import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { initAppSession } from '../src/lib/app-session.ts';

export default function RootLayout() {
  // One session layer for the whole app: token sources and relock-on-background.
  useEffect(() => initAppSession(), []);
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }} />
    </SafeAreaProvider>
  );
}
