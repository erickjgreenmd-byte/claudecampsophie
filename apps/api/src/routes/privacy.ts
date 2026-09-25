import { Hono, type Context } from 'hono';
import {
  ADMIN_SAFETY_REPORTS_PAGE_SIZE,
  createAnswerKeyExportRequestSchema,
  createDeletionRequestSchema,
  createExportRequestSchema,
  createSafetyReportRequestSchema,
  childReportRequestSchema,
  parentSafetyReportActionRequestSchema,
  PRIVACY_RULES,
  safetyReportStatusSchema,
  updateSafetyReportRequestSchema,
  uuidSchema,
  type AdminSafetyReport,
  type AssignmentStatus,
  type DataExport,
  type DeletionRequest,
  type ExportKind,
  type ParentReportOutcome,
  type SafetyClearanceRecheck,
  type SafetyFlagEmailStatus,
  type SafetyReport,
  type SafetyReportResolution,
  type SafetyReportStatus,
} from '@pencillift/contracts';
import { readJson } from '../app.ts';
import { stateRequestInstant, type Tx } from '../db.ts';
import { ApiError, businessRule, pgErrorCode } from '../errors.ts';
import {
  assertOwnerAdmin,
  assertRecentUnlock,
  currentFamilyId,
  requireChild,
  requireParent,
} from '../middleware/auth.ts';
import type { AppEnv } from '../middleware/context.ts';
import { enforceRateLimit, type RateRule } from '../middleware/rate-limit.ts';

/**
 * Privacy vertical (spec P4, P8, P10, P14, E4 Deletion; AC_ACCESS_10, AC_SECURITY_01,
 * AC_SECURITY_05, AC_LEARNING_10 request side). Paths under /v1:
 *   /deletion, /exports, /exports/answer-key, /safety-reports, /safety-reports/:id,
 *   /child/reports, /admin/safety-reports, /admin/safety-reports/:id
 *
 * Access model (spec E4 tenant isolation):
 * - Reads a family member may make run as the caller (`asParent`), so RLS is a second layer.
 * - The deletion and export RPCs (migrations 0600/0620) run as the caller: they re-check membership
 *   and the recent adult unlock inside the database.
 * - `asService` (bypasses RLS) is used only where the caller's role has no grant: job enqueueing,
 *   parent report inserts that must carry the derived child id, withdrawing exports on deletion,
 *   the caller's deletion history after the family is tombstoned (their own requests and those of a
 *   tombstoned family they still belong to), and admin report updates. Every such statement is
 *   explicitly scoped to ids the handler verified first.
 *
 * Middleware is attached per route (not with `use`), because this router is mounted at /v1 next to
 * other verticals and a wildcard here would run on their paths too.
 */

/** Local rate rules for this vertical (reviewed here; shared rules live in rate-limit.ts). */
const RULES = {
  exportPerFamily: { limit: 20, windowSeconds: 24 * 3600 },
  parentReportPerUser: { limit: 30, windowSeconds: 3600 },
  childReportPerChild: { limit: 20, windowSeconds: 3600 },
} as const satisfies Record<string, RateRule>;

/** Calm acknowledgement for a child's report. It never claims a parent was alerted (spec P4). */
export const CHILD_REPORT_THANKS =
  'Thank you for telling us. We saved your report so it can be checked. You can also tell a grown-up you trust.';

/**
 * Decision: the admin workflow is forward-only. open → triaged | escalated | resolved;
 * triaged → escalated | resolved; escalated → resolved; resolved is final (a new concern is a new
 * report). Serious safety concerns (`upsetting`, `unsafe_content`) follow the escalation steps in
 * docs/Deployment_Runbook.md, section "Safety reports: moderation and escalation". System reports
 * (`reporter_kind = 'system'`, category `severe_risk`, filed by the scan job's safety screen) start
 * `escalated`; migration 0760 keeps them `escalated` or `resolved`. A system report may be cleared
 * as a false match in the request that resolves it (`resolution: 'false_match'`; round 3,
 * CHK2-CS-5): the flagged question is then re-checked like a corrected answer.
 *
 * Owner decision (2026-09-25; the lead's dissent is recorded in docs/Threat_Model.md): the parent
 * is the only person PencilLift sends a safety message to, and the parent addresses the concern.
 * No report is held from the family (the 0760 hold and the admin release `familyVisible: true`
 * stay in the schema and here, unused: the scan job files every report visible), every flag is
 * emailed to the active guardians (jobs/dispatcher.ts safetyFlagEmailHandler; the list shows the
 * recorded delivery), and a guardian resolves a flag or a child's report from the portal or the app
 * (PATCH /safety-reports/:id: `addressed` keeps the child's notice, `false_match` clears the flag
 * exactly as the reviewer's clearing does). The owner admin queue stays as a support tool; a report
 * a guardian resolved is final for it too.
 */
const REPORT_TRANSITIONS: Readonly<Record<SafetyReportStatus, readonly SafetyReportStatus[]>> = {
  open: ['triaged', 'escalated', 'resolved'],
  triaged: ['escalated', 'resolved'],
  escalated: ['resolved'],
  resolved: [],
};

/**
 * Scan statuses in which a false-match clearance is refused: the scan job may already have passed
 * its pre-grading screen, so the cleared question could stay ungraded. The reviewer clears it once
 * the scan settles (runbook 5.1).
 */
