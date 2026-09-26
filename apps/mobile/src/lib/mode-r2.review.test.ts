import { afterEach, describe, expect, it, vi } from 'vitest';
import { entryRoute } from './entry.ts';
import {
  currentMode,
  enterParentMode,
  forgetParentUnlock,
  lockParentAreaOnDevice,
  noteParentIdentity,
  parentIdentityGeneration,
  parentStateStillCurrent,
  parentUnlockActive,
  signOutClosedAccount,
  signOutParent,
  storePurchaseInFlight,
  STORAGE_KEYS,
  whileStorePurchaseOpen,
  type ModeEffects,
  type SecureStorage,
} from './mode.ts';

/**
 * Mobile round-2 hardening of the parent/child split (MOB-R2-01, MOB-R2-03, MOB-R2-04).
 * The clock is pinned (L-027): every instant below comes from SERVER_NOW.
 */

const SERVER_NOW = new Date('2026-09-24T15:00:00Z');
const UNLOCK_SECONDS = 300;
const SERVER_UNTIL = new Date(SERVER_NOW.getTime() + UNLOCK_SECONDS * 1000).toISOString();

function memoryStorage(): SecureStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => Promise.resolve(data.get(k) ?? null),
    setItem: (k, v) => {
      data.set(k, v);
      return Promise.resolve();
    },
    deleteItem: (k) => {
      data.delete(k);
      return Promise.resolve();
    },
  };
}

function effects(overrides: Partial<ModeEffects> = {}): ModeEffects & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    clearAdultCaches: () => calls.push('clear'),
    resetNavigationToChildHome: () => calls.push('reset-nav'),
    resetNavigationToWelcome: () => calls.push('reset-welcome'),
    resetNavigationToUnlock: () => calls.push('reset-unlock'),
    relockOnServer: () => {
      calls.push('relock');
      return Promise.resolve();
    },
    setScreenPrivacy: (on) => {
      calls.push(`privacy:${on}`);
      return Promise.resolve();
    },
    ...overrides,
  };
}

afterEach(() => forgetParentUnlock());

/**
 * MOB-R2-01. Backgrounding the app, and either "Lock parent area" button, used to revoke only the
 * server step-up: the open parent screen kept its data and every other parent screen still opened
 * without a PIN until the server's window ran out.
 */
describe('one lock action for backgrounding and both Lock buttons (MOB-R2-01)', () => {
  it('forgets the client unlock, clears the adult caches, relocks and goes to the unlock screen', async () => {
    const storage = memoryStorage();
    await enterParentMode(
      storage,
      effects(),
      { unlocked: true, unlockedUntil: SERVER_UNTIL, unlockSeconds: UNLOCK_SECONDS },
      SERVER_NOW,
    );
    expect(parentUnlockActive(SERVER_NOW)).toBe(true);

    const fx = effects();
    await lockParentAreaOnDevice(storage, fx);
    // The next parent screen needs a fresh PIN, whatever the server's window still says.
    expect(parentUnlockActive(SERVER_NOW)).toBe(false);
    expect(fx.calls).toContain('clear');
    expect(fx.calls).toContain('relock');
    expect(fx.calls).toContain('reset-unlock');
    // Locking is not signing out and not leaving parent mode: the parent PINs back in.
    expect(await currentMode(storage)).toBe('parent');
  });

  it('still locks locally when the server relock fails offline', async () => {
    const storage = memoryStorage();
    await enterParentMode(
      storage,
      effects(),
      { unlocked: true, unlockedUntil: SERVER_UNTIL, unlockSeconds: UNLOCK_SECONDS },
      SERVER_NOW,
    );
    const fx = effects({ relockOnServer: vi.fn(() => Promise.reject(new Error('offline'))) });
    await lockParentAreaOnDevice(storage, fx);
    expect(parentUnlockActive(SERVER_NOW)).toBe(false);
    expect(fx.calls).toContain('reset-unlock');
  });

  it('an open store purchase sheet is exempt: it backgrounds the activity mid-purchase', async () => {
    expect(storePurchaseInFlight()).toBe(false);
    const seen: boolean[] = [];
    const result = await whileStorePurchaseOpen(() => {
      seen.push(storePurchaseInFlight());
      return Promise.resolve('done');
    });
    expect(result).toBe('done');
    expect(seen).toEqual([true]);
    // The flag is cleared again afterwards, so the next backgrounding does lock.
    expect(storePurchaseInFlight()).toBe(false);
  });

  it('a failed purchase clears the exemption too', async () => {
    await expect(
      whileStorePurchaseOpen(() => Promise.reject(new Error('store unavailable'))),
    ).rejects.toThrow('store unavailable');
    expect(storePurchaseInFlight()).toBe(false);
  });

  /**
   * Lead follow-up to the acceptance checker's residual: the exemption skips the whole background
   * lock, including the server relock HEAD did unconditionally. A store promise that never settles
   * (a sheet the user leaves open, a provider that stops answering) would therefore disable the lock
   * for as long as the app lived. The exemption is bounded: past the window the device locks as if
   * no purchase were open, and the purchase's own verify step is the thing that may be lost, not the
   * parent area.
   */
  it('the exemption lapses, so a purchase that never settles cannot hold the lock open', async () => {
    const started = 1_780_000_000_000;
    const seen: { atStart: boolean; nearEnd: boolean; past: boolean } = {
      atStart: false,
      nearEnd: false,
      past: false,
    };
    await whileStorePurchaseOpen(() => {
      seen.atStart = storePurchaseInFlight(started);
      seen.nearEnd = storePurchaseInFlight(started + 4 * 60_000);
      seen.past = storePurchaseInFlight(started + 5 * 60_000 + 1);
      return Promise.resolve();
    }, started);
    expect(seen).toEqual({ atStart: true, nearEnd: true, past: false });
    // A later purchase opens a fresh window rather than inheriting the lapsed one.
    await whileStorePurchaseOpen(
      () => {
        expect(storePurchaseInFlight(started + 6 * 60_000)).toBe(true);
        return Promise.resolve();
      },
      started + 6 * 60_000,
    );
  });
});

