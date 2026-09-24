import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { StandardExportKind } from '@pencillift/contracts';
import { colors, minTouchTarget, radii, spacing, typography } from '@pencillift/ui-tokens';
import { createMobileApi } from '../../src/lib/api.ts';
import {
  confirmationPhrase,
  deletableChildren,
  deletionStatusText,
  exportLine,
  familyDeletion,
  loadPrivacyOverview,
  MOBILE_EXPORT_OPTIONS,
  parentErrorMessage,
  PRIVACY_RETENTION_LINES,
  requestDeletionAction,
  requestExportAction,
  unlockAction,
  type ActionResult,
  type DeletionTarget,
  type PrivacyOverview,
} from '../../src/privacy/parent-privacy.ts';
import { parentPrivacyTokenSource } from '../../src/privacy/session.ts';

type ScreenState =
  | { status: 'not_connected' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: PrivacyOverview };

type Feedback = { area: 'export' | 'delete'; result: ActionResult; id: number } | null;

/**
 * Parent privacy screen (spec P4, P10, P14 "export/delete"; AC_ACCESS_10, AC_SECURITY_05). Request
 * a private export, delete a child's data or the whole family (typed confirmation + server-enforced
 * PIN step-up), and read how long information is kept. Logic lives in src/privacy (unit-tested).
 */
