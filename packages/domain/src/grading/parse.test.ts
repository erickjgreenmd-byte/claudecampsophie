import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addRational,
  divideRational,
  formatRational,
  isSimplestForm,
  MAX_ANSWER_LENGTH,
  multiplyRational,
  parseMathAnswer,
  parseMathAnswerDetailed,
  PARSE_ERROR_CODES,
  rational,
  rationalToDecimalString,
  subtractRational,
  type ParseErrorCode,
  type Rational,
} from './index.ts';

function value(text: string): string {
  const result = parseMathAnswer(text);
  if (!result.ok)
    throw new Error(`expected ${JSON.stringify(text)} to parse, got ${result.error.code}`);
  return formatRational(result.value);
}

function errorCode(text: string, options?: Parameters<typeof parseMathAnswer>[1]): string {
  const result = parseMathAnswer(text, options);
  return result.ok ? `ok:${formatRational(result.value)}` : result.error.code;
}

describe('P5 safe parser: accepted numeric notations (AC_GRADING_02, AC_CAPTURE_03)', () => {
  it.each([
    ['integer', '5', '5'],
    ['negative integer', '-7', '-7'],
    ['decimal', '0.5', '1/2'],
    ['decimal without leading zero', '.5', '1/2'],
    ['decimal with trailing zero', '3.0', '3'],
    ['decimal point with no fractional digits', '3.', '3'],
    ['thousands separator', '1,000', '1000'],
    ['thousands separator with decimals', '12,345.6', '61728/5'],
    ['several thousands groups', '1,234,567', '1234567'],
    ['ASCII fraction', '3/4', '3/4'],
    ['unreduced fraction keeps its value', '6/8', '3/4'],
    ['fraction slash U+2044', '3\u20444', '3/4'],
    ['division slash U+2215', '3\u22154', '3/4'],
    ['mixed number (whitespace form)', '2 1/2', '5/2'],
    ['negative mixed number', '-2 1/2', '-5/2'],
    ['mixed number with vulgar fraction', '2½', '5/2'],
    ['mixed number with spaced vulgar fraction', '2 ½', '5/2'],
    ['vulgar one half', '½', '1/2'],
    ['vulgar three quarters', '¾', '3/4'],
    ['vulgar seven eighths', '⅞', '7/8'],
    ['vulgar one third', '⅓', '1/3'],
    ['superscript/subscript fraction', '¹\u2044₂', '1/2'],
    ['mixed superscript/subscript fraction', '2¹\u2044₂', '5/2'],
    ['unicode minus at start', '\u22123', '-3'],
    ['unicode minus as a binary operator', '5 \u2212 3', '2'],
    ['en dash as a leading minus', '\u20133', '-3'],
    ['parentheses and precedence', '(2+3)*4', '20'],
    ['multiplication binds tighter', '2 + 3 × 4', '14'],
    ['obelus division', '12 ÷ 4', '3'],
    ['middle-dot multiplication', '3 · 4', '12'],
    ['caret exponent', '2^3', '8'],
    ['superscript exponent', '2³', '8'],
    ['superscript negative exponent', '10⁻²', '1/100'],
    ['exponent of a parenthesized fraction', '(1/2)^2', '1/4'],
    ['exponent of a vulgar fraction binds to the whole glyph', '¾²', '9/16'],
    ['negative caret exponent', '2^-1', '1/2'],
    ['exponent binds tighter than division', '1/2^2', '1/4'],
    ['percent in value mode', '50%', '1/2'],
    ['decimal percent', '12.5%', '1/8'],
    ['fullwidth digits (NFKC)', '１２', '12'],
    ['fullwidth fraction (NFKC)', '３\uff0f４', '3/4'],
    ['leading equals sign is ignored', '= 7', '7'],
    ['surrounding whitespace', '  42  ', '42'],
    ['mixed number inside a sum', '2 + 1 1/2', '7/2'],
    ['mixed number as a right factor', '3 × 2 1/2', '15/2'],
    ['double negative', '3 - -4', '7'],
    ['leading plus', '+5', '5'],
    ['non-breaking space inside mixed number', '2\u00a01/2', '5/2'],
  ])('%s: %j = %s', (_label, input, expected) => {
    expect(value(input)).toBe(expected);
  });

  it('keeps exponent placement distinct from juxtaposed digits (AC_CAPTURE_03)', () => {
    expect(value('3²')).toBe('9');
    expect(value('32')).toBe('32');
    expect(value('10²')).toBe('100');
    expect(value('102')).toBe('102');
  });
});

