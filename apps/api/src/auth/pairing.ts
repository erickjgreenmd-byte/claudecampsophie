import { randomInt, type RandomSource } from '@pencillift/domain';
import { hmacSha256 } from '../security/crypto.ts';

/** Crockford base32 without I, L, O, U: unambiguous when read aloud or typed by a child. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_LENGTH = 8;

/** 8 symbols × 5 bits = 40 bits; single use, 10-minute expiry, rate-limited redemption. */
export function generatePairingCode(random: RandomSource): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1)
    code += ALPHABET[randomInt(ALPHABET.length, random)];
  return code;
}

export function normalizePairingCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (cleaned.length !== PAIRING_CODE_LENGTH) return null;
  for (const ch of cleaned) if (!ALPHABET.includes(ch)) return null;
  return cleaned;
}

export async function pairingCodeHash(pepper: Uint8Array, code: string): Promise<Uint8Array> {
  return hmacSha256(pepper, `pairing:${code}`);
}
