import { addMonths, calendarMonthOf } from '@pencillift/domain';
import { MOCK_ENVIRONMENTS } from '../config.ts';
import { stateRequestInstant, type Tx } from '../db.ts';
import type { AppDeps } from '../middleware/context.ts';
import { runIdentityHousekeeping } from '../auth/housekeeping.ts';
import {
  TERMINAL_STATUSES,
  resolveUnreachableRedemptions,
  reverifyFormerHolders,
  syncFamilyFromProvider,
} from '../services/billing-sync.ts';
import {
  createExportBuildHandler,
  EXPORT_EXTENSIONS,
  exportPath,
  settleDeadLetteredExport,
  storageUploader,
  type ExportUploader,
} from './export-build.ts';
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
/** Terminal job rows are kept this long (BUG-139); must stay above RAW_SCAN_RETENTION_DAYS. */
export const JOB_RETENTION_DAYS = 90;
/**
 * A claimed job's lease. Longer than a Cron Trigger invocation can live (15 minutes wall time), so a
 * lease only expires when its worker is really gone (RV-lead-jobs-ai-1).
 */
export const JOB_LEASE_MINUTES = 20;
/** A tick stops claiming new jobs after this long; the next tick continues. */
const TICK_CLAIM_BUDGET_MS = 10 * 60_000;
/**
 * How long a Cron Trigger invocation lives in wall time. Measured against the TICK's start, not
 * runJobs' own (JOBS-R2-07): every earlier step of the tick is unbounded in time (an inactivity
 * sweep sends up to 50 emails with a 10 s timeout each, entitlement syncs call the store), so the
 * ledger can start late and must not claim work it has no time to finish.
 */
const TICK_WALL_LIMIT_MS = 15 * 60_000;
/**
 * The worst case, in wall time, a job of this kind may need. A job is not claimed unless that much
 * of the invocation is left, so a kill mid-run (which spends an attempt and leaves the job invisible
 * until its 20-minute lease expires) is not how a long job usually ends. A scan is the longest:
 * extraction, grading and verification plus up to two 45-second coaching calls per wrong answer.
 */
const JOB_WORST_CASE_MS: Readonly<Record<string, number>> = { scan_process: 7 * 60_000 };
const DEFAULT_JOB_WORST_CASE_MS = 60_000;
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

// ---------------------------------------------------------------------------------------------
// Failure codes and dead-letter successors
// ---------------------------------------------------------------------------------------------

/**
 * A job failure with a payload-free pipeline code (JOBS-R1-04). The ledger records `code` in
 * `last_error_code`, so an operator can tell a storage outage from a provider refusal there.
 */
export class JobFailure extends Error {
  constructor(
    readonly code: string,
    message: string = code,
  ) {
    super(message);
    this.name = 'JobFailure';
  }
}

/** A pipeline code: upper-case letters, digits and underscores (never free text or an id). */
const PIPELINE_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * What the ledger stores for a failure (JOBS-R1-04): the error's `code` when it is a pipeline code
 * (JobFailure, the scan's RetryableFailure/PermanentFailure, provider errors carrying one), else the
 * class name. Never the message, which may carry provider text.
 */
export function ledgerErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'Error';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && PIPELINE_CODE_RE.test(code) ? code : error.name;
}

/**
 * How long a dead-lettered deletion purge or account closure waits before its successor runs
 * (JOBS-R1-01): long enough for a storage or auth incident to be over, short enough that a deletion
 * still completes the same day.
 */
export const DEAD_LETTER_SUCCESSOR_DELAY_MS = 6 * 3600_000;

const RETRY_SUFFIX_RE = /:retry(\d+)$/;

/**
 * Compensation for the jobs that must eventually complete (deletion_purge, account_close;
 * JOBS-R1-01): a dead letter queues a versioned successor for the same work (idempotency key
 * `<original key>:retry<n>`, same kind, family, child, payload and attempt budget, due after
 * DEAD_LETTER_SUCCESSOR_DELAY_MS), logs an error with the code and writes an audit row naming the
 * job ids and codes only (no user id, request id or storage path). Terminal rows stay immutable
 * (migration 0600); the successor is a new row. Idempotent: the key is derived from the dead job,
 * so a repeated compensation inserts nothing.
 */
