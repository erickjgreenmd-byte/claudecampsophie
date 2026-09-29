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

/**
 * What a sign-out on this device managed to do (HUNT6-J-1). Every step below is best effort — nothing
 * may STOP a sign-out — but each one is reported, because the screen that follows a closure tells the
 * parent what state the device in front of them is in, and they act on it.
 */
export interface DeviceSignOutOutcome {
  /**
   * The auth service CONFIRMED that the session ended.
   *
   * False is deliberately not "this device is still signed in" — that is the adjacent fact, and
   * claiming it would be as wrong as the claim this replaced. supabase-js (auth-js 2.116) removes the
   * local session even when the logout call failed, and returns the failure in `{ error }`; it does
   * NOT remove it when it could not read the session in the first place. So false means only that
   * this device cannot say the session is gone: either the service was never told, or the session
   * could not be read at all. The copy says exactly that (src/privacy/parent-privacy.ts).
   */
  readonly sessionEndConfirmed: boolean;
  /**
   * The parent's biometric PIN and the store SDK identity were both removed from this device.
   *
   * Each half is what the operation itself reported (HUNT7-K-1): the keychain accepted the delete of
   * the PIN ITEM — not merely of the two flags that withhold the biometric offer — and the store SDK
   * accepted the logOut, or has since been bound to another family. False is therefore "this device
   * may still hold one of them", which is what the copy says (src/privacy/parent-privacy.ts).
   */
  readonly secretsCleared: boolean;
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
 * Which adult the client-side parent state belongs to (HUNT5-H-1). Memory only, like the unlock
 * above: the signed-in parent's user id, recorded by the session watcher (src/lib/app-session.ts) on
 * every auth change, and a counter that moves whenever that is somebody else (or nobody).
 *
 * A parent screen that is already 'ready' is handed its own state back on a re-check, so an ordinary
 * back-navigation does not flash "Loading your family" over data the parent is reading. The data on
 * that screen belongs to the adult who fetched it, though, while the client's token source follows
 * whoever is signed in now — so on a handed-on tablet the next adult was shown the previous one's
 * children. The screen records the generation its state was published under and compares it on every
 * re-check: the same adult keeps the screen, a different one gets fresh state and a refetch.
 */
let parentStateOwnerUserId: string | null = null;
let parentIdentityChanges = 0;

/** The identity a parent screen's state is published under; it moves when the adult changes. */
export function parentIdentityGeneration(): number {
  return parentIdentityChanges;
}

/**
 * Records the adult the parent state belongs to now: their user id, or null when nobody is signed in
 * on this device — or when this device cannot read who is. The same id twice (supabase-js reports a
 * token refresh as an auth change too) is not a new adult and leaves the screens alone.
 *
 * Null is never "the same adult": nobody is not the same person twice. `parentAuth.userId()` reads
 * the session and resolves to nothing on a device that is offline past its token expiry, so null
 * stands for an adult this device cannot name as well as for no adult at all — and an early return on
 * null after null left a screen published for the previous adult current for the next one, which is
 * the handed-on tablet HUNT5-H-1 is about. So an unnamed owner always moves the identity: it costs a
 * mounted screen one refetch.
 *
 * What that refetch does to the rows already on the screen is the SCREEN's business, not this
 * counter's: the sentence here used to add "and never keeps its rows", which was untrue of every
 * screen — the moved identity publishes a new client, and the shared load hook preserved its 'ready'
 * state across it, so the previous adult's rows stayed up for the length of the new request
 * (HUNT6-I-2). The hook drops them before the fetch now (`loadStateForRun`,
 * src/family/family-view.ts). Component state that is not keyed on the identity — a nickname typed
 * into Add child and never submitted — still survives the refetch, so this is about rows, not about
 * everything on the screen.
 */
export function noteParentIdentity(userId: string | null): void {
  if (userId !== null && userId === parentStateOwnerUserId) return;
  parentStateOwnerUserId = userId;
  parentIdentityChanges += 1;
}

/**
 * Whether state a parent screen already published still belongs to the adult at the device. A screen
 * that has published nothing (null) has nothing to keep.
 */
export function parentStateStillCurrent(publishedUnder: number | null): boolean {
  return publishedUnder !== null && publishedUnder === parentIdentityChanges;
}

/**
 * A screen-privacy change the child's space is owed, applied only once the app is in the foreground
 * (HUNT6-I-4). Memory only, never persisted; a fresh process starts with OS capture allowed anyway,
 * because expo-screen-capture's protection lives in the process that asked for it.
 *
 * Locking a paired tablet returns it to the child's space, and the child's space must allow
 * screenshots, screen recording and casting (MOB-R2-05, BUG-287). But one of the two ways the lock is
 * reached is the app LEAVING the foreground (src/lib/app-session.ts), and the frame the OS snapshots
 * for its app-switcher card at that transition is still the ADULT one: resetNavigationToChildHome is
 * a JS router.replace (src/family/runtime.ts), which cannot paint while the app is suspended. Turning
 * protection off inside that handler removed it at the one instant it exists for. So the lock records
 * the debt, and the callers that KNOW the app is in the foreground settle it: the 'active' handler in
 * src/lib/app-session.ts, the same file's backgrounding handler once the lock has finished and
 * AppState says the app is back (HUNT7-A-1), and the Lock button the parent has just pressed
 * (src/family/ui.tsx).
 *
 * The debt NAMES what it is owed for (HUNT7-A-2): the space, and the device store the lock read the
 * mode from. It was a bare boolean, so nothing could tell whether it was still due — and nothing
 * cleared it when the device left the child space, because `enterParentMode` writes mode 'parent',
 * switches protection ON and left the flag standing. A settle that arrived after that switched ADULT
 * protection off with parent screens mounted (on iOS every 'inactive' → 'active' blip reaches the
 * settler: control centre, the notification shade, a Face ID prompt, a dismissed call, none of which
 * runs the lock). The three functions that apply a privacy state of their own drop the debt now, and
 * the settle re-reads the mode before it applies anything.
 */
let screenPrivacyDebt: { readonly space: 'child'; readonly storage: SecureStorage } | null = null;

/** Whether the child's space is still owed its screen-privacy change. */
export function childSpaceOwesScreenPrivacy(): boolean {
  return screenPrivacyDebt !== null;
}

/**
 * Dropped by every path that applies a screen-privacy state of its own (HUNT7-A-2), so no deferred
 * change can arrive after the state it was computed for has been replaced.
 */
function forgetScreenPrivacyDebt(): void {
  screenPrivacyDebt = null;
}

/**
 * Settles that debt — and only from a caller that is sure the app is in the foreground, since the
 * whole point is that the adult frame stays protected while the OS snapshots it. Answers whether the
 * change was APPLIED. The debt is dropped before anything is awaited, so two settles cannot both
 * apply it and an OS that refuses is not retried on every foreground: the child's space allowing
 * capture is a comfort, adult protection is not.
 *
 * Being owed is not enough (HUNT7-A-2): the device may have left the space the debt was recorded for,
 * and only the keychain can say so, which is why the debt carries the store it was recorded against
 * rather than trusting whatever store a later caller happens to hold. A mode that cannot be read is
 * not the child's space, so protection stays as it is.
 */
export async function settleChildSpaceScreenPrivacy(
  effects: Pick<ModeEffects, 'setScreenPrivacy'>,
): Promise<boolean> {
  const debt = screenPrivacyDebt;
  if (debt === null) return false;
  screenPrivacyDebt = null;
  const mode = await currentMode(debt.storage).catch((): AppMode => 'parent');
  if (mode !== debt.space) return false;
  await effects.setScreenPrivacy(false).catch(() => undefined);
  return true;
}

/**
 * Locking the parent area on this device (MOB-R2-01). One action for every way the area is locked —
 * the app leaving the foreground in parent mode, and both "Lock parent area" buttons — because
 * revoking only the server step-up left the open parent screen showing its data and every other
 * parent screen one tap away for the rest of the server's window (the read routes behind them need
 * only a signed-in parent). The parent stays signed in: coming back needs the PIN, not the password.
 *
 * A device that holds a child pairing goes back to the child's space (MOB-R4-LOCK-01), the way
 * signing out already did (MOB-R2-04). Locking used to leave mode 'parent' and replace the whole
 * stack with the PIN screen, so on a family tablet the child was left on a PIN field with no way
 * back (one route in the stack means no back arrow) and the next cold start showed the parent/child
 * chooser, because entryRoute only sends mode 'child' straight to the child home. The child space
 * needs no PIN; the parent PINs back in from "Grown-ups".
 *
 * Answers whether the child's space is still owed its screen-privacy change (HUNT7-A-1). The
 * backgrounding caller needs that answer: the debt below is recorded after three awaited keychain
 * round trips, so the 'active' event that was supposed to settle it can have gone by already.
 */
export async function lockParentAreaOnDevice(
  storage: SecureStorage,
  effects: ModeEffects,
): Promise<boolean> {
  // Local state first: an offline relock must not leave the screens open.
  forgetParentUnlock();
  effects.clearAdultCaches();
  // A keychain that cannot be read counts as unpaired: the unlock screen is the safe fallback.
  const childPaired = await storage
    .getItem(STORAGE_KEYS.childRefreshToken)
    .then((token) => token !== null)
    .catch(() => false);
  if (childPaired) {
    await storage.setItem(STORAGE_KEYS.mode, 'child').catch(() => undefined);
    effects.resetNavigationToChildHome();
    // The child's space is not an adult screen, so it is owed screen privacy off as every other way
    // in gives it (enterChildMode, signOutParent), or the child keeps a tablet that refuses
    // screenshots, screen recording and casting (MOB-R2-05, HUNT5-G-4). useChildModeOnFocus cannot
    // correct it, because the mode written above makes that hook return early. It is RECORDED here
    // and not applied here (HUNT6-I-4): this same function runs from the backgrounding handler, where
    // the adult screen is still the painted frame, so switching protection off here removed it at the
    // exact moment the OS snapshots the app. `settleChildSpaceScreenPrivacy` applies it, and the debt
    // names the space and the store it was read from so no later settle can apply it to another state.
    screenPrivacyDebt = { space: 'child', storage };
  } else {
    // A parent-only device stays in parent mode on the unlock screen: adult privacy stays on.
    effects.resetNavigationToUnlock();
  }
  await effects.relockOnServer().catch(() => undefined);
  // Still owed, i.e. no settle overtook this lock while the relock was out.
  return childSpaceOwesScreenPrivacy();
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
  // This path applies the child space's screen-privacy state itself, below, so a deferred one is void.
  forgetScreenPrivacyDebt();
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
  // The device is the adult's again, so any deferred child-space change is void (HUNT7-A-2): letting
  // one arrive after this line switched adult protection off with parent screens on screen.
  forgetScreenPrivacyDebt();
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
  auth: { signOut(): Promise<{ ok: boolean }> },
): Promise<Pick<DeviceSignOutOutcome, 'sessionEndConfirmed'>> {
  const childPaired = (await storage.getItem(STORAGE_KEYS.childRefreshToken)) !== null;
  effects.clearAdultCaches();
  await effects.relockOnServer().catch(() => undefined);
  forgetParentUnlock();
  // This path applies its own screen-privacy state at the end, so a deferred one is void.
  forgetScreenPrivacyDebt();
  // Reported, not swallowed (HUNT6-J-1). Nothing below is skipped whatever this answered — that is
  // the "nothing may stop the sign-out" rule and it is unchanged — but the answer reaches the caller,
  // because `.catch(() => undefined)` here, on top of parentAuth.signOut dropping supabase's own
  // `{ error }`, meant the only fact a screen could observe was that no keychain write threw.
  const sessionEndConfirmed = await auth.signOut().then(
    (result) => result.ok,
    () => false,
  );
  // The session watcher clears caches again and unbinds the store SDK; this covers a watcher that
  // never fires (e.g. an offline sign-out that only removed the local session).
  effects.clearAdultCaches();
  await storage.setItem(STORAGE_KEYS.mode, childPaired ? 'child' : 'signed_out');
  if (childPaired) effects.resetNavigationToChildHome();
  else effects.resetNavigationToWelcome();
  await effects.setScreenPrivacy(false);
  return { sessionEndConfirmed };
}

/**
 * Closing the parent's own account on this device (MOB-R4-LOCK-05). The same sign-out, and then the
 * device also stops being the child's: an account closure is not a sign-out, because the adult who
 * set this device up is gone.
 *
 * signOutParent deliberately leaves a paired tablet in child mode with its pairing intact
 * (MOB-R2-04). After a closure that rule strands the device: the family owner can only close their
 * sign-in once the whole-family deletion has been requested (ACCOUNT_CLOSE_COPY.familyDeletionRequired),
 * which already revoked the child's session server-side, so every later launch went straight to the
 * child home of a deleted family with the child's refresh token and cached nickname still in the
 * keychain.
 *
 * The forget is unconditional and local. The first round-4 attempt made it conditional on a
 * `familyDeleted` flag, so that a guardian's own closure (the family lives on) kept the pairing —
 * but no caller passed the flag, and the fix never ran on the path the finding describes. Nothing on
 * this device can tell the two closures apart, so the honest state after either is a device with no
 * adult sign-in and no child credential: the child re-enters a connect code, which is one step from
 * the child home's "Grown-ups" route. Nothing is revoked on the wire, so a guardian's closure costs
 * a live child session nothing.
 */
export async function signOutClosedAccount(
  storage: SecureStorage,
  effects: ModeEffects,
  auth: { signOut(): Promise<{ ok: boolean }> },
): Promise<Pick<DeviceSignOutOutcome, 'sessionEndConfirmed'>> {
  const outcome = await signOutParent(storage, effects, auth);
  await unpairChildDevice(storage);
  return outcome;
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
