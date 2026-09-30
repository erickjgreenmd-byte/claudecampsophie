import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import {
  LEARNING_LIMITS,
  dailyPracticeCopy,
  learningScheduleResponseSchema,
  noWeeklyReviewsCopy,
  reviewReleaseReasonCopy,
  reviewReleaseWhen,
  subjectName,
  type ChildSubject,
  type LearningScheduleResponse,
} from '@pencillift/contracts';
import { useApiQuery, useSession } from '../../lib/session.tsx';
import { ErrorState, Loading } from '../states.tsx';
import {
  ActionFeedback,
  FieldError,
  buttonRow,
  hintStyle,
  sectionStyle,
  useAction,
} from './feedback.tsx';
import { WEEKDAYS, zoneLabel } from './format.ts';
import {
  scheduleToForm,
  validateScheduleForm,
  type ScheduleErrors,
  type ScheduleForm,
} from './schedule-form.ts';

/**
 * Daily practice + weekly review schedule (spec P7, P8). Every time is the family's local time
 * in its IANA zone, which is named on screen; the server computes the next releases with the zone's
 * daylight-saving rules. `refreshKey` reloads the releases after subject or test-date changes.
 *
 * HUNT5-F-10: the RELEASE TIMES do not branch on the status. For an archived profile the planner's
 * own notice frames every time below it — "the times below are what the schedule would produce if the
 * profile were active again" — so these instants are read as the hypothetical they are, and the
 * stored plan the parent came to read stays on screen. Blanking them would throw that plan away.
 *
 * HUNT6-H-1: the EDITOR does branch, and `childStatus` is back for that. Its submit is
 * PUT /learning-schedule, which goes through `ownedChild(c, 'write')` and answers BUSINESS_RULE
 * CHILD_ARCHIVED for an archived profile (apps/api/src/routes/learning.ts), while the GET above takes
 * `'read'` and succeeds — so the section mounted, printed the plan, and offered a "Save schedule" the
 * server refuses, under a notice saying the page is readable. For that one status the fields are
 * shown disabled and the submit is not rendered; the values stay visible. The test is "is this
 * profile ARCHIVED?", not "is it active?": the same guard keeps a DRAFT profile writable on purpose,
 * because a parent sets the plan up before the slot is assigned, so a draft — and an unrecognised
 * status, which the family contract has none of — keeps the editor.
 *
 * HUNT7-H-4 and HUNT7-H-1: the status also decides the ADVICE this card gives when nothing is coming
 * up — so it cannot ask for a subject toggle the same status has made unusable in the section next to
 * it — and the DAILY line, which was the last unconditional present-tense claim in this region.
 *
 * BUG-411: both of those sentences, and the release-reason words beside each instant, are now
 * `dailyPracticeCopy`, `noWeeklyReviewsCopy` and `reviewReleaseReasonCopy` in
 * packages/contracts/src/learning.ts, which apps/mobile's planner calls too. This file holds NO copy of
 * them and derives no status predicate of its own beyond `readOnly` below, which is the other question.
 */
export function ScheduleSection({
  childId,
  childName,
  subjects,
  refreshKey,
  childStatus,
}: {
  childId: string;
  childName: string;
  subjects: readonly ChildSubject[];
  refreshKey: number;
  childStatus?: string;
}) {
  const path = `/v1/children/${encodeURIComponent(childId)}/learning-schedule`;
  const query = useApiQuery(
    (api) => api.get(path, learningScheduleResponseSchema),
    [path, refreshKey],
  );
  const [snapshot, setSnapshot] = useState<LearningScheduleResponse | null>(null);
  const ready = query.status === 'ready' ? query.data : null;
  useEffect(() => {
    if (ready) setSnapshot(ready);
  }, [ready]);
  const headingId = useId();
  // The latest known schedule: from the last load, or from a save (which answers with the new one).
  const data = snapshot ?? ready;
  /**
   * "Can this plan be changed at all?" — the EDITOR's question, and only the editor's. It is the same
   * expression SubjectsSection's own `readOnly` uses
   * (apps/web/src/components/learning/SubjectsSection.tsx), which is what makes the empty-review advice
   * below agree with whether the subject checkbox it names is usable; the page-level case in
   * apps/web/src/pages/app/ArchivedChildCopy.test.tsx asserts the two sections against each other so
   * they cannot drift apart again.
   *
   * The card below is handed `childStatus` instead of this value, because the OTHER question — does
   * this profile receive practice — is `receivesPractice`, which a draft profile also fails while its
   * plan stays writable. Passing this boolean where that one belongs is the confusion of L-068.
   */
  const readOnly = childStatus === 'archived';

  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Practice and review schedule</h2>
      {data === null && query.status === 'loading' ? <Loading label="Loading schedule…" /> : null}
      {query.status === 'error' ? (
        <ErrorState
          message={`We couldn’t load the schedule. ${query.error.message}`}
          onRetry={query.reload}
        />
      ) : null}
      {data ? (
        <>
          <ScheduleEditor
            path={path}
            childName={childName}
            initial={data}
            readOnly={readOnly}
            onSaved={(saved) => setSnapshot(saved)}
          />
          <UpcomingReleases
            data={data}
            subjects={subjects}
            childName={childName}
            childStatus={childStatus}
          />
        </>
      ) : null}
    </section>
  );
}

