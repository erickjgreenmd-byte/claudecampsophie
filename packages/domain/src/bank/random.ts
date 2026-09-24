// Deterministic, seedable randomness for the question bank (docs/Architecture.md §2: randomness is
// injected). The bank never needs unpredictability, only reproducibility: the same seed always
// produces the same items, so a retried generation job composes the same set.
import type { RandomSource } from '../shared/random.ts';

/** xmur3 string hash: turns a seed string into a stream of 32-bit seeds. */
function xmur3(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/**
 * A `RandomSource` driven by the sfc32 generator seeded from `seed`. Not for security: the bank
 * uses it only to vary numbers, contexts and choice order reproducibly.
 */
export function seededRandom(seed: string): RandomSource {
  const next = xmur3(seed);
  let a = next();
  let b = next();
  let c = next();
  let d = next();
  const word = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return t >>> 0;
  };
  return (byteLength) => {
    const out = new Uint8Array(byteLength);
    for (let i = 0; i < byteLength; i += 4) {
      const w = word();
      for (let j = 0; j < 4 && i + j < byteLength; j += 1) out[i + j] = (w >>> (8 * j)) & 0xff;
    }
    return out;
  };
}

/** Uniform integer in [min, max] (inclusive) with rejection sampling over 32-bit draws. */
export function randInt(random: RandomSource, min: number, max: number): number {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
    throw new RangeError('randInt needs integers with min <= max');
  }
  const span = max - min + 1;
  if (span > 2 ** 32) throw new RangeError('randInt range too large');
  const limit = Math.floor(2 ** 32 / span) * span;
  for (;;) {
    const bytes = random(4);
    const value =
      ((bytes[0] ?? 0) |
        ((bytes[1] ?? 0) << 8) |
        ((bytes[2] ?? 0) << 16) |
        ((bytes[3] ?? 0) << 24)) >>>
      0;
    if (value < limit) return min + (value % span);
  }
}

export function pick<T>(random: RandomSource, list: readonly T[]): T {
  if (list.length === 0) throw new RangeError('pick needs a non-empty list');
  return list[randInt(random, 0, list.length - 1)] as T;
}

/** Fisher-Yates shuffle into a new array. */
export function shuffle<T>(random: RandomSource, list: readonly T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randInt(random, 0, i);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** Short, opaque, deterministic hash (FNV-1a 32-bit, hex) used in instance keys. */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