const SCAN_STILL_CHECKING: readonly AssignmentStatus[] = [
  'draft',
  'uploading',
  'queued',
  'extracting',
  'checking',
  'verifying',
];
/**
 * Statuses from which a cleared question is re-checked at once: the same states a parent's
 * transcription correction may re-check from (they alone may move back to `checking`, 0100).
 */
const RECHECK_NOW: readonly AssignmentStatus[] = ['ready', 'needs_parent_review'];

// ---------------------------------------------------------------------------------------------
// Row types and DTO mapping (explicit columns only; storage paths are never selected)
// ---------------------------------------------------------------------------------------------

interface DeletionRow {
  id: string;
  scope: 'family' | 'child';
  target_child_id: string | null;
  status: DeletionRequest['status'];
  requested_at: Date;
  complete_by: Date;
  completed_at: Date | null;
}

interface ExportRow {
  id: string;
  kind: ExportKind;
  child_id: string | null;
  status: DataExport['status'];
  created_at: Date;
  expires_at: Date | null;
}

interface ReportRow {
  id: string;
  reporter_kind: SafetyReport['reporterKind'];
  category: SafetyReport['category'];
  child_id: string | null;
  question_id: string | null;
  note: string | null;
  status: SafetyReportStatus;
  created_at: Date;
  triaged_at: Date | null;
  resolved_at: Date | null;
  resolution: SafetyReportResolution | null;
  parent_action_at: Date | null;
  parent_emailed_at: Date | null;
  parent_email_status: SafetyFlagEmailStatus;
}

/** The family view's columns (granted to `authenticated`: never the screen codes or the note). */
const REPORT_COLUMNS = `id, reporter_kind, category, child_id, question_id, note, status, created_at, triaged_at,
    resolved_at, resolution, parent_action_at, parent_emailed_at, parent_email_status`;

