import { Platform } from 'react-native';
import { router } from 'expo-router';
import * as ScreenCapture from 'expo-screen-capture';
import * as SecureStore from 'expo-secure-store';
import type { ApiClient } from '@pencillift/contracts/client';
import { forgetStoreIdentity } from '../billing/revenuecat.ts';
import { createMobileApi } from '../lib/api.ts';
import {
  signOutClosedAccount,
  signOutParent,
  type DeviceSignOutOutcome,
  type ModeEffects,
} from '../lib/mode.ts';
import { parentAuth } from '../lib/parent-auth.ts';
import { secureStorage } from '../lib/secure-storage.ts';
import { createChildSession, withChildTokenRetry } from './child-session.ts';
import { clearAdultCaches, parentTokenSource, stepUpTokenSource } from './parent-session.ts';
import {
  biometricOffer,
  BIOMETRIC_ENABLED_KEY,
  BIOMETRIC_OWNER_KEY,
  BIOMETRIC_PIN_KEY,
  lockParentArea,
  type BiometricPinStore,
} from './unlock.ts';

/**
 * Native wiring for the family screens: the device keychain, the API base URL, navigation and
 * screen privacy. Logic lives in the pure modules next to this file (unit-tested); this module only
 * connects them to Expo and is covered by typechecking.
 */

export function devicePlatform(): 'ios' | 'android' | 'web' {
  return Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web';
}

/** The one child session on this device. Only this module refreshes child tokens. */
export const childSession = createChildSession({
  storage: secureStorage,
  publicApi: createMobileApi(() => Promise.resolve(null)),
  authedApi: (token) => createMobileApi(token),
  now: () => new Date(),
});

/**
 * Child API client (bearer = the paired child's in-memory access token). A single UNAUTHENTICATED
 * answer while a cached token was presented drops that token and retries once through the one
 * refresher above (MOB-R2-02), so a device whose clock moved does not report itself unpaired.
 */
export const childApi: ApiClient = withChildTokenRetry(
  createMobileApi(childSession.accessToken),
  childSession,
);

/**
 * Parent API client for parent DATA, or null while parent sign-in is not connected on this device.
 * Its token source is empty in child mode, so calls from child mode fail closed.
 */
export function parentApi(): ApiClient | null {
  const source = parentTokenSource();
  return source ? createMobileApi(source) : null;
}

/** Client for POST /v1/adult/unlock and /v1/adult/lock only (works in child mode, by design). */
export function stepUpApi(): ApiClient | null {
  const source = stepUpTokenSource();
  return source ? createMobileApi(source) : null;
}

/**
 * Decision: biometric unlock stores the parent's PIN under `requireAuthentication` with
 * WHEN_PASSCODE_SET_THIS_DEVICE_ONLY, so it never leaves this device, is not backed up, and is
 * readable only after the OS biometric prompt. The server still verifies the PIN on every unlock.
 *
 * Removing it ANSWERS whether the PIN ITEM went, and is still best effort (HUNT7-K-1): a keychain that
 * refuses that one delete must not stop the two flag deletes below — those are what withholds the
 * biometric offer — and must not throw at the callers that only want the enrolment gone (the
 * biometric-disable path, and `isEnabled`'s 'other_user' cleanup). Discarding the rejection here was
 * what let `clearDeviceAdultSecrets` report `secretsCleared: true` for a device still holding the
 * parent's 6-digit PIN: resolving proved the two FLAGS were deleted, which is the fact next to the one
 * the closure copy claims. BIOMETRIC_PIN_KEY is the only item written with `requireAuthentication` and
 * WHEN_PASSCODE_SET_THIS_DEVICE_ONLY, and expo-secure-store documents deletes as able to reject, so
 * the asymmetric failure is the plausible one rather than a theoretical one.
 */
