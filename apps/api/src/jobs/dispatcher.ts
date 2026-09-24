import { addMonths, calendarMonthOf } from '@pencillift/domain';
import type { Tx } from '../db.ts';
import type { AppDeps } from '../middleware/context.ts';
import { runIdentityHousekeeping } from '../auth/housekeeping.ts';
import {
  resolveUnreachableRedemptions,
  reverifyFormerHolders,
  syncFamilyFromProvider,
} from '../services/billing-sync.ts';
import { enqueueDueLearningJobs } from './learning-jobs.ts';
import { purgeExpiredServes } from '../services/monetization-retention.ts';
import { runDonationAccrual, runGeneration } from '../services/p17-jobs.ts';

/**
 * Durable scheduled work (spec E4 Scheduling, V2). A Cloudflare Cron Trigger calls `runScheduledTick`
 * every few minutes; every task is idempotent, so overlapping or repeated ticks are harmless. Jobs
 * live in the Postgres job ledger (migration 0600), claimed one at a time with SKIP LOCKED and a
 * lease longer than a Worker invocation can live, so concurrent workers never run the same job;
 * retries are bounded and end in a dead-letter state with per-kind compensation. Each sweep is
 * isolated: one failing step never stops the others or the job ledger. Nothing depends on an
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

/**
 * A handler may ask to run again later without spending an attempt (a pause, not a failure: e.g. the
 * owner's AI spend ceiling is reached). The job becomes retryable at `runAfter`.
 */
export interface JobDeferral {
  readonly kind: 'defer';
  readonly runAfter: Date;
  readonly code: string;
}

/** Why a job was dead-lettered: its lease expired on the final attempt, or the handler failed it. */
export type DeadLetterReason = 'LOCK_EXPIRED' | 'ATTEMPTS_EXHAUSTED';

export type JobHandler = ((deps: JobDeps, job: JobRow) => Promise<void | JobDeferral>) & {
  /**
   * Compensation for a dead-lettered job whose handler could not settle its own state (e.g. the
   * worker died on the final attempt). Must be idempotent; failures are logged, never thrown.
   */
  readonly onDeadLetter?: (deps: JobDeps, job: JobRow, reason: DeadLetterReason) => Promise<void>;
};

export const RAW_SCAN_RETENTION_DAYS = 30;
/**
 * A claimed job's lease. Longer than a Cron Trigger invocation can live (15 minutes wall time), so a
 * lease only expires when its worker is really gone (RV-lead-jobs-ai-1).
 */
export const JOB_LEASE_MINUTES = 20;
/** A tick stops claiming new jobs after this long; the next tick continues. */
const TICK_CLAIM_BUDGET_MS = 10 * 60_000;
/**
 * Signed upload URLs are honoured for two hours (Supabase fixes the lifetime server-side); one more
 * hour covers an upload still in flight. An object removed less than this long after its scan stopped
 * accepting uploads is removed a second time once the window has passed. Equals the database's
 * app.late_upload_window() (tested).
 */
export const LATE_UPLOAD_WINDOW_MS = 3 * 3600_000;
/** The daily inactivity sweep runs on the first tick at or after this UTC hour. */
export const INACTIVITY_SWEEP_HOUR_UTC = 3;
const RESERVATION_TIMEOUT_MINUTES = 30;
const GENERATION_LEAD_DAYS = 5;
const EXPORT_EXTENSIONS = ['json', 'pdf', 'csv'] as const;

// ---------------------------------------------------------------------------------------------
// Deletion purge
// ---------------------------------------------------------------------------------------------

/**
 * Deletion: remove private storage objects first (homework pages and export files), then purge rows
 * and schedule a second storage pass for anything a still-valid signed upload writes afterwards (a
 * retry can never orphan files, and a late upload cannot outlive the deletion).
 */
