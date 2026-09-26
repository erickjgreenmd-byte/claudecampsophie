import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentMode,
  enterParentMode,
  forgetParentUnlock,
  lockParentAreaOnDevice,
  parentUnlockActive,
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
    await lockParentAreaOnDevice(fx);
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
    await lockParentAreaOnDevice(fx);
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
