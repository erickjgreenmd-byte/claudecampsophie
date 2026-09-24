import { ApiRequestError } from '@pencillift/contracts/client';

/**
 * Child device pairing code entry (spec P3, AC_ACCESS_04). Mirrors the API's code format: 8
 * symbols of Crockford base32 (no I, L, O, U), shown as `ABCD-EFGH`. Letters that look alike are
 * mapped the same way the server maps them, so a child typing "O" for "0" still succeeds.
 * Pure: no react-native imports.
 */

export const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_LENGTH = 8;

/** Normalizes what was typed so far: uppercase, separators dropped, look-alikes mapped. */
export function normalizePairingInput(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .slice(0, PAIRING_CODE_LENGTH + 4);
}

/** Display form while typing: `ABCD-EFGH` (a hyphen after the fourth symbol). */
export function formatPairingInput(raw: string): string {
  const normalized = normalizePairingInput(raw).slice(0, PAIRING_CODE_LENGTH);
  return normalized.length > 4 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized;
}

export type PairingCodeCheck =
  { readonly ok: true; readonly code: string } | { readonly ok: false; readonly message: string };

/** Validates a complete code. Messages are calm and child-friendly. */
export function validatePairingCode(raw: string): PairingCodeCheck {
  const normalized = normalizePairingInput(raw);
  for (const ch of normalized) {
    if (!PAIRING_ALPHABET.includes(ch)) {
      return {
        ok: false,
        message: 'That code has a letter or symbol it can’t have. Check it with a grown-up.',
      };
    }
  }
  if (normalized.length < PAIRING_CODE_LENGTH) {
    return { ok: false, message: 'The code has 8 letters and numbers. Keep going!' };
  }
  if (normalized.length > PAIRING_CODE_LENGTH) {
    return { ok: false, message: 'That code is too long. Check it with a grown-up.' };
  }
  return { ok: true, code: normalized };
}

/** Maps a pairing failure to calm copy without technical terms. */
export function pairingErrorMessage(error: unknown): string {
  const code = error instanceof ApiRequestError ? error.code : null;
  if (code === 'NOT_FOUND' || code === 'VALIDATION_FAILED')
    return 'That code didn’t work. Ask a grown-up for a new one.';
  if (code === 'RATE_LIMITED') return 'Let’s take a short break, then try again.';
  if (code === 'NETWORK')
    return 'We can’t reach PencilLift right now. Check the internet and try again.';
  return 'Something went wrong. Please try again, or ask a grown-up for help.';
}

/** Plain-language device label for a platform, used when a child pairs a device. */
export function defaultDeviceLabel(platform: 'ios' | 'android' | 'web'): string {
  switch (platform) {
    case 'ios':
      return 'iPhone or iPad';
    case 'android':
      return 'Android device';
    case 'web':
      return 'Web browser';
  }
}