async function queueDeadLetterSuccessor(
  deps: JobDeps,
  job: JobRow,
  reason: DeadLetterReason,
  code: 'DELETION_PURGE_DEAD_LETTER' | 'ACCOUNT_CLOSE_DEAD_LETTER',
  shouldRequeue: (tx: Tx, lastErrorCode: string | null) => Promise<boolean>,
): Promise<void> {
  const outcome = await deps.db.asService(async (tx) => {
    const [dead] = await tx<{ idempotency_key: string; last_error_code: string | null }[]>`
      select idempotency_key, last_error_code from public.jobs
       where id = ${job.id} and status = 'dead_letter'`;
    if (!dead) return null;
    if (!(await shouldRequeue(tx, dead.last_error_code))) return null;
    const match = RETRY_SUFFIX_RE.exec(dead.idempotency_key);
    const retry = match ? Number(match[1]) + 1 : 1;
    const base = match ? dead.idempotency_key.slice(0, match.index) : dead.idempotency_key;
    const [successor] = await tx<{ id: string }[]>`
      insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, max_attempts, run_after)
      values (${job.kind}, ${`${base}:retry${retry}`}, ${job.family_id}, ${job.child_id},
              ${JSON.stringify(job.payload)}::text::jsonb, ${job.max_attempts},
              ${new Date(deps.clock().getTime() + DEAD_LETTER_SUCCESSOR_DELAY_MS)})
      on conflict (idempotency_key) do nothing
      returning id`;
    if (!successor) return null;
    await tx`
      insert into public.audit_events (family_id, actor_kind, action, target_type, target_id, metadata)
      values (${job.family_id}, 'system', 'job.dead_letter_requeued', 'job', ${job.id},
              ${JSON.stringify({
                kind: job.kind,
                code,
                reason,
                attempts: job.attempts,
                lastErrorCode: dead.last_error_code,
                successorJobId: successor.id,
                retry,
              })}::text::jsonb)`;
    return successor.id;
  });
  if (outcome !== null) deps.log({ level: 'error', event: 'job_dead_letter_requeued', code });
}

// ---------------------------------------------------------------------------------------------
// Deletion purge
// ---------------------------------------------------------------------------------------------

/**
 * Deletion: remove private storage objects first (homework pages and export files), then purge rows
 * and schedule a second storage pass for anything a still-valid signed upload writes afterwards (a
 * retry can never orphan files, and a late upload cannot outlive the deletion).
 *
 * A purge never stops for good (JOBS-R1-01): after its bounded retries a dead letter queues a
 * successor (onDeadLetter below) while the deletion request is still open, so a storage or database
 * incident delays a deletion by hours, never strands it; the owner's account_close keeps deferring
 * meanwhile.
 */
export const deletionPurgeHandler: JobHandler = Object.assign(
  (deps: JobDeps, job: JobRow): Promise<void> => runDeletionPurge(deps, job),
  {
    onDeadLetter: (deps: JobDeps, job: JobRow, reason: DeadLetterReason): Promise<void> => {
      if (!job.family_id) return Promise.resolve(); // malformed: no successor could ever succeed
      const requestId =
        typeof job.payload.deletionRequestId === 'string' ? job.payload.deletionRequestId : null;
      return queueDeadLetterSuccessor(
        deps,
        job,
        reason,
        'DELETION_PURGE_DEAD_LETTER',
        async (tx) => {
          // Nothing left to do once the request is no longer open (completed or cancelled).
          if (requestId === null || !UUID_RE.test(requestId)) return true;
          const open = await tx`
            select 1 from public.deletion_requests
             where id = ${requestId}::uuid and family_id = ${job.family_id}
               and status in ('requested', 'processing')`;
          return open.length > 0;
        },
      );
    },
  },
);

