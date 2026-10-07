import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { colors, minTouchTarget, spacing, typography } from '@pencillift/ui-tokens';
import type { ApiClient } from '@pencillift/contracts/client';
import {
  dataPracticesStrip,
  loadDataPractices,
  UNKNOWN_DATA_PRACTICES,
  type DataPracticesState,
} from './data-practices.ts';

/**
 * The strip at the foot of every PARENT screen (spec P4, P15).
 *
 * NOT ON A CHILD SCREEN, on purpose. A notice about which companies read homework is a decision for
 * the adult who agreed to it; an eight-year-old can neither act on it nor consent, and the brand
 * guide asks the child space to stay playful rather than becoming a wall of policy. The child's own
 * words for what happens to their work live in apps/mobile/src/privacy/child-help.ts.
 * `data-practices.test.ts` asserts that only the parent layout imports this.
 *
 * Every decision is in `./data-practices.ts`; this file is the view.
 */
export function DataPracticesNotice({ api }: { readonly api: ApiClient }) {
  const [state, setState] = useState<DataPracticesState>(UNKNOWN_DATA_PRACTICES);
  useEffect(() => {
    let live = true;
    void loadDataPractices(api).then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, [api]);
  const strip = dataPracticesStrip(state);
  return (
    <View style={styles.strip}>
      <Text style={styles.heading}>{strip.heading}</Text>
      <Text style={styles.sentence}>{strip.sentence}</Text>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={strip.linkLabel}
        onPress={() => router.push('/(parent)/privacy')}
        style={styles.link}
      >
        <Text style={styles.linkText}>{strip.linkLabel}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    borderTopWidth: 2,
    borderTopColor: colors.teal,
    backgroundColor: colors.offWhite,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  heading: {
    color: colors.navy,
    fontSize: typography.scale.sm,
    fontWeight: '800',
  },
  sentence: { color: colors.muted, fontSize: typography.scale.xs, marginTop: spacing.xs },
  link: { minHeight: minTouchTarget, justifyContent: 'center' },
  linkText: {
    color: colors.tealText,
    fontSize: typography.scale.sm,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
});
