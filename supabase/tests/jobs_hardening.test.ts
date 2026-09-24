import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { grantAdultUnlock, seedFamily, type SeededFamily } from './fixtures.ts';

/**
 * Migration 0710 (jobs/deletion hardening, RV-lead-jobs-ai-3/12/13/15/17/18) against real Postgres:
 * deletion stops running scans, the purge clears the queue but keeps (pseudonymised) quota and cost
 * records, and inactivity deletion re-checks everything under the family row lock. Synthetic data.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.drop();
});

async function assignment(fam: SeededFamily, childIndex: number, status = 'extracting') {
  const [row] = await db.sql<{ id: string }[]>`
    insert into public.assignments (family_id, child_id, idempotency_key, created_by_kind, status)
    values (${fam.familyId}, ${fam.children[childIndex]!.id}, ${'k-' + randomUUID()}, 'child', 'draft')
    returning id`;
  // Walk the state machine the way the pipeline does.
  const path: Record<string, string[]> = {
    draft: [],
    queued: ['uploading', 'queued'],
    extracting: ['uploading', 'queued', 'extracting'],
    ready: ['uploading', 'queued', 'extracting', 'checking', 'verifying', 'ready'],
  };
  for (const step of path[status]!) {
    await db.sql`update public.assignments set status = ${step} where id = ${row!.id}`;
  }
  return row!.id;
}

async function statuses(ids: string[]): Promise<Record<string, string>> {
  const rows = await db.sql<{ id: string; status: string }[]>`
    select id, status from public.assignments where id = any(${ids})`;
  return Object.fromEntries(rows.map((r) => [r.id, r.status]));
}

describe('request_deletion stops in-flight processing (RV-lead-jobs-ai-3)', () => {
  it('a child deletion moves only that child’s assignments to deleted', async () => {
    const fam = await seedFamily(db, { childCount: 2 });
    const doomed = [await assignment(fam, 0, 'extracting'), await assignment(fam, 0, 'ready')];
    const kept = await assignment(fam, 1, 'extracting');
    await grantAdultUnlock(db, fam.ownerId);
    await db.asParent(
      fam.ownerId,
      (tx) => tx`select public.request_deletion(${fam.familyId}, ${fam.children[0]!.id})`,
    );
    expect(await statuses([...doomed, kept])).toEqual({
      [doomed[0]!]: 'deleted',
      [doomed[1]!]: 'deleted',
      [kept]: 'extracting',
    });
  });

  it('a family deletion moves every assignment to deleted', async () => {
    const fam = await seedFamily(db, { childCount: 2 });
    const ids = [await assignment(fam, 0, 'queued'), await assignment(fam, 1, 'extracting')];
    await grantAdultUnlock(db, fam.ownerId);
    await db.asParent(
      fam.ownerId,
      (tx) => tx`select public.request_deletion(${fam.familyId}, null)`,
    );
    expect(Object.values(await statuses(ids))).toEqual(['deleted', 'deleted']);
  });

  it('only the owner can delete the whole family; a guardian can still delete a child', async () => {
    const fam = await seedFamily(db, { childCount: 1 });
    const guardian = await db.createUser();
    await db.sql`
      insert into public.family_memberships (family_id, user_id, role)
      values (${fam.familyId}, ${guardian}, 'guardian')`;
    await grantAdultUnlock(db, guardian);
    await expect(
      db.asParent(guardian, (tx) => tx`select public.request_deletion(${fam.familyId}, null)`),
    ).rejects.toThrow(/only the family owner/);
    const [family] = await db.sql<{ deleted_at: Date | null }[]>`
      select deleted_at from public.families where id = ${fam.familyId}`;
    expect(family!.deleted_at).toBeNull();
    await db.asParent(
      guardian,
      (tx) => tx`select public.request_deletion(${fam.familyId}, ${fam.children[0]!.id})`,
    );
  });
});

describe('purge keeps quota and cost records, clears the queue (RV-lead-jobs-ai-17, -18)', () => {
  it('a child purge pseudonymises reservations and usage, deletes the child’s jobs and family-wide exports', async () => {
    const fam = await seedFamily(db, { childCount: 2 });
    const [doomed, sibling] = [fam.children[0]!.id, fam.children[1]!.id];
    const doomedScan = await assignment(fam, 0, 'ready');
    const siblingScan = await assignment(fam, 1, 'ready');
    for (const [child, units] of [
      [doomed, 40],
      [sibling, 3],
    ] as const) {
      await db.sql`
        insert into public.usage_reservations (family_id, child_id, period_key, units, idempotency_key, status)
        values (${fam.familyId}, ${child}, 'pages:2026-09', ${units}, ${'scan-usage:' + randomUUID() + ':v1'}, 'committed')`;
      await db.sql`
        insert into public.ai_usage_events (family_id, child_id, stage, model_id, prompt_version, status, input_tokens, output_tokens, latency_ms, cost_micros, rate_table_version)
        values (${fam.familyId}, ${child}, 'grading', 'gpt-5.6-terra', 'grading.v1', 'succeeded', 10, 10, 5, 700, 'test')`;
    }
    const job = (kind: string, childId: string | null, payload: Record<string, unknown>) => db.sql`
      insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, status)
      values (${kind}, ${kind + ':' + randomUUID()}, ${fam.familyId}, ${childId},
              ${JSON.stringify(payload)}::text::jsonb, 'succeeded')`;
    await job('scan_process', doomed, { assignmentId: doomedScan });
    await job('scan_process', null, { assignmentId: doomedScan }); // no child_id, payload only
    await job('daily_set_generate', null, { childId: doomed, localDate: '2026-09-24' });
    await job('scan_process', sibling, { assignmentId: siblingScan });
    const exports = await db.sql<{ id: string; child_id: string | null }[]>`
      insert into public.data_exports (family_id, requested_by, kind, child_id, status)
      values (${fam.familyId}, ${fam.ownerId}, 'family_data', null, 'ready'),
             (${fam.familyId}, ${fam.ownerId}, 'progress_pdf', ${sibling}, 'ready')
      returning id, child_id`;

    await grantAdultUnlock(db, fam.ownerId);
    await db.asParent(
      fam.ownerId,
      (tx) => tx`select public.request_deletion(${fam.familyId}, ${doomed})`,
    );
    await db.asService((tx) => tx`select app.purge_family_data(${fam.familyId}, ${doomed})`);

    const reservations = await db.sql<{ child_id: string | null; units: number; status: string }[]>`
      select child_id, units, status from public.usage_reservations where family_id = ${fam.familyId}
       order by units`;
    // The month's allowance stays used: the doomed child's 40 pages still count, unattributed.
    expect(reservations).toEqual([
      { child_id: sibling, units: 3, status: 'committed' },
      { child_id: null, units: 40, status: 'committed' },
    ]);
    const usage = await db.sql<{ child_id: string | null; cost: string }[]>`
      select child_id, cost_micros::text as cost from public.ai_usage_events where family_id = ${fam.familyId}
       order by child_id nulls first`;
    expect(usage).toEqual([
      { child_id: null, cost: '700' },
      { child_id: sibling, cost: '700' },
    ]);
    const jobs = await db.sql<{ kind: string; child_id: string | null }[]>`
      select kind, child_id from public.jobs where family_id = ${fam.familyId} order by kind`;
    expect(jobs).toEqual([
      { kind: 'deletion_purge', child_id: doomed }, // the deletion record: payload is the request id
      { kind: 'scan_process', child_id: sibling },
    ]);
    const left = await db.sql<{ id: string }[]>`
      select id from public.data_exports where family_id = ${fam.familyId}`;
    // The family-wide export held the deleted child's records; the sibling's own export stays.
    expect(left.map((r) => r.id)).toEqual([exports.find((e) => e.child_id === sibling)!.id]);
  });

  it('a family purge deletes every job except the deletion purge itself', async () => {
    const fam = await seedFamily(db, { childCount: 1 });
    await db.sql`
      insert into public.jobs (kind, idempotency_key, family_id, payload, status)
      values ('export_build', ${'export:' + randomUUID()}, ${fam.familyId}, '{}'::jsonb, 'succeeded')`;
    await grantAdultUnlock(db, fam.ownerId);
    await db.asParent(
      fam.ownerId,
      (tx) => tx`select public.request_deletion(${fam.familyId}, null)`,
    );
    await db.asService((tx) => tx`select app.purge_family_data(${fam.familyId}, null)`);
    const jobs = await db.sql<{ kind: string }[]>`
      select kind from public.jobs where family_id = ${fam.familyId}`;
    expect(jobs.map((j) => j.kind)).toEqual(['deletion_purge']);
  });

  it('outside a purge, quota and cost records stay immutable (even with the purge flag forged)', async () => {
    const fam = await seedFamily(db, { childCount: 1 });
    const child = fam.children[0]!.id;
    const [r] = await db.sql<{ id: string }[]>`
      insert into public.usage_reservations (family_id, child_id, period_key, units, idempotency_key)
      values (${fam.familyId}, ${child}, 'pages:2026-09', 2, ${'scan-usage:' + randomUUID() + ':v1'}) returning id`;
    await expect(
      db.asService(
        (tx) => tx`update public.usage_reservations set child_id = null where id = ${r!.id}`,
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.sql`
        insert into public.usage_reservations (family_id, child_id, period_key, units, idempotency_key)
        values (${fam.familyId}, null, 'pages:2026-09', 1, ${'scan-usage:' + randomUUID() + ':v1'})`,
    ).rejects.toThrow(/requires a child/);
    const [e] = await db.sql<{ id: string }[]>`
      insert into public.ai_usage_events (family_id, child_id, stage, model_id, prompt_version, status, input_tokens, output_tokens, latency_ms, cost_micros, rate_table_version)
      values (${fam.familyId}, ${child}, 'grading', 'gpt-5.6-terra', 'grading.v1', 'succeeded', 10, 10, 5, 700, 'test')
      returning id`;
    await expect(
      db.asService(async (tx) => {
        await tx`select set_config('pencillift.purging', 'on', true)`;
        await tx`update public.ai_usage_events set child_id = null where id = ${e!.id}`;
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.asService((tx) => tx`delete from public.ai_usage_events where id = ${e!.id}`),
    ).rejects.toThrow(/append-only/);
  });
});

describe('inactivity deletion re-checks under the row lock (RV-lead-jobs-ai-12, -13, -15)', () => {
  const NOW = new Date('2026-09-24T03:00:00Z');
  const IDLE_BEFORE = new Date('2025-09-24T03:00:00Z');
  const NOTICE_BEFORE = new Date('2026-08-25T03:00:00Z');

  async function idle(options: { notifiedAt?: Date | null; createdAt?: string } = {}) {
    const fam = await seedFamily(db, { childCount: 1 });
    await db.sql`
      update public.families set created_at = ${options.createdAt ?? '2025-06-01T00:00:00Z'},
             inactivity_notified_at = ${options.notifiedAt === undefined ? new Date('2026-08-01T00:00:00Z') : options.notifiedAt}
       where id = ${fam.familyId}`;
    return fam;
  }

  const del = (familyId: string) =>
    db.asService(
      (tx) => tx<{ id: string | null }[]>`
        select app.inactivity_delete_family(${familyId}, ${NOW}, ${IDLE_BEFORE}, ${NOTICE_BEFORE}) as id`,
    );

  async function tombstoned(familyId: string): Promise<boolean> {
    const [row] = await db.sql<{ deleted: boolean }[]>`
      select deleted_at is not null as deleted from public.families where id = ${familyId}`;
    return row!.deleted;
  }

  it('deletes an idle, notified, unpaid family: tombstone, assignments deleted, purge queued', async () => {
    const fam = await idle();
    const scan = await assignment(fam, 0, 'queued');
    await db.sql`update public.assignments set created_at = '2025-06-02T00:00:00Z' where id = ${scan}`;
    const [row] = await del(fam.familyId);
    expect(row!.id).not.toBeNull();
    expect(await tombstoned(fam.familyId)).toBe(true);
    expect(await statuses([scan])).toEqual({ [scan]: 'deleted' });
    const [job] = await db.sql<{ status: string }[]>`
      select status from public.jobs where family_id = ${fam.familyId} and kind = 'deletion_purge'`;
    expect(job!.status).toBe('queued');
  });

  it('skips (null, never raises) without a notice, after activity, inside the notice period or while paid', async () => {
    const noNotice = await idle({ notifiedAt: null });
    const answered = await idle();
    await db.sql`
      update public.family_memberships set last_seen_at = '2026-08-10T00:00:00Z' where family_id = ${answered.familyId}`;
    const recentNotice = await idle({ notifiedAt: new Date('2026-09-01T00:00:00Z') });
    const paying = await idle();
    await db.sql`
      insert into public.family_entitlements (family_id, channel, provider_subscription_id, product_id, paid_slots, status,
        environment, period_start, period_end, provider_updated_at, fetched_at)
      values (${paying.familyId}, 'app_store', ${'rc:' + randomUUID()}, 'pl_family_1', 1, 'active', 'sandbox',
              '2026-09-20T00:00:00Z', '2026-10-20T00:00:00Z', '2026-09-20T00:00:00Z', now())`;
    for (const fam of [noNotice, answered, recentNotice, paying]) {
      const [row] = await del(fam.familyId);
      expect(row!.id).toBeNull();
      expect(await tombstoned(fam.familyId)).toBe(false);
    }
  });

  it('is service-only', async () => {
    const fam = await idle();
    await expect(
      db.asParent(
        fam.ownerId,
        (tx) =>
          tx`select app.inactivity_delete_family(${fam.familyId}, ${NOW}, ${IDLE_BEFORE}, ${NOTICE_BEFORE})`,
      ),
    ).rejects.toThrow(/permission denied/);
    expect(await tombstoned(fam.familyId)).toBe(false);
  });
});

describe('a purged child never comes back through late usage metering (RV-lead-jobs-ai-18)', () => {
  const usage = (familyId: string, childId: string) => db.sql`
    insert into public.ai_usage_events (family_id, child_id, stage, model_id, prompt_version, status, input_tokens, output_tokens, latency_ms, cost_micros, rate_table_version)
    values (${familyId}, ${childId}, 'grading', 'gpt-5.6-terra', 'grading.v1', 'succeeded', 10, 10, 5, 700, 'test')`;

  async function keyed(childId: string): Promise<number> {
    const [row] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from public.ai_usage_events where child_id = ${childId}`;
    return row!.n;
  }

  it('a usage event recorded after the purge keeps its cost but not the child', async () => {
    const fam = await seedFamily(db, { childCount: 2 });
    const [doomed, sibling] = [fam.children[0]!.id, fam.children[1]!.id];
    await grantAdultUnlock(db, fam.ownerId);
    await db.asParent(
      fam.ownerId,
      (tx) => tx`select public.request_deletion(${fam.familyId}, ${doomed})`,
    );
    await db.asService((tx) => tx`select app.purge_family_data(${fam.familyId}, ${doomed})`);
    await usage(fam.familyId, doomed); // a stage that was in flight during the purge returns
    await usage(fam.familyId, sibling);
    expect(await keyed(doomed)).toBe(0);
    expect(await keyed(sibling)).toBe(1);
    const [kept] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from public.ai_usage_events where family_id = ${fam.familyId} and child_id is null`;
    expect(kept!.n).toBe(1);
  });

  it('an insert racing the purge transaction waits for it, then drops the child id', async () => {
    const fam = await seedFamily(db, { childCount: 1 });
    const doomed = fam.children[0]!.id;
    await grantAdultUnlock(db, fam.ownerId);
    await db.asParent(
      fam.ownerId,
      (tx) => tx`select public.request_deletion(${fam.familyId}, null)`,
    );
    let purged!: () => void;
    const purgeRan = new Promise<void>((resolve) => (purged = resolve));
    const purge = db.asService(async (tx) => {
      await tx`select app.purge_family_data(${fam.familyId}, null)`;
      purged();
      await new Promise((resolve) => setTimeout(resolve, 300)); // still uncommitted
    });
    await purgeRan;
    await Promise.all([purge, usage(fam.familyId, doomed)]);
    expect(await keyed(doomed)).toBe(0);
  });
});

describe('inactivity deletion treats a store still retrying payment as paying (RV-lead-jobs-ai-13)', () => {
  const NOW = new Date('2026-09-24T03:00:00Z');
  const IDLE_BEFORE = new Date('2025-09-24T03:00:00Z');
  const NOTICE_BEFORE = new Date('2026-08-25T03:00:00Z');

  async function idleWith(status: string, periodEnd: string, autoRenew: boolean) {
    const fam = await seedFamily(db, { childCount: 1 });
    await db.sql`
      update public.families set created_at = '2025-06-01T00:00:00Z',
             inactivity_notified_at = '2026-08-01T00:00:00Z'
       where id = ${fam.familyId}`;
    await db.sql`
      insert into public.family_entitlements (family_id, channel, provider_subscription_id, product_id, paid_slots, status,
        environment, period_start, period_end, auto_renew, provider_updated_at, fetched_at)
      values (${fam.familyId}, 'app_store', ${'rc:' + randomUUID()}, 'pl_family_1', 1, ${status}, 'sandbox',
              '2026-08-20T00:00:00Z', ${periodEnd}, ${autoRenew}, '2026-09-20T00:00:00Z', now())`;
    return fam;
  }

  const del = (familyId: string) =>
    db.asService(
      (tx) => tx<{ id: string | null }[]>`
        select app.inactivity_delete_family(${familyId}, ${NOW}, ${IDLE_BEFORE}, ${NOTICE_BEFORE}) as id`,
    );

  it('grace period, billing retry and an unreported auto-renewal are paying; an ended subscription is not', async () => {
    for (const [status, autoRenew] of [
      ['grace_period', true],
      ['grace_period', false],
      ['billing_retry', true],
      ['active', true],
    ] as const) {
      const fam = await idleWith(status, '2026-09-22T00:00:00Z', autoRenew); // period_end passed
      const [row] = await del(fam.familyId);
      expect(row!.id, `${status} auto_renew=${autoRenew}`).toBeNull();
    }
    for (const status of ['cancelled_active', 'active', 'expired']) {
      const fam = await idleWith(status, '2026-09-22T00:00:00Z', false);
      const [row] = await del(fam.familyId);
      expect(row!.id, status).not.toBeNull();
    }
  });

  it('the sweep and the function share one rule', async () => {
    const fam = await idleWith('grace_period', '2026-09-22T00:00:00Z', true);
    const [row] = await db.asService(
      (tx) => tx<{ paying: boolean }[]>`
        select app.family_may_be_charged(${fam.familyId}, ${NOW}) as paying`,
    );
    expect(row!.paying).toBe(true);
  });
});

describe('upload windows (RV-lead-jobs-ai-5, -20)', () => {
  async function closedAt(id: string): Promise<Date | null> {
    const [row] = await db.sql<{ at: Date | null }[]>`
      select uploads_closed_at as at from public.assignments where id = ${id}`;
    return row!.at;
  }

  it('an assignment records when it stopped accepting uploads, once', async () => {
    const fam = await seedFamily(db, { childCount: 1 });
    const draft = await assignment(fam, 0, 'draft');
    expect(await closedAt(draft)).toBeNull();
    await db.sql`update public.assignments set status = 'uploading' where id = ${draft}`;
    expect(await closedAt(draft)).toBeNull(); // uploads still open
    await db.sql`update public.assignments set status = 'queued' where id = ${draft}`;
    const closed = await closedAt(draft);
    expect(closed).not.toBeNull();
    await db.sql`update public.assignments set status = 'deleted' where id = ${draft}`;
    expect(await closedAt(draft)).toEqual(closed); // a later change keeps the closing time
    const cancelled = await assignment(fam, 0, 'draft');
    await db.sql`update public.assignments set status = 'cancelled' where id = ${cancelled}`;
    expect(await closedAt(cancelled)).not.toBeNull();
  });

  it('marking a page removed inside the upload window schedules a second storage pass', async () => {
    const fam = await seedFamily(db, { childCount: 1 });
    const recent = await assignment(fam, 0, 'queued'); // uploads closed just now
    const old = await assignment(fam, 0, 'queued');
    await db.sql`update public.assignments set uploads_closed_at = now() - interval '2 days' where id = ${old}`;
    const page = async (assignmentId: string) => {
      const id = randomUUID();
      const path = `${fam.familyId}/${fam.children[0]!.id}/${assignmentId}/${id}.jpg`;
      await db.sql`
        insert into public.source_pages (id, assignment_id, family_id, child_id, page_number, storage_path, mime_type, byte_size, sha256)
        values (${id}, ${assignmentId}, ${fam.familyId}, ${fam.children[0]!.id}, 1, ${path}, 'image/jpeg', 10, ${'d'.repeat(64)})`;
      return { id, path };
    };
    const [a, b] = [await page(recent), await page(old)];
    const removedAt = new Date('2026-09-24T15:00:00Z');
    await db.asService(
      (tx) => tx`
        update public.source_pages set storage_removed_at = ${removedAt}
         where id = any(${[a.id, b.id]}::uuid[])`,
    );
    const passes = await db.sql<{ storage_path: string; remove_after: Date }[]>`
      select storage_path, remove_after from private.storage_removals
       where storage_path = any(${[a.path, b.path]})`;
    expect(passes).toEqual([
      { storage_path: a.path, remove_after: new Date('2026-09-24T18:00:00Z') },
    ]);
  });
});

describe('private operational tables', () => {
  it('no client role can read storage removals, sweep markers or spend holds', async () => {
    const fam = await seedFamily(db, { childCount: 0 });
    for (const table of ['storage_removals', 'sweep_runs', 'ai_spend_holds']) {
      await expect(
        db.asParent(fam.ownerId, (tx) => tx.unsafe(`select 1 from private.${table}`)),
      ).rejects.toThrow(/permission denied/);
    }
  });
});