interface AdminReportRow {
  id: string;
  family_id: string;
  child_id: string | null;
  reporter_kind: SafetyReport['reporterKind'];
  category: SafetyReport['category'];
  question_id: string | null;
  feedback_id: string | null;
  has_note: boolean;
  screen_categories: AdminSafetyReport['screenCategories'];
  family_visible: boolean;
  transcription_corrected: boolean;
  status: SafetyReportStatus;
  created_at: Date;
  triaged_at: Date | null;
  resolved_at: Date | null;
  resolution_note: string | null;
  resolution: SafetyReportResolution | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toDeletion(row: DeletionRow): DeletionRequest {
  return {
    id: row.id,
    scope: row.scope,
    childId: row.target_child_id,
    status: row.status,
    requestedAt: row.requested_at.toISOString(),
    completeBy: row.complete_by.toISOString(),
    completedAt: iso(row.completed_at),
  };
}

/**
 * The status a parent sees at `now`. A finished export past `expires_at` is reported as expired,
 * matching the download route, which refuses it from that instant (spec P14 honest states,
 * RV-privacy-8); the stored row is only rewritten by a deletion or a cleanup job.
 */
function exportStatusAt(
  row: Pick<ExportRow, 'status' | 'expires_at'>,
  now: Date,
): DataExport['status'] {
  if (row.status === 'ready' && row.expires_at !== null && row.expires_at <= now) return 'expired';
  return row.status;
}

function toExport(row: ExportRow, now: Date): DataExport {
  return {
    id: row.id,
    kind: row.kind,
    childId: row.child_id,
    status: exportStatusAt(row, now),
    createdAt: row.created_at.toISOString(),
    expiresAt: iso(row.expires_at),
  };
}

function toReport(row: ReportRow): SafetyReport {
  return {
    id: row.id,
    reporterKind: row.reporter_kind,
    category: row.category,
    childId: row.child_id,
    questionId: row.question_id,
    note: row.note,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    triagedAt: iso(row.triaged_at),
    resolvedAt: iso(row.resolved_at),
    clearedAsFalseMatch: row.reporter_kind === 'system' && row.resolution === 'false_match',
    parentActionAt: iso(row.parent_action_at),
    // The stamp says a guardian acted; the resolution is then theirs (0790 parent_action_shape).
    parentOutcome: row.parent_action_at !== null ? row.resolution : null,
    emailedAt: iso(row.parent_emailed_at),
    emailStatus: row.parent_email_status,
  };
}

function toAdminReport(row: AdminReportRow): AdminSafetyReport {
  return {
    id: row.id,
    familyId: row.family_id,
    childId: row.child_id,
    reporterKind: row.reporter_kind,
    category: row.category,
    questionId: row.question_id,
    feedbackId: row.feedback_id,
    hasNote: row.has_note,
    screenCategories: row.screen_categories,
    familyVisible: row.family_visible,
    transcriptionCorrected: row.transcription_corrected,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    triagedAt: iso(row.triaged_at),
    resolvedAt: iso(row.resolved_at),
    resolutionNote: row.resolution_note,
    resolution: row.resolution,
  };
}

// ---------------------------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------------------------

interface Membership {
  familyId: string;
  role: 'owner' | 'guardian';
}

/** The caller's active membership in a live family (RLS hides tombstoned families). */
async function callerMembership(c: Context<AppEnv>): Promise<Membership | null> {
  const { deps, parent } = c.var;
  const [row] = await deps.db.asParent(
    parent,
    (tx) => tx<{ family_id: string; role: 'owner' | 'guardian' }[]>`
      select family_id, role from public.family_memberships
       where user_id = ${parent.userId} and status = 'active'`,
  );
  return row ? { familyId: row.family_id, role: row.role } : null;
}

/** 404 unless the child belongs to the caller's family (checked as the caller, under RLS). */
async function assertFamilyChild(
  c: Context<AppEnv>,
  familyId: string,
  childId: string,
): Promise<void> {
  const { deps, parent } = c.var;
  const rows = await deps.db.asParent(
    parent,
    (tx) => tx<{ id: string }[]>`
      select id from public.child_profiles where id = ${childId} and family_id = ${familyId}`,
  );
  if (rows.length === 0) throw new ApiError('NOT_FOUND', 'Child not found');
}

/**
 * Decision (spec P4 "Deletion requests should stop processing immediately" and "Purge active
 * uploads, derivatives ..."; E4 "purge owned derivatives"; RV-privacy-3, RV-privacy-4): a deletion
 * withdraws every finished export file that holds the deleted data as soon as it is requested —
 * all of the family's exports for a family deletion; for a child deletion, that child's exports and
 * every family-wide export (child_id null: family data and progress files list every child). The
 * rows become 'expired' (the download route refuses them; parents see "request a new copy") and the
 * files are removed from private storage. A family-wide export that is still queued is left alone:
 * the builder leaves out every child with an open deletion request.
 *
 * Service role (the caller has no update grant on exports); scoped to the family and child the
 * handler verified. Runs after the deletion is recorded, so a storage failure never loses the
 * request: the row keeps its storage_path (still refused for download) for a later cleanup, and the
 * failure is logged without payload.
 */
async function withdrawExports(
  c: Context<AppEnv>,
  familyId: string,
  childId: string | null,
): Promise<void> {
  const { deps } = c.var;
  const now = deps.clock();
  const withdrawn = await deps.db.asService(
    (tx) => tx<{ id: string; storage_path: string | null }[]>`
      update public.data_exports
         set status = 'expired',
             expires_at = case when status = 'ready' then least(coalesce(expires_at, ${now}), ${now})
                           else expires_at end
       where family_id = ${familyId}
         and (status = 'ready' or (status = 'expired' and storage_path is not null))
         and (${childId}::uuid is null or child_id = ${childId}::uuid or child_id is null)
      returning id, storage_path`,
  );
  const files = withdrawn.filter(
    (row): row is { id: string; storage_path: string } => row.storage_path !== null,
  );
  if (files.length === 0) return;
  try {
    await deps.providers.storage.remove(files.map((row) => row.storage_path));
  } catch {
    deps.log({
      level: 'error',
      event: 'export_withdraw_failed',
      code: 'STORAGE_REMOVE_FAILED',
      requestId: c.var.requestId,
    });
    return;
  }
  await deps.db.asService(
    (tx) => tx`
      update public.data_exports set storage_path = null
       where family_id = ${familyId} and status = 'expired'
         and id = any(${files.map((row) => row.id)}::uuid[])`,
  );
}

const DELETION_COLUMNS =
  'id, scope, target_child_id, status, requested_at, complete_by, completed_at';

// ---------------------------------------------------------------------------------------------
// False-match clearing, shared by the reviewer's path (PATCH /admin/safety-reports/:id) and the
// guardian's ("This was a false alarm", PATCH /safety-reports/:id). Both run inside the service
// transaction that resolves the report with `resolution = 'false_match'`: the child's notice is
// then hidden (the child API reads the clearance for that transcription) and the flagged question
// is graded normally by a recheck.
// ---------------------------------------------------------------------------------------------

interface FlaggedScan {
  id: string;
  status: AssignmentStatus;
  child_id: string;
}

interface ClearableReport {
  question_id: string;
  family_id: string;
}

/**
 * Locks the flagged question's scan and refuses a clearance while it is mid-run: the run may
 * already have passed its pre-grading screen and would leave the cleared question unchecked.
 */
async function lockFlaggedScan(tx: Tx, report: ClearableReport): Promise<FlaggedScan | undefined> {
  const [scan] = await tx<FlaggedScan[]>`
    select a.id, a.status, a.child_id from public.assignments a
      join public.extracted_questions q on q.assignment_id = a.id and q.family_id = a.family_id
     where q.id = ${report.question_id} and a.family_id = ${report.family_id}
       for update of a`;
  if (scan && SCAN_STILL_CHECKING.includes(scan.status)) {
    throw businessRule(
      PRIVACY_RULES.scanStillChecking,
      'This scan is still being checked. Clear the flag once it is ready.',
    );
  }
  return scan;
}

/**
 * Re-checks the cleared question: the same re-check a parent's transcription correction queues
 * (homework.ts). The scan job grades it normally because its pre-grading screen honours the
 * clearance for this transcription (scan-process.ts screenBeforeGrading). Call after the report
 * row carries the clearance, in the same transaction.
 */
async function queueClearanceRecheck(
  tx: Tx,
  now: Date,
  report: ClearableReport,
  scan: FlaggedScan | undefined,
): Promise<SafetyClearanceRecheck> {
  const [family] = await tx<{ active: boolean }[]>`
    select app.family_is_active(${report.family_id}) as active`;
  if (!scan || !family?.active) return 'none';
  if (RECHECK_NOW.includes(scan.status)) {
    await tx`
      update public.assignments set status = 'checking'
       where id = ${scan.id} and family_id = ${report.family_id}`;
    const [jobs] = await tx<{ n: number }[]>`
      select count(*)::int as n from public.jobs
       where family_id = ${report.family_id} and idempotency_key like ${`scan:${scan.id}:v%`}`;
    await tx`
      insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, run_after)
      values ('scan_process', ${`scan:${scan.id}:v${(jobs?.n ?? 0) + 1}`}, ${report.family_id},
              ${scan.child_id},
              ${tx.json({ assignmentId: scan.id, mode: 'recheck', questionIds: [report.question_id] })},
              ${now})`;
    return 'queued';
  }
  // The scan's own retry grades every stored question again and honours the clearance.
  if (scan.status === 'failed_retryable') return 'on_retry';
  // The scan cannot be graded (failed for good, cancelled, sent back for a retake).
  return 'none';
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

/** Largest epoch-microsecond value Postgres can hold in a bigint. */
const INT64_MAX = 9223372036854775807n;
/** No stored row is timestamped this far past the request clock; anything beyond is a bad cursor. */
const CURSOR_AHEAD_MICROS = 10n * 366n * 24n * 3600n * 1_000_000n;

/**
 * Parses the epoch-microseconds half of a keyset cursor with BigInt (API-AUTH-R1-03): a 19-digit
 * value past int64, or one far in the future, would fail the bigint cast or overflow the interval
 * in SQL and surface as a 500; here it is a 400 like any other malformed cursor.
 */
function cursorMicros(digits: string, now: Date): string {
  const micros = BigInt(digits);
  if (micros > INT64_MAX || micros > BigInt(now.getTime()) * 1000n + CURSOR_AHEAD_MICROS) {
    throw new ApiError('VALIDATION_FAILED', 'Invalid request: after');
  }
  return micros.toString();
}

export function privacyRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // ----- Deletion ------------------------------------------------------------------------------

  r.post('/deletion', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const body = await readJson(c, createDeletionRequestSchema);
    const membership = await callerMembership(c);
    if (!membership) throw new ApiError('NOT_FOUND', 'Create your family first');
    // Decision: deleting the whole family also removes the owner's account data and every guardian's
    // access, so only the owner may request it. Any guardian may delete a child's data (spec P4).
    if (body.scope === 'family' && membership.role !== 'owner') {
      throw new ApiError('FORBIDDEN', 'Only the family owner can delete the whole family', {
        rule: PRIVACY_RULES.ownerOnlyFamilyDeletion,
      });
    }
    await assertRecentUnlock(c);
    const childId = body.scope === 'child' ? (body.childId ?? null) : null;
    if (childId) await assertFamilyChild(c, membership.familyId, childId);

    let row: DeletionRow;
    try {
      // The RPC re-checks membership and the step-up, tombstones, revokes child sessions/devices,
      // cancels queued work and (migration 0620) enqueues the purge in the same transaction.
      const rows = await deps.db.asParent(parent, async (tx) => {
        // The purge job the RPC enqueues is due at the application's clock (migration 0780).
        await stateRequestInstant(tx, deps.clock());
        return tx.unsafe<DeletionRow[]>(
          `select ${DELETION_COLUMNS} from public.request_deletion($1::uuid, $2::uuid)`,
          [membership.familyId, childId],
        );
      });
      row = rows[0]!;
    } catch (error) {
      const code = pgErrorCode(error);
      if (code === '23505') {
        throw new ApiError('CONFLICT', 'A deletion request for this is already in progress');
      }
      if (code === 'P0002') throw new ApiError('NOT_FOUND', 'Not found');
      if (code === '42501') {
        // The database also refuses a whole-family deletion by a non-owner (proposed forward
        // migration for RV-privacy-1, same SQLSTATE); if ownership changed since the check above,
        // say so instead of asking for the PIN again.
        if (body.scope === 'family' && (await callerMembership(c))?.role !== 'owner') {
          throw new ApiError('FORBIDDEN', 'Only the family owner can delete the whole family', {
            rule: PRIVACY_RULES.ownerOnlyFamilyDeletion,
          });
        }
        throw new ApiError('STEP_UP_REQUIRED', 'Enter your parent PIN to continue');
      }
      throw error;
    }

    // Decision: re-assert the durable purge job with the same per-request idempotency key. With
    // migration 0620 the RPC already inserted it (this is a no-op); the check guarantees a deletion
    // request is never acknowledged without its purge job.
    await deps.db.asService(async (tx) => {
      await tx`
        insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, run_after)
        values ('deletion_purge', ${'deletion:' + row.id}, ${membership.familyId}, ${childId}::uuid,
                ${JSON.stringify({ deletionRequestId: row.id })}::text::jsonb, ${deps.clock()})
        on conflict (idempotency_key) do nothing`;
      const jobs = await tx<{ id: string }[]>`
        select id from public.jobs
         where idempotency_key = ${'deletion:' + row.id} and kind = 'deletion_purge'
           and family_id = ${membership.familyId}`;
      if (jobs.length !== 1) throw new Error('deletion purge job missing');
    });
    await withdrawExports(c, membership.familyId, childId);
    deps.log({ level: 'info', event: 'deletion_requested', requestId: c.var.requestId });
    return c.json({ deletion: toDeletion(row) }, 202);
  });