/**
 * MOB-R4-LOCK-01. Locking the parent area was the one way out of it that ignored the child pairing:
 * it left pl.mode 'parent' and replaced the whole stack with the PIN screen. On a paired family
 * tablet that stranded the child on a PIN field with no way back to their space (the unlock screen
 * is the only route in the stack, so there is no back arrow), and the next cold start showed the
 * parent/child chooser instead of the child home, because entryRoute only sends mode 'child'
 * straight there. Signing out already handled this (MOB-R2-04); locking now does the same.
 */
describe('locking a paired family tablet returns it to the child space (MOB-R4-LOCK-01)', () => {
  it('[repro] writes mode child and goes to the child home instead of the PIN screen', async () => {
    const storage = memoryStorage();
    await storage.setItem(STORAGE_KEYS.childRefreshToken, 'refresh-token-number-4-abcdefghijkl');
    await enterParentMode(
      storage,
      effects(),
      { unlocked: true, unlockedUntil: SERVER_UNTIL, unlockSeconds: UNLOCK_SECONDS },
      SERVER_NOW,
    );
    expect(await currentMode(storage)).toBe('parent');

    const fx = effects();
    await lockParentAreaOnDevice(storage, fx);

    // The parent area is still locked: the PIN is what opens it again, from the child's Grown-ups.
    expect(parentUnlockActive(SERVER_NOW)).toBe(false);
    expect(fx.calls).toContain('clear');
    expect(fx.calls).toContain('relock');
    // ... but the device is the child's again, not a PIN field with no exit.
    expect(fx.calls).toContain('reset-nav');
    expect(fx.calls).not.toContain('reset-unlock');
    expect(await currentMode(storage)).toBe('child');
    // And the next cold start opens the child space rather than the parent/child chooser.
    expect(entryRoute(await currentMode(storage), true, true, null)).toBe('/(child)/home');
    // The pairing itself is untouched: locking is not unpairing.
    expect(storage.data.get(STORAGE_KEYS.childRefreshToken)).toBe(
      'refresh-token-number-4-abcdefghijkl',
    );
  });

  it('a parent-only device still lands on the unlock screen and stays in parent mode', async () => {
    const storage = memoryStorage();
    await enterParentMode(
      storage,
      effects(),
      { unlocked: true, unlockedUntil: SERVER_UNTIL, unlockSeconds: UNLOCK_SECONDS },
      SERVER_NOW,
    );
    const fx = effects();
    await lockParentAreaOnDevice(storage, fx);
    expect(fx.calls).toContain('reset-unlock');
    expect(fx.calls).not.toContain('reset-nav');
    expect(await currentMode(storage)).toBe('parent');
  });

  it('[repro] the child space gets screen privacy back, as every other way into it does', async () => {
    // enterParentMode switches screen privacy ON (mode.ts). Both other ways back into the child
    // space switch it off — enterChildMode and signOutParent — and MOB-R2-05 counts "screen privacy
    // stayed on" as part of that defect. The lock's child branch did not, and useChildModeOnFocus
    // cannot heal it: the lock has already written mode 'child', so that hook returns early. The
    // child's own space then blocked screenshots, screen recording and casting for the whole
    // session, on a device the child is meant to be holding.
    const storage = memoryStorage();
    await storage.setItem(STORAGE_KEYS.childRefreshToken, 'refresh-token-number-6-abcdefghijkl');
    await enterParentMode(
      storage,
      effects(),
      { unlocked: true, unlockedUntil: SERVER_UNTIL, unlockSeconds: UNLOCK_SECONDS },
      SERVER_NOW,
    );
    const fx = effects();
    await lockParentAreaOnDevice(storage, fx);
    expect(fx.calls).toContain('privacy:false');
  });

  it('a parent-only device keeps screen privacy on behind the PIN', async () => {
    // Nothing changes for the unpaired case: the device stays in parent mode on the unlock screen,
    // so the adult protection the next adult expects is still in place.
    const storage = memoryStorage();
    await enterParentMode(
      storage,
      effects(),
      { unlocked: true, unlockedUntil: SERVER_UNTIL, unlockSeconds: UNLOCK_SECONDS },
      SERVER_NOW,
    );
    const fx = effects();
    await lockParentAreaOnDevice(storage, fx);
    expect(fx.calls).not.toContain('privacy:false');
  });

  it('a keychain that cannot be read falls back to the unlock screen', async () => {
    const storage: SecureStorage = {
      getItem: () => Promise.reject(new Error('keychain unavailable')),
      setItem: () => Promise.resolve(),
      deleteItem: () => Promise.resolve(),
    };
    const fx = effects();
    await lockParentAreaOnDevice(storage, fx);
    expect(fx.calls).toContain('reset-unlock');
    expect(fx.calls).not.toContain('reset-nav');
  });
});

