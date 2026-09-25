import { Stack } from 'expo-router';
import { colors } from '@pencillift/ui-tokens';

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
