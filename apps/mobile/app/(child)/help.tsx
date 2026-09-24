import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ChildReportCategory } from '@pencillift/contracts';
import { colors, minTouchTarget, radii, spacing, typography } from '@pencillift/ui-tokens';
import { createMobileApi } from '../../src/lib/api.ts';
import {
  CHILD_HELP_COPY,
  CHILD_REPORT_CHOICES,
  parseReportContext,
  sendChildReport,
  type ReportContext,
} from '../../src/privacy/child-help.ts';
import { childPrivacyTokenSource } from '../../src/privacy/session.ts';

/**
 * Child help / report screen (spec P4 child-safe help/report button, P14 "report/help";
 * AC_SECURITY_01). "Tell a grown-up" always works, even offline. Report choices save a reviewable
 * report for the child's own question when one is attached. Calm copy; never answers, scores, ads
 * or purchases, and never a claim that a parent was alerted. Logic lives in src/privacy (tested).
 */
export default function ChildHelpScreen() {
  const params = useLocalSearchParams<{ questionId?: string; feedbackId?: string }>();
  const [context, setContext] = useState<ReportContext>(() => parseReportContext(params));
  const tokenSource = childPrivacyTokenSource();
  const api = useMemo(() => (tokenSource ? createMobileApi(tokenSource) : null), [tokenSource]);
  const [busy, setBusy] = useState<ChildReportCategory | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const report = async (category: ChildReportCategory) => {
    if (!api || busy !== null) return;
    setBusy(category);
    setNotice(null);
    const result = await sendChildReport(api, category, context);
    setNotice({ ok: result.ok, text: result.message });
    if (!result.ok && result.dropContext) setContext({});
    setBusy(null);
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>
          {CHILD_HELP_COPY.title}
        </Text>
        <Text style={styles.body}>{CHILD_HELP_COPY.intro}</Text>

        <View style={[styles.card, styles.grownUpCard]}>
          <Text accessibilityRole="header" style={styles.heading}>
            {CHILD_HELP_COPY.tellGrownUpTitle}
          </Text>
          <Text style={styles.body}>{CHILD_HELP_COPY.tellGrownUp}</Text>
          <Text style={[styles.body, styles.spaced]}>{CHILD_HELP_COPY.urgent}</Text>
        </View>

        <Text accessibilityRole="header" style={styles.heading}>
          {CHILD_HELP_COPY.reportTitle}
        </Text>
        {api ? (
          <>
            <Text style={styles.body}>{CHILD_HELP_COPY.reportIntro}</Text>
            {CHILD_REPORT_CHOICES.map((choice) => (
              <Pressable
                key={choice.category}
                accessibilityRole="button"
                accessibilityLabel={choice.label}
                accessibilityHint={choice.hint}
                accessibilityState={{
                  disabled: busy !== null,
                  busy: busy === choice.category,
                }}
                disabled={busy !== null}
                onPress={() => void report(choice.category)}
                style={({ pressed }) => [
                  styles.choice,
                  pressed && styles.choicePressed,
                  busy !== null && styles.disabled,
                ]}
              >
                <Text style={styles.choiceLabel}>
                  {busy === choice.category ? CHILD_HELP_COPY.sending : choice.label}
                </Text>
                <Text style={styles.muted}>{choice.hint}</Text>
              </Pressable>
            ))}
          </>
        ) : (
          <Text style={styles.body}>{CHILD_HELP_COPY.notConnected}</Text>
        )}

        {notice ? (
          <View
            accessibilityLiveRegion="polite"
            accessibilityRole={notice.ok ? 'text' : 'alert'}
            style={[styles.notice, notice.ok ? styles.noticeOk : styles.noticeProblem]}
          >
            <Text style={styles.noticeMark}>{notice.ok ? '✓ Saved' : 'Not sent yet'}</Text>
            <Text style={styles.body}>{notice.text}</Text>
          </View>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          style={[styles.choice, styles.back]}
        >
          <Text style={styles.choiceLabel}>Go back</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.offWhite },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  title: {
    fontSize: typography.scale.xxl,
    fontWeight: '800',
    color: colors.navy,
    marginBottom: spacing.sm,
  },
  heading: {
    fontSize: typography.scale.lg,
    fontWeight: '800',
    color: colors.navy,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  body: { fontSize: typography.scale.md, color: colors.navy },
  muted: { fontSize: typography.scale.sm, color: colors.muted, marginTop: spacing.xs },
  spaced: { marginTop: spacing.sm },
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.lg,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  grownUpCard: { borderLeftWidth: 6, borderLeftColor: colors.teal },
  choice: {
    minHeight: minTouchTarget,
    backgroundColor: colors.white,
    borderRadius: radii.md,
    borderWidth: 2,
    borderColor: colors.teal,
    padding: spacing.md,
    marginTop: spacing.sm,
    justifyContent: 'center',
  },
  choicePressed: { backgroundColor: colors.offWhite },
  choiceLabel: { fontSize: typography.scale.lg, fontWeight: '800', color: colors.tealText },
  disabled: { opacity: 0.6 },
  back: { marginTop: spacing.lg, borderColor: colors.navy },
  notice: { borderRadius: radii.md, padding: spacing.md, marginTop: spacing.md, borderWidth: 2 },
  noticeOk: { borderColor: colors.success, backgroundColor: colors.white },
  noticeProblem: { borderColor: colors.gold, backgroundColor: colors.white },
  noticeMark: { fontSize: typography.scale.md, fontWeight: '800', color: colors.navy },
});