/**
 * MOB-R2-03. `unlockedUntil` is a database instant. A device clock more than the TTL ahead read the
 * window as already over, so every correct PIN led straight back to the unlock screen with no
 * message. The window is now measured on the device's own clock.
 */
describe('the unlock window is held on the device clock (MOB-R2-03)', () => {
  it('[repro] a device clock 6 minutes fast still opens the parent area', async () => {
    const storage = memoryStorage();
    const deviceNow = new Date(SERVER_NOW.getTime() + 6 * 60_000);
    const outcome = await enterParentMode(
      storage,
      effects(),
      { unlocked: true, unlockedUntil: SERVER_UNTIL, unlockSeconds: UNLOCK_SECONDS },
      deviceNow,
    );
    expect(outcome).toBe('parent');
    expect(parentUnlockActive(deviceNow)).toBe(true);
    // And it lasts the window the server granted, measured from here.
    expect(parentUnlockActive(new Date(deviceNow.getTime() + (UNLOCK_SECONDS - 1) * 1000))).toBe(
      true,
    );
    expect(parentUnlockActive(new Date(deviceNow.getTime() + UNLOCK_SECONDS * 1000))).toBe(false);
  });

  it('the window is clamped to the seconds the server granted, never the instant it named', async () => {
    const storage = memoryStorage();
    // A slow device clock must not stretch the window: an hour-old clock would otherwise read
    // `unlockedUntil` as an hour away.
    const deviceNow = new Date(SERVER_NOW.getTime() - 60 * 60_000);
    await enterParentMode(
      storage,
      effects(),
      { unlocked: true, unlockedUntil: SERVER_UNTIL, unlockSeconds: UNLOCK_SECONDS },
      deviceNow,
    );
    expect(parentUnlockActive(new Date(deviceNow.getTime() + UNLOCK_SECONDS * 1000))).toBe(false);
  });

  it('a window already over at unlock is reported, never a silent redirect', async () => {
    const storage = memoryStorage();
    // An older API that states no window length, and an instant already in the past on this device.
    const outcome = await enterParentMode(
      storage,
      effects(),
      { unlocked: true, unlockedUntil: new Date(SERVER_NOW.getTime() - 1000).toISOString() },
      SERVER_NOW,
    );
    expect(outcome).toBe('window_lapsed');
    expect(parentUnlockActive(SERVER_NOW)).toBe(false);
    // The screens stay locked, and the device is not left believing it is in parent mode.
    expect(await currentMode(storage)).toBe('signed_out');
  });

  it('without a stated window an unreadable instant still opens only briefly', async () => {
    const storage = memoryStorage();
    await enterParentMode(
      storage,
      effects(),
      { unlocked: true, unlockedUntil: 'not-a-date' },
      SERVER_NOW,
    );
    expect(parentUnlockActive(SERVER_NOW)).toBe(true);
    expect(parentUnlockActive(new Date(SERVER_NOW.getTime() + 61_000))).toBe(false);
  });
});

