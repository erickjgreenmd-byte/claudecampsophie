import { Stack } from 'expo-router';

/** Child space. Only child-scoped data; no ads, purchases, answer keys or adult screens. */
export default function ChildLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
