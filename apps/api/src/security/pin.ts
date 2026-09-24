import { hmacSha256, randomBytes, timingSafeEqual, toBase64Url } from './crypto.ts';

/**
 * Parent PIN hashing: PBKDF2-SHA256 over HMAC(pepper, pin). A 6-digit PIN has only 10^6 values, so
 * the online lockout is the primary control; the pepper keeps a leaked table from being brute-forced
 * offline. Format: `pbkdf2-sha256$<iterations>$<salt b64url>$<hash b64url>`.
 */

export const PIN_ITERATIONS = 100_000;
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCKOUT_SECONDS = 15 * 60;

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function derive(
  pin: string,
  pepper: Uint8Array,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const peppered = await hmacSha256(pepper, pin);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- required by Workers types
  const key = await crypto.subtle.importKey('raw', peppered as BufferSource, 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPin(
  pin: string,
  pepper: Uint8Array,
  iterations = PIN_ITERATIONS,
): Promise<string> {
  if (!/^\d{6}$/.test(pin)) throw new RangeError('PIN must be 6 digits');
  const salt = randomBytes(16);
  const hash = await derive(pin, pepper, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPin(pin: string, stored: string, pepper: Uint8Array): Promise<boolean> {
  const [scheme, iterationsRaw, saltRaw, hashRaw] = stored.split('$');
  if (scheme !== 'pbkdf2-sha256' || !iterationsRaw || !saltRaw || !hashRaw) return false;
  const iterations = Number(iterationsRaw);
  if (!Number.isSafeInteger(iterations) || iterations < 10_000) return false;
  if (!/^\d{6}$/.test(pin)) return false;
  const expected = fromBase64Url(hashRaw);
  const actual = await derive(pin, pepper, fromBase64Url(saltRaw), iterations);
  return timingSafeEqual(actual, expected);
}

/** Trivial PINs are refused (a shared family device makes guessing easy). */
export function isWeakPin(pin: string): boolean {
  if (/^(\d)\1{5}$/.test(pin)) return true;
  const ascending = '0123456789012345';
  const descending = '9876543210987654';
  return (
    ascending.includes(pin) ||
    descending.includes(pin) ||
    ['123123', '121212', '112233'].includes(pin)
  );
}
