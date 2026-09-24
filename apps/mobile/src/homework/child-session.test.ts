import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '@pencillift/contracts/client';
import { STORAGE_KEYS, type SecureStorage } from '../lib/mode.ts';
import { createChildTokenSource, type ChildTokens } from './child-session.ts';

function memoryStorage(initial: Record<string, string> = {}): SecureStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
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

const T0 = new Date('2026-09-24T15:00:00Z');

describe('child access tokens for homework requests', () => {
  it('refreshes once, rotates the stored refresh token and reuses the access token until expiry', async () => {
    const storage = memoryStorage({ [STORAGE_KEYS.childRefreshToken]: 'refresh-1' });
    const now = { value: T0 };
    const calls: string[] = [];
    const source = createChildTokenSource({
      storage,
      now: () => now.value,
      refresh: (token) => {
        calls.push(token);
        const n = calls.length;
        return Promise.resolve<ChildTokens>({
          accessToken: `access-${n}`,
          accessTokenExpiresAt: new Date(now.value.getTime() + 900_000).toISOString(),
          refreshToken: `refresh-${n + 1}`,
        });
      },
    });
    // Concurrent callers share one refresh: two refreshes with one rotated token would look like
    // token theft to the server and revoke the session.
    const [a, b] = await Promise.all([source.token(), source.token()]);
    expect([a, b]).toEqual(['access-1', 'access-1']);
    expect(calls).toEqual(['refresh-1']);
    expect(storage.data.get(STORAGE_KEYS.childRefreshToken)).toBe('refresh-2');
    now.value = new Date(T0.getTime() + 10 * 60_000);
    expect(await source.token()).toBe('access-1');
    now.value = new Date(T0.getTime() + 15 * 60_000);
    expect(await source.token()).toBe('access-2');
    expect(calls).toEqual(['refresh-1', 'refresh-2']);
  });

  it('returns no token when the device is not paired or the session was revoked', async () => {
    const unpaired = createChildTokenSource({
      storage: memoryStorage(),
      now: () => T0,
      refresh: () => Promise.reject(new Error('should not be called')),
    });
    expect(await unpaired.token()).toBeNull();
    const revoked = createChildTokenSource({
      storage: memoryStorage({ [STORAGE_KEYS.childRefreshToken]: 'old' }),
      now: () => T0,
      refresh: () => Promise.reject(new ApiRequestError('UNAUTHENTICATED', 'x', 401)),
    });
    expect(await revoked.token()).toBeNull();
  });

  it('surfaces offline errors so the screen can say so, and clears on demand', async () => {
    let online = false;
    const source = createChildTokenSource({
      storage: memoryStorage({ [STORAGE_KEYS.childRefreshToken]: 'r' }),
      now: () => T0,
      refresh: () =>
        online
          ? Promise.resolve({
              accessToken: 'a',
              accessTokenExpiresAt: new Date(T0.getTime() + 900_000).toISOString(),
              refreshToken: 'r2',
            })
          : Promise.reject(new ApiRequestError('NETWORK', 'offline', 0)),
    });
    await expect(source.token()).rejects.toMatchObject({ code: 'NETWORK' });
    online = true;
    expect(await source.token()).toBe('a');
    source.clear();
    online = false;
    await expect(source.token()).rejects.toMatchObject({ code: 'NETWORK' });
  });
});