export const deletionPurgeHandler: JobHandler = async (deps, job) => {
  if (!job.family_id) throw new Error('deletion_purge job without family');
  const familyId = job.family_id;
  const childId =
    job.child_id ?? (typeof job.payload.childId === 'string' ? job.payload.childId : null);
  const now = deps.clock();
  const { pages, exports } = await deps.db.asService(async (tx) => ({
    // Pages whose object may exist: never confirmed removed, or removed while a signed upload URL
    // could still write it again (whoever removed it, e.g. the retention step of this very tick).
    // Older removals are final; the purge is the last chance, because it deletes the paths.
    pages: await tx<{ storage_path: string; upload_window_open: boolean }[]>`
      select storage_path, app.upload_window_open(assignment_id) as upload_window_open
        from public.source_pages
       where family_id = ${familyId} and (${childId}::uuid is null or child_id = ${childId}::uuid)
         and (storage_removed_at is null or app.upload_window_open(assignment_id))
    `,
    // A family-wide export (child_id null) holds every child's records: a child deletion removes it.
    exports: await tx<{ id: string; storage_path: string | null; status: string }[]>`
      select id, storage_path, status from public.data_exports
       where family_id = ${familyId}
         and (${childId}::uuid is null or child_id = ${childId}::uuid or child_id is null)
    `,
  }));
  // An export still being built may upload its file after the purge: its path is deterministic.
  const pendingExportPaths = exports
    .filter((e) => e.status === 'queued')
    .flatMap((e) => EXPORT_EXTENSIONS.map((ext) => `exports/${familyId}/${e.id}.${ext}`));
  const paths = [
    ...pages.map((p) => p.storage_path),
    ...exports.flatMap((e) => (e.storage_path ? [e.storage_path] : [])),
    ...pendingExportPaths,
  ];
  if (paths.length > 0) await deps.providers.storage.remove(paths);
  // Pages a still-valid signed URL can write, and pending exports, are removed again after the
  // upload window closes (RV-lead-jobs-ai-20).
  const late = [
    ...new Set([
      ...pages.filter((p) => p.upload_window_open).map((p) => p.storage_path),
      ...pendingExportPaths,
    ]),
  ];
  const removeAfter = new Date(now.getTime() + LATE_UPLOAD_WINDOW_MS);
  await deps.db.asService(async (tx) => {
    await tx`select app.purge_family_data(${familyId}, ${childId}::uuid)`;
    if (late.length > 0) {
      await tx`
        insert into private.storage_removals (storage_path, remove_after, reason)
        select p, ${removeAfter}, 'deletion_late_upload' from unnest(${late}::text[]) as p
      `;
    }
  });
};

export const DEFAULT_HANDLERS: Readonly<Record<string, JobHandler>> = {
  deletion_purge: deletionPurgeHandler,
};

export interface TickReport {
  generatedCampaigns: number;
  donationAccruals: number;
  expiredReservations: number;
  retentionPurgedPages: number;
  expiredExports: number;
  lateStorageRemovals: number;
  spendAlerts: number;
  placementServesPurged: number;
  entitlementsReconciled: number;
  inactivity: { notified: number; deleted: number };
  /** Rate-limit buckets and sign-out records cleared in bulk (migration 0720). */
  identityHousekeeping: { rateLimitBuckets: number; endedAuthSessions: number };
  /** Daily, Thursday and top-up jobs queued this tick (0 when learning handlers are not registered). */
  learningJobsEnqueued: number;
  jobs: { succeeded: number; retried: number; deadLettered: number };
  /** Steps that failed this tick (logged by code); the other steps still ran. */
  failedSteps: string[];
}

// ---------------------------------------------------------------------------------------------
// Job ledger
// ---------------------------------------------------------------------------------------------

/** Claims the oldest due job (run_after order) with a fresh lease; null when nothing is due. */
async function claimNext(deps: JobDeps, kinds: readonly string[]): Promise<JobRow | null> {
  const now = deps.clock();
  const [row] = await deps.db.asService(
    (tx) => tx<JobRow[]>`
      update public.jobs set status = 'running', attempts = attempts + 1,
             locked_until = ${new Date(now.getTime() + JOB_LEASE_MINUTES * 60_000)}
       where id = (
         select j.id from public.jobs j
          where j.status in ('queued', 'failed_retryable') and j.run_after <= ${now}
            and j.kind = any(${[...kinds]})
            and (j.family_id is null or j.kind = 'deletion_purge'
                 or exists (select 1 from public.families f where f.id = j.family_id and f.deleted_at is null))
          order by j.run_after, j.created_at, j.id
          for update of j skip locked
          limit 1
       )
      returning id, kind, family_id, child_id, payload, attempts, max_attempts
    `,
  );
  return row ?? null;
}

