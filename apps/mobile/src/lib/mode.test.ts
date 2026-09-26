import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentMode,
  enterChildMode,
  enterParentMode,
  forgetParentUnlock,
  parentUnlockActive,
  signOutParent,
  STORAGE_KEYS,
  unpairChildDevice,
  type ModeEffects,
  type SecureStorage,
} from './mode.ts';

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

describe('mode switching (AC_ACCESS_07)', () => {
  it('clears adult caches before anything else and relocks on the server', async () => {
    const storage = memoryStorage();
    const fx = effects();
    await enterChildMode(storage, fx);
    expect(fx.calls[0]).toBe('clear');
    expect(fx.calls).toContain('relock');
    expect(fx.calls).toContain('reset-nav');
    expect(await currentMode(storage)).toBe('child');
  });

  it('still switches (and clears) when the server relock fails offline', async () => {
    const storage = memoryStorage();
    const fx = effects({ relockOnServer: vi.fn(() => Promise.reject(new Error('offline'))) });
    await enterChildMode(storage, fx);
    expect(fx.calls[0]).toBe('clear');
    expect(await currentMode(storage)).toBe('child');
  });

  it('returning to parent mode requires fresh proof', async () => {
    const storage = memoryStorage();
    await enterChildMode(storage, effects());
    expect(
      await enterParentMode(storage, effects(), { unlocked: false, unlockedUntil: UNTIL }, NOW),
    ).toBe('step_up_required');
    expect(await currentMode(storage)).toBe('child');
    // The pinned clock is passed in (L-027): UNTIL is five minutes after NOW, so leaving `now` to
    // the real wall clock would read the window as long lapsed (MOB-R2-03 reports that, correctly).
    expect(
      await enterParentMode(storage, effects(), { unlocked: true, unlockedUntil: UNTIL }, NOW),
    ).toBe('parent');
  });

  it('unpairing removes the child refresh token and profile', async () => {
    const storage = memoryStorage();
    await storage.setItem(STORAGE_KEYS.childRefreshToken, 'secret-refresh');
    await storage.setItem(STORAGE_KEYS.childProfile, '{"nickname":"Riley"}');
    await unpairChildDevice(storage);
    expect(storage.data.has(STORAGE_KEYS.childRefreshToken)).toBe(false);
    expect(storage.data.has(STORAGE_KEYS.childProfile)).toBe(false);
    expect(await currentMode(storage)).toBe('signed_out');
  });
});

const NOW = new Date('2026-09-24T15:00:00Z');
const UNTIL = new Date(NOW.getTime() + 5 * 60_000).toISOString();

describe('the client-side unlock lives in memory only (MOB-R1-09)', () => {
  afterEach(() => forgetParentUnlock());

  it('a cold start (fresh module) has no unlock, even with mode=parent in the keychain', async () => {
    const storage = memoryStorage();
    await storage.setItem(STORAGE_KEYS.mode, 'parent');
    expect(await currentMode(storage)).toBe('parent');
    expect(parentUnlockActive(NOW)).toBe(false);
  });

  it('entering parent mode records the server’s unlock window; it lapses with the TTL', async () => {
    const storage = memoryStorage();
    await enterParentMode(storage, effects(), { unlocked: true, unlockedUntil: UNTIL }, NOW);
    expect(parentUnlockActive(NOW)).toBe(true);
    expect(parentUnlockActive(new Date(NOW.getTime() + 4 * 60_000))).toBe(true);
    // Backgrounded (or idle) beyond the TTL: the read screens need the PIN again.
    expect(parentUnlockActive(new Date(NOW.getTime() + 5 * 60_000))).toBe(false);
  });

  it('a refused step-up records nothing', async () => {
    const storage = memoryStorage();
    await enterParentMode(storage, effects(), { unlocked: false, unlockedUntil: UNTIL }, NOW);
    expect(parentUnlockActive(NOW)).toBe(false);
  });

  it('switching to child mode or unpairing forgets the unlock', async () => {
    const storage = memoryStorage();
    await enterParentMode(storage, effects(), { unlocked: true, unlockedUntil: UNTIL }, NOW);
    await enterChildMode(storage, effects());
    expect(parentUnlockActive(NOW)).toBe(false);
    await enterParentMode(storage, effects(), { unlocked: true, unlockedUntil: UNTIL }, NOW);
    await unpairChildDevice(storage);
    expect(parentUnlockActive(NOW)).toBe(false);
  });
});

describe('parent sign-out (MOB-R1-01)', () => {
  afterEach(() => forgetParentUnlock());

  it('relocks on the server while the token still exists, then ends the session and clears everything', async () => {
    const storage = memoryStorage();
    await enterParentMode(storage, effects(), { unlocked: true, unlockedUntil: UNTIL }, NOW);
    const fx = effects();
    const auth = {
      signOut: () => {
        fx.calls.push('auth-sign-out');
        return Promise.resolve();
      },
    };
    await signOutParent(storage, fx, auth);
    expect(fx.calls.indexOf('relock')).toBeLessThan(fx.calls.indexOf('auth-sign-out'));
    expect(fx.calls).toContain('clear');
    expect(fx.calls).toContain('reset-welcome');
    expect(fx.calls).toContain('privacy:false');
    expect(await currentMode(storage)).toBe('signed_out');
    expect(parentUnlockActive(NOW)).toBe(false);
  });

  it('still signs out and clears when the device is offline (relock and remote sign-out fail)', async () => {
    const storage = memoryStorage();
    await storage.setItem(STORAGE_KEYS.mode, 'parent');
    const fx = effects({ relockOnServer: vi.fn(() => Promise.reject(new Error('offline'))) });
    const auth = { signOut: vi.fn(() => Promise.reject(new Error('offline'))) };
    await signOutParent(storage, fx, auth);
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(fx.calls).toContain('clear');
    expect(fx.calls).toContain('reset-welcome');
    expect(await currentMode(storage)).toBe('signed_out');
  });

  it('a paired child device stays paired: sign-out only ends the parent session', async () => {
    const storage = memoryStorage();
    await storage.setItem(STORAGE_KEYS.childRefreshToken, 'secret-refresh');
    await storage.setItem(STORAGE_KEYS.mode, 'parent');
    await signOutParent(storage, effects(), { signOut: () => Promise.resolve() });
    expect(storage.data.get(STORAGE_KEYS.childRefreshToken)).toBe('secret-refresh');
  });
});
