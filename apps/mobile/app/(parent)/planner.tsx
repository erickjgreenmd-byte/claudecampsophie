import { useCallback, useState } from 'react';
import { Pressable, Switch, Text, TextInput, View } from 'react-native';
import {
  LEARNING_LIMITS,
  childSubjectResponseSchema,
  childSubjectsResponseSchema,
  familyOverviewResponseSchema,
  learningScheduleResponseSchema,
  type ChildSubject,
  type FamilyOverview,
  type LearningScheduleResponse,
} from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { colors } from '@pencillift/ui-tokens';
import {
  Body,
  Button,
  Card,
  Choice,
  ErrorBox,
  Heading,
  Loading,
  Notice,
  ParentAccessState,
  Screen,
  Title,
  styles,
  useLoad,
  useParentAccess,
} from '../../src/family/ui.tsx';
import { childPlanEditable } from '../../src/family/family-view.ts';
import {
  WEEKDAY_OPTIONS,
  buildUpcomingView,
  plannerError,
  scheduleToPlannerForm,
  stepCount,
  validatePlannerForm,
  type PlannerField,
  type PlannerForm,
} from '../../src/learning/planner-form.ts';

/**
 * Parent practice planner on the phone (spec P7, P8, P14 "practice/review planner"). The schedule
 * essentials: which subjects are on, review day and time, questions per subject, daily time and
 * count, a vacation pause and quiet hours — all in the family's time zone, which is named. Test
 * dates, teacher lists, skills and answer keys are in the parent portal's Learning planner.
 */
export default function PlannerScreen() {
  const access = useParentAccess();
  if (access.status !== 'ready') {
    return (
      <Screen>
        <Title>Practice planner</Title>
        <ParentAccessState access={access} />
      </Screen>
    );
  }
  return <Planner api={access.api} />;
}

/**
 * The screen loads through the shared `useLoad` (src/family/ui.tsx), like every other parent screen.
 * It used to run its own hook whose effect depended on a literal path string and a manual counter, so
 * a new client — which is what the parent gate publishes when the adult at the device has changed —
 * re-rendered this screen without re-running a single load: the next adult read the previous family's
 * children, subject toggles and practice schedule, with no request made at all (HUNT6-I-1). The whole
 * HUNT5-H-1 fix rests on the screens keying their loads on the client, and this one did not.
 *
 * Re-loading on a new client is only half of it: the CHILD the screen is showing is a choice, and a
 * choice made in one family means nothing in the next. Setting it once from an effect ("if it is null
 * and a first child exists") left the previous family's child id in place across the load, and with
 * that id in none of the new family's children the screen fell out of every branch it has: no
 * loading, no error, no empty-family notice, no plan — a blank screen under the title for a family
 * with one child, and a <Choice> holding a value that is not one of its options for a family with
 * more. So the selection is DERIVED from the family that is loaded, on every render, and the screen's
 * four states (loading / error / no children / one named child's plan) cover every case between them.
 */
function Planner({ api }: { api: ApiClient }) {
  const loadFamily = useCallback(() => api.get('/v1/family', familyOverviewResponseSchema), [api]);
  const family = useLoad(loadFamily);
  /** What the parent last tapped. It says nothing about which family is loaded now. */
  const [picked, setPicked] = useState<string | null>(null);
  const children = family.state.status === 'ready' ? family.state.data.children : [];
  // The pick counts only while the loaded family still has that child; otherwise the family's first
  // child is the selection. Derived, so a load can never leave a selection the family cannot answer
  // for: `childId` is either null (no children loaded) or one of `children`, which is what makes the
  // <Choice> below always hold one of its own options and `child` always resolve when there are any.
  const childId = children.some((c) => c.id === picked) ? picked : (children[0]?.id ?? null);
  const child = children.find((c) => c.id === childId) ?? null;

  return (
    <Screen>
      <Title>Practice planner</Title>
      {family.state.status === 'idle' || family.state.status === 'loading' ? (
        <Loading label="Loading your family" />
      ) : null}
      {family.state.status === 'error' ? (
        <ErrorBox
          message={plannerError(family.state.error).message}
          needsPin={plannerError(family.state.error).needsPin}
          onRetry={() => void family.reload()}
        />
      ) : null}
      {family.state.status === 'ready' && children.length === 0 ? (
        <Notice>
          <Body>Add a child first, then plan their practice here.</Body>
        </Notice>
      ) : null}
      {children.length > 1 && childId !== null ? (
        <Choice
          label="Child"
          options={children.map((c) => ({ value: c.id, label: c.nickname }))}
          value={childId}
          onChange={setPicked}
        />
      ) : null}
      {child && family.state.status === 'ready' ? (
        <ChildPlan key={child.id} api={api} child={child} family={family.state.data} />
      ) : null}
    </Screen>
  );
}

