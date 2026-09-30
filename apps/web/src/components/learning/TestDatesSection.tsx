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
import { formatCalendarDate, receivesPractice } from '@pencillift/contracts';

const SCOPE_MAX = 2000;
/** The recognised practice topics of one saved test date, as the two lines below print them. */
const topicsOf = (t: TestDate): string => t.matchedSkills.map((m) => m.label).join(', ');
/** DELETE answers 204 with no body; the client reads that as null. */
const noContentSchema = z.null();

/**
 * Test dates by subject (spec P6 "parents mark an upcoming test", P8 "test dates by subject").
 * A test moves that subject's review to before the test; scope notes steer which skills are
 * practiced. Review practice happens beforehand; there is no live exam help.
 *
 * HUNT6-H-1: `childStatus` is the profile's status from GET /v1/family. POST /test-dates and
 * DELETE /test-dates/:id both go through `ownedChild(c, 'write')`, which answers BUSINESS_RULE
 * CHILD_ARCHIVED for an archived profile (apps/api/src/routes/learning.ts), while the GET takes
 * `'read'` and succeeds — so an archived child's saved dates are listed (history, AC_CAPACITY_08) and
 * the add form and Remove are not offered. The test is "is this profile ARCHIVED?", not "is it
 * active?": the same guard keeps a DRAFT profile writable on purpose, so a parent can put next week's
 * test in before the slot is assigned.
 *
 * HUNT7-H-3: "history only" is what a non-active profile's rendering now IS. Dropping the controls was
 * only part of it — each listed row also carried a future-tense line about the practice the test would
 * get, which no non-active profile receives. That line answers to `receivesReview` below, a SECOND
 * status value, because "may the parent write here" and "is a review prepared" are different questions
 * with different answers: a draft keeps every control and still gets no review.
 */
export function TestDatesSection({
  childId,
  childName,
  subjects,
  onChanged,
  childStatus,
}: {
  childId: string;
  childName: string;
  subjects: readonly ChildSubject[];
  onChanged: () => void;
  childStatus?: string;
}) {
  const readOnly = childStatus === 'archived';
  /**
   * Whether a review is PREPARED for this profile, which is a different question from whether the
   * parent may write here and has a different answer (HUNT7-H-3). Four statements decide it and all
   * four say `active`: `loadChildContext` returns null for an archived profile and then for any status
   * that is not 'active' unless `requireActive: false` is passed, which only routes/learning.ts's own
   * parent-side preview does; the nightly enqueue sweep selects `where c.status = 'active'`; the
   * practice-set insert re-checks `status = 'active'` under FOR SHARE (all three in
   * apps/api/src/jobs/learning-jobs.ts); and `app.current_child_id()` requires `c.status = 'active'`
   * (migration 0001_core_identity.sql), so a non-active child's own device could not open a review
   * either. Written as "is active" rather than "is not archived" so a status nobody has enumerated
   * gets the conditional wording rather than a promise.
   */
  // The planner's ONE answer to "does this profile receive practice", shared with ScheduleSection so the
  // two cards in this page region cannot tell the parent opposite things (see `receivesPractice`).
  const receivesReview = receivesPractice(childStatus);
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
      // The SAME `receivesReview` that decides the row lines decides this sentence, because the parent
      // who just saved the date is precisely the reader of the row below it: unhedged, the one card said
      // "“Coming up” shows when its review is ready." two lines above "No review is prepared while
      // {name}'s profile is not active." (blocker found on re-check — L-053's third copy, in product copy
      // rather than in a comment).
      return (
        `Saved the ${nameOf(testDate)} test on ${formatCalendarDate(testDate.testDate)}.` +
        (receivesReview
          ? ' “Coming up” shows when its review is ready.'
          : ` If ${childName}’s profile is activated, “Coming up” will show when its review is ready.`) +
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
        {receivesReview
          ? `Add a test so that subject’s review is planned before it, using the topics you list.`
          : `Add a test and list its topics. A review is planned from them once ${childName}’s profile is active.`}{' '}
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
                {/*
                  HUNT7-H-3: the two lines below are the only FORWARD-LOOKING ones in this list, and
                  for a profile that is not active both were false. GET /test-dates admits an archived
                  profile through `ownedChild(c, 'read')` and `toTestDate` computes `matchedSkills`
                  from the scope notes whatever the status (apps/api/src/routes/learning.ts), so a
                  saved future test still printed "Practice will include: …" — a promise of practice
                  the profile cannot receive. It sat under this section's own "test dates can't be
                  added or removed" notice and the planner's "no new practice is prepared for them".
                  Same shape as HUNT5-F-10's "Shown to your child from …" in PracticeSetsSection: the
                  row stays, the date and the "Covers:" history stay, and only the promise becomes the
                  conditional. The unrecognised-notes sentence names what the review WOULD use, so
                  where there is no review it is dropped rather than rewritten.

                  They are keyed on `receivesReview`, NOT on `readOnly`: the first attempt hedged them
                  for 'archived' only and left a DRAFT — and any status this page has never heard of —
                  printing the promise, directly under the planner's own notice that the child
                  "doesn't have a paid slot right now, so no practice is prepared". See the value's
                  own comment above for the four statements that decide it.
                */}
                {t.matchedSkills.length > 0 ? (
                  <p style={hintStyle}>
                    {receivesReview
                      ? `Practice will include: ${topicsOf(t)}`
                      : `No review is prepared while ${childName}’s profile is not active. If it is activated, these topics would steer one: ${topicsOf(t)}`}
                  </p>
                ) : t.scopeNotes && receivesReview ? (
                  <p style={hintStyle}>
                    No practice topics were recognized in these notes; the review uses this week’s
                    skills.
                  </p>
                ) : null}
                {readOnly ? null : (
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
                )}
              </li>
            ))}
          </ul>
        )
      ) : null}

      {readOnly ? (
        <p className="notice" style={{ margin: '8px 0 0' }}>
          {childName}’s profile is archived, so test dates can’t be added or removed. The dates
          already saved stay readable above. Activate {childName} again on the Children page while a
          paid slot is free to change them.
        </p>
      ) : choices.length === 0 ? (
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
