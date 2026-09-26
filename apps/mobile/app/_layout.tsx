import { useEffect } from 'react';
import { Stack } from 'expo-router';
import type { ErrorBoundaryProps } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorScreen } from '../src/family/ui.tsx';
import { initAppSession } from '../src/lib/app-session.ts';

export default function RootLayout() {
  // One session layer for the whole app: token sources and lock-on-background.
  useEffect(() => initAppSession(), []);
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }} />
    </SafeAreaProvider>
  );
}

/**
 * Last resort for a render error anywhere in the app (MOB-R2-07). Without a boundary, one unexpected
 * value reaching a view unmounts the root, which in a release build is a crash or a blank screen for
 * a child or a parent. The words stay calm and name no internals; the boundary's `error` carries
 * developer detail only and is never shown. `retry` re-renders the route.
 */
export function ErrorBoundary({ retry }: ErrorBoundaryProps) {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <ErrorScreen
        title="Something went wrong"
        message="PencilLift hit a problem on this screen. You can try again; nothing you sent is lost."
        onRetry={() => void retry()}
      />
    </SafeAreaProvider>
  );
}