function ChildPlan({
  api,
  child,
  family,
}: {
  api: ApiClient;
  child: FamilyOverview['children'][number];
  family: FamilyOverview;
}) {
  // The API refuses every learning write for an archived profile (HUNT6-H-1), so no control for one is
  // offered: the stored plan stays readable, which is what archiving promises.
  const editable = childPlanEditable(child.status);
  const base = `/v1/children/${encodeURIComponent(child.id)}`;
  const loadSchedule = useCallback(
    () => api.get(`${base}/learning-schedule`, learningScheduleResponseSchema),
    [api, base],
  );
  const schedule = useLoad(loadSchedule);
  const loadSubjects = useCallback(
    () => api.get(`${base}/subjects`, childSubjectsResponseSchema),
    [api, base],
  );
  const subjects = useLoad(loadSubjects);

  return (
    <>
      <Heading>{child.nickname}</Heading>
      {editable ? null : (
        <Notice>
          <Body>
            {child.nickname} is archived, so their practice plan is read-only. Everything below is
            what was planned; make them active again in Children to change it.
          </Body>
        </Notice>
      )}
      {family.timezone ? (
        <Body muted>Times are in your family’s time zone: {family.timezone}.</Body>
      ) : null}
      {subjects.state.status === 'idle' || subjects.state.status === 'loading' ? (
        <Loading label="Loading subjects" />
      ) : null}
      {subjects.state.status === 'error' ? (
        <ErrorBox
          message={plannerError(subjects.state.error).message}
          onRetry={() => void subjects.reload()}
        />
      ) : null}
      {subjects.state.status === 'ready' ? (
        <SubjectToggles
          api={api}
          path={`${base}/subjects`}
          editable={editable}
          subjects={subjects.state.data.subjects}
          onChanged={() => {
            void subjects.reload();
            void schedule.reload();
          }}
        />
      ) : null}
      {schedule.state.status === 'idle' || schedule.state.status === 'loading' ? (
        <Loading label="Loading the schedule" />
      ) : null}
      {schedule.state.status === 'error' ? (
        <ErrorBox
          message={plannerError(schedule.state.error).message}
          onRetry={() => void schedule.reload()}
        />
      ) : null}
      {schedule.state.status === 'ready' ? (
        <ScheduleEditor
          api={api}
          path={`${base}/learning-schedule`}
          childName={child.nickname}
          editable={editable}
          initial={schedule.state.data}
        />
      ) : null}
    </>
  );
}

