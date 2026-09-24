import { describe, expect, it } from 'vitest';
import { extractNumericMentions, canonicalize } from './index.ts';
import { numeric, scan } from './test-helpers.ts';

function flagged(content: string, value: string, alternates?: readonly string[]): boolean {
  const result = scan(content, numeric(value, alternates));
  return !result.safe && result.findings.some((f) => f.answerIndex === 0);
}

// Spec P6: "No original problem's final numeric value ... in hints." AC_GRADING_07.
describe('AC_GRADING_07 numeric detector: every representation of a withheld 1/2', () => {
  it.each([
    ['plain fraction', 'The answer is 1/2.'],
    ['decimal', 'It equals 0.5 when you divide.'],
    ['decimal with trailing zero', 'Write 0.50 in the box.'],
    ['leading-dot decimal', 'That is .5 of the strip.'],
    ['percent sign', 'You shaded 50% of it.'],
    ['percent word', 'That is fifty percent.'],
    ['equivalent fraction 2/4', 'Try 2/4.'],
    ['equivalent fraction 4/8', 'It matches 4/8.'],
    ['English words', 'It is one half.'],
    ['English article + denominator', 'Eat a half.'],
    ['hyphenated words', 'Color one-half.'],
    ['bare "half"', 'Shade half of the shape.'],
    ['Spanish "un medio"', 'La respuesta es un medio.'],
    ['Spanish "la mitad"', 'Es la mitad.'],
    ['Spanish percent words', 'Es cincuenta por ciento.'],
    ['LaTeX \\frac{2}{4}', 'Look: $\\frac{2}{4}$'],
    ['LaTeX \\dfrac{3}{6}', 'Look: \\dfrac{3}{6}'],
    ['LaTeX shorthand \\frac12', 'Look: \\frac12'],
    ['TeX \\over', 'Look: {1 \\over 2}'],
    ['unicode vulgar fraction', 'About \u00BD of it.'],
    ['superscript/subscript fraction', 'About \u00B9\u2044\u2082 of it.'],
    ['fullwidth digits', 'About \uFF11/\uFF12 of it.'],
    ['"a over b"', 'Think 1 over 2.'],
    ['"one over two"', 'Think one over two.'],
    ['"out of"', 'It is 1 out of 2.'],
    ['decimal words', 'It is zero point five.'],
    ['Spanish decimal comma', 'Es 0,5.'],
  ])('flags %s', (_label, content) => {
    expect(flagged(content, '1/2')).toBe(true);
  });
});

describe('AC_GRADING_07 numeric detector: other values and notations', () => {
  it.each([
    ['3/4', 'three fourths'],
    ['3/4', 'three quarters'],
    ['3/4', 'three-fourths'],
    ['3/4', 'tres cuartos'],
    ['3/4', 'seventy-five percent'],
    ['3/4', '3 fourths'],
    ['3/4', '75%'],
    ['3/4', '6/8'],
    ['3/4', '\u00BE'],
    ['25', 'twenty-five'],
    ['25', 'twenty five'],
    ['25', 'veinticinco'],
    ['25', '100/4'],
    ['25', '25.0'],
    ['1500', '1,500'],
    ['1500', '1.500 (Spanish thousands)'],
    ['1500', '1 500'],
    ['1500', 'one thousand five hundred'],
    ['1500', 'fifteen hundred'],
    ['1500', '1.5 thousand'],
    ['3 1/2', '3 1/2'],
    ['3 1/2', '3\u00BD'],
    ['3 1/2', '3-1/2'],
    ['3 1/2', 'three and a half'],
    ['3 1/2', 'tres y medio'],
    ['3 1/2', '3\\frac{1}{2}'],
    ['3 1/2', '3.5'],
    ['3 1/2', '7/2'],
    ['1/3', 'one third'],
    ['1/3', 'un tercio'],
    ['1/3', '2/6'],
    ['1/3', '0.333'],
    ['1/3', '0.33 (rounded)'],
    ['1/3', '33.3%'],
    ['1/3', '0.3...'],
    ['2000000', '2 million'],
    ['2000000', 'two million'],
    ['2000000', '2,000,000'],
    ['101', 'one hundred and one'],
    ['101', 'ciento uno'],
    ['0', 'zero'],
    ['0', 'cero'],
    ['32', 'treinta y dos'],
    ['11', 'La respuesta es once.'],
    ['12 cm', 'It is 12 centimeters long.'],
    ['$3.50', 'It costs 3.50.'],
    ['-5', 'It is 5 below zero.'],
    ['50%', 'The answer is 50.'],
    ['125', 'Read 521 backwards.'],
    ['125', 'Digits: 1.2.5'],
    ['125', 'Digits: 1 2 5'],
    ['42', 'It is forty-2.'],
    ['42', 'It has 4 tens and 2 ones.'],
    ['42', 'It has four tens and two ones.'],
    ['342', 'It has 3 hundreds, 4 tens and 2 ones.'],
    ['42', 'Tiene 4 decenas y 2 unidades.'],
  ])('answer %s is flagged in "%s"', (value, content) => {
    expect(flagged(content, value)).toBe(true);
  });

  it('protects numeric alternates, and treats a non-numeric alternate as a text target', () => {
    expect(flagged('It is 0.75.', '3/4', ['0.75'])).toBe(true);
    expect(flagged("That is a baker's dozen.", '13', ["a baker's dozen"])).toBe(true);
  });
});