describe('P5 safe parser: failures are typed, never guessed', () => {
  it.each<[string, string, ParseErrorCode]>([
    ['empty', '', 'EMPTY_INPUT'],
    ['whitespace only', '   ', 'EMPTY_INPUT'],
    ['European decimal comma', '1,5', 'AMBIGUOUS_FORMAT'],
    ['two-digit group', '1,00', 'AMBIGUOUS_FORMAT'],
    ['four-digit group', '1,0000', 'AMBIGUOUS_FORMAT'],
    ['oversized leading group', '1234,567', 'AMBIGUOUS_FORMAT'],
    ['leading comma', ',5', 'AMBIGUOUS_FORMAT'],
    ['comma-separated list', '1, 2', 'AMBIGUOUS_FORMAT'],
    ['comma after decimals', '1.000,5', 'AMBIGUOUS_FORMAT'],
    ['two decimal points', '1.2.3', 'AMBIGUOUS_FORMAT'],
    ['hyphenated mixed number', '2-1/2', 'AMBIGUOUS_FORMAT'],
    ['en dash between numbers (range?)', '5\u20133', 'AMBIGUOUS_FORMAT'],
    ['em dash', '\u20145', 'AMBIGUOUS_FORMAT'],
    ['unary minus on a power', '-2^2', 'AMBIGUOUS_FORMAT'],
    ['chained exponent', '2^3^2', 'AMBIGUOUS_FORMAT'],
    ['chained superscript exponent', '2²^3', 'AMBIGUOUS_FORMAT'],
    ['juxtaposed integers', '2 3', 'AMBIGUOUS_FORMAT'],
    ['implicit multiplication', '2(3)', 'AMBIGUOUS_FORMAT'],
    ['juxtaposed fractions', '1/2 1/2', 'AMBIGUOUS_FORMAT'],
    ['exponent on a mixed number', '2 1/2^2', 'AMBIGUOUS_FORMAT'],
    ['superscript on a vulgar mixed number', '2½²', 'AMBIGUOUS_FORMAT'],
    ['division by zero', '5/0', 'DIVISION_BY_ZERO'],
    ['division by a zero expression', '1/(2-2)', 'DIVISION_BY_ZERO'],
    ['zero to a negative power', '0^-1', 'DIVISION_BY_ZERO'],
    ['variable', 'x+1', 'UNSUPPORTED_EXPRESSION'],
    ['scientific e-notation', '3e5', 'UNSUPPORTED_EXPRESSION'],
    ['letter x is never multiplication', '3x4', 'UNSUPPORTED_EXPRESSION'],
    ['currency is left to the unit layer', '$5', 'UNSUPPORTED_EXPRESSION'],
    ['equation', '3+4=7', 'UNSUPPORTED_EXPRESSION'],
    ['number word', 'seven', 'UNSUPPORTED_EXPRESSION'],
    ['irrational power', '2^(1/2)', 'UNSUPPORTED_EXPRESSION'],
    ['zero to the zero', '0^0', 'UNSUPPORTED_EXPRESSION'],
    ['stray subscript', '3₂', 'UNSUPPORTED_EXPRESSION'],
    ['private-use character', '\ue000', 'UNSUPPORTED_EXPRESSION'],
    ['exponent too large', '2^13', 'EXPONENT_OUT_OF_RANGE'],
    ['superscript exponent too large', '2¹³', 'EXPONENT_OUT_OF_RANGE'],
    ['exponent too negative', '2^-13', 'EXPONENT_OUT_OF_RANGE'],
    ['result magnitude bound', '999999999999^12', 'RESULT_TOO_LARGE'],
    ['nested magnitude bound', '(10^12)^12', 'RESULT_TOO_LARGE'],
    ['trailing operator', '3+', 'INVALID_SYNTAX'],
    ['unclosed parenthesis', '(2+3', 'INVALID_SYNTAX'],
    ['unopened parenthesis', '2+3)', 'INVALID_SYNTAX'],
    ['empty parentheses', '()', 'INVALID_SYNTAX'],
    ['lone decimal point', '.', 'INVALID_SYNTAX'],
    ['leading binary operator', '*3', 'INVALID_SYNTAX'],
    ['deep nesting', `${'('.repeat(40)}1${')'.repeat(40)}`, 'TOO_COMPLEX'],
    ['long unary chain', `${'-'.repeat(60)}1`, 'TOO_COMPLEX'],
  ])('%s: %j -> %s', (_label, input, code) => {
    expect(errorCode(input)).toBe(code);
  });

  it(`rejects inputs longer than ${MAX_ANSWER_LENGTH} characters before doing any work`, () => {
    expect(errorCode('1'.repeat(MAX_ANSWER_LENGTH))).not.toBe('INPUT_TOO_LONG');
    expect(errorCode('1'.repeat(MAX_ANSWER_LENGTH + 1))).toBe('INPUT_TOO_LONG');
    expect(errorCode(`${'1+'.repeat(100)}1`)).toBe('INPUT_TOO_LONG');
    expect(errorCode('9'.repeat(1_000_000))).toBe('INPUT_TOO_LONG');
  });

  it('can reject percent notation when the caller wants plain numbers only', () => {
    expect(errorCode('50%', { percent: 'reject' })).toBe('UNSUPPORTED_EXPRESSION');
  });

  it('exports every error code it can produce as a stable const union', () => {
    expect(PARSE_ERROR_CODES).toEqual([
      'EMPTY_INPUT',
      'INPUT_TOO_LONG',
      'TOO_COMPLEX',
      'INVALID_SYNTAX',
      'AMBIGUOUS_FORMAT',
      'UNSUPPORTED_EXPRESSION',
      'DIVISION_BY_ZERO',
      'EXPONENT_OUT_OF_RANGE',
      'RESULT_TOO_LARGE',
    ]);
  });
});