function SubjectToggles({
  api,
  path,
  editable,
  subjects,
  onChanged,
}: {
  api: ApiClient;
  path: string;
  /** False for an archived child: PATCH /subjects is refused 422 CHILD_ARCHIVED (HUNT6-H-1). */
  editable: boolean;
  subjects: readonly ChildSubject[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ message: string; needsPin: boolean } | null>(null);

  const toggle = async (subject: ChildSubject, enabled: boolean) => {
    setBusy(subject.id);
    setProblem(null);
    try {
      await api.send('PATCH', path, { subjectId: subject.id, enabled }, childSubjectResponseSchema);
      onChanged();
    } catch (error) {
      setProblem(plannerError(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <Heading>Subjects</Heading>
      <Body muted>Subjects that are on get daily questions and a weekly review.</Body>
      {editable ? null : <Body muted>These can’t be changed while this child is archived.</Body>}
      {problem ? <ErrorBox message={problem.message} needsPin={problem.needsPin} /> : null}
      {subjects.map((subject) => (
        <View
          key={subject.id}
          style={[
            styles.row,
            { alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
          ]}
        >
          <Text style={styles.body}>
            {subject.displayName}
            {subject.generatedPractice ? '' : ' (no generated practice)'} ·{' '}
            {subject.enabled ? 'On' : 'Off'}
          </Text>
          {editable ? (
            <Switch
              accessibilityLabel={`${subject.displayName} practice`}
              accessibilityState={{ checked: subject.enabled, disabled: busy !== null }}
              value={subject.enabled}
              disabled={busy !== null}
              onValueChange={(value) => void toggle(subject, value)}
            />
          ) : null}
        </View>
      ))}
    </Card>
  );
}

function Stepper({
  label,
  value,
  limits,
  onChange,
  error,
}: {
  label: string;
  value: number;
  limits: { readonly min: number; readonly max: number };
  onChange: (value: number) => void;
  error: string | undefined;
}) {
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min: limits.min, max: limits.max, now: value, text: String(value) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) =>
        onChange(stepCount(value, e.nativeEvent.actionName === 'increment' ? 1 : -1, limits))
      }
    >
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.row, { alignItems: 'center' }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Fewer: ${label}`}
          onPress={() => onChange(stepCount(value, -1, limits))}
          style={styles.chip}
        >
          <Text style={styles.chipText}>−</Text>
        </Pressable>
        <Text style={[styles.body, { minWidth: 32, textAlign: 'center' }]}>{value}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`More: ${label}`}
          onPress={() => onChange(stepCount(value, 1, limits))}
          style={styles.chip}
        >
          <Text style={styles.chipText}>+</Text>
        </Pressable>
        <Text style={[styles.body, styles.muted]}>
          ({limits.min}–{limits.max})
        </Text>
      </View>
      {error ? <Text style={[styles.body, { color: colors.danger }]}>{error}</Text> : null}
    </View>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  error: string | undefined;
}) {
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={placeholder}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        keyboardType="numbers-and-punctuation"
        autoCorrect={false}
        autoCapitalize="none"
        style={styles.input}
      />
      {error ? (
        <Text accessibilityRole="alert" style={[styles.body, { color: colors.danger }]}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function ScheduleEditor({
  api,
  path,
  childName,
  editable,
  initial,
}: {
  api: ApiClient;
  path: string;
  childName: string;
  /** False for an archived child: PUT /learning-schedule is refused 422 CHILD_ARCHIVED (HUNT6-H-1). */
  editable: boolean;
  initial: LearningScheduleResponse;
}) {
  const [latest, setLatest] = useState(initial);
  const [form, setForm] = useState<PlannerForm>(() => scheduleToPlannerForm(initial.schedule));
  const [errors, setErrors] = useState<Partial<Record<PlannerField, string>>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    { ok: true; message: string } | { ok: false; message: string; needsPin: boolean } | null
  >(null);
  const zone = latest.timezone;
  const upcoming = buildUpcomingView(latest, childName);
  const set = <K extends keyof PlannerForm>(key: K, value: PlannerForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    const checked = validatePlannerForm(form);
    if (!checked.ok) {
      setErrors(checked.errors);
      setResult({ ok: false, message: 'Please check the highlighted fields.', needsPin: false });
      return;
    }
    setErrors({});
    setBusy(true);
    setResult(null);
    try {
      const saved = await api.send('PUT', path, checked.value, learningScheduleResponseSchema);
      setLatest(saved);
      setForm(scheduleToPlannerForm(saved.schedule));
      setResult({ ok: true, message: `Schedule saved for ${childName}.` });
    } catch (error) {
      setResult({ ok: false, ...plannerError(error) });
    } finally {
      setBusy(false);
    }
  };

  const comingUp = (
    <Card>
      <Heading>Coming up</Heading>
      <Body>{upcoming.dailyLine}</Body>
      {upcoming.reviewLines.length === 0 ? (
        <Body muted>No weekly reviews are scheduled yet.</Body>
      ) : (
        upcoming.reviewLines.map((line) => <Body key={line}>{line}</Body>)
      )}
      <Body muted>{upcoming.pointsLine}</Body>
    </Card>
  );

  // An archived child's plan is shown, never offered for editing (HUNT6-H-1): the fields below are
  // left out rather than disabled, so there is nothing to type into and nothing to lose on a Save the
  // server would refuse.
  if (!editable) {
    return (
      <>
        {comingUp}
        <Card>
          <Heading>Weekly review and daily practice</Heading>
          <Body>
            Review {WEEKDAY_OPTIONS.find((day) => day.value === form.reviewWeekday)?.label ?? ''} at{' '}
            {form.reviewLocalTime} ({zone}), {form.reviewQuestionsPerSubject} questions per subject.
          </Body>
          <Body>
            Daily practice at {form.dailyLocalTime} ({zone}), {form.dailyQuestionCount} questions.
          </Body>
          {form.pauseEnabled ? (
            <Body>
              Paused from {form.pauseFrom} to {form.pauseTo}.
            </Body>
          ) : null}
        </Card>
        <Body muted>
          Test dates, teacher spelling lists, skills and answer keys are in the Learning planner of
          the parent portal.
        </Body>
      </>
    );
  }

  return (
    <>
      {comingUp}

      <Card>
        <Heading>Weekly review</Heading>
        <Choice
          label="Review day"
          options={WEEKDAY_OPTIONS}
          value={form.reviewWeekday}
          onChange={(v) => set('reviewWeekday', v)}
        />
        <Field
          label={`Review time (${zone})`}
          value={form.reviewLocalTime}
          onChange={(v) => set('reviewLocalTime', v)}
          placeholder="24-hour time, like 16:00"
          error={errors.reviewLocalTime}
        />
        <Stepper
          label="Questions per subject"
          value={form.reviewQuestionsPerSubject}
          limits={LEARNING_LIMITS.reviewQuestionsPerSubject}
          onChange={(v) => set('reviewQuestionsPerSubject', v)}
          error={errors.reviewQuestionsPerSubject}
        />
      </Card>

      <Card>
        <Heading>Daily practice</Heading>
        <Body muted>Offered every day, weekends included.</Body>
        <Field
          label={`Daily practice time (${zone})`}
          value={form.dailyLocalTime}
          onChange={(v) => set('dailyLocalTime', v)}
          placeholder="24-hour time, like 15:30"
          error={errors.dailyLocalTime}
        />
        <Stepper
          label="Daily questions"
          value={form.dailyQuestionCount}
          limits={LEARNING_LIMITS.dailyQuestionCount}
          onChange={(v) => set('dailyQuestionCount', v)}
          error={errors.dailyQuestionCount}
        />
        <ToggleRow
          label="Pause daily practice for a vacation"
          value={form.pauseEnabled}
          onChange={(v) => set('pauseEnabled', v)}
        />
        {form.pauseEnabled ? (
          <>
            <Field
              label="First day of the pause"
              value={form.pauseFrom}
              onChange={(v) => set('pauseFrom', v)}
              placeholder="YYYY-MM-DD"
              error={undefined}
            />
            <Field
              label="Last day of the pause"
              value={form.pauseTo}
              onChange={(v) => set('pauseTo', v)}
              placeholder="YYYY-MM-DD"
              error={errors.pause}
            />
          </>
        ) : null}
      </Card>

      <Card>
        <Heading>Reminders</Heading>
        {/* The app sends no notifications (no push stack in this build), so the reminder and
            quiet-hours controls are not offered: the copy must match what is delivered
            (AC_SECURITY_02; MOB-R1-05). The schedule keeps its stored reminder fields unchanged. */}
        <Body muted>
          Practice reminders and quiet hours aren’t available yet. PencilLift doesn’t send
          notifications to {childName}’s device in this version; when reminders arrive, you’ll
          choose here whether to allow them and when to keep things quiet.
        </Body>
      </Card>

      {result ? (
        result.ok ? (
          <Notice>
            <Body>{result.message}</Body>
          </Notice>
        ) : (
          <ErrorBox message={result.message} needsPin={result.needsPin} />
        )
      ) : null}
      {editable ? (
        <Button
          label={busy ? 'Saving…' : 'Save schedule'}
          busy={busy}
          onPress={() => void save()}
        />
      ) : null}
      <Body muted>
        Test dates, teacher spelling lists, skills and answer keys are in the Learning planner of
        the parent portal.
      </Body>
    </>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View
      style={[styles.row, { alignItems: 'center', justifyContent: 'space-between', minHeight: 44 }]}
    >
      <Text style={[styles.body, { flexShrink: 1 }]}>{label}</Text>
      <Switch
        accessibilityLabel={label}
        accessibilityState={{ checked: value }}
        value={value}
        onValueChange={onChange}
      />
    </View>
  );
}
