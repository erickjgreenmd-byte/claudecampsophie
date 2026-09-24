import type { RandomSource } from '../shared/random.ts';

/** RFC 4122 version 4 UUID from an injected RandomSource (docs/Architecture.md §2: IDs are UUID v4). */
export function uuidV4(random: RandomSource): string {
  const bytes = random(16);
  if (bytes.length !== 16) throw new Error('RandomSource must return the requested 16 bytes');
  const b = Uint8Array.from(bytes);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * New id that is not already used in `taken`.
 * Decision: a collision can only come from a broken RandomSource, so it is a programmer error and
 * throws instead of silently aliasing two reservations (which could double-commit or double-release).
 */
export function freshId(random: RandomSource, taken: (id: string) => boolean): string {
  const id = uuidV4(random);
  if (taken(id)) throw new Error('RandomSource produced a duplicate reservation id');
  return id;
}

/** True for a non-empty string. Identifiers are opaque data: compared, never interpreted. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
