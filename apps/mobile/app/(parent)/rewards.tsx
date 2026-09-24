import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { RewardDecisionAction, RewardsOverview } from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { colors, minTouchTarget, radii, spacing, typography } from '@pencillift/ui-tokens';
import {
  ErrorBox,
  ParentAccessState,
  Screen,
  Title,
  useParentAccess,
} from '../../src/family/ui.tsx';
import { decideRequestAction, loadRewardsOverview } from '../../src/rewards/actions.ts';
import {
  buildParentApprovalsView,
  parentActionError,
  type ParentRequestCard,
} from '../../src/rewards/parent-view-model.ts';

type ScreenState =
  | { status: 'loading' }
  | { status: 'error'; message: string; needsPin: boolean }
  | { status: 'ready'; data: RewardsOverview };

type Notice = { ok: boolean; needsPin: boolean; text: string };

/**
 * Parent reward approvals (spec P9, P14 "requests"). Approve/decline pending requests and record
 * when a reward was given. Decisions need a recent parent-PIN step-up, enforced by the API.
 *
 * Decision (RV-rewards-3, spec P3 / AC_ACCESS_07): the screen goes through the same parent-area
 * gate as every other parent screen. A device in child mode never loads family balances or
 * requests here, even through a deep link, and never shows the decision buttons; it offers the
 * PIN unlock instead. The parent sign-in stays on the device in child mode, so a registered token
 * alone is not proof that a grown-up is present.
 */
export default function ParentRewardsScreen() {
  const access = useParentAccess();
  if (access.status !== 'ready') {
    return (
      <Screen>
        <Title>Reward requests</Title>
        <ParentAccessState access={access} />
      </Screen>
    );
  }
  return <RewardApprovals api={access.api} />;
}

function RewardApprovals({ api }: { api: ApiClient }) {
  const [state, setState] = useState<ScreenState>({ status: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', data: await loadRewardsOverview(api) });
    } catch (error) {
      const problem = parentActionError(error);
      setState({ status: 'error', message: problem.message, needsPin: problem.needsPin });
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

  const decide = async (card: ParentRequestCard, action: RewardDecisionAction) => {
    if (busy !== null) return;
    setBusy(`${card.id}:${action}`);
    setNotice(null);
    const result = await decideRequestAction(api, card.request, action);
    setNotice({ ok: result.ok, needsPin: result.needsPin, text: result.message });
    setBusy(null);
    // After a success, or when the request already changed elsewhere (RV-rewards-7), the list is
    // stale: reload so no button stays on screen that can only fail.
    if (result.reload) await load();
  };

  const view = state.status === 'ready' ? buildParentApprovalsView(state.data) : null;

  const renderCard = (card: ParentRequestCard) => (
    <View key={card.id} style={styles.card}>
      <Text style={styles.cardTitle}>{card.heading}</Text>
      <Text style={styles.body}>{card.detail}</Text>
      <Text style={styles.body}>Status: {card.statusLabel}</Text>
      <View style={styles.row}>
        {card.actions.map((button) => {
          const key = `${card.id}:${button.action}`;
          return (
            <Pressable
              key={button.action}
              accessibilityRole="button"
              accessibilityLabel={button.a11yLabel}
              accessibilityState={{ disabled: busy !== null, busy: busy === key }}
              disabled={busy !== null}
              onPress={() => void decide(card, button.action)}
              style={[
                styles.button,
                !button.primary && styles.secondary,
                busy !== null && styles.buttonDisabled,
              ]}
            >
              <Text style={[styles.buttonText, !button.primary && styles.secondaryText]}>
                {busy === key ? 'Saving…' : button.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.screen} edges={['left', 'right', 'bottom']}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      >
        <Text accessibilityRole="header" style={styles.title}>
          Reward requests
        </Text>
        <Text style={styles.muted}>
          Points are a family motivation tool, not money. You give rewards yourself, outside the
          app.
        </Text>

        {state.status === 'loading' ? (
          <ActivityIndicator
            color={colors.teal}
            accessibilityLabel="Loading reward requests"
            style={styles.loading}
          />
        ) : null}

        {state.status === 'error' ? (
          <ErrorBox
            message={state.message}
            needsPin={state.needsPin}
            onRetry={() => {
              setState({ status: 'loading' });
              void load();
            }}
          />
        ) : null}

        {notice?.ok ? (
          <View
            accessibilityRole="text"
            accessibilityLiveRegion="polite"
            style={[styles.notice, styles.noticeOk]}
          >
            <Text style={styles.body}>{notice.text}</Text>
          </View>
        ) : null}
        {notice && !notice.ok ? (
          // RV-rewards-4: a STEP_UP_REQUIRED answer comes with an "Unlock with parent PIN" button
          // (to /(parent)/unlock), so an expired unlock is recoverable from this screen.
          <ErrorBox message={notice.text} needsPin={notice.needsPin} />
        ) : null}

        {view ? (
          <>
            <Text accessibilityRole="header" style={styles.heading}>
              Balances
            </Text>
            {view.balances.length === 0 ? (
              <Text style={styles.body}>Add a child to start using rewards.</Text>
            ) : null}
            {view.balances.map((b) => (
              <Text key={b.childId} style={styles.body}>
                {b.label}
              </Text>
            ))}

            {view.emptyMessage ? (
              <Text style={[styles.body, styles.spaced]}>{view.emptyMessage}</Text>
            ) : null}
            {view.pending.length > 0 ? (
              <>
                <Text accessibilityRole="header" style={styles.heading}>
                  Waiting for you
                </Text>
                {view.pending.map(renderCard)}
              </>
            ) : null}
            {view.approved.length > 0 ? (
              <>
                <Text accessibilityRole="header" style={styles.heading}>
                  Approved – to give
                </Text>
                {view.approved.map(renderCard)}
              </>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.offWhite },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  title: {
    fontSize: typography.scale.xl,
    fontWeight: '800',
    color: colors.navy,
    marginBottom: spacing.sm,
  },
  heading: {
    fontSize: typography.scale.lg,
    fontWeight: '800',
    color: colors.navy,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  body: { fontSize: typography.scale.md, color: colors.navy },
  muted: { fontSize: typography.scale.md, color: colors.muted },
  spaced: { marginTop: spacing.md },
  loading: { marginVertical: spacing.lg },
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  cardTitle: { fontSize: typography.scale.md, fontWeight: '800', color: colors.navy },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  notice: {
    marginTop: spacing.md,
    padding: spacing.sm,
    borderRadius: radii.sm,
    borderLeftWidth: 4,
    backgroundColor: colors.white,
  },
  noticeOk: { borderLeftColor: colors.success },
  button: {
    minHeight: minTouchTarget,
    borderRadius: radii.pill,
    backgroundColor: colors.teal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  buttonDisabled: { opacity: 0.55 },
  buttonText: { color: colors.white, fontSize: typography.scale.md, fontWeight: '800' },
  secondary: { backgroundColor: colors.white, borderWidth: 2, borderColor: colors.teal },
  secondaryText: { color: colors.tealText },
});