async function clearBiometricPin(): Promise<boolean> {
  const pinRemoved = await SecureStore.deleteItemAsync(BIOMETRIC_PIN_KEY).then(
    () => true,
    () => false,
  );
  await secureStorage.deleteItem(BIOMETRIC_ENABLED_KEY);
  await secureStorage.deleteItem(BIOMETRIC_OWNER_KEY);
  return pinRemoved;
}

export const biometricPinStore: BiometricPinStore = {
  /**
   * The stored PIN belongs to one parent (MOB-R2-06): another signed-in adult, or a new account
   * after a deletion, is never offered a Face ID unlock that would submit the previous parent's PIN
   * (a failed attempt counted toward the lockout and read as "Your PIN has changed"). A PIN that
   * belongs to someone else is removed here rather than left on the device.
   *
   * Only 'other_user' removes it. A user id that cannot be read ('unknown', MOB-R4-LOCK-02) means
   * nothing about who the PIN belongs to — an offline device past its access-token expiry reports
   * exactly that — so the offer is withheld and the enrolment is left alone.
   */
  async isEnabled() {
    const [enabled, ownerUserId, signedInUserId] = await Promise.all([
      secureStorage.getItem(BIOMETRIC_ENABLED_KEY),
      secureStorage.getItem(BIOMETRIC_OWNER_KEY),
      parentAuth.userId().catch(() => null),
    ]);
    const offer = biometricOffer({ enabled: enabled === '1', ownerUserId }, signedInUserId);
    if (offer === 'other_user') {
      await clearBiometricPin();
      return false;
    }
    return offer === 'offer';
  },
  async save(pin) {
    const userId = await parentAuth.userId();
    // Without a signed-in parent there is nobody to bind the PIN to, so it is not stored at all.
    if (userId === null) throw new Error('No signed-in parent to store a biometric PIN for');
    await SecureStore.setItemAsync(BIOMETRIC_PIN_KEY, pin, {
      requireAuthentication: true,
      authenticationPrompt: 'Unlock the parent area',
      keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
    });
    await secureStorage.setItem(BIOMETRIC_OWNER_KEY, userId);
    await secureStorage.setItem(BIOMETRIC_ENABLED_KEY, '1');
  },
  async read() {
    return SecureStore.getItemAsync(BIOMETRIC_PIN_KEY, {
      requireAuthentication: true,
      authenticationPrompt: 'Unlock the parent area',
      keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
    });
  },
  /**
   * The best-effort face of `clearBiometricPin`: the callers that only want the enrolment gone (this
   * store's own 'other_user' cleanup above, unlock.ts's stale-PIN removal, the unlock screen's "turn
   * Face ID off") have nothing to do with what it answers. The one caller that must report what the
   * device kept calls the helper itself (`clearDeviceAdultSecrets`, below).
   */
  async clear() {
    await clearBiometricPin();
  },
};

/** Whether this device can offer biometric unlock at all. */
export function biometricsSupported(): boolean {
  try {
    return Platform.OS !== 'web' && SecureStore.canUseBiometricAuthentication();
  } catch {
    return false;
  }
}

/** Mode-switch side effects (src/lib/mode.ts) wired to Expo. */
export const modeEffects: ModeEffects = {
  clearAdultCaches,
  resetNavigationToChildHome() {
    if (router.canDismiss()) router.dismissAll();
    router.replace('/(child)/home');
  },
  resetNavigationToWelcome() {
    if (router.canDismiss()) router.dismissAll();
    router.replace('/');
  },
  resetNavigationToUnlock() {
    // The open parent screen goes with the lock (MOB-R2-01): nothing adult is left mounted with its
    // data, and coming back needs the PIN.
    if (router.canDismiss()) router.dismissAll();
    router.replace('/(parent)/unlock');
  },
  async relockOnServer() {
    const api = stepUpApi();
    if (api) await lockParentArea(api);
  },
  async setScreenPrivacy(enabled) {
    if (Platform.OS === 'web') return;
    try {
      if (enabled) {
        await ScreenCapture.preventScreenCaptureAsync();
        await ScreenCapture.enableAppSwitcherProtectionAsync();
      } else {
        await ScreenCapture.allowScreenCaptureAsync();
        await ScreenCapture.disableAppSwitcherProtectionAsync();
      }
    } catch {
      // Not supported everywhere; we never claim screenshots are prevented on every OS.
    }
  },
};

