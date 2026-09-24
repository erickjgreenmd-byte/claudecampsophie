import { describe, expect, it, vi } from 'vitest';
import {
  currentMode,
  enterChildMode,
  enterParentMode,
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
    expect(await enterParentMode(storage, effects(), { unlocked: false })).toBe('step_up_required');
    expect(await currentMode(storage)).toBe('child');
    expect(await enterParentMode(storage, effects(), { unlocked: true })).toBe('parent');
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