/** Updates a job only while this worker still holds its claim (status running, same attempt). */
async function fenced(
  deps: JobDeps,
  job: JobRow,
  update: (tx: Tx) => Promise<readonly unknown[]>,
): Promise<boolean> {
  const rows = await deps.db.asService(update);
  if (rows.length === 0) {
    // The lease was recovered by another tick, or a deletion purge removed the job.
    deps.log({ level: 'warn', event: 'job_claim_lost', code: job.kind });
    return false;
  }
  return true;
}

async function compensateDeadLetter(
  deps: JobDeps,
  handlers: Readonly<Record<string, JobHandler>>,
  job: JobRow,
  reason: DeadLetterReason,
): Promise<void> {
  deps.log({ level: 'error', event: 'job_dead_letter', code: job.kind });
  const onDeadLetter = handlers[job.kind]?.onDeadLetter;
  if (!onDeadLetter) return;
  try {
    await onDeadLetter(deps, job, reason);
  } catch {
    deps.log({ level: 'error', event: 'job_dead_letter_compensation_failed', code: job.kind });
  }
}

function isDeferral(value: unknown): value is JobDeferral {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'defer' &&
    (value as { runAfter?: unknown }).runAfter instanceof Date
  );
}

export async function runJobs(
  deps: JobDeps,
  handlers: Readonly<Record<string, JobHandler>> = DEFAULT_HANDLERS,
  limit = 25,
): Promise<TickReport['jobs']> {
  const started = deps.clock();
  const report = { succeeded: 0, retried: 0, deadLettered: 0 };
  // Recover jobs whose worker died mid-run (lease expired while still "running"). A final attempt
  // lost this way is dead-lettered AND compensated (RV-lead-jobs-ai-2).
  const recovered = await deps.db.asService(
    (tx) => tx<(JobRow & { status: string })[]>`
      update public.jobs set status = case when attempts >= max_attempts then 'dead_letter' else 'failed_retryable' end,
             last_error_code = 'LOCK_EXPIRED', locked_until = null
       where status = 'running' and locked_until < ${started}
      returning id, kind, family_id, child_id, payload, attempts, max_attempts, status
    `,
  );
  for (const job of recovered.filter((j) => j.status === 'dead_letter')) {
    await compensateDeadLetter(deps, handlers, job, 'LOCK_EXPIRED');
    report.deadLettered += 1;
  }
  // Work for a tombstoned family can never run (the job guard would also refuse to start it, and one
  // refused row must not block the claim). The deletion purge itself is exempt.
  await deps.db.asService(
    (tx) => tx`
      update public.jobs j set status = 'cancelled', locked_until = null, last_error_code = 'FAMILY_DELETED'
        from public.families f
       where f.id = j.family_id and f.deleted_at is not null
         and j.kind <> 'deletion_purge' and j.status in ('queued', 'failed_retryable')
    `,
  );

  const kinds = Object.keys(handlers);
  // One job per claim: a job's lease starts when it starts, so a long job never lets the next
  // tick "recover" (and run again) jobs that are claimed but still waiting (RV-lead-jobs-ai-1).
  for (let n = 0; n < limit; n += 1) {
    if (deps.clock().getTime() - started.getTime() > TICK_CLAIM_BUDGET_MS) break;
    let job: JobRow | null;
    try {
      job = await claimNext(deps, kinds);
    } catch {
      // e.g. the family was tombstoned between the filter and the guard; the next tick cancels it.
      deps.log({ level: 'warn', event: 'job_claim_failed' });
      break;
    }
    if (!job) break;
    await runOne(deps, handlers, job, report);
  }
  return report;
}

