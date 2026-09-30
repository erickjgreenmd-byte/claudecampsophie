import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Link } from 'react-router';
import { z } from 'zod';
import {
  CANCELLABLE_ASSIGNMENT_STATUSES,
  CORRECTABLE_ASSIGNMENT_STATUSES,
  DEFAULT_HOMEWORK_UPLOAD_LIMITS,
  FINALIZED_ASSIGNMENT_STATUSES,
  HOMEWORK_IMAGE_LIMITS,
  HOMEWORK_READABLE_MIME_TYPES,
  HOMEWORK_SCAN_MAX_TOTAL_BYTES,
  OVERRIDE_REASON_MAX_LENGTH,
  TRANSCRIPTION_TEXT_MAX_LENGTH,
  assignmentDetailResponseSchema,
  assignmentListResponseSchema,
  assignmentSolutionsResponseSchema,
  assignmentStateResponseSchema,
  correctTranscriptionResponseSchema,
  homeworkImageSizeProblem,
  homeworkRubricSchema,
  ARCHIVED_CHILD_NO_CORRECTION_COPY,
  ARCHIVED_CHILD_NO_NEW_SCAN_COPY,
  ARCHIVED_CHILD_SCAN_COPY,
  CONSENT_WITHDRAWN_SCAN_COPY,
  INACTIVE_CHILD_NO_CORRECTION_COPY,
  INACTIVE_CHILD_NO_NEW_SCAN_COPY,
  INACTIVE_CHILD_SCAN_COPY,
  NO_CORRECTION_WITHOUT_ACTIVE_PROFILE_COPY,
  NO_NEW_SCAN_WITHOUT_ACTIVE_PROFILE_COPY,
  PROVIDER_UNAVAILABLE_SCAN_COPY,
  PROVIDER_UNAVAILABLE_SCAN_OUTCOME,
  homeworkScanFits,
  overrideResultResponseSchema,
  uploadLimitsResponseSchema,
  uploadPagesResponseSchema,
  type AssignmentState,
  type AssignmentStatus,
  type AssignmentSummary,
  type GradedVerdict,
  type HomeworkMimeType,
  type HomeworkUploadLimits,
  type OverrideVerdict,
  type PageAllowance,
  type ParentQuestion,
  type QuestionSolution,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { EmptyState, ErrorState, Loading } from '../../components/states.tsx';
import { StepUpPrompt } from '../../components/StepUpPrompt.tsx';
import { downscaleForUpload } from '../../lib/image-downscale.ts';
import { RequireParent, useApiQuery, useSession } from '../../lib/session.tsx';
import { childPickerSuffix } from './ChildrenPage.tsx';

/**
 * Parent homework (spec P5 "Parent selects child", P6, P14 "scan uploader / assignment review /
 * solutions"; AC_UX_02, AC_GRADING_03, AC_GRADING_05, AC_GRADING_10). Parents can scan homework for
 * the selected child by uploading page photos (PDF and HEIC are shown as not available yet: the scan
 * job cannot read them until the file converter ships), see every processing state explained
 * honestly, the child's answers and verdicts, and — only after a server-verified PIN step-up —
 * solutions, including rubric feedback for written work.
 */
export default function HomeworkPage() {
  return (
    <RequireParent>
      <HomeworkManager />
    </RequireParent>
  );
}

// Only the fields this page needs from GET /v1/family (owned by the family vertical); unknown keys
// are ignored rather than rendered.
//
// HUNT5-F-2: `deletionPending` is one of the fields this page needs. z.object strips what it does not
// name, so leaving it out silently emptied childPickerSuffix's first branch and the notice below: a
// child whose data deletion is under way was labelled "(archived — history only)" while the purge
// deletes that history, and the list GET — which answers NOT_FOUND for such a child — showed only
// "Child not found" with a Try again, for a child this page's own picker names.
const familyChildrenSchema = z.object({
  children: z.array(
    z.object({
      id: z.uuid(),
      nickname: z.string(),
      status: z.string(),
      deletionPending: z.boolean().optional(),
    }),
  ),
});
type FamilyChild = z.infer<typeof familyChildrenSchema>['children'][number];

// ---------------------------------------------------------------------------------------------
// Copy (text + symbol; never colour alone)
// ---------------------------------------------------------------------------------------------

const STATUS_COPY: Record<AssignmentStatus, { label: string; explain: (name: string) => string }> =
  {
    draft: { label: 'Started', explain: () => 'Pages have not been added yet.' },
    uploading: {
      label: 'Uploading',
      // RV-homework-7: only what the product supports. An interrupted upload can be finished from
      // the scan screen that sent it while that screen is still open; otherwise cancel and rescan.
      explain: () =>
        'Pages are still being sent. If sending stopped, “Try again” on the scan screen that sent them finishes it while that screen is still open; otherwise cancel this scan and start a new one.',
    },
    queued: { label: 'Waiting', explain: () => 'Waiting to be read.' },
    extracting: { label: 'Reading', explain: () => 'Reading the pages.' },
    checking: { label: 'Checking', explain: () => 'Checking answers.' },
    verifying: { label: 'Double-checking', explain: () => 'Double-checking the results.' },
    ready: { label: 'Ready', explain: () => 'Results are ready.' },
    needs_rescan: {
      label: 'Needs a new scan',
      explain: (name) =>
        `Some pages were hard to read (blur, glare, rotation or cut-off edges). PencilLift will not guess — ask ${name} to scan again with a clearer picture.`,
    },
    needs_parent_review: {
      label: 'Needs your review',
      explain: (name) =>
        `Some answers need your review before ${name} sees a final result. Open the scan to check them.`,
    },
    failed_retryable: {
      label: 'Delayed',
      explain: () =>
        'Processing hit a temporary problem and will be retried automatically. Nothing you need to do yet.',
    },
    failed_final: {
      label: 'Could not finish',
      explain: () =>
        'This scan could not be processed after several tries. Please start a new scan with clear photos.',
    },
    cancelled: {
      label: 'Cancelled',
      explain: () =>
        'Cancelled. Its page photos are deleted — right away, or within 30 days of upload if storage was briefly unreachable.',
    },
    deleted: { label: 'Deleted', explain: () => 'Deleted.' },
  };

/**
 * Error codes whose meaning is more specific than the generic copy of their state. Each line says
 * what the parent can do next; the code itself is never shown, and a code with no line here falls
 * back to the state's own copy (JOBS-R2-02, JOBS-R2-06).
 */
/**
 * Shared by SCAN_TOO_MANY_QUESTIONS and STAGE_LIMIT, which are one outcome with two codes: the stage
 * cap refused the request, before it was sent (STAGE_LIMIT) or after the answer was cut off
 * (SCAN_TOO_MANY_QUESTIONS). Splitting the worksheet is the remedy for both (HUNT7-I-3).
 */
const TOO_MANY_QUESTIONS_COPY =
  'This worksheet has more questions than one check can handle, so its pages were given back. Split it into two scans with fewer pages each.';

const FAILED_FINAL_COPY: Readonly<Record<string, string>> = {
  FORMAT_NEEDS_CONVERSION:
    'PencilLift can’t read PDF or HEIC files yet, so this scan was not checked and its pages were given back. Scan the pages again as JPEG or PNG photos.',
  SCAN_TOO_MANY_QUESTIONS: TOO_MANY_QUESTIONS_COPY,
  AI_PAUSED_TOO_LONG:
    'PencilLift could not check this scan in time and its pages were given back. Send the pages again.',
  // CS-R4-03: a scan the family's own consent withdrawal stopped. The generic line is untrue twice
  // over (the photos were fine, and the scan was stopped rather than failing) and its advice cannot
  // work — a new upload re-checks consent and is refused. The wording lives in the contract so the
  // portal and the app say the same thing.
  CONSENT_REQUIRED: CONSENT_WITHDRAWN_SCAN_COPY,
  // HUNT5-F-5: the two other permanent codes the scan job records — an archive (reachable in one
  // click from this portal's Children page, WEB-R2-03) and a profile that lost its paid slot to a
  // store downgrade. The generic line blamed the photos and asked for a rescan the API refuses with
  // CHILD_NOT_ACTIVE, and on an archived child it contradicted the "Scanning paused" notice above
  // this list. Wording in the contract, beside the consent line, for the same reason.
  CHILD_ARCHIVED: ARCHIVED_CHILD_SCAN_COPY,
  CHILD_NOT_ACTIVE: INACTIVE_CHILD_SCAN_COPY,
  // HUNT7-I-3: the pre-flight admission refusal. `runStage` refuses attempt 1 outright with
  // STAGE_LIMIT and ZERO provider calls when the request is too large for the stage's cap
  // (packages/ai/src/run.ts, priced in packages/ai/src/routing.ts), which scan-process.ts converts
  // to a PermanentFailure. The pages were never read, "several tries" never happened, and the one
  // thing that works is the SCAN_TOO_MANY_QUESTIONS remedy — the same sentence, deliberately shared,
  // because routing.ts's own comment records a bare STAGE_LIMIT as the case with no copy of its own.
  STAGE_LIMIT: TOO_MANY_QUESTIONS_COPY,
  // HUNT7-I-3: the three operator-side refusals. See PROVIDER_UNAVAILABLE_SCAN_COPY
  // (packages/contracts/src/privacy.ts) for where each is thrown and why no parent action helps.
  AI_NOT_AVAILABLE: PROVIDER_UNAVAILABLE_SCAN_COPY,
  MODERATION_NOT_AVAILABLE: PROVIDER_UNAVAILABLE_SCAN_COPY,
  UNKNOWN_MODEL: PROVIDER_UNAVAILABLE_SCAN_COPY,
};

/**
 * HUNT6-H-2: the outcomes whose advice is "get a new scan", with the advice taken off. Keyed by the
 * assignment status, or by the permanent error code where the code is what decides the advice. A
 * non-active profile keeps the outcome sentence and gets a blocker line instead of the advice.
 *
 * G-H2: `failed_final` is in here BY STATE, and that is what closes the hole. The round-6 fix keyed
 * the replacement on five keys, and a `failed_final` row is looked up by its CODE — so every code
 * with no line of its own fell through to `STATUS_COPY.failed_final.explain` and its "Please start a
 * new scan with clear photos.", printed under this page's own "new scans are not taken" notice. Those
 * codes are the ordinary ones: PROCESSING_ERROR is the catch-all for any error that is neither
 * PermanentFailure nor RetryableFailure, PROCESSING_TIMEOUT is what a lost lock records, and
 * AI_NOT_AVAILABLE, NO_PAGES, SCAN_TOO_LARGE, STAGE_LIMIT, UNKNOWN_MODEL, the per-stage
 * *_REQUEST_REJECTED and *_OUTPUT_TRUNCATED codes, the fail-closed moderation codes and any retryable
 * code that runs out of attempts all reach it too (apps/api/src/jobs/scan-process.ts), as does a row
 * that recorded no code at all. The state's own line is the answer for all of them, so no future code
 * has to be added here to stay covered.
 *
 * HUNT7-I-1 / HUNT7-E-2: each entry has TWO parts, because the round-6 trim took the whole second
 * half of the line — the requirement as well as the instruction. `outcome` is what happened, with the
 * "scan again" imperative gone; `then` is the same outcome's own requirement, kept, and moved behind
 * the profile step so it reads as what becomes possible once that step is done rather than as
 * something to do now. `failed_final` and `uploading` have no `then`: neither names a requirement of
 * the pages, so there is nothing to defer.
 */
/** The one outcome SCAN_TOO_MANY_QUESTIONS and STAGE_LIMIT share, trimmed (HUNT7-I-1, HUNT7-I-3). */
const TOO_MANY_QUESTIONS_OUTCOME = {
  outcome:
    'This worksheet has more questions than one check can handle, so its pages were given back.',
  then: 'Once the profile is active, this worksheet can be checked as two scans with fewer pages each.',
} as const;

const OUTCOME_WITHOUT_NEW_SCAN_ADVICE: Readonly<
  Record<string, { readonly outcome: string; readonly then?: string }>
> = {
  needs_rescan: {
    outcome:
      'Some pages were hard to read (blur, glare, rotation or cut-off edges), and PencilLift will not guess.',
    then: 'Once the profile is active, PencilLift can check these pages from a clearer photo.',
  },
  uploading: {
    outcome: 'Pages are still being sent. If sending stopped, it can’t be finished from here.',
  },
  failed_final: { outcome: 'This scan could not be processed after several tries.' },
  FORMAT_NEEDS_CONVERSION: {
    outcome:
      'PencilLift can’t read PDF or HEIC files yet, so this scan was not checked and its pages were given back.',
    then: 'Once the profile is active, PencilLift can check these pages as JPEG or PNG photos.',
  },
  SCAN_TOO_MANY_QUESTIONS: TOO_MANY_QUESTIONS_OUTCOME,
  // HUNT7-I-3: STAGE_LIMIT is the SAME outcome as SCAN_TOO_MANY_QUESTIONS and belongs in BOTH tables
  // with it. Giving it the split-the-worksheet line in FAILED_FINAL_COPY alone would have handed a
  // non-active child's parent that imperative through path 2, which is the very advice HUNT6-H-2
  // removed — one outcome, two codes, one entry each side.
  STAGE_LIMIT: TOO_MANY_QUESTIONS_OUTCOME,
  AI_PAUSED_TOO_LONG: {
    outcome: 'PencilLift could not check this scan in time and its pages were given back.',
    then: 'Once the profile is active, these pages can go for checking again.',
  },
  /*
    HUNT7-I-3 (repair): the three operator-side codes belong in BOTH tables too, for the opposite
    reason to STAGE_LIMIT's. Their line asks for nothing, so it was left out of this table — but what
    it DOES do is explain why every scan stops, and for a child who cannot scan at all that explanation
    is wrong and the page contradicts itself: the row said "Sending these pages again would stop the
    same way until that is fixed. There is nothing for you to change" under this page's own "Riley's
    profile is archived, so new scans are not taken … Activate Riley again on the Children page to scan
    homework". That child's scans stop at `assertCanCollect` before any provider is reached and go on
    stopping after the outage is fixed. The OUTCOME — the pages came back, the photos were fine, it
    stopped on PencilLift's side — is true for them, so it is what survives, and the profile's own
    blocker follows it. No `then`: nothing about these pages is a requirement to defer.
  */
  AI_NOT_AVAILABLE: { outcome: PROVIDER_UNAVAILABLE_SCAN_OUTCOME },
  MODERATION_NOT_AVAILABLE: { outcome: PROVIDER_UNAVAILABLE_SCAN_OUTCOME },
  UNKNOWN_MODEL: { outcome: PROVIDER_UNAVAILABLE_SCAN_OUTCOME },
};

/**
 * The ONE reading of the profile status that every region of this page blocks on, so that no two of
 * them can key the same profile differently (HUNT7-I-6). `null` is "this child can scan"; everything
 * else is a reason they cannot, and the three reasons are the three the copy tables below are written
 * for.
 *
 * The test is `=== 'active'`, not `!== 'archived'`: POST /v1/assignments and
 * POST /v1/questions/:id/correction both reach `readPaidProfile`, whose `entitled` requires
 * `status = 'active'` plus an unreleased paid slot (apps/api/src/routes/homework.ts), so a status this
 * page has never heard of is refused exactly like the two it knows — and must not be DESCRIBED as
 * either of them. That fall-through is what was missing: the uploader treated every non-active status
 * as a missing paid slot while the rows printed a blocker only for 'archived' and 'draft', so a value
 * outside the pair got a reason in one region and none in the other.
 */
type ScanBlocker = 'archived' | 'no-paid-slot' | 'not-active';

function scanBlocker(childStatus?: string): ScanBlocker | null {
  if (childStatus === 'active') return null;
  if (childStatus === 'archived') return 'archived';
  if (childStatus === 'draft') return 'no-paid-slot';
  return 'not-active';
}

/** The row-level line for each blocker, shared with the app through the contract package. */
const NO_NEW_SCAN_COPY: Readonly<Record<ScanBlocker, string>> = {
  archived: ARCHIVED_CHILD_NO_NEW_SCAN_COPY,
  'no-paid-slot': INACTIVE_CHILD_NO_NEW_SCAN_COPY,
  'not-active': NO_NEW_SCAN_WITHOUT_ACTIVE_PROFILE_COPY,
};

/** The correction panel's line for each blocker, keyed by the same value. */
const NO_CORRECTION_COPY: Readonly<Record<ScanBlocker, string>> = {
  archived: ARCHIVED_CHILD_NO_CORRECTION_COPY,
  'no-paid-slot': INACTIVE_CHILD_NO_CORRECTION_COPY,
  'not-active': NO_CORRECTION_WITHOUT_ACTIVE_PROFILE_COPY,
};

/**
 * HUNT6-H-2: `childStatus` is the profile's status from GET /v1/family. HUNT5-F-5 added the two
 * permanent codes the archive itself records to FAILED_FINAL_COPY, but that table is consulted only
 * for `failed_final`, so every other outcome on this page still told the parent to get a new scan for
 * a child whose profile makes one impossible — `readPaidProfile` requires status 'active'
 * (apps/api/src/routes/homework.ts), this page offers no uploader for an archived child, and archiving
 * signs the child's devices out. The rows are listed all the same (GET /v1/assignments drops only a
 * child under an open deletion), so the advice sat directly under this page's own "new scans are not
 * taken" notice.
 *
 * 'archived' and 'draft' each name their own blocker, because those are the two non-active values the
 * family contract has today (packages/contracts/src/family.ts); anything else gets the fall-through,
 * which asserts neither reason.
 *
 * G-H2: the lookup is by code AND THEN by state, which is the whole point. Keying it on the code alone
 * meant a code in neither table — PROCESSING_ERROR and the rest, see the table above — walked past
 * both and printed the state's generic "Please start a new scan with clear photos." The state-level
 * entry answers every such row, so the advice cannot come back through a code nobody listed.
 */
function noNewScanCopy(childStatus?: string): string | null {
  const blocker = scanBlocker(childStatus);
  return blocker === null ? null : NO_NEW_SCAN_COPY[blocker];
}

/**
 * G-LABEL: the state's own label, and the one state whose label is an imperative the profile can
 * refuse. `needs_rescan` prints "Needs a new scan" in the row header and as the detail panel's
 * prefix, so once HUNT6-H-2 replaced the EXPLANATION's rescan advice for a non-active child, the
 * panel read "Needs a new scan: … A new scan can’t help while this child’s profile is archived" —
 * the label asking for exactly what the sentence beside it says cannot happen, and what POST
 * /v1/assignments refuses (`readPaidProfile` requires `status = 'active'`) for a child whose devices
 * are signed out. For those profiles the label names the outcome instead and asks for nothing; the
 * explanation still says what happened and why no scan can help. Every other label is a description
 * already ("Delayed", "Could not finish"), and an ACTIVE child keeps this one, because for them a new
 * scan is the next step.
 */
/**
 * HUNT7-I-2: why "Fix transcription" is not offered, and it is a TRUE sentence for every reason it can
 * be missing. The control has two independent blockers and the panel used to name only one of them:
 * the assignment status, so a finished scan of an archived or slotless child offered the button and
 * the save was refused by `assertCanCollect` with "Assign a paid slot to this child before scanning
 * homework" — in reply to a correction, and on a `needs_parent_review` row whose own explanation asks
 * the parent to open the scan and check the answers. Keyed the same way `noNewScanCopy` is, and the
 * final branch is the fall-through: any status this page does not recognise is non-active as far as
 * the correction route is concerned, so it gets a line that states the requirement without asserting
 * which of the two named reasons applies.
 */
function whyNotCorrectable(status: AssignmentStatus, childStatus: string): string {
  /*
    The PROFILE is tested first (the repair). With the status branch first, a non-active child whose
    scan was terminal or mid-flight read "Transcriptions can be fixed once checking has finished" — and
    GET /v1/assignments/:id calls readParentQuestions with no status filter, while questions are
    persisted at extraction, so a `checking`, `verifying` or `failed_final` row really does render
    QuestionCards. That sentence promised SUFFICIENCY the profile does not grant: finishing the check
    changes nothing for an archived or slotless child, whose blocker is the one that survives it.

    And the status sentence itself no longer promises. `CORRECTABLE_ASSIGNMENT_STATUSES` is
    ['ready', 'needs_parent_review'] and `failed_final` is in no resume set
    (packages/contracts/src/homework.ts), so for that row the check will never finish; and even a
    `checking` row may end in `needs_rescan` or `failed_final` rather than in a correctable state. So
    the line states the NECESSARY condition and stops — the shape HUNT7-G-5 settled on for the pairing
    notice — which is also true of any status this page has never heard of.
  */
  const blocker = scanBlocker(childStatus);
  if (blocker !== null) return NO_CORRECTION_COPY[blocker];
  return 'A transcription can be fixed only on a scan PencilLift has finished checking.';
}

function statusLabel(status: AssignmentStatus, childStatus?: string): string {
  if (status === 'needs_rescan' && noNewScanCopy(childStatus) !== null) return 'Couldn’t be read';
  return STATUS_COPY[status].label;
}

function explainStatus(
  assignment: { status: AssignmentStatus; errorCode: string | null },
  name: string,
  childStatus?: string,
): string {
  const blocked = noNewScanCopy(childStatus);
  const code = assignment.status === 'failed_final' ? assignment.errorCode : null;
  /**
   * HUNT7-I-1 / HUNT7-E-2: what the trimming leaves out is the IMPERATIVE, never the condition that
   * made the advice true. `outcome` says what happened, `blocked` says what stands in the way and
   * where the parent acts, and `then` restates the outcome's own requirement as what becomes possible
   * after that step — so a parent who activates the profile and re-sends the same PDF, the same
   * oversized worksheet or the same blurred photos has been told, on the screen they acted from, why
   * that will fail again. Composed in that order so nothing between the blocker and its action can be
   * read as a promise about THESE pages.
   */
  const composed = (entry: { outcome: string; then?: string }, why: string): string =>
    entry.then === undefined ? `${entry.outcome} ${why}` : `${entry.outcome} ${why} ${entry.then}`;
  // 1. A code whose own line ENDS in the advice this replaces (four of FAILED_FINAL_COPY's ten: the
  //    two format/size codes, AI_PAUSED_TOO_LONG, and STAGE_LIMIT, which shares one of them), so
  //    it is trimmed before that table can print it.
  if (blocked !== null && code !== null) {
    const trimmed = OUTCOME_WITHOUT_NEW_SCAN_ADVICE[code];
    if (trimmed !== undefined) return composed(trimmed, blocked);
  }
  // 2. A code with a line of its own and no such advice keeps it whole. CHILD_ARCHIVED and
  //    CHILD_NOT_ACTIVE already name this very profile as the blocker, and CONSENT_REQUIRED names
  //    consent, a prior blocker of its own whose remedy the parent still needs; each says what to do
  //    before scanning again rather than asking for a scan now. HUNT7-I-3's three operator-side codes
  //    reach this arm for an ACTIVE child only: their full line explains why every scan stops, which
  //    is true for a child who can scan and false for one who cannot, so for a blocked profile the
  //    entry above trims it to the outcome and path 1 appends that profile's own blocker.
  if (code !== null) {
    const copy = FAILED_FINAL_COPY[code];
    if (copy !== undefined) return copy;
  }
  // 3. Otherwise the STATE decides — including every `failed_final` code this page has no line for,
  //    which is what used to fall through to the generic advice below.
  if (blocked !== null) {
    const trimmed = OUTCOME_WITHOUT_NEW_SCAN_ADVICE[assignment.status];
    if (trimmed !== undefined) return composed(trimmed, blocked);
  }
  return STATUS_COPY[assignment.status].explain(name);
}

const VERDICT_COPY: Record<GradedVerdict, string> = {
  correct: '✓ Correct',
  incorrect: '✗ Incorrect',
  unresolved: '? Unresolved — not enough to decide',
  unanswered: '– Left blank',
  rubric: '✎ Written response — see rubric feedback',
  needs_parent_review: '! Needs your review',
};

const OVERRIDE_OPTIONS: { value: OverrideVerdict; label: string }[] = [
  { value: 'correct', label: 'Correct' },
  { value: 'incorrect', label: 'Incorrect' },
  { value: 'unresolved', label: 'Unresolved' },
];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function toApiError(error: unknown): ApiRequestError {
  return error instanceof ApiRequestError
    ? error
    : new ApiRequestError('INTERNAL', 'Something went wrong. Please try again.', 0);
}

const buttonRow = { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 } as const;
const textareaStyle = {
  width: '100%',
  maxWidth: 520,
  minHeight: 72,
  fontSize: '1rem',
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--muted)',
  fontFamily: 'inherit',
} as const;

