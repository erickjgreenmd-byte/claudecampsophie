import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cryptoRandom } from '@pencillift/domain';
import { generatePromoCode } from '@pencillift/domain/promotions';
import {
  grantAdultUnlock,
  seedFamily,
  seedOwnerAdmin,
  type SeededFamily,
} from '@pencillift/db/testing/fixtures';
import {
  DEFAULT_HANDLERS,
  expireStaleReservations,
  inactivitySweep,
  LATE_UPLOAD_WINDOW_MS,
  purgeExpiredExports,
  purgeLateUploads,
  reconcileStaleEntitlements,
  recordSpendAlerts,
  purgeExpiredScans,
  runJobs,
  runScheduledTick,
  type JobDeps,
  type JobHandler,
} from '../src/jobs/dispatcher.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

let api: TestApi;
let deps: JobDeps;

beforeAll(async () => {
  api = await createTestApi();
  deps = {
    db: api.apiDb,
    config: api.config,
    clock: () => api.now.value,
    random: cryptoRandom,
    providers: api.providers,
    log: (e) => api.logs.push(e),
  };
});

afterAll(async () => {
  await api?.close();
});

/** One assignment + one stored page for a child; the object is registered in the storage mock. */
async function storedPage(fam: SeededFamily, childIndex = 0, createdAt?: Date): Promise<string> {
  const childId = fam.children[childIndex]!.id;
  const [a] = await api.db.sql<{ id: string }[]>`
    insert into public.assignments (family_id, child_id, idempotency_key, created_by_kind)
    values (${fam.familyId}, ${childId}, ${'k-' + randomUUID()}, 'child') returning id`;
  const pageId = randomUUID();
  const path = `${fam.familyId}/${childId}/${a!.id}/${pageId}.jpg`;
  await api.db.sql`
    insert into public.source_pages (id, assignment_id, family_id, child_id, page_number, storage_path, mime_type, byte_size, sha256, created_at)
    values (${pageId}, ${a!.id}, ${fam.familyId}, ${childId}, 1, ${path}, 'image/jpeg', 10, ${'d'.repeat(64)},
            ${createdAt ?? api.now.value})`;
  api.providers.storage.objects.add(path);
  return path;
}

async function queueJob(
  kind: string,
  familyId: string | null,
  options: { maxAttempts?: number; runAfter?: Date } = {},
): Promise<string> {
  const [row] = await api.db.sql<{ id: string }[]>`
    insert into public.jobs (kind, idempotency_key, family_id, max_attempts, run_after)
    values (${kind}, ${'test:' + randomUUID()}, ${familyId}, ${options.maxAttempts ?? 5},
            ${options.runAfter ?? new Date(api.now.value.getTime() - 1000)})
    returning id`;
  return row!.id;
}

async function jobState(id: string) {
  const [row] = await api.db.sql<
    { status: string; attempts: number; run_after: Date; last_error_code: string | null }[]
  >`select status, attempts, run_after, last_error_code from public.jobs where id = ${id}`;
  return row!;
}

