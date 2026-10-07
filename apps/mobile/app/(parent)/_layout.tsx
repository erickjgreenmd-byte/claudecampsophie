import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import type { ErrorBoundaryProps } from 'expo-router';
import { colors } from '@pencillift/ui-tokens';
import { ErrorScreen } from '../../src/family/ui.tsx';
import { createPublicMobileApi } from '../../src/lib/api.ts';
import { DataPracticesNotice } from '../../src/privacy/DataPracticesNotice.tsx';

/**
 * Parent area. Screens here require a signed-in parent; sensitive actions require step-up. The
 * native header keeps its text title (the brand mark sits in each screen's brand row) and takes
 * the brand colours: off-white ground, navy title and back control, no shadow line.
 */
export default function ParentLayout() {
  // Public client: the notice's endpoint needs no identity, and a parent may be on a screen here
  // before signing in. Not a second token source (L-007) — it carries no token at all.
  const api = useMemo(() => createPublicMobileApi(), []);
  return (
    <View style={styles.fill}>
      <Stack
        screenOptions={{
          headerTitle: 'Parent area',
          headerStyle: { backgroundColor: colors.offWhite },
          headerShadowVisible: false,
          headerTintColor: colors.navy,
          headerTitleStyle: { color: colors.navy, fontWeight: '800' },
          contentStyle: { backgroundColor: colors.offWhite },
        }}
      />
      {/* Below the stack and inside the bottom safe area, so it is on every parent screen without
          sitting under the home indicator. The child area deliberately has no equivalent. */}
      <SafeAreaView edges={['bottom']} style={styles.ground}>
        <DataPracticesNotice api={api} />
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.offWhite },
  ground: { backgroundColor: colors.offWhite },
});

/** A render error in a parent screen offers a retry rather than closing the app (MOB-R2-07). */
export function ErrorBoundary({ retry }: ErrorBoundaryProps) {
  return (
    <ErrorScreen
      title="Something went wrong"
      message="This parent screen hit a problem. You can try again; your family’s data is unchanged."
      onRetry={() => void retry()}
    />
  );
}