async function runDeletionPurge(deps: JobDeps, job: JobRow): Promise<void> {
  if (!job.family_id) throw new JobFailure('INVALID_JOB', 'deletion_purge job without family');
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
    .flatMap((e) => EXPORT_EXTENSIONS.map((ext) => exportPath(familyId, e.id, ext)));
  // JOBS-R2-01: a row that is not `ready` may still have its file in storage — an attempt whose
  // answer was lost stored the bytes without ever recording `storage_path`, and the row then became
  // `failed`. Nothing else ever removes such an object (the 7-day sweep only reads `ready` rows), so
  // a family deletion would otherwise leave a whole-family JSON, or an answer key, behind for ever.
  const unreadyExportPaths = exports
    .filter((e) => e.status !== 'ready')
    .flatMap((e) => EXPORT_EXTENSIONS.map((ext) => exportPath(familyId, e.id, ext)));
  const paths = [
    ...new Set([
      ...pages.map((p) => p.storage_path),
      ...exports.flatMap((e) => (e.storage_path ? [e.storage_path] : [])),
      ...unreadyExportPaths,
      ...pendingExportPaths,
    ]),
  ];
  if (paths.length > 0) {
    try {
      await deps.providers.storage.remove(paths);
    } catch {
      throw new JobFailure('STORAGE_REMOVE_FAILED');
    }
  }
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
}

// ---------------------------------------------------------------------------------------------
// Safety flag email (owner decision, 2026-09-25: the parent is the only safety recipient)
// ---------------------------------------------------------------------------------------------

/** Records that the provider refused the flag email; never overwrites a recorded delivery. */
async function recordFlagEmailFailed(deps: JobDeps, reportId: string): Promise<void> {
  await deps.db.asService(
    (tx) => tx`
      update public.safety_reports set parent_email_status = 'failed'
       where id = ${reportId} and parent_email_status = 'not_sent'`,
  );
}

/**
 * When the scan job files a system report (a safety flag) it enqueues this job with the report id
 * (scan-process.ts safetyResponse, once per report). The job emails every active guardian whose
 * address is verified that PencilLift flagged an answer for them to look at, and where: the
 * portal's privacy page. Template `safety_flag` with the portal address as its only parameter: no
 * child name, no homework text, no category, no report id (providers/index.ts EMAIL_TEMPLATES).
 *
 * The delivery is recorded on the report (migration 0790) so the family's list never claims an
 * email that was not sent: `sent` (with the instant) once at least one address accepted it,
 * `failed` from the first refusal on (the ledger retries a bounded number of times with backoff,
 * then dead-letters the job; the record stays `failed` unless a retry succeeds), `not_sent` when
 * no verified address exists (nothing to retry: the job ends). A recorded delivery is final: a
 * retry after it sends nothing, so no guardian is emailed twice for one flag.
 *
 * The labeled outbox mock is never used outside development and test (the inactivity-notice rule,
 * L-016): elsewhere the job refuses, records `failed` and fails, so the refusal is in the ledger
 * and the logs, never a "sent" that went nowhere.
 */
