import { Stack } from 'expo-router';

/** Parent area. Screens here require a signed-in parent; sensitive actions require step-up. */
export default function ParentLayout() {
  return <Stack screenOptions={{ headerTitle: 'Parent area' }} />;
}