async function runOne(
  deps: JobDeps,
  handlers: Readonly<Record<string, JobHandler>>,
  job: JobRow,
  report: TickReport['jobs'],
): Promise<void> {
  const handler = handlers[job.kind]!;
  let outcome: void | JobDeferral;
  try {
    outcome = await handler(deps, job);
  } catch (error) {
    const dead = job.attempts >= job.max_attempts;
    const backoffMs = Math.min(6 * 3600_000, 60_000 * 2 ** (job.attempts - 1));
    const owned = await fenced(
      deps,
      job,
      (tx) => tx`
        update public.jobs set status = ${dead ? 'dead_letter' : 'failed_retryable'}, locked_until = null,
               run_after = ${new Date(deps.clock().getTime() + backoffMs)},
               last_error_code = ${error instanceof Error ? error.name : 'Error'}
         where id = ${job.id} and status = 'running' and attempts = ${job.attempts}
        returning id
      `,
    );
    if (!owned) return;
    if (dead) {
      await compensateDeadLetter(deps, handlers, job, 'ATTEMPTS_EXHAUSTED');
      report.deadLettered += 1;
    } else {
      deps.log({ level: 'warn', event: 'job_retry', code: job.kind });
      report.retried += 1;
    }
    return;
  }
  if (isDeferral(outcome)) {
    const deferral = outcome;
    // A pause is not a failure: the attempt is given back.
    const owned = await fenced(
      deps,
      job,
      (tx) => tx`
        update public.jobs set status = 'failed_retryable', locked_until = null,
               attempts = attempts - 1, run_after = ${deferral.runAfter},
               last_error_code = ${deferral.code}
         where id = ${job.id} and status = 'running' and attempts = ${job.attempts}
        returning id
      `,
    );
    if (owned) {
      deps.log({ level: 'warn', event: 'job_deferred', code: job.kind });
      report.retried += 1;
    }
    return;
  }
  const owned = await fenced(
    deps,
    job,
    (tx) => tx`
      update public.jobs set status = 'succeeded', locked_until = null
       where id = ${job.id} and status = 'running' and attempts = ${job.attempts}
      returning id
    `,
  );
  if (owned) report.succeeded += 1;
}

// ---------------------------------------------------------------------------------------------
// Retention sweeps
// ---------------------------------------------------------------------------------------------

/**
 * Raw scan retention (spec P4: 30 days by default). Every page whose object may still exist
 * (storage_removed_at null) is removed once it is 30 days old, or right away when its row was
 * soft-deleted or its scan cancelled/deleted (a failed immediate delete is retried here, RV-5).
 * Objects go first; the rows are marked only after storage confirmed the removal.
 *
 * A removal is final only once no signed upload URL can write the object again: marking a page
 * removed inside its scan's upload window schedules a second pass in the same transaction (database
 * trigger, see 0710), and a 30-day-old scan still accepting uploads is closed (cancelled) before its
 * photos go, so no new URL can be signed for a page retention removed.
 */
export async function purgeExpiredScans(deps: JobDeps): Promise<number> {
  const now = deps.clock();
  const cutoff = new Date(now.getTime() - RAW_SCAN_RETENTION_DAYS * 86_400_000);
  const pages = await deps.db.asService(
    (tx) => tx<{ id: string; storage_path: string; assignment_id: string; open: boolean }[]>`
      select p.id, p.storage_path, p.assignment_id, a.status in ('draft', 'uploading') as open
        from public.source_pages p
        join public.assignments a on a.id = p.assignment_id and a.family_id = p.family_id
       where p.storage_removed_at is null
         and (p.created_at < ${cutoff} or p.deleted_at is not null or a.status in ('cancelled', 'deleted'))
       order by p.created_at
       limit 500
    `,
  );
  if (pages.length === 0) return 0;
  const stale = [...new Set(pages.filter((p) => p.open).map((p) => p.assignment_id))];
  if (stale.length > 0) {
    // Compare-and-set: a scan finalized meanwhile is left alone (its pages still go at 30 days).
    const closed = await deps.db.asService(
      (tx) => tx`
        update public.assignments set status = 'cancelled'
         where id = any(${stale}::uuid[]) and status in ('draft', 'uploading')
        returning id
      `,
    );
    if (closed.length > 0) {
      deps.log({ level: 'info', event: 'retention_closed_stale_upload', code: 'RETENTION' });
    }
  }
  await deps.providers.storage.remove(pages.map((p) => p.storage_path));
  await deps.db.asService(
    (tx) => tx`
      update public.source_pages
         set storage_removed_at = ${now}, deleted_at = coalesce(deleted_at, ${now})
       where id = any(${pages.map((p) => p.id)})
    `,
  );
  return pages.length;
}

