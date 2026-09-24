import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cryptoRandom, type RandomSource } from '../shared/random.ts';
import {
  CROCKFORD_ALPHABET,
  formatPromoCode,
  generatePromoCode,
  generatePromoCodes,
  normalizePromoCode,
} from './codes.ts';

/** Deterministic RandomSource that replays `bytes` (then zeros). Test double, labeled as such. */
function replay(bytes: readonly number[]): RandomSource {
  const queue = [...bytes];
  return (n) => Uint8Array.from({ length: n }, () => queue.shift() ?? 0);
}

const dataSymbol = fc.integer({ min: 0, max: 31 });
const tenSymbols = fc.array(dataSymbol, { minLength: 10, maxLength: 10 });

function codeFromValues(values: readonly number[]): string {
  return generatePromoCode(replay(values)).normalized;
}

describe('P17 promo code format: Crockford base32, 50 data bits + mod-37 check symbol', () => {
  it('encodes 10 data symbols plus one check symbol and displays them grouped 5-5-1', () => {
    const code = generatePromoCode(replay([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(code.normalized).toMatch(/^0123456789.$/);
    expect(code.display).toBe(`01234-56789-${code.normalized.slice(10)}`);
  });

  it('uses the Crockford check alphabet, including *~$=U for values 32..36', () => {
    // value(0000000001) = 1 -> '1'; value(000000000Z) = 31 -> 'Z'; value(0000000010) = 32 -> '*'
    expect(codeFromValues([0, 0, 0, 0, 0, 0, 0, 0, 0, 1])).toBe('00000000011');
    expect(codeFromValues([0, 0, 0, 0, 0, 0, 0, 0, 0, 31])).toBe('000000000ZZ');
    expect(codeFromValues([0, 0, 0, 0, 0, 0, 0, 0, 1, 0])).toBe('0000000010*');
    expect(codeFromValues([0, 0, 0, 0, 0, 0, 0, 0, 1, 1])).toBe('0000000011~');
    expect(codeFromValues([0, 0, 0, 0, 0, 0, 0, 0, 1, 2])).toBe('0000000012$');
    expect(codeFromValues([0, 0, 0, 0, 0, 0, 0, 0, 1, 3])).toBe('0000000013=');
    expect(codeFromValues([0, 0, 0, 0, 0, 0, 0, 0, 1, 4])).toBe('0000000014U');
    // 37 mod 37 = 0
    expect(codeFromValues([0, 0, 0, 0, 0, 0, 0, 0, 1, 5])).toBe('00000000150');
  });

  it('draws every data symbol through unbiased randomInt (bytes map uniformly onto 32 symbols)', () => {
    // 256 % 32 === 0, so every byte is accepted and byte % 32 selects the symbol.
    const code = generatePromoCode(replay([32, 33, 255, 64, 95, 128, 160, 200, 224, 250]));
    expect(code.normalized.slice(0, 10)).toBe(
      [0, 1, 31, 0, 31, 0, 0, 8, 0, 26].map((i) => CROCKFORD_ALPHABET[i]).join(''),
    );
  });

  it('round-trips: every generated code normalizes back to itself from its display form', () => {
    fc.assert(
      fc.property(tenSymbols, (values) => {
        const code = generatePromoCode(replay(values));
        expect(code.normalized).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}[0-9A-HJKMNP-TV-Z*~$=U]$/);
        const result = normalizePromoCode(code.display);
        expect(result).toEqual({ ok: true, value: code.normalized });
      }),
    );
  });

  it('is forgiving on entry: case, spaces, hyphens and O/I/L look-alikes all normalize', () => {
    const code = generatePromoCode(replay([0, 1, 1, 18, 20, 21, 22, 23, 24, 25])); // 011JMNPQRS
    const sloppy = ` ${code.display.toLowerCase().replace(/0/g, 'o').replace(/1/, 'i').replace(/1/, 'l')} `;
    expect(normalizePromoCode(sloppy)).toEqual({ ok: true, value: code.normalized });
    expect(normalizePromoCode(code.normalized.split('').join(' '))).toEqual({
      ok: true,
      value: code.normalized,
    });
  });

  it('detects every single-symbol substitution in the data part (CODE_CHECKSUM_MISMATCH)', () => {
    fc.assert(
      fc.property(
        tenSymbols,
        fc.integer({ min: 0, max: 9 }),
        fc.integer({ min: 1, max: 31 }),
        (values, position, shift) => {
          const code = codeFromValues(values);
          const mutated = [...values];
          mutated[position] = ((mutated[position] ?? 0) + shift) % 32;
          const forged = mutated.map((v) => CROCKFORD_ALPHABET[v]).join('') + code.slice(10);
          const result = normalizePromoCode(forged);
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error.code).toBe('CODE_CHECKSUM_MISMATCH');
        },
      ),
    );
  });

  it('detects every adjacent transposition of distinct data symbols', () => {
    fc.assert(
      fc.property(tenSymbols, fc.integer({ min: 0, max: 8 }), (values, i) => {
        fc.pre(values[i] !== values[i + 1]);
        const code = codeFromValues(values);
        const swapped = [...values];
        [swapped[i], swapped[i + 1]] = [swapped[i + 1]!, swapped[i]!];
        const forged = swapped.map((v) => CROCKFORD_ALPHABET[v]).join('') + code.slice(10);
        const result = normalizePromoCode(forged);
        expect(result.ok).toBe(false);
      }),
    );
  });

  it.each([
    ['empty', ''],
    ['too short', '0123456789'],
    ['too long', '0123456789AB'],
    ['U in a data position', 'U000000000U'],
    ['check-only symbol in a data position', '*0000000000'],
    ['punctuation', '01234.56789.X'],
    ['dotless i (uppercases to I)', 'ı000000000' + '1'],
    ['long s (uppercases to S)', 'ſ0000000000'],
    ['full-width digits', '０000000000' + '0'],
    ['very long input', 'A'.repeat(10_000)],
  ])('rejects %s as CODE_INVALID_FORMAT', (_label, input) => {
    const result = normalizePromoCode(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CODE_INVALID_FORMAT');
  });

  it('accepts U only as the check symbol', () => {
    expect(normalizePromoCode('00000-00014-u')).toEqual({ ok: true, value: '0000000014U' });
  });

  it('formats only valid normalized codes for display', () => {
    expect(formatPromoCode('0000000014U')).toBe('00000-00014-U');
    expect(() => formatPromoCode('0000000014X')).toThrow(RangeError);
  });

  it('generates distinct codes for individual campaigns, skipping collisions', () => {
    // First two draws are identical; the second must be redrawn.
    const same = [3, 3, 3, 3, 3, 3, 3, 3, 3, 3];
    const other = [4, 4, 4, 4, 4, 4, 4, 4, 4, 4];
    const codes = generatePromoCodes(replay([...same, ...same, ...other]), 2);
    expect(codes.map((c) => c.normalized)).toEqual([codeFromValues(same), codeFromValues(other)]);
  });

  it('never returns a code listed in `exclude` (already stored codes)', () => {
    const taken = codeFromValues([5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
    const code = generatePromoCode(
      replay([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6]),
      { exclude: new Set([taken]) },
    );
    expect(code.normalized).toBe(codeFromValues([6, 6, 6, 6, 6, 6, 6, 6, 6, 6]));
  });

  it('fails loudly instead of looping forever on a broken RandomSource', () => {
    const constant: RandomSource = (n) => new Uint8Array(n);
    expect(() => generatePromoCodes(constant, 2)).toThrow(/distinct/i);
  });

  it('uses the real crypto source by default and yields valid codes', () => {
    const [a, b] = generatePromoCodes(cryptoRandom, 2);
    expect(normalizePromoCode(a!.display).ok).toBe(true);
    expect(a!.normalized).not.toBe(b!.normalized);
  });
});
