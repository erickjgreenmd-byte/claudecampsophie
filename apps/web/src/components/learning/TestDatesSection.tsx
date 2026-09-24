import { useEffect, useId, useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  testDateResponseSchema,
  testDatesResponseSchema,
  type ChildSubject,
  type CreateTestDateRequest,
  type TestDate,
} from '@pencillift/contracts';
import { useApiQuery, useSession } from '../../lib/session.tsx';
import { ErrorState, Loading } from '../states.tsx';
import {
  ActionFeedback,
  FieldError,
  buttonRow,
  hintStyle,
  listReset,
  rowStyle,
  sectionStyle,
  textareaStyle,
  useAction,
} from './feedback.tsx';
import { formatCalendarDate } from './format.ts';

const SCOPE_MAX = 2000;
/** DELETE answers 204 with no body; the client reads that as null. */
const noContentSchema = z.null();

/**
 * Test dates by subject (spec P6 "parents mark an upcoming test", P8 "test dates by subject").
 * A test moves that subject's review to before the test; scope notes steer which skills are
 * practiced. Review practice happens beforehand; there is no live exam help.
 */
export function TestDatesSection({
  childId,
  childName,
  subjects,
  onChanged,
}: {
  childId: string;
  childName: string;
  subjects: readonly ChildSubject[];
  onChanged: () => void;
}) {
  const base = `/v1/children/${encodeURIComponent(childId)}/test-dates`;
  const query = useApiQuery((api) => api.get(base, testDatesResponseSchema), [base]);
  const { api } = useSession();
  const { busy, feedback, run } = useAction();
  const headingId = useId();
  const subjectId = useId();
  const dateId = useId();
  const notesId = useId();
  const choices = subjects.filter((s) => s.enabled);
  const [form, setForm] = useState({ subjectId: choices[0]?.id ?? '', testDate: '', notes: '' });
  const [errors, setErrors] = useState<{ subject?: string; date?: string; notes?: string }>({});
  const firstChoice = choices[0]?.id ?? '';
  useEffect(() => {
    if (form.subjectId === '' && firstChoice !== '') {
      setForm((f) => ({ ...f, subjectId: firstChoice }));
    }
  }, [form.subjectId, firstChoice]);
  const { reload } = query;

  const nameOf = (testDate: TestDate) =>
    subjects.find((s) => s.id === testDate.subjectId)?.displayName ?? testDate.subjectKey;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next: typeof errors = {};
    if (!choices.some((s) => s.id === form.subjectId)) next.subject = 'Choose a subject.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.testDate)) next.date = 'Enter the test date.';
    if (form.notes.trim().length > SCOPE_MAX) next.notes = `Use at most ${SCOPE_MAX} characters.`;
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const notes = form.notes.trim();
    const body: CreateTestDateRequest = {
      subjectId: form.subjectId,
      testDate: form.testDate,
      ...(notes.length > 0 ? { scopeNotes: notes } : {}),
    };
    void run('add', async () => {
      const { testDate } = await api.send('POST', base, body, testDateResponseSchema);
      setForm((f) => ({ ...f, testDate: '', notes: '' }));
      reload();
      onChanged();
      const skills = testDate.matchedSkills.map((m) => m.label);
      return (
        `Saved the ${nameOf(testDate)} test on ${formatCalendarDate(testDate.testDate)}. “Coming up” shows when its review is ready.` +
        (skills.length > 0 ? ` Topics recognized: ${skills.join(', ')}.` : '')
      );
    });
  };

  const remove = (testDate: TestDate) =>
    void run(testDate.id, async () => {
      await api.send(
        'DELETE',
        `${base}/${encodeURIComponent(testDate.id)}`,
        undefined,
        noContentSchema,
      );
      reload();
      onChanged();
      return `Removed the ${nameOf(testDate)} test on ${formatCalendarDate(testDate.testDate)}.`;
    });

  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Upcoming tests</h2>
      <p>
        Add a test so that subject’s review is planned before it, using the topics you list.
        PencilLift helps {childName} practice beforehand; it doesn’t help during a test.
      </p>
      <ActionFeedback feedback={feedback} />
      {query.status === 'loading' ? <Loading label="Loading test dates…" /> : null}
      {query.status === 'error' ? (
        <ErrorState message={query.error.message} onRetry={reload} />
      ) : null}
      {query.status === 'ready' ? (
        query.data.testDates.length === 0 ? (
          <p>No tests added for {childName}.</p>
        ) : (
          <ul style={listReset} aria-label="Saved test dates">
            {query.data.testDates.map((t) => (
              <li key={t.id} style={rowStyle}>
                <strong>
                  {nameOf(t)} · {formatCalendarDate(t.testDate)}
                </strong>
                {t.scopeNotes ? <p style={{ margin: '4px 0' }}>Covers: {t.scopeNotes}</p> : null}
                {t.matchedSkills.length > 0 ? (
                  <p style={hintStyle}>
                    Practice will include: {t.matchedSkills.map((m) => m.label).join(', ')}
                  </p>
                ) : t.scopeNotes ? (
                  <p style={hintStyle}>
                    No practice topics were recognized in these notes; the review uses this week’s
                    skills.
                  </p>
                ) : null}
                <div style={buttonRow}>
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busy !== null}
                    aria-label={`Remove the ${nameOf(t)} test on ${formatCalendarDate(t.testDate)}`}
                    onClick={() => remove(t)}
                  >
                    {busy === t.id ? 'Removing…' : 'Remove'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {choices.length === 0 ? (
        <p>Turn on a subject above to add a test date.</p>
      ) : (
        <form onSubmit={submit} noValidate aria-label="Add a test date">
          <h3>Add a test</h3>
          <label htmlFor={subjectId}>Subject</label>
          <select
            id={subjectId}
            value={form.subjectId}
            onChange={(e) => setForm((f) => ({ ...f, subjectId: e.target.value }))}
            aria-invalid={errors.subject ? true : undefined}
            aria-describedby={errors.subject ? `${subjectId}-error` : undefined}
          >
            {choices.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName}
              </option>
            ))}
          </select>
          <FieldError id={`${subjectId}-error`} message={errors.subject} />
          <label htmlFor={dateId}>Test date</label>
          <input
            id={dateId}
            type="date"
            value={form.testDate}
            onChange={(e) => setForm((f) => ({ ...f, testDate: e.target.value }))}
            aria-invalid={errors.date ? true : undefined}
            aria-describedby={errors.date ? `${dateId}-error` : undefined}
          />
          <FieldError id={`${dateId}-error`} message={errors.date} />
          <label htmlFor={notesId}>What the test covers (optional)</label>
          <textarea
            id={notesId}
            value={form.notes}
            maxLength={SCOPE_MAX}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            style={textareaStyle}
            aria-invalid={errors.notes ? true : undefined}
            aria-describedby={`${notesId}-hint${errors.notes ? ` ${notesId}-error` : ''}`}
          />
          <p id={`${notesId}-hint`} style={hintStyle}>
            For example “adding fractions, comparing decimals”. Topics only — no names or personal
            details. {form.notes.length}/{SCOPE_MAX}
          </p>
          <FieldError id={`${notesId}-error`} message={errors.notes} />
          <div style={buttonRow}>
            <button type="submit" className="btn" disabled={busy !== null}>
              {busy === 'add' ? 'Saving…' : 'Save test date'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
