import { Hono, type Context } from 'hono';
import {
  ASSIGNMENT_LIST_PAGE_SIZE,
  assignmentCursorSchema,
  CANCELLABLE_ASSIGNMENT_STATUSES,
  CORRECTABLE_ASSIGNMENT_STATUSES,
  correctTranscriptionRequestSchema,
  createAssignmentRequestSchema,
  DEFAULT_HOMEWORK_PAGE_ALLOWANCE_PER_CHILD,
  DEFAULT_HOMEWORK_UPLOAD_LIMITS,
  finalizeAssignmentRequestSchema,
  FINALIZED_ASSIGNMENT_STATUSES,
  HOMEWORK_READABLE_MIME_TYPES,
  overrideResultRequestSchema,
  uploadPagesRequestSchema,
  uuidSchema,
  type AssignmentDetailResponse,
  type AssignmentListResponse,
  type AssignmentSolutionsResponse,
  type AssignmentState,
  type AssignmentStateResponse,
  type AssignmentStatus,
  type AssignmentSummary,
  type ChildAssignmentDetailResponse,
  type ChildAssignmentListResponse,
  type ChildAssignmentSummary,
  type CorrectTranscriptionResponse,
  type GradedVerdict,
  type HomeworkMimeType,
  type HomeworkUploadLimits,
  type OverrideResultResponse,
  type PageAllowance,
  type ParentQuestion,
  type ParentQuestionResult,
  type UploadLimitsResponse,
  type UploadPage,
  type UploadPagesResponse,
  type UploadTarget,
} from '@pencillift/contracts';
import { calendarMonthOf, isValidIanaZone } from '@pencillift/domain';
import { readJson } from '../app.ts';
import { verifyChildAccessToken } from '../auth/child.ts';
import { acceptsTestProviderConsent } from '../config.ts';
import type { ChildPrincipal, ParentPrincipal, Tx } from '../db.ts';
import { ApiError, businessRule, pgErrorCode } from '../errors.ts';
import {
  assertRecentUnlock,
  currentFamilyId,
  requireChild,
  requireParent,
} from '../middleware/auth.ts';
import type { AppEnv } from '../middleware/context.ts';
import { enforceRateLimit, type RateRule } from '../middleware/rate-limit.ts';
import type { StoredObjectInfo } from '../providers/index.ts';
import { hasVerifiedConsent } from '../services/consent.ts';

/**
 * Homework capture, processing status, child results and parent solutions (spec P5, P6, P3 step-up,
 * P11 page allowance, P13 "uploads/create/finalize/cancel; scan status; child results; parent
 * solutions/regrade/override"). Extraction and grading are later jobs: this module registers pages,
 * reserves allowance, enqueues one durable `scan_process` job and serves what those jobs write.
 *
 * Authorization layers:
 * - Parent reads run as `authenticated` and child reads as `pl_child`, so RLS and column grants are an
 *   independent second layer (docs/Architecture.md §3). Child queries name allowlisted columns only.
 * - Writes need the service role (clients have no insert/update grants on these tables). Every
 *   service-role statement is scoped explicitly by the caller's verified family (and child).
 * - Parent solutions and overrides go through the SECURITY DEFINER RPCs of migration 0100, which
 *   re-check membership and the recent adult unlock inside the database.
 */

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

export interface HomeworkConfig {
  readonly limits: HomeworkUploadLimits;
  /** Pages per paid child per period (spec P11 prototype allowance). */
  readonly pageAllowancePerChild: number;
  /** Lifetime requested for signed upload URLs. */
  readonly uploadUrlTtlSeconds: number;
}

/** Hard ceilings from migration 0100 (source_pages checks and the `homework` bucket limit). */
const DB_MAX_PAGES = 50;
const DB_MAX_PAGE_BYTES = 15 * 1024 * 1024;

export const DEFAULT_HOMEWORK_CONFIG: HomeworkConfig = {
  limits: DEFAULT_HOMEWORK_UPLOAD_LIMITS,
  pageAllowancePerChild: DEFAULT_HOMEWORK_PAGE_ALLOWANCE_PER_CHILD,
  // Decision: 15 minutes is enough for 10 pages on a slow connection; resume re-issues URLs.
  uploadUrlTtlSeconds: 15 * 60,
};

/**
 * Decision: configured limits may only tighten the database ceilings (50 pages, 15 MB per page), so a
 * misconfiguration can never turn a limit error into a database 500.
 */
function resolveConfig(overrides: Partial<HomeworkConfig>): HomeworkConfig {
  const merged = { ...DEFAULT_HOMEWORK_CONFIG, ...overrides };
  return {
    ...merged,
    limits: {
      maxPages: Math.max(1, Math.min(merged.limits.maxPages, DB_MAX_PAGES)),
      maxPageBytes: Math.max(1, Math.min(merged.limits.maxPageBytes, DB_MAX_PAGE_BYTES)),
      allowedMimeTypes: merged.limits.allowedMimeTypes,
    },
  };
}

/**
 * Decision: creation is rate limited per caller so a stuck button or script cannot flood the family
 * with drafts, and a child cannot use up the parent's budget (separate keys).
 */
const CHILD_CREATE_RULE: RateRule = { limit: 30, windowSeconds: 3600 };
const PARENT_CREATE_RULE: RateRule = { limit: 120, windowSeconds: 3600 };
const CORRECTION_RULE: RateRule = { limit: 120, windowSeconds: 3600 };

const LIST_LIMIT = ASSIGNMENT_LIST_PAGE_SIZE;

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

const CHILD_LIST_LIMIT = 50;

const EXTENSIONS: Record<HomeworkMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

/** Names used in capture error copy. */
const TYPE_NAMES: Record<HomeworkMimeType, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/heic': 'HEIC',
  'application/pdf': 'PDF',
};

/** Child verdicts are shown only once checking has finished (no interim results). */
const RESULT_VISIBLE_STATUSES: readonly AssignmentStatus[] = ['ready', 'needs_parent_review'];

// ---------------------------------------------------------------------------------------------
// Callers
// ---------------------------------------------------------------------------------------------

type Caller =
  | { readonly kind: 'parent'; readonly parent: ParentPrincipal; readonly familyId: string }
  | {
      readonly kind: 'child';
      readonly child: ChildPrincipal;
      readonly familyId: string;
      readonly childId: string;
    };

