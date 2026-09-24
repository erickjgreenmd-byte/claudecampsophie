import { useCallback, useEffect, useState } from 'react';
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
  useParentAccess,
} from '../../src/family/ui.tsx';
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

type Load<T> =
  { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; data: T };

function useApiLoad<T>(load: () => Promise<T>, key: string) {
  const [state, setState] = useState<Load<T>>({ status: 'loading' });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let active = true;
    setState((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    load().then(
      (data) => active && setState({ status: 'ready', data }),
      (error: unknown) => active && setState({ status: 'error', error }),
    );
    return () => {
      active = false;
    };
    // `load` closes over `key`; reloading is explicit through `version`.
  }, [key, version]);
  return { state, reload };
}

function Planner({ api }: { api: ApiClient }) {
  const family = useApiLoad(() => api.get('/v1/family', familyOverviewResponseSchema), 'family');
  const [childId, setChildId] = useState<string | null>(null);
  const children = family.state.status === 'ready' ? family.state.data.children : [];
  const firstChild = children[0]?.id ?? null;
  useEffect(() => {
    if (childId === null && firstChild !== null) setChildId(firstChild);
  }, [childId, firstChild]);
  const child = children.find((c) => c.id === childId) ?? null;

  return (
    <Screen>
      <Title>Practice planner</Title>
      {family.state.status === 'loading' ? <Loading label="Loading your family" /> : null}
      {family.state.status === 'error' ? (
        <ErrorBox
          message={plannerError(family.state.error).message}
          needsPin={plannerError(family.state.error).needsPin}
          onRetry={family.reload}
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
          onChange={setChildId}
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
  const base = `/v1/children/${encodeURIComponent(child.id)}`;
  const schedule = useApiLoad(
    () => api.get(`${base}/learning-schedule`, learningScheduleResponseSchema),
    `${base}/schedule`,
  );
  const subjects = useApiLoad(
    () => api.get(`${base}/subjects`, childSubjectsResponseSchema),
    `${base}/subjects`,
  );

  return (
    <>
      <Heading>{child.nickname}</Heading>
      {family.timezone ? (
        <Body muted>Times are in your family’s time zone: {family.timezone}.</Body>
      ) : null}
      {subjects.state.status === 'loading' ? <Loading label="Loading subjects" /> : null}
      {subjects.state.status === 'error' ? (
        <ErrorBox message={plannerError(subjects.state.error).message} onRetry={subjects.reload} />
      ) : null}
      {subjects.state.status === 'ready' ? (
        <SubjectToggles
          api={api}
          path={`${base}/subjects`}
          subjects={subjects.state.data.subjects}
          onChanged={() => {
            subjects.reload();
            schedule.reload();
          }}
        />
      ) : null}
      {schedule.state.status === 'loading' ? <Loading label="Loading the schedule" /> : null}
      {schedule.state.status === 'error' ? (
        <ErrorBox message={plannerError(schedule.state.error).message} onRetry={schedule.reload} />
      ) : null}
      {schedule.state.status === 'ready' ? (
        <ScheduleEditor
          api={api}
          path={`${base}/learning-schedule`}
          childName={child.nickname}
          initial={schedule.state.data}
        />
      ) : null}
    </>
  );
}

function SubjectToggles({
  api,
  path,
  subjects,
  onChanged,
}: {
  api: ApiClient;
  path: string;
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
          <Switch
            accessibilityLabel={`${subject.displayName} practice`}
            accessibilityState={{ checked: subject.enabled, disabled: busy !== null }}
            value={subject.enabled}
            disabled={busy !== null}
            onValueChange={(value) => void toggle(subject, value)}
          />
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
  initial,
}: {
  api: ApiClient;
  path: string;
  childName: string;
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

  return (
    <>
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
        <ToggleRow
          label={`Allow gentle practice reminders on ${childName}’s device`}
          value={form.childRemindersPermitted}
          onChange={(v) => set('childRemindersPermitted', v)}
        />
        <ToggleRow
          label="Quiet hours (no reminders)"
          value={form.quietEnabled}
          onChange={(v) => set('quietEnabled', v)}
        />
        {form.quietEnabled ? (
          <>
            <Field
              label={`Quiet hours start (${zone})`}
              value={form.quietStart}
              onChange={(v) => set('quietStart', v)}
              placeholder="24-hour time, like 20:00"
              error={undefined}
            />
            <Field
              label={`Quiet hours end (${zone})`}
              value={form.quietEnd}
              onChange={(v) => set('quietEnd', v)}
              placeholder="24-hour time, like 07:00"
              error={errors.quietHours}
            />
          </>
        ) : null}
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
      <Button label={busy ? 'Saving…' : 'Save schedule'} busy={busy} onPress={() => void save()} />
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