/**
 * MOB-R2-04. Signing the parent out from the unlock screen (reachable from the child's "Grown-ups"
 * button with no PIN) also took a paired device out of child mode, so every later launch showed the
 * parent/child chooser instead of the child's space.
 */
describe('signing out on a paired child device keeps the child space (MOB-R2-04)', () => {
  it('[repro] a device in child mode stays in child mode and returns to the child home', async () => {
    const storage = memoryStorage();
    await storage.setItem(STORAGE_KEYS.mode, 'child');
    await storage.setItem(STORAGE_KEYS.childRefreshToken, 'refresh-token-number-1-abcdefghijkl');
    const fx = effects();
    await signOutParent(storage, fx, { signOut: () => Promise.resolve() });
    expect(await currentMode(storage)).toBe('child');
    expect(fx.calls).toContain('reset-nav');
    expect(fx.calls).not.toContain('reset-welcome');
    // The pairing itself is untouched.
    expect(storage.data.get(STORAGE_KEYS.childRefreshToken)).toBe(
      'refresh-token-number-1-abcdefghijkl',
    );
  });

  it('a paired device the parent had unlocked also returns to the child space', async () => {
    const storage = memoryStorage();
    await storage.setItem(STORAGE_KEYS.mode, 'parent');
    await storage.setItem(STORAGE_KEYS.childRefreshToken, 'refresh-token-number-2-abcdefghijkl');
    const fx = effects();
    await signOutParent(storage, fx, { signOut: () => Promise.resolve() });
    expect(await currentMode(storage)).toBe('child');
    expect(fx.calls).toContain('reset-nav');
  });

  it('a parent-only device still signs out to the welcome screen', async () => {
    const storage = memoryStorage();
    await storage.setItem(STORAGE_KEYS.mode, 'parent');
    const fx = effects();
    await signOutParent(storage, fx, { signOut: () => Promise.resolve() });
    expect(await currentMode(storage)).toBe('signed_out');
    expect(fx.calls).toContain('reset-welcome');
    expect(fx.calls).not.toContain('reset-nav');
  });

  it('signing out always forgets the unlock and clears the adult caches', async () => {
    const storage = memoryStorage();
    await storage.setItem(STORAGE_KEYS.childRefreshToken, 'refresh-token-number-3-abcdefghijkl');
    await enterParentMode(
      storage,
      effects(),
      { unlocked: true, unlockedUntil: SERVER_UNTIL, unlockSeconds: UNLOCK_SECONDS },
      SERVER_NOW,
    );
    const fx = effects();
    await signOutParent(storage, fx, { signOut: () => Promise.resolve() });
    expect(parentUnlockActive(SERVER_NOW)).toBe(false);
    expect(fx.calls).toContain('clear');
    expect(fx.calls).toContain('privacy:false');
  });
});

/**
 * MOB-R4-LOCK-05, re-fix round. An account closure is not a sign-out: the adult who set this device
 * up is gone. The first attempt put the forget behind a `familyDeleted` flag that no caller passed,
 * so on the finding's own repro — the family owner deletes the whole family, then closes their
 * sign-in on the paired tablet — the device still came out in child mode with the deleted child's
 * refresh token and nickname in the keychain. The device cannot tell an owner's closure from a
 * guardian's, so the closure forgets the child either way and nothing is revoked on the wire.
 */
