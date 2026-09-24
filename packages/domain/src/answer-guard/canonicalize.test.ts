import { describe, expect, it } from 'vitest';
import { canonicalize } from './index.ts';

// Spec P6: "Do not leak by acrostic, encoding, translated text ... rendered math". Obfuscation
// must be undone before any detector compares text with a protected answer.
describe('canonicalize (P6 obfuscation is removed before comparison)', () => {
  it('strips zero-width, bidi and soft-hyphen format characters', () => {
    expect(canonicalize('le\u200Bar\u200Dn\u2060\uFEFF\u00AD\u200E')).toBe('learn');
  });

  it('maps common Cyrillic and Greek homoglyphs to Latin letters', () => {
    // Cyrillic \u0435/\u0430 and Greek \u0392 \u0395 \u03A4 \u0391
    expect(canonicalize('l\u0435\u0430rn \u0392\u0395\u03A4\u0391')).toBe('learn beta');
  });

  it('applies NFKC so fullwidth, mathematical and circled forms become ASCII', () => {
    expect(canonicalize('\uFF21\uFF22\uFF23 \u{1D7D2}\u{1D7D0} \u2460')).toBe('abc 42 1');
  });

  it('collapses horizontal whitespace, keeps single line breaks and lowercases', () => {
    expect(canonicalize('  One\t\t TWO \r\n\r\n three ')).toBe('one two\nthree');
  });

  it('rewrites vulgar fractions as n/d so a mixed number stays readable', () => {
    expect(canonicalize('3\u00BD')).toBe('3 1/2');
    expect(canonicalize('\u00B9\u2044\u2082')).toBe('1/2');
  });

  it('removes accents so Spanish number words compare without diacritics', () => {
    expect(canonicalize('diecis\u00E9is \u00D1and\u00FA')).toBe('dieciseis nandu');
  });
});
