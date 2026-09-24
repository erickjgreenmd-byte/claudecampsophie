import { describe, expect, it } from 'vitest';
import { createChunkedStorage } from './chunked-storage.ts';
import type { SecureStorage } from './mode.ts';

function memory(): SecureStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => Promise.resolve(data.get(k) ?? null),
    setItem: (k, v) => {
      if (!/^[A-Za-z0-9._-]+$/.test(k)) return Promise.reject(new Error(`invalid key ${k}`));
      data.set(k, v);
      return Promise.resolve();
    },
    deleteItem: (k) => {
      data.delete(k);
      return Promise.resolve();
    },
  };
}

describe('chunked keychain storage for the parent session', () => {
  it('round-trips values larger than one keychain item', async () => {
    const store = memory();
    const storage = createChunkedStorage(store, 10);
    const session = JSON.stringify({ access_token: 'a'.repeat(95), refresh_token: 'r' });
    await storage.setItem('sb-proj-auth-token', session);
    expect(await storage.getItem('sb-proj-auth-token')).toBe(session);
    expect([...store.data.values()].every((v) => v.length <= 10)).toBe(true);
  });

  it('shrinking a value removes stale chunks; removal clears everything', async () => {
    const store = memory();
    const storage = createChunkedStorage(store, 4);
    await storage.setItem('k', 'abcdefghijkl');
    await storage.setItem('k', 'xy');
    expect(await storage.getItem('k')).toBe('xy');
    expect(store.data.size).toBe(2); // one chunk + count
    await storage.removeItem('k');
    expect(store.data.size).toBe(0);
    expect(await storage.getItem('k')).toBeNull();
  });

  it('a missing chunk reads as signed out, never as a truncated session', async () => {
    const store = memory();
    const storage = createChunkedStorage(store, 3);
    await storage.setItem('k', 'abcdefg');
    store.data.delete('k.1');
    expect(await storage.getItem('k')).toBeNull();
  });

  it('keys with characters the keychain rejects are made safe', async () => {
    const storage = createChunkedStorage(memory());
    await storage.setItem('sb:proj/auth token', 'v');
    expect(await storage.getItem('sb:proj/auth token')).toBe('v');
  });
});
