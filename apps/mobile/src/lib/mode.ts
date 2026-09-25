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
  /** Resets navigation to the welcome screen (after a parent signs out). */
  resetNavigationToWelcome(): void;
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

/**
 * The client-side unlock (MOB-R1-09): the end of the server's unlock window, kept in memory only.
 * Mode 'parent' is persisted so the welcome flow knows where to go, but a cold start, a switch to
 * child mode, a sign-out, or a background stretch beyond the window all leave the parent screens
 * behind the PIN again. Never written to storage.
 */
let parentUnlockedUntilMs: number | null = null;

export function parentUnlockActive(now: Date): boolean {
  return parentUnlockedUntilMs !== null && now.getTime() < parentUnlockedUntilMs;
}

export function forgetParentUnlock(): void {
  parentUnlockedUntilMs = null;
}

/** Adult credentials are never persisted by this module; Supabase keeps its own session store. */
export async function enterChildMode(storage: SecureStorage, effects: ModeEffects): Promise<void> {
  forgetParentUnlock();
  effects.clearAdultCaches();
  // Relock even if the network call fails: local state must not keep adult data regardless.
  await effects.relockOnServer().catch(() => undefined);
  await storage.setItem(STORAGE_KEYS.mode, 'child');
  effects.resetNavigationToChildHome();
  await effects.setScreenPrivacy(false);
}

/**
 * Entering the parent area from child mode never reuses a previous unlock: callers must complete a
 * fresh PIN/biometric step-up (`unlocked` true only after the server accepted it, `unlockedUntil`
 * being the window the server granted).
 */
export async function enterParentMode(
  storage: SecureStorage,
  effects: ModeEffects,
  proof: { unlocked: boolean; unlockedUntil: string },
  now: Date = new Date(),
): Promise<'parent' | 'step_up_required'> {
  if (!proof.unlocked) return 'step_up_required';
  const until = Date.parse(proof.unlockedUntil);
  // An unreadable window never opens the screens for longer than a short default.
  parentUnlockedUntilMs = Number.isFinite(until) ? until : now.getTime() + 60_000;
  await storage.setItem(STORAGE_KEYS.mode, 'parent');
  await effects.setScreenPrivacy(true);
  return 'parent';
}

/**
 * Parent sign-out (MOB-R1-01). Order matters: the server relock needs the session token, so it
 * runs first; then the session ends, and everything adult on the device is cleared whether or not
 * the network calls succeeded. A paired child device stays paired.
 */
export async function signOutParent(
  storage: SecureStorage,
  effects: ModeEffects,
  auth: { signOut(): Promise<void> },
): Promise<void> {
  effects.clearAdultCaches();
  await effects.relockOnServer().catch(() => undefined);
  forgetParentUnlock();
  await auth.signOut().catch(() => undefined);
  // The session watcher clears caches again and unbinds the store SDK; this covers a watcher that
  // never fires (e.g. an offline sign-out that only removed the local session).
  effects.clearAdultCaches();
  await storage.setItem(STORAGE_KEYS.mode, 'signed_out');
  effects.resetNavigationToWelcome();
  await effects.setScreenPrivacy(false);
}

/** Unpairing a child device removes the child's refresh token and cached profile. */
export async function unpairChildDevice(storage: SecureStorage): Promise<void> {
  forgetParentUnlock();
  await storage.deleteItem(STORAGE_KEYS.childRefreshToken);
  await storage.deleteItem(STORAGE_KEYS.childProfile);
  await storage.setItem(STORAGE_KEYS.mode, 'signed_out');
}

export async function currentMode(storage: SecureStorage): Promise<AppMode> {
  const value = await storage.getItem(STORAGE_KEYS.mode);
  return value === 'parent' || value === 'child' ? value : 'signed_out';
}