// ---------------------------------------------------------------------------------------------
// Data that stays on screen while it refreshes
// ---------------------------------------------------------------------------------------------

type RefreshingQuery<T> =
  | { status: 'loading'; reload: () => void }
  | { status: 'error'; error: ApiRequestError; reload: () => void }
  | { status: 'ready'; data: T; refreshing: boolean; reload: () => void };

/**
 * Like useApiQuery, but a reload keeps the last loaded data on screen (RV-homework-8): a refresh
 * after an action must not unmount the action's confirmation (role=status), shown solutions or open
 * forms. The section is marked aria-busy while the reload runs. Callers key the component by what
 * the query loads, so kept data never belongs to another child or scan.
 */
function useRefreshingQuery<T>(
  load: (api: ApiClient) => Promise<T>,
  deps: readonly unknown[],
): RefreshingQuery<T> {
  const query = useApiQuery(load, deps);
  const [kept, setKept] = useState<{ data: T } | null>(null);
  // Adjusting state while rendering (React's documented pattern for derived state); guarded so it
  // settles after one extra render.
  if (query.status === 'ready' && kept?.data !== query.data) setKept({ data: query.data });
  const { reload } = query;
  if (query.status === 'error') return { status: 'error', error: query.error, reload };
  if (query.status === 'ready') {
    return { status: 'ready', data: query.data, refreshing: false, reload };
  }
  if (kept) return { status: 'ready', data: kept.data, refreshing: true, reload };
  return { status: 'loading', reload };
}

