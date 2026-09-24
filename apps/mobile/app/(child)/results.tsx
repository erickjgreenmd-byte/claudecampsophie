import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import {
  childAssignmentDetailResponseSchema,
  childAssignmentListResponseSchema,
  type ChildAssignmentSummary,
} from '@pencillift/contracts';
import { colors, minTouchTarget, radii, spacing, typography } from '@pencillift/ui-tokens';
import { childApi } from '../../src/homework/child-api.ts';
import {
  buildResultView,
  childLoadMessage,
  findForbiddenKeys,
  statusView,
  type ResultView,
  type VerdictTone,
} from '../../src/homework/result-view.ts';

/**
 * Child results (spec P6, P14 child "results"; AC_GRADING_06, AC_UX_02). "Correct" / "Try again" with
 * an icon and accessible text; unresolved work says "Let's get a clearer picture" or "Ask a grown-up
 * to review this". The child sees their own answer and guarded hints — never an answer key, solution
 * or confidence score (the response contract cannot carry one).
 */
export default function ResultsScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const id = typeof params.id === 'string' && params.id.length > 0 ? params.id : null;
  return (
    <SafeAreaView style={styles.screen}>
      {id ? <ResultDetail id={id} /> : <ScanList />}
    </SafeAreaView>
  );
}

type Load<T> =
  { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: T };

function useLoad<T>(load: () => Promise<T>, key: string): Load<T> & { reload: () => void } {
  const [state, setState] = useState<Load<T>>({ kind: 'loading' });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    load().then(
      (data) => active && setState({ kind: 'ready', data }),
      (error: unknown) => active && setState({ kind: 'error', message: childLoadMessage(error) }),
    );
    return () => {
      active = false;
    };
    // `load` closes over `key`; reloading is explicit through `version`.
  }, [key, version]);
  return { ...state, reload };
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function ScanList() {
  const state = useLoad(
    () => childApi.get('/v1/child/assignments', childAssignmentListResponseSchema),
    'list',
  );
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title} accessibilityRole="header">
        My scans
      </Text>
      {state.kind === 'loading' ? <Loading /> : null}
      {state.kind === 'error' ? <LoadError message={state.message} onRetry={state.reload} /> : null}
      {state.kind === 'ready' && state.data.assignments.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.body}>No scans yet. When you scan homework, it shows up here.</Text>
          <Button label="Scan homework" onPress={() => router.push('/scan')} />
        </View>
      ) : null}
      {state.kind === 'ready'
        ? state.data.assignments.map((a) => <ScanRow key={a.id} assignment={a} />)
        : null}
    </ScrollView>
  );
}