describe('deletion purge job (AC_ACCESS_10, AC_SECURITY_05)', () => {
  it('a family deletion request enqueues its purge atomically and the tick completes it', async () => {
    const fam = await seedFamily(api.db, { childCount: 2 });
    const pathA = await storedPage(fam, 0);
    const pathB = await storedPage(fam, 1);
    await grantAdultUnlock(api.db, fam.ownerId);
    await api.db.asParent(
      fam.ownerId,
      (tx) => tx`select public.request_deletion(${fam.familyId}, null)`,
    );
    const [job] = await api.db.sql<{ id: string; status: string }[]>`
      select id, status from public.jobs where family_id = ${fam.familyId} and kind = 'deletion_purge'`;
    expect(job?.status).toBe('queued');

    const report = await runScheduledTick(deps);
    expect(report.jobs.succeeded).toBeGreaterThanOrEqual(1);
    expect((await jobState(job!.id)).status).toBe('succeeded');
    // Storage objects go first, then rows; nothing of the children remains in the active store.
    expect(api.providers.storage.objects.has(pathA)).toBe(false);
    expect(api.providers.storage.objects.has(pathB)).toBe(false);
    const [counts] = await api.db.sql<{ children: number; pages: number; status: string }[]>`
      select (select count(*)::int from public.child_profiles where family_id = ${fam.familyId}) as children,
             (select count(*)::int from public.source_pages where family_id = ${fam.familyId}) as pages,
             (select status from public.deletion_requests where family_id = ${fam.familyId}) as status`;
    expect(counts).toEqual({ children: 0, pages: 0, status: 'completed' });
  });

  it('a child deletion purges only that child', async () => {
    const fam = await seedFamily(api.db, { childCount: 2 });
    const doomed = await storedPage(fam, 0);
    const kept = await storedPage(fam, 1);
    await grantAdultUnlock(api.db, fam.ownerId);
    await api.db.asParent(
      fam.ownerId,
      (tx) => tx`select public.request_deletion(${fam.familyId}, ${fam.children[0]!.id})`,
    );
    await runJobs(deps);
    expect(api.providers.storage.objects.has(doomed)).toBe(false);
    expect(api.providers.storage.objects.has(kept)).toBe(true);
    const children = await api.db.sql<{ id: string }[]>`
      select id from public.child_profiles where family_id = ${fam.familyId}`;
    expect(children.map((c) => c.id)).toEqual([fam.children[1]!.id]);
  });

  it('a storage failure leaves the rows for the retry (no orphaned photos)', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const path = await storedPage(fam, 0);
    await grantAdultUnlock(api.db, fam.ownerId);
    await api.db.asParent(
      fam.ownerId,
      (tx) => tx`select public.request_deletion(${fam.familyId}, null)`,
    );
    const failingStorage = {
      ...api.providers.storage,
      remove: () => Promise.reject(new Error('storage down')),
    };
    const flaky: JobDeps = { ...deps, providers: { ...api.providers, storage: failingStorage } };
    const report = await runJobs(flaky);
    expect(report.retried).toBe(1);
    const [pages] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.source_pages where family_id = ${fam.familyId}`;
    expect(pages!.n).toBe(1);
    expect(api.providers.storage.objects.has(path)).toBe(true);

    // After the backoff the healthy retry completes the purge.
    api.now.value = new Date(api.now.value.getTime() + 10 * 60_000);
    try {
      expect((await runJobs(deps)).succeeded).toBeGreaterThanOrEqual(1);
    } finally {
      api.now.value = new Date(api.now.value.getTime() - 10 * 60_000);
    }
    expect(api.providers.storage.objects.has(path)).toBe(false);
  });

  it('queued work for a deleted family is cancelled, never run', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const job = await queueJob('scan_process', fam.familyId);
    // Simulate a worker that died mid-run before the tombstone landed: it stays "running".
    await api.db
      .sql`update public.jobs set status = 'running', attempts = 1, locked_until = ${new Date(
      api.now.value.getTime() - 1000,
    )} where id = ${job}`;
    await api.db.sql`update public.families set deleted_at = now() where id = ${fam.familyId}`;
    let ran = false;
    const handlers: Record<string, JobHandler> = {
      scan_process: () => {
        ran = true;
        return Promise.resolve();
      },
    };
    await runJobs(deps, handlers);
    expect(ran).toBe(false);
    expect((await jobState(job)).status).toBe('cancelled');
  });
});

describe('job ledger mechanics', () => {
  it('retries with exponential backoff, then dead-letters at max attempts', async () => {
    const id = await queueJob('export_build', null, { maxAttempts: 2 });
    const handlers: Record<string, JobHandler> = {
      export_build: () => Promise.reject(new TypeError('boom')),
    };
    const first = await runJobs(deps, handlers);
    expect(first).toEqual({ succeeded: 0, retried: 1, deadLettered: 0 });
    const afterFirst = await jobState(id);
    expect(afterFirst).toMatchObject({
      status: 'failed_retryable',
      attempts: 1,
      last_error_code: 'TypeError',
    });
    expect(afterFirst.run_after.getTime()).toBe(api.now.value.getTime() + 60_000);

    // Not due yet: the next tick must not pick it up.
    expect((await runJobs(deps, handlers)).retried).toBe(0);

    api.now.value = new Date(api.now.value.getTime() + 2 * 60_000);
    try {
      expect(await runJobs(deps, handlers)).toEqual({ succeeded: 0, retried: 0, deadLettered: 1 });
    } finally {
      api.now.value = new Date(api.now.value.getTime() - 2 * 60_000);
    }
    expect((await jobState(id)).status).toBe('dead_letter');
    expect(api.logs.some((l) => l.event === 'job_dead_letter' && l.code === 'export_build')).toBe(
      true,
    );
  });

  it('recovers a job whose worker died (expired lock) and runs it again', async () => {
    const id = await queueJob('notification_send', null);
    await api.db.sql`update public.jobs set status = 'running', attempts = 1,
                       locked_until = ${new Date(api.now.value.getTime() - 60_000)} where id = ${id}`;
    let runs = 0;
    const handlers: Record<string, JobHandler> = {
      notification_send: () => {
        runs += 1;
        return Promise.resolve();
      },
    };
    await runJobs(deps, handlers); // recovery marks it retryable with run_after unchanged (already due)
    expect(runs).toBe(1);
    expect(await jobState(id)).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('concurrent workers never run the same job twice (SKIP LOCKED)', async () => {
    const ids = await Promise.all(
      Array.from({ length: 6 }, () => queueJob('payout_prepare', null)),
    );
    const seen: string[] = [];
    const handlers: Record<string, JobHandler> = {
      payout_prepare: async (_d, job) => {
        seen.push(job.id);
        await new Promise((r) => setTimeout(r, 20));
      },
    };
    const reports = await Promise.all([
      runJobs(deps, handlers),
      runJobs(deps, handlers),
      runJobs(deps, handlers),
    ]);
    expect(reports.reduce((n, r) => n + r.succeeded, 0)).toBe(6);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('leaves kinds without a registered handler queued', async () => {
    const id = await queueJob('review_top_up', null);
    await runJobs(deps, DEFAULT_HANDLERS);
    expect((await jobState(id)).status).toBe('queued');
    await api.db.sql`update public.jobs set status = 'cancelled' where id = ${id}`;
  });
});

describe('retention and reservation sweeps', () => {
  it('purges raw scans older than 30 days from storage and marks them deleted', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const old = await storedPage(fam, 0, new Date(api.now.value.getTime() - 31 * 86_400_000));
    const fresh = await storedPage(fam, 0, new Date(api.now.value.getTime() - 29 * 86_400_000));
    expect(await purgeExpiredScans(deps)).toBeGreaterThanOrEqual(1);
    expect(api.providers.storage.objects.has(old)).toBe(false);
    expect(api.providers.storage.objects.has(fresh)).toBe(true);
    const rows = await api.db.sql<{ storage_path: string; deleted: boolean }[]>`
      select storage_path, deleted_at is not null as deleted from public.source_pages where family_id = ${fam.familyId}`;
    expect(Object.fromEntries(rows.map((r) => [r.storage_path, r.deleted]))).toEqual({
      [old]: true,
      [fresh]: false,
    });
    // Idempotent: a second sweep finds nothing new for this family.
    await purgeExpiredScans(deps);
    expect(api.providers.storage.objects.has(fresh)).toBe(true);
  });

  it('expires unsubmitted reservations but never provider_pending ones', async () => {
    const adminId = await seedOwnerAdmin(api.db);
    // One in-flight redemption per family is allowed, so each case uses its own family.
    const famA = await seedFamily(api.db, { childCount: 1 });
    const famB = await seedFamily(api.db, { childCount: 1 });
    const [tpl] = await api.db.sql<{ id: string }[]>`
      insert into public.promo_campaign_templates
        (name, percent_off, eligible_tiers, subscriber_eligibility, redemption_cap, budget_cap_cents, calendar_timezone,
         timezone_confirmed, code_mode, channels, enabled, created_by)
      values ('Sweep test', 25, '{1,2,3,4}', '{new,existing,lapsed}', 100, 1000000, 'UTC', true, 'shared',
              '{app_store}', false, ${adminId})
      returning id`;
    const campaigns: { id: string; codeId: string }[] = [];
    for (const month of ['2026-07', '2026-08']) {
      const [c] = await api.db.sql<{ id: string }[]>`
        insert into public.promo_campaigns (template_id, campaign_month, generation_key, percent_off, eligible_tiers,
          subscriber_eligibility, redemption_cap, budget_cap_cents, opens_at, closes_at, status)
        values (${tpl!.id}, ${month}, ${tpl!.id + ':' + month}, 25, '{1,2,3,4}', '{new,existing,lapsed}', 100, 1000000,
                ${month + '-01T00:00:00Z'}, ${month + '-28T00:00:00Z'}, 'active')
        returning id`;
      const [code] = await api.db.sql<{ id: string }[]>`
        insert into public.promo_codes (campaign_id, code_normalized)
        values (${c!.id}, ${generatePromoCode(cryptoRandom).normalized}) returning id`;
      campaigns.push({ id: c!.id, codeId: code!.id });
    }
    const insert = (
      fam: SeededFamily,
      campaign: { id: string; codeId: string },
      periodKey: string,
    ) => api.db.sql<{ id: string }[]>`
      insert into public.promo_redemptions
        (family_id, campaign_id, code_id, channel, target_period_key, state, idempotency_key, paid_slots, percent_off,
         regular_cents, discount_cents, charged_cents, redeemed_by, created_at)
      values (${fam.familyId}, ${campaign.id}, ${campaign.codeId}, 'app_store', ${periodKey}, 'reserved', ${randomUUID()}, 1, 25,
              3999, 1000, 2999, ${fam.ownerId}, ${new Date(api.now.value.getTime() - 45 * 60_000)})
      returning id`;
    const [stale] = await insert(famA, campaigns[0]!, 'renewal:2026-08-05');
    await api.db
      .sql`update public.promo_redemptions set state = 'provider_pending' where id = ${stale!.id}`;
    const [unsubmitted] = await insert(famB, campaigns[1]!, 'renewal:2026-09-05');

    expect(await expireStaleReservations(deps)).toBeGreaterThanOrEqual(1);
    const states = await api.db.sql<{ id: string; state: string }[]>`
      select id, state from public.promo_redemptions where family_id = any(${[famA.familyId, famB.familyId]})`;
    expect(Object.fromEntries(states.map((s) => [s.id, s.state]))).toEqual({
      [stale!.id]: 'provider_pending',
      [unsubmitted!.id]: 'expired',
    });
  });
});

describe('scheduled tick', () => {
  it('generates this month’s campaigns once; a repeated tick is a no-op', async () => {
    const adminId = await seedOwnerAdmin(api.db);
    await api.db.sql`
      insert into public.promo_campaign_templates
        (name, percent_off, eligible_tiers, subscriber_eligibility, redemption_cap, budget_cap_cents, calendar_timezone,
         timezone_confirmed, code_mode, channels, enabled, created_by)
      values ('Monthly tick', 10, '{1,2,3,4}', '{new,existing,lapsed}', 50, 500000, 'UTC', true, 'shared',
              '{stripe}', true, ${adminId})`;
    const first = await runScheduledTick(deps);
    expect(first.generatedCampaigns).toBeGreaterThanOrEqual(1);
    const second = await runScheduledTick(deps);
    expect(second.generatedCampaigns).toBe(0);
    const [row] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.promo_campaigns c join public.promo_campaign_templates t on t.id = c.template_id
       where t.name = 'Monthly tick' and c.campaign_month = '2026-09'`;
    expect(row!.n).toBe(1);
  });
});