// Safe cases: analogous examples and method explanations must still pass (AC_GRADING_07).
describe('AC_GRADING_07 numeric detector: safe method hints pass', () => {
  it.each([
    ['1/2', 'Try a different one: what is 1/3 of 9? Split 9 into 3 equal groups.'],
    ['1', 'Step 1: Find a common bottom number.'],
    ['3', '1. Read the problem.\n2. Draw a picture.\n3. Count the parts.'],
    ['42', 'Multiply the tens first, then add the ones.'],
    ['8', 'Here is a similar problem: 3 + 4 = 7. Use the same steps on yours.'],
    ['11', 'Once you line up the digits, add them.'],
    ['1/2', 'Cut the shape into equal parts and count them.'],
    ['9', 'Look at the second row.'],
    ['1/4', 'The fourth step is to check your work.'],
    ['20', 'Use a bar model to compare the two amounts.'],
    ['12', 'Count the eggs in each row, then add the rows.'],
    ['42', 'Regroup: 1 ten and 5 ones is the same as 15 ones.'],
    ['42', 'Count by tens, then look at the ones place.'],
  ])('answer %s: "%s" is safe', (value, content) => {
    const result = scan(content, numeric(value));
    expect(result.findings).toEqual([]);
    expect(result.safe).toBe(true);
  });

  it('regression: prototype property names in text are words, not table entries', () => {
    const content =
      'The constructor used tostring, valueof and hasownproperty; &constructor; &proto; ok.';
    expect(() => scan(content, numeric('42'))).not.toThrow();
    expect(scan(content, numeric('42')).findings).toEqual([]);
    expect(scan('constructor point constructor', numeric('42')).findings).toEqual([]);
  });

  it('only treats list markers as structural when numbered in sequence from the start', () => {
    // A lone "3." at line start is not a list; it is the withheld value.
    expect(flagged('3. Count the parts.', '3')).toBe(true);
    expect(flagged('Step 7: you are done.', '7')).toBe(true);
    // In-sentence numbers are never structural.
    expect(flagged('Go to step 1 and write 1.', '1')).toBe(true);
  });
});

describe('extractNumericMentions reads exact rationals', () => {
  function values(content: string): string[] {
    return extractNumericMentions(canonicalize(content)).map((m) =>
      m.value.den === 1n ? `${m.value.num}` : `${m.value.num}/${m.value.den}`,
    );
  }

  it('reads mixed numbers, words and percents as exact values', () => {
    expect(values('2 3/4')).toContain('11/4');
    expect(values('two and three quarters')).toContain('11/4');
    expect(values('12.5%')).toContain('1/8');
    expect(values('ninety-nine thousand nine hundred')).toContain('99900');
  });

  it('reads an expression value only when asked, through the safe parser (numbers stay data)', () => {
    // Default (answer keys, scan-process key parsing): component numbers only.
    expect(values('6 x 7')).not.toContain('42');
    expect(values('6 x 7')).toEqual(expect.arrayContaining(['6', '7']));
    // Opt-in (hints, examples): the value too, read by parseMathAnswer, never eval.
    const opted = extractNumericMentions(canonicalize('6 x 7'), { evaluateExpressions: true });
    expect(opted.map((m) => `${m.value.num}/${m.value.den}:${m.reading}`)).toEqual(
      expect.arrayContaining(['6/1:integer', '7/1:integer', '42/1:expression']),
    );
    expect(() =>
      extractNumericMentions(canonicalize('process.exit(1) + constructor(2)'), {
        evaluateExpressions: true,
      }),
    ).not.toThrow();
  });
});