/**
 * Expired exports (7-day TTL): the private file is removed and the row marked expired, so answer
 * keys and whole-family data never sit in storage indefinitely (RV-lead-jobs-ai-6).
 */
export async function purgeExpiredExports(deps: JobDeps, limit = 200): Promise<number> {
  const now = deps.clock();
  const rows = await deps.db.asService(
    (tx) => tx<{ id: string; storage_path: string | null }[]>`
      select id, storage_path from public.data_exports
       where status = 'ready' and expires_at < ${now}
       order by expires_at
       limit ${limit}
    `,
  );
  if (rows.length === 0) return 0;
  const paths = rows.flatMap((r) => (r.storage_path ? [r.storage_path] : []));
  if (paths.length > 0) await deps.providers.storage.remove(paths);
  await deps.db.asService(
    (tx) => tx`
      update public.data_exports set status = 'expired', storage_path = null
       where id = any(${rows.map((r) => r.id)}) and status = 'ready'
    `,
  );
  return rows.length;
}

/**
 * The second storage pass after a deletion (RV-lead-jobs-ai-20): objects a still-valid signed upload
 * wrote after the purge removed their rows. Rows are deleted only after storage confirms.
 */
export async function purgeLateUploads(deps: JobDeps, limit = 500): Promise<number> {
  const now = deps.clock();
  const due = await deps.db.asService(
    (tx) => tx<{ id: string; storage_path: string }[]>`
      select id, storage_path from private.storage_removals
       where remove_after <= ${now}
       order by remove_after
       limit ${limit}
    `,
  );
  if (due.length === 0) return 0;
  const ids = due.map((d) => d.id);
  try {
    await deps.providers.storage.remove([...new Set(due.map((d) => d.storage_path))]);
  } catch (error) {
    await deps.db.asService(
      (tx) =>
        tx`update private.storage_removals set attempts = attempts + 1 where id = any(${ids})`,
    );
    throw error;
  }
  await deps.db.asService((tx) => tx`delete from private.storage_removals where id = any(${ids})`);
  return due.length;
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
  // In-flight redemptions whose target can no longer happen are resolved from provider state
  // (RV-lead-billing-p17-2): the family is never blocked for good and cap slots do not leak.
  const resolved = await deps.db.asService((tx) => resolveUnreachableRedemptions(tx, deps.clock()));
  return rows.length + resolved.length;
}

/**
 * Spend alerts (spec F4): once per threshold (default 50/80/100%) of the owner's monthly AI budget.
 * No budget row means no alerts — the owner's cap is never invented (docs/Owner_Actions.md #9).
 */
export async function recordSpendAlerts(deps: JobDeps): Promise<number[]> {
  const now = deps.clock();
  const periodKey = now.toISOString().slice(0, 7);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return deps.db.asService(async (tx) => {
    const [budget] = await tx<
      {
        id: string;
        budget_micros: string;
        thresholds: number[];
        alerted: number[];
        spent: string;
      }[]
    >`
      select b.id, b.budget_micros::text, b.alert_thresholds_percent as thresholds,
             b.alerted_thresholds_percent as alerted,
             coalesce((select sum(cost_micros) from public.ai_usage_events
                        where created_at >= ${monthStart}), 0)::text as spent
        from public.spend_budgets b
       where b.scope = 'global' and b.period_key = ${periodKey}
       for update
    `;
    if (!budget) return [];
    const spent = BigInt(budget.spent);
    const cap = BigInt(budget.budget_micros);
    const crossed = budget.thresholds
      .filter((t) => !budget.alerted.includes(t) && spent * 100n >= cap * BigInt(t))
      .sort((a, b) => a - b);
    if (crossed.length === 0) return [];
    await tx`
      update public.spend_budgets
         set alerted_thresholds_percent = ${[...budget.alerted, ...crossed]}::smallint[]
       where id = ${budget.id}
    `;
    for (const threshold of crossed) {
      await tx`
        insert into public.audit_events (actor_kind, action, target_type, target_id, metadata)
        values ('system', 'spend.threshold_crossed', 'spend_budget', ${budget.id},
                ${JSON.stringify({ periodKey, thresholdPercent: threshold })}::text::jsonb)
      `;
      deps.log({
        level: threshold >= 100 ? 'error' : 'warn',
        event: 'spend_threshold_crossed',
        code: `P${threshold}`,
      });
    }
    return crossed;
  });
}

