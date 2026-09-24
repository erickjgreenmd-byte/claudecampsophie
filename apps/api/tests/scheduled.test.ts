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
  purgeExpiredScans,
  runJobs,
  runScheduledTick,
  type JobDeps,
  type JobHandler,
} from '../src/jobs/dispatcher.ts';
import { createTestApi, type TestApi } from './helpers.ts';

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