/**
 * Parent sign-out on this device (MOB-R1-01): server relock, Supabase session ended, adult caches
 * cleared, the biometric PIN removed, store SDK identity forgotten, mode reset and navigation back
 * to the welcome screen (or, on a paired tablet, the child's space; MOB-R2-04). The
 * session watcher in src/lib/app-session.ts also reacts to the sign-out; this covers the device
 * being offline, when that watcher may see no change.
 */
export async function signOutParentOnDevice(
  effects: ModeEffects = modeEffects,
): Promise<DeviceSignOutOutcome> {
  const { sessionEndConfirmed } = await signOutParent(secureStorage, effects, parentAuth);
  return { sessionEndConfirmed, secretsCleared: await clearDeviceAdultSecrets() };
}

/**
 * Account closure (MOB-R2-06): the same device sign-out, but the screen keeps its outcome. The
 * closure path used to call parentAuth.signOut() directly, which left mode 'parent', the in-memory
 * unlock and the biometric PIN of a deleted account on the device. Navigation is the only part left
 * out, so the parent still reads what happened to their account before leaving the screen.
 *
 * The child pairing goes too (MOB-R4-LOCK-05): signOutClosedAccount in src/lib/mode.ts carries that
 * rule and its reasoning, and is unit-tested there. It takes no argument, so the one call site
 * (app/(parent)/privacy.tsx) cannot leave the forget switched off — which is exactly what the first
 * round-4 attempt did with a `familyDeleted` flag no caller passed.
 *
 * It answers what it managed to do (HUNT6-J-1). The screen prints "and this device is signed out",
 * which is this app's claim about the device the parent is holding, so it may not rest on "the promise
 * resolved": every step that could leave the device signed in swallowed its own failure, so a
 * resolved promise only ever meant no keychain write threw.
 */
export async function signOutClosedAccountOnDevice(): Promise<DeviceSignOutOutcome> {
  const { sessionEndConfirmed } = await signOutClosedAccount(
    secureStorage,
    {
      ...modeEffects,
      resetNavigationToWelcome: () => undefined,
      resetNavigationToChildHome: () => undefined,
    },
    parentAuth,
  );
  return { sessionEndConfirmed, secretsCleared: await clearDeviceAdultSecrets() };
}

/**
 * What a signed-out device must not keep whichever way the adult left: the parent's PIN must not stay
 * for the next adult to unlock with (MOB-R2-06), and the store SDK must forget the identity it was
 * bound to. Both are best effort; neither may stop the sign-out — and both are REPORTED rather than
 * discarded (HUNT6-J-1), so the closure screen can say what happened to this device instead of
 * inferring it from nothing having thrown. Answers whether both succeeded.
 *
 * Each half is asked of the operation the flag NAMES, not of its wrapper (HUNT7-K-1). Round 6 turned
 * the two `.catch(() => undefined)`s here into `.then(() => true, () => false)` while both helpers went
 * on swallowing the failure that matters one level in — the PIN item's own delete, and
 * `Purchases.logOut()` — so `pinCleared && storeForgotten` was true whenever two plain keychain flag
 * deletes resolved: the "nothing threw" predicate HUNT6-J-1 exists to remove, one layer further in.
 * Both helpers answer now, and both still never throw, so the outer `.then(…, () => false)` is kept as
 * the belt for a rejection neither is supposed to produce.
 */
async function clearDeviceAdultSecrets(): Promise<boolean> {
  const pinCleared = await clearBiometricPin().then(
    (removed) => removed,
    () => false,
  );
  const storeForgotten = await forgetStoreIdentity().then(
    (forgotten) => forgotten,
    () => false,
  );
  return pinCleared && storeForgotten;
}
