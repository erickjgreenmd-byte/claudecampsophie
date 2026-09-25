import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cryptoRandom } from '@pencillift/domain';
import { seedFamily } from '@pencillift/db/testing/fixtures';
import {
  JOB_RETENTION_DAYS,
  RAW_SCAN_RETENTION_DAYS,
  runScheduledTick,
} from '../src/jobs/dispatcher.ts';
import type { JobDeps } from '../src/jobs/dispatcher.ts';
import { createTestApi, type TestApi } from './helpers.ts';

/**
 * Job ledger retention (BUG-139, migration 0840 `app.prune_terminal_jobs`): the tick's
 * `job_retention` step deletes terminal rows older than JOB_RETENTION_DAYS and keeps the
 * deletion_purge / account_close audit rows. Real local Postgres; synthetic ids only. Every fixture
 * instant derives from the pinned request clock (L-027), never from the database wall clock.
 */

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

const DAY_MS = 86_400_000;

/** A job row in `status`, last written `ageDays` before the pinned clock (guard trigger bypassed). */
async function agedJob(
  familyId: string,
  kind: string,
  status: string,
  ageDays: number,
): Promise<string> {
  const id = randomUUID();
  const stamp = new Date(api.now.value.getTime() - ageDays * DAY_MS);
  await api.db.sql.begin(async (tx) => {
    // app.guard_job stamps updated_at on every write, so the row's age is set with triggers off.
    await tx`set local session_replication_role = replica`;
    await tx`
      insert into public.jobs (id, kind, idempotency_key, family_id, status, max_attempts, run_after, created_at, updated_at)
      values (${id}, ${kind}, ${'retention:' + id}, ${familyId}, ${status}, 5, ${stamp}, ${stamp}, ${stamp})`;
  });
  return id;
}

async function remaining(ids: readonly string[]): Promise<Set<string>> {
  const rows = await api.db.sql<{ id: string }[]>`
    select id from public.jobs where id = any(${ids as string[]}::uuid[])`;
  return new Set(rows.map((r) => r.id));
}

describe('job ledger retention (BUG-139)', () => {
  it('keeps the horizon above the raw scan retention', () => {
    expect(JOB_RETENTION_DAYS).toBeGreaterThan(RAW_SCAN_RETENTION_DAYS);
  });

  it('prunes terminal rows older than the horizon and keeps everything else', async () => {
    const fam = await seedFamily(api.db);
    const old = JOB_RETENTION_DAYS + 5;
    const young = JOB_RETENTION_DAYS - 5;
    const gone = [
      await agedJob(fam.familyId, 'daily_set_generate', 'succeeded', old),
      await agedJob(fam.familyId, 'scan_process', 'cancelled', old),
      await agedJob(fam.familyId, 'export_build', 'dead_letter', old),
    ];
    const kept = [
      // Younger than the horizon, whatever the state.
      await agedJob(fam.familyId, 'daily_set_generate', 'succeeded', young),
      // Not terminal: a queued or retrying row is never retention's business.
      await agedJob(fam.familyId, 'scan_process', 'queued', old),
      await agedJob(fam.familyId, 'scan_process', 'failed_retryable', old),
      // The audit trail of a deletion stays.
      await agedJob(fam.familyId, 'deletion_purge', 'succeeded', old),
      await agedJob(fam.familyId, 'account_close', 'succeeded', old),
    ];

    const report = await runScheduledTick(deps);
    expect(report.failedSteps).not.toContain('job_retention');
    expect(report.prunedJobs).toBeGreaterThanOrEqual(gone.length);

    const left = await remaining([...gone, ...kept]);
    for (const id of gone) expect(left.has(id)).toBe(false);
    for (const id of kept) expect(left.has(id)).toBe(true);

    // A second tick finds nothing more to prune from this family.
    const again = await runScheduledTick(deps);
    expect((await remaining(kept)).size).toBe(kept.length);
    expect(again.failedSteps).not.toContain('job_retention');
  });
});
