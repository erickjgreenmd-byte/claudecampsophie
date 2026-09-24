import { useId, useState } from 'react';
import { Link } from 'react-router';
import {
  answerKeyResponseSchema,
  practiceSetsResponseSchema,
  reviewPdfExportResponseSchema,
  type AnswerKeyResponse,
  type ChildSubject,
  type ParentPracticeSet,
  type ReviewPdfExportRequest,
} from '@pencillift/contracts';
import { useApiQuery, useSession } from '../../lib/session.tsx';
import { ErrorState, Loading } from '../states.tsx';
import {
  ActionFeedback,
  StepUpNotice,
  buttonRow,
  hintStyle,
  listReset,
  sectionStyle,
  toApiError,
  useAction,
} from './feedback.tsx';
import {
  ITEM_STATUS_LABEL,
  SET_KIND_LABEL,
  SET_STATUS_LABEL,
  choiceLetter,
  formatCalendarDate,
  formatInZone,
  mixSummary,
  questionsLabel,
  subjectName,
} from './format.ts';

/** The API returns at most this many sets (newest first). */
const SET_LIMIT = 30;

type KindFilter = 'all' | ParentPracticeSet['kind'];

const FILTERS: readonly { value: KindFilter; label: string }[] = [
  { value: 'all', label: 'All practice' },
  { value: 'daily', label: 'Daily practice' },
  { value: 'thursday_review', label: 'Weekly reviews' },
  { value: 'top_up', label: 'Extra practice (optional)' },
];

/**
 * Practice sets and weekly reviews with their questions and progress (spec P8, P10). The answer
 * key is a separate, protected request that needs a recent parent PIN; it is held only in this
 * component's memory and never mixed into the child's view. PDF exports are requested here and
 * listed on the Privacy page when ready.
 */
export function PracticeSetsSection({
  childId,
  childName,
  subjects,
  zone,
}: {
  childId: string;
  childName: string;
  subjects: readonly ChildSubject[];
  zone: string;
}) {
  const [filter, setFilter] = useState<KindFilter>('all');
  const path =
    `/v1/children/${encodeURIComponent(childId)}/practice-sets` +
    (filter === 'all' ? '' : `?kind=${filter}`);
  const query = useApiQuery((api) => api.get(path, practiceSetsResponseSchema), [path]);
  const headingId = useId();
  const filterId = useId();

  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Practice sets and reviews</h2>
      <p>
        The questions {childName} sees, with progress. Answer keys stay in the parent area and need
        your parent PIN.
      </p>
      <label htmlFor={filterId}>Show</label>
      <select
        id={filterId}
        value={filter}
        onChange={(e) => setFilter(e.target.value as KindFilter)}
      >
        {FILTERS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      {query.status === 'loading' ? <Loading label="Loading practice sets…" /> : null}
      {query.status === 'error' ? (
        <ErrorState message={query.error.message} onRetry={query.reload} />
      ) : null}
      {query.status === 'ready' ? (
        query.data.sets.length === 0 ? (
          <p>
            No{' '}
            {filter === 'all'
              ? 'practice sets'
              : FILTERS.find((f) => f.value === filter)?.label.toLowerCase()}{' '}
            yet. They appear here once they are prepared for {childName}.
          </p>
        ) : (
          <>
            <ul style={listReset}>
              {query.data.sets.map((set) => (
                <SetCard key={set.id} set={set} subjects={subjects} zone={zone} />
              ))}
            </ul>
            {query.data.sets.length >= SET_LIMIT ? (
              <p style={hintStyle}>Showing the {SET_LIMIT} most recent sets.</p>
            ) : null}
          </>
        )
      ) : null}
    </section>
  );
}

function setTitle(set: ParentPracticeSet, subjects: readonly ChildSubject[]): string {
  const parts = [SET_KIND_LABEL[set.kind]];
  if (set.subjectKey !== null) parts.push(subjectName(set.subjectKey, subjects));
  if (set.localDate !== null) parts.push(formatCalendarDate(set.localDate));
  else if (set.reviewWeek !== null) parts.push(`week ${set.reviewWeek}`);
  if (set.version > 1) parts.push(`version ${set.version}`);
  return parts.join(' · ');
}

type KeyState =
  | { status: 'hidden' }
  | { status: 'loading' }
  | { status: 'needs_pin' }
  | { status: 'error'; message: string }
  | { status: 'shown'; data: AnswerKeyResponse };