export const safetyFlagEmailHandler: JobHandler = Object.assign(
  async (deps: JobDeps, job: JobRow): Promise<void> => {
    const reportId = typeof job.payload.reportId === 'string' ? job.payload.reportId : null;
    if (!reportId || !job.family_id) throw new Error('safety_flag_email job without report');
    const now = deps.clock();
    const [report] = await deps.db.asService(
      (tx) => tx<{ email_status: string; visible: boolean }[]>`
        select r.parent_email_status as email_status, r.family_visible as visible
          from public.safety_reports r
          join public.families f on f.id = r.family_id and f.deleted_at is null
         where r.id = ${reportId} and r.family_id = ${job.family_id} and r.reporter_kind = 'system'`,
    );
    // Purged with the child or the family (the purge removes this job too), or not a flag.
    if (!report) return;
    // A retry after a recorded delivery: never a second email for one flag.
    if (report.email_status === 'sent') return;
    // Nothing for the family to look at while a report is held from its list (none is filed held
    // since the owner decision; the mechanism stays as a support tool).
    if (!report.visible) {
      deps.log({ level: 'warn', event: 'safety_flag_email_skipped', code: 'REPORT_HELD' });
      return;
    }
    if (deps.providers.email.isMock && !MOCK_ENVIRONMENTS.has(deps.config.environment)) {
      // An email that goes to an in-memory outbox is not an email: refuse it in staging as in
      // production (only development and test may use the labeled outbox).
      deps.log({ level: 'error', event: 'safety_flag_email_blocked', code: 'EMAIL_PROVIDER_MOCK' });
      await recordFlagEmailFailed(deps, reportId);
      throw new JobFailure('EMAIL_PROVIDER_MOCK');
    }
    const recipients = await deps.db.asService(
      (tx) => tx<{ email: string | null; email_verified: boolean }[]>`
        select e.email, e.email_verified
          from public.family_memberships m
          cross join lateral app.adult_auth_email(m.user_id) e
         where m.family_id = ${job.family_id} and m.status = 'active'
         order by m.role, m.created_at`,
    );
    const addresses = recipients.flatMap((r) => (r.email && r.email_verified ? [r.email] : []));
    if (addresses.length === 0) {
      deps.log({
        level: 'warn',
        event: 'safety_flag_email_undeliverable',
        code: 'NO_VERIFIED_EMAIL',
      });
      return;
    }
    // The accept link of guardian invitations points at the same portal origin (guardians.ts).
    const origin = deps.config.corsOrigins[0];
    if (!origin) {
      deps.log({ level: 'error', event: 'safety_flag_email_blocked', code: 'NO_PORTAL_ORIGIN' });
      await recordFlagEmailFailed(deps, reportId);
      throw new JobFailure('NO_PORTAL_ORIGIN');
    }
    const portalUrl = `${origin}/app/privacy`;
    let accepted = 0;
    let refused = 0;
    for (const to of addresses) {
      try {
        await deps.providers.email.send({ to, templateKey: 'safety_flag', params: { portalUrl } });
        accepted += 1;
      } catch {
        refused += 1;
      }
    }
    if (accepted === 0) {
      deps.log({
        level: 'error',
        event: 'safety_flag_email_send_failed',
        code: 'EMAIL_SEND_FAILED',
      });
      await recordFlagEmailFailed(deps, reportId);
      throw new JobFailure('EMAIL_SEND_FAILED');
    }
    await deps.db.asService(async (tx) => {
      const stamped = await tx`
        update public.safety_reports set parent_email_status = 'sent', parent_emailed_at = ${now}
         where id = ${reportId} and parent_email_status <> 'sent'
        returning id`;
      if (stamped.length === 0) return;
      // Counts and the provider only: no address, no homework (family members read this log).
      await tx`
        insert into public.audit_events (family_id, actor_kind, action, target_type, target_id, metadata)
        values (${job.family_id}, 'system', 'safety_report.guardian_emailed', 'safety_report', ${reportId},
                ${JSON.stringify({ provider: deps.providers.email.name, recipients: accepted, refused })}::text::jsonb)`;
    });
    deps.log({
      level: refused > 0 ? 'warn' : 'info',
      event: 'safety_flag_email_sent',
      code: refused > 0 ? 'PARTIAL' : 'ALL_GUARDIANS',
    });
  },
  {
    /** The worker died on the final attempt: the family's list must not keep saying "not sent". */
    onDeadLetter: async (deps: JobDeps, job: JobRow): Promise<void> => {
      const reportId = typeof job.payload.reportId === 'string' ? job.payload.reportId : null;
      if (reportId) await recordFlagEmailFailed(deps, reportId);
    },
  },
);

// ---------------------------------------------------------------------------------------------
// Private exports (spec P8, P10; AC_LEARNING_10): the builder job, registered for every tick
// ---------------------------------------------------------------------------------------------

/**
 * The in-memory storage double stores bytes directly: its signed URLs point nowhere, so uploading
 * through them would fail every export in development. Only the labeled mock has `put`; the real
 * adapter uploads through its signed URL (export-build.ts storageUploader).
 */
function isMemoryStorageMock(
  storage: JobDeps['providers']['storage'],
): storage is JobDeps['providers']['storage'] & { put(path: string, bytes: Uint8Array): void } {
  return storage.isMock && typeof (storage as { put?: unknown }).put === 'function';
}