/**
 * Entitlement safety net (spec P11): webhooks can be lost, so entitlements that are stale (not
 * fetched for a day) or past their period end are re-fetched from the provider and reconciled.
 */
export async function reconcileStaleEntitlements(deps: JobDeps, limit = 25): Promise<number> {
  const now = deps.clock();
  const staleBefore = new Date(now.getTime() - 86_400_000);
  const families = await deps.db.asService(
    (tx) => tx<{ id: string; billing_ref: string }[]>`
      select f.id, f.billing_ref from public.families f
       where f.deleted_at is null and exists (
         select 1 from public.family_entitlements e
          where e.family_id = f.id and e.status not in ('expired', 'revoked')
            and (e.fetched_at < ${staleBefore} or e.period_end < ${now})
       )
       order by f.id
       limit ${limit}
    `,
  );
  let reconciled = 0;
  for (const family of families) {
    try {
      // The same whole-family reconciliation as sync and webhooks: a subscription the provider no
      // longer lists stops granting, released children go back to draft (RV-billing-1/2).
      const result = await syncFamilyFromProvider(deps, family.id, family.billing_ref, now);
      if (result) {
        await reverifyFormerHolders(deps, family.id, result.newClaims, now, 'scheduled');
        reconciled += 1;
      }
    } catch {
      // One provider failure never stops the sweep; the next tick retries this family.
      deps.log({ level: 'warn', event: 'entitlement_reconcile_failed' });
    }
  }
  return reconciled;
}

// ---------------------------------------------------------------------------------------------
// Inactivity retention
// ---------------------------------------------------------------------------------------------

/** Latest adult or child activity of family `f` (same rule as app.inactivity_delete_family). */
const lastActive = (tx: Tx) => tx`greatest(
  f.created_at,
  coalesce((select max(m.last_seen_at) from public.family_memberships m where m.family_id = f.id), f.created_at),
  coalesce((select max(a.created_at) from public.assignments a where a.family_id = f.id), f.created_at),
  coalesce((select max(t.created_at) from public.attempts t where t.family_id = f.id), f.created_at))`;

/**
 * Inactivity retention (spec P4). Disabled unless the owner enabled it. A family with no adult or
 * child activity for `inactivityMonths` gets a notice; the notice counts only once it was actually
 * delivered to a verified address (RV-11). If nothing happens for `inactivityNoticeDays` after a
 * delivered notice, the family is tombstoned and purged like a parent deletion. Any activity after a
 * notice voids it, so a later idle period needs a fresh notice (RV-12); a family a store may still
 * charge (current period, grace period, billing retry, or an unreported auto-renewal) is never
 * deleted (RV-13; one rule, app.family_may_be_charged). The database re-checks all of it under the
 * family row lock.
 */
export async function inactivitySweep(
  deps: JobDeps,
  limit = 50,
): Promise<{ notified: number; deleted: number }> {
  if (!deps.config.flags.inactivityDeletionEnabled) return { notified: 0, deleted: 0 };
  if (deps.config.environment === 'production' && deps.providers.email.isMock) {
    // A notice that goes to an in-memory outbox is not a notice: never delete on the strength of it.
    deps.log({ level: 'error', event: 'inactivity_sweep_blocked', code: 'EMAIL_PROVIDER_MOCK' });
    return { notified: 0, deleted: 0 };
  }
  const now = deps.clock();
  const idleBefore = new Date(now);
  idleBefore.setUTCMonth(idleBefore.getUTCMonth() - deps.config.inactivityMonths);
  const noticeBefore = new Date(now.getTime() - deps.config.inactivityNoticeDays * 86_400_000);

  // A notice answered by any activity (adult or child) is void.
  await deps.db.asService(
    (tx) => tx`
      update public.families f set inactivity_notified_at = null
       where f.deleted_at is null and f.inactivity_notified_at is not null
         and ${lastActive(tx)} >= f.inactivity_notified_at
    `,
  );

  // Only families that need something now: a first (or fresh) notice, or a notice period that is
  // over. Families waiting inside their notice period never crowd out the rest (RV-14).
  const candidates = await deps.db.asService(
    (tx) => tx<{ id: string; created_by: string; notified_at: Date | null }[]>`
      select f.id, f.created_by, f.inactivity_notified_at as notified_at
        from public.families f
       where f.deleted_at is null
         and ${lastActive(tx)} < ${idleBefore}
         and (f.inactivity_notified_at is null or f.inactivity_notified_at < ${noticeBefore})
         and not app.family_may_be_charged(f.id, ${now})
       order by f.inactivity_notified_at nulls first, f.id
       limit ${limit}
    `,
  );
  let notified = 0;
  let deleted = 0;
  for (const family of candidates) {
    try {
      if (family.notified_at === null) {
        if (await sendInactivityNotice(deps, family, now)) notified += 1;
      } else {
        const [row] = await deps.db.asService(
          (tx) => tx<{ id: string | null }[]>`
            select app.inactivity_delete_family(${family.id}, ${now}, ${idleBefore}, ${noticeBefore}) as id`,
        );
        if (row?.id) deleted += 1;
      }
    } catch {
      // One family's failure never stops the sweep; the next daily run retries it.
      deps.log({ level: 'warn', event: 'inactivity_family_failed' });
    }
  }
  return { notified, deleted };
}

