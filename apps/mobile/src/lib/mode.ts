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
  /**
   * Resets navigation to the parent-area unlock screen, so the open parent screen and its data are
   * gone once the area is locked (MOB-R2-01).
   */
  resetNavigationToUnlock(): void;
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

/**
 * Locking the parent area on this device (MOB-R2-01). One action for every way the area is locked —
 * the app leaving the foreground in parent mode, and both "Lock parent area" buttons — because
 * revoking only the server step-up left the open parent screen showing its data and every other
 * parent screen one tap away for the rest of the server's window (the read routes behind them need
 * only a signed-in parent). The parent stays signed in and the device stays in parent mode: coming
 * back needs the PIN, not the password.
 */
export async function lockParentAreaOnDevice(effects: ModeEffects): Promise<void> {
  // Local state first: an offline relock must not leave the screens open.
  forgetParentUnlock();
  effects.clearAdultCaches();
  effects.resetNavigationToUnlock();
  await effects.relockOnServer().catch(() => undefined);
}

/**
 * The store's own purchase sheet backgrounds the app's activity on Android, which would otherwise
 * lock the parent area in the middle of a purchase and lose the verify step. A purchase marks itself
 * in flight, and backgrounding skips the lock while it is. Module state, never persisted, and always
 * cleared — including when the purchase throws.
 */
let openStorePurchases = 0;
let newestStorePurchaseMs: number | null = null;

/**
 * How long a purchase may hold the exemption. The store's own sheet is a few taps; past this the
 * device locks as if no purchase were open. Without the deadline a promise that never settles (a
 * sheet the user walks away from, a provider that stops answering) left the parent area unlocked and
 * unrelocked for the life of the app — the exemption's own residual, found by the round-3 checker.
 * What a lapse can cost is the purchase's verify step, which POST /v1/billing/sync recovers; what it
 * protects is every parent screen on a device someone else may pick up.
 */
const STORE_PURCHASE_EXEMPTION_MS = 5 * 60_000;

export function storePurchaseInFlight(nowMs: number = Date.now()): boolean {
  if (openStorePurchases === 0 || newestStorePurchaseMs === null) return false;
  return nowMs - newestStorePurchaseMs < STORE_PURCHASE_EXEMPTION_MS;
}

export async function whileStorePurchaseOpen<T>(
  run: () => Promise<T>,
  startedMs: number = Date.now(),
): Promise<T> {
  openStorePurchases += 1;
  // The newest start owns the window, so a second purchase after a lapsed one is exempt again.
  newestStorePurchaseMs = startedMs;
  try {
    return await run();
  } finally {
    openStorePurchases = Math.max(0, openStorePurchases - 1);
    if (openStorePurchases === 0) newestStorePurchaseMs = null;
  }
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
  proof: { unlocked: boolean; unlockedUntil: string; unlockSeconds?: number | undefined },
  now: Date = new Date(),
): Promise<'parent' | 'step_up_required' | 'window_lapsed'> {
  if (!proof.unlocked) return 'step_up_required';
  // The window is held on THIS device's clock (MOB-R2-03): `unlockedUntil` is a database instant, so
  // a device clock more than the TTL ahead read the window as already over and sent the parent
  // straight back to the PIN screen with no message. The server's stated length, measured from the
  // device's own now, is never longer than the window the server granted.
  const seconds = proof.unlockSeconds;
  if (seconds !== undefined && Number.isFinite(seconds) && seconds > 0) {
    parentUnlockedUntilMs = now.getTime() + seconds * 1000;
  } else {
    // An API that states no length: fall back to the instant, and to a short default when even that
    // is unreadable. A lapsed window is reported below rather than silently redirecting.
    const until = Date.parse(proof.unlockedUntil);
    parentUnlockedUntilMs = Number.isFinite(until) ? until : now.getTime() + 60_000;
  }
  if (!parentUnlockActive(now)) {
    // Nothing is opened and nothing is persisted: the screen says the unlock did not hold.
    forgetParentUnlock();
    return 'window_lapsed';
  }
  await storage.setItem(STORAGE_KEYS.mode, 'parent');
  await effects.setScreenPrivacy(true);
  return 'parent';
}

/**
 * Parent sign-out (MOB-R1-01). Order matters: the server relock needs the session token, so it
 * runs first; then the session ends, and everything adult on the device is cleared whether or not
 * the network calls succeeded.
 *
 * A device that holds a child pairing goes back to the child's space, not to the welcome chooser
 * (MOB-R2-04): writing mode 'signed_out' on a paired tablet stopped it opening in the child space
 * at all, because entryRoute only sends mode 'child' straight to the child home. The pairing itself
 * is untouched either way.
 */
export async function signOutParent(
  storage: SecureStorage,
  effects: ModeEffects,
  auth: { signOut(): Promise<void> },
): Promise<void> {
  const childPaired = (await storage.getItem(STORAGE_KEYS.childRefreshToken)) !== null;
  effects.clearAdultCaches();
  await effects.relockOnServer().catch(() => undefined);
  forgetParentUnlock();
  await auth.signOut().catch(() => undefined);
  // The session watcher clears caches again and unbinds the store SDK; this covers a watcher that
  // never fires (e.g. an offline sign-out that only removed the local session).
  effects.clearAdultCaches();
  await storage.setItem(STORAGE_KEYS.mode, childPaired ? 'child' : 'signed_out');
  if (childPaired) effects.resetNavigationToChildHome();
  else effects.resetNavigationToWelcome();
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