/** `export_build`: one job per data_exports row (payload: export id, optional set id). */
export const exportBuildHandler: JobHandler = Object.assign(
  (deps: JobDeps, job: JobRow): Promise<void | JobDeferral> => {
    const storage = deps.providers.storage;
    const upload: ExportUploader = isMemoryStorageMock(storage)
      ? (path, bytes) => {
          storage.put(path, bytes);
          return Promise.resolve();
        }
      : storageUploader(storage);
    return createExportBuildHandler({ upload })(deps, job);
  },
  {
    /**
     * JOBS-R2-05: the worker died on the final attempt (or an error outside build/upload ended it),
     * so the handler never settled the row. Without this the parent's export list said "preparing"
     * for ever, and any file the lost attempt stored was never removed.
     */
    onDeadLetter: (deps: JobDeps, job: JobRow): Promise<void> =>
      settleDeadLetteredExport(deps, job),
  },
);

// ---------------------------------------------------------------------------------------------
// Account closure (Apple 5.1.1(v), Google Play account deletion; migration 0830)
// ---------------------------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How long a family owner's closure waits between checks while the family purge is pending. */
export const ACCOUNT_CLOSE_RECHECK_MS = 5 * 60_000;

/**
 * `account_close` (payload: the auth user id only; no family, so the job outlives the family
 * tombstone): closes the parent's Supabase sign-in through the auth-admin provider once nothing
 * still needs it. Queued by POST /v1/account/close for every closure; for a family owner it is the
 * only path (their sign-in closes after the family purge has completed), for a guardian or an adult
 * without a family it is the durable backstop behind the inline close.
 *
 * Idempotent: a user already closed ends the job. While the user still holds an active membership
 * of a tombstoned family (purge pending) the job pauses without spending an attempt; a membership
 * of a LIVE family (the deletion was cancelled or never asked for) fails the job, so it retries and
 * dead-letters like every other job, visible in the ledger. Nothing here is ever a mock outside
 * development and test (L-016): the refusing provider fails the job. Logs and the audit row carry
 * the user id and provider name only.
 */
export const accountCloseHandler: JobHandler = Object.assign(
  (deps: JobDeps, job: JobRow): Promise<void | JobDeferral> => runAccountClose(deps, job),
  {
    /**
     * JOBS-R1-01: an outage of the auth service (or of anything the job reads) never ends a closure
     * for good: a dead letter queues a successor. Not when the last refusal was FAMILY_ACTIVE (the
     * user holds a live family again, a rule and not an outage: a fresh request queues a new
     * closure once that family is deleted), nor for a malformed payload.
     */
    onDeadLetter: (deps: JobDeps, job: JobRow, reason: DeadLetterReason): Promise<void> => {
      const userId = typeof job.payload.userId === 'string' ? job.payload.userId : '';
      if (!UUID_RE.test(userId)) return Promise.resolve();
      return queueDeadLetterSuccessor(
        deps,
        job,
        reason,
        'ACCOUNT_CLOSE_DEAD_LETTER',
        (_tx, lastErrorCode) => Promise.resolve(lastErrorCode !== 'FAMILY_ACTIVE'),
      );
    },
  },
);