/** Sends the notice; records it only after a verified address accepted it. */
async function sendInactivityNotice(
  deps: JobDeps,
  family: { id: string; created_by: string },
  now: Date,
): Promise<boolean> {
  const [contact] = await deps.db.asService(
    (tx) => tx<{ email: string | null; email_verified: boolean }[]>`
      select email, email_verified from app.adult_auth_email(${family.created_by})`,
  );
  if (!contact?.email || !contact.email_verified) {
    deps.log({
      level: 'warn',
      event: 'inactivity_notice_undeliverable',
      code: 'NO_VERIFIED_EMAIL',
    });
    return false;
  }
  let messageId: string;
  try {
    ({ messageId } = await deps.providers.email.send({
      to: contact.email,
      templateKey: 'inactivity_notice',
      params: { days: String(deps.config.inactivityNoticeDays) },
    }));
  } catch {
    deps.log({ level: 'warn', event: 'inactivity_notice_send_failed', code: 'EMAIL_SEND_FAILED' });
    return false;
  }
  await deps.db.asService(async (tx) => {
    const stamped = await tx`
      update public.families set inactivity_notified_at = ${now}
       where id = ${family.id} and deleted_at is null and inactivity_notified_at is null
      returning id`;
    if (stamped.length === 0) return;
    await tx`
      insert into public.audit_events (family_id, actor_kind, action, target_type, target_id, metadata)
      values (${family.id}, 'system', 'retention.inactivity_notice', 'family', ${family.id},
              ${JSON.stringify({ provider: deps.providers.email.name, messageId })}::text::jsonb)`;
  });
  return true;
}

/**
 * Claims today's run of a once-a-day sweep: true for the first tick at or after `hourUtc` each UTC
 * day, whatever minute the cron lands on (a late or skipped tick no longer skips the day).
 */
async function claimDailyRun(
  deps: JobDeps,
  sweep: 'inactivity',
  now: Date,
  hourUtc: number,
): Promise<string | null> {
  if (now.getUTCHours() < hourUtc) return null;
  const runKey = now.toISOString().slice(0, 10);
  const rows = await deps.db.asService(
    (tx) => tx`
      insert into private.sweep_runs (sweep, run_key, started_at) values (${sweep}, ${runKey}, ${now})
      on conflict do nothing
      returning run_key
    `,
  );
  return rows.length === 1 ? runKey : null;
}

async function releaseDailyRun(deps: JobDeps, sweep: 'inactivity', runKey: string): Promise<void> {
  await deps.db.asService(
    (tx) => tx`delete from private.sweep_runs where sweep = ${sweep} and run_key = ${runKey}`,
  );
}

// ---------------------------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------------------------

