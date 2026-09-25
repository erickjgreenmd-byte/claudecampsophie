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
 */
export function ScheduleSection({
  childId,
  childName,
  subjects,
  refreshKey,
}: {
  childId: string;
  childName: string;
  subjects: readonly ChildSubject[];
  refreshKey: number;
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
            onSaved={(saved) => setSnapshot(saved)}
          />
          <UpcomingReleases data={data} subjects={subjects} childName={childName} />
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
  onSaved,
}: {
  path: string;
  childName: string;
  initial: LearningScheduleResponse;
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
              onChange={(e) => set('pauseFrom', e.target.value)}
              aria-invalid={errors.pause ? true : undefined}
              aria-describedby={errors.pause ? id('pause-error') : undefined}
            />
            <label htmlFor={id('pauseTo')}>Last day of the pause</label>
            <input
              id={id('pauseTo')}
              type="date"
              value={form.pauseTo}
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

      <div style={buttonRow}>
        <button type="submit" className="btn" disabled={busy !== null}>
          {busy === 'save' ? 'Saving…' : 'Save schedule'}
        </button>
      </div>
    </form>
  );
}

function UpcomingReleases({
  data,
  subjects,
  childName,
}: {
  data: LearningScheduleResponse;
  subjects: readonly ChildSubject[];
  childName: string;
}) {
  const zone = data.timezone;
  const headingId = useId();
  return (
    <div aria-labelledby={headingId} role="region">
      <h3 id={headingId}>Coming up for {childName}</h3>
      <p>{DAILY_STATE[data.dailyPractice.state](data.dailyPractice.releaseAt, zone)}</p>
      {data.nextReviewReleases.length === 0 ? (
        <p>No weekly reviews are scheduled yet. Turn on at least one subject to get a review.</p>
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