function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error: string | undefined;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} style={hintStyle}>
          {hint}
        </p>
      ) : null}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

function describedBy(id: string, error: string | undefined, hint: boolean): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

function ScheduleEditor({
  path,
  childName,
  initial,
  readOnly,
  onSaved,
}: {
  path: string;
  childName: string;
  initial: LearningScheduleResponse;
  /** HUNT6-H-1: the saved schedule stays readable; PUT /learning-schedule is refused (CHILD_ARCHIVED). */
  readOnly: boolean;
  onSaved: (saved: LearningScheduleResponse) => void;
}) {
  const { api } = useSession();
  const { busy, feedback, run } = useAction();
  // The form starts from the first loaded schedule and is replaced only by a successful save, so
  // a background refresh (e.g. after a test date change) never discards unsaved edits.
  const [form, setForm] = useState<ScheduleForm>(() => scheduleToForm(initial.schedule));
  const [errors, setErrors] = useState<ScheduleErrors>({});
  const base = useId();
  const id = (field: string) => `${base}-${field}`;
  const zone = initial.timezone;

  const set = <K extends keyof ScheduleForm>(key: K, value: ScheduleForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // HUNT6-H-1: this form stays mounted read-only, so the property is "no PUT is issued", not "no
    // button is rendered" — every field is disabled and the submit is gone, and this holds even if a
    // later field arrives without one.
    if (readOnly) return;
    const result = validateScheduleForm(form);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    void run('save', async () => {
      const saved = await api.send('PUT', path, result.value, learningScheduleResponseSchema);
      setForm(scheduleToForm(saved.schedule));
      onSaved(saved);
      return `Schedule saved for ${childName}.`;
    });
  };

  const zoneText = `All times are in your family’s time zone: ${zoneLabel(zone)}.`;
  const { reviewQuestionsPerSubject: reviewLimits, dailyQuestionCount: dailyLimits } =
    LEARNING_LIMITS;

  return (
    <form onSubmit={submit} noValidate aria-label="Practice and review schedule">
      <p id={id('zone')}>
        <strong>{zoneText}</strong> Daylight-saving changes are handled automatically.
      </p>
      <ActionFeedback feedback={feedback} />

      <fieldset style={{ border: 'none', padding: 0, margin: '12px 0 0' }}>
        <legend style={{ fontWeight: 800 }}>Weekly review</legend>
        <Field id={id('reviewWeekday')} label="Review day" error={errors.reviewWeekday}>
          <select
            id={id('reviewWeekday')}
            value={form.reviewWeekday}
            disabled={readOnly}
            onChange={(e) => set('reviewWeekday', e.target.value)}
            aria-invalid={errors.reviewWeekday ? true : undefined}
            aria-describedby={describedBy(id('reviewWeekday'), errors.reviewWeekday, false)}
          >
            {WEEKDAYS.map((d) => (
              <option key={d.value} value={String(d.value)}>
                {d.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id={id('reviewLocalTime')}
          label={`Review time (${zone})`}
          error={errors.reviewLocalTime}
          hint="The review is ready by this time on the review day, even if the app is closed."
        >
          <input
            id={id('reviewLocalTime')}
            type="time"
            value={form.reviewLocalTime}
            disabled={readOnly}
            onChange={(e) => set('reviewLocalTime', e.target.value)}
            aria-invalid={errors.reviewLocalTime ? true : undefined}
            aria-describedby={describedBy(id('reviewLocalTime'), errors.reviewLocalTime, true)}
          />
        </Field>
        <Field
          id={id('reviewQuestionsPerSubject')}
          label="Review questions per subject"
          error={errors.reviewQuestionsPerSubject}
          hint={`${reviewLimits.min}–${reviewLimits.max}. The default ${reviewLimits.default} is six from the week’s weaker skills and two cumulative.`}
        >
          <input
            id={id('reviewQuestionsPerSubject')}
            type="number"
            inputMode="numeric"
            min={reviewLimits.min}
            max={reviewLimits.max}
            step={1}
            value={form.reviewQuestionsPerSubject}
            disabled={readOnly}
            onChange={(e) => set('reviewQuestionsPerSubject', e.target.value)}
            aria-invalid={errors.reviewQuestionsPerSubject ? true : undefined}
            aria-describedby={describedBy(
              id('reviewQuestionsPerSubject'),
              errors.reviewQuestionsPerSubject,
              true,
            )}
          />
        </Field>
      </fieldset>

      <fieldset style={{ border: 'none', padding: 0, margin: '16px 0 0' }}>
        <legend style={{ fontWeight: 800 }}>Daily practice (every day, weekends included)</legend>
        <Field
          id={id('dailyLocalTime')}
          label={`Daily practice time (${zone})`}
          error={errors.dailyLocalTime}
        >
          <input
            id={id('dailyLocalTime')}
            type="time"
            value={form.dailyLocalTime}
            disabled={readOnly}
            onChange={(e) => set('dailyLocalTime', e.target.value)}
            aria-invalid={errors.dailyLocalTime ? true : undefined}
            aria-describedby={describedBy(id('dailyLocalTime'), errors.dailyLocalTime, false)}
          />
        </Field>
        <Field
          id={id('dailyQuestionCount')}
          label="Daily questions"
          error={errors.dailyQuestionCount}
          hint={`${dailyLimits.min}–${dailyLimits.max}. ${dailyLimits.default} questions take about 5–10 minutes.`}
        >
          <input
            id={id('dailyQuestionCount')}
            type="number"
            inputMode="numeric"
            min={dailyLimits.min}
            max={dailyLimits.max}
            step={1}
            value={form.dailyQuestionCount}
            disabled={readOnly}
            onChange={(e) => set('dailyQuestionCount', e.target.value)}
            aria-invalid={errors.dailyQuestionCount ? true : undefined}
            aria-describedby={describedBy(
              id('dailyQuestionCount'),
              errors.dailyQuestionCount,
              true,
            )}
          />
        </Field>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={form.pauseEnabled}
            disabled={readOnly}
            onChange={(e) => set('pauseEnabled', e.target.checked)}
            style={{ width: 24, minHeight: 24 }}
          />
          Pause daily practice for a vacation
        </label>
        {form.pauseEnabled ? (
          <div role="group" aria-label="Vacation pause dates">
            <label htmlFor={id('pauseFrom')}>First day of the pause</label>
            <input
              id={id('pauseFrom')}
              type="date"
              value={form.pauseFrom}
              disabled={readOnly}
              onChange={(e) => set('pauseFrom', e.target.value)}
              aria-invalid={errors.pause ? true : undefined}
              aria-describedby={errors.pause ? id('pause-error') : undefined}
            />
            <label htmlFor={id('pauseTo')}>Last day of the pause</label>
            <input
              id={id('pauseTo')}
              type="date"
              value={form.pauseTo}
              disabled={readOnly}
              onChange={(e) => set('pauseTo', e.target.value)}
              aria-invalid={errors.pause ? true : undefined}
              aria-describedby={errors.pause ? id('pause-error') : undefined}
            />
          </div>
        ) : null}
        <FieldError id={id('pause-error')} message={errors.pause} />
        <p style={hintStyle}>
          Pausing or missing a day never removes points {childName} already earned.
        </p>
      </fieldset>

      <fieldset style={{ border: 'none', padding: 0, margin: '16px 0 0' }}>
        <legend style={{ fontWeight: 800 }}>Reminders</legend>
        {/* Honest copy (MOB-R1-05, web twin): nothing sends a notification to a child's device in
            this version, so no toggle promises one. The schedule's stored reminder and quiet-hours
            values round-trip unchanged through the form. */}
        <p style={hintStyle}>
          Practice reminders and quiet hours aren’t available yet. PencilLift doesn’t send
          notifications to {childName}’s device in this version; when reminders arrive, you’ll
          choose here whether to allow them and when to keep things quiet.
        </p>
        <FieldError id={id('quiet-error')} message={errors.quietHours} />
      </fieldset>

      {readOnly ? (
        <p className="notice" style={{ margin: '16px 0 0' }}>
          {childName}’s profile is archived, so this schedule can’t be changed. The saved times are
          shown above and stay readable. Activate {childName} again on the Children page while a
          paid slot is free to change them.
        </p>
      ) : (
        <div style={buttonRow}>
          <button type="submit" className="btn" disabled={busy !== null}>
            {busy === 'save' ? 'Saving…' : 'Save schedule'}
          </button>
        </div>
      )}
    </form>
  );
}

function UpcomingReleases({
  data,
  subjects,
  childName,
  childStatus,
}: {
  data: LearningScheduleResponse;
  /**
   * The array the Subjects card renders, handed on unchanged. The empty-review line needs to know
   * whether a subject that BEARS a weekly review is on, and it derives that itself from these rows
   * rather than take a flag from here (L-071): a flag is what the first repair got wrong, claiming
   * "no subject is on" for a child whose only enabled subject was CUSTOM, which the card beside this
   * one printed as "On".
   */
  subjects: readonly ChildSubject[];
  childName: string;
  /**
   * The profile's status, NOT a boolean derived from it. Every status-dependent sentence in this card
   * comes from `packages/contracts` and asks `receivesPractice` itself, so this card cannot hand one
   * line a different answer from the next, and cannot hand the shared copy a `prepared` flag it
   * computed from the wrong question — `readOnly` (above, for the EDITOR) is the wrong question, and
   * confusing the two is what promised a draft profile practice four rounds running (L-068).
   */
  childStatus: string | undefined;
}) {
  const zone = data.timezone;
  const headingId = useId();
  return (
    <div aria-labelledby={headingId} role="region">
      <h3 id={headingId}>Coming up for {childName}</h3>
      {/*
        HUNT7-H-1: the daily line used to be one string per state, and three of the four carried no time
        at all, so the planner's framing sentence — "the times below are what the schedule would produce
        if the profile were active again" — could not cover them; 'available' then told the parent of an
        archived or draft child that today's practice was ready, a few inches under a notice saying no
        new practice is prepared for them. It is false for both: `app.current_child_id()` requires
        `c.status = 'active'` (migration 0001_core_identity), so no request from the child's device can
        open a set, and `loadChildContext` (apps/api/src/jobs/learning-jobs.ts) prepares none. It is not
        a stale value either — the archived branch of GET /learning-schedule recomputes
        `dailyPracticeState` from the clock on every request, and that returns 'available' on any local
        day past `daily_local_time` with no pause covering it (packages/domain/src/scheduling/daily.ts).
        The instant stays where there is one; only the claim hedges.

        BUG-411: the table and the choice between its two variants are `dailyPracticeCopy`
        (packages/contracts/src/learning.ts), which the phone's planner calls too. This card hands it
        the STATUS, so there is no `prepared` flag here to get wrong and no second copy of the wording.
      */}
      <p>
        {dailyPracticeCopy({
          dailyPractice: data.dailyPractice,
          zone,
          childName,
          childStatus,
        })}
      </p>
      {data.nextReviewReleases.length === 0 ? (
        /*
          HUNT7-H-4 and BUG-411: the four sentences, the fall-through order and the cause this card may
          claim are all `noWeeklyReviewsCopy` (packages/contracts/src/learning.ts), which the phone's
          planner calls with the same three inputs. The phone had two sentences of its own, said
          "…are scheduled." where this card said "…are scheduled yet.", named no subject and had no
          archived arm — HUNT7-H-1 agreed the DAILY line across the surfaces and stopped there. The
          reasoning that settled each arm is written out at the shared function.

          The SUBJECTS array goes in, not a flag computed here: the empty-list cause is the shared
          function's to establish, and a flag is what the first repair got wrong.
        */
        <p>{noWeeklyReviewsCopy({ childName, childStatus, subjects })}</p>
      ) : (
        <ul>
          {data.nextReviewReleases.map((r) => (
            <li key={`${r.subjectKey}-${r.weekKey}`}>
              <strong>{subjectName(r.subjectKey, subjects)}</strong>: {reviewReleaseWhen(r, zone)} (
              {reviewReleaseReasonCopy(r)})
            </li>
          ))}
        </ul>
      )}
      <p style={hintStyle}>
        Reviews practice the week’s skills and any test topics you add. They help prepare, but can’t
        predict what the teacher will put on a test.
      </p>
    </div>
  );
}