describe('P5 simplest-form detection (requireSimplestForm support)', () => {
  it.each([
    ['3/4', 'fraction', true],
    ['6/8', 'fraction', false],
    ['4/1', 'fraction', false],
    ['0/5', 'fraction', false],
    ['5/2', 'fraction', true], // improper fractions in lowest terms are simplest
    ['-3/4', 'fraction', true],
    ['½', 'fraction', true],
    ['2 1/2', 'mixed_number', true],
    ['2 2/4', 'mixed_number', false],
    ['1 3/2', 'mixed_number', false],
    ['0.5', 'decimal', true],
    ['7', 'integer', true],
    ['50%', 'percent', true],
    ['1+1', 'expression', false],
    ['2²', 'expression', false],
    ['(3/4)', 'fraction', true],
  ] as const)('%j is %s (simplest: %s)', (input, kind, simplest) => {
    const result = parseMathAnswerDetailed(input);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.form.kind).toBe(kind);
    expect(isSimplestForm(result.value.form)).toBe(simplest);
  });
});

// ---------------------------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------------------------

const smallInt = fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n });
const positiveInt = fc.bigInt({ min: 1n, max: 10n ** 12n });
const arbRational = fc.tuple(smallInt, positiveInt).map(([n, d]) => rational(n, d));

function parsed(text: string): Rational {
  const result = parseMathAnswer(text);
  if (!result.ok) throw new Error(`${JSON.stringify(text)} -> ${result.error.code}`);
  return result.value;
}

describe('P5 safe parser: properties', () => {
  it('parse(format(r)) == r for random rationals', () => {
    fc.assert(
      fc.property(arbRational, (x) => {
        expect(parsed(formatRational(x))).toEqual(x);
      }),
    );
  });

  it('parse(decimal(r)) == r for random terminating decimals', () => {
    const terminating = fc
      .tuple(smallInt, fc.integer({ min: 0, max: 8 }), fc.integer({ min: 0, max: 8 }))
      .map(([n, a, b]) => rational(n, 2n ** BigInt(a) * 5n ** BigInt(b)));
    fc.assert(
      fc.property(terminating, (x) => {
        const text = rationalToDecimalString(x);
        expect(text).not.toBeNull();
        expect(parsed(text!)).toEqual(x);
      }),
    );
  });

  it('agrees with exact rational arithmetic for generated binary expressions', () => {
    const ops = [
      ['+', addRational],
      ['-', subtractRational],
      ['*', multiplyRational],
      ['×', multiplyRational],
      ['/', divideRational],
      ['÷', divideRational],
    ] as const;
    fc.assert(
      fc.property(arbRational, arbRational, fc.constantFrom(...ops), (a, b, [symbol, apply]) => {
        fc.pre(!((symbol === '/' || symbol === '÷') && b.num === 0n));
        const text = `(${formatRational(a)}) ${symbol} (${formatRational(b)})`;
        expect(parsed(text)).toEqual(apply(a, b));
      }),
    );
  });

  it('never throws on arbitrary untrusted text (full Unicode)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 260 }), (text) => {
        const result = parseMathAnswer(text);
        if (!result.ok) expect(PARSE_ERROR_CODES).toContain(result.error.code);
      }),
      { numRuns: 500 },
    );
  });

  it('never throws on dense math-alphabet fuzz', () => {
    const alphabet = fc.constantFrom(
      ...'0123456789.,/+-*^() %'.split(''),
      '½',
      '¾',
      '²',
      '³',
      '⁻',
      '¹',
      '₂',
      '\u2044',
      '\u2215',
      '\u2212',
      '\u2013',
      '×',
      '÷',
      '·',
      '=',
    );
    fc.assert(
      fc.property(fc.array(alphabet, { maxLength: 60 }), (chars) => {
        const result = parseMathAnswer(chars.join(''));
        if (!result.ok) expect(PARSE_ERROR_CODES).toContain(result.error.code);
      }),
      { numRuns: 2000 },
    );
  });
});
