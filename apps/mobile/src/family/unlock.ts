import { adultUnlockResponseSchema, familyOkResponseSchema } from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';

/**
 * Parent-area unlock (spec P3, AC_ACCESS_07/08). The server always verifies the PIN and enforces
 * rate limits and lockout. Biometric unlock is only a convenience: if the parent opts in, the PIN
 * is kept in the device keychain behind the OS biometric prompt, read back after the prompt, and
 * sent to the server exactly like a typed PIN. Pure: no react-native imports.
 */

/** Keychain entry holding the parent's PIN, readable only after an OS biometric prompt. */
export const BIOMETRIC_PIN_KEY = 'pl.parent.biometricPin';
/** Non-secret flag so the screen can offer biometrics without triggering a prompt. */
export const BIOMETRIC_ENABLED_KEY = 'pl.parent.biometricEnabled';

export interface BiometricPinStore {
  isEnabled(): Promise<boolean>;
  /** Saves the PIN behind biometric authentication. */
  save(pin: string): Promise<void>;
  /** Shows the OS biometric prompt; null when cancelled, failed or nothing is stored. */
  read(): Promise<string | null>;
  clear(): Promise<void>;
}

export type UnlockOutcome =
  | { readonly kind: 'unlocked'; readonly unlockedUntil: string }
  | { readonly kind: 'error'; readonly message: string; readonly wrongPin: boolean }
  /** The stored PIN no longer matches (it was changed): biometrics are turned off. */
  | { readonly kind: 'pin_changed'; readonly message: string }
  | { readonly kind: 'cancelled' };

export function pinEntryError(pin: string): string | null {
  return /^\d{6}$/.test(pin) ? null : 'Enter your 6-digit parent PIN.';
}

export function unlockErrorMessage(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return 'Something went wrong. Please try again.';
  if (error.code === 'FORBIDDEN') return 'That PIN is not correct.';
  if (error.code === 'NOT_FOUND') return 'Set a parent PIN in the parent portal first.';
  const serverWorded = ['LOCKED_OUT', 'RATE_LIMITED', 'NETWORK', 'UNAUTHENTICATED'] as const;
  return (serverWorded as readonly string[]).includes(error.code)
    ? error.message
    : 'Something went wrong. Please try again.';
}

export async function unlockWithPin(api: ApiClient, pin: string): Promise<UnlockOutcome> {
  const invalid = pinEntryError(pin);
  if (invalid) return { kind: 'error', message: invalid, wrongPin: false };
  try {
    const result = await api.send(
      'POST',
      '/v1/adult/unlock',
      { method: 'pin', pin },
      adultUnlockResponseSchema,
    );
    return { kind: 'unlocked', unlockedUntil: result.unlockedUntil };
  } catch (error) {
    return {
      kind: 'error',
      message: unlockErrorMessage(error),
      wrongPin: error instanceof ApiRequestError && error.code === 'FORBIDDEN',
    };
  }
}

/** Biometric convenience: OS prompt, then the same server-verified PIN unlock. */
export async function unlockWithBiometrics(
  api: ApiClient,
  store: BiometricPinStore,
): Promise<UnlockOutcome> {
  let pin: string | null;
  try {
    pin = await store.read();
  } catch {
    pin = null;
  }
  if (pin === null) return { kind: 'cancelled' };
  const outcome = await unlockWithPin(api, pin);
  if (outcome.kind === 'error' && outcome.wrongPin) {
    // A stale stored PIN must not keep failing (and counting toward lockout).
    await store.clear();
    return {
      kind: 'pin_changed',
      message: 'Your PIN has changed. Enter it once to turn biometric unlock back on.',
    };
  }
  return outcome;
}

/** Where a forgotten PIN is reset: the portal's verified recovery page (re-auth, then new PIN). */
export const PIN_RESET_PATH = '/app/security/reset-pin';

export interface PinResetGuidance {
  readonly text: string;
  /** Absolute link to the portal's reset page, or null when this build has no portal origin. */
  readonly url: string | null;
}

/**
 * Honest "Forgot your PIN?" guidance (spec P3: reset only through verified parent recovery;
 * AC_ACCESS_08). The reset works in the parent portal, so never say it does not exist
 * (RV-family-4); link straight to it when the portal origin is configured.
 */
export function pinResetGuidance(portalUrl: string | null): PinResetGuidance {
  const origin = portalUrl?.trim().replace(/\/+$/, '') ?? '';
  if (!/^https:\/\/[^/\s]+$/.test(origin)) {
    return {
      text: 'Forgot your PIN? Reset it in the parent portal: open Security, choose “Reset your parent PIN”, and confirm your account password.',
      url: null,
    };
  }
  return {
    text: 'Forgot your PIN? Reset it in the parent portal after confirming your account password.',
    url: `${origin}${PIN_RESET_PATH}`,
  };
}

/** Relocks the parent area on the server (switching to child mode, or the parent tapping Lock). */
export async function lockParentArea(api: ApiClient): Promise<boolean> {
  try {
    await api.send('POST', '/v1/adult/lock', undefined, familyOkResponseSchema);
    return true;
  } catch {
    return false;
  }
}
