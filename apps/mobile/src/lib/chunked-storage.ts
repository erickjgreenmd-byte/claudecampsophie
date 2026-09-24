import type { SecureStorage } from './mode.ts';

/**
 * Supabase session storage on top of the device keychain. SecureStore warns above ~2 KB per item
 * and a Supabase session is often larger, so values are split into chunks.
 * Pure (no react-native imports) so it is unit-tested; the app passes the real keychain.
 *
 * Crash safety (RV-lead-identity-access-10): chunks are never overwritten in place. Two chunk slots
 * ("a" and "b") alternate; a write fills the slot the pointer does NOT reference, then writes the
 * pointer record (slot, chunk count, length, checksum) as the single commit step, then deletes the
 * old slot. If the app dies at any point, the pointer references one complete value, so a read
 * returns the old session, the new session, or nothing — never a mix of two sessions (a mixed
 * session would present an already-rotated refresh token and trip Supabase's reuse detection).
 */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const DEFAULT_CHUNK_SIZE = 1800;
const MAX_CHUNKS = 32;
const POINTER_VERSION = '2';

type Slot = 'a' | 'b';

type Pointer =
  | { readonly kind: 'none' }
  /** Written by earlier app versions: a bare count, chunks under `<key>.<i>`. */
  | { readonly kind: 'legacy'; readonly count: number }
  | {
      readonly kind: 'slot';
      readonly slot: Slot;
      readonly count: number;
      readonly length: number;
      readonly checksum: string;
    };

function safeKey(key: string): string {
  // SecureStore keys allow only alphanumerics, ".", "-" and "_".
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** FNV-1a (32-bit) over UTF-16 code units: detects a pointer/chunk mismatch, not an attacker. */
function checksum(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function validCount(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_CHUNKS;
}

function parsePointer(raw: string | null): Pointer {
  if (raw === null) return { kind: 'none' };
  if (/^\d+$/.test(raw)) {
    const count = Number(raw);
    return validCount(count) ? { kind: 'legacy', count } : { kind: 'none' };
  }
  const parts = raw.split('|');
  if (parts.length !== 5 || parts[0] !== POINTER_VERSION) return { kind: 'none' };
  const [, slot, countText, lengthText, sum] = parts as [string, string, string, string, string];
  const count = Number(countText);
  const length = Number(lengthText);
  if ((slot !== 'a' && slot !== 'b') || !validCount(count)) return { kind: 'none' };
  if (!Number.isInteger(length) || length < 0 || !/^[0-9a-f]{8}$/.test(sum)) {
    return { kind: 'none' };
  }
  return { kind: 'slot', slot, count, length, checksum: sum };
}

export function createChunkedStorage(
  store: SecureStorage,
  chunkSize = DEFAULT_CHUNK_SIZE,
): KeyValueStorage {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new RangeError('chunkSize must be >= 1');
  const pointerKey = (key: string) => `${safeKey(key)}.n`;
  const legacyChunkKey = (key: string, i: number) => `${safeKey(key)}.${i}`;
  const slotChunkKey = (key: string, slot: Slot, i: number) => `${safeKey(key)}.${slot}.${i}`;

  async function pointer(key: string): Promise<Pointer> {
    return parsePointer(await store.getItem(pointerKey(key)));
  }

  async function readChunks(keys: readonly string[]): Promise<string | null> {
    const parts: string[] = [];
    for (const k of keys) {
      const part = await store.getItem(k);
      if (part === null) return null; // incomplete value: treat as signed out
      parts.push(part);
    }
    return parts.join('');
  }

  /** Deletes chunks of a slot from index `from` upward until one is missing (bounded). */
  async function clearSlotFrom(key: string, slot: Slot, from: number): Promise<void> {
    for (let i = from; i < MAX_CHUNKS; i += 1) {
      const k = slotChunkKey(key, slot, i);
      if ((await store.getItem(k)) === null) return;
      await store.deleteItem(k);
    }
  }

  async function clearLegacy(key: string, count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) await store.deleteItem(legacyChunkKey(key, i));
  }

  return {
    async getItem(key) {
      const current = await pointer(key);
      if (current.kind === 'none') return null;
      if (current.kind === 'legacy') {
        return readChunks(Array.from({ length: current.count }, (_, i) => legacyChunkKey(key, i)));
      }
      const value = await readChunks(
        Array.from({ length: current.count }, (_, i) => slotChunkKey(key, current.slot, i)),
      );
      if (value === null) return null;
      // Belt and braces: a value that is not exactly what the pointer committed reads as signed out.
      return value.length === current.length && checksum(value) === current.checksum ? value : null;
    },

    async setItem(key, value) {
      const chunks: string[] = [];
      for (let i = 0; i < value.length; i += chunkSize) chunks.push(value.slice(i, i + chunkSize));
      if (chunks.length === 0) chunks.push('');
      if (chunks.length > MAX_CHUNKS) throw new RangeError('value too large for secure storage');
      const previous = await pointer(key);
      // Never write into the slot the pointer references: that value must stay whole until the
      // new pointer is written.
      const slot: Slot = previous.kind === 'slot' && previous.slot === 'a' ? 'b' : 'a';
      for (let i = 0; i < chunks.length; i += 1) {
        await store.setItem(slotChunkKey(key, slot, i), chunks[i]!);
      }
      // Commit: one keychain item switches readers from the old value to the new one.
      await store.setItem(
        pointerKey(key),
        [POINTER_VERSION, slot, chunks.length, value.length, checksum(value)].join('|'),
      );
      // Cleanup only (the value is already committed): leftovers in this slot, then the old value.
      await clearSlotFrom(key, slot, chunks.length);
      if (previous.kind === 'slot') await clearSlotFrom(key, previous.slot, 0);
      if (previous.kind === 'legacy') await clearLegacy(key, previous.count);
    },

    async removeItem(key) {
      const previous = await pointer(key);
      // The pointer goes first, so a crash mid-removal already reads as signed out.
      await store.deleteItem(pointerKey(key));
      await clearSlotFrom(key, 'a', 0);
      await clearSlotFrom(key, 'b', 0);
      if (previous.kind === 'legacy') await clearLegacy(key, previous.count);
    },
  };
}