// ---------------------------------------------------------------------------------------------
// Action feedback
// ---------------------------------------------------------------------------------------------

type Feedback = { kind: 'success'; message: string } | { kind: 'error'; error: ApiRequestError };

function useAction() {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const run = useCallback(async (action: () => Promise<string>) => {
    setBusy(true);
    setFeedback(null);
    try {
      setFeedback({ kind: 'success', message: await action() });
      return true;
    } catch (error) {
      setFeedback({ kind: 'error', error: toApiError(error) });
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, feedback, run, setFeedback };
}

/**
 * WEB-R2-05: the shared inline prompt, so a step-up refusal on a scan is answered here instead of
 * sending the parent to /app/security and unmounting the panel they had open.
 */
function StepUpNotice({ what }: { what: string }) {
  return (
    <StepUpPrompt
      explanation={`${what} needs a recent PIN unlock.`}
      retryHint={() => 'Press the same button again to continue.'}
    />
  );
}

function ActionFeedback({ feedback, what }: { feedback: Feedback | null; what: string }) {
  if (!feedback) return null;
  if (feedback.kind === 'success') {
    return (
      <p role="status" style={{ color: 'var(--success)', fontWeight: 700 }}>
        {feedback.message}
      </p>
    );
  }
  if (feedback.error.code === 'STEP_UP_REQUIRED') return <StepUpNotice what={what} />;
  return <ErrorState message={feedback.error.message} />;
}

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------

function HomeworkManager() {
  const family = useApiQuery((api) => api.get('/v1/family', familyChildrenSchema), []);
  const [childId, setChildId] = useState<string | null>(null);
  const children = family.status === 'ready' ? family.data.children : [];
  const firstChild = children[0]?.id ?? null;
  useEffect(() => {
    if (childId === null && firstChild !== null) setChildId(firstChild);
  }, [childId, firstChild]);
  const selectId = useId();

  return (
    <>
      <h1>Homework</h1>
      <p>
        Scan homework here by uploading photos of the pages, or in the PencilLift app on a paired
        phone or tablet. Here you can follow each scan, review answers, fix transcriptions and —
        after your parent PIN — see solutions.
      </p>
      {family.status === 'loading' ? <Loading /> : null}
      {family.status === 'error' ? (
        <ErrorState message={family.error.message} onRetry={family.reload} />
      ) : null}
      {family.status === 'ready' && children.length === 0 ? (
        <EmptyState title="No children yet">
          <p>
            Add a child on the <Link to="/app/children">Children page</Link> to start scanning
            homework.
          </p>
        </EmptyState>
      ) : null}
      {children.length > 0 && childId !== null ? (
        <>
          <label htmlFor={selectId}>Child</label>
          <select id={selectId} value={childId} onChange={(e) => setChildId(e.target.value)}>
            {children.map((child) => (
              <option key={child.id} value={child.id}>
                {child.nickname}
                {childPickerSuffix(child)}
              </option>
            ))}
          </select>
          <ChildHomework
            key={childId}
            child={children.find((c) => c.id === childId) ?? children[0]!}
          />
        </>
      ) : null}
    </>
  );
}

/**
 * Older pages of a newest-first list (API-AUTH-R1-02). They stay attached only while the first
 * page still ends at the row they were fetched after (`from`); a refresh that moves that row (a
 * new scan arrived) drops them and offers "Show older" again, so nothing is ever skipped.
 */
interface OlderPages<T> {
  from: string;
  items: T[];
  nextCursor: string | null;
}

function ChildHomework({ child }: { child: FamilyChild }) {
  const listPath = `/v1/assignments?childId=${encodeURIComponent(child.id)}`;
  const query = useRefreshingQuery(
    (api) => api.get(listPath, assignmentListResponseSchema),
    [child.id],
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [older, setOlder] = useState<OlderPages<AssignmentSummary> | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const { api } = useSession();
  const action = useAction();
  const { reload } = query;

  const showOlder = (firstCursor: string, cursor: string) =>
    void (async () => {
      setOlderBusy(true);
      setOlderError(null);
      try {
        const page = await api.get(
          `${listPath}&after=${encodeURIComponent(cursor)}`,
          assignmentListResponseSchema,
        );
        setOlder((prev) => ({
          from: firstCursor,
          items: [...(prev?.from === firstCursor ? prev.items : []), ...page.assignments],
          nextCursor: page.nextCursor ?? null,
        }));
      } catch (error) {
        setOlderError(
          error instanceof ApiRequestError ? error.message : 'Could not load older scans.',
        );
      } finally {
        setOlderBusy(false);
      }
    })();

  const cancel = (assignment: AssignmentSummary) =>
    void action
      .run(async () => {
        await api.send(
          'POST',
          `/v1/assignments/${assignment.id}/cancel`,
          undefined,
          assignmentStateResponseSchema,
        );
        return 'Scan cancelled and its page allowance released. Its page photos are being deleted.';
      })
      .then((ok) => {
        if (ok) reload();
      });

  // G-I3-WEB / L-037: the notice names the OPEN REQUEST, not the reader. GET /v1/family computes
  // `deletionPending` from the request's scope and target and never exposes
  // deletion_requests.requested_by (apps/api/src/routes/family.ts); any guardian may delete a child's
  // data and a child-scope request leaves every other adult's membership active, so the family's
  // other adult is served the same flag and was told THEY had asked for it. Same sentence as the app
  // (apps/mobile/app/(parent)/children.tsx) and as the Children page.
  //
  // HUNT5-F-2: before the query's own states, because GET /v1/assignments answers NOT_FOUND for a
  // child whose data deletion is `requested` or `processing` (homework.ts) — so the parent read
  // "Child not found" and a Try again that can never succeed. Processing has stopped for this child,
  // so there is nothing to scan, nothing to load and no retry to offer: only what is happening and
  // where a mistake is handled. The wording matches ChildrenPage's notice for the same state.
  if (child.deletionPending === true) {
    return (
      <section className="notice" aria-label="Data deletion under way" style={{ marginTop: 16 }}>
        <p style={{ margin: 0 }}>
          <strong>Data deletion under way.</strong> A deletion request covering {child.nickname}’s
          data is open. Processing has already stopped, so no homework is checked or kept for them,
          nothing new can be scanned, and the scans already here are being deleted. You can follow
          it on the <Link to="/app/privacy">privacy page</Link>. Deletion can’t be undone from the
          app: if you did not mean it, <Link to="/app/support">contact support</Link> straight away.
        </p>
      </section>
    );
  }
  if (query.status === 'loading') return <Loading label="Loading scans…" />;
  if (query.status === 'error') {
    return <ErrorState message={query.error.message} onRetry={reload} />;
  }
  const { allowance } = query.data;
  const firstCursor = query.data.nextCursor ?? null;
  const attached = older !== null && older.from === firstCursor ? older : null;
  const nextCursor = attached ? attached.nextCursor : firstCursor;
  const seen = new Set<string>();
  const assignments = [...query.data.assignments, ...(attached?.items ?? [])].filter((a) =>
    seen.has(a.id) ? false : (seen.add(a.id), true),
  );
  return (
    <>
      {allowance ? <AllowanceCard allowance={allowance} name={child.nickname} /> : null}
      {/*
        WEBR4-10: no uploader for an archived profile. POST /v1/assignments answers CHILD_NOT_ACTIVE
        for it and no client can assign a slot to an archived child from the scan screen, so offering
        the uploader was a dead end. A draft still gets it: activating a draft is one click away on
        the Children page.
      */}
      {child.status === 'archived' ? (
        <section className="notice" aria-label="Scanning paused" style={{ marginTop: 16 }}>
          <p style={{ margin: 0 }}>
            {child.nickname}’s profile is archived, so new scans are not taken. Everything already
            scanned stays readable below.{' '}
            <Link to="/app/children">
              Activate {child.nickname} again on the Children page to scan homework
            </Link>
            .
          </p>
        </section>
      ) : (
        <ScanUploader child={child} allowance={allowance} onChanged={reload} />
      )}
      <ActionFeedback feedback={action.feedback} what="Cancelling" />
      <section
        className="card"
        aria-label="Scans"
        aria-busy={query.refreshing}
        style={{ marginTop: 16 }}
      >
        <h2>Scans for {child.nickname}</h2>
        {assignments.length === 0 ? (
          <NoScans child={child} />
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {assignments.map((a) => (
              <li key={a.id} style={{ borderTop: '1px solid #e3e8ee', padding: '12px 0' }}>
                <strong>
                  {formatDate(a.createdAt)} · {a.pageCount} {a.pageCount === 1 ? 'page' : 'pages'} ·{' '}
                  {statusLabel(a.status, child.status)}
                </strong>
                <p style={{ margin: '4px 0' }}>{explainStatus(a, child.nickname, child.status)}</p>
                <div style={buttonRow}>
                  <button
                    type="button"
                    className="btn secondary"
                    aria-label={`Open scan from ${formatDate(a.createdAt)}`}
                    aria-expanded={openId === a.id}
                    onClick={() => setOpenId(openId === a.id ? null : a.id)}
                  >
                    {openId === a.id ? 'Close' : 'Open'}
                  </button>
                  {CANCELLABLE_ASSIGNMENT_STATUSES.includes(a.status) ? (
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={action.busy}
                      aria-label={`Cancel scan from ${formatDate(a.createdAt)}`}
                      onClick={() => cancel(a)}
                    >
                      Cancel scan
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {nextCursor !== null && firstCursor !== null ? (
          <div style={buttonRow}>
            <button
              type="button"
              className="btn secondary"
              disabled={olderBusy}
              onClick={() => showOlder(firstCursor, nextCursor)}
            >
              {olderBusy ? 'Loading older scans…' : 'Show older scans'}
            </button>
          </div>
        ) : null}
        {olderError ? <p role="alert">{olderError}</p> : null}
      </section>
      {openId !== null ? (
        <AssignmentDetail
          key={openId}
          assignmentId={openId}
          childName={child.nickname}
          childStatus={child.status}
          onChanged={reload}
        />
      ) : null}
    </>
  );
}

function AllowanceCard({ allowance, name }: { allowance: PageAllowance; name: string }) {
  // RV-homework-6: no paid capacity (e.g. the subscription ended) or no paid slot for this child is
  // not "used up": nothing changes next month until the plan does.
  const noCapacity = allowance.familyPagesAllowed === 0;
  const noSlot = !noCapacity && allowance.childHasPaidSlot === false;
  const childLeft = allowance.childPagesAllowed - allowance.childPagesUsed;
  const familyLeft = allowance.familyPagesAllowed - allowance.familyPagesUsed;
  const exhausted = !noCapacity && !noSlot && (childLeft <= 0 || familyLeft <= 0);
  const pages = (n: number) => `${n} ${n === 1 ? 'page' : 'pages'}`;
  return (
    <section
      className={noCapacity || noSlot || exhausted ? 'notice' : 'card'}
      aria-label="Page allowance"
      style={{ marginTop: 16 }}
    >
      {noCapacity ? (
        <p style={{ margin: 0 }}>
          <strong>
            {name}: {pages(allowance.childPagesUsed)} scanned this month. No paid page allowance
            right now.
          </strong>{' '}
          The family plan has no paid child slots at the moment, so new scans are paused. Existing
          homework and results stay available.{' '}
          <Link to="/app/subscription">See your plan on the Subscription page</Link>.
        </p>
      ) : (
        <p style={{ margin: 0 }}>
          <strong>
            {name}: {allowance.childPagesUsed} of {allowance.childPagesAllowed} pages used this
            month
          </strong>{' '}
          (family: {allowance.familyPagesUsed} of {allowance.familyPagesAllowed}). Scans still being
          processed are counted; pages that could not be read are given back.
        </p>
      )}
      {noSlot ? (
        <p style={{ margin: '8px 0 0' }}>
          {name} doesn’t hold a paid child slot right now (for example after the plan changed to
          fewer children), so new scans for {name} are paused. Existing homework and results stay
          available. <Link to="/app/children">Manage child slots on the Children page</Link>.
        </p>
      ) : null}
      {exhausted ? (
        <p style={{ margin: '8px 0 0' }}>
          {name}’s page allowance for this month is used up, so new scans will wait until next
          month. Existing homework and results stay available. You are never charged for extra
          pages.
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Parent scan uploader (spec P5 "Parent selects child", P14 parent "scan uploader"; RV-homework-9)
// ---------------------------------------------------------------------------------------------

interface ImageSize {
  readonly width: number;
  readonly height: number;
}

interface PickedPage {
  readonly key: string;
  readonly file: File;
  /** The browser's reading of the photo's pixel size; null when it could not tell. */
  readonly measured: Promise<ImageSize | null>;
  /** `measured` once it settles (undefined while measuring). */
  readonly size?: ImageSize | null;
}

/** Idempotency keys kept across retries so a retry resumes the same scan (AC_CAPTURE_01/06). */
interface UploadAttempt {
  readonly createKey: string;
  readonly finalizeKey: string;
  readonly assignmentId: string | null;
}

type UploadPhase = 'preparing' | 'uploading' | 'finishing';

type SendState =
  | { kind: 'idle' }
  | { kind: 'running'; phase: UploadPhase; done: number; total: number }
  | { kind: 'error'; message: string }
  | { kind: 'sent' };

/** The parent pressed "Stop sending". */
class UploadStoppedError extends Error {}
/** The scan was cancelled or deleted on the server; its pages can only be sent as a new scan. */
class ScanStoppedError extends Error {}
/** A page's photo is over the picture size limits (found when its measurement finished late). */
class PictureTooBigError extends Error {}
/** R2C-WEB-1: the prepared pages together are over HOMEWORK_SCAN_MAX_TOTAL_BYTES. */
class ScanTooLargeError extends Error {}
/** A PUT to a signed storage URL failed (page number and status only; never the signed URL). */
class PageTransferError extends Error {
  readonly pageNumber: number;
  constructor(pageNumber: number) {
    super('upload failed');
    this.pageNumber = pageNumber;
  }
}

const newKey = () => crypto.randomUUID();
const newAttempt = (): UploadAttempt => ({
  createKey: newKey(),
  finalizeKey: newKey(),
  assignmentId: null,
});

const TYPE_NAMES: Record<HomeworkMimeType, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/heic': 'HEIC photos',
  'application/pdf': 'PDF study guides',
};

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function describeSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function readableTypes(limits: HomeworkUploadLimits): HomeworkMimeType[] {
  return limits.allowedMimeTypes.filter((t) => HOMEWORK_READABLE_MIME_TYPES.includes(t));
}

const MEGAPIXELS = HOMEWORK_IMAGE_LIMITS.maxPixels / 1_000_000;
const SCAN_MAX_MB = Math.floor(HOMEWORK_SCAN_MAX_TOTAL_BYTES / (1024 * 1024));
/** R2C-WEB-1: the same words the API uses for SCAN_TOO_LARGE (parent copy). */
const SCAN_TOO_LARGE_COPY = `These pages add up to more than ${SCAN_MAX_MB} MB, which is more than one scan can hold. Take the photos again at a smaller size, or split the pages into two scans.`;
const SCAN_TOO_LARGE_NEXT = 'Your pages are still selected — remove a page to send the rest.';
const MEASURE_TIMEOUT_MS = 10_000;

/**
 * Asks the browser for a picked photo's natural pixel size without putting it on the page
 * (AC_CAPTURE_02). Resolves null when the browser can't tell (not an image it opens, or no answer in
 * time): the scan job measures every page's header anyway, so an unknown size is not refused here.
 */
function measureImage(file: File): Promise<ImageSize | null> {
  return new Promise((resolve) => {
    let url: string;
    try {
      url = URL.createObjectURL(file);
    } catch {
      resolve(null);
      return;
    }
    const image = new Image();
    let settled = false;
    const done = (size: ImageSize | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      URL.revokeObjectURL(url);
      resolve(size);
    };
    const timer = setTimeout(() => done(null), MEASURE_TIMEOUT_MS);
    image.onload = () =>
      done(
        image.naturalWidth > 0 && image.naturalHeight > 0
          ? { width: image.naturalWidth, height: image.naturalHeight }
          : null,
      );
    image.onerror = () => done(null);
    image.src = url;
  });
}

/** The same picture size limits the scan job applies (HOMEWORK_IMAGE_LIMITS). */
function pictureSizeProblem(name: string, size: ImageSize | null | undefined): string | null {
  if (!size || homeworkImageSizeProblem(size.width, size.height) !== 'too_large') return null;
  const n = (value: number) => value.toLocaleString('en-US');
  return `${name} is too big a picture (${n(size.width)} × ${n(size.height)} pixels). Photos can be up to ${n(HOMEWORK_IMAGE_LIMITS.maxSidePx)} pixels on each side and ${MEGAPIXELS} megapixels; a photo at your camera’s usual size works.`;
}

/** Checked before anything is sent; the server enforces the same limits either way. */
function pageProblem(page: PickedPage, limits: HomeworkUploadLimits): string | null {
  const { file } = page;
  const readable: readonly string[] = readableTypes(limits);
  if (!readable.includes(file.type)) return `${file.name} isn’t a JPEG or PNG photo.`;
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > limits.maxPageBytes) {
    return `${file.name} is larger than ${Math.floor(limits.maxPageBytes / (1024 * 1024))} MB.`;
  }
  return pictureSizeProblem(file.name, page.size);
}

/**
 * Create (idempotent key) → register pages and receive signed URLs → PUT bytes straight to private
 * storage → finalize (idempotent). Mirrors the child app's flow (apps/mobile/src/homework/upload.ts):
 * the same attempt resumes an interrupted upload, and a scan whose finalize already committed is
 * reported as sent instead of re-registered (RV-homework-4).
 */
async function sendParentScan(args: {
  api: ApiClient;
  childId: string;
  pages: readonly PickedPage[];
  /** The file actually uploaded for a page (shrunk in the browser when it can; R2C-WEB-1). */
  prepare: (page: PickedPage, size: ImageSize | null) => Promise<File>;
  attempt: UploadAttempt;
  signal: AbortSignal;
  onAttempt: (attempt: UploadAttempt) => void;
  onProgress: (phase: UploadPhase, done: number) => void;
}): Promise<AssignmentState> {
  const { api, pages, signal } = args;
  const stopIfAborted = () => {
    if (signal.aborted) throw new UploadStoppedError();
  };
  const prepared: {
    pageNumber: number;
    mimeType: string;
    bytes: Uint8Array<ArrayBuffer>;
    sha256: string;
  }[] = [];
  for (const [i, page] of pages.entries()) {
    stopIfAborted();
    args.onProgress('preparing', i);
    // A measurement still running when Send was pressed is waited for, so an over-limit photo is
    // refused before the scan is created.
    const measured = await page.measured;
    const tooBig = pictureSizeProblem(page.file.name, measured);
    if (tooBig) throw new PictureTooBigError(tooBig);
    stopIfAborted();
    const upload = await args.prepare(page, measured);
    stopIfAborted();
    const bytes = new Uint8Array(await upload.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    prepared.push({ pageNumber: i + 1, mimeType: upload.type, bytes, sha256: toHex(digest) });
  }
  stopIfAborted();
  // R2C-WEB-1: the server refuses a scan over the bound at registration (SCAN_TOO_LARGE); checking
  // the prepared bytes here first means no scan is created and nothing is sent.
  if (!homeworkScanFits(prepared.map((p) => p.bytes.length))) throw new ScanTooLargeError();
  const created = await api.send(
    'POST',
    '/v1/assignments',
    { childId: args.childId, pageCount: pages.length, idempotencyKey: args.attempt.createKey },
    assignmentStateResponseSchema,
  );
  const attempt: UploadAttempt = { ...args.attempt, assignmentId: created.assignment.id };
  args.onAttempt(attempt);
  if (FINALIZED_ASSIGNMENT_STATUSES.includes(created.assignment.status)) return created.assignment;
  if (created.assignment.status === 'cancelled' || created.assignment.status === 'deleted') {
    throw new ScanStoppedError();
  }
  const base = `/v1/assignments/${created.assignment.id}`;
  stopIfAborted();
  const registered = await api.send(
    'POST',
    `${base}/uploads`,
    {
      pages: prepared.map((p) => ({
        pageNumber: p.pageNumber,
        mimeType: p.mimeType,
        byteSize: p.bytes.length,
        sha256: p.sha256,
      })),
    },
    uploadPagesResponseSchema,
  );
  let done = registered.uploads.filter((u) => u.alreadyUploaded).length;
  args.onProgress('uploading', done);
  for (const target of registered.uploads) {
    if (target.alreadyUploaded) continue;
    stopIfAborted();
    const page = prepared.find((p) => p.pageNumber === target.pageNumber);
    if (!page) throw new PageTransferError(target.pageNumber);
    let response: Response;
    try {
      response = await fetch(target.uploadUrl, {
        method: target.method,
        body: page.bytes,
        headers: { 'content-type': page.mimeType, 'x-upsert': 'false' },
        signal,
      });
    } catch {
      if (signal.aborted) throw new UploadStoppedError();
      throw new PageTransferError(target.pageNumber);
    }
    if (!response.ok) throw new PageTransferError(target.pageNumber);
    done += 1;
    args.onProgress('uploading', done);
  }
  stopIfAborted();
  args.onProgress('finishing', pages.length);
  const finalized = await api.send(
    'POST',
    `${base}/finalize`,
    { idempotencyKey: attempt.finalizeKey },
    assignmentStateResponseSchema,
  );
  return finalized.assignment;
}

function parentUploadMessage(error: unknown): string {
  if (error instanceof UploadStoppedError) {
    return 'Stopped. Your pages are still selected.';
  }
  if (error instanceof ScanStoppedError) {
    return 'That scan was cancelled. Your pages are still selected — send them again to start a new scan.';
  }
  if (error instanceof PictureTooBigError) {
    return `${error.message} Your pages are still selected — remove that page to send the rest.`;
  }
  if (error instanceof ScanTooLargeError) return `${SCAN_TOO_LARGE_COPY} ${SCAN_TOO_LARGE_NEXT}`;
  if (error instanceof ApiRequestError && error.rule === 'SCAN_TOO_LARGE') {
    return `${error.message} ${SCAN_TOO_LARGE_NEXT}`;
  }
  if (error instanceof PageTransferError) {
    return `Page ${error.pageNumber} didn’t finish uploading. Your pages are still selected — try again to send the rest.`;
  }
  if (error instanceof ApiRequestError) return error.message;
  return 'Something went wrong. Your pages are still selected — please try again.';
}

function progressCopy(state: { phase: UploadPhase; done: number; total: number }): string {
  switch (state.phase) {
    case 'preparing':
      return `Getting page ${Math.min(state.done + 1, state.total)} of ${state.total} ready…`;
    case 'uploading':
      return `Uploading page ${Math.min(state.done + 1, state.total)} of ${state.total}…`;
    case 'finishing':
      return 'Sending the scan to be read…';
  }
}

/** Why new scans can’t start for this child right now, or null. Never offers a purchase. */
function uploadBlockedReason(child: FamilyChild, allowance: PageAllowance | null): ReactNode {
  const name = child.nickname;
  const blocker = scanBlocker(child.status);
  if (blocker !== null) {
    // HUNT7-I-6: the same hedge the page's three other draft remedies carry. "You can set that up on
    // the Children page" promised capacity this portal cannot sell (WEB-R1-04): POST
    // /v1/children/:id/activate assigns only an unused verified slot and answers BUSINESS_RULE
    // NEEDS_PAID_SLOT when the family has none (packages/contracts/src/family.ts), so with no free
    // slot there is nothing to set up there. A draft child renders this region AND the Scans card at
    // once, so the unhedged sentence sat beside INACTIVE_CHILD_NO_NEW_SCAN_COPY's hedged one and the
    // hedged `NoScans` line.
    //
    // And it is keyed on `scanBlocker` (the repair), not on `!== 'active'` with one sentence for all of
    // them: this branch used to say "needs a paid child slot" for EVERY non-active status, while
    // `noNewScanCopy` printed a blocker only for 'archived' and 'draft' — so for any other value this
    // region asserted a reason the rows beside it did not support and the rows asserted none. One value
    // decides both now. 'archived' is here for completeness: that profile gets the "Scanning paused"
    // notice in place of this whole region (WEBR4-10), so this arm is not reached for it today.
    if (blocker === 'no-paid-slot') {
      return (
        <>
          {name} needs a paid child slot before homework can be scanned. Assign one of your family’s
          unused paid slots to this profile on the <Link to="/app/children">Children page</Link>,
          while one is free.
        </>
      );
    }
    if (blocker === 'archived') {
      return (
        <>
          {name}’s profile is archived, so homework can’t be scanned for them. Activate {name} again
          on the <Link to="/app/children">Children page</Link>, while a paid slot is free.
        </>
      );
    }
    return (
      <>
        {name}’s profile is not active, so homework can’t be scanned for them. You can check this
        profile on the <Link to="/app/children">Children page</Link>.
      </>
    );
  }
  if (allowance === null) return null;
  if (allowance.familyPagesAllowed === 0) {
    return 'New scans are paused while the family plan has no paid child slots.';
  }
  if (allowance.childHasPaidSlot === false) {
    return `New scans for ${name} are paused while ${name} doesn’t hold a paid child slot.`;
  }
  if (
    allowance.childPagesUsed >= allowance.childPagesAllowed ||
    allowance.familyPagesUsed >= allowance.familyPagesAllowed
  ) {
    return 'No pages are left for new scans this month.';
  }
  return null;
}

/**
 * G-NO-SCANS-COPY: the empty Scans list said "Add one above, or {name} can scan homework in the
 * PencilLift app on a paired phone or tablet". Both halves are false for a profile that is not
 * active, and this page renders the refutation itself: an archived child gets no uploader at all
 * (WEBR4-10 replaced it with the "Scanning paused" notice) and any other non-active profile gets the
 * uploader region with `uploadBlockedReason` and no control — so nothing is "above" to add from — and
 * no paired device can scan either, because POST /v1/assignments requires `status = 'active'`
 * (`readPaidProfile`, apps/api/src/routes/homework.ts) and archiving revokes the child's sessions.
 * It is the two-regions-disagree defect HUNT6-H-2 and G-H2 closed for this list's ROWS, left in the
 * branch that renders when there are none.
 *
 * Keyed on `scanBlocker`, the one value `uploadBlockedReason` and `noNewScanCopy` also read, so the
 * three regions of this screen cannot give one profile three readings (HUNT7-I-6). The draft line
 * asserts no history of the slot, since a draft may never have held one or may have lost one to a
 * downgrade (`releaseSlotlessProfiles`, apps/api/src/services/billing-sync.ts), and the fall-through
 * asserts no reason at all.
 */
function NoScans({ child }: { child: FamilyChild }) {
  const name = child.nickname;
  const blocker = scanBlocker(child.status);
  if (blocker === null) {
    return (
      <p>
        No scans for {name} yet. Add one above, or {name} can scan homework in the PencilLift app on
        a paired phone or tablet; each scan appears here as it is processed.
      </p>
    );
  }
  return (
    <p>
      No scans for {name}.{' '}
      {blocker === 'archived'
        ? `PencilLift takes no new scans while ${name}’s profile is archived, and their paired devices are signed out, so none can be added here or in the app. `
        : blocker === 'no-paid-slot'
          ? `PencilLift takes no new scans while ${name} has no paid slot, so none can be added here or in the app. `
          : `PencilLift takes no new scans while ${name}’s profile is not active, so none can be added here or in the app. `}
      {blocker === 'archived' ? (
        <>
          Activate {name} again on the <Link to="/app/children">Children page</Link>, while a paid
          slot is free
        </>
      ) : blocker === 'no-paid-slot' ? (
        <>
          Assign one of your family’s unused paid slots to this profile on the{' '}
          <Link to="/app/children">Children page</Link>, while one is free
        </>
      ) : (
        <>
          Check this profile on the <Link to="/app/children">Children page</Link>
        </>
      )}
      , and new scans will appear here as they are processed.
    </p>
  );
}

function ScanUploader({
  child,
  allowance,
  onChanged,
}: {
  child: FamilyChild;
  allowance: PageAllowance | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const blocked = uploadBlockedReason(child, allowance);
  const name = child.nickname;
  return (
    <section className="card" aria-label="Add a scan" style={{ marginTop: 16 }}>
      <h2>Scan homework for {name}</h2>
      {blocked !== null ? (
        <p style={{ margin: 0 }}>{blocked}</p>
      ) : (
        <>
          <p style={{ margin: '0 0 8px' }}>
            Upload photos of {name}’s homework pages from this device, in page order. Each scan is
            read and checked, then appears in the list below.
          </p>
          <button
            type="button"
            className="btn secondary"
            aria-expanded={open}
            disabled={busy}
            onClick={() => setOpen(!open)}
          >
            {open ? 'Close the uploader' : `Add a scan for ${name}`}
          </button>
          {open ? (
            <UploadPanel childId={child.id} name={name} onChanged={onChanged} onBusy={setBusy} />
          ) : null}
        </>
      )}
    </section>
  );
}

function UploadPanel({
  childId,
  name,
  onChanged,
  onBusy,
}: {
  childId: string;
  name: string;
  onChanged: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const { api } = useSession();
  const [limits, setLimits] = useState<HomeworkUploadLimits>(DEFAULT_HOMEWORK_UPLOAD_LIMITS);
  const [pages, setPages] = useState<PickedPage[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [state, setState] = useState<SendState>({ kind: 'idle' });
  const attemptRef = useRef<UploadAttempt>(newAttempt());
  // R2C-WEB-1: each picked photo is shrunk once; a retry of the same scan uploads the same bytes
  // (the server compares a resumed scan's pages with what was registered).
  const preparedRef = useRef(new WeakMap<File, Promise<File>>());
  const controllerRef = useRef<AbortController | null>(null);
  const inputId = useId();
  const limitsId = useId();

  // The server's configured limits; the shipped defaults show until (or unless) they load. The
  // server enforces its limits either way. Closing the uploader stops an upload in progress.
  useEffect(() => {
    let active = true;
    api.get('/v1/assignments/limits', uploadLimitsResponseSchema).then(
      (body) => {
        if (active) setLimits(body.limits);
      },
      () => undefined,
    );
    return () => {
      active = false;
      controllerRef.current?.abort();
    };
  }, [api]);

  const running = state.kind === 'running';
  const readable = readableTypes(limits);
  const notYet = limits.allowedMimeTypes.filter((t) => !readable.includes(t));
  const problems = pages.map((p) => pageProblem(p, limits));
  const canSend =
    pages.length > 0 && pages.length <= limits.maxPages && problems.every((p) => p === null);

  /** Resolves true when there was nothing to cancel or the server cancelled the scan. */
  const cancelOnServer = (attempt: UploadAttempt): Promise<boolean> =>
    attempt.assignmentId === null
      ? Promise.resolve(true)
      : api
          .send(
            'POST',
            `/v1/assignments/${attempt.assignmentId}/cancel`,
            undefined,
            assignmentStateResponseSchema,
          )
          .then(
            () => {
              onChanged();
              return true;
            },
            () => false,
          );

  /** Different pages make a different scan: an unfinished earlier one is cancelled (released). */
  const changePages = (next: PickedPage[]) => {
    void cancelOnServer(attemptRef.current);
    attemptRef.current = newAttempt();
    setState({ kind: 'idle' });
    setPages(next);
  };

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    const room = Math.max(0, limits.maxPages - pages.length);
    const added: PickedPage[] = files
      .slice(0, room)
      .map((file) => ({ key: newKey(), file, measured: measureImage(file) }));
    const dropped = files.length - added.length;
    changePages([...pages, ...added]);
    // Sizes arrive as each photo is measured; a page over the limits then shows its problem.
    for (const page of added) {
      void page.measured.then((size) =>
        setPages((current) => current.map((p) => (p.key === page.key ? { ...p, size } : p))),
      );
    }
    setNotice(
      dropped > 0
        ? `Only ${limits.maxPages} pages fit in one scan, so ${dropped} ${dropped === 1 ? 'file was' : 'files were'} left out.`
        : null,
    );
  };

  const move = (index: number, delta: -1 | 1) => {
    const next = [...pages];
    const [page] = next.splice(index, 1);
    if (!page) return;
    next.splice(index + delta, 0, page);
    changePages(next);
  };

  const remove = (index: number) => changePages(pages.filter((_, i) => i !== index));

  const send = async () => {
    const controller = new AbortController();
    controllerRef.current = controller;
    const total = pages.length;
    setNotice(null);
    setState({ kind: 'running', phase: 'preparing', done: 0, total });
    onBusy(true);
    try {
      await sendParentScan({
        api,
        childId,
        pages,
        prepare: (page, size) => {
          // Only a photo whose pixel size the browser measured, within the limits, is decoded
          // again to shrink it; anything else is sent as picked (the server checks it).
          if (!size) return Promise.resolve(page.file);
          let upload = preparedRef.current.get(page.file);
          if (!upload) {
            upload = downscaleForUpload(page.file);
            preparedRef.current.set(page.file, upload);
          }
          return upload;
        },
        attempt: attemptRef.current,
        signal: controller.signal,
        onAttempt: (attempt) => {
          attemptRef.current = attempt;
        },
        onProgress: (phase, done) => setState({ kind: 'running', phase, done, total }),
      });
      attemptRef.current = newAttempt();
      setPages([]);
      setState({ kind: 'sent' });
      onChanged();
    } catch (error) {
      if (error instanceof UploadStoppedError || controller.signal.aborted) {
        // Stop means stop: the server releases anything reserved for the unfinished scan.
        const stopped = attemptRef.current;
        attemptRef.current = newAttempt();
        const cancelled = await cancelOnServer(stopped);
        setState({
          kind: 'error',
          message: cancelled
            ? parentUploadMessage(new UploadStoppedError())
            : 'Stopped. Your pages are still selected. The unfinished scan couldn’t be cancelled just now — you can cancel it from the list below.',
        });
      } else {
        // Keep the same attempt so "Try again" resumes; a scan stopped on the server needs a new one.
        if (error instanceof ScanStoppedError) attemptRef.current = newAttempt();
        setState({ kind: 'error', message: parentUploadMessage(error) });
      }
    } finally {
      controllerRef.current = null;
      onBusy(false);
    }
  };

  const typeNames = readable.map((t) => TYPE_NAMES[t]).join(' or ');
  return (
    <div style={{ marginTop: 12 }}>
      <p id={limitsId} style={{ margin: '0 0 8px' }}>
        Up to {limits.maxPages} pages per scan, each{' '}
        {Math.floor(limits.maxPageBytes / (1024 * 1024))} MB or smaller, up to {SCAN_MAX_MB} MB per
        scan, as {typeNames} photos of up to {MEGAPIXELS} megapixels. Large photos are made smaller
        on this device before they are sent. Lay each page flat in good light so every word shows.
      </p>
      {notYet.length > 0 ? (
        <p style={{ margin: '0 0 8px' }}>
          <strong>Not available yet:</strong> {notYet.map((t) => TYPE_NAMES[t]).join(' and ')}.
          Reading them needs a file converter that isn’t running yet, so for now please use{' '}
          {typeNames} photos of the pages.
        </p>
      ) : null}
      <label htmlFor={inputId}>Choose page photos</label>
      <input
        id={inputId}
        type="file"
        accept={readable.join(',')}
        multiple
        aria-describedby={limitsId}
        disabled={running || pages.length >= limits.maxPages}
        onChange={onPick}
      />
      {notice ? (
        <p role="status" style={{ margin: '8px 0 0' }}>
          {notice}
        </p>
      ) : null}
      {pages.length > 0 ? (
        <ol aria-label="Pages to send" style={{ paddingLeft: 20 }}>
          {pages.map((page, i) => (
            <li key={page.key} style={{ margin: '8px 0' }}>
              <span>
                Page {i + 1}: {page.file.name} · {describeSize(page.file.size)}
              </span>
              {problems[i] ? (
                <p style={{ color: 'var(--danger)', margin: '4px 0 0' }}>⚠ {problems[i]}</p>
              ) : null}
              {!running ? (
                <div style={buttonRow}>
                  <button
                    type="button"
                    className="btn secondary"
                    aria-label={`Move page ${i + 1} up`}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    className="btn secondary"
                    aria-label={`Move page ${i + 1} down`}
                    disabled={i === pages.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    Down
                  </button>
                  <button
                    type="button"
                    className="btn secondary"
                    aria-label={`Remove page ${i + 1}`}
                    onClick={() => remove(i)}
                  >
                    Remove
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {state.kind === 'running' ? (
        <div style={{ margin: '8px 0' }}>
          <p role="status" style={{ margin: 0 }}>
            {progressCopy(state)}
          </p>
          <progress max={state.total} value={state.done} aria-label="Upload progress" />
          <div style={buttonRow}>
            <button
              type="button"
              className="btn secondary"
              onClick={() => controllerRef.current?.abort()}
            >
              Stop sending
            </button>
          </div>
        </div>
      ) : null}
      {state.kind === 'error' ? (
        <div className="error" role="alert">
          <p>{state.message}</p>
        </div>
      ) : null}
      {state.kind === 'sent' ? (
        <p role="status" style={{ color: 'var(--success)', fontWeight: 700 }}>
          Sent! {name}’s scan is waiting to be read; it appears in the list below.
        </p>
      ) : null}
      {pages.length > 0 && !running ? (
        <div style={buttonRow}>
          <button type="button" className="btn" disabled={!canSend} onClick={() => void send()}>
            {state.kind === 'error'
              ? 'Try again'
              : `Send ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------------------------

function AssignmentDetail({
  assignmentId,
  childName,
  childStatus,
  onChanged,
}: {
  assignmentId: string;
  childName: string;
  /**
   * HUNT6-H-2: the same status the list rows use, so the panel does not ask for a refused rescan.
   *
   * HUNT7-I-2: and so it does not OFFER one either. The prop reached the label and the explanation
   * only, while the correction control — which re-checks the work through the same gate a new scan
   * goes through — was still decided by the assignment status alone. It is part of `correctable`
   * below now, and of the reason printed when that is false.
   */
  childStatus: string;
  onChanged: () => void;
}) {
  const query = useRefreshingQuery(
    (api) => api.get(`/v1/assignments/${assignmentId}`, assignmentDetailResponseSchema),
    [assignmentId],
  );
  const { api } = useSession();
  const [solutions, setSolutions] = useState<Map<string, QuestionSolution> | null>(null);
  const solutionAction = useAction();
  const { reload } = query;
  const refresh = useCallback(() => {
    reload();
    onChanged();
  }, [reload, onChanged]);

  const showSolutions = () =>
    void solutionAction.run(async () => {
      const body = await api.get(
        `/v1/assignments/${assignmentId}/solutions`,
        assignmentSolutionsResponseSchema,
      );
      setSolutions(new Map(body.solutions.map((s) => [s.questionId, s])));
      return body.solutions.length === 0
        ? 'No solutions are available for this scan yet.'
        : 'Solutions are shown below. Keep them out of sight of your child.';
    });

  const hideSolutions = () => {
    setSolutions(null);
    solutionAction.setFeedback(null);
  };

  return (
    <section
      className="card"
      aria-label="Scan details"
      aria-busy={query.status === 'ready' && query.refreshing}
      style={{ marginTop: 16 }}
    >
      <h2>Scan details</h2>
      {query.status === 'loading' ? <Loading label="Loading scan…" /> : null}
      {query.status === 'error' ? (
        <ErrorState message={query.error.message} onRetry={reload} />
      ) : null}
      {query.status === 'ready' ? (
        <>
          <p>
            {statusLabel(query.data.assignment.status, childStatus)}:{' '}
            {explainStatus(query.data.assignment, childName, childStatus)}
          </p>
          {query.data.questions.length === 0 ? (
            <p>No questions have been read from this scan yet.</p>
          ) : (
            <>
              <div style={buttonRow}>
                {solutions === null ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={solutionAction.busy}
                    onClick={showSolutions}
                  >
                    Show solutions
                  </button>
                ) : (
                  <button type="button" className="btn secondary" onClick={hideSolutions}>
                    Hide solutions
                  </button>
                )}
              </div>
              <ActionFeedback feedback={solutionAction.feedback} what="Seeing solutions" />
              {query.data.questions.map((q) => (
                <QuestionCard
                  key={q.id}
                  question={q}
                  solution={solutions?.get(q.id) ?? null}
                  solutionsShown={solutions !== null}
                  // HUNT7-I-2: the STATUS is part of the decision, not only of the label beside it.
                  // POST /v1/questions/:id/correction queues a paid AI re-check and goes through the
                  // same `assertCanCollect` → `readPaidProfile` gate as a new scan, whose `entitled`
                  // requires `status = 'active'` (apps/api/src/routes/homework.ts). "active" rather
                  // than "not archived", so a status this page has never heard of fails closed.
                  correctable={
                    childStatus === 'active' &&
                    CORRECTABLE_ASSIGNMENT_STATUSES.includes(query.data.assignment.status)
                  }
                  whyNotCorrectable={whyNotCorrectable(query.data.assignment.status, childStatus)}
                  onChanged={refresh}
                />
              ))}
            </>
          )}
        </>
      ) : null}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ margin: '4px 0' }}>
      <span style={{ fontWeight: 700 }}>{label}: </span>
      {children}
    </div>
  );
}

function QuestionCard({
  question: q,
  solution,
  solutionsShown = false,
  correctable,
  whyNotCorrectable,
  onChanged,
}: {
  question: ParentQuestion;
  solution: QuestionSolution | null;
  /** True once the parent unlocked and loaded the solutions for this scan. */
  solutionsShown?: boolean;
  correctable: boolean;
  /**
   * The true reason the correction control is not offered, for whichever of its two blockers applies
   * (HUNT7-I-2). Read only when `correctable` is false, and never a guess: see `whyNotCorrectable`.
   */
  whyNotCorrectable: string;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<'view' | 'override' | 'correct'>('view');
  const action = useAction();
  const result = q.result;
  const uncertain = q.uncertainty === 'high' || q.uncertainty === 'medium';

  return (
    <article
      aria-label={`Question ${q.questionNumber}`}
      style={{ borderTop: '1px solid #e3e8ee', padding: '12px 0' }}
    >
      <h3 style={{ margin: '0 0 4px' }}>
        Question {q.questionNumber}{' '}
        <span style={{ fontWeight: 400, fontSize: '0.9rem' }}>(page {q.pageNumber})</span>
      </h3>
      <Field label="Question">{q.promptText}</Field>
      {q.correctedPromptText !== null ? (
        <Field label="Corrected by a parent">{q.correctedPromptText}</Field>
      ) : null}
      <Field label="Student answer">{q.studentAnswerText ?? '(blank)'}</Field>
      {q.correctedStudentAnswerText !== null ? (
        <Field label="Corrected by a parent">{q.correctedStudentAnswerText || '(blank)'}</Field>
      ) : null}
      {uncertain ? (
        <p style={{ margin: '4px 0' }}>
          ⚠ Transcription may be wrong — hard to read ({q.uncertainty}). Check it against the page.
        </p>
      ) : null}
      {result ? (
        <>
          <Field label="Result">
            <strong>{VERDICT_COPY[result.verdict]}</strong>
            {result.override
              ? ` (you changed this from “${VERDICT_COPY[result.gradedVerdict]}”${result.override.reason ? `: ${result.override.reason}` : ''})`
              : ''}
          </Field>
          {result.disagreement ? (
            <p style={{ margin: '4px 0' }}>
              ⚑ The automatic checkers disagreed on this one, so it was escalated
              {result.route === 'parent_review' ? ' to you' : ''}. Worth a look.
            </p>
          ) : null}
          {!result.disagreement && result.route === 'parent_review' ? (
            <p style={{ margin: '4px 0' }}>⚑ Sent to you for review.</p>
          ) : null}
        </>
      ) : (
        <Field label="Result">Not checked yet</Field>
      )}
      {!solution && result?.gradedVerdict === 'rubric' ? (
        <p style={{ margin: '4px 0' }}>
          {solutionsShown
            ? 'No rubric feedback was recorded for this answer.'
            : 'Rubric feedback is shown with the solutions (it needs your parent PIN).'}
        </p>
      ) : null}
      {solution ? (
        <div className="notice" style={{ margin: '8px 0' }}>
          {/* Written work has no single right answer, so empty answer lines are left out. */}
          {solution.correctAnswer.trim() ? (
            <Field label="Answer">{solution.correctAnswer}</Field>
          ) : null}
          {solution.workedSolution.trim() ? (
            <Field label="Worked solution">{solution.workedSolution}</Field>
          ) : null}
          <RubricFeedback
            rubric={solution.rubric}
            written={q.answerKind === 'writing' || result?.gradedVerdict === 'rubric'}
          />
          {solution.misconception ? (
            <Field label="Likely mix-up">{solution.misconception}</Field>
          ) : null}
        </div>
      ) : null}
      <div style={buttonRow}>
        {result ? (
          <button
            type="button"
            className="btn secondary"
            aria-expanded={mode === 'override'}
            onClick={() => setMode(mode === 'override' ? 'view' : 'override')}
          >
            Change result
          </button>
        ) : null}
        {correctable ? (
          <button
            type="button"
            className="btn secondary"
            aria-expanded={mode === 'correct'}
            onClick={() => setMode(mode === 'correct' ? 'view' : 'correct')}
          >
            Fix transcription
          </button>
        ) : null}
      </div>
      {!correctable ? (
        <p style={{ margin: '4px 0', fontSize: '0.9rem' }}>{whyNotCorrectable}</p>
      ) : null}
      {mode === 'override' && result ? (
        <OverrideForm
          questionId={q.id}
          current={result.verdict}
          action={action}
          onDone={() => {
            setMode('view');
            onChanged();
          }}
        />
      ) : null}
      {mode === 'correct' ? (
        <CorrectionForm
          question={q}
          action={action}
          onDone={() => {
            setMode('view');
            onChanged();
          }}
        />
      ) : null}
      <ActionFeedback feedback={action.feedback} what="Changing a result" />
    </article>
  );
}

/**
 * Rubric feedback for written work (AC_GRADING_03): each criterion, whether it was met and the
 * grader's note, in words and symbols (never colour alone). Parent-only — it arrives only with the
 * step-up solutions. A rubric stored in any other JSON shape is still shown as plain text.
 */
function RubricFeedback({ rubric, written }: { rubric: unknown; written: boolean }) {
  const known = homeworkRubricSchema.safeParse(rubric);
  const empty = rubric === null || (known.success && known.data.length === 0);
  if (empty) {
    return written ? (
      <p style={{ margin: '4px 0' }}>No rubric feedback was recorded for this answer.</p>
    ) : null;
  }
  return (
    <section aria-label="Rubric feedback" style={{ margin: '4px 0' }}>
      <span style={{ fontWeight: 700 }}>Rubric feedback:</span>
      {known.success ? (
        <ul style={{ margin: '4px 0', paddingLeft: 20 }}>
          {known.data.map((c, i) => (
            <li key={i}>
              <strong>{c.met ? '✓ Met' : '○ Not yet'}</strong> — {c.criterion}
              {c.note ? `: ${c.note}` : ''}
            </li>
          ))}
        </ul>
      ) : (
        <RubricText value={rubric} />
      )}
    </section>
  );
}

/** Plain-text rendering of JSON (lists and “key: value” lines); never raw JSON or [object Object]. */
function RubricText({ value }: { value: unknown }): ReactNode {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return (
      <ul style={{ margin: '4px 0', paddingLeft: 20 }}>
        {items.map((item, i) => (
          <li key={i}>
            <RubricText value={item} />
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === 'object' && value !== null) {
    return (
      <ul style={{ margin: '4px 0', paddingLeft: 20 }}>
        {Object.entries(value as Record<string, unknown>).map(([key, item]) => (
          <li key={key}>
            {key}: <RubricText value={item} />
          </li>
        ))}
      </ul>
    );
  }
  return null;
}

type Action = ReturnType<typeof useAction>;

function OverrideForm({
  questionId,
  current,
  action,
  onDone,
}: {
  questionId: string;
  current: GradedVerdict;
  action: Action;
  onDone: () => void;
}) {
  const { api } = useSession();
  const initial: OverrideVerdict =
    current === 'correct' || current === 'incorrect' ? current : 'unresolved';
  const [verdict, setVerdict] = useState<OverrideVerdict>(initial);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const verdictId = useId();
  const reasonId = useId();
  const errorId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      setError('Add a short reason so the change is clear later.');
      return;
    }
    setError(null);
    void action
      .run(async () => {
        await api.send(
          'POST',
          `/v1/questions/${questionId}/override`,
          { verdict, reason: trimmed },
          overrideResultResponseSchema,
        );
        return 'Result updated. Points your child already earned are kept.';
      })
      .then((ok) => {
        if (ok) onDone();
      });
  };

  return (
    <form onSubmit={submit} noValidate>
      <label htmlFor={verdictId}>New result</label>
      <select
        id={verdictId}
        value={verdict}
        onChange={(e) => setVerdict(e.target.value as OverrideVerdict)}
      >
        {OVERRIDE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <label htmlFor={reasonId}>Reason</label>
      <textarea
        id={reasonId}
        style={textareaStyle}
        value={reason}
        maxLength={OVERRIDE_REASON_MAX_LENGTH}
        aria-invalid={error !== null}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => setReason(e.target.value)}
      />
      {error ? (
        <p id={errorId} role="alert" style={{ color: 'var(--danger)', margin: '4px 0 0' }}>
          {error}
        </p>
      ) : null}
      <div style={buttonRow}>
        <button type="submit" className="btn" disabled={action.busy}>
          Save result
        </button>
      </div>
    </form>
  );
}

function CorrectionForm({
  question: q,
  action,
  onDone,
}: {
  question: ParentQuestion;
  action: Action;
  onDone: () => void;
}) {
  const { api } = useSession();
  const startPrompt = q.correctedPromptText ?? q.promptText;
  const startAnswer = q.correctedStudentAnswerText ?? q.studentAnswerText ?? '';
  const [prompt, setPrompt] = useState(startPrompt);
  const [answer, setAnswer] = useState(startAnswer);
  const [error, setError] = useState<string | null>(null);
  const promptId = useId();
  const answerId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body: { promptText?: string; studentAnswerText?: string } = {};
    if (prompt.trim() !== startPrompt.trim()) body.promptText = prompt.trim();
    if (answer.trim() !== startAnswer.trim()) body.studentAnswerText = answer.trim();
    if (body.promptText === undefined && body.studentAnswerText === undefined) {
      setError('Nothing changed yet.');
      return;
    }
    if (body.promptText !== undefined && body.promptText.length === 0) {
      setError('The question text can’t be empty.');
      return;
    }
    setError(null);
    void action
      .run(async () => {
        await api.send(
          'POST',
          `/v1/questions/${q.id}/correction`,
          body,
          correctTranscriptionResponseSchema,
        );
        return 'Saved. The original reading is kept, and PencilLift is re-checking this question.';
      })
      .then((ok) => {
        if (ok) onDone();
      });
  };

  return (
    <form onSubmit={submit} noValidate>
      <p style={{ margin: '8px 0 0' }}>
        Type what is actually on the page. Don’t type the right answer here — only what your child
        wrote.
      </p>
      <label htmlFor={promptId}>Question text as printed</label>
      <textarea
        id={promptId}
        style={textareaStyle}
        value={prompt}
        maxLength={TRANSCRIPTION_TEXT_MAX_LENGTH}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <label htmlFor={answerId}>Student answer as written</label>
      <textarea
        id={answerId}
        style={textareaStyle}
        value={answer}
        maxLength={TRANSCRIPTION_TEXT_MAX_LENGTH}
        onChange={(e) => setAnswer(e.target.value)}
      />
      {error ? (
        <p role="alert" style={{ color: 'var(--danger)', margin: '4px 0 0' }}>
          {error}
        </p>
      ) : null}
      <div style={buttonRow}>
        <button type="submit" className="btn" disabled={action.busy}>
          Save transcription
        </button>
      </div>
    </form>
  );
}