export async function runScheduledTick(
  deps: JobDeps,
  handlers: Readonly<Record<string, JobHandler>> = DEFAULT_HANDLERS,
): Promise<TickReport> {
  const now = deps.clock();
  const failedSteps: string[] = [];
  // Every step is isolated: a failure is logged by name and the rest of the tick (above all the job
  // ledger, which runs deletion purges and scans) still runs (RV-lead-jobs-ai-15).
  async function step<T>(name: string, fallback: T, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch {
      failedSteps.push(name);
      deps.log({ level: 'error', event: 'scheduled_step_failed', code: name });
      return fallback;
    }
  }

  const generatedCampaigns = await step('promo_generation', 0, async () => {
    const month = calendarMonthOf(now, 'UTC');
    const next = addMonths(month, 1);
    const monthsToGenerate = [month];
    const daysLeft =
      (Date.UTC(Number(next.slice(0, 4)), Number(next.slice(5, 7)) - 1, 1) - now.getTime()) /
      86_400_000;
    if (daysLeft <= GENERATION_LEAD_DAYS) monthsToGenerate.push(next);
    let created = 0;
    for (const m of monthsToGenerate) {
      created += (await runGeneration(deps.db, m, deps.random)).created.length;
    }
    return created;
  });
  const donationAccruals = await step('donation_accrual', 0, async () => {
    const programMonth = calendarMonthOf(now, deps.config.programTimezone);
    let accrued = 0;
    for (const m of [addMonths(programMonth, -1), programMonth]) {
      accrued += (await runDonationAccrual(deps.db, m, deps.config.programTimezone)).accrued;
    }
    return accrued;
  });
  const expiredReservations = await step('promo_reservations', 0, () =>
    expireStaleReservations(deps),
  );
  const retentionPurgedPages = await step('scan_retention', 0, () => purgeExpiredScans(deps));
  const expiredExports = await step('export_retention', 0, () => purgeExpiredExports(deps));
  const lateStorageRemovals = await step('late_upload_removal', 0, () => purgeLateUploads(deps));
  const spendAlerts = await step(
    'spend_alerts',
    0,
    async () => (await recordSpendAlerts(deps)).length,
  );
  // P16.5: short-lived placement anti-duplication state is kept 7 days at most.
  const placementServesPurged = await step(
    'placement_serves',
    0,
    async () => (await purgeExpiredServes(deps.db, now)).deleted,
  );
  const entitlementsReconciled = await step('entitlements', 0, () =>
    reconcileStaleEntitlements(deps),
  );
  // The inactivity scan aggregates activity across tables, so it runs once per UTC day: on the first
  // tick at or after 03:00 UTC (a durable marker, not a five-minute window).
  const inactivity = await step('inactivity', { notified: 0, deleted: 0 }, async () => {
    if (!deps.config.flags.inactivityDeletionEnabled) return { notified: 0, deleted: 0 };
    const runKey = await claimDailyRun(deps, 'inactivity', now, INACTIVITY_SWEEP_HOUR_UTC);
    if (runKey === null) return { notified: 0, deleted: 0 };
    try {
      return await inactivitySweep(deps);
    } catch (error) {
      await releaseDailyRun(deps, 'inactivity', runKey); // the next tick retries today's run
      throw error;
    }
  });
  const identityHousekeeping = await step(
    'identity_housekeeping',
    { rateLimitBuckets: 0, endedAuthSessions: 0 },
    () => runIdentityHousekeeping(deps.db, now),
  );
  // Learning jobs are queued only where a worker will run them, and before the job ledger so a due
  // set is built in the same tick.
  const learningJobsEnqueued = await step('learning_enqueue', 0, async () => {
    if (!handlers.daily_set_generate) return 0;
    const r = await enqueueDueLearningJobs(deps, now);
    return r.dailyJobs + r.reviewJobs + r.topUpJobs;
  });
  const jobs = await step('jobs', { succeeded: 0, retried: 0, deadLettered: 0 }, () =>
    runJobs(deps, handlers),
  );
  const report: TickReport = {
    generatedCampaigns,
    donationAccruals,
    expiredReservations,
    retentionPurgedPages,
    expiredExports,
    lateStorageRemovals,
    spendAlerts,
    placementServesPurged,
    entitlementsReconciled,
    inactivity,
    identityHousekeeping,
    learningJobsEnqueued,
    jobs,
    failedSteps,
  };
  deps.log({
    level: failedSteps.length > 0 ? 'warn' : 'info',
    event: 'scheduled_tick',
    ...(failedSteps.length > 0 ? { code: failedSteps.join(',') } : {}),
  });
  return report;
}
