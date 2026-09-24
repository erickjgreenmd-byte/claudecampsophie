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
  HOMEWORK_READABLE_MIME_TYPES,
  OVERRIDE_REASON_MAX_LENGTH,
  TRANSCRIPTION_TEXT_MAX_LENGTH,
  assignmentDetailResponseSchema,
  assignmentListResponseSchema,
  assignmentSolutionsResponseSchema,
  assignmentStateResponseSchema,
  correctTranscriptionResponseSchema,
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
import { RequireParent, useApiQuery, useSession } from '../../lib/session.tsx';

/**
 * Parent homework (spec P5 "Parent selects child", P6, P14 "scan uploader / assignment review /
 * solutions"; AC_UX_02, AC_GRADING_05, AC_GRADING_10). Parents can scan homework for the selected
 * child by uploading page photos, see every processing state explained honestly, the child's answers
 * and verdicts, and — only after a server-verified PIN step-up — solutions.
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
const familyChildrenSchema = z.object({
  children: z.array(z.object({ id: z.uuid(), nickname: z.string(), status: z.string() })),
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

/** Error codes whose meaning is more specific than the generic copy of their state. */
function explainStatus(
  assignment: { status: AssignmentStatus; errorCode: string | null },
  name: string,
): string {
  if (assignment.status === 'failed_final' && assignment.errorCode === 'FORMAT_NEEDS_CONVERSION') {
    return 'PencilLift can’t read PDF or HEIC files yet, so this scan was not checked and its pages were given back. Scan the pages again as JPEG or PNG photos.';
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

function StepUpNotice({ what }: { what: string }) {
  return (
    <div className="notice" role="alert">
      <p style={{ margin: 0 }}>
        <strong>Enter your parent PIN to continue.</strong> {what} needs a recent PIN unlock.{' '}
        <Link to="/app/security">Unlock on the Security page</Link>, then try again.
      </p>
    </div>
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
                {child.status === 'active' ? '' : ' (no paid slot yet)'}
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

function ChildHomework({ child }: { child: FamilyChild }) {
  const query = useRefreshingQuery(
    (api) =>
      api.get(
        `/v1/assignments?childId=${encodeURIComponent(child.id)}`,
        assignmentListResponseSchema,
      ),
    [child.id],
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const { api } = useSession();
  const action = useAction();
  const { reload } = query;

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

  if (query.status === 'loading') return <Loading label="Loading scans…" />;
  if (query.status === 'error') {
    return <ErrorState message={query.error.message} onRetry={reload} />;
  }
  const { assignments, allowance } = query.data;
  return (
    <>
      {allowance ? <AllowanceCard allowance={allowance} name={child.nickname} /> : null}
      <ScanUploader child={child} allowance={allowance} onChanged={reload} />
      <ActionFeedback feedback={action.feedback} what="Cancelling" />
      <section
        className="card"
        aria-label="Scans"
        aria-busy={query.refreshing}
        style={{ marginTop: 16 }}
      >
        <h2>Scans for {child.nickname}</h2>
        {assignments.length === 0 ? (
          <p>
            No scans for {child.nickname} yet. Add one above, or {child.nickname} can scan homework
            in the PencilLift app on a paired phone or tablet; each scan appears here as it is
            processed.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {assignments.map((a) => (
              <li key={a.id} style={{ borderTop: '1px solid #e3e8ee', padding: '12px 0' }}>
                <strong>
                  {formatDate(a.createdAt)} · {a.pageCount} {a.pageCount === 1 ? 'page' : 'pages'} ·{' '}
                  {STATUS_COPY[a.status].label}
                </strong>
                <p style={{ margin: '4px 0' }}>{explainStatus(a, child.nickname)}</p>
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
      </section>
      {openId !== null ? (
        <AssignmentDetail
          key={openId}
          assignmentId={openId}
          childName={child.nickname}
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

interface PickedPage {
  readonly key: string;
  readonly file: File;
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

/** Checked before anything is sent; the server enforces the same limits either way. */
function pageProblem(file: File, limits: HomeworkUploadLimits): string | null {
  const readable: readonly string[] = readableTypes(limits);
  if (!readable.includes(file.type)) return `${file.name} isn’t a JPEG or PNG photo.`;
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > limits.maxPageBytes) {
    return `${file.name} is larger than ${Math.floor(limits.maxPageBytes / (1024 * 1024))} MB.`;
  }
  return null;
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
    const bytes = new Uint8Array(await page.file.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    prepared.push({ pageNumber: i + 1, mimeType: page.file.type, bytes, sha256: toHex(digest) });
  }
  stopIfAborted();
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
  if (child.status !== 'active') {
    return (
      <>
        {name} needs a paid child slot before homework can be scanned. You can set that up on the{' '}
        <Link to="/app/children">Children page</Link>.
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
  const problems = pages.map((p) => pageProblem(p.file, limits));
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
    const added = files.slice(0, room).map((file) => ({ key: newKey(), file }));
    const dropped = files.length - added.length;
    changePages([...pages, ...added]);
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
        {Math.floor(limits.maxPageBytes / (1024 * 1024))} MB or smaller, as {typeNames} photos. Lay
        each page flat in good light so every word shows.
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
  onChanged,
}: {
  assignmentId: string;
  childName: string;
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
            {STATUS_COPY[query.data.assignment.status].label}:{' '}
            {explainStatus(query.data.assignment, childName)}
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
                  correctable={CORRECTABLE_ASSIGNMENT_STATUSES.includes(
                    query.data.assignment.status,
                  )}
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
  correctable,
  onChanged,
}: {
  question: ParentQuestion;
  solution: QuestionSolution | null;
  correctable: boolean;
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
      {solution ? (
        <div className="notice" style={{ margin: '8px 0' }}>
          <Field label="Answer">{solution.correctAnswer}</Field>
          <Field label="Worked solution">{solution.workedSolution}</Field>
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
        <p style={{ margin: '4px 0', fontSize: '0.9rem' }}>
          Transcriptions can be fixed once checking has finished.
        </p>
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
