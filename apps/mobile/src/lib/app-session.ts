import { AppState } from 'react-native';
import { childSession, modeEffects } from '../family/runtime.ts';
import { clearAdultCaches, registerParentTokenSource } from '../family/parent-session.ts';
import { registerPrivacyTokenSources } from '../privacy/session.ts';
import { registerRewardsTokenSources } from '../rewards/session.ts';
import { currentMode } from './mode.ts';
import { parentAuth } from './parent-auth.ts';
import { secureStorage } from './secure-storage.ts';

/**
 * The app's single session layer (spec P3). It is the ONLY place that hands out token sources:
 * - child: the one refresh-rotating child session (a second refresher would trip the server's
 *   reuse detection and revoke the device);
 * - parent: the Supabase session, registered only while a parent is signed in.
 * It also relocks the parent area whenever the app leaves the foreground in parent mode.
 */
export function initAppSession(): () => void {
  registerRewardsTokenSources({ child: childSession.accessToken });
  registerPrivacyTokenSources({ child: childSession.accessToken });

  const unwatch = parentAuth.watch((signedIn) => {
    const source = signedIn ? parentAuth.tokenSource : null;
    registerParentTokenSource(source);
    registerRewardsTokenSources({ parent: source });
    registerPrivacyTokenSources({ parent: source });
    if (!signedIn) clearAdultCaches();
  });

  const appState = AppState.addEventListener('change', (next) => {
    if (next !== 'background') return;
    void currentMode(secureStorage).then(async (mode) => {
      if (mode !== 'parent') return;
      clearAdultCaches();
      await modeEffects.relockOnServer().catch(() => undefined);
    });
  });

  return () => {
    unwatch();
    appState.remove();
  };
}