  r.get('/deletion', requireParent, async (c) => {
    const { deps, parent } = c.var;
    // Read with the service role because a deleted family is tombstoned and invisible to RLS.
    // Explicitly scoped to the verified caller: requests they made, plus the requests of a
    // tombstoned family they are still an active member of — so the other guardian sees the
    // deleted-account state instead of "set up your family" until the purge revokes their
    // membership (spec P14 deleted-account state, RV-privacy-5).
    const own = await deps.db.asService((tx) =>
      tx.unsafe<DeletionRow[]>(
        `select ${DELETION_COLUMNS} from public.deletion_requests d
          where d.requested_by = $1::uuid
             or exists (
                  select 1 from public.family_memberships m
                    join public.families f on f.id = m.family_id
                   where m.family_id = d.family_id and m.user_id = $1::uuid
                     and m.status = 'active' and f.deleted_at is not null)
          order by d.requested_at desc limit 50`,
        [parent.userId],
      ),
    );
    // Plus requests by the other guardian of a live family, through RLS as the caller.
    const membership = await callerMembership(c);
    const family = membership
      ? await deps.db.asParent(parent, (tx) =>
          tx.unsafe<DeletionRow[]>(
            `select ${DELETION_COLUMNS} from public.deletion_requests
              where family_id = $1::uuid order by requested_at desc limit 50`,
            [membership.familyId],
          ),
        )
      : [];
    const byId = new Map<string, DeletionRow>();
    for (const row of [...own, ...family]) byId.set(row.id, row);
    const requests = [...byId.values()]
      .sort((a, b) => b.requested_at.getTime() - a.requested_at.getTime())
      .map(toDeletion);
    return c.json({ requests });
  });