async function runAccountClose(deps: JobDeps, job: JobRow): Promise<void | JobDeferral> {
  const userId = typeof job.payload.userId === 'string' ? job.payload.userId : '';
  if (!UUID_RE.test(userId)) throw new JobFailure('INVALID_JOB', 'account_close job without user');
  const authAdmin = deps.providers.authAdmin;
  if (!authAdmin) throw new JobFailure('AUTH_ADMIN_NOT_CONFIGURED');
  if (authAdmin.isMock && !MOCK_ENVIRONMENTS.has(deps.config.environment)) {
    deps.log({ level: 'error', event: 'account_close_blocked', code: 'AUTH_ADMIN_MOCK' });
    throw new JobFailure('AUTH_ADMIN_MOCK');
  }
  const [state] = await deps.db.asService(
    (tx) => tx<{ closed: boolean; live_family: boolean; purge_pending: boolean }[]>`
      select app.auth_user_closed(${userId}::uuid) as closed,
             exists (
               select 1 from public.family_memberships m
                 join public.families f on f.id = m.family_id
                where m.user_id = ${userId}::uuid and m.status = 'active' and f.deleted_at is null
             ) as live_family,
             exists (
               -- A family-scope deletion releases memberships at request time (migration 0840,
               -- DB-R1-02): a membership the deletion itself released still holds the closure
               -- until that family's purge has completed.
               select 1 from public.family_memberships m
                 join public.families f on f.id = m.family_id
                where m.user_id = ${userId}::uuid and f.deleted_at is not null
                  and (m.status = 'active' or m.revoked_at >= f.deletion_requested_at)
                  and exists (
                    select 1 from public.deletion_requests d
                     where d.family_id = f.id and d.scope = 'family'
                       and d.status in ('requested', 'processing'))
             ) as purge_pending`,
  );
  if (state?.closed) return;
  if (state?.live_family) {
    deps.log({ level: 'error', event: 'account_close_blocked', code: 'FAMILY_ACTIVE' });
    throw new JobFailure('FAMILY_ACTIVE');
  }
  if (state?.purge_pending) {
    return {
      kind: 'defer',
      runAfter: new Date(deps.clock().getTime() + ACCOUNT_CLOSE_RECHECK_MS),
      code: 'PURGE_PENDING',
    };
  }
  let outcome: string;
  try {
    ({ outcome } = await authAdmin.closeUser(userId));
  } catch {
    throw new JobFailure('AUTH_ADMIN_CLOSE_FAILED');
  }
  await deps.db.asService(
    (tx) => tx`
      insert into public.audit_events (actor_kind, action, target_type, target_id, metadata)
      values ('system', 'account.closed', 'auth_user', ${userId},
              ${JSON.stringify({ provider: authAdmin.name, outcome })}::text::jsonb)`,
  );
  deps.log({ level: 'info', event: 'account_closed', code: outcome });
}

