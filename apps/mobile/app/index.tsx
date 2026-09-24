import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, minTouchTarget, spacing, typography } from '@pencillift/ui-tokens';

/** Entry: choose the parent area or connect a child device. No child data is shown here. */
export default function Welcome() {
  return (
    <View style={styles.screen} accessibilityRole="summary">
      <Text style={styles.wordmark} accessibilityRole="header">
        <Text style={{ color: colors.navy }}>Pencil</Text>
        <Text style={{ color: colors.tealText }}>Lift</Text>
      </Text>
      <Text style={styles.tagline}>Turn homework into progress.</Text>
      <Pressable accessibilityRole="button" style={styles.button}>
        <Text style={styles.buttonText}>I’m a parent</Text>
      </Pressable>
      <Pressable accessibilityRole="button" style={[styles.button, styles.secondary]}>
        <Text style={[styles.buttonText, { color: colors.tealText }]}>
          Connect a child’s device
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    backgroundColor: colors.offWhite,
  },
  wordmark: { fontSize: typography.scale.xxl, fontWeight: '800' },
  tagline: { fontSize: typography.scale.md, color: colors.navy, marginBottom: spacing.xl },
  button: {
    minHeight: minTouchTarget,
    minWidth: 260,
    borderRadius: 999,
    backgroundColor: colors.teal,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  secondary: { backgroundColor: colors.white, borderWidth: 2, borderColor: colors.teal },
  buttonText: { color: colors.white, fontSize: typography.scale.md, fontWeight: '800' },
});