describe('spend alerts (spec F4, AC_FIN_09)', () => {
  it('fires each threshold once and never without an owner budget', async () => {
    expect(await recordSpendAlerts(deps)).toEqual([]); // no budget row: nothing is invented
    const adminId = await seedOwnerAdmin(api.db);
    await api.db.sql`
      insert into public.spend_budgets (scope, period_key, budget_micros, created_by)
      values ('global', '2026-09', 1000000, ${adminId})`;
    const spend = (micros: number) => api.db.sql`
      insert into public.ai_usage_events (stage, model_id, prompt_version, status, input_tokens, output_tokens, latency_ms, cost_micros, rate_table_version, created_at)
      values ('grading', 'gpt-5.6-terra', 'grading.v1', 'succeeded', 10, 10, 5, ${micros}, 'test', ${api.now.value})`;
    await spend(600_000);
    expect(await recordSpendAlerts(deps)).toEqual([50]);
    expect(await recordSpendAlerts(deps)).toEqual([]);
    await spend(450_000);
    expect(await recordSpendAlerts(deps)).toEqual([80, 100]);
    const [alerts] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events where action = 'spend.threshold_crossed'`;
    expect(alerts!.n).toBe(3);
    expect(api.logs.some((l) => l.event === 'spend_threshold_crossed' && l.level === 'error')).toBe(
      true,
    );
  });
});

describe('entitlement safety net (spec P11: lost webhooks)', () => {
  it('re-fetches stale entitlements; one provider failure does not stop the sweep', async () => {
    await api.db.sql`
      insert into public.store_product_mappings (channel, product_id, environment, paid_slots)
      values ('app_store', 'pl_family_2', 'sandbox', 2) on conflict do nothing`;
    const seed = async () => {
      const fam = await seedFamily(api.db, { childCount: 0 });
      const [f] = await api.db.sql<{ billing_ref: string }[]>`
        select billing_ref from public.families where id = ${fam.familyId}`;
      const ref = f!.billing_ref;
      await api.db.sql`
        insert into public.family_capacity (family_id, paid_slots, managing_channel)
        values (${fam.familyId}, 2, 'app_store')`;
      await api.db.sql`
        insert into public.family_entitlements (family_id, channel, provider_subscription_id, product_id, paid_slots, status,
          environment, period_start, period_end, provider_updated_at, fetched_at)
        values (${fam.familyId}, 'app_store', ${`rc:${ref}:app_store:pl_family_2`}, 'pl_family_2', 2, 'active', 'sandbox',
                '2026-08-10T00:00:00Z', '2026-09-10T00:00:00Z', '2026-08-10T00:00:00Z', '2026-09-20T00:00:00Z')`;
      return { fam, ref };
    };
    const lapsed = await seed();
    const broken = await seed();
    api.providers.subscriptions.state.set(lapsed.ref, [
      {
        channel: 'app_store',
        providerSubscriptionId: `rc:${lapsed.ref}:app_store:pl_family_2`,
        productId: 'pl_family_2',
        status: 'expired',
        periodStart: new Date('2026-08-10T00:00:00Z'),
        periodEnd: new Date('2026-09-10T00:00:00Z'),
        autoRenew: false,
        environment: 'sandbox',
        providerUpdatedAt: new Date('2026-09-10T00:00:00Z'),
        fetchedAt: api.now.value,
      },
    ]);
    const original = api.providers.subscriptions.fetchSubscriptions.bind(
      api.providers.subscriptions,
    );
    const flaky: JobDeps = {
      ...deps,
      providers: {
        ...api.providers,
        subscriptions: {
          ...api.providers.subscriptions,
          fetchSubscriptions: (ref, now) =>
            ref === broken.ref ? Promise.reject(new Error('provider down')) : original(ref, now),
        },
      },
    };
    expect(await reconcileStaleEntitlements(flaky)).toBeGreaterThanOrEqual(1);
    const [row] = await api.db.sql<{ status: string; paid_slots: number }[]>`
      select e.status, c.paid_slots from public.family_entitlements e
        join public.family_capacity c on c.family_id = e.family_id
       where e.family_id = ${lapsed.fam.familyId}`;
    expect(row).toEqual({ status: 'expired', paid_slots: 0 });
    const [untouched] = await api.db.sql<{ status: string }[]>`
      select status from public.family_entitlements where family_id = ${broken.fam.familyId}`;
    expect(untouched!.status).toBe('active');
    expect(api.logs.some((l) => l.event === 'entitlement_reconcile_failed')).toBe(true);
  });
});

describe('inactivity retention (spec P4; disabled until the owner approves the period)', () => {
  const enabled = (): JobDeps => ({
    ...deps,
    config: { ...api.config, flags: { ...api.config.flags, inactivityDeletionEnabled: true } },
  });

  async function idleFamily() {
    const fam = await seedFamily(api.db, { childCount: 1 });
    await api.db
      .sql`update public.families set created_at = '2025-08-01T00:00:00Z' where id = ${fam.familyId}`;
    return fam;
  }

  it('does nothing while disabled', async () => {
    const fam = await idleFamily();
    expect(await inactivitySweep(deps)).toEqual({ notified: 0, deleted: 0 });
    const [row] = await api.db.sql<{ notified: Date | null }[]>`
      select inactivity_notified_at as notified from public.families where id = ${fam.familyId}`;
    expect(row!.notified).toBeNull();
  });

  it('notifies once, then deletes after the notice period if nothing happens', async () => {
    const idle = await idleFamily();
    const active = await seedFamily(api.db, { childCount: 1 }); // created now: not idle
    const outboxBefore = api.providers.email.outbox.length;
    const first = await inactivitySweep(enabled());
    expect(first.notified).toBeGreaterThanOrEqual(1);
    expect(api.providers.email.outbox.length).toBeGreaterThan(outboxBefore);
    expect(api.providers.email.outbox.at(-1)!.templateKey).toBe('inactivity_notice');
    expect((await inactivitySweep(enabled())).deleted).toBe(0); // still inside the notice period

    api.now.value = new Date(api.now.value.getTime() + 31 * 86_400_000);
    try {
      expect((await inactivitySweep(enabled())).deleted).toBeGreaterThanOrEqual(1);
    } finally {
      api.now.value = new Date(api.now.value.getTime() - 31 * 86_400_000);
    }
    const rows = await api.db.sql<{ id: string; deleted: boolean }[]>`
      select id, deleted_at is not null as deleted from public.families where id = any(${[idle.familyId, active.familyId]})`;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.deleted]))).toEqual({
      [idle.familyId]: true,
      [active.familyId]: false,
    });
    const [job] = await api.db.sql<{ status: string }[]>`
      select status from public.jobs where family_id = ${idle.familyId} and kind = 'deletion_purge'`;
    expect(job!.status).toBe('queued');
  });

  it('any parent activity after the notice cancels the deletion', async () => {
    const fam = await idleFamily();
    await inactivitySweep(enabled());
    const token = await parentToken(fam.ownerId);
    expect((await api.request('/v1/family', { token })).status).toBe(200);
    const [row] = await api.db.sql<{ notified: Date | null }[]>`
      select inactivity_notified_at as notified from public.families where id = ${fam.familyId}`;
    expect(row!.notified).toBeNull();
    api.now.value = new Date(api.now.value.getTime() + 31 * 86_400_000);
    try {
      await inactivitySweep(enabled());
    } finally {
      api.now.value = new Date(api.now.value.getTime() - 31 * 86_400_000);
    }
    const [still] = await api.db.sql<{ deleted_at: Date | null }[]>`
      select deleted_at from public.families where id = ${fam.familyId}`;
    expect(still!.deleted_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Hardening from the lead jobs/AI review (RV-lead-jobs-ai-1/2/5/6/11/15/20)
// ---------------------------------------------------------------------------------------------

describe('job ledger hardening (RV-lead-jobs-ai-1, -2, -15)', () => {
  it('claims one job at a time, oldest run_after first', async () => {
    const at = (ms: number) => new Date(api.now.value.getTime() - ms);
    const late = await queueJob('promo_reconcile', null, { runAfter: at(1_000) });
    const oldest = await queueJob('promo_reconcile', null, { runAfter: at(3_000) });
    const middle = await queueJob('promo_reconcile', null, { runAfter: at(2_000) });
    const order: string[] = [];
    const claimedWhileRunning: string[] = [];
    const handlers: Record<string, JobHandler> = {
      promo_reconcile: async (_d, job) => {
        order.push(job.id);
        // Only the job being run is claimed; the others are still waiting in the queue.
        const running = await api.db.sql<{ id: string }[]>`
          select id from public.jobs where kind = 'promo_reconcile' and status = 'running'`;
        claimedWhileRunning.push(...running.map((r) => r.id).filter((id) => id !== job.id));
      },
    };
    await runJobs(deps, handlers);
    expect(order).toEqual([oldest, middle, late]);
    expect(claimedWhileRunning).toEqual([]);
  });

  it('a worker whose claim was taken over neither overwrites the job nor aborts the tick', async () => {
    const id = await queueJob('entitlement_reconcile', null);
    const handlers: Record<string, JobHandler> = {
      entitlement_reconcile: async () => {
        // Another worker recovered and finished this job meanwhile.
        await api.db.sql`update public.jobs set status = 'succeeded' where id = ${id}`;
        throw new Error('late failure from the stale worker');
      },
    };
    const report = await runJobs(deps, handlers);
    expect(report).toEqual({ succeeded: 0, retried: 0, deadLettered: 0 });
    expect((await jobState(id)).status).toBe('succeeded');
    expect(
      api.logs.some((l) => l.event === 'job_claim_lost' && l.code === 'entitlement_reconcile'),
    ).toBe(true);
  });

  it('a deferral gives the attempt back and reschedules the job', async () => {
    const id = await queueJob('notification_send', null, { maxAttempts: 1 });
    const runAfter = new Date(api.now.value.getTime() + 3600_000);
    const handlers: Record<string, JobHandler> = {
      notification_send: () => Promise.resolve({ kind: 'defer', runAfter, code: 'SPEND_CEILING' }),
    };
    expect(await runJobs(deps, handlers)).toEqual({ succeeded: 0, retried: 1, deadLettered: 0 });
    expect(await jobState(id)).toEqual({
      status: 'failed_retryable',
      attempts: 0, // the pause did not use up the single attempt
      run_after: runAfter,
      last_error_code: 'SPEND_CEILING',
    });
    await api.db.sql`update public.jobs set status = 'cancelled' where id = ${id}`;
  });

  it('a job dead-lettered by its handler or by a lost final lease runs the kind’s compensation', async () => {
    const failing = await queueJob('review_top_up', null, { maxAttempts: 1 });
    const lost = await queueJob('review_top_up', null, { maxAttempts: 1 });
    await api.db.sql`update public.jobs set status = 'running', attempts = 1,
                       locked_until = ${new Date(api.now.value.getTime() - 60_000)} where id = ${lost}`;
    const compensated: [string, string][] = [];
    const handler: JobHandler = Object.assign(() => Promise.reject(new RangeError('boom')), {
      onDeadLetter: (_d: JobDeps, job: { id: string }, reason: string) => {
        compensated.push([job.id, reason]);
        return Promise.resolve();
      },
    });
    const report = await runJobs(deps, { review_top_up: handler });
    expect(report.deadLettered).toBe(2);
    expect(compensated.sort()).toEqual(
      [
        [failing, 'ATTEMPTS_EXHAUSTED'],
        [lost, 'LOCK_EXPIRED'],
      ].sort(),
    );
    expect((await jobState(failing)).status).toBe('dead_letter');
    expect((await jobState(lost)).status).toBe('dead_letter');
  });

  it('one failing sweep is logged and skipped; the other sweeps and the job ledger still run', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    await storedPage(fam, 0, new Date(api.now.value.getTime() - 40 * 86_400_000));
    const brokenStorage = {
      ...api.providers.storage,
      remove: () => Promise.reject(new Error('storage down')),
    };
    const id = await queueJob('payout_prepare', null);
    let ran = false;
    const report = await runScheduledTick(
      { ...deps, providers: { ...api.providers, storage: brokenStorage } },
      {
        payout_prepare: () => {
          ran = true;
          return Promise.resolve();
        },
      },
    );
    expect(report.failedSteps).toContain('scan_retention');
    expect(ran).toBe(true);
    expect((await jobState(id)).status).toBe('succeeded');
    expect(
      api.logs.some((l) => l.event === 'scheduled_step_failed' && l.code === 'scan_retention'),
    ).toBe(true);
    await purgeExpiredScans(deps); // healthy storage again: the page is removed on the next tick
  });
});

describe('retention hardening (RV-lead-jobs-ai-5, -6, -20)', () => {
  it('pages of a cancelled scan are removed on the next sweep, and marked only after storage confirms', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const path = await storedPage(fam, 0);
    await api.db.sql`
      update public.assignments set status = 'cancelled'
       where id = (select assignment_id from public.source_pages where storage_path = ${path})`;
    const failing: JobDeps = {
      ...deps,
      providers: {
        ...api.providers,
        storage: { ...api.providers.storage, remove: () => Promise.reject(new Error('down')) },
      },
    };
    await expect(purgeExpiredScans(failing)).rejects.toThrow('down');
    const [before] = await api.db.sql<{ removed: Date | null }[]>`
      select storage_removed_at as removed from public.source_pages where storage_path = ${path}`;
    expect(before!.removed).toBeNull(); // nothing is marked while the object may still exist
    expect(await purgeExpiredScans(deps)).toBeGreaterThanOrEqual(1);
    expect(api.providers.storage.objects.has(path)).toBe(false);
    const [after] = await api.db.sql<{ removed: Date | null; deleted: Date | null }[]>`
      select storage_removed_at as removed, deleted_at as deleted from public.source_pages where storage_path = ${path}`;
    expect(after!.removed).not.toBeNull();
    expect(after!.deleted).not.toBeNull();
  });

  it('expired exports lose their file and show as expired; live exports are untouched', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const insert = (expiresAt: Date) => api.db.sql<{ id: string }[]>`
      insert into public.data_exports (family_id, requested_by, kind, status, storage_path, expires_at)
      values (${fam.familyId}, ${fam.ownerId}, 'family_data', 'ready',
              ${`exports/${fam.familyId}/${randomUUID()}.json`}, ${expiresAt})
      returning id`;
    const [expired] = await insert(new Date(api.now.value.getTime() - 1000));
    const [live] = await insert(new Date(api.now.value.getTime() + 86_400_000));
    const rows = await api.db.sql<{ id: string; storage_path: string }[]>`
      select id, storage_path from public.data_exports where id = any(${[expired!.id, live!.id]})`;
    for (const r of rows) api.providers.storage.objects.add(r.storage_path);
    expect(await purgeExpiredExports(deps)).toBeGreaterThanOrEqual(1);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.storage_path]));
    expect(api.providers.storage.objects.has(byId[expired!.id]!)).toBe(false);
    expect(api.providers.storage.objects.has(byId[live!.id]!)).toBe(true);
    const states = await api.db.sql<{ id: string; status: string; storage_path: string | null }[]>`
      select id, status, storage_path from public.data_exports where id = any(${[expired!.id, live!.id]})`;
    expect(Object.fromEntries(states.map((s) => [s.id, [s.status, s.storage_path]]))).toEqual({
      [expired!.id]: ['expired', null],
      [live!.id]: ['ready', byId[live!.id]],
    });
  });

  it('a deletion removes an object a still-valid upload writes after the purge, once the window closes', async () => {
    const fam = await seedFamily(api.db, { childCount: 2 });
    const path = await storedPage(fam, 0);
    api.providers.storage.objects.delete(path); // the device has not finished the upload yet
    await grantAdultUnlock(api.db, fam.ownerId);
    await api.db.asParent(
      fam.ownerId,
      (tx) => tx`select public.request_deletion(${fam.familyId}, ${fam.children[0]!.id})`,
    );
    await runJobs(deps);
    api.providers.storage.objects.add(path); // the PUT lands after the purge
    const start = api.now.value;
    try {
      api.now.value = new Date(start.getTime() + LATE_UPLOAD_WINDOW_MS - 60_000);
      await purgeLateUploads(deps);
      expect(api.providers.storage.objects.has(path)).toBe(true); // still inside the upload window

      // A storage failure keeps the removal for the next tick.
      api.now.value = new Date(start.getTime() + LATE_UPLOAD_WINDOW_MS + 60_000);
      const failing: JobDeps = {
        ...deps,
        providers: {
          ...api.providers,
          storage: { ...api.providers.storage, remove: () => Promise.reject(new Error('down')) },
        },
      };
      await expect(purgeLateUploads(failing)).rejects.toThrow('down');
      expect(await purgeLateUploads(deps)).toBeGreaterThanOrEqual(1);
    } finally {
      api.now.value = start;
    }
    expect(api.providers.storage.objects.has(path)).toBe(false);
    const [left] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from private.storage_removals where storage_path = ${path}`;
    expect(left!.n).toBe(0);
  });
});

