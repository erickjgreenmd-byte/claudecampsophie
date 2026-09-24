/** WebCrypto helpers that run unchanged on Cloudflare Workers and Node 22. */

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** 256-bit URL-safe random token (refresh tokens, invitation tokens). */
export function randomToken(): string {
  return toBase64Url(randomBytes(32));
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? encoder.encode(input) : input;
  // Workers types need the cast (Uint8Array<ArrayBufferLike> vs BufferSource); the lint rule disagrees.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return toHex(new Uint8Array(digest));
}

/**
 * Keyed hash for low-entropy secrets we must look up (pairing codes, promo-guess keys): an attacker
 * with a database dump still needs the Worker-held pepper to brute-force them.
 */
export async function hmacSha256(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- required by Workers types
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message)));
}

/** Constant-time comparison of equal-length byte arrays. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
