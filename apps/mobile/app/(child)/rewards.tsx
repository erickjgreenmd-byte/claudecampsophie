import * as Crypto from 'expo-crypto';
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
import type { ChildRewards } from '@pencillift/contracts';
import { colors, minTouchTarget, radii, spacing, typography } from '@pencillift/ui-tokens';
import { BrandRow } from '../../src/brand/BrandMark.tsx';
import { ChildNav } from '../../src/family/ui.tsx';
import { createMobileApi } from '../../src/lib/api.ts';
import {
  askForRewardAction,
  cancelRequestAction,
  createRequestIds,
  loadChildRewards,
} from '../../src/rewards/actions.ts';
import {
  buildChildRewardsView,
  childRewardsErrorMessage,
} from '../../src/rewards/child-view-model.ts';
import { childRewardsTokenSource } from '../../src/rewards/session.ts';

type ScreenState =
  | { status: 'not_connected' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: ChildRewards };

/**
 * Child "My rewards" screen (spec P9, P14). Shows the child's own points, how points are earned
 * (the family's published rules), the rewards a grown-up offers them, and their requests. No
 * prices, purchases, ads or wallet language; asking reserves points and a grown-up decides. Logic
 * lives in src/rewards (unit-tested).
 */
export default function ChildRewardsScreen() {
  const tokenSource = childRewardsTokenSource();
  const api = useMemo(() => (tokenSource ? createMobileApi(tokenSource) : null), [tokenSource]);
  const ids = useMemo(() => createRequestIds(() => Crypto.randomUUID()), []);
  const [state, setState] = useState<ScreenState>(
    api ? { status: 'loading' } : { status: 'not_connected' },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!api) {
      setState({ status: 'not_connected' });
      return;
    }
    try {
      setState({ status: 'ready', data: await loadChildRewards(api) });
    } catch (error) {
      setState({ status: 'error', message: childRewardsErrorMessage(error) });
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

  const ask = async (reward: { id: string; title: string }) => {
    if (!api || busy !== null) return;
    setBusy(reward.id);
    setNotice(null);
    const result = await askForRewardAction(api, ids, reward);
    setNotice({ ok: result.ok, text: result.message });
    setBusy(null);
    if (result.ok) await load();
  };

  const cancel = async (request: { id: string; title: string }) => {
    if (!api || busy !== null) return;
    setBusy(request.id);
    setNotice(null);
    const result = await cancelRequestAction(api, request);
    setNotice({ ok: result.ok, text: result.message });
    setBusy(null);
    await load();
  };

  const view = state.status === 'ready' ? buildChildRewardsView(state.data) : null;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          api ? (
            <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />
          ) : undefined
        }
      >
        <BrandRow />
        <ChildNav />
        <Text accessibilityRole="header" style={styles.title}>
          My rewards
        </Text>

        {state.status === 'not_connected' ? (
          <Text style={styles.body}>
            This device isn’t connected yet. Ask a grown-up to connect it, then your rewards will
            show up here.
          </Text>
        ) : null}

        {state.status === 'loading' ? (
          <ActivityIndicator
            color={colors.teal}
            accessibilityLabel="Loading your rewards"
            style={styles.loading}
          />
        ) : null}

        {state.status === 'error' ? (
          <View accessibilityRole="alert" style={styles.card}>
            <Text style={styles.body}>{state.message}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Try loading your rewards again"
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

        {view ? (
          <>
            <View style={styles.balanceCard} accessible accessibilityLabel={view.balanceLabel}>
              <Text style={styles.balance}>{view.balanceLabel}</Text>
              <Text style={styles.body}>{view.encouragement}</Text>
            </View>

            <Text accessibilityRole="header" style={styles.heading}>
              {view.earning.heading}
            </Text>
            <View style={styles.card}>
              {view.earning.lines.map((line) => (
                <Text key={line} style={styles.body}>
                  {line}
                </Text>
              ))}
              <Text style={styles.muted}>{view.earning.note}</Text>
            </View>

            {notice ? (
              <Text
                accessibilityLiveRegion="polite"
                accessibilityRole={notice.ok ? 'text' : 'alert'}
                style={[styles.notice, notice.ok ? styles.noticeOk : styles.noticeProblem]}
              >
                {notice.text}
              </Text>
            ) : null}

            <Text accessibilityRole="header" style={styles.heading}>
              Rewards to work toward
            </Text>
            {view.emptyRewardsMessage ? (
              <Text style={styles.body}>{view.emptyRewardsMessage}</Text>
            ) : null}
            {view.rewards.map((card) => {
              const percent = Math.round(card.progress * 100);
              return (
                <View key={card.id} style={styles.card}>
                  <Text style={styles.cardTitle}>{card.title}</Text>
                  <Text style={styles.body}>{card.costLabel}</Text>
                  {card.instructions ? <Text style={styles.muted}>{card.instructions}</Text> : null}
                  <View
                    accessibilityRole="progressbar"
                    accessibilityLabel={`Progress toward ${card.title}`}
                    accessibilityValue={{
                      min: 0,
                      max: 100,
                      now: percent,
                      text: card.progressLabel,
                    }}
                    style={styles.track}
                  >
                    <View style={[styles.fill, { width: `${percent}%` as const }]} />
                  </View>
                  <Text style={styles.body}>{card.progressLabel}</Text>
                  {card.canAsk ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={card.askA11yLabel}
                      accessibilityState={{ disabled: busy !== null, busy: busy === card.id }}
                      disabled={busy !== null}
                      onPress={() => void ask(card)}
                      style={[styles.button, busy !== null && styles.buttonDisabled]}
                    >
                      <Text style={styles.buttonText}>
                        {busy === card.id ? 'Asking…' : card.askLabel}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              );
            })}

            <Text accessibilityRole="header" style={styles.heading}>
              My requests
            </Text>
            {view.emptyRequestsMessage ? (
              <Text style={styles.body}>{view.emptyRequestsMessage}</Text>
            ) : null}
            {view.requests.map((row) => (
              <View key={row.id} style={styles.card}>
                <Text style={styles.cardTitle}>{row.title}</Text>
                <Text style={styles.body}>{row.statusLabel}</Text>
                {row.canCancel ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={row.cancelA11yLabel}
                    accessibilityState={{ disabled: busy !== null, busy: busy === row.id }}
                    disabled={busy !== null}
                    onPress={() => void cancel(row)}
                    style={[
                      styles.button,
                      styles.secondary,
                      busy !== null && styles.buttonDisabled,
                    ]}
                  >
                    <Text style={[styles.buttonText, styles.secondaryText]}>
                      {busy === row.id ? 'Cancelling…' : row.cancelLabel}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.offWhite },
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    width: '100%',
    maxWidth: 640 + 2 * spacing.md,
    alignSelf: 'center',
  },
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
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  body: { fontSize: typography.scale.md, color: colors.navy },
  muted: { fontSize: typography.scale.md, color: colors.muted },
  loading: { marginVertical: spacing.lg },
  balanceCard: {
    backgroundColor: colors.white,
    borderRadius: radii.lg,
    padding: spacing.lg,
    borderWidth: 2,
    borderColor: colors.gold,
  },
  balance: { fontSize: typography.scale.xl, fontWeight: '800', color: colors.tealText },
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  cardTitle: { fontSize: typography.scale.lg, fontWeight: '800', color: colors.navy },
  track: {
    height: 12,
    borderRadius: radii.pill,
    backgroundColor: colors.offWhite,
    borderWidth: 1,
    borderColor: colors.muted,
    overflow: 'hidden',
    marginTop: spacing.sm,
  },
  fill: { height: '100%', backgroundColor: colors.teal },
  notice: {
    fontSize: typography.scale.md,
    marginTop: spacing.md,
    padding: spacing.sm,
    borderRadius: radii.sm,
    borderLeftWidth: 4,
  },
  noticeOk: { borderLeftColor: colors.success, color: colors.navy },
  noticeProblem: { borderLeftColor: colors.gold, color: colors.navy },
  button: {
    minHeight: minTouchTarget,
    borderRadius: radii.pill,
    // White text needs the text teal (5.9:1), not the brand teal (4.07:1) (R2C-MOB-1).
    backgroundColor: colors.tealText,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
    alignSelf: 'flex-start',
  },
  buttonDisabled: { opacity: 0.55 },
  buttonText: { color: colors.white, fontSize: typography.scale.md, fontWeight: '800' },
  secondary: { backgroundColor: colors.white, borderWidth: 2, borderColor: colors.teal },
  secondaryText: { color: colors.tealText },
});