  // ----- Exports -------------------------------------------------------------------------------

  async function requestExport(c: Context<AppEnv>, kind: ExportKind, childId: string | null) {
    const { deps, parent } = c.var;
    const familyId = await currentFamilyId(c);
    await assertRecentUnlock(c);
    await enforceRateLimit(
      deps.rateLimiter,
      `export:${familyId}`,
      RULES.exportPerFamily,
      deps.clock(),
    );
    // A family-wide export (no childId) is accepted while a child's deletion is pending: the builder
    // leaves out every child with an open deletion request (RV-privacy-2).
    if (childId) {
      await assertFamilyChild(c, familyId, childId);
      // Decision: a deletion request stops processing immediately (spec P4), so no new export of
      // that child's data is built while the deletion is pending.
      const pending = await deps.db.asParent(
        parent,
        (tx) => tx<{ id: string }[]>`
          select id from public.deletion_requests
           where family_id = ${familyId} and target_child_id = ${childId}
             and status in ('requested', 'processing')`,
      );
      if (pending.length > 0) {
        throw businessRule(
          PRIVACY_RULES.childDeletionPending,
          'This child’s data is being deleted, so it can’t be exported',
        );
      }
    }

    let exportId: string;
    try {
      // request_export re-checks membership and the recent step-up inside the database.
      const [created] = await deps.db.asParent(
        parent,
        (tx) => tx<{ id: string }[]>`
          select public.request_export(${familyId}, ${kind}, ${childId}::uuid) as id`,
      );
      exportId = created!.id;
    } catch (error) {
      const code = pgErrorCode(error);
      if (code === '42501') {
        throw new ApiError('STEP_UP_REQUIRED', 'Enter your parent PIN to continue');
      }
      if (code === 'P0002' || code === '23503') throw new ApiError('NOT_FOUND', 'Not found');
      throw error;
    }

    try {
      await deps.db.asService(
        (tx) => tx`
          insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, run_after)
          values ('export_build', ${'export:' + exportId}, ${familyId}, ${childId}::uuid,
                  ${JSON.stringify({ exportId })}::text::jsonb, ${deps.clock()})
          on conflict (idempotency_key) do nothing`,
      );
    } catch (error) {
      // Never leave a "queued" export that no job will ever build: mark it failed, then report.
      await deps.db.asService(
        (tx) => tx`
          update public.data_exports set status = 'failed'
           where id = ${exportId} and family_id = ${familyId}`,
      );
      throw error;
    }

    const [row] = await deps.db.asParent(
      parent,
      (tx) => tx<ExportRow[]>`
        select id, kind, child_id, status, created_at, expires_at from public.data_exports
         where id = ${exportId} and family_id = ${familyId}`,
    );
    deps.log({ level: 'info', event: 'export_requested', requestId: c.var.requestId });
    return c.json({ export: toExport(row!, deps.clock()) }, 202);
  }

  r.post('/exports', requireParent, async (c) => {
    const body = await readJson(c, createExportRequestSchema);
    return requestExport(c, body.kind, body.childId ?? null);
  });

  // Spec P8: the answer key has its own protected route; no parameter on the questions-only export
  // can switch a key on.
  r.post('/exports/answer-key', requireParent, async (c) => {
    const body = await readJson(c, createAnswerKeyExportRequestSchema);
    return requestExport(c, 'review_answer_key_pdf', body.childId);
  });