function SetCard({
  set,
  subjects,
  zone,
}: {
  set: ParentPracticeSet;
  subjects: readonly ChildSubject[];
  zone: string;
}) {
  const { api } = useSession();
  const { busy, feedback, run } = useAction();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState<KeyState>({ status: 'hidden' });
  const title = setTitle(set, subjects);
  const questionsId = useId();
  const keyId = useId();
  const finished = set.items.filter(
    (i) => i.progress.status === 'correct' || i.progress.status === 'help_offered',
  ).length;
  const firstTryRight = set.items.filter((i) => i.progress.firstTry === 'correct').length;
  const mix = mixSummary(set.mix);
  const hasQuestions = set.items.length > 0;

  const showKey = async () => {
    setKey({ status: 'loading' });
    try {
      const data = await api.get(
        `/v1/practice-sets/${encodeURIComponent(set.id)}/answer-key`,
        answerKeyResponseSchema,
      );
      setKey({ status: 'shown', data });
    } catch (error) {
      const problem = toApiError(error);
      setKey(
        problem.code === 'STEP_UP_REQUIRED'
          ? { status: 'needs_pin' }
          : { status: 'error', message: problem.message },
      );
    }
  };

  const exportPdf = (variant: ReviewPdfExportRequest['variant']) =>
    void run(variant, async () => {
      const body: ReviewPdfExportRequest = { setId: set.id, variant };
      await api.send('POST', '/v1/exports/review-pdf', body, reviewPdfExportResponseSchema);
      return variant === 'answer_key'
        ? 'Preparing the parent answer-key PDF. It will be listed on the Privacy page when it is ready.'
        : 'Preparing the questions-only PDF (no answers). It will be listed on the Privacy page when it is ready.';
    });

  return (
    <li style={{ borderTop: '1px solid #e3e8ee', padding: '12px 0' }} aria-label={title}>
      <h3 style={{ margin: 0, fontSize: '1.1rem' }}>{title}</h3>
      <p style={{ margin: '4px 0' }}>
        Status: {SET_STATUS_LABEL[set.status]}
        {hasQuestions
          ? ` · ${finished} of ${questionsLabel(set.items.length)} finished · ${firstTryRight} right on the first try`
          : ''}
      </p>
      {set.releaseAt ? (
        <p style={hintStyle}>Shown to your child from {formatInZone(set.releaseAt, zone)}.</p>
      ) : null}
      {mix ? <p style={hintStyle}>Mix: {mix}.</p> : null}
      {set.notes.length > 0 ? (
        <ul style={{ margin: '4px 0' }} aria-label="How this set was put together">
          {set.notes.map((n, i) => (
            <li key={`${n.code}-${i}`}>{n.message}</li>
          ))}
        </ul>
      ) : null}
      <ActionFeedback feedback={feedback} stepUpWhat="Exporting a PDF" />
      {feedback?.kind === 'success' ? (
        <p style={{ margin: 0 }}>
          <Link to="/app/privacy">Go to Privacy and exports</Link>
        </p>
      ) : null}
      {hasQuestions ? (
        <div style={buttonRow}>
          <button
            type="button"
            className="btn secondary"
            aria-expanded={open}
            aria-controls={questionsId}
            aria-label={`${open ? 'Hide' : 'Show'} questions: ${title}`}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Hide questions' : 'Show questions'}
          </button>
          {key.status === 'shown' ? (
            <button
              type="button"
              className="btn secondary"
              aria-controls={keyId}
              aria-label={`Hide answer key: ${title}`}
              onClick={() => setKey({ status: 'hidden' })}
            >
              Hide answer key
            </button>
          ) : (
            <button
              type="button"
              className="btn secondary"
              disabled={key.status === 'loading'}
              aria-label={`Show answer key: ${title}`}
              onClick={() => void showKey()}
            >
              {key.status === 'loading' ? 'Opening answer key…' : 'Show answer key'}
            </button>
          )}
          <button
            type="button"
            className="btn secondary"
            disabled={busy !== null}
            aria-label={`Request questions-only PDF: ${title}`}
            onClick={() => exportPdf('questions')}
          >
            {busy === 'questions' ? 'Requesting…' : 'Questions PDF'}
          </button>
          <button
            type="button"
            className="btn secondary"
            disabled={busy !== null}
            aria-label={`Request parent answer-key PDF: ${title}`}
            onClick={() => exportPdf('answer_key')}
          >
            {busy === 'answer_key' ? 'Requesting…' : 'Answer key PDF (parent only)'}
          </button>
        </div>
      ) : (
        <p style={hintStyle}>No questions in this set yet.</p>
      )}
      {key.status === 'needs_pin' ? <StepUpNotice what="Showing the answer key" /> : null}
      {key.status === 'error' ? <ErrorState message={key.message} /> : null}
      {open ? (
        <ol id={questionsId} style={{ paddingLeft: 24 }}>
          {set.items.map((item) => (
            <li key={item.id} style={{ margin: '8px 0' }}>
              <p style={{ margin: 0 }}>
                <strong>{item.topic}</strong>
              </p>
              {item.prompt.passage ? (
                <details>
                  <summary>Passage: {item.prompt.passage.title}</summary>
                  <p style={{ whiteSpace: 'pre-wrap' }}>{item.prompt.passage.text}</p>
                </details>
              ) : null}
              <p style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>{item.prompt.text}</p>
              {item.prompt.choices ? (
                <ul style={{ listStyle: 'none', paddingLeft: 0, margin: '4px 0' }}>
                  {item.prompt.choices.map((choice, i) => (
                    <li key={`${i}-${choice}`}>
                      {choiceLetter(i)}. {choice}
                    </li>
                  ))}
                </ul>
              ) : null}
              {item.prompt.unitHint ? (
                <p style={hintStyle}>Answer in {item.prompt.unitHint}.</p>
              ) : null}
              <p style={hintStyle}>
                {ITEM_STATUS_LABEL[item.progress.status]}
                {item.progress.attempts > 0
                  ? ` · ${item.progress.attempts} ${item.progress.attempts === 1 ? 'try' : 'tries'}`
                  : ''}
                {item.progress.firstTry === 'correct'
                  ? ' · right on the first try'
                  : item.progress.firstTry === 'incorrect'
                    ? ' · first try needed another go'
                    : ''}
              </p>
            </li>
          ))}
        </ol>
      ) : null}
      {key.status === 'shown' ? (
        <section
          id={keyId}
          aria-label={`Answer key: ${title}`}
          className="notice"
          style={{ marginTop: 8 }}
        >
          <h4 style={{ marginTop: 0 }}>Answer key (parent only)</h4>
          <p style={hintStyle}>Please don’t share it with your child before they practice.</p>
          <ol style={{ paddingLeft: 24 }}>
            {[...key.data.items]
              .sort((a, b) => a.position - b.position)
              .map((k) => (
                <li key={k.itemId} value={k.position}>
                  <strong>{k.answer}</strong>
                  {k.explanation ? ` — ${k.explanation}` : ''}
                </li>
              ))}
          </ol>
        </section>
      ) : null}
    </li>
  );
}
