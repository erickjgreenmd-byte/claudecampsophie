import { AppState } from 'react-native';
import type { TokenSource } from '@pencillift/contracts/client';
import { forgetStoreIdentity } from '../billing/revenuecat.ts';
import { childSession, modeEffects } from '../family/runtime.ts';
import { clearAdultCaches, registerParentTokenSource } from '../family/parent-session.ts';
import { registerPrivacyTokenSources } from '../privacy/session.ts';
import { registerRewardsTokenSources } from '../rewards/session.ts';
import {
  currentMode,
  lockParentAreaOnDevice,
  storePurchaseInFlight,
  type AppMode,
} from './mode.ts';
import { parentAuth } from './parent-auth.ts';
import { secureStorage } from './secure-storage.ts';

/**
 * A parent bearer source that yields no token while the device is in child mode, so a parent data
 * call made from child mode fails closed at the data layer, not only behind the UI gate
 * (spec P3/AC_ACCESS_07; review note on RV-lead-identity-access). Fails closed if the mode cannot
 * be read.
 */
export function parentSourceOutsideChildMode(
  source: TokenSource,
  mode: () => Promise<AppMode>,
): TokenSource {
  return async () => {
    let current: AppMode;
    try {
      current = await mode();
    } catch {
      return null;
    }
    return current === 'child' ? null : source();
  };
}

/**
 * The app's single session layer (spec P3). It is the ONLY place that hands out token sources:
 * - child: the one refresh-rotating child session (a second refresher would trip the server's
 *   reuse detection and revoke the device);
 * - parent: the Supabase session, registered only while a parent is signed in. Every parent data
 *   source (family, privacy/exports, rewards approvals) is empty in child mode, so a parent data
 *   call made from child mode fails closed at the data layer. Only the step-up source (the PIN
 *   unlock that leads OUT of child mode, and the relock) keeps the raw session.
 * It also locks the parent area whenever the app leaves the foreground in parent mode (MOB-R2-01):
 * the server step-up is revoked, the client-side unlock is forgotten, the adult caches are cleared
 * and the open parent screen is replaced by the unlock screen.
 */
export function initAppSession(): () => void {
  registerRewardsTokenSources({ child: childSession.accessToken });
  registerPrivacyTokenSources({ child: childSession.accessToken });
  const readMode = () => currentMode(secureStorage);

  const unwatch = parentAuth.watch((signedIn) => {
    const source = signedIn ? parentAuth.tokenSource : null;
    const gated = source ? parentSourceOutsideChildMode(source, readMode) : null;
    registerParentTokenSource(gated, { stepUp: source });
    registerRewardsTokenSources({ parent: gated });
    registerPrivacyTokenSources({ parent: gated });
    if (!signedIn) {
      clearAdultCaches();
      // The store SDK must stop acting for the signed-out family (RV-billing-7).
      void forgetStoreIdentity().catch(() => undefined);
    }
  });

  const appState = AppState.addEventListener('change', (next) => {
    if (next !== 'background') return;
    // The store's own purchase sheet backgrounds the activity on Android. Locking there would take
    // the plan screen away in the middle of a purchase; the verify step that follows
    // (POST /v1/billing/sync) needs no step-up, so skipping the lock costs nothing (MOB-R2-01).
    if (storePurchaseInFlight()) return;
    void readMode().then(async (mode) => {
      if (mode !== 'parent') return;
      // The whole lock, not only the server relock: the open parent screen and its data go too.
      await lockParentAreaOnDevice(modeEffects);
    });
  });

  return () => {
    unwatch();
    appState.remove();
  };
}
