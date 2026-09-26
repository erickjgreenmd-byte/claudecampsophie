import { Stack } from 'expo-router';
import type { ErrorBoundaryProps } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors } from '@pencillift/ui-tokens';
import { ErrorScreen, goToChildHome, useChildModeOnFocus } from '../../src/family/ui.tsx';

/**
 * Child space. Only child-scoped data; no ads, purchases, answer keys or adult screens. There is
 * no native header here, so the layout keeps every child screen (and its brand row) below the
 * status bar; a screen that also applies its own top edge measures zero once inside this one.
 */
export default function ChildLayout() {
  // Coming back here from the parent area, by the header back arrow or Android/Fire Back, switches
  // the device back to child mode: relock, forget the unlock, persist 'child' (MOB-R2-05).
  useChildModeOnFocus();
  return (
    <SafeAreaView style={styles.fill} edges={['top']}>
      <Stack screenOptions={{ headerShown: false, contentStyle: styles.fill }} />
    </SafeAreaView>
  );
}

/**
 * A render error in a child screen shows calm words and a way home, never a closed app (MOB-R2-07).
 */
export function ErrorBoundary({ retry }: ErrorBoundaryProps) {
  return (
    <ErrorScreen
      title="Oops!"
      message="Something went wrong. Let’s go back home."
      retryLabel="Go to my home"
      onRetry={() => {
        void retry();
        goToChildHome();
      }}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.offWhite },
});