  r.get('/exports', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const familyId = await currentFamilyId(c);
    const rows = await deps.db.asParent(
      parent,
      (tx) => tx<ExportRow[]>`
        select id, kind, child_id, status, created_at, expires_at from public.data_exports
         where family_id = ${familyId} order by created_at desc limit 100`,
    );
    const now = deps.clock();
    return c.json({ exports: rows.map((row) => toExport(row, now)) });
  });

  // ----- Safety reports (family) -----------------------------------------------------------------

  r.post('/safety-reports', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const body = await readJson(c, createSafetyReportRequestSchema);
    const familyId = await currentFamilyId(c);
    await enforceRateLimit(
      deps.rateLimiter,
      `safety-report:${parent.userId}`,
      RULES.parentReportPerUser,
      deps.clock(),
    );
    const questionId = body.questionId ?? null;
    let childId: string | null = null;
    if (questionId) {
      const [question] = await deps.db.asParent(
        parent,
        (tx) => tx<{ child_id: string }[]>`
          select child_id from public.extracted_questions
           where id = ${questionId} and family_id = ${familyId}`,
      );
      if (!question) throw new ApiError('NOT_FOUND', 'Question not found');
      childId = question.child_id;
    }
    // Decision: inserted with the service role because `authenticated` has no grant on child_id,
    // and a question-linked report must carry its child so a child purge deletes it (otherwise the
    // report's question reference would block that purge). Family, question and child were all
    // verified above as the caller; the insert refuses a family tombstoned in the meantime.
    const [row] = await deps.db.asService(async (tx) => {
      const rows = await tx<ReportRow[]>`
        insert into public.safety_reports (family_id, child_id, reporter_kind, category, question_id, note)
        select ${familyId}, ${childId}::uuid, 'parent', ${body.category}, ${questionId}::uuid, ${body.note ?? null}
         where app.family_is_active(${familyId})
        returning ${tx.unsafe(REPORT_COLUMNS)}`;
      const created = rows[0];
      if (created) {
        await tx`
          insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
          values (${familyId}, ${parent.userId}, 'parent', 'safety_report.created', 'safety_report', ${created.id},
                  ${JSON.stringify({ category: body.category })}::text::jsonb)`;
      }
      return rows;
    });
    if (!row) throw new ApiError('NOT_FOUND', 'Create your family first');
    deps.log({ level: 'info', event: 'safety_report_created', requestId: c.var.requestId });
    return c.json({ report: toReport(row) }, 201);
  });

  // The family list includes system reports (the safety screen flagged a child's answer). Their
  // screen category codes are not selected (and not granted to `authenticated`, migration 0760):
  // the family sees that an answer was flagged for a grown-up, never which kind of concern the word
  // match suggested. The guardian email's recorded delivery (migration 0790) is returned as stored,
  // so the list never claims an email that was not sent. RLS still filters a held report and
  // `family_visible` itself is not granted, so this query cannot and does not name it (the API files
  // none since the owner decision). A flag cleared as a false match is marked so (round 3): its
  // summary would no longer be true; a guardian's own action is returned as `parentOutcome`.
  r.get('/safety-reports', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const familyId = await currentFamilyId(c);
    const rows = await deps.db.asParent(
      parent,
      (tx) => tx<ReportRow[]>`
        select ${tx.unsafe(REPORT_COLUMNS)}
          from public.safety_reports
         where family_id = ${familyId} order by created_at desc limit 100`,
    );
    return c.json({ reports: rows.map(toReport) });
  });

  // A guardian acts on the family's own report (owner decision, 2026-09-25): "I've looked into
  // this" (`addressed`: resolved, the child's notice stays, no AI on that question) or "This was a
  // false alarm" (`false_match`: the reviewer's clearing, system reports only). A recent PIN unlock
  // is required (spec P3) and a resolved report is final for everyone (409). The update runs as the
  // service role on exactly the report the handler verified as the caller's family's; `authenticated`
  // has no update grant (migration 0790).
  r.patch('/safety-reports/:id', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const id = uuidSchema.safeParse(c.req.param('id'));
    if (!id.success) throw new ApiError('NOT_FOUND', 'Report not found');
    const body = await readJson(c, parentSafetyReportActionRequestSchema);
    const familyId = await currentFamilyId(c);
    await assertRecentUnlock(c);
    const now = deps.clock();
    const outcome: ParentReportOutcome = body.outcome;
    const result = await deps.db.asService(async (tx) => {
      // Scoped to the caller's family, and to what the family can see (a held report is not the
      // family's to act on; none is filed since the owner decision).
      const [current] = await tx<
        {
          status: SafetyReportStatus;
          reporter_kind: SafetyReport['reporterKind'];
          question_id: string | null;
        }[]
      >`select status, reporter_kind, question_id from public.safety_reports
         where id = ${id.data} and family_id = ${familyId} and family_visible
           for update`;
      if (!current) throw new ApiError('NOT_FOUND', 'Report not found');
      if (current.status === 'resolved') {
        throw new ApiError('CONFLICT', 'This report is already resolved', {
          rule: PRIVACY_RULES.reportAlreadyResolved,
        });
      }
      if (current.reporter_kind === 'parent') {
        throw businessRule(
          PRIVACY_RULES.parentActionNotForReport,
          'A report you sent is reviewed by PencilLift; this action is for flags and your child’s reports',
        );
      }
      if (
        outcome === 'false_match' &&
        (current.reporter_kind !== 'system' || !current.question_id)
      ) {
        throw businessRule(
          PRIVACY_RULES.falseMatchSystemOnly,
          'Only a flag from PencilLift’s safety screen can be cleared as a false alarm',
        );
      }
      const clearable: ClearableReport | null =
        outcome === 'false_match' && current.question_id
          ? { question_id: current.question_id, family_id: familyId }
          : null;
      const scan = clearable ? await lockFlaggedScan(tx, clearable) : undefined;
      const [updated] = await tx<ReportRow[]>`
        update public.safety_reports
           set status = 'resolved',
               triaged_at = coalesce(triaged_at, ${now}),
               resolved_at = ${now},
               resolution = ${outcome},
               parent_action_at = ${now},
               parent_action_by = ${parent.userId}
         where id = ${id.data} and family_id = ${familyId}
         returning ${tx.unsafe(REPORT_COLUMNS)}`;
      const recheck = clearable ? await queueClearanceRecheck(tx, now, clearable, scan) : undefined;
      // Ids and codes only: never the note or homework text.
      await tx`
        insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
        values (${familyId}, ${parent.userId}, 'parent', 'safety_report.parent_action', 'safety_report', ${id.data},
                ${JSON.stringify({
                  from: current.status,
                  to: 'resolved',
                  outcome,
                  ...(recheck !== undefined ? { recheck } : {}),
                })}::text::jsonb)`;
      return { report: updated!, recheck };
    });
    deps.log({
      level: 'info',
      event: 'safety_report_parent_action',
      code: `${outcome.toUpperCase()}${result.recheck !== undefined ? `_RECHECK_${result.recheck.toUpperCase()}` : ''}`,
      requestId: c.var.requestId,
    });
    return c.json({ report: toReport(result.report) });
  });

  // ----- Child help/report button ---------------------------------------------------------------

  r.post('/child/reports', requireChild, async (c) => {
    const { deps, child } = c.var;
    const body = await readJson(c, childReportRequestSchema);
    await enforceRateLimit(
      deps.rateLimiter,
      `child-report:${child.childId}`,
      RULES.childReportPerChild,
      deps.clock(),
    );
    try {
      // The RPC takes the child and family from the verified child session and accepts only the
      // child's own question/hint, so a sibling's or another family's item is refused.
      await deps.db.asChild(
        child,
        (tx) => tx`
          select public.child_report_content(${body.category}, ${body.questionId ?? null}::uuid,
                                             ${body.feedbackId ?? null}::uuid) as id`,
      );
    } catch (error) {
      if (pgErrorCode(error) === 'P0002') {
        throw new ApiError('NOT_FOUND', 'We couldn’t find that. You can still tell a grown-up.');
      }
      throw error;
    }
    deps.log({ level: 'info', event: 'child_report_created', requestId: c.var.requestId });
    return c.json({ received: true as const, message: CHILD_REPORT_THANKS }, 201);
  });

  // ----- Owner admin report queue ---------------------------------------------------------------

  // System reports add the screen's category codes (never text) so the reviewer can follow the
  // right escalation step (runbook 5.1), and whether a grown-up later corrected the flagged
  // answer's transcription (RV-child-safety-7; never the corrected text).
  const ADMIN_COLUMNS = `id, family_id, child_id, reporter_kind, category, question_id, feedback_id,
    (note is not null) as has_note, screen_categories, family_visible,
    (reporter_kind = 'system' and exists (
       select 1 from public.extracted_questions q
        where q.id = safety_reports.question_id
          and q.corrected_at > safety_reports.transcription_at)) as transcription_corrected,
    status, created_at, triaged_at, resolved_at, resolution_note, resolution`;
  /** `<created_at in epoch microseconds>_<id>` of the last report on the previous page. */
  const ADMIN_CURSOR =
    /^([0-9]{1,19})_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

  r.get('/admin/safety-reports', requireParent, async (c) => {
    const { deps } = c.var;
    await assertOwnerAdmin(c);
    const raw = c.req.query('status');
    let status: SafetyReportStatus | null = null;
    if (raw !== undefined) {
      const parsed = safetyReportStatusSchema.safeParse(raw);
      if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'Invalid request: status');
      status = parsed.data;
    }
    // Keyset pages, oldest first (RV-child-safety-9): a fixed first page of 200 hid every newer
    // report once 200 were escalated, however severe. `after` is the previous page's `nextCursor`.
    const after = c.req.query('after');
    let cursor: { micros: string; id: string } | null = null;
    if (after !== undefined) {
      const m = ADMIN_CURSOR.exec(after);
      if (!m) throw new ApiError('VALIDATION_FAILED', 'Invalid request: after');
      cursor = { micros: cursorMicros(m[1]!, deps.clock()), id: m[2]! };
    }
    // Service role after the aal2 owner check above (RLS no longer grants admins family reports,
    // migration 0670). Selects ids, category, status and timestamps only — never homework text,
    // child nicknames or the parent's free-text note.
    const rows = await deps.db.asService((tx) =>
      tx.unsafe<(AdminReportRow & { cursor_micros: string })[]>(
        `select ${ADMIN_COLUMNS},
                ((extract(epoch from created_at) * 1000000)::bigint)::text as cursor_micros
           from public.safety_reports
          where ($1::text is null or status = $1::text)
            and ($2::bigint is null
                 or (created_at, id) > (timestamptz 'epoch' + $2::bigint * interval '1 microsecond', $3::uuid))
          order by created_at asc, id asc
          limit ${ADMIN_SAFETY_REPORTS_PAGE_SIZE + 1}`,
        [status, cursor?.micros ?? null, cursor?.id ?? null],
      ),
    );
    const page = rows.slice(0, ADMIN_SAFETY_REPORTS_PAGE_SIZE);
    const last = page.at(-1);
    const nextCursor =
      rows.length > ADMIN_SAFETY_REPORTS_PAGE_SIZE && last !== undefined
        ? `${last.cursor_micros}_${last.id}`
        : null;
    return c.json({ reports: page.map(toAdminReport), nextCursor });
  });

  r.patch('/admin/safety-reports/:id', requireParent, async (c) => {
    const { deps, parent } = c.var;
    await assertOwnerAdmin(c);
    const id = uuidSchema.safeParse(c.req.param('id'));
    if (!id.success) throw new ApiError('NOT_FOUND', 'Report not found');
    const body = await readJson(c, updateSafetyReportRequestSchema);
    const clearing = body.resolution === 'false_match';
    // `authenticated` has no update grant on reports; the owner admin (verified above, aal2) acts
    // through the service role on exactly this report id.
    const outcome = await deps.db.asService(async (tx) => {
      const [current] = await tx<
        {
          status: SafetyReportStatus;
          family_id: string;
          resolution_note: string | null;
          family_visible: boolean;
          reporter_kind: SafetyReport['reporterKind'];
          question_id: string | null;
          resolution: SafetyReportResolution | null;
        }[]
      >`select status, family_id, resolution_note, family_visible, reporter_kind, question_id, resolution
          from public.safety_reports where id = ${id.data} for update`;
      if (!current) throw new ApiError('NOT_FOUND', 'Report not found');
      if (body.status !== undefined && !REPORT_TRANSITIONS[current.status].includes(body.status)) {
        throw businessRule(
          PRIVACY_RULES.invalidTransition,
          `A ${current.status} report cannot move to ${body.status}`,
        );
      }
      const note = body.resolutionNote ?? current.resolution_note;
      if (body.status === 'resolved' && !note) {
        throw businessRule(
          PRIVACY_RULES.resolutionNoteRequired,
          'Add a resolution note before resolving',
        );
      }
      if (clearing && (current.reporter_kind !== 'system' || current.question_id === null)) {
        throw businessRule(
          PRIVACY_RULES.falseMatchSystemOnly,
          'Only a flag from PencilLift’s safety screen can be cleared as a false match',
        );
      }
      // Round 3 (CHK2-CS-5): the family never learns of a held flag that was cleared.
      if (body.familyVisible === true && current.resolution !== null && !current.family_visible) {
        throw businessRule(
          PRIVACY_RULES.falseMatchNotReleasable,
          'A held flag cleared as a false match is never released to the family',
        );
      }
      // A clearance re-checks the flagged question, so its scan must not be mid-run (shared with
      // the guardian's clearing above).
      const clearable: ClearableReport | null =
        clearing && current.question_id
          ? { question_id: current.question_id, family_id: current.family_id }
          : null;
      const scan = clearable ? await lockFlaggedScan(tx, clearable) : undefined;
      const nextStatus = body.status ?? current.status;
      // Forward only: a held report can be released to the family list, never hidden again.
      const released = body.familyVisible === true && !current.family_visible;
      const visible = current.family_visible || released;
      if (body.status === undefined && !released) {
        // Releasing a report that is already visible changes nothing (no triage stamp, no audit).
        const [same] = await tx.unsafe<AdminReportRow[]>(
          `select ${ADMIN_COLUMNS} from public.safety_reports where id = $1::uuid`,
          [id.data],
        );
        return { report: same!, recheck: undefined };
      }
      const [updated] = await tx.unsafe<AdminReportRow[]>(
        `update public.safety_reports
            set status = $2::text,
                triaged_at = coalesce(triaged_at, now()),
                resolved_at = case when $2::text = 'resolved' and status <> 'resolved' then now()
                                   else resolved_at end,
                resolution_note = $3::text,
                family_visible = $4::boolean,
                resolution = coalesce($5::text, resolution)
          where id = $1::uuid
          returning ${ADMIN_COLUMNS}`,
        [id.data, nextStatus, note, visible, clearing ? 'false_match' : null],
      );
      const recheck: SafetyClearanceRecheck | undefined = clearable
        ? await queueClearanceRecheck(tx, deps.clock(), clearable, scan)
        : undefined;
      // A held report's audit rows carry no family_id: family members can read their family's
      // audit log (0001 audit_member_read), and it must not point them at a held report.
      const auditFamily = visible ? current.family_id : null;
      if (body.status !== undefined) {
        const metadata = clearing
          ? { from: current.status, to: body.status, resolution: 'false_match', recheck }
          : { from: current.status, to: body.status };
        await tx`
          insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
          values (${auditFamily}, ${parent.userId}, 'admin', 'safety_report.updated', 'safety_report', ${id.data},
                  ${JSON.stringify(metadata)}::text::jsonb)`;
      }
      if (released) {
        await tx`
          insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
          values (${current.family_id}, ${parent.userId}, 'admin', 'safety_report.released_to_family', 'safety_report',
                  ${id.data}, ${JSON.stringify({ familyVisible: true })}::text::jsonb)`;
      }
      return { report: updated!, recheck };
    });
    if (outcome.recheck !== undefined) {
      deps.log({
        level: 'info',
        event: 'safety_flag_cleared',
        code: `RECHECK_${outcome.recheck.toUpperCase()}`,
        requestId: c.var.requestId,
      });
    }
    return c.json({
      report: toAdminReport(outcome.report),
      ...(outcome.recheck !== undefined ? { recheck: outcome.recheck } : {}),
    });
  });

  return r;
}
