import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
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
import { router } from 'expo-router';
import {
  ACCOUNT_CLOSE_COPY,
  DELETION_INTRO,
  deletionConfirmationCopy,
  deletionRequestLabel,
  PARENT_SAFETY_FLAG_COPY,
  privacyRetentionLines,
  DATA_PRACTICES_COPY,
} from '@pencillift/contracts';
import type {
  DeletionTarget,
  ParentReportOutcome,
  StandardExportKind,
} from '@pencillift/contracts';
import { colors, minTouchTarget, radii, spacing, typography } from '@pencillift/ui-tokens';
import { storeChannelForBuild } from '../../src/billing/revenuecat.ts';
import { BrandRow } from '../../src/brand/BrandMark.tsx';
import { ParentAccessState, useParentAccess } from '../../src/family/ui.tsx';
import { createMobileApi } from '../../src/lib/api.ts';
import {
  dataPracticesDetail,
  loadDataPractices,
  UNKNOWN_DATA_PRACTICES,
  type DataPracticesState,
} from '../../src/privacy/data-practices.ts';
import { signOutClosedAccountOnDevice } from '../../src/family/runtime.ts';
import {
  deletableChildren,
  deletionStatusText,
  exportDownloadAction,
  exportLine,
  familyDeletion,
  loadPrivacyOverview,
  MOBILE_EXPORT_OPTIONS,
  parentErrorMessage,
  reportOutcomeAction,
  requestDeletionAction,
  requestExportAction,
  runAccountClosure,
  SAFETY_REPORTS_INTRO,
  safetyReportView,
  unlockAction,
  type ActionResult,
  type PrivacyOverview,
} from '../../src/privacy/parent-privacy.ts';
import { parentPrivacyTokenSource } from '../../src/privacy/session.ts';

type ScreenState =
  | { status: 'not_connected' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: PrivacyOverview }
  /**
   * The parent deleted their own sign-in and the closure is over: only the outcome remains, and this
   * screen has nothing left to offer. It does NOT mean the device is signed out, which is what this
   * comment used to claim (HUNT6-J-6): the closure goes through the whole device sign-out, but the
   * session end and the two secret clears are reported rather than assumed (HUNT6-J-1), and `message`
   * is what says whether this device really was signed out.
   */
  | { status: 'account_closed'; message: string }
  /**
   * The server has closed the sign-in and the device sign-out is still running (HUNT6-J-2). Its own
   * state rather than a busy flag, because `data` is null here: the whole "Delete my account" section
   * — including a second, live "Delete my account" button — is off the screen for the length of the
   * operation, not just for the API call.
   */
  | { status: 'closing' };

type Feedback =
  | { area: 'export' | 'delete' | 'account'; result: ActionResult; id: number }
  | { area: 'report'; reportId: string; result: ActionResult; id: number }
  | null;

/**
 * Parent privacy screen (spec P4, P10, P14 "export/delete"; AC_ACCESS_10, AC_SECURITY_05; Apple
 * 5.1.1(v) / Google Play account deletion). Request a private export and open a ready one, delete a
 * child's data or the whole family (typed confirmation + server-enforced PIN step-up), delete the
 * parent's own sign-in, read how long information is kept, and follow the family's safety reports: every
 * flag is listed with the recorded state of the guardian email, and a guardian can mark it looked
 * into or a false alarm (owner decision, 2026-09-25; same wording as the web portal). Logic lives
 * in src/privacy (unit-tested).
 */
