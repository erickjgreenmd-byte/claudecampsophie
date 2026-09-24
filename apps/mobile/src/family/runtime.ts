import { Platform } from 'react-native';
import { router } from 'expo-router';
import * as ScreenCapture from 'expo-screen-capture';
import * as SecureStore from 'expo-secure-store';
import type { ApiClient } from '@pencillift/contracts/client';
import { createMobileApi } from '../lib/api.ts';
import type { ModeEffects } from '../lib/mode.ts';
import { secureStorage } from '../lib/secure-storage.ts';
import { createChildSession } from './child-session.ts';
import { clearAdultCaches, parentTokenSource, stepUpTokenSource } from './parent-session.ts';
import {
  BIOMETRIC_ENABLED_KEY,
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

/** Child API client (bearer = the paired child's in-memory access token). */
export const childApi: ApiClient = createMobileApi(childSession.accessToken);

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
 */
export const biometricPinStore: BiometricPinStore = {
  async isEnabled() {
    return (await secureStorage.getItem(BIOMETRIC_ENABLED_KEY)) === '1';
  },
  async save(pin) {
    await SecureStore.setItemAsync(BIOMETRIC_PIN_KEY, pin, {
      requireAuthentication: true,
      authenticationPrompt: 'Unlock the parent area',
      keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
    });
    await secureStorage.setItem(BIOMETRIC_ENABLED_KEY, '1');
  },
  async read() {
    return SecureStore.getItemAsync(BIOMETRIC_PIN_KEY, {
      requireAuthentication: true,
      authenticationPrompt: 'Unlock the parent area',
      keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
    });
  },
  async clear() {
    await SecureStore.deleteItemAsync(BIOMETRIC_PIN_KEY).catch(() => undefined);
    await secureStorage.deleteItem(BIOMETRIC_ENABLED_KEY);
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
