import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalize, guardChildContent, scanForLeaks } from './index.ts';
import { base64, choice, hex, numeric, spelling } from './test-helpers.ts';

const ZERO_WIDTH = ['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF', '\u00AD'];
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** Inserts invisible characters at arbitrary positions. */
function sprinkle(
  textValue: string,
  positions: readonly number[],
  marks: readonly string[],
): string {
  const chars = [...textValue];
  positions.forEach((p, i) => {
    chars.splice(p % (chars.length + 1), 0, marks[i % marks.length] ?? '\u200B');
  });
  return chars.join('');
}

describe('answer-guard invariants (property-based; P6, AC_GRADING_07/08)', () => {
  it('canonicalize is idempotent', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (s) => {
        const once = canonicalize(s);
        expect(canonicalize(once)).toBe(once);
      }),
    );
  });

  it('a stated integer answer is flagged even with zero-width characters sprinkled in', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.array(fc.nat(), { maxLength: 8 }),
        fc.array(fc.constantFrom(...ZERO_WIDTH), { minLength: 1, maxLength: 8 }),
        (n, positions, marks) => {
          const content = sprinkle(`The answer is ${n}.`, positions, marks);
          expect(scanForLeaks(content, [numeric(String(n))]).safe).toBe(false);
        },
      ),
    );
  });

  it('any equivalent fraction of a protected fraction is flagged', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 2, max: 61 }),
        fc.integer({ min: 2, max: 9 }),
        (a, b, k) => {
          fc.pre(a < b);
          const content = `Try ${a * k}/${b * k}.`;
          expect(scanForLeaks(content, [numeric(`${a}/${b}`)]).safe).toBe(false);
        },
      ),
    );
  });

  it('a base64- or hex-wrapped statement of the answer is flagged', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), fc.boolean(), (n, useHex) => {
        const secret = `The answer is ${n}`;
        const wrapped = useHex ? hex(secret) : base64(secret);
        expect(scanForLeaks(`Code: ${wrapped}`, [numeric(String(n))]).safe).toBe(false);
      }),
    );
  });

  it('a spelling target written with separators or reversed is flagged', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom(...LETTERS), minLength: 4, maxLength: 10 }),
        fc.constantFrom('-', ' ', '.', '\n', ' - ', '*', '_'),
        fc.boolean(),
        (word, separator, reverse) => {
          const letters = reverse ? [...word].reverse() : [...word];
          const content = `Hint: ${letters.join(separator)}!`;
          expect(scanForLeaks(content, [spelling(word)]).safe).toBe(false);
        },
      ),
    );
  });

  it('an example using a different integer is safe', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 99_999 }),
        fc.integer({ min: 0, max: 99_999 }),
        (n, m) => {
          const digits = String(n);
          fc.pre(m !== n);
          fc.pre(digits.length < 3 || String(m) !== [...digits].reverse().join(''));
          fc.pre(String(m) !== hex(digits));
          const result = scanForLeaks(`Try an example with ${m} counters.`, [numeric(digits)]);
          expect(result.findings).toEqual([]);
        },
      ),
    );
  });

  it('finding evidence never contains the protected spelling target', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom(...LETTERS), minLength: 4, maxLength: 10 }),
        (word) => {
          const result = scanForLeaks(`Spell ${word} carefully: ${word}`, [spelling(word)]);
          expect(result.safe).toBe(false);
          for (const finding of result.findings) expect(finding.evidence).not.toContain(word);
        },
      ),
    );
  });

  it('scanForLeaks never throws on arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (s) => {
        const result = scanForLeaks(s, [numeric('3/4'), spelling('learn')]);
        expect(typeof result.safe).toBe('boolean');
        expect(result.safe).toBe(result.findings.length === 0);
      }),
    );
  });

  it('scanForLeaks never throws on word soup (prototype names, number words, notation)', () => {
    const vocabulary = [
      'constructor',
      '__proto__',
      'tostring',
      'valueof',
      'hasownproperty',
      'prototype',
      'one',
      'a',
      'an',
      'un',
      'una',
      'half',
      'medio',
      'mitad',
      'quarter',
      'third',
      'fourths',
      'twenty',
      'forty',
      'treinta',
      'y',
      'and',
      'hundred',
      'thousand',
      'million',
      'mil',
      'ciento',
      'cien',
      'point',
      'punto',
      'coma',
      'over',
      'out',
      'of',
      'de',
      'cada',
      'percent',
      'per',
      'cent',
      'por',
      'dozen',
      'tens',
      'ones',
      'decenas',
      'once',
      'la',
      'es',
      'step',
      '1.',
      '(2)',
      '3',
      '0.5',
      '1,500',
      '1.500',
      '3/4',
      '%',
      '\\frac',
      '{1}',
      '{2}',
      '...',
      '-',
      '\n',
      'option',
      'b',
      'B)',
      '(a)',
      'is',
      'correct',
      'www.',
      'bit.ly',
      '&#52;',
      '<b>',
      '</b>',
      '%34',
      'NDI=',
      '3432',
      'gur',
      'sbegl',
      'l-e-a-r-n',
      'learn',
    ];
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...vocabulary), { maxLength: 40 }), (words) => {
        const result = scanForLeaks(words.join(' '), [
          numeric('42'),
          numeric('3/4'),
          choice('b'),
          spelling('learn'),
        ]);
        expect(result.safe).toBe(result.findings.length === 0);
      }),
      { numRuns: 300 },
    );
  });

  it('guardChildContent never throws and only releases packets with no reasons', () => {
    fc.assert(
      fc.property(fc.anything(), (packet) => {
        const decision = guardChildContent({ packet, answers: [numeric('7')] });
        expect(['release', 'block']).toContain(decision.decision);
        expect(decision.decision === 'release').toBe(decision.reasons.length === 0);
      }),
    );
  });
});