describe('inactivity hardening (RV-lead-jobs-ai-11, -15)', () => {
  const enabled = (overrides: Partial<JobDeps['config']> = {}): JobDeps => ({
    ...deps,
    config: {
      ...api.config,
      ...overrides,
      flags: { ...api.config.flags, inactivityDeletionEnabled: true },
    },
  });

  async function idleFamily() {
    const fam = await seedFamily(api.db, { childCount: 1 });
    await api.db
      .sql`update public.families set created_at = '2025-08-01T00:00:00Z' where id = ${fam.familyId}`;
    return fam;
  }

  async function notifiedAt(familyId: string): Promise<Date | null> {
    const [row] = await api.db.sql<{ at: Date | null }[]>`
      select inactivity_notified_at as at from public.families where id = ${familyId}`;
    return row!.at;
  }

  it('an owner without a verified email is never counted as notified, so never deleted', async () => {
    const fam = await idleFamily();
    await api.db.sql`update auth.users set email_confirmed_at = null where id = ${fam.ownerId}`;
    await inactivitySweep(enabled());
    expect(await notifiedAt(fam.familyId)).toBeNull();
    expect(
      api.logs.some(
        (l) => l.event === 'inactivity_notice_undeliverable' && l.code === 'NO_VERIFIED_EMAIL',
      ),
    ).toBe(true);
  });

  it('in production a mock email provider blocks the sweep entirely', async () => {
    const fam = await idleFamily();
    expect(await inactivitySweep(enabled({ environment: 'production' }))).toEqual({
      notified: 0,
      deleted: 0,
    });
    expect(await notifiedAt(fam.familyId)).toBeNull();
    expect(api.logs.some((l) => l.event === 'inactivity_sweep_blocked')).toBe(true);
  });

  it('runs once per UTC day on the first tick at or after 03:00, whatever minute it lands on', async () => {
    const start = api.now.value;
    const tick = async (iso: string) => {
      api.now.value = new Date(iso);
      return (await runScheduledTick(enabled())).inactivity;
    };
    try {
      const first = await idleFamily();
      expect(await tick('2026-09-27T02:58:00Z')).toEqual({ notified: 0, deleted: 0 }); // before 03:00
      expect(await notifiedAt(first.familyId)).toBeNull();
      expect((await tick('2026-09-27T04:17:00Z')).notified).toBeGreaterThanOrEqual(1); // late tick
      expect(await notifiedAt(first.familyId)).not.toBeNull();
      const second = await idleFamily();
      expect(await tick('2026-09-27T09:00:00Z')).toEqual({ notified: 0, deleted: 0 }); // same day
      expect(await notifiedAt(second.familyId)).toBeNull();
      expect((await tick('2026-09-28T03:02:00Z')).notified).toBeGreaterThanOrEqual(1); // next day
      expect(await notifiedAt(second.familyId)).not.toBeNull();
    } finally {
      api.now.value = start;
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Checker follow-up: a removal is final only once no signed upload URL can still write the object
// (RV-lead-jobs-ai-5, -20), and a store still retrying payment is a paying family (RV-13)
// ---------------------------------------------------------------------------------------------

describe('a removal is final only after the upload window (RV-lead-jobs-ai-5, -20)', () => {
  /** A scan created through the routes whose device holds a signed upload URL for page 1. */
  async function uploadingScan(): Promise<{
    fam: SeededFamily;
    id: string;
    path: string;
    token: string;
  }> {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const childId = fam.children[0]!.id;
    await api.db.sql`
      insert into public.consent_records (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
      values (${fam.familyId}, ${fam.ownerId}, 'development_mock', 'development_mock', 'child_data_processing', 'v1', 'verified', true, now())`;
    await api.db.sql`
      insert into public.family_capacity (family_id, paid_slots, managing_channel)
      values (${fam.familyId}, 1, 'app_store') on conflict (family_id) do update set paid_slots = 1`;
    const token = await parentToken(fam.ownerId);
    const created = await api.request('/v1/assignments', {
      method: 'POST',
      token,
      body: { childId, pageCount: 1, idempotencyKey: randomUUID() },
    });
    expect(created.status).toBe(201);
    const id = (await json<{ assignment: { id: string } }>(created)).assignment.id;
    const uploaded = await api.request(`/v1/assignments/${id}/uploads`, {
      method: 'POST',
      token,
      body: {
        pages: [
          { pageNumber: 1, mimeType: 'image/jpeg', byteSize: 250_000, sha256: 'f'.repeat(64) },
        ],
      },
    });
    expect(uploaded.status).toBe(200);
    const [page] = await api.db.sql<{ storage_path: string }[]>`
      select storage_path from public.source_pages where assignment_id = ${id}`;
    return { fam, id, path: page!.storage_path, token };
  }

  /** Runs `fn` with the clock moved forward by `ms`, then restores it. */
  async function later<T>(ms: number, fn: () => Promise<T>): Promise<T> {
    const start = api.now.value;
    api.now.value = new Date(start.getTime() + ms);
    try {
      return await fn();
    } finally {
      api.now.value = start;
    }
  }

  async function pendingRemovals(path: string): Promise<number> {
    const [row] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from private.storage_removals where storage_path = ${path}`;
    return row!.n;
  }

  it('the database and the API agree on the upload window', async () => {
    const [row] = await api.db.sql<{ ms: string }[]>`
      select (extract(epoch from app.late_upload_window()) * 1000)::bigint::text as ms`;
    expect(Number(row!.ms)).toBe(LATE_UPLOAD_WINDOW_MS);
  });

  it('a deletion purged inside the scheduled tick (retention step first) still removes a late upload', async () => {
    const s = await uploadingScan(); // the device is still sending the photo
    await grantAdultUnlock(api.db, s.fam.ownerId);
    await api.db.asParent(
      s.fam.ownerId,
      (tx) => tx`select public.request_deletion(${s.fam.familyId}, null)`,
    );
    const report = await runScheduledTick(deps); // scan_retention runs before the job ledger
    expect(report.jobs.succeeded).toBeGreaterThanOrEqual(1);
    const [left] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.source_pages where family_id = ${s.fam.familyId}`;
    expect(left!.n).toBe(0); // purged: nothing references the path any more ...
    expect(await pendingRemovals(s.path)).toBeGreaterThanOrEqual(1); // ... except the second pass
    api.providers.storage.objects.add(s.path); // the signed PUT completes after the purge
    await later(LATE_UPLOAD_WINDOW_MS - 60_000, () => runScheduledTick(deps));
    expect(api.providers.storage.objects.has(s.path)).toBe(true); // URL may still be valid
    await later(LATE_UPLOAD_WINDOW_MS + 60_000, () => runScheduledTick(deps));
    expect(api.providers.storage.objects.has(s.path)).toBe(false);
    expect(await pendingRemovals(s.path)).toBe(0);
  });

  it('a cancelled scan’s photo written by a still-valid upload after the sweep is removed once the window closes', async () => {
    const s = await uploadingScan();
    api.providers.storage.objects.add(s.path);
    const cancelled = await api.request(`/v1/assignments/${s.id}/cancel`, {
      method: 'POST',
      token: s.token,
    });
    expect(cancelled.status).toBe(200);
    await purgeExpiredScans(deps); // the next tick: storage confirms, storage_removed_at stamped
    const [page] = await api.db.sql<{ removed: boolean }[]>`
      select storage_removed_at is not null as removed from public.source_pages where assignment_id = ${s.id}`;
    expect(page!.removed).toBe(true);
    api.providers.storage.objects.add(s.path); // the PUT lands after the stamp
    await later(LATE_UPLOAD_WINDOW_MS + 60_000, () => runScheduledTick(deps));
    expect(api.providers.storage.objects.has(s.path)).toBe(false);
    // ... and it also does not outlive a later family deletion (no pass is left pending).
    expect(await pendingRemovals(s.path)).toBe(0);
  });

  it('a 30-day-old upload that never finished is closed when its photos go: no new upload URL, late PUT removed', async () => {
    const s = await uploadingScan();
    api.providers.storage.objects.add(s.path);
    await later(31 * 86_400_000, async () => {
      await runScheduledTick(deps);
      expect(api.providers.storage.objects.has(s.path)).toBe(false);
      const [row] = await api.db.sql<{ status: string }[]>`
        select status from public.assignments where id = ${s.id}`;
      expect(row!.status).toBe('cancelled');
      // Resuming the upload would sign a fresh URL for a page retention already removed.
      const resumed = await api.request(`/v1/assignments/${s.id}/uploads`, {
        method: 'POST',
        token: await parentToken(s.fam.ownerId),
        body: {
          pages: [
            { pageNumber: 1, mimeType: 'image/jpeg', byteSize: 250_000, sha256: 'f'.repeat(64) },
          ],
        },
      });
      expect(resumed.status).not.toBe(200);
    });
    api.providers.storage.objects.add(s.path); // a URL signed before the sweep is used late
    await later(31 * 86_400_000 + LATE_UPLOAD_WINDOW_MS + 60_000, () => runScheduledTick(deps));
    expect(api.providers.storage.objects.has(s.path)).toBe(false);
  });

  it('a page whose upload window closed long ago needs no second pass', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const path = await storedPage(fam, 0, new Date(api.now.value.getTime() - 40 * 86_400_000));
    // Finalized (uploads closed) well over the window ago.
    await api.db.sql`
      update public.assignments set status = 'uploading'
       where id = (select assignment_id from public.source_pages where storage_path = ${path})`;
    await api.db.sql`
      update public.assignments set status = 'queued'
       where id = (select assignment_id from public.source_pages where storage_path = ${path})`;
    await api.db.sql`
      update public.assignments set uploads_closed_at = now() - interval '39 days'
       where id = (select assignment_id from public.source_pages where storage_path = ${path})`;
    await purgeExpiredScans(deps);
    expect(api.providers.storage.objects.has(path)).toBe(false);
    expect(await pendingRemovals(path)).toBe(0);
  });
});

describe('inactivity never deletes a family the store may still charge (RV-lead-jobs-ai-13)', () => {
  const enabled = (): JobDeps => ({
    ...deps,
    config: { ...api.config, flags: { ...api.config.flags, inactivityDeletionEnabled: true } },
  });

  async function notifiedIdleFamily(): Promise<SeededFamily> {
    const fam = await seedFamily(api.db, { childCount: 1 });
    await api.db.sql`
      update public.families set created_at = '2025-06-01T00:00:00Z',
             inactivity_notified_at = ${new Date(api.now.value.getTime() - 31 * 86_400_000)}
       where id = ${fam.familyId}`;
    return fam;
  }

  async function entitlement(
    fam: SeededFamily,
    status: string,
    options: { periodEndDaysAgo: number; autoRenew: boolean },
  ): Promise<void> {
    const now = api.now.value.getTime();
    await api.db.sql`
      insert into public.family_entitlements (family_id, channel, provider_subscription_id, product_id, paid_slots, status,
        environment, period_start, period_end, auto_renew, provider_updated_at, fetched_at)
      values (${fam.familyId}, 'app_store', ${'rc:' + randomUUID()}, 'pl_family_1', 1, ${status}, 'sandbox',
              ${new Date(now - (options.periodEndDaysAgo + 30) * 86_400_000)},
              ${new Date(now - options.periodEndDaysAgo * 86_400_000)}, ${options.autoRenew},
              ${new Date(now - options.periodEndDaysAgo * 86_400_000)}, ${api.now.value})`;
  }

  async function deleted(familyId: string): Promise<boolean> {
    const [row] = await api.db.sql<{ deleted: boolean }[]>`
      select deleted_at is not null as deleted from public.families where id = ${familyId}`;
    return row!.deleted;
  }

  it('a store grace period or billing retry past period_end counts as paying; an ended subscription does not', async () => {
    const grace = await notifiedIdleFamily();
    await entitlement(grace, 'grace_period', { periodEndDaysAgo: 2, autoRenew: true });
    const retry = await notifiedIdleFamily();
    await entitlement(retry, 'billing_retry', { periodEndDaysAgo: 2, autoRenew: true });
    // A renewal the webhooks have not reported yet: still auto-renewing after period_end.
    const unreported = await notifiedIdleFamily();
    await entitlement(unreported, 'active', { periodEndDaysAgo: 1, autoRenew: true });
    const ended = await notifiedIdleFamily();
    await entitlement(ended, 'cancelled_active', { periodEndDaysAgo: 2, autoRenew: false });
    await inactivitySweep(enabled());
    expect(await deleted(grace.familyId)).toBe(false);
    expect(await deleted(retry.familyId)).toBe(false);
    expect(await deleted(unreported.familyId)).toBe(false);
    expect(await deleted(ended.familyId)).toBe(true); // control: the store will not charge again
  });
});
