import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import {
  LEARNING_LIMITS,
  learningScheduleResponseSchema,
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
import {
  DAILY_STATE,
  RELEASE_REASON,
  WEEKDAYS,
  formatInZone,
  subjectName,
  zoneLabel,
  receivesPractice,
} from './format.ts';
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
 * HUNT7-H-4: that one value also decides the ADVICE this card gives when nothing is coming up, so the
 * card cannot ask for a subject toggle that the same status has made unusable in the section next to
 * it. It is computed once, below, and handed to both parts.
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
   * ONE value decides everything on this card that depends on the status, so no two parts of it can
   * disagree (HUNT7-H-4). It is the same expression SubjectsSection's own `readOnly` uses
   * (apps/web/src/components/learning/SubjectsSection.tsx), which is what makes the empty-review
   * advice below agree with whether the subject checkbox it names is usable; the page-level case in
   * apps/web/src/pages/app/ArchivedChildCopy.test.tsx asserts the two sections against each other so
   * they cannot drift apart again.
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
            readOnly={readOnly}
            receivesReview={receivesPractice(childStatus)}
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
  readOnly,
  receivesReview,
}: {
  data: LearningScheduleResponse;
  subjects: readonly ChildSubject[];
  childName: string;
  /** The card's one status value (ScheduleSection above): this profile's plan cannot be changed. */
  readOnly: boolean;
  /**
   * Whether this profile receives practice at all (`receivesPractice`). SEPARATE from `readOnly`, and
   * separate on purpose: a draft profile is writable — the instruction below names a control that really
   * is live for it — and receives nothing, so the instruction may stand while its PROMISE must not.
   * TestDatesSection answers the same question with the same value, which is what stops the two cards in
   * this page region telling the parent opposite things.
   */
  receivesReview: boolean;
}) {
  const zone = data.timezone;
  const headingId = useId();
  /**
   * Whether a subject that PencilLift actually builds a weekly review for is on, read from the SAME
   * array the Subjects card renders (HUNT7-H-4). `generatedPractice` is false for a custom subject —
   * the subjects GET computes it as `isBankSubject(row.subject_key)` (apps/api/src/routes/learning.ts)
   * — and it is precisely a custom-only child that has subjects on and no weekly review, which is why
   * "no subject is on" was the wrong claim to make from an empty list.
   */
  const reviewSubjectOn = subjects.some((s) => s.enabled && s.generatedPractice);
  return (
    <div aria-labelledby={headingId} role="region">
      <h3 id={headingId}>Coming up for {childName}</h3>
      <p>{DAILY_STATE[data.dailyPractice.state](data.dailyPractice.releaseAt, zone)}</p>
      {data.nextReviewReleases.length === 0 ? (
        /*
          HUNT7-H-4: the instruction is printed only where the control it names can be pressed, and
          the CAUSE is stated only where this card can establish it. The list is empty when the child
          has no enabled BANK subject — `storedPlan` builds the set from `child_subjects … and
          enabled` and keeps only `BANK_SUBJECTS`, `scheduleResponse` drops any release whose subject
          is not a bank subject, and with an enabled bank subject it always iterates the current AND
          next ISO week, so a future release exists (apps/api/src/routes/learning.ts). Reachable for
          an archived profile three ways: subjects turned off before archiving, only custom subjects,
          or a profile archived before the planner was ever opened, since the subjects GET skips
          `ensureLearningDefaults` for an archived one. For that profile the subject checkbox is
          permanently disabled and the add-subject form is not rendered (SubjectsSection), which says
          on this same page that subjects can't be turned on or off — so "Turn on at least one
          subject" pointed at a dead control and contradicted the section that owns it. That is the
          two-sections-disagree defect of BUG-282 and HUNT5-F-10 a third time, so the sentence names
          the parent's real move. A draft profile keeps the instruction: the same guard keeps its
          subjects writable.

          The first attempt at that sentence asserted "no subject is on", which is not what this list
          being empty means and is FALSE for a child whose only enabled subject is CUSTOM — the
          Subjects card in this same region prints that subject as "On", a fresh contradiction of the
          same shape. `reviewSubjectOn` is computed from `subjects`, the array that card renders, so
          one value decides both; and when a review-bearing subject IS on and the list is empty all
          the same (`reviewReleases` answers !ok for both weeks on an invalid stored schedule or week
          key), the line reports the list and claims no cause at all.
        */
        <p>
          {reviewSubjectOn
            ? 'No weekly review is scheduled for this week or next.'
            : readOnly
              ? `No weekly reviews are scheduled: no subject that gets a weekly review is on, and subjects can’t be turned on or off while ${childName}’s profile is archived. Activate ${childName} again on the Children page, while a paid slot is free, to change that.`
              : receivesReview
                ? 'No weekly reviews are scheduled yet. Turn on at least one subject that PencilLift makes practice for to get a review.'
                : `No weekly reviews are scheduled yet. Turn on at least one subject that PencilLift makes practice for; a review is prepared once ${childName}’s profile is active.`}
        </p>
      ) : (
        <ul>
          {data.nextReviewReleases.map((r) => (
            <li key={`${r.subjectKey}-${r.weekKey}`}>
              <strong>{subjectName(r.subjectKey, subjects)}</strong>:{' '}
              {r.releaseAt ? formatInZone(r.releaseAt, zone) : 'not this week'} (
              {RELEASE_REASON[r.reason](r.testDate)})
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