export const DEFAULT_HANDLERS: Readonly<Record<string, JobHandler>> = {
  deletion_purge: deletionPurgeHandler,
  safety_flag_email: safetyFlagEmailHandler,
  export_build: exportBuildHandler,
  account_close: accountCloseHandler,
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
  identityHousekeeping: {
    rateLimitBuckets: number;
    endedAuthSessions: number;
    endedSessionRows: number;
    /** Consumed or expired pairing codes and lapsed spend holds pruned this tick (DB-R2-08). */
    endedCredentialRows: number;
  };
  /** Daily, Thursday and top-up jobs queued this tick (0 when learning handlers are not registered). */
  learningJobsEnqueued: number;
  /** Terminal job rows older than JOB_RETENTION_DAYS deleted this tick (BUG-139, migration 0840). */
  prunedJobs: number;
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
  /**
   * When this invocation started (JOBS-R2-07). The claim budget and the remaining wall time are
   * measured from it, so steps that ran before the ledger count against it. Defaults to now, which
   * is right for a caller that runs the ledger on its own.
   */
  tickStartedAt?: Date,
): Promise<TickReport['jobs']> {
  const started = deps.clock();
  const tickStart = tickStartedAt ?? started;
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
    const elapsed = deps.clock().getTime() - tickStart.getTime();
    if (elapsed > TICK_CLAIM_BUDGET_MS) break;
    // Only kinds whose worst case still fits the rest of the invocation (JOBS-R2-07).
    const remaining = TICK_WALL_LIMIT_MS - elapsed;
    const claimable = kinds.filter(
      (kind) => (JOB_WORST_CASE_MS[kind] ?? DEFAULT_JOB_WORST_CASE_MS) <= remaining,
    );
    if (claimable.length === 0) break;
    let job: JobRow | null;
    try {
      job = await claimNext(deps, claimable);
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
               last_error_code = ${ledgerErrorCode(error)}
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

/** A row past its period end is re-verified at most this often until the provider moves it. */
export const STALE_ENTITLEMENT_RECHECK_MS = 3600_000;

/**
 * Entitlement safety net (spec P11): webhooks can be lost, so entitlements that are stale (not
 * fetched for a day) or past their period end are re-fetched from the provider and reconciled.
 * BILL-R1-3: rows in a terminal state (expired, revoked, refunded) never grant again and are
 * skipped; a row past its period end is re-checked hourly, not on every tick; families are taken
 * oldest verification first, so a fixed batch limit rotates through every stale family instead of
 * re-fetching the same first `limit` ids forever.
 */
export async function reconcileStaleEntitlements(deps: JobDeps, limit = 25): Promise<number> {
  const now = deps.clock();
  const staleBefore = new Date(now.getTime() - 86_400_000);
  const recheckBefore = new Date(now.getTime() - STALE_ENTITLEMENT_RECHECK_MS);
  const terminal = [...TERMINAL_STATUSES];
  const families = await deps.db.asService(
    (tx) => tx<{ id: string; billing_ref: string }[]>`
      select f.id, f.billing_ref
        from public.families f
        join public.family_entitlements e on e.family_id = f.id
       where f.deleted_at is null
         and not (e.status = any(${terminal}))
         and (e.fetched_at < ${staleBefore}
              or (e.period_end < ${now} and e.fetched_at < ${recheckBefore}))
       group by f.id, f.billing_ref
       order by min(e.fetched_at), f.id
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
  if (deps.providers.email.isMock && !MOCK_ENVIRONMENTS.has(deps.config.environment)) {
    // A notice that goes to an in-memory outbox is not a notice: never delete on the strength of
    // it, in staging as in production (only development and test may use the labeled outbox).
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
        const [row] = await deps.db.asService(async (tx) => {
          // The purge job the function enqueues is due at the tick's clock (migration 0780).
          await stateRequestInstant(tx, now);
          return tx<{ id: string | null }[]>`
            select app.inactivity_delete_family(${family.id}, ${now}, ${idleBefore}, ${noticeBefore}) as id`;
        });
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
    { rateLimitBuckets: 0, endedAuthSessions: 0, endedSessionRows: 0, endedCredentialRows: 0 },
    () => runIdentityHousekeeping(deps.db, now),
  );
  // Learning jobs are queued only where a worker will run them, and before the job ledger so a due
  // set is built in the same tick.
  // Job ledger retention (BUG-139): terminal rows older than the horizon go; the deletion_purge and
  // account_close kinds stay as the audit trail of a deletion. The horizon must exceed the raw scan
  // retention (30 days). Every next-scan-version key (homework.ts scan and correction routes,
  // privacy.ts queueClearanceRecheck) is the HIGHEST kept version + 1, never a count (L-033,
  // CS-R2-01), so pruning an earlier row cannot re-derive a key a kept later row still holds.
  const prunedJobs = await step(
    'job_retention',
    0,
    async () =>
      (
        await deps.db.asService(
          (tx) => tx<{ n: number }[]>`
            select app.prune_terminal_jobs(make_interval(days => ${JOB_RETENTION_DAYS})) as n`,
        )
      )[0]?.n ?? 0,
  );
  const learningJobsEnqueued = await step('learning_enqueue', 0, async () => {
    if (!handlers.daily_set_generate) return 0;
    const r = await enqueueDueLearningJobs(deps, now);
    return r.dailyJobs + r.reviewJobs + r.topUpJobs;
  });
  // The claim budget is measured from the tick's own start, not from when the ledger begins
  // (JOBS-R2-07): the steps above are unbounded in time.
  const jobs = await step('jobs', { succeeded: 0, retried: 0, deadLettered: 0 }, () =>
    runJobs(deps, handlers, 25, now),
  );
  // The provider sweep runs AFTER the ledger (JOBS-R2-04, second round). Each request is bounded at
  // BILLING_REQUEST_TIMEOUT_MS, but the sweep makes up to 25 of them one after another, and the work
  // a family is actually waiting on — a scan, a safety email, an export — is in the ledger. A store
  // that answers slowly now delays only itself; entitlement staleness is measured in days, so a sweep
  // that misses the end of a tick loses nothing.
  const entitlementsReconciled = await step('entitlements', 0, () =>
    reconcileStaleEntitlements(deps),
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
    prunedJobs,
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
