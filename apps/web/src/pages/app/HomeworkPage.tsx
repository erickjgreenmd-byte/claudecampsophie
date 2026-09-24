import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';
import {
  CANCELLABLE_ASSIGNMENT_STATUSES,
  CORRECTABLE_ASSIGNMENT_STATUSES,
  OVERRIDE_REASON_MAX_LENGTH,
  TRANSCRIPTION_TEXT_MAX_LENGTH,
  assignmentDetailResponseSchema,
  assignmentListResponseSchema,
  assignmentSolutionsResponseSchema,
  assignmentStateResponseSchema,
  correctTranscriptionResponseSchema,
  overrideResultResponseSchema,
  type AssignmentStatus,
  type AssignmentSummary,
  type GradedVerdict,
  type OverrideVerdict,
  type PageAllowance,
  type ParentQuestion,
  type QuestionSolution,
} from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import { EmptyState, ErrorState, Loading } from '../../components/states.tsx';
import { RequireParent, useApiQuery, useSession } from '../../lib/session.tsx';

/**
 * Parent homework review (spec P5, P6, P14 "scan uploader / assignment review / solutions";
 * AC_UX_02, AC_GRADING_05, AC_GRADING_10). Parents see every processing state explained honestly,
 * the child's answers and verdicts, and — only after a server-verified PIN step-up — solutions.
 * Scanning itself happens in the mobile app; this page never pretends to upload.
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
      explain: () =>
        'Pages are being sent from the device. If it was interrupted, reopen the scan in the app to resume.',
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
    cancelled: { label: 'Cancelled', explain: () => 'Cancelled. Its pages were removed.' },
    deleted: { label: 'Deleted', explain: () => 'Deleted.' },
  };

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
        Scans are made in the PencilLift app on a phone or tablet. Here you can follow each scan,
        review answers, fix transcriptions and — after your parent PIN — see solutions.
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
  const query = useApiQuery(
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
        return 'Scan cancelled. Its pages were removed and its page allowance released.';
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
      <ActionFeedback feedback={action.feedback} what="Cancelling" />
      <section className="card" aria-label="Scans" style={{ marginTop: 16 }}>
        <h2>Scans for {child.nickname}</h2>
        {assignments.length === 0 ? (
          <p>
            No scans for {child.nickname} yet. {child.nickname} can scan homework in the PencilLift
            app on a paired phone or tablet; each scan appears here as it is processed.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {assignments.map((a) => (
              <li key={a.id} style={{ borderTop: '1px solid #e3e8ee', padding: '12px 0' }}>
                <strong>
                  {formatDate(a.createdAt)} · {a.pageCount} {a.pageCount === 1 ? 'page' : 'pages'} ·{' '}
                  {STATUS_COPY[a.status].label}
                </strong>
                <p style={{ margin: '4px 0' }}>{STATUS_COPY[a.status].explain(child.nickname)}</p>
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
  const childLeft = allowance.childPagesAllowed - allowance.childPagesUsed;
  const familyLeft = allowance.familyPagesAllowed - allowance.familyPagesUsed;
  const exhausted = childLeft <= 0 || familyLeft <= 0;
  return (
    <section
      className={exhausted ? 'notice' : 'card'}
      aria-label="Page allowance"
      style={{ marginTop: 16 }}
    >
      <p style={{ margin: 0 }}>
        <strong>
          {name}: {allowance.childPagesUsed} of {allowance.childPagesAllowed} pages used this month
        </strong>{' '}
        (family: {allowance.familyPagesUsed} of {allowance.familyPagesAllowed}). Scans still being
        processed are counted; pages that could not be read are given back.
      </p>
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
  const query = useApiQuery(
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
    <section className="card" aria-label="Scan details" style={{ marginTop: 16 }}>
      <h2>Scan details</h2>
      {query.status === 'loading' ? <Loading label="Loading scan…" /> : null}
      {query.status === 'error' ? (
        <ErrorState message={query.error.message} onRetry={reload} />
      ) : null}
      {query.status === 'ready' ? (
        <>
          <p>
            {STATUS_COPY[query.data.assignment.status].label}:{' '}
            {STATUS_COPY[query.data.assignment.status].explain(childName)}
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
