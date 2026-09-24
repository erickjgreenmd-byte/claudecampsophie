import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { colors, minTouchTarget, radii, spacing, typography } from '@pencillift/ui-tokens';
import { createMobileApi } from '../../src/lib/api.ts';
import { decideRequestAction, loadRewardsOverview } from '../../src/rewards/actions.ts';
import {
  buildParentApprovalsView,
  parentActionError,
  type ParentRequestCard,
} from '../../src/rewards/parent-view-model.ts';
import { parentRewardsTokenSource } from '../../src/rewards/session.ts';

type ScreenState =
  | { status: 'signed_out' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: RewardsOverview };

/**
 * Parent reward approvals (spec P9, P14 "requests"). Approve/decline pending requests and record
 * when a reward was given. Decisions need a recent parent-PIN step-up, enforced by the API.
 */
export default function ParentRewardsScreen() {
  const tokenSource = parentRewardsTokenSource();
  const api = useMemo(() => (tokenSource ? createMobileApi(tokenSource) : null), [tokenSource]);
  const [state, setState] = useState<ScreenState>(
    api ? { status: 'loading' } : { status: 'signed_out' },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; needsPin: boolean; text: string } | null>(
    null,
  );
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!api) {
      setState({ status: 'signed_out' });
      return;
    }
    try {
      setState({ status: 'ready', data: await loadRewardsOverview(api) });
    } catch (error) {
      setState({ status: 'error', message: parentActionError(error).message });
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
    if (!api || busy !== null) return;
    setBusy(`${card.id}:${action}`);
    setNotice(null);
    const result = await decideRequestAction(api, card.request, action);
    setNotice({ ok: result.ok, needsPin: result.needsPin, text: result.message });
    setBusy(null);
    if (result.ok) await load();
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
        refreshControl={
          api ? (
            <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />
          ) : undefined
        }
      >
        <Text accessibilityRole="header" style={styles.title}>
          Reward requests
        </Text>
        <Text style={styles.muted}>
          Points are a family motivation tool, not money. You give rewards yourself, outside the
          app.
        </Text>

        {state.status === 'signed_out' ? (
          <Text style={styles.body}>
            Parent sign-in isn’t connected on this device yet, so requests can’t be shown here.
          </Text>
        ) : null}

        {state.status === 'loading' ? (
          <ActivityIndicator
            color={colors.teal}
            accessibilityLabel="Loading reward requests"
            style={styles.loading}
          />
        ) : null}

        {state.status === 'error' ? (
          <View accessibilityRole="alert" style={styles.card}>
            <Text style={styles.body}>{state.message}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Try loading reward requests again"
              onPress={() => {
                setState({ status: 'loading' });
                void load();
              }}
              style={styles.button}
            >
              <Text style={styles.buttonText}>Try again</Text>
            </Pressable>
          </View>
        ) : null}

        {notice ? (
          <View
            accessibilityRole={notice.ok ? 'text' : 'alert'}
            accessibilityLiveRegion="polite"
            style={[styles.notice, notice.ok ? styles.noticeOk : styles.noticeProblem]}
          >
            <Text style={[styles.body, notice.needsPin && styles.strong]}>{notice.text}</Text>
          </View>
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
  strong: { fontWeight: '800' },
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
  noticeProblem: { borderLeftColor: colors.danger },
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
