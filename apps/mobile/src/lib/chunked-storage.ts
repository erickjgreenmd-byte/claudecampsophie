import type { SecureStorage } from './mode.ts';

/**
 * Supabase session storage on top of the device keychain. SecureStore warns above ~2 KB per item
 * and a Supabase session is often larger, so values are split into chunks with a count record.
 * Pure (no react-native imports) so it is unit-tested; the app passes the real keychain.
 *
 * Writes store the chunks first and the count last, and remove stale extra chunks, so a crash
 * mid-write leaves either the old complete value or a readable new one — never a mixed session.
 */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const DEFAULT_CHUNK_SIZE = 1800;
const MAX_CHUNKS = 32;

function safeKey(key: string): string {
  // SecureStore keys allow only alphanumerics, ".", "-" and "_".
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function createChunkedStorage(
  store: SecureStorage,
  chunkSize = DEFAULT_CHUNK_SIZE,
): KeyValueStorage {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new RangeError('chunkSize must be >= 1');
  const countKey = (key: string) => `${safeKey(key)}.n`;
  const chunkKey = (key: string, i: number) => `${safeKey(key)}.${i}`;

  async function count(key: string): Promise<number> {
    const raw = await store.getItem(countKey(key));
    const n = raw === null ? 0 : Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= MAX_CHUNKS ? n : 0;
  }

  return {
    async getItem(key) {
      const n = await count(key);
      if (n === 0) return null;
      const parts: string[] = [];
      for (let i = 0; i < n; i += 1) {
        const part = await store.getItem(chunkKey(key, i));
        if (part === null) return null; // incomplete value: treat as signed out
        parts.push(part);
      }
      return parts.join('');
    },
    async setItem(key, value) {
      const chunks: string[] = [];
      for (let i = 0; i < value.length; i += chunkSize) chunks.push(value.slice(i, i + chunkSize));
      if (chunks.length === 0) chunks.push('');
      if (chunks.length > MAX_CHUNKS) throw new RangeError('value too large for secure storage');
      const previous = await count(key);
      for (let i = 0; i < chunks.length; i += 1) await store.setItem(chunkKey(key, i), chunks[i]!);
      await store.setItem(countKey(key), String(chunks.length));
      for (let i = chunks.length; i < previous; i += 1) await store.deleteItem(chunkKey(key, i));
    },
    async removeItem(key) {
      const n = await count(key);
      await store.deleteItem(countKey(key));
      for (let i = 0; i < n; i += 1) await store.deleteItem(chunkKey(key, i));
    },
  };
}
