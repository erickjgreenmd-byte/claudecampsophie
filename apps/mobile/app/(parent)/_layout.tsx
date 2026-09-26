import { Stack } from 'expo-router';
import type { ErrorBoundaryProps } from 'expo-router';
import { colors } from '@pencillift/ui-tokens';
import { ErrorScreen } from '../../src/family/ui.tsx';

/**
 * Parent area. Screens here require a signed-in parent; sensitive actions require step-up. The
 * native header keeps its text title (the brand mark sits in each screen's brand row) and takes
 * the brand colours: off-white ground, navy title and back control, no shadow line.
 */
export default function ParentLayout() {
  return (
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
  );
}

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
