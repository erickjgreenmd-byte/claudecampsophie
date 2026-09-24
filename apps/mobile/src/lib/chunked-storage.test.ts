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
    // Every chunk fits the chunk size; the pointer record is a short fixed-shape string.
    const chunks = [...store.data.entries()].filter(([k]) => k !== 'sb-proj-auth-token.n');
    expect(chunks.length).toBe(Math.ceil(session.length / 10));
    expect(chunks.every(([, v]) => v.length <= 10)).toBe(true);
    expect(store.data.get('sb-proj-auth-token.n')!.length).toBeLessThanOrEqual(40);
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
    const second = [...store.data.keys()].filter((k) => /^k\.[ab]\.1$/.test(k));
    expect(second).toHaveLength(1);
    store.data.delete(second[0]!);
    expect(await storage.getItem('k')).toBeNull();
  });

  it('a chunk that does not match the committed value reads as signed out', async () => {
    const store = memory();
    const storage = createChunkedStorage(store, 3);
    await storage.setItem('k', 'abcdefg');
    const chunk = [...store.data.keys()].find((k) => /^k\.[ab]\.1$/.test(k))!;
    store.data.set(chunk, 'XYZ'); // same length, different content
    expect(await storage.getItem('k')).toBeNull();
  });

  it('[RV-lead-identity-access-10] a crash at any write of an overwrite leaves the old or the new value', async () => {
    const oldValue = 'old-session-'.repeat(9);
    const newValue = 'NEW-SESSION-'.repeat(11);
    // Enough writes to cover every chunk, the pointer and the cleanup, for both slot directions.
    for (const priorWrites of [0, 1]) {
      for (let okWrites = 0; okWrites <= 20; okWrites += 1) {
        const store = memory();
        const storage = createChunkedStorage(store, 10);
        for (let i = 0; i <= priorWrites; i += 1) await storage.setItem('k', oldValue);
        let remaining = okWrites;
        const setItem = store.setItem.bind(store);
        const deleteItem = store.deleteItem.bind(store);
        store.setItem = (k, v) => {
          if (remaining <= 0) return Promise.reject(new Error('process killed'));
          remaining -= 1;
          return setItem(k, v);
        };
        store.deleteItem = (k) =>
          remaining <= 0 ? Promise.reject(new Error('process killed')) : deleteItem(k);
        await storage.setItem('k', newValue).catch(() => undefined);
        const read = await storage.getItem('k');
        expect({ priorWrites, okWrites, ok: read === oldValue || read === newValue }).toEqual({
          priorWrites,
          okWrites,
          ok: true,
        });
        // The storage keeps working after the crash.
        store.setItem = setItem;
        store.deleteItem = deleteItem;
        await storage.setItem('k', 'after');
        expect(await storage.getItem('k')).toBe('after');
        expect(store.data.size).toBe(2); // one chunk + pointer: no leftovers from the crash
      }
    }
  });

  it('reads a session saved by the previous (count + in-place chunks) format and migrates it', async () => {
    const store = memory();
    store.data.set('k.n', '3');
    store.data.set('k.0', 'abc');
    store.data.set('k.1', 'def');
    store.data.set('k.2', 'g');
    const storage = createChunkedStorage(store, 3);
    expect(await storage.getItem('k')).toBe('abcdefg');
    await storage.setItem('k', 'xyz');
    expect(await storage.getItem('k')).toBe('xyz');
    expect([...store.data.keys()].sort()).toEqual(['k.a.0', 'k.n']);
    await storage.removeItem('k');
    expect(store.data.size).toBe(0);
  });

  it('keys with characters the keychain rejects are made safe', async () => {
    const storage = createChunkedStorage(memory());
    await storage.setItem('sb:proj/auth token', 'v');
    expect(await storage.getItem('sb:proj/auth token')).toBe('v');
  });
});
