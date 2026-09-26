import { AppState } from 'react-native';
import type { TokenSource } from '@pencillift/contracts/client';
import { forgetStoreIdentity } from '../billing/revenuecat.ts';
import { childSession, modeEffects } from '../family/runtime.ts';
import { clearAdultCaches, registerParentTokenSource } from '../family/parent-session.ts';
import { registerPrivacyTokenSources } from '../privacy/session.ts';
import { registerRewardsTokenSources } from '../rewards/session.ts';
import {
  currentMode,
  forgetParentUnlock,
  lockParentAreaOnDevice,
  noteParentIdentity,
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
      // The client-side unlock belongs to the session that earned it (MOB-R4-LOCK-04). A session
      // that ends elsewhere (portal "sign out everywhere", a password change) used to leave the
      // grant running for the rest of its window, so the next parent to sign in on this device
      // reached the parent screens with no fresh PIN unlock.
      forgetParentUnlock();
      // And the parent state on this device now belongs to nobody (HUNT5-G-5/H-1). This is what a
      // screen still mounted as 'ready' is measured against: the gate reuses such a screen's state
      // only while it belongs to the adult at the device, so the next re-check of that screen (its
      // focus, or the app returning to the foreground) publishes fresh state and refetches instead
      // of handing on the previous parent's data. It is recorded here, synchronously, because this
      // is the moment the session goes; the gate deliberately does not re-check on this event
      // itself (src/family/ui.tsx explains why: privacy.tsx's own closure confirmation).
      noteParentIdentity(null);
      clearAdultCaches();
      // The store SDK must stop acting for the signed-out family (RV-billing-7).
      void forgetStoreIdentity().catch(() => undefined);
    } else {
      // A session that appears: record WHOSE it is, so a screen mounted under the previous adult is
      // replaced rather than reused even if this device never saw that session end (HUNT5-H-1).
      // Reading the id is asynchronous; it cannot leave a gap, because a session ending has already
      // moved the identity above, and the same id twice changes nothing. An id that cannot be read
      // counts as nobody's, which costs a mounted screen one refetch and never keeps its rows —
      // including when the previous owner was also nobody, because noteParentIdentity treats an
      // unnamed owner as a new one every time (src/lib/mode.ts: nobody is not the same person
      // twice). userId() reads the session, so an offline device past its token expiry reaches this
      // line with null for an adult who is signed in.
      const recordParentIdentity = async () => noteParentIdentity(await parentAuth.userId());
      void recordParentIdentity().catch(() => noteParentIdentity(null));
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
      // On a paired family tablet this also returns the device to the child's space
      // (MOB-R4-LOCK-01), so backgrounding cannot strand a child on the PIN screen.
      await lockParentAreaOnDevice(secureStorage, modeEffects);
    });
  });

  return () => {
    unwatch();
    appState.remove();
  };
}
