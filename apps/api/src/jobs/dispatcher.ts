import { addMonths, calendarMonthOf } from '@pencillift/domain';
import type { AppDeps } from '../middleware/context.ts';
import { runDonationAccrual, runGeneration } from '../services/p17-jobs.ts';

/**
 * Durable scheduled work (spec E4 Scheduling, V2). A Cloudflare Cron Trigger calls `runScheduledTick`
 * every few minutes; every task is idempotent, so overlapping or repeated ticks are harmless. Jobs
 * live in the Postgres job ledger (migration 0600), claimed with SKIP LOCKED so concurrent workers
 * never run the same job, with bounded retries and a dead-letter state. Nothing depends on an
 * in-process timer or on any client staying open.
 */

export type JobDeps = Pick<AppDeps, 'db' | 'config' | 'clock' | 'random' | 'providers' | 'log'>;

export interface JobRow {
  id: string;
  kind: string;
  family_id: string | null;
  child_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export type JobHandler = (deps: JobDeps, job: JobRow) => Promise<void>;

export const RAW_SCAN_RETENTION_DAYS = 30;
const RESERVATION_TIMEOUT_MINUTES = 30;
const GENERATION_LEAD_DAYS = 5;
const LOCK_MINUTES = 10;

/** Deletion: remove private storage objects first, then purge rows (a retry can never orphan files). */
export const deletionPurgeHandler: JobHandler = async (deps, job) => {
  if (!job.family_id) throw new Error('deletion_purge job without family');
  const childId =
    job.child_id ?? (typeof job.payload.childId === 'string' ? job.payload.childId : null);
  const paths = await deps.db.asService(
    (tx) => tx<{ storage_path: string }[]>`
      select storage_path from public.source_pages
       where family_id = ${job.family_id} and (${childId}::uuid is null or child_id = ${childId}::uuid)
    `,
  );
  if (paths.length > 0) await deps.providers.storage.remove(paths.map((p) => p.storage_path));
  await deps.db.asService(
    (tx) => tx`select app.purge_family_data(${job.family_id}, ${childId}::uuid)`,
  );
};

export const DEFAULT_HANDLERS: Readonly<Record<string, JobHandler>> = {
  deletion_purge: deletionPurgeHandler,
};

export interface TickReport {
  generatedCampaigns: number;
  donationAccruals: number;
  expiredReservations: number;
  retentionPurgedPages: number;
  jobs: { succeeded: number; retried: number; deadLettered: number };
}

async function claimJobs(
  deps: JobDeps,
  kinds: readonly string[],
  limit: number,
): Promise<JobRow[]> {
  const now = deps.clock();
  return deps.db.asService(
    (tx) => tx<JobRow[]>`
      update public.jobs set status = 'running', attempts = attempts + 1,
             locked_until = ${new Date(now.getTime() + LOCK_MINUTES * 60_000)}
       where id in (
         select id from public.jobs
          where status in ('queued', 'failed_retryable') and run_after <= ${now} and kind = any(${[...kinds]})
          order by run_after
          for update skip locked
          limit ${limit}
       )
      returning id, kind, family_id, child_id, payload, attempts, max_attempts
    `,
  );
}

export async function runJobs(
  deps: JobDeps,
  handlers: Readonly<Record<string, JobHandler>> = DEFAULT_HANDLERS,
  limit = 25,
): Promise<TickReport['jobs']> {
  const now = deps.clock();
  // Recover jobs whose worker died mid-run (lock expired while still "running").
  await deps.db.asService(
    (tx) => tx`
      update public.jobs set status = case when attempts >= max_attempts then 'dead_letter' else 'failed_retryable' end,
             last_error_code = 'LOCK_EXPIRED', locked_until = null
       where status = 'running' and locked_until < ${now}
    `,
  );
  // Work for a tombstoned family can never run (the job guard would also refuse to start it, and one
  // refused row must not block the whole claim batch). The deletion purge itself is exempt.
  await deps.db.asService(
    (tx) => tx`
      update public.jobs j set status = 'cancelled', locked_until = null, last_error_code = 'FAMILY_DELETED'
        from public.families f
       where f.id = j.family_id and f.deleted_at is not null
         and j.kind <> 'deletion_purge' and j.status in ('queued', 'failed_retryable')
    `,
  );
  const report = { succeeded: 0, retried: 0, deadLettered: 0 };
  for (const job of await claimJobs(deps, Object.keys(handlers), limit)) {
    const handler = handlers[job.kind]!;
    try {
      await handler(deps, job);
      await deps.db.asService(
        (tx) =>
          tx`update public.jobs set status = 'succeeded', locked_until = null where id = ${job.id}`,
      );
      report.succeeded += 1;
    } catch (error) {
      const dead = job.attempts >= job.max_attempts;
      const backoffMs = Math.min(6 * 3600_000, 60_000 * 2 ** (job.attempts - 1));
      await deps.db.asService(
        (tx) => tx`
          update public.jobs set status = ${dead ? 'dead_letter' : 'failed_retryable'}, locked_until = null,
                 run_after = ${new Date(now.getTime() + backoffMs)},
                 last_error_code = ${error instanceof Error ? error.name : 'Error'}
           where id = ${job.id}
        `,
      );
      deps.log({
        level: dead ? 'error' : 'warn',
        event: dead ? 'job_dead_letter' : 'job_retry',
        code: job.kind,
      });
      if (dead) report.deadLettered += 1;
      else report.retried += 1;
    }
  }
  return report;
}

/** Raw scan retention (spec P4: 30 days by default): delete objects, then mark the page deleted. */
export async function purgeExpiredScans(deps: JobDeps): Promise<number> {
  const cutoff = new Date(deps.clock().getTime() - RAW_SCAN_RETENTION_DAYS * 86_400_000);
  const pages = await deps.db.asService(
    (tx) => tx<{ id: string; storage_path: string }[]>`
      select id, storage_path from public.source_pages where deleted_at is null and created_at < ${cutoff} limit 500
    `,
  );
  if (pages.length === 0) return 0;
  await deps.providers.storage.remove(pages.map((p) => p.storage_path));
  await deps.db.asService(
    (tx) =>
      tx`update public.source_pages set deleted_at = ${deps.clock()} where id = any(${pages.map((p) => p.id)})`,
  );
  return pages.length;
}

/** Reserved promo redemptions whose store step never started are released (never provider_pending). */
export async function expireStaleReservations(deps: JobDeps): Promise<number> {
  const cutoff = new Date(deps.clock().getTime() - RESERVATION_TIMEOUT_MINUTES * 60_000);
  const rows = await deps.db.asService(
    (tx) => tx`
      update public.promo_redemptions set state = 'expired'
       where state = 'reserved' and created_at < ${cutoff}
      returning id
    `,
  );
  return rows.length;
}

export async function runScheduledTick(
  deps: JobDeps,
  handlers: Readonly<Record<string, JobHandler>> = DEFAULT_HANDLERS,
): Promise<TickReport> {
  const now = deps.clock();
  const month = calendarMonthOf(now, 'UTC');
  const next = addMonths(month, 1);
  const monthsToGenerate = [month];
  const daysLeft =
    (Date.UTC(Number(next.slice(0, 4)), Number(next.slice(5, 7)) - 1, 1) - now.getTime()) /
    86_400_000;
  if (daysLeft <= GENERATION_LEAD_DAYS) monthsToGenerate.push(next);
  let generatedCampaigns = 0;
  for (const m of monthsToGenerate) {
    generatedCampaigns += (await runGeneration(deps.db, m, deps.random)).created.length;
  }
  const programMonth = calendarMonthOf(now, deps.config.programTimezone);
  let donationAccruals = 0;
  for (const m of [addMonths(programMonth, -1), programMonth]) {
    donationAccruals += (await runDonationAccrual(deps.db, m, deps.config.programTimezone)).accrued;
  }
  const expiredReservations = await expireStaleReservations(deps);
  const retentionPurgedPages = await purgeExpiredScans(deps);
  const jobs = await runJobs(deps, handlers);
  const report = {
    generatedCampaigns,
    donationAccruals,
    expiredReservations,
    retentionPurgedPages,
    jobs,
  };
  deps.log({ level: 'info', event: 'scheduled_tick' });
  return report;
}