function ScanRow({ assignment }: { assignment: ChildAssignmentSummary }) {
  const view = statusView(assignment.status);
  const label = `Scan from ${formatDay(assignment.createdAt)}. ${view.title}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => router.push({ pathname: '/results', params: { id: assignment.id } })}
      style={styles.row}
    >
      <Text style={styles.cardTitle}>Scan from {formatDay(assignment.createdAt)}</Text>
      <Text style={styles.body}>{view.title}</Text>
    </Pressable>
  );
}

function ResultDetail({ id }: { id: string }) {
  const state = useLoad(async (): Promise<ResultView> => {
    const detail = await childApi.get(
      `/v1/child/assignments/${encodeURIComponent(id)}`,
      childAssignmentDetailResponseSchema,
    );
    // Fail closed if anything answer-key-like ever reaches the device (AC_GRADING_06).
    if (findForbiddenKeys(detail).length > 0) throw new Error('unsafe payload');
    return buildResultView(detail);
  }, id);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {state.kind === 'loading' ? <Loading /> : null}
      {state.kind === 'error' ? <LoadError message={state.message} onRetry={state.reload} /> : null}
      {state.kind === 'ready' ? (
        <>
          <Text style={styles.title} accessibilityRole="header">
            {state.data.status.title}
          </Text>
          {state.data.status.body ? (
            <Text style={styles.body}>{state.data.status.body}</Text>
          ) : null}
          {state.data.summary ? (
            <Text style={styles.summary} accessibilityLabel={`Summary: ${state.data.summary}`}>
              {state.data.summary}
            </Text>
          ) : null}
          {state.data.status.inProgress ? (
            <Button label="Check again" onPress={state.reload} />
          ) : null}
          {state.data.status.title === 'Let’s get a clearer picture' ||
          state.data.status.title === 'Let’s try a new scan' ? (
            <Button label="Scan again" onPress={() => router.push('/scan')} />
          ) : null}
          {state.data.questions.map((q) => (
            <View key={q.id} style={styles.card}>
              <Text style={styles.cardTitle}>{q.label}</Text>
              <Text style={styles.body}>{q.prompt}</Text>
              <Text style={styles.body}>
                <Text style={styles.label}>Your answer: </Text>
                {q.yourAnswer}
              </Text>
              <View
                style={[styles.chip, toneStyle(q.verdict.tone)]}
                accessible
                accessibilityLabel={q.verdict.accessibilityLabel}
              >
                <Text style={styles.chipIcon} importantForAccessibility="no">
                  {q.verdict.icon}
                </Text>
                <Text style={styles.chipText}>{q.verdict.title}</Text>
              </View>
              {q.hints.map((hint, i) => (
                <Text key={i} style={styles.hint}>
                  <Text style={styles.label}>Hint: </Text>
                  {hint}
                </Text>
              ))}
            </View>
          ))}
          <Button label="All my scans" secondary onPress={() => router.push('/results')} />
        </>
      ) : null}
    </ScrollView>
  );
}

function toneStyle(tone: VerdictTone) {
  switch (tone) {
    case 'success':
      return { borderColor: colors.success };
    case 'retry':
      return { borderColor: colors.teal };
    case 'help':
      return { borderColor: colors.gold };
    case 'info':
      return { borderColor: colors.navy };
    case 'pending':
      return { borderColor: colors.muted };
  }
}

function Loading() {
  return (
    <View style={styles.center} accessibilityRole="progressbar" accessibilityLabel="Loading">
      <ActivityIndicator color={colors.teal} />
      <Text style={styles.body}>Loading…</Text>
    </View>
  );
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={styles.card} accessibilityRole="alert">
      <Text style={styles.body}>{message}</Text>
      <Button label="Try loading again" onPress={onRetry} />
    </View>
  );
}

function Button({
  label,
  onPress,
  secondary = false,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.button, secondary ? styles.buttonSecondary : null]}
    >
      <Text style={[styles.buttonText, secondary ? { color: colors.tealText } : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.offWhite },
  content: { padding: spacing.md, gap: spacing.md },
  center: { alignItems: 'center', gap: spacing.sm, padding: spacing.lg },
  title: { fontSize: typography.scale.xl, fontWeight: '800', color: colors.navy },
  body: { fontSize: typography.scale.md, color: colors.navy },
  label: { fontWeight: '800' },
  summary: { fontSize: typography.scale.md, fontWeight: '700', color: colors.navy },
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardTitle: { fontSize: typography.scale.md, fontWeight: '800', color: colors.navy },
  row: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    minHeight: minTouchTarget,
    gap: spacing.xs,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.sm,
    borderWidth: 2,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    minHeight: minTouchTarget,
  },
  chipIcon: { fontSize: typography.scale.lg, color: colors.navy },
  chipText: { fontSize: typography.scale.md, fontWeight: '800', color: colors.navy },
  hint: {
    fontSize: typography.scale.md,
    color: colors.navy,
    backgroundColor: colors.offWhite,
    padding: spacing.sm,
    borderRadius: radii.sm,
  },
  button: {
    minHeight: minTouchTarget,
    borderRadius: radii.pill,
    backgroundColor: colors.teal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  buttonSecondary: { backgroundColor: colors.white, borderWidth: 2, borderColor: colors.teal },
  buttonText: { color: colors.white, fontSize: typography.scale.md, fontWeight: '800' },
});
