/**
 * Parent ↔ child mode switching (spec P3, AC_ACCESS_07). Switching to child mode must leave nothing
 * usable from the adult session on a shared device: adult query caches, decrypted documents,
 * navigation history and the server-side step-up are all cleared, and returning requires fresh proof.
 *
 * Kept free of react-native imports so it is unit-testable; the app wires real implementations.
 */

export type AppMode = 'signed_out' | 'parent' | 'child';

export interface SecureStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

export interface ModeEffects {
  /** Clears every cached adult API response (query client, in-memory stores). */
  clearAdultCaches(): void;
  /** Resets navigation so the back stack contains no adult screens. */
  resetNavigationToChildHome(): void;
  /** Server-side relock (POST /v1/adult/lock) so the step-up cannot be reused. */
  relockOnServer(): Promise<void>;
  /** Hides content in the app switcher / screenshots where the OS supports it. */
  setScreenPrivacy(enabled: boolean): Promise<void>;
}

export const STORAGE_KEYS = {
  mode: 'pl.mode',
  childRefreshToken: 'pl.child.refresh',
  childProfile: 'pl.child.profile',
} as const;

/** Adult credentials are never persisted by this module; Supabase keeps its own session store. */
export async function enterChildMode(storage: SecureStorage, effects: ModeEffects): Promise<void> {
  effects.clearAdultCaches();
  // Relock even if the network call fails: local state must not keep adult data regardless.
  await effects.relockOnServer().catch(() => undefined);
  await storage.setItem(STORAGE_KEYS.mode, 'child');
  effects.resetNavigationToChildHome();
  await effects.setScreenPrivacy(false);
}

/**
 * Entering the parent area from child mode never reuses a previous unlock: callers must complete a
 * fresh PIN/biometric step-up (`unlocked` true only after the server accepted it).
 */
export async function enterParentMode(
  storage: SecureStorage,
  effects: ModeEffects,
  proof: { unlocked: boolean },
): Promise<'parent' | 'step_up_required'> {
  if (!proof.unlocked) return 'step_up_required';
  await storage.setItem(STORAGE_KEYS.mode, 'parent');
  await effects.setScreenPrivacy(true);
  return 'parent';
}

/** Unpairing a child device removes the child's refresh token and cached profile. */
export async function unpairChildDevice(storage: SecureStorage): Promise<void> {
  await storage.deleteItem(STORAGE_KEYS.childRefreshToken);
  await storage.deleteItem(STORAGE_KEYS.childProfile);
  await storage.setItem(STORAGE_KEYS.mode, 'signed_out');
}

export async function currentMode(storage: SecureStorage): Promise<AppMode> {
  const value = await storage.getItem(STORAGE_KEYS.mode);
  return value === 'parent' || value === 'child' ? value : 'signed_out';
}