describe('closing an account leaves no child pairing on the device (MOB-R4-LOCK-05)', () => {
  it('[repro] the paired tablet ends signed out, with no child token and no cached nickname', async () => {
    const storage = memoryStorage();
    await storage.setItem(STORAGE_KEYS.mode, 'parent');
    await storage.setItem(STORAGE_KEYS.childRefreshToken, 'refresh-token-number-5-abcdefghijkl');
    await storage.setItem(STORAGE_KEYS.childProfile, '{"id":"child-1","nickname":"Robin"}');
    const fx = effects();
    await signOutClosedAccount(storage, fx, { signOut: () => Promise.resolve() });
    expect(await currentMode(storage)).toBe('signed_out');
    expect(storage.data.has(STORAGE_KEYS.childRefreshToken)).toBe(false);
    expect(storage.data.has(STORAGE_KEYS.childProfile)).toBe(false);
    // Nothing sends the relaunch into the child space of a family that no longer exists: the
    // welcome screen asks again (null) instead of opening the deleted child's home.
    expect(entryRoute(await currentMode(storage), false, true, null)).toBeNull();
  });

  it('a parent-only device closes exactly as the plain sign-out did', async () => {
    const storage = memoryStorage();
    await storage.setItem(STORAGE_KEYS.mode, 'parent');
    const fx = effects();
    await signOutClosedAccount(storage, fx, { signOut: () => Promise.resolve() });
    expect(await currentMode(storage)).toBe('signed_out');
    expect(fx.calls).toContain('clear');
    expect(fx.calls).toContain('relock');
  });

  it('the closure still forgets the client-side unlock', async () => {
    const storage = memoryStorage();
    await storage.setItem(STORAGE_KEYS.childRefreshToken, 'refresh-token-number-6-abcdefghijkl');
    await enterParentMode(
      storage,
      effects(),
      { unlocked: true, unlockedUntil: SERVER_UNTIL, unlockSeconds: UNLOCK_SECONDS },
      SERVER_NOW,
    );
    expect(parentUnlockActive(SERVER_NOW)).toBe(true);
    await signOutClosedAccount(storage, effects(), { signOut: () => Promise.resolve() });
    expect(parentUnlockActive(SERVER_NOW)).toBe(false);
  });
});

/**
 * HUNT5-H-1. A parent screen that is already 'ready' is handed its own state back on a re-check, so
 * an ordinary back-navigation does not flash "Loading your family" over data the parent is reading.
 * That was unconditional, and the ApiClient's token source follows whoever is signed in NOW: on a
 * handed-on tablet — parent A's Children screen still mounted underneath, A's session ended, parent
 * B signs in and unlocks with their own PIN, B taps the header back arrow — the re-check handed B
 * the state holding A's children (nicknames, grades, age bands) with no reload and no PIN in
 * between. The state is kept only while it still belongs to the adult at the device; the session
 * watcher (src/lib/app-session.ts) records who that is.
 */
describe('a parent screen’s state belongs to the adult it was published for (HUNT5-H-1)', () => {
  it('[repro] a state published for one adult is not current for the next one', () => {
    noteParentIdentity('user-a');
    const publishedForA = parentIdentityGeneration();
    expect(parentStateStillCurrent(publishedForA)).toBe(true);
    // The same adult's session firing the watcher again (a token refresh) is not a new adult, so
    // the screens keep their state: the no-flash behaviour survives.
    noteParentIdentity('user-a');
    expect(parentStateStillCurrent(publishedForA)).toBe(true);
    // A's session ends elsewhere ("sign out everywhere", a password change), then B signs in.
    noteParentIdentity(null);
    expect(parentStateStillCurrent(publishedForA)).toBe(false);
    noteParentIdentity('user-b');
    expect(parentStateStillCurrent(publishedForA)).toBe(false);
    // B's own screens start from B's identity, and a screen that has published nothing yet has
    // nothing to keep.
    expect(parentStateStillCurrent(parentIdentityGeneration())).toBe(true);
    expect(parentStateStillCurrent(null)).toBe(false);
  });

  it('[repro] an unreadable id always moves the identity: nobody is not the same person twice', () => {
    // `parentAuth.userId()` reads the Supabase session, and it resolves to nothing on a device that
    // is offline past its token expiry — so the session watcher records null for an adult who IS
    // signed in (src/lib/app-session.ts). The early return compared the new id with the stored one,
    // so null after null moved nothing: adult A's screen, published while this device could not read
    // A's id, stayed "current" when A's session ended and B signed in with an id that could not be
    // read either. That is exactly the handed-on tablet HUNT5-H-1 is about, and it is the state the
    // watcher's own comment promised "never keeps its rows".
    noteParentIdentity(null);
    const publishedWhileNobodyKnown = parentIdentityGeneration();
    expect(parentStateStillCurrent(publishedWhileNobodyKnown)).toBe(true);
    // A second unreadable id is a second unknown adult, not the same one: the screen loses its state.
    noteParentIdentity(null);
    expect(parentStateStillCurrent(publishedWhileNobodyKnown)).toBe(false);
    // And a known adult after an unknown one still moves it, as it always did.
    const publishedForNobody = parentIdentityGeneration();
    noteParentIdentity('user-c');
    expect(parentStateStillCurrent(publishedForNobody)).toBe(false);
  });
});