function bearerToken(c: Context<AppEnv>): string | null {
  const header = c.req.header('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 && token.length < 8192 ? token : null;
}

/**
 * Capture routes accept a parent or a paired child. A child token only verifies with the API-only
 * child key (issuer/audience `pencillift-child`) and a parent token only with Supabase keys, so the
 * two can never be confused; the child session is then re-checked in the database exactly as
 * `requireChild` does, and the parent's family comes from active membership, never the body.
 */
async function resolveCaller(c: Context<AppEnv>): Promise<Caller> {
  const token = bearerToken(c);
  if (!token) throw new ApiError('UNAUTHENTICATED', 'Sign in to continue');
  const { deps } = c.var;
  const child = await verifyChildAccessToken(deps.config, token, deps.clock()).catch(() => null);
  if (child) {
    const [row] = await deps.db.asChild(
      child,
      (tx) => tx<{ id: string | null }[]>`select app.current_child_id() as id`,
    );
    if (!row?.id)
      throw new ApiError('UNAUTHENTICATED', 'Ask a grown-up to connect this device again');
    c.set('child', child);
    return { kind: 'child', child, familyId: child.familyId, childId: child.childId };
  }
  const parent = await deps.verifyParentToken(token);
  c.set('parent', parent);
  return { kind: 'parent', parent, familyId: await currentFamilyId(c) };
}

/** Error copy differs by audience: children get calm, blame-free words (spec P6, P14). */
function say(caller: Caller, parentText: string, childText: string): string {
  return caller.kind === 'child' ? childText : parentText;
}

// ---------------------------------------------------------------------------------------------
// Rows and DTO mappers (explicit columns only)
// ---------------------------------------------------------------------------------------------

interface AssignmentRow {
  id: string;
  family_id: string;
  child_id: string;
  subject_id: string | null;
  status: AssignmentStatus;
  page_count: number;
  created_by_kind: 'parent' | 'child';
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

interface PageRow {
  id: string;
  page_number: number;
  mime_type: HomeworkMimeType;
  byte_size: number;
  sha256: string;
  storage_path: string;
}

interface ParentQuestionRow {
  id: string;
  page_number: number;
  question_number: string;
  prompt_text: string;
  student_answer_text: string | null;
  corrected_prompt_text: string | null;
  corrected_student_answer_text: string | null;
  corrected_at: Date | null;
  answer_kind: ParentQuestion['answerKind'];
  subject_key: string;
  skill: string;
  uncertainty: 'low' | 'medium' | 'high' | null;
  verdict: GradedVerdict | null;
  route: ParentQuestionResult['route'] | null;
  disagreement: boolean | null;
  graded_at: Date | null;
  parent_override_verdict: 'correct' | 'incorrect' | 'unresolved' | null;
  override_reason: string | null;
  overridden_at: Date | null;
}

/** Selected via postgres.js's escaped-identifier helper (never string-built SQL). */
const ASSIGNMENT_COLUMNS: string[] = [
  'id',
  'family_id',
  'child_id',
  'subject_id',
  'status',
  'page_count',
  'created_by_kind',
  'error_code',
  'created_at',
  'updated_at',
];

function toState(row: AssignmentRow): AssignmentState {
  return {
    id: row.id,
    subjectId: row.subject_id,
    status: row.status,
    pageCount: row.page_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toSummary(row: AssignmentRow): AssignmentSummary {
  return {
    ...toState(row),
    childId: row.child_id,
    createdByKind: row.created_by_kind,
    errorCode: row.error_code,
  };
}

function toParentResult(row: ParentQuestionRow): ParentQuestionResult | null {
  if (row.verdict === null || row.route === null || row.graded_at === null) return null;
  const override =
    row.parent_override_verdict !== null && row.overridden_at !== null
      ? {
          verdict: row.parent_override_verdict,
          reason: row.override_reason,
          at: row.overridden_at.toISOString(),
        }
      : null;
  return {
    verdict: override?.verdict ?? row.verdict,
    gradedVerdict: row.verdict,
    route: row.route,
    disagreement: row.disagreement ?? false,
    gradedAt: row.graded_at.toISOString(),
    override,
  };
}

function toParentQuestion(row: ParentQuestionRow): ParentQuestion {
  return {
    id: row.id,
    pageNumber: row.page_number,
    questionNumber: row.question_number,
    promptText: row.prompt_text,
    studentAnswerText: row.student_answer_text,
    correctedPromptText: row.corrected_prompt_text,
    correctedStudentAnswerText: row.corrected_student_answer_text,
    correctedAt: row.corrected_at?.toISOString() ?? null,
    answerKind: row.answer_kind,
    subjectKey: row.subject_key,
    skill: row.skill,
    uncertainty: row.uncertainty,
    result: toParentResult(row),
  };
}

// ---------------------------------------------------------------------------------------------
// Shared queries
// ---------------------------------------------------------------------------------------------

function paramUuid(c: Context<AppEnv>, name: string, notFound: string): string {
  const parsed = uuidSchema.safeParse(c.req.param(name));
  if (!parsed.success) throw new ApiError('NOT_FOUND', notFound);
  return parsed.data;
}

/**
 * Locks one assignment the caller may act on (service role, so the scope is explicit): same family,
 * and for a child also the same child. Deleted work is invisible.
 */
async function lockAssignment(tx: Tx, caller: Caller, id: string): Promise<AssignmentRow | null> {
  const isParent = caller.kind === 'parent';
  const childId = caller.kind === 'child' ? caller.childId : null;
  const [row] = await tx<AssignmentRow[]>`
    select ${tx(ASSIGNMENT_COLUMNS)} from public.assignments
     where id = ${id} and family_id = ${caller.familyId} and status <> 'deleted'
       and (${isParent}::boolean or child_id = ${childId}::uuid)
     for update`;
  return row ?? null;
}

async function readPages(tx: Tx, familyId: string, assignmentId: string): Promise<PageRow[]> {
  return tx<PageRow[]>`
    select id, page_number, mime_type, byte_size, sha256, storage_path from public.source_pages
     where assignment_id = ${assignmentId} and family_id = ${familyId} and deleted_at is null
     order by page_number`;
}

interface PaidProfileState {
  status: string;
  /** The profile may use paid AI now (spec P11); see `readPaidProfile`. */
  entitled: boolean;
}

/**
 * Whether a child profile is paid for right now (spec P11: "stop paid AI for inactive profiles";
 * migration 0001: "active: holds a paid slot"). The profile status alone is not enough: a
 * provider-confirmed downgrade or expiry releases the slot (`child_slot_assignments.released_at`,
 * services/billing-sync.ts) and leaves the profile row `active` (RV-homework-3).
 *
 * Entitled when the profile is `active`, the family has verified paid capacity, and either
 * - it holds an open slot assignment (the activation route always creates one), or
 * - it has no slot history at all (a profile made `active` without the activation route, e.g. seeded
 *   test data) and verified capacity still covers every active profile in the family.
 * A released slot with no open one, zero capacity, or more slot-less active profiles than capacity
 * all fail closed. Works under RLS (parent reads) and the service role; scoped by family either way.
 */
async function readPaidProfile(
  tx: Tx,
  familyId: string,
  childId: string,
): Promise<PaidProfileState | null> {
  const [row] = await tx<
    {
      status: string;
      holds_slot: boolean;
      slot_history: boolean;
      active_profiles: number;
      paid_slots: number;
    }[]
  >`
    select c.status,
           exists (select 1 from public.child_slot_assignments s
                    where s.child_id = c.id and s.family_id = c.family_id
                      and s.released_at is null) as holds_slot,
           exists (select 1 from public.child_slot_assignments s
                    where s.child_id = c.id and s.family_id = c.family_id) as slot_history,
           (select count(*)::int from public.child_profiles o
             where o.family_id = c.family_id and o.status = 'active') as active_profiles,
           coalesce((select f.paid_slots from public.family_capacity f
                      where f.family_id = c.family_id), 0)::int as paid_slots
      from public.child_profiles c
     where c.id = ${childId} and c.family_id = ${familyId}`;
  if (!row) return null;
  const entitled =
    row.status === 'active' &&
    row.paid_slots >= 1 &&
    (row.holds_slot || (!row.slot_history && row.active_profiles <= row.paid_slots));
  return { status: row.status, entitled };
}

/**
 * Consent (spec P3) and an active paid profile (spec P11) gate every capture step: create, upload
 * (including a resumed upload, which signs new URLs for child photos) and finalize.
 */
async function assertCanCollect(
  c: Context<AppEnv>,
  tx: Tx,
  caller: Caller,
  childId: string,
): Promise<void> {
  // A record the development consent mock wrote counts only where that mock may run (LRD-1).
  const allowTestProvider = acceptsTestProviderConsent(c.var.deps.config.environment);
  if (!(await hasVerifiedConsent(tx, caller.familyId, { allowTestProvider }))) {
    throw businessRule(
      'CONSENT_REQUIRED',
      say(
        caller,
        'Parental consent must be verified before homework can be scanned',
        'A grown-up needs to finish setting up PencilLift before you can scan.',
      ),
    );
  }
  const profile = await readPaidProfile(tx, caller.familyId, childId);
  if (!profile?.entitled) {
    throw businessRule(
      'CHILD_NOT_ACTIVE',
      say(
        caller,
        profile?.status === 'active'
          ? 'This child has no paid child slot right now, so new scans are paused. Existing homework and results stay available.'
          : 'Assign a paid slot to this child before scanning homework',
        'Ask a grown-up to help with scanning right now.',
      ),
    );
  }
}

/**
 * Period key for the page allowance. Decision (placeholder): the calendar month in the family's time
 * zone, namespaced `pages:` so other usage kinds can share the ledger. Provider billing periods
 * (spec P11/Architecture §5) must replace this once entitlement periods are reconciled.
 */
async function pagePeriodKey(tx: Tx, familyId: string, now: Date): Promise<string> {
  const [family] = await tx<{ timezone: string }[]>`
    select timezone from public.families where id = ${familyId}`;
  const zone = family && isValidIanaZone(family.timezone) ? family.timezone : 'UTC';
  return `pages:${calendarMonthOf(now, zone)}`;
}

interface Usage {
  childUsed: number;
  familyUsed: number;
  paidSlots: number;
}

/** In-flight (`reserved`) and `committed` pages both count (AC_SECURITY_06); released never does. */
async function pageUsage(
  tx: Tx,
  familyId: string,
  childId: string,
  periodKey: string,
): Promise<Usage> {
  const [row] = await tx<{ child_used: number; family_used: number; paid_slots: number }[]>`
    select coalesce(sum(units) filter (where child_id = ${childId}), 0)::int as child_used,
           coalesce(sum(units), 0)::int as family_used,
           coalesce((select paid_slots from public.family_capacity where family_id = ${familyId}), 0)::int as paid_slots
      from public.usage_reservations
     where family_id = ${familyId} and period_key = ${periodKey} and status in ('reserved', 'committed')`;
  return {
    childUsed: row?.child_used ?? 0,
    familyUsed: row?.family_used ?? 0,
    paidSlots: row?.paid_slots ?? 0,
  };
}

function toAllowance(
  periodKey: string,
  usage: Usage,
  perChild: number,
  childHasPaidSlot: boolean,
): PageAllowance {
  return {
    periodKey,
    childPagesUsed: usage.childUsed,
    childPagesAllowed: perChild,
    familyPagesUsed: usage.familyUsed,
    familyPagesAllowed: usage.paidSlots * perChild,
    childHasPaidSlot,
  };
}

function assertWithinAllowance(caller: Caller, usage: Usage, units: number, perChild: number) {
  const childOver = usage.childUsed + units > perChild;
  const familyOver = usage.familyUsed + units > usage.paidSlots * perChild;
  if (childOver || familyOver) {
    throw businessRule(
      'QUOTA_EXCEEDED',
      say(
        caller,
        'This month’s homework page allowance is used up. Existing homework, results and practice stay available.',
        'That’s a lot of scanning this month! Ask a grown-up to help with this one.',
      ),
    );
  }
}

/** Expected trigger/constraint outcomes → stable API errors (never raw SQL text). */
function mapDbError(error: unknown, caller: Caller | null): never {
  const code = pgErrorCode(error);
  const message = error instanceof Error ? error.message : '';
  if (code === 'P0001' && message.includes('invalid assignment transition')) {
    throw businessRule(
      'INVALID_TRANSITION',
      caller?.kind === 'child'
        ? 'This scan can’t change right now.'
        : 'This scan can’t move to that state from where it is now',
    );
  }
  if (code === 'P0001' && message.includes('is deleted')) {
    throw new ApiError('NOT_FOUND', 'Not found');
  }
  throw error;
}

async function audit(
  tx: Tx,
  caller: Caller,
  action: string,
  targetType: string,
  targetId: string,
): Promise<void> {
  // Pseudonymous ids only; never homework text (spec P4).
  await tx`
    insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id)
    values (${caller.familyId}, ${caller.kind === 'parent' ? caller.parent.userId : null},
            ${caller.kind}, ${action}, ${targetType}, ${targetId})`;
}

async function readParentQuestions(
  tx: Tx,
  familyId: string,
  assignmentId: string,
  questionId: string | null,
): Promise<ParentQuestionRow[]> {
  return tx<ParentQuestionRow[]>`
    select q.id, p.page_number, q.question_number, q.prompt_text, q.student_answer_text,
           q.corrected_prompt_text, q.corrected_student_answer_text, q.corrected_at, q.answer_kind,
           q.subject_key, q.skill, q.uncertainty,
           r.verdict, r.route, r.disagreement, r.graded_at, r.parent_override_verdict,
           r.override_reason, r.overridden_at
      from public.extracted_questions q
      join public.source_pages p on p.id = q.page_id
      left join public.question_results r on r.question_id = q.id
     where q.assignment_id = ${assignmentId} and q.family_id = ${familyId}
       and (${questionId}::uuid is null or q.id = ${questionId}::uuid)
     order by p.page_number, length(q.question_number), q.question_number`;
}

/**
 * Closes the parent review loop (RV-homework-5): once nothing in a `needs_parent_review` scan is
 * left for the parent to decide, the scan becomes `ready`, so the parent list and the child stop
 * saying it needs review. Service role, so every statement is scoped by the caller's family.
 *
 * A question is still open when it has no result, when its result is undecided
 * (`needs_parent_review` / `unresolved`) and the parent has not overridden it — the same rule the
 * scan job's recheck applies — or when its transcription was corrected after it was graded (a
 * failed re-check leaves the old result in place) and no override was made since that correction.
 */
async function settleParentReview(tx: Tx, caller: Caller, questionId: string): Promise<void> {
  const [assignment] = await tx<{ id: string; status: AssignmentStatus }[]>`
    select a.id, a.status from public.assignments a
      join public.extracted_questions q on q.assignment_id = a.id and q.family_id = a.family_id
     where q.id = ${questionId} and a.family_id = ${caller.familyId}
     for update of a`;
  if (assignment?.status !== 'needs_parent_review') return;
  const [open] = await tx<{ n: number }[]>`
    select count(*)::int as n
      from public.extracted_questions q
      left join public.question_results r on r.question_id = q.id and r.family_id = q.family_id
     where q.assignment_id = ${assignment.id} and q.family_id = ${caller.familyId}
       and (r.question_id is null
            or (r.parent_override_verdict is null
                and r.verdict in ('needs_parent_review', 'unresolved'))
            or (q.corrected_at is not null and q.corrected_at > r.graded_at
                and (r.overridden_at is null or r.overridden_at < q.corrected_at)))`;
  if ((open?.n ?? 1) > 0) return;
  const settled = await tx`
    update public.assignments set status = 'ready', error_code = null
     where id = ${assignment.id} and family_id = ${caller.familyId}
       and status = 'needs_parent_review'
    returning id`;
  if (settled.length === 1) {
    await audit(tx, caller, 'homework.review_settled', 'assignment', assignment.id);
  }
}

/** Validates page numbering and the configured limits before touching the database. */
function validatePages(pages: readonly UploadPage[], config: HomeworkConfig): void {
  const numbers = pages.map((p) => p.pageNumber).sort((a, b) => a - b);
  if (numbers.some((n, i) => n !== i + 1)) {
    throw new ApiError('VALIDATION_FAILED', 'Invalid request: pages must be numbered 1, 2, 3, …');
  }
  const { limits } = config;
  if (pages.length > limits.maxPages) {
    throw businessRule('TOO_MANY_PAGES', `A scan can have at most ${limits.maxPages} pages`);
  }
  const allowed: readonly string[] = limits.allowedMimeTypes;
  const readable = limits.allowedMimeTypes.filter((t) => HOMEWORK_READABLE_MIME_TYPES.includes(t));
  const readableNames = readable.map((t) => TYPE_NAMES[t]).join(' or ');
  if (pages.some((p) => !allowed.includes(p.mimeType))) {
    throw businessRule('UNSUPPORTED_FILE_TYPE', `Only ${readableNames} photos work`);
  }
  // Decision (AC_CAPTURE_02): HEIC and PDF stay in the configured list (spec P5; clients show them
  // as "not available yet") but the scan job cannot read them until the isolated converter ships.
  // Refusing them here, before pages are registered or signed, keeps a scan from starting, using
  // allowance and then failing as FORMAT_NEEDS_CONVERSION.
  const unreadable = pages.find((p) => !(readable as readonly string[]).includes(p.mimeType));
  if (unreadable) {
    const name = TYPE_NAMES[unreadable.mimeType as HomeworkMimeType];
    throw businessRule(
      'FORMAT_NOT_SUPPORTED_YET',
      `${name} files can’t be read yet. Please add ${readableNames} photos of the pages instead.`,
    );
  }
  if (pages.some((p) => p.byteSize > limits.maxPageBytes)) {
    const mb = Math.floor(limits.maxPageBytes / (1024 * 1024));
    throw businessRule('PAGE_TOO_LARGE', `Each page must be ${mb} MB or smaller`);
  }
}

function samePages(existing: readonly PageRow[], requested: readonly UploadPage[]): boolean {
  if (existing.length !== requested.length) return false;
  const byNumber = new Map(requested.map((p) => [p.pageNumber, p]));
  return existing.every((row) => {
    const p = byNumber.get(row.page_number);
    return (
      p !== undefined &&
      p.mimeType === row.mime_type &&
      p.byteSize === row.byte_size &&
      p.sha256 === row.sha256
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

/** Homework routes. Mounted at /v1: /assignments*, /child/assignments*, /questions*. */
export function homeworkRoutes(overrides: Partial<HomeworkConfig> = {}): Hono<AppEnv> {
  const config = resolveConfig(overrides);
  const r = new Hono<AppEnv>();
  // Middleware is attached per route (never `use('*')`): this router shares the /v1 prefix.

  // Registered before `/assignments/:id` so the static path wins.
  r.get('/assignments/limits', async (c) => {
    await resolveCaller(c);
    const body: UploadLimitsResponse = {
      limits: {
        maxPages: config.limits.maxPages,
        maxPageBytes: config.limits.maxPageBytes,
        allowedMimeTypes: [...config.limits.allowedMimeTypes],
      },
    };
    return c.json(body);
  });

  // -------------------------------------------------------------------------------------------
  // Capture (parent or child)
  // -------------------------------------------------------------------------------------------

  r.post('/assignments', async (c) => {
    const caller = await resolveCaller(c);
    const { deps } = c.var;
    const body = await readJson(c, createAssignmentRequestSchema);
    if (caller.kind === 'child' && body.childId !== undefined) {
      throw new ApiError('VALIDATION_FAILED', 'Invalid request: childId');
    }
    if (caller.kind === 'parent' && body.childId === undefined) {
      throw new ApiError('VALIDATION_FAILED', 'Invalid request: childId');
    }
    const childId = caller.kind === 'child' ? caller.childId : body.childId!;
    if (body.pageCount > config.limits.maxPages) {
      throw businessRule(
        'TOO_MANY_PAGES',
        `A scan can have at most ${config.limits.maxPages} pages`,
      );
    }
    const now = deps.clock();
    await enforceRateLimit(
      deps.rateLimiter,
      caller.kind === 'child'
        ? `homework-create:child:${caller.childId}`
        : `homework-create:parent:${caller.familyId}`,
      caller.kind === 'child' ? CHILD_CREATE_RULE : PARENT_CREATE_RULE,
      now,
    );
    // Decision: client keys are namespaced by family so one family's key can never collide with,
    // or reveal, another family's (the column is globally unique).
    const scopedKey = `${caller.familyId}:${body.idempotencyKey}`;

    const outcome = await deps.db
      .asService(async (tx) => {
        const [child] = await tx<{ id: string }[]>`
          select id from public.child_profiles where id = ${childId} and family_id = ${caller.familyId}`;
        if (!child) throw new ApiError('NOT_FOUND', 'Child not found');
        const existing = async () => {
          const [row] = await tx<AssignmentRow[]>`
            select ${tx(ASSIGNMENT_COLUMNS)} from public.assignments
             where family_id = ${caller.familyId} and idempotency_key = ${scopedKey}`;
          if (!row) return null;
          if (row.child_id !== childId || row.status === 'deleted') {
            throw new ApiError('CONFLICT', 'This request key was already used for another scan');
          }
          return row;
        };
        const prior = await existing();
        if (prior) return { row: prior, created: false };
        await assertCanCollect(c, tx, caller, childId);
        if (body.subjectId !== undefined) {
          const [subject] = await tx<{ id: string }[]>`
            select id from public.child_subjects
             where id = ${body.subjectId} and child_id = ${childId} and family_id = ${caller.familyId}
               and enabled`;
          if (!subject) throw new ApiError('NOT_FOUND', 'Subject not found');
        }
        // Advisory early check so nobody uploads pages that cannot be processed; finalize is the
        // authoritative, atomic reservation.
        const periodKey = await pagePeriodKey(tx, caller.familyId, now);
        const usage = await pageUsage(tx, caller.familyId, childId, periodKey);
        assertWithinAllowance(caller, usage, body.pageCount, config.pageAllowancePerChild);
        const [row] = await tx<AssignmentRow[]>`
          insert into public.assignments (family_id, child_id, subject_id, idempotency_key, created_by_kind, page_count)
          values (${caller.familyId}, ${childId}, ${body.subjectId ?? null}, ${scopedKey}, ${caller.kind}, ${body.pageCount})
          on conflict (idempotency_key) do nothing
          returning ${tx(ASSIGNMENT_COLUMNS)}`;
        if (row) {
          await audit(tx, caller, 'homework.created', 'assignment', row.id);
          return { row, created: true };
        }
        // A concurrent request with the same key won the insert.
        const raced = await existing();
        if (!raced) throw new ApiError('CONFLICT', 'Please try again');
        return { row: raced, created: false };
      })
      .catch((error: unknown) => mapDbError(error, caller));
    const response: AssignmentStateResponse = { assignment: toState(outcome.row) };
    return c.json(response, outcome.created ? 201 : 200);
  });

  r.post('/assignments/:id/uploads', async (c) => {
    const caller = await resolveCaller(c);
    const { deps } = c.var;
    const id = paramUuid(c, 'id', 'Scan not found');
    const { pages } = await readJson(c, uploadPagesRequestSchema);
    validatePages(pages, config);

    const registered = await deps.db
      .asService(async (tx) => {
        const assignment = await lockAssignment(tx, caller, id);
        if (!assignment) throw new ApiError('NOT_FOUND', 'Scan not found');
        if (assignment.status === 'uploading') {
          // A resume signs fresh PUT URLs for child photos, so it passes the same consent and
          // paid-profile gate as a new scan (RV-homework-1): withdrawn consent stops uploads.
          await assertCanCollect(c, tx, caller, assignment.child_id);
          // Resume after an interrupted upload: the same pages get fresh URLs; changed pages would
          // silently alter what was already sent, so they need a new scan.
          const existing = await readPages(tx, caller.familyId, id);
          if (!samePages(existing, pages)) {
            throw new ApiError(
              'CONFLICT',
              say(
                caller,
                'These pages differ from the ones already added. Start a new scan to change pages.',
                'These pages are different. Let’s start a new scan.',
              ),
            );
          }
          return { assignment, pages: existing };
        }
        if (assignment.status === 'needs_rescan') {
          // Decision: a rescan is a new scan so the unreadable pages and their evidence stay intact.
          throw businessRule(
            'START_NEW_SCAN',
            say(
              caller,
              'Start a new scan with clearer pictures',
              'Let’s get a clearer picture with a new scan.',
            ),
          );
        }
        if (assignment.status !== 'draft') {
          throw businessRule(
            'INVALID_TRANSITION',
            say(
              caller,
              'Pages can only be added before a scan is sent',
              'This scan was already sent.',
            ),
          );
        }
        await assertCanCollect(c, tx, caller, assignment.child_id);
        if (pages.length !== assignment.page_count) {
          throw businessRule(
            'PAGE_COUNT_MISMATCH',
            `This scan was started with ${assignment.page_count} page(s)`,
          );
        }
        const inserted: PageRow[] = [];
        for (const page of [...pages].sort((a, b) => a.pageNumber - b.pageNumber)) {
          const mime = page.mimeType as HomeworkMimeType;
          const pageId = crypto.randomUUID();
          const path = `${caller.familyId}/${assignment.child_id}/${id}/${pageId}.${EXTENSIONS[mime]}`;
          const [row] = await tx<PageRow[]>`
            insert into public.source_pages
              (id, assignment_id, family_id, child_id, page_number, storage_path, mime_type, byte_size, sha256)
            values (${pageId}, ${id}, ${caller.familyId}, ${assignment.child_id}, ${page.pageNumber},
                    ${path}, ${mime}, ${page.byteSize}, ${page.sha256})
            returning id, page_number, mime_type, byte_size, sha256, storage_path`;
          inserted.push(row!);
        }
        const [updated] = await tx<AssignmentRow[]>`
          update public.assignments set status = 'uploading'
           where id = ${id} and family_id = ${caller.familyId}
          returning ${tx(ASSIGNMENT_COLUMNS)}`;
        return { assignment: updated!, pages: inserted };
      })
      .catch((error: unknown) => mapDbError(error, caller));

    // Signing happens after commit: network I/O never holds row locks, and a storage outage leaves
    // the registered pages in place so the same request can simply be retried (resume).
    let uploads: UploadTarget[];
    try {
      uploads = await Promise.all(
        registered.pages.map(async (page) => {
          const [signed, present] = await Promise.all([
            deps.providers.storage.createSignedUploadUrl(
              page.storage_path,
              config.uploadUrlTtlSeconds,
              { byteSize: page.byte_size, contentType: page.mime_type },
            ),
            deps.providers.storage.exists(page.storage_path),
          ]);
          return {
            pageId: page.id,
            pageNumber: page.page_number,
            uploadUrl: signed.url,
            method: 'PUT' as const,
            expiresAt: signed.expiresAt.toISOString(),
            alreadyUploaded: present,
          };
        }),
      );
    } catch {
      deps.log({
        level: 'warn',
        event: 'homework_storage_unavailable',
        requestId: c.var.requestId,
      });
      throw new ApiError(
        'PROVIDER_UNAVAILABLE',
        say(
          caller,
          'Homework storage is not reachable right now. Your pages are saved; please try again.',
          'We couldn’t reach the internet helper. Let’s try again in a moment.',
        ),
      );
    }
    const response: UploadPagesResponse = { assignment: toState(registered.assignment), uploads };
    return c.json(response);
  });

  r.post('/assignments/:id/finalize', async (c) => {
    const caller = await resolveCaller(c);
    const { deps } = c.var;
    const id = paramUuid(c, 'id', 'Scan not found');
    // Decision: the client key is required for retry semantics, but deduplication is keyed by the
    // assignment itself (one live reservation and one job per scan version), which is stronger than
    // trusting a client-chosen key.
    await readJson(c, finalizeAssignmentRequestSchema);

    // Storage checks run outside the transaction (network I/O must not hold row locks).
    const pre = await deps.db.asService(async (tx) => {
      const [row] = await tx<{ status: AssignmentStatus }[]>`
        select status from public.assignments
         where id = ${id} and family_id = ${caller.familyId} and status <> 'deleted'
           and (${caller.kind === 'parent'}::boolean or child_id = ${caller.kind === 'child' ? caller.childId : null}::uuid)`;
      if (!row) return null;
      return { status: row.status, pages: await readPages(tx, caller.familyId, id) };
    });
    if (!pre) throw new ApiError('NOT_FOUND', 'Scan not found');
    let verified = false;
    if (pre.status === 'uploading') {
      // AC_CAPTURE_02: byte size and hash were declared by the device at registration, so finalize
      // compares them with what storage measured (never trusting mere existence). Only the size can
      // be checked cheaply: Supabase reports no content hash besides an MD5/multipart ETag, and
      // hashing would mean downloading every page here (see providers/supabase-storage.ts).
      let stored: (StoredObjectInfo | null)[];
      try {
        stored = await Promise.all(
          pre.pages.map((p) => deps.providers.storage.stat(p.storage_path)),
        );
      } catch {
        throw new ApiError('PROVIDER_UNAVAILABLE', 'Homework storage is not reachable right now');
      }
      if (pre.pages.length === 0 || stored.includes(null)) {
        throw businessRule(
          'UPLOAD_INCOMPLETE',
          say(
            caller,
            'Some pages have not finished uploading. Resume the upload, then send the scan.',
            'Some pages didn’t finish sending. Let’s try sending them again.',
          ),
        );
      }
      const mismatched = pre.pages.filter((p, i) => {
        const size = stored[i]!.byteSize;
        return size !== p.byte_size || size > config.limits.maxPageBytes;
      });
      if (mismatched.length > 0) {
        // Unverified bytes are removed so a resume signs fresh URLs and sends those pages again
        // (uploads never overwrite). Best effort: a failed removal still refuses, and the pages
        // stay unfinalized either way.
        deps.log({ level: 'warn', event: 'homework_upload_mismatch', requestId: c.var.requestId });
        await deps.providers.storage.remove(mismatched.map((p) => p.storage_path)).catch(() => {
          deps.log({
            level: 'warn',
            event: 'homework_storage_remove_failed',
            requestId: c.var.requestId,
          });
        });
        throw businessRule(
          'UPLOAD_MISMATCH',
          say(
            caller,
            'Some pages didn’t arrive the way they were sent. Try again to send those pages again.',
            'Some pages got mixed up on the way. Let’s try sending them again.',
          ),
        );
      }
      verified = true;
    }

    const now = deps.clock();
    const result = await deps.db
      .asService(async (tx) => {
        const assignment = await lockAssignment(tx, caller, id);
        if (!assignment) throw new ApiError('NOT_FOUND', 'Scan not found');
        if (FINALIZED_ASSIGNMENT_STATUSES.includes(assignment.status)) return assignment;
        if (assignment.status === 'draft') {
          throw businessRule(
            'NO_PAGES',
            say(caller, 'Add pages before sending the scan', 'Add a page first.'),
          );
        }
        if (assignment.status !== 'uploading') {
          throw businessRule(
            'INVALID_TRANSITION',
            say(caller, 'This scan was cancelled', 'This scan was stopped.'),
          );
        }
        if (!verified) {
          throw businessRule('UPLOAD_INCOMPLETE', 'Please send the scan again');
        }
        await assertCanCollect(c, tx, caller, assignment.child_id);
        // Serialize reservations for one family (two guardians, several devices).
        await tx`select id from public.families where id = ${caller.familyId} for update`;
        const pages = await readPages(tx, caller.familyId, id);
        const units = pages.length;
        const periodKey = await pagePeriodKey(tx, caller.familyId, now);
        const reservations = await tx<{ id: string; status: string }[]>`
          select id, status from public.usage_reservations
           where family_id = ${caller.familyId} and idempotency_key like ${`scan-usage:${id}:v%`}`;
        let reservationId = reservations.find((r) => r.status !== 'released')?.id;
        if (!reservationId) {
          const usage = await pageUsage(tx, caller.familyId, assignment.child_id, periodKey);
          assertWithinAllowance(caller, usage, units, config.pageAllowancePerChild);
          const [created] = await tx<{ id: string }[]>`
            insert into public.usage_reservations (family_id, child_id, period_key, units, idempotency_key)
            values (${caller.familyId}, ${assignment.child_id}, ${periodKey}, ${units},
                    ${`scan-usage:${id}:v${reservations.length + 1}`})
            returning id`;
          reservationId = created!.id;
        }
        // The next version follows the HIGHEST kept one, never a count: job retention prunes old
        // terminal rows (BUG-139), so a count could re-derive a key a kept later row still holds.
        const [jobs] = await tx<{ n: number }[]>`
          select coalesce(max(substring(idempotency_key from ':v([0-9]+)$')::int), 0) as n
            from public.jobs
           where family_id = ${caller.familyId} and idempotency_key like ${`scan:${id}:v%`}`;
        // Payload holds references only, never homework content (migration 0600).
        await tx`
          insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, run_after)
          values ('scan_process', ${`scan:${id}:v${(jobs?.n ?? 0) + 1}`}, ${caller.familyId},
                  ${assignment.child_id},
                  ${tx.json({ assignmentId: id, mode: 'initial', reservationId })}, ${deps.clock()})
          on conflict (idempotency_key) do nothing`;
        const [updated] = await tx<AssignmentRow[]>`
          update public.assignments set status = 'queued'
           where id = ${id} and family_id = ${caller.familyId}
          returning ${tx(ASSIGNMENT_COLUMNS)}`;
        await audit(tx, caller, 'homework.finalized', 'assignment', id);
        return updated!;
      })
      .catch((error: unknown) => mapDbError(error, caller));
    const response: AssignmentStateResponse = { assignment: toState(result) };
    return c.json(response);
  });

  r.post('/assignments/:id/cancel', async (c) => {
    const caller = await resolveCaller(c);
    const { deps } = c.var;
    const id = paramUuid(c, 'id', 'Scan not found');
    /**
     * Decision (RV-homework-2): `source_pages.deleted_at` means "the object is gone from storage",
     * which is what the raw-scan retention purge relies on (it only selects `deleted_at is null`).
     * So the cancel commits the state change first, removes the objects after commit (no network I/O
     * under row locks), and stamps `deleted_at` only for objects storage confirmed removed. If
     * storage is unreachable the rows stay live: a repeated cancel retries the removal, and the
     * 30-day retention purge removes them at the latest. The scan job never reads them (a cancelled
     * scan cannot move to `extracting`).
     */
    const livePages = (tx: Tx) =>
      tx<{ id: string; storage_path: string }[]>`
        select id, storage_path from public.source_pages
         where assignment_id = ${id} and family_id = ${caller.familyId} and deleted_at is null`;
    const outcome = await deps.db
      .asService(async (tx) => {
        const assignment = await lockAssignment(tx, caller, id);
        if (!assignment) throw new ApiError('NOT_FOUND', 'Scan not found');
        if (assignment.status === 'cancelled') {
          return { row: assignment, pages: await livePages(tx) };
        }
        if (!CANCELLABLE_ASSIGNMENT_STATUSES.includes(assignment.status)) {
          throw businessRule(
            'INVALID_TRANSITION',
            say(
              caller,
              'Finished or in-progress scans can’t be cancelled',
              'This scan is already being checked.',
            ),
          );
        }
        const [updated] = await tx<AssignmentRow[]>`
          update public.assignments set status = 'cancelled'
           where id = ${id} and family_id = ${caller.familyId}
          returning ${tx(ASSIGNMENT_COLUMNS)}`;
        await tx`
          update public.usage_reservations set status = 'released', release_reason = 'cancelled'
           where family_id = ${caller.familyId} and status = 'reserved'
             and idempotency_key like ${`scan-usage:${id}:v%`}`;
        await tx`
          update public.jobs set status = 'cancelled'
           where family_id = ${caller.familyId} and status in ('queued', 'failed_retryable')
             and idempotency_key like ${`scan:${id}:v%`}`;
        await audit(tx, caller, 'homework.cancelled', 'assignment', id);
        return { row: updated!, pages: await livePages(tx) };
      })
      .catch((error: unknown) => mapDbError(error, caller));
    if (outcome.pages.length > 0) {
      // Decision: cancelled pages are deleted from storage right away (data minimization). A failure
      // is logged by code only; the rows stay live so a retried cancel or the retention purge job
      // removes what was left behind.
      const removed = await deps.providers.storage
        .remove(outcome.pages.map((p) => p.storage_path))
        .then(
          () => true,
          () => {
            deps.log({
              level: 'warn',
              event: 'homework_storage_remove_failed',
              requestId: c.var.requestId,
            });
            return false;
          },
        );
      if (removed) {
        await deps.db.asService(
          (tx) => tx`
            update public.source_pages set deleted_at = now()
             where assignment_id = ${id} and family_id = ${caller.familyId} and deleted_at is null
               and id = any(${outcome.pages.map((p) => p.id)}::uuid[])`,
        );
      }
    }
    const response: AssignmentStateResponse = { assignment: toState(outcome.row) };
    return c.json(response);
  });

  // -------------------------------------------------------------------------------------------
  // Parent views
  // -------------------------------------------------------------------------------------------

  r.get('/assignments', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const familyId = await currentFamilyId(c);
    const rawChild = c.req.query('childId');
    let childId: string | null = null;
    if (rawChild !== undefined) {
      const parsed = uuidSchema.safeParse(rawChild);
      if (!parsed.success) throw new ApiError('NOT_FOUND', 'Child not found');
      childId = parsed.data;
    }
    const now = deps.clock();
    // Keyset page, newest first (API-AUTH-R1-02): `after` is the previous page's `nextCursor`.
    const rawAfter = c.req.query('after');
    let cursor: { micros: string; id: string } | null = null;
    if (rawAfter !== undefined) {
      const parsed = assignmentCursorSchema.safeParse(rawAfter);
      if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'Invalid request: after');
      const [micros, id] = parsed.data.split('_') as [string, string];
      cursor = { micros: cursorMicros(micros, now), id };
    }
    const data = await deps.db.asParent(parent, async (tx) => {
      let childHasPaidSlot = false;
      if (childId !== null) {
        // Archived and draft profiles keep their scan history (spec P11, AC_CAPACITY_08); a child
        // whose data deletion is under way is not shown, like every other parent read.
        const [deleting] = await tx<{ id: string }[]>`
          select id from public.deletion_requests
           where family_id = ${familyId} and target_child_id = ${childId}
             and status in ('requested', 'processing')`;
        if (deleting) return null;
        // Parent read under RLS; the same rule the capture gate applies.
        const profile = await readPaidProfile(tx, familyId, childId);
        if (!profile) return null;
        childHasPaidSlot = profile.entitled;
      }
      const rows = await tx<(AssignmentRow & { cursor_micros: string })[]>`
        select ${tx(ASSIGNMENT_COLUMNS)},
               ((extract(epoch from created_at) * 1000000)::bigint)::text as cursor_micros
          from public.assignments
         where family_id = ${familyId} and status <> 'deleted'
           and (${childId}::uuid is null or child_id = ${childId}::uuid)
           and (${cursor?.micros ?? null}::bigint is null
                or (created_at, id) < (timestamptz 'epoch' + ${cursor?.micros ?? null}::bigint * interval '1 microsecond',
                                       ${cursor?.id ?? null}::uuid))
         order by created_at desc, id desc
         limit ${LIST_LIMIT + 1}`;
      let allowance: PageAllowance | null = null;
      if (childId !== null) {
        const periodKey = await pagePeriodKey(tx, familyId, now);
        const usage = await pageUsage(tx, familyId, childId, periodKey);
        allowance = toAllowance(periodKey, usage, config.pageAllowancePerChild, childHasPaidSlot);
      }
      return { rows, allowance };
    });
    if (!data) throw new ApiError('NOT_FOUND', 'Child not found');
    const page = data.rows.slice(0, LIST_LIMIT);
    const last = page.at(-1);
    const response: AssignmentListResponse = {
      assignments: page.map(toSummary),
      allowance: data.allowance,
      nextCursor:
        data.rows.length > LIST_LIMIT && last !== undefined
          ? `${last.cursor_micros}_${last.id}`
          : null,
    };
    return c.json(response);
  });

  r.get('/assignments/:id', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const id = paramUuid(c, 'id', 'Scan not found');
    const familyId = await currentFamilyId(c);
    const data = await deps.db.asParent(parent, async (tx) => {
      const [assignment] = await tx<AssignmentRow[]>`
        select ${tx(ASSIGNMENT_COLUMNS)} from public.assignments
         where id = ${id} and family_id = ${familyId} and status <> 'deleted'`;
      if (!assignment) return null;
      const pages = await tx<{ id: string; page_number: number; mime_type: HomeworkMimeType }[]>`
        select id, page_number, mime_type from public.source_pages
         where assignment_id = ${id} and family_id = ${familyId} and deleted_at is null
         order by page_number`;
      const questions = await readParentQuestions(tx, familyId, id, null);
      return { assignment, pages, questions };
    });
    if (!data) throw new ApiError('NOT_FOUND', 'Scan not found');
    const response: AssignmentDetailResponse = {
      assignment: toSummary(data.assignment),
      pages: data.pages.map((p) => ({
        id: p.id,
        pageNumber: p.page_number,
        mimeType: p.mime_type,
      })),
      questions: data.questions.map(toParentQuestion),
    };
    return c.json(response);
  });

  // Complete solutions: parent + server-verified recent step-up (AC_GRADING_05).
  r.get('/assignments/:id/solutions', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const id = paramUuid(c, 'id', 'Scan not found');
    const familyId = await currentFamilyId(c);
    const [visible] = await deps.db.asParent(
      parent,
      (tx) => tx<{ id: string }[]>`
        select id from public.assignments
         where id = ${id} and family_id = ${familyId} and status <> 'deleted'`,
    );
    if (!visible) throw new ApiError('NOT_FOUND', 'Scan not found');
    await assertRecentUnlock(c);
    const rows = await deps.db
      .asParent(
        parent,
        (tx) => tx<
          {
            question_id: string;
            question_number: string;
            correct_answer: string;
            worked_solution: string;
            rubric: unknown;
            misconception: string | null;
          }[]
        >`
          select question_id, question_number, correct_answer, worked_solution, rubric, misconception
            from public.parent_assignment_solutions(${id})`,
      )
      .catch((error: unknown) => {
        const code = pgErrorCode(error);
        if (code === 'P0002') throw new ApiError('NOT_FOUND', 'Scan not found');
        if (code === '42501') {
          throw new ApiError('STEP_UP_REQUIRED', 'Enter your parent PIN to see solutions');
        }
        throw error;
      });
    const response: AssignmentSolutionsResponse = {
      assignmentId: id,
      solutions: rows.map((row) => ({
        questionId: row.question_id,
        questionNumber: row.question_number,
        correctAnswer: row.correct_answer,
        workedSolution: row.worked_solution,
        rubric: (row.rubric ?? null) as AssignmentSolutionsResponse['solutions'][number]['rubric'],
        misconception: row.misconception,
      })),
    };
    return c.json(response);
  });

  // Parent override with audit (migration RPC) + learning-evidence correction (AC_GRADING_10).
  r.post('/questions/:id/override', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const questionId = paramUuid(c, 'id', 'Question not found');
    const familyId = await currentFamilyId(c);
    const body = await readJson(c, overrideResultRequestSchema);
    await assertRecentUnlock(c);
    const [row] = await deps.db
      .asParent(
        parent,
        (tx) => tx<
          {
            family_id: string;
            verdict: GradedVerdict;
            route: ParentQuestionResult['route'];
            disagreement: boolean;
            graded_at: Date;
            parent_override_verdict: 'correct' | 'incorrect' | 'unresolved';
            override_reason: string | null;
            overridden_at: Date;
          }[]
        >`
          select family_id, verdict, route, disagreement, graded_at, parent_override_verdict,
                 override_reason, overridden_at
            from public.parent_override_result(${questionId}, ${body.verdict}, ${body.reason})`,
      )
      .catch((error: unknown) => {
        const code = pgErrorCode(error);
        if (code === 'P0002') throw new ApiError('NOT_FOUND', 'No result to override');
        if (code === '42501') throw new ApiError('STEP_UP_REQUIRED', 'Enter your parent PIN');
        if (code === '22023') throw new ApiError('VALIDATION_FAILED', 'Invalid request: reason');
        throw error;
      });
    if (!row || row.family_id !== familyId)
      throw new ApiError('NOT_FOUND', 'No result to override');
    const caller: Caller = { kind: 'parent', parent, familyId };
    await deps.db.asService(async (tx) => {
      // Decision: the override corrects the evidence of the latest homework attempt on this question
      // (append-only attempt_overrides). Points are never touched here, so an override cannot claw
      // back rewards the child already earned.
      await tx`
        insert into public.attempt_overrides (attempt_id, family_id, correctness, reason, overridden_by)
        select a.id, a.family_id, ${body.verdict}, ${body.reason}, ${parent.userId}
          from public.attempts a
         where a.question_instance_id = ${questionId} and a.family_id = ${familyId}
           and a.source = 'homework'
         order by a.attempt_number desc
         limit 1`;
      await settleParentReview(tx, caller, questionId);
    });
    const response: OverrideResultResponse = {
      questionId,
      result: {
        verdict: row.parent_override_verdict,
        gradedVerdict: row.verdict,
        route: row.route,
        disagreement: row.disagreement,
        gradedAt: row.graded_at.toISOString(),
        override: {
          verdict: row.parent_override_verdict,
          reason: row.override_reason,
          at: row.overridden_at.toISOString(),
        },
      },
    };
    return c.json(response);
  });

  // Transcription correction: originals kept, correction recorded, re-check queued (spec P5).
  r.post('/questions/:id/correction', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const questionId = paramUuid(c, 'id', 'Question not found');
    const familyId = await currentFamilyId(c);
    const body = await readJson(c, correctTranscriptionRequestSchema);
    await enforceRateLimit(
      deps.rateLimiter,
      `homework-correction:${familyId}`,
      CORRECTION_RULE,
      deps.clock(),
    );
    const caller: Caller = { kind: 'parent', parent, familyId };
    const outcome = await deps.db
      .asService(async (tx) => {
        // Service role: ownership is checked explicitly against the caller's family.
        const [question] = await tx<{ assignment_id: string }[]>`
          select assignment_id from public.extracted_questions
           where id = ${questionId} and family_id = ${familyId}`;
        if (!question) throw new ApiError('NOT_FOUND', 'Question not found');
        const assignment = await lockAssignment(tx, caller, question.assignment_id);
        if (!assignment) throw new ApiError('NOT_FOUND', 'Question not found');
        if (!CORRECTABLE_ASSIGNMENT_STATUSES.includes(assignment.status)) {
          throw businessRule(
            'INVALID_TRANSITION',
            'This scan is still being checked. Try again when it is ready.',
          );
        }
        // A correction queues a paid AI recheck of child data, so it needs the same gate as a new
        // scan: verified consent and a child who holds a paid slot. History of an archived or
        // downgraded child stays readable but is not re-graded (AC_CAPACITY_08, spec P11).
        await assertCanCollect(c, tx, caller, assignment.child_id);
        const hasPrompt = body.promptText !== undefined;
        const hasAnswer = body.studentAnswerText !== undefined;
        await tx`
          update public.extracted_questions
             set corrected_prompt_text = case when ${hasPrompt}::boolean then ${body.promptText ?? null} else corrected_prompt_text end,
                 corrected_student_answer_text = case when ${hasAnswer}::boolean then ${body.studentAnswerText ?? null} else corrected_student_answer_text end,
                 corrected_by = ${parent.userId},
                 corrected_at = now(),
                 transcription_version = transcription_version + 1
           where id = ${questionId} and family_id = ${familyId}`;
        const [updated] = await tx<AssignmentRow[]>`
          update public.assignments set status = 'checking'
           where id = ${assignment.id} and family_id = ${familyId}
          returning ${tx(ASSIGNMENT_COLUMNS)}`;
        // Highest kept version + 1, never a count (job retention, BUG-139; see the scan route).
        const [jobs] = await tx<{ n: number }[]>`
          select coalesce(max(substring(idempotency_key from ':v([0-9]+)$')::int), 0) as n
            from public.jobs
           where family_id = ${familyId} and idempotency_key like ${`scan:${assignment.id}:v%`}`;
        await tx`
          insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, run_after)
          values ('scan_process', ${`scan:${assignment.id}:v${(jobs?.n ?? 0) + 1}`}, ${familyId},
                  ${assignment.child_id},
                  ${tx.json({ assignmentId: assignment.id, mode: 'recheck', questionIds: [questionId] })},
                  ${deps.clock()})`;
        await audit(tx, caller, 'homework.transcription_corrected', 'question', questionId);
        const [row] = await readParentQuestions(tx, familyId, assignment.id, questionId);
        return { assignment: updated!, question: row! };
      })
      .catch((error: unknown) => mapDbError(error, caller));
    const response: CorrectTranscriptionResponse = {
      assignment: toState(outcome.assignment),
      question: toParentQuestion(outcome.question),
    };
    return c.json(response);
  });

  // -------------------------------------------------------------------------------------------
  // Child views (pl_child role, allowlisted columns; lesson L-003)
  // -------------------------------------------------------------------------------------------

  r.get('/child/assignments', requireChild, async (c) => {
    const { deps, child } = c.var;
    const rows = await deps.db.asChild(
      child,
      (tx) => tx<ChildAssignmentRow[]>`
        select id, subject_id, status, page_count, created_at, updated_at from public.assignments
         where child_id = ${child.childId}
         order by created_at desc
         limit ${CHILD_LIST_LIMIT}`,
    );
    const response: ChildAssignmentListResponse = { assignments: rows.map(toChildSummary) };
    return c.json(response);
  });

  r.get('/child/assignments/:id', requireChild, async (c) => {
    const { deps, child } = c.var;
    const id = paramUuid(c, 'id', 'We couldn’t find that scan.');
    const data = await deps.db.asChild(child, async (tx) => {
      const [assignment] = await tx<ChildAssignmentRow[]>`
        select id, subject_id, status, page_count, created_at, updated_at from public.assignments
         where id = ${id} and child_id = ${child.childId}`;
      if (!assignment) return null;
      const questions = await tx<
        {
          id: string;
          question_number: string;
          prompt_text: string;
          student_answer_text: string | null;
          verdict: GradedVerdict | null;
        }[]
      >`
        select q.id, q.question_number, q.prompt_text, q.student_answer_text, r.verdict
          from public.extracted_questions q
          left join public.question_results r on r.question_id = q.id
         where q.assignment_id = ${id} and q.child_id = ${child.childId}
         order by length(q.question_number), q.question_number`;
      const ids = questions.map((q) => q.id);
      const feedback =
        ids.length === 0
          ? []
          : await tx<
              {
                id: string;
                question_id: string;
                kind: ChildAssignmentDetailResponse['questions'][number]['feedback'][number]['kind'];
                body: string;
                created_at: Date;
              }[]
            >`
              select id, question_id, kind, body, created_at from public.child_feedback
               where child_id = ${child.childId} and question_id = any(${ids}::uuid[])
               order by created_at`;
      return { assignment, questions, feedback };
    });
    if (!data) throw new ApiError('NOT_FOUND', 'We couldn’t find that scan.');
    // Decision: pl_child has no column grant for parent overrides or corrected transcriptions, so
    // this one narrowly scoped service read applies them (the child must not be told "Try again"
    // after a grown-up confirmed the answer). Only these columns are read, scoped to the child's
    // own questions; see schemaRequests for the grant that would move it under pl_child. The
    // correction time keeps coaching to the current transcription: a hint written for the answer
    // as first read is not shown after a grown-up corrected it. The override time does the same
    // for the verdict: coaching written for the machine verdict is not shown next to a grown-up's
    // verdict. A safety notice is different (spec P4; RV-child-safety-5 and 7): the scan job files
    // it before grading, so the child sees it as soon as it exists, whatever the scan's status
    // (still being checked, waiting for a retry, failed for good), and a later correction or
    // override never hides it (a severe screen always wins; LJA-F10). Only the latest notice is
    // shown: the recheck of a corrected answer files a copy of it. Once a reviewer cleared every
    // flag on the question as a false match (runbook 5.1; round 3, CHK2-CS-5), no notice is shown:
    // the question is re-checked and graded like the others.
    const corrections =
      data.questions.length === 0
        ? []
        : await deps.db.asService(
            (tx) => tx<
              {
                id: string;
                corrected_prompt_text: string | null;
                corrected_student_answer_text: string | null;
                corrected_at: Date | null;
                parent_override_verdict: GradedVerdict | null;
                overridden_at: Date | null;
                safety_cleared: boolean;
              }[]
            >`
              select q.id, q.corrected_prompt_text, q.corrected_student_answer_text, q.corrected_at,
                     r.parent_override_verdict, r.overridden_at,
                     exists (select 1 from public.safety_reports s
                              where s.question_id = q.id and s.family_id = q.family_id
                                and s.reporter_kind = 'system')
                     and not exists (select 1 from public.safety_reports s
                                      where s.question_id = q.id and s.family_id = q.family_id
                                        and s.reporter_kind = 'system'
                                        and s.resolution is distinct from 'false_match') as safety_cleared
                from public.extracted_questions q
                left join public.question_results r on r.question_id = q.id
               where q.assignment_id = ${id} and q.child_id = ${child.childId}
                 and q.family_id = ${child.familyId}`,
          );
    const byId = new Map(corrections.map((row) => [row.id, row]));
    const showResults = RESULT_VISIBLE_STATUSES.includes(data.assignment.status);
    const response: ChildAssignmentDetailResponse = {
      assignment: toChildSummary(data.assignment),
      questions: data.questions.map((q) => {
        const fix = byId.get(q.id);
        const answerText =
          fix?.corrected_student_answer_text !== undefined &&
          fix.corrected_student_answer_text !== null
            ? fix.corrected_student_answer_text
            : q.student_answer_text;
        const overriddenAt = fix?.parent_override_verdict ? fix.overridden_at : null;
        const own = data.feedback.filter((f) => f.question_id === q.id);
        const notice = fix?.safety_cleared
          ? undefined
          : own.filter((f) => f.kind === 'safety').at(-1);
        return {
          id: q.id,
          questionNumber: q.question_number,
          promptText: withholdStatedAnswers(fix?.corrected_prompt_text ?? q.prompt_text),
          studentAnswerText:
            answerText === null ? null : withholdStatedAnswers(answerText, { bracketedOnly: true }),
          verdict: showResults ? (fix?.parent_override_verdict ?? q.verdict) : null,
          feedback: own
            .filter(
              (f) =>
                f === notice ||
                (showResults &&
                  f.kind !== 'safety' &&
                  (!fix?.corrected_at || f.created_at >= fix.corrected_at) &&
                  (!overriddenAt || f.created_at >= overriddenAt)),
            )
            .map((f) => ({ id: f.id, kind: f.kind, body: f.body })),
        };
      }),
    };
    return c.json(response);
  });

  return r;
}

// Whitespace runs are bounded ([ \t]{0,3}) so the patterns stay linear on long transcriptions.
const QUALIFIER = String.raw`(?:(?:correct|right|final)[ \t]{1,3})?`;
/** ":", "=", "→", or a dash between spaces. */
const SYMBOL_SEPARATOR = String.raw`[ \t]{0,3}(?:[:=→]|[-–—](?=[ \t]))[ \t]{0,3}`;
/**
 * "answer", "answers", "answer key" or "ans" (optionally "correct"/"right"/"final") followed by a
 * symbol, "is" or "are"; "solution(s)" only with a symbol, because "A solution is a mixture ..." is
 * a science prompt, while "Solution: x = 3" states one.
 */
const ANSWER_LABEL = String.raw`(?:${QUALIFIER}(?:answers?(?:[ \t]{1,3}key)?|ans)(?:${SYMBOL_SEPARATOR}|[ \t]{1,3}(?:is|are)\b[ \t]{0,3})|${QUALIFIER}solutions?${SYMBOL_SEPARATOR})`;
const VALUE_END = String.raw`[ \t]{0,3}(?:[)\]};\n]|[.!?](?:\s|$)|$)`;
/** A labelled value, up to a closing bracket, a line or sentence end, or the end of the text. */
const STATED_ANSWER = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?<!\b(?:your|my)\s)(${ANSWER_LABEL})([^\n()\[\]{};]{1,80}?)(?=${VALUE_END})`,
  'giu',
);
/** The same, only inside brackets: "(answer: 84)", "[correct answer = 84]". */
const BRACKETED_ANSWER = new RegExp(
  String.raw`([(\[][ \t]{0,3}${ANSWER_LABEL})([^\n()\[\]]{1,80}?)(?=[ \t]{0,3}[)\]])`,
  'giu',
);

/**
 * Transcriptions are model output, and a worksheet photo can carry prompt-injection text that makes
 * the extraction model write the answer in ("What is 12 × 7? (answer: 84)"). Before a child sees a
 * transcription, a value labelled as the answer is replaced by a blank (spec P6 "never the withheld
 * solution or answer key"; LJA-F7). It needs no key, so it also covers a scan still being checked.
 * A blank answer line ("Answer: ____"), a question after the label and "your answer:" stay as
 * printed. In the child's own answer only a bracketed label counts, so their own words ("The answer
 * is 7 because ...") are shown as written.
 *
 * A partial mitigation, not a fix (LJA-F7 residual, round-2 decision): an answer the model adds
 * without an answer label ("What is 12 × 7? (84)", "= 84", "Key: 84") is shown, and a printed
 * prompt that labels a value it asks about ("Tom says the answer is 12. Is he right?") loses that
 * value. No check against the private key is used: the extraction model is the only reading of the
 * page (grading and verification see its text, not the photo), so text it added cannot be told from
 * printed text; printed prompts legitimately carry the key (comparisons, option lists, "circle the
 * correct spelling"); and blanking only the span that matches the key would mark the right option.
 */
export function withholdStatedAnswers(
  text: string,
  options: { readonly bracketedOnly?: boolean } = {},
): string {
  const pattern = options.bracketedOnly ? BRACKETED_ANSWER : STATED_ANSWER;
  return text.replace(
    pattern,
    (match: string, label: string, value: string, offset: number, whole: string) => {
      if (!/[\p{L}\p{N}]/u.test(value)) return match; // a blank answer line
      if (
        whole
          .slice(offset + match.length)
          .trimStart()
          .startsWith('?')
      )
        return match; // a question
      return `${label}___`;
    },
  );
}

interface ChildAssignmentRow {
  id: string;
  subject_id: string | null;
  status: AssignmentStatus;
  page_count: number;
  created_at: Date;
  updated_at: Date;
}

function toChildSummary(row: ChildAssignmentRow): ChildAssignmentSummary {
  return {
    id: row.id,
    subjectId: row.subject_id,
    status: row.status,
    pageCount: row.page_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
