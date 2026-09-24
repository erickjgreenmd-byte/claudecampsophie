import { describe, expect, it } from 'vitest';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import {
  clearAdultCaches,
  parentTokenSource,
  registerAdultCacheClearer,
  registerParentTokenSource,
} from './parent-session.ts';
import {
  lockParentArea,
  pinEntryError,
  pinResetGuidance,
  unlockWithBiometrics,
  unlockWithPin,
  type BiometricPinStore,
} from './unlock.ts';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeApi(respond: (call: Call) => unknown): ApiClient & { calls: Call[] } {
  const calls: Call[] = [];
  const handle = (call: Call, schema: { parse: (v: unknown) => unknown }): Promise<never> => {
    calls.push(call);
    const value = respond(call);
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(schema.parse(value) as never);
  };
  return {
    calls,
    get: (path, schema) => handle({ method: 'GET', path, body: undefined }, schema),
    send: (method, path, body, schema) => handle({ method, path, body }, schema),
  };
}

function memoryBiometricStore(pin: string | null): BiometricPinStore & { cleared: boolean } {
  let stored = pin;
  const store = {
    cleared: false,
    isEnabled: () => Promise.resolve(stored !== null),
    save: (value: string) => {
      stored = value;
      return Promise.resolve();
    },
    read: () => Promise.resolve(stored),
    clear: () => {
      stored = null;
      store.cleared = true;
      return Promise.resolve();
    },
  };
  return store;
}

const UNTIL = '2026-09-24T15:05:00.000Z';

describe('parent unlock', () => {
  it('validates PIN entry before calling the server', async () => {
    expect(pinEntryError('12345')).toBe('Enter your 6-digit parent PIN.');
    expect(pinEntryError('482913')).toBeNull();
    const api = fakeApi(() => ({ unlockedUntil: UNTIL }));
    expect(await unlockWithPin(api, '12a456')).toMatchObject({ kind: 'error' });
    expect(api.calls).toHaveLength(0);
  });

  it('unlocks with a server-verified PIN', async () => {
    const api = fakeApi(() => ({ unlockedUntil: UNTIL }));
    expect(await unlockWithPin(api, '482913')).toEqual({ kind: 'unlocked', unlockedUntil: UNTIL });
    expect(api.calls).toEqual([
      { method: 'POST', path: '/v1/adult/unlock', body: { method: 'pin', pin: '482913' } },
    ]);
  });

  it('reports wrong PIN and lockout clearly', async () => {
    const wrong = fakeApi(() => new ApiRequestError('FORBIDDEN', 'Incorrect PIN', 403));
    expect(await unlockWithPin(wrong, '482913')).toEqual({
      kind: 'error',
      message: 'That PIN is not correct.',
      wrongPin: true,
    });
    const locked = fakeApi(
      () => new ApiRequestError('LOCKED_OUT', 'Too many incorrect PINs. Try again later.', 423),
    );
    expect(await unlockWithPin(locked, '482913')).toMatchObject({
      message: 'Too many incorrect PINs. Try again later.',
      wrongPin: false,
    });
  });

  it('biometric unlock still sends the PIN to the server for verification', async () => {
    const api = fakeApi(() => ({ unlockedUntil: UNTIL }));
    const store = memoryBiometricStore('482913');
    expect(await unlockWithBiometrics(api, store)).toEqual({
      kind: 'unlocked',
      unlockedUntil: UNTIL,
    });
    expect(api.calls[0]?.body).toEqual({ method: 'pin', pin: '482913' });
  });

  it('a cancelled biometric prompt sends nothing', async () => {
    const api = fakeApi(() => ({ unlockedUntil: UNTIL }));
    expect(await unlockWithBiometrics(api, memoryBiometricStore(null))).toEqual({
      kind: 'cancelled',
    });
    const throwing: BiometricPinStore = {
      ...memoryBiometricStore('482913'),
      read: () => Promise.reject(new Error('user cancel')),
    };
    expect(await unlockWithBiometrics(api, throwing)).toEqual({ kind: 'cancelled' });
    expect(api.calls).toHaveLength(0);
  });

  it('turns biometrics off when the stored PIN no longer matches', async () => {
    const api = fakeApi(() => new ApiRequestError('FORBIDDEN', 'Incorrect PIN', 403));
    const store = memoryBiometricStore('482913');
    const outcome = await unlockWithBiometrics(api, store);
    expect(outcome.kind).toBe('pin_changed');
    expect(store.cleared).toBe(true);
    expect(await store.isEnabled()).toBe(false);
  });

  it('points a parent who forgot the PIN to the working portal reset (RV-family-4)', () => {
    expect(pinResetGuidance('https://portal.example.test/')).toEqual({
      text: 'Forgot your PIN? Reset it in the parent portal after confirming your account password.',
      url: 'https://portal.example.test/app/security/reset-pin',
    });
    for (const origin of [null, '', 'http://portal.example.test', 'javascript:alert(1)']) {
      const guidance = pinResetGuidance(origin);
      expect(guidance.url, String(origin)).toBeNull();
      expect(guidance.text).toMatch(/Reset your parent PIN/);
      expect(guidance.text).not.toMatch(/isn’t available|needs account recovery/);
    }
  });

  it('relocks on the server and reports failure without throwing', async () => {
    const ok = fakeApi(() => ({ ok: true }));
    expect(await lockParentArea(ok)).toBe(true);
    expect(ok.calls).toEqual([{ method: 'POST', path: '/v1/adult/lock', body: undefined }]);
    const offline = fakeApi(() => new ApiRequestError('NETWORK', 'offline', 0));
    expect(await lockParentArea(offline)).toBe(false);
  });
});

describe('parent session registry', () => {
  it('has no parent token until the auth layer registers one', async () => {
    registerParentTokenSource(null);
    expect(parentTokenSource()).toBeNull();
    registerParentTokenSource(() => Promise.resolve('parent-token'));
    expect(await parentTokenSource()?.()).toBe('parent-token');
    registerParentTokenSource(null);
  });

  it('clears every adult cache even if one clearer fails', () => {
    const cleared: string[] = [];
    const a = registerAdultCacheClearer(() => cleared.push('a'));
    const b = registerAdultCacheClearer(() => {
      throw new Error('boom');
    });
    const c = registerAdultCacheClearer(() => cleared.push('c'));
    clearAdultCaches();
    expect(cleared).toEqual(['a', 'c']);
    a();
    b();
    c();
    clearAdultCaches();
    expect(cleared).toEqual(['a', 'c']);
  });
});
