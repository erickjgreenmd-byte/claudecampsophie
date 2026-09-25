import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { colors, minTouchTarget, spacing, typography } from '@pencillift/ui-tokens';
import { BrandHero } from '../src/brand/BrandMark.tsx';
import { childSession, modeEffects } from '../src/family/runtime.ts';
import { entryRoute } from '../src/lib/entry.ts';
import { currentMode, enterChildMode } from '../src/lib/mode.ts';
import { parentAuth } from '../src/lib/parent-auth.ts';
import { secureStorage } from '../src/lib/secure-storage.ts';

/** Entry: choose the parent area or connect a child device. No child data is shown here. */
export default function Welcome() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([currentMode(secureStorage), childSession.isPaired()]).then(
      ([mode, paired]) => {
        if (!active) return;
        const route = entryRoute(mode, paired, false, null);
        if (route) router.replace(route);
        else setReady(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  async function choose(choice: 'parent' | 'child') {
    const [mode, paired, email] = await Promise.all([
      currentMode(secureStorage),
      childSession.isPaired(),
      parentAuth.email(),
    ]);
    const route = entryRoute(mode, paired, email !== null, choice);
    if (route === '/(child)/home') {
      // Handing a paired device to the child switches modes explicitly: adult caches cleared,
      // parent area relocked and the stack reset, never a push that leaves parent mode behind.
      await enterChildMode(secureStorage, modeEffects);
      return;
    }
    if (route) router.push(route);
  }

  return (
    <View style={styles.screen} accessibilityRole="summary">
      {/* Full-colour symbol above the text wordmark (the traced lockup PNG would blur at this
          size); the wordmark text names the brand, so the symbol is decorative. */}
      <BrandHero />
      <Text style={styles.wordmark} accessibilityRole="header">
        <Text style={{ color: colors.navy }}>Pencil</Text>
        <Text style={{ color: colors.tealText }}>Lift</Text>
      </Text>
      <Text style={styles.tagline}>Turn homework into progress.</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !ready }}
        disabled={!ready}
        style={styles.button}
        onPress={() => void choose('parent')}
      >
        <Text style={styles.buttonText}>I’m a parent</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !ready }}
        disabled={!ready}
        style={[styles.button, styles.secondary]}
        onPress={() => void choose('child')}
      >
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
    // White text needs the text teal (5.9:1), not the brand teal (4.07:1) (R2C-MOB-1).
    backgroundColor: colors.tealText,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  secondary: { backgroundColor: colors.white, borderWidth: 2, borderColor: colors.teal },
  buttonText: { color: colors.white, fontSize: typography.scale.md, fontWeight: '800' },
});