export default function ParentPrivacyScreen() {
  const tokenSource = parentPrivacyTokenSource();
  const api = useMemo(() => (tokenSource ? createMobileApi(tokenSource) : null), [tokenSource]);
  const [state, setState] = useState<ScreenState>(
    api ? { status: 'loading' } : { status: 'not_connected' },
  );
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [feedbackCount, setFeedbackCount] = useState(0);
  const [target, setTarget] = useState<DeletionTarget | null>(null);
  const [typed, setTyped] = useState('');

  const load = useCallback(async () => {
    if (!api) {
      setState({ status: 'not_connected' });
      return;
    }
    try {
      setState({ status: 'ready', data: await loadPrivacyOverview(api) });
    } catch (error) {
      setState({ status: 'error', message: parentErrorMessage(error) });
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const requestExport = async (kind: StandardExportKind) => {
    if (!api || busy !== null) return;
    setBusy(`export:${kind}`);
    setFeedback(null);
    const result = await requestExportAction(api, kind);
    setFeedbackCount((n) => n + 1);
    setFeedback({ area: 'export', result, id: feedbackCount + 1 });
    setBusy(null);
    if (result.status === 'done') await load();
  };

  const requestDeletion = async () => {
    if (!api || !target || busy !== null) return;
    setBusy('delete');
    setFeedback(null);
    const result = await requestDeletionAction(api, target, typed);
    setFeedbackCount((n) => n + 1);
    setFeedback({ area: 'delete', result, id: feedbackCount + 1 });
    setBusy(null);
    if (result.status === 'done') {
      setTarget(null);
      setTyped('');
      await load();
    }
  };

  const data = state.status === 'ready' ? state.data : null;
  const deleted = data && !data.family ? familyDeletion(data.deletions) : null;

  return (
    <SafeAreaView style={styles.screen} edges={['left', 'right', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            api ? (
              <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />
            ) : undefined
          }
        >
          <Text accessibilityRole="header" style={styles.title}>
            Privacy, export and deletion
          </Text>

          {state.status === 'not_connected' ? (
            <Text style={styles.body}>
              Parent sign-in isn’t connected on this device yet, so privacy requests can’t be sent
              from here. You can use the PencilLift parent portal on the web.
            </Text>
          ) : null}

          {state.status === 'loading' ? (
            <ActivityIndicator
              color={colors.teal}
              accessibilityLabel="Loading your privacy settings"
              style={styles.loading}
            />
          ) : null}

          {state.status === 'error' ? (
            <View accessibilityRole="alert" style={styles.card}>
              <Text style={styles.body}>{state.message}</Text>
              <Button
                label="Try again"
                onPress={() => {
                  setState({ status: 'loading' });
                  void load();
                }}
              />
            </View>
          ) : null}

          <Section title="How long we keep information">
            {PRIVACY_RETENTION_LINES.map((line) => (
              <Text key={line} style={[styles.body, styles.bullet]}>
                {`• ${line}`}
              </Text>
            ))}
          </Section>

          {data && deleted ? (
            <Section
              title={
                deleted.status === 'completed'
                  ? 'Your family account has been deleted'
                  : 'Your family account is being deleted'
              }
            >
              <Text style={styles.body}>{deletionStatusText(deleted)}</Text>
              <Text style={[styles.body, styles.spaced]}>
                Your child’s devices were signed out and queued work was cancelled.
              </Text>
            </Section>
          ) : null}

          {data && !data.family && !deleted ? (
            <Text style={styles.body}>
              There is no family on this account yet. Set up your family first.
            </Text>
          ) : null}

          {data?.family ? (
            <>
              <Section title="Export your data">
                <Text style={styles.body}>
                  Each request needs a recent parent PIN unlock. Export files aren’t prepared
                  automatically yet: your request is saved and its status is shown here, and there
                  is nothing to download until the export service is switched on.
                </Text>
                {MOBILE_EXPORT_OPTIONS.map((option) => (
                  <Button
                    key={option.kind}
                    label={
                      busy === `export:${option.kind}` ? 'Requesting…' : `Request ${option.label}`
                    }
                    disabled={busy !== null}
                    secondary
                    onPress={() => void requestExport(option.kind)}
                  />
                ))}
                {feedback?.area === 'export' ? (
                  <ResultView key={feedback.id} result={feedback.result} api={api} />
                ) : null}
                <Text accessibilityRole="header" style={styles.subheading}>
                  Your exports
                </Text>
                {data.exports.length === 0 ? (
                  <Text style={styles.body}>No exports requested yet.</Text>
                ) : (
                  data.exports.map((item) => (
                    <Text key={item.id} style={[styles.body, styles.bullet]}>
                      {`• ${exportLine(item)}`}
                    </Text>
                  ))
                )}
              </Section>

              <Section title="Delete data">
                <View style={styles.warning}>
                  <Text style={[styles.body, styles.bold]}>
                    Deleting your PencilLift account does not cancel an App Store or Google Play
                    subscription. Cancel it in the store first.
                  </Text>
                </View>
                <Text style={[styles.body, styles.spaced]}>
                  Deleting stops processing immediately and signs out the affected devices. This
                  can’t be undone. Choose what to delete:
                </Text>
                {deletableChildren(data.family, data.deletions).map((child) => (
                  <Choice
                    key={child.id}
                    label={`${child.nickname}’s data`}
                    selected={target?.scope === 'child' && target.childId === child.id}
                    onPress={() => {
                      setTarget({ scope: 'child', childId: child.id, nickname: child.nickname });
                      setTyped('');
                      setFeedback(null);
                    }}
                  />
                ))}
                <Choice
                  label="Our whole family account (owner only)"
                  selected={target?.scope === 'family'}
                  onPress={() => {
                    setTarget({ scope: 'family' });
                    setTyped('');
                    setFeedback(null);
                  }}
                />
                {target ? (
                  <>
                    <Text nativeID="confirm-label" style={[styles.body, styles.spaced]}>
                      {`Type ${confirmationPhrase(target)} to confirm`}
                    </Text>
                    <TextInput
                      accessibilityLabel={`Type ${confirmationPhrase(target)} to confirm`}
                      accessibilityLabelledBy="confirm-label"
                      autoCapitalize={target.scope === 'family' ? 'characters' : 'none'}
                      autoCorrect={false}
                      value={typed}
                      onChangeText={setTyped}
                      style={styles.input}
                    />
                    <Button
                      label={busy === 'delete' ? 'Requesting…' : 'Request deletion'}
                      danger
                      disabled={busy !== null}
                      onPress={() => void requestDeletion()}
                    />
                  </>
                ) : null}
                {feedback?.area === 'delete' ? (
                  <ResultView key={feedback.id} result={feedback.result} api={api} />
                ) : null}
                <Text accessibilityRole="header" style={styles.subheading}>
                  Deletion requests
                </Text>
                {data.deletions.length === 0 ? (
                  <Text style={styles.body}>No deletion requests.</Text>
                ) : (
                  data.deletions.map((d) => (
                    <Text key={d.id} style={[styles.body, styles.bullet]}>
                      {`• ${
                        d.scope === 'family'
                          ? 'Whole family account'
                          : `${data.family?.children.find((c) => c.id === d.childId)?.nickname ?? 'A removed child profile'}’s data`
                      }: ${deletionStatusText(d)}`}
                    </Text>
                  ))
                )}
              </Section>
            </>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.heading}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function Button({
  label,
  onPress,
  disabled = false,
  secondary = false,
  danger = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        secondary && styles.buttonSecondary,
        danger && styles.buttonDanger,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.buttonText, secondary && styles.buttonTextSecondary]}>{label}</Text>
    </Pressable>
  );
}

function Choice({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected, checked: selected }}
      onPress={onPress}
      style={[styles.choice, selected && styles.choiceSelected]}
    >
      {/* Selection is shown with a mark and a border, not colour alone. */}
      <Text style={styles.body}>{`${selected ? '◉' : '○'}  ${label}`}</Text>
    </Pressable>
  );
}

/** Outcome of an action, including the inline PIN step-up when the server asks for it. */
function ResultView({
  result,
  api,
}: {
  result: ActionResult;
  api: ReturnType<typeof createMobileApi> | null;
}) {
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [busy, setBusy] = useState(false);

  if (result.status === 'done') {
    return (
      <Text accessibilityLiveRegion="polite" style={[styles.body, styles.success]}>
        {`✓ ${result.message}`}
      </Text>
    );
  }
  if (result.status === 'error') {
    return (
      <Text accessibilityRole="alert" style={[styles.body, styles.problem]}>
        {result.message}
      </Text>
    );
  }
  if (unlocked) {
    return (
      <Text accessibilityLiveRegion="polite" style={[styles.body, styles.success]}>
        ✓ Unlocked. Press the button again to continue.
      </Text>
    );
  }
  const submit = async () => {
    if (!api || busy) return;
    setBusy(true);
    const outcome = await unlockAction(api, pin);
    setPin('');
    setBusy(false);
    if (outcome.ok) {
      setUnlocked(true);
    } else {
      setMessage(outcome.message);
    }
  };
  return (
    <View accessibilityRole="alert" style={styles.warning}>
      <Text style={[styles.body, styles.bold]}>Enter your parent PIN to continue</Text>
      <Text style={styles.body}>
        This needs a recent PIN unlock, checked by PencilLift’s servers.
      </Text>
      <TextInput
        accessibilityLabel="Parent PIN"
        secureTextEntry
        keyboardType="number-pad"
        maxLength={6}
        value={pin}
        onChangeText={(v) => {
          setPin(v.replace(/\D/g, '').slice(0, 6));
          setMessage(null);
        }}
        style={styles.input}
      />
      {message ? <Text style={[styles.body, styles.problem]}>{message}</Text> : null}
      <Button label={busy ? 'Checking…' : 'Unlock'} disabled={busy} onPress={() => void submit()} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.offWhite },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  title: {
    fontSize: typography.scale.xxl,
    fontWeight: '800',
    color: colors.navy,
    marginBottom: spacing.md,
  },
  heading: {
    fontSize: typography.scale.lg,
    fontWeight: '800',
    color: colors.navy,
    marginBottom: spacing.sm,
  },
  subheading: {
    fontSize: typography.scale.md,
    fontWeight: '800',
    color: colors.navy,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  body: { fontSize: typography.scale.md, color: colors.navy },
  bold: { fontWeight: '800' },
  bullet: { marginTop: spacing.xs },
  spaced: { marginTop: spacing.sm },
  loading: { marginVertical: spacing.lg },
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.lg,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  warning: {
    borderLeftWidth: 4,
    borderLeftColor: colors.gold,
    backgroundColor: '#FFF8EB',
    borderRadius: radii.sm,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  input: {
    minHeight: minTouchTarget,
    borderWidth: 1,
    borderColor: colors.muted,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    fontSize: typography.scale.md,
    color: colors.navy,
    backgroundColor: colors.white,
    marginTop: spacing.xs,
  },
  button: {
    minHeight: minTouchTarget,
    borderRadius: radii.pill,
    backgroundColor: colors.teal,
    borderWidth: 2,
    borderColor: colors.teal,
    paddingHorizontal: spacing.lg,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  buttonSecondary: { backgroundColor: colors.white },
  buttonDanger: { backgroundColor: colors.danger, borderColor: colors.danger },
  buttonText: { color: colors.white, fontWeight: '800', fontSize: typography.scale.md },
  buttonTextSecondary: { color: colors.tealText },
  disabled: { opacity: 0.55 },
  choice: {
    minHeight: minTouchTarget,
    borderWidth: 2,
    borderColor: colors.muted,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  choiceSelected: { borderColor: colors.teal, borderWidth: 3 },
  success: { color: colors.success, fontWeight: '800', marginTop: spacing.sm },
  problem: { color: colors.danger, marginTop: spacing.sm },
});