export default function ParentPrivacyScreen() {
  // Same gate as every parent screen (MOB-R1-09): child mode, a signed-out parent and a device
  // that has not entered the PIN since the app started all stop here, deep link or not.
  const access = useParentAccess();
  const tokenSource = parentPrivacyTokenSource();
  const api = useMemo(() => (tokenSource ? createMobileApi(tokenSource) : null), [tokenSource]);
  const [state, setState] = useState<ScreenState>(
    api ? { status: 'loading' } : { status: 'not_connected' },
  );
  const [refreshing, setRefreshing] = useState(false);
  /**
   * The published data-practices states for the section below.
   *
   * Loaded inside this screen's own `load`, through this screen's own client, NOT by a second effect
   * with a client of its own: `screens-r2.review.test.ts`'s HUNT6-I-1 walker forbids a load hook a
   * new client cannot re-run, and it was right to fire on the first version of this. The endpoint is
   * public, so a parent token is not needed — but a fetch that ignores the gate's client is the
   * shape of BUG-335 whether or not this particular fetch could go stale, and the strip in
   * `(parent)/_layout.tsx` already covers the screens where there is no client at all.
   */
  const [practices, setPractices] = useState<DataPracticesState>(UNKNOWN_DATA_PRACTICES);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [feedbackCount, setFeedbackCount] = useState(0);
  const [target, setTarget] = useState<DeletionTarget | null>(null);
  const [typed, setTyped] = useState('');
  /**
   * The store this build sells through (App Store, Google Play or, on Fire tablets, the Amazon
   * Appstore), or null for a build sold through no store (Expo web), which then names every store
   * rather than guessing one (MOB-R1-10). It is only ever handed to the contracts' copy functions,
   * which decide the sentence; the screen never turns it into words of its own.
   */
  const buildStore = useMemo(() => storeChannelForBuild(), []);
  const [closeConfirmed, setCloseConfirmed] = useState(false);
  /**
   * The closure has started, so this screen is its outcome and nothing else (HUNT6-J-2). A ref, not
   * state: the reload effect below must not replace that outcome, and the sign-out inside the closure
   * un-registers this device's parent token source, which changes `api` and so changes `load`.
   *
   * Guarding that effect alone left the guarantee — "the section is off the screen for the length of
   * the operation" — with a gesture-shaped exception: pull-to-refresh calls `load` directly, so one
   * pull during the closure put the whole "Delete my account" section back, second live button and
   * all. The guard belongs to `load` itself, which is the one way any of this screen's rows reach it.
   */
  const closureStarted = useRef(false);
  /** The most recent load. Only the load holding this number may publish what it fetched. */
  const latestLoad = useRef(0);

  const load = useCallback(async () => {
    // The ticket is taken FIRST, before either return below, the way `useLoad` takes its own before
    // anything can be awaited (HUNT7-J-7). It used to be taken after the `!api` return, so a run that
    // found no client published 'not_connected' and left the ticket pointing at the PREVIOUS run: a
    // load still in flight then passed the check below and repainted the family this device can no
    // longer speak for — its children, exports and safety reports — over that honest state. Every
    // entry into `load` supersedes what is in flight, including the two that publish nothing.
    latestLoad.current += 1;
    const ticket = latestLoad.current;
    // Every reload door at once: the effect below, pull-to-refresh, and the post-action reloads.
    if (closureStarted.current) return;
    if (!api) {
      setState({ status: 'not_connected' });
      return;
    }
    try {
      const [data, published] = await Promise.all([
        loadPrivacyOverview(api),
        // Never rejects: `loadDataPractices` answers with the unknown (disclosing) state on any
        // failure, so a notice can neither fail this load nor delay it past the overview.
        loadDataPractices(api),
      ]);
      // A load superseded while its request was in flight publishes nothing. Two ways to be
      // superseded: a newer load, which for this screen means a new client and so the next adult at
      // the device (publishing here would show them the previous adult's children, exports and
      // safety reports as their own — HUNT6-I-2's harm through the answer rather than the start); or
      // a closure that began while this request was out, whose outcome is what the screen now is.
      if (latestLoad.current !== ticket || closureStarted.current) return;
      setState({ status: 'ready', data });
      // AFTER the publish, not between the ticket check and it: HUNT6-J-2's guard pins that pair as
      // adjacent text, and it is pinned because the check and the publish belonging together is the
      // claim. Both setters are inside the same guarded block and batch in one render either way.
      setPractices(published);
    } catch (error) {
      if (latestLoad.current !== ticket || closureStarted.current) return;
      setState({ status: 'error', message: parentErrorMessage(error) });
    }
  }, [api]);

  useEffect(() => {
    if (access.status !== 'ready' || closureStarted.current) return;
    // The rows go BEFORE the fetch, not when it answers (HUNT6-I-2). This effect runs on mount and
    // whenever `load` changes identity, which for this screen means a new client — and the parent gate
    // publishes a new client when the adult at the device has changed, so leaving the previous adult's
    // children, exports and safety reports up until the new fetch settled showed them to the next
    // parent for the length of one request. Pull-to-refresh does not come through here, which is why
    // the closure guard is inside `load` as well as on this effect.
    setState(api ? { status: 'loading' } : { status: 'not_connected' });
    void load();
  }, [api, load, access.status]);

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

  const downloadExport = async (exportId: string) => {
    if (!api || busy !== null) return;
    setBusy(`download:${exportId}`);
    setFeedback(null);
    const result = await exportDownloadAction(api, exportId, (url) => Linking.openURL(url));
    setFeedbackCount((n) => n + 1);
    setFeedback({ area: 'export', result, id: feedbackCount + 1 });
    setBusy(null);
  };

  /**
   * The app's normal sign-out path clears the parent session: the closure goes through the whole
   * device sign-out (MOB-R2-06), so it attempts to leave no biometric PIN, no parent mode and no live
   * unlock behind. Navigation is the only part left out, so the outcome stays on screen.
   *
   * The order and the claim both matter, and both live in src/privacy/parent-privacy.ts where they can
   * be run in a test rather than grepped out of this file (L-054):
   * - HUNT5-N6 / L-037: the outcome is shown only after the device sign-out, because
   *   `ACCOUNT_CLOSE_COPY.closed` ends "and this device is signed out", which is this app's half of
   *   the job, not the server's — and a claim about the device in front of the parent is the dangerous
   *   one to get wrong, because they put it down.
   * - HUNT6-J-1: that claim comes from what the sign-out REPORTED, not from its not throwing.
   * - HUNT6-J-2: the screen leaves 'ready' before the sign-out starts, so the second "Delete my
   *   account" is not live through three network calls, and the parent is acknowledged at once.
   */
  const closeAccount = async () => {
    if (!api || busy !== null) return;
    setBusy('account');
    setFeedback(null);
    await runAccountClosure(api, closeConfirmed, signOutClosedAccountOnDevice, (step) => {
      if (step.kind === 'refused') {
        setFeedbackCount((n) => n + 1);
        setFeedback({ area: 'account', result: step.result, id: feedbackCount + 1 });
        return;
      }
      closureStarted.current = true;
      setState(
        step.kind === 'closing'
          ? { status: 'closing' }
          : { status: 'account_closed', message: step.message },
      );
    });
    setBusy(null);
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

  const actOnReport = async (reportId: string, outcome: ParentReportOutcome) => {
    if (!api || busy !== null) return;
    setBusy(`report:${reportId}:${outcome}`);
    setFeedback(null);
    const result = await reportOutcomeAction(api, reportId, outcome);
    setFeedbackCount((n) => n + 1);
    setFeedback({ area: 'report', reportId, result, id: feedbackCount + 1 });
    setBusy(null);
    if (result.status === 'done') await load();
  };

  const data = state.status === 'ready' ? state.data : null;
  const deleted = data && !data.family ? familyDeletion(data.deletions) : null;
  // Every sentence the chosen deletion is confirmed with, for THAT target: the contracts branch on
  // the scope, so this screen cannot print the family's sentence over one child's deletion.
  const confirmCopy = target ? deletionConfirmationCopy(target, buildStore) : null;

  if (access.status !== 'ready') {
    return (
      <SafeAreaView style={styles.screen} edges={['left', 'right', 'bottom']}>
        <ScrollView contentContainerStyle={styles.content}>
          <BrandRow />
          <Text accessibilityRole="header" style={styles.title}>
            Privacy, export and deletion
          </Text>
          <ParentAccessState access={access} />
        </ScrollView>
      </SafeAreaView>
    );
  }

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
            // Not offered while the closure is running or over: `load` refuses the pull anyway, so
            // this is about not offering a gesture whose spinner would promise a reload that cannot
            // happen — the outcome of a deletion is not a view with fresh rows behind it.
            api && state.status !== 'closing' && state.status !== 'account_closed' ? (
              <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />
            ) : undefined
          }
        >
          <BrandRow />
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

          {state.status === 'closing' ? (
            <Section title="Account deleted">
              <Text accessibilityLiveRegion="polite" style={styles.body}>
                Your request has gone through. Signing this device out…
              </Text>
              <ActivityIndicator
                color={colors.teal}
                accessibilityLabel="Signing this device out"
                style={styles.loading}
              />
            </Section>
          ) : null}

          {state.status === 'account_closed' ? (
            <Section title="Account deleted">
              <Text accessibilityLiveRegion="polite" style={styles.body}>
                {state.message}
              </Text>
              <Button label="Done" onPress={() => router.replace('/')} />
            </Section>
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

          {state.status !== 'account_closed' && state.status !== 'closing' ? (
            <Section title="How long we keep information">
              {privacyRetentionLines(buildStore).map((line) => (
                <Text key={line} style={[styles.body, styles.bullet]}>
                  {`• ${line}`}
                </Text>
              ))}
            </Section>
          ) : null}

          {/* The fuller version of the strip at the foot of every parent screen: the strip carries
              the child-work sentence alone, because a phone has no room for three permanent lines,
              and the adult-ID sentence belongs here. Same constants, so the two cannot differ. */}
          {state.status !== 'account_closed' && state.status !== 'closing' ? (
            <Section title={DATA_PRACTICES_COPY.heading}>
              {dataPracticesDetail(practices).map((line) => (
                <Text key={line} style={styles.body}>
                  {line}
                </Text>
              ))}
            </Section>
          ) : null}

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
                  Each request and each download needs a recent parent PIN unlock. Files are
                  prepared in the background, usually within a few minutes: pull down to refresh. A
                  ready file can be opened for a limited time, then it expires and you can request a
                  new copy.
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
                    <View key={item.id}>
                      <Text style={[styles.body, styles.bullet]}>{`• ${exportLine(item)}`}</Text>
                      {item.status === 'ready' ? (
                        <Button
                          label={busy === `download:${item.id}` ? 'Opening…' : 'Download'}
                          secondary
                          disabled={busy !== null}
                          onPress={() => void downloadExport(item.id)}
                        />
                      ) : null}
                    </View>
                  ))
                )}
              </Section>

              <Section title="Safety reports">
                <Text style={styles.body}>{SAFETY_REPORTS_INTRO}</Text>
                {data.reports.length === 0 ? (
                  <Text style={[styles.body, styles.spaced]}>No safety reports yet.</Text>
                ) : (
                  data.reports.map((r) => {
                    const view = safetyReportView(data.family, r);
                    return (
                      <View
                        key={view.id}
                        style={styles.report}
                        accessibilityLabel={`${view.title}. ${view.meta}`}
                      >
                        <Text style={[styles.body, styles.bold]}>{view.title}</Text>
                        <Text style={styles.muted}>{view.meta}</Text>
                        {view.note ? <Text style={styles.muted}>{`“${view.note}”`}</Text> : null}
                        {view.lines.map((line) => (
                          <Text key={line} style={[styles.body, styles.spaced]}>
                            {line}
                          </Text>
                        ))}
                        {view.actions.map((action) => (
                          <View key={action.outcome}>
                            <Button
                              label={
                                busy === `report:${view.id}:${action.outcome}`
                                  ? 'Saving…'
                                  : action.label
                              }
                              disabled={busy !== null}
                              secondary
                              onPress={() => void actOnReport(view.id, action.outcome)}
                            />
                            <Text style={styles.muted}>{action.effect}</Text>
                          </View>
                        ))}
                        {view.actions.length > 0 ? (
                          <Text style={styles.muted}>
                            {PARENT_SAFETY_FLAG_COPY.actionsNeedUnlock}
                          </Text>
                        ) : null}
                        {feedback?.area === 'report' && feedback.reportId === view.id ? (
                          <ResultView key={feedback.id} result={feedback.result} api={api} />
                        ) : null}
                      </View>
                    );
                  })
                )}
              </Section>

              <Section title="Delete data">
                {/* No store-subscription sentence here: what it must say depends on WHICH deletion,
                    and this section showed the account-wide one over a single child's deletion. It
                    is printed below with the rest of the chosen target's confirmation. */}
                <Text style={[styles.body, styles.spaced]}>{DELETION_INTRO}</Text>
                <Text style={[styles.body, styles.spaced]}>Choose what to delete:</Text>
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
                {target && confirmCopy ? (
                  <>
                    {/* Every sentence below is the chosen TARGET's, decided in the contracts and
                        printed unchanged: what this deletion removes, what survives it, what it
                        does not do to the store subscription, and what to type. */}
                    <Text style={[styles.body, styles.spaced]}>{confirmCopy.effect}</Text>
                    <View style={styles.warning}>
                      <Text style={[styles.body, styles.bold]}>{confirmCopy.storeNotice}</Text>
                    </View>
                    <Text nativeID="confirm-label" style={[styles.body, styles.spaced]}>
                      {confirmCopy.typePrompt}
                    </Text>
                    <TextInput
                      accessibilityLabel={confirmCopy.typePrompt}
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
                      {`• ${deletionRequestLabel(
                        d,
                        data.family?.children.find((c) => c.id === d.childId)?.nickname ??
                          'A removed child profile',
                      )}: ${deletionStatusText(d)}`}
                    </Text>
                  ))
                )}
              </Section>
            </>
          ) : null}

          {data ? (
            <Section title={ACCOUNT_CLOSE_COPY.title}>
              <Text style={styles.body}>{ACCOUNT_CLOSE_COPY.intro}</Text>
              <Text
                style={[styles.body, styles.bullet]}
              >{`• ${ACCOUNT_CLOSE_COPY.ownerRule}`}</Text>
              <Text style={[styles.body, styles.bullet]}>
                {`• ${ACCOUNT_CLOSE_COPY.guardianRule}`}
              </Text>
              <Text style={[styles.body, styles.bullet]}>{`• ${ACCOUNT_CLOSE_COPY.keep}`}</Text>
              <View style={styles.warning}>
                <Text style={[styles.body, styles.bold]}>{ACCOUNT_CLOSE_COPY.storeNotice}</Text>
              </View>
              <Pressable
                accessibilityRole="checkbox"
                accessibilityLabel={ACCOUNT_CLOSE_COPY.confirmLabel}
                accessibilityState={{ checked: closeConfirmed }}
                onPress={() => {
                  setCloseConfirmed((v) => !v);
                  setFeedback(null);
                }}
                style={[styles.choice, closeConfirmed && styles.choiceSelected]}
              >
                <Text style={styles.body}>
                  {`${closeConfirmed ? '☑' : '☐'}  ${ACCOUNT_CLOSE_COPY.confirmLabel}`}
                </Text>
              </Pressable>
              <Button
                label={busy === 'account' ? 'Deleting…' : ACCOUNT_CLOSE_COPY.action}
                danger
                disabled={busy !== null}
                onPress={() => void closeAccount()}
              />
              {feedback?.area === 'account' ? (
                <ResultView key={feedback.id} result={feedback.result} api={api} />
              ) : null}
            </Section>
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
  muted: { fontSize: typography.scale.sm, color: colors.muted, marginTop: spacing.xs },
  bold: { fontWeight: '800' },
  report: {
    borderTopWidth: 1,
    borderTopColor: colors.muted,
    paddingTop: spacing.sm,
    marginTop: spacing.md,
  },
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
    backgroundColor: colors.tealText,
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
