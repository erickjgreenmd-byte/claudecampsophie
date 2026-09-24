import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '@pencillift/contracts/client';
import {
  defaultDeviceLabel,
  formatPairingInput,
  normalizePairingInput,
  pairingErrorMessage,
  validatePairingCode,
} from './pairing-code.ts';

describe('pairing code entry', () => {
  it('normalizes case, separators and look-alike letters like the server', () => {
    expect(normalizePairingInput('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizePairingInput(' 0o1i l ')).toBe('00111');
    expect(normalizePairingInput('ab cd\nef-gh')).toBe('ABCDEFGH');
  });

  it('formats with a hyphen after four symbols while typing', () => {
    expect(formatPairingInput('abc')).toBe('ABC');
    expect(formatPairingInput('abcd')).toBe('ABCD');
    expect(formatPairingInput('abcde')).toBe('ABCD-E');
    expect(formatPairingInput('ABCD-EFGH-JK')).toBe('ABCD-EFGH');
  });

  it('accepts a complete valid code', () => {
    expect(validatePairingCode('7k2m-9pqr')).toEqual({ ok: true, code: '7K2M9PQR' });
    expect(validatePairingCode('O0IL-2345')).toEqual({ ok: true, code: '00112345' });
  });

  it('rejects short, long and invalid codes with calm messages', () => {
    const short = validatePairingCode('ABC');
    expect(short.ok).toBe(false);
    expect(!short.ok && short.message).toMatch(/Keep going/);
    expect(validatePairingCode('ABCDEFGHJ').ok).toBe(false);
    const invalid = validatePairingCode('ABCD-EFGU'); // U is not in the alphabet
    expect(invalid.ok).toBe(false);
    expect(!invalid.ok && invalid.message).toMatch(/grown-up/);
    expect(validatePairingCode('ABCD!FGH').ok).toBe(false);
  });

  it('maps API failures to child-friendly copy without technical words', () => {
    const cases: [ApiRequestError | Error, RegExp][] = [
      [new ApiRequestError('NOT_FOUND', 'That code did not work', 404), /Ask a grown-up/],
      [new ApiRequestError('RATE_LIMITED', 'Too many attempts', 429), /short break/],
      [new ApiRequestError('NETWORK', 'offline', 0), /internet/],
      [new Error('boom'), /Something went wrong/],
    ];
    for (const [error, expected] of cases) {
      const message = pairingErrorMessage(error);
      expect(message).toMatch(expected);
      expect(message).not.toMatch(/API|token|4\d\d|HTTP/);
    }
  });

  it('labels devices in plain language', () => {
    expect(defaultDeviceLabel('ios')).toBe('iPhone or iPad');
    expect(defaultDeviceLabel('android')).toBe('Android device');
  });
});
