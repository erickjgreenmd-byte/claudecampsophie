import { describe, expect, it } from 'vitest';
import {
  checkDivisionWithRemainder,
  checkExactText,
  checkMultipleChoice,
  checkNumericAnswer,
  checkSpelling,
  equalsRational,
  GRADING_REASONS,
  gradeObjectiveQuestion,
  gradeWorksheet,
  parseMathAnswer,
  parseMathAnswerDetailed,
  parseQuantity,
  rational,
  type CheckResult,
  type NumericExpected,
} from './index.ts';

// Neighbouring cases for the fixes to the confirmed review findings (review.test.ts,
// RV-grading-1..7). Each block names the finding it extends. Synthetic worksheet content only.

const numeric = (studentAnswer: string, expected: NumericExpected): CheckResult =>
  checkNumericAnswer({ studentAnswer, expected });
const verdictOf = (studentAnswer: string, expected: NumericExpected): string =>
  `${numeric(studentAnswer, expected).verdict}/${numeric(studentAnswer, expected).reason}`;

describe('[RV-grading-1] neighbours: an unevaluated expression is never a deterministic "correct"', () => {
  it('numeric: any expression that evaluates to the key is unresolved', () => {
    for (const [answer, key] of [
      ['347 × 29', '10063'],
      ['12 + 7', '19'],
      ['37 ÷ 5', '7.4'],
      ['2 + 1/2', '5/2'],
      ['3²', '9'],
      ['(2 + 3) × 4', '20'],
    ] as const) {
      expect(numeric(answer, { value: key }), answer).toEqual({
        verdict: 'unresolved',
        reason: 'UNEVALUATED_EXPRESSION',
      });
    }
  });

  it('numeric: an expression with the wrong value is also left to a model or a grown-up', () => {
    expect(numeric('347 × 28', { value: '10063' })).toEqual({
      verdict: 'unresolved',
      reason: 'UNEVALUATED_EXPRESSION',
    });
  });

  it('requireSimplestForm keeps its approved NOT_SIMPLIFIED / VALUE_MISMATCH verdicts', () => {
    expect(numeric('347 × 29', { value: '10063', requireSimplestForm: true })).toEqual({
      verdict: 'incorrect',
      reason: 'NOT_SIMPLIFIED',
    });
    expect(numeric('347 × 28', { value: '10063', requireSimplestForm: true })).toEqual({
      verdict: 'incorrect',
      reason: 'VALUE_MISMATCH',
    });
  });

  it('quantities: an expression before the unit is unresolved', () => {
    expect(numeric('2 × 3 m', { value: '6', unit: 'm' })).toEqual({
      verdict: 'unresolved',
      reason: 'UNEVALUATED_EXPRESSION',
    });
  });

  it('single numbers in every written form are still graded', () => {
    const correct = (answer: string, key: string) =>
      expect(numeric(answer, { value: key }), answer).toEqual({
        verdict: 'correct',
        reason: 'EXACT_MATCH',
      });
    correct('10063', '10063');
    correct('10,063', '10063');
    correct('2 1/2', '5/2');
    correct('2½', '5/2');
    correct('5/2', '2.5');
    correct('-5/2', '-2.5');
    correct('(−3)', '-3');
    correct('50%', '0.5');
    correct('½%', '0.005');
    correct('(1/2)%', '0.005');
  });

  it('division: the problem restated is unresolved on the quotient and remainder paths too', () => {
    const unevaluated = { verdict: 'unresolved', reason: 'UNEVALUATED_EXPRESSION' };
    expect(checkDivisionWithRemainder('35 ÷ 5', { quotient: 7, remainder: 0 })).toEqual(
      unevaluated,
    );
    expect(checkDivisionWithRemainder('3+4 R 2', { quotient: 7, remainder: 2 })).toEqual(
      unevaluated,
    );
    expect(checkDivisionWithRemainder('7 R 4-2', { quotient: 7, remainder: 2 })).toEqual(
      unevaluated,
    );
    // Approved alternative methods are unchanged.
    expect(checkDivisionWithRemainder('7 2/5', { quotient: 7, remainder: 2, divisor: 5 })).toEqual({
      verdict: 'correct',
      reason: 'EQUIVALENT_VALUE',
    });
    expect(checkDivisionWithRemainder('7.4', { quotient: 7, remainder: 2, divisor: 5 })).toEqual({
      verdict: 'correct',
      reason: 'EQUIVALENT_VALUE',
    });
  });

  it('the new reason codes are in the exported stable list', () => {
    expect(GRADING_REASONS).toContain('UNEVALUATED_EXPRESSION');
    expect(GRADING_REASONS).toContain('AMBIGUOUS_UNIT');
  });
});

describe('[RV-grading-2] neighbours: a percent sign after a division', () => {
  it('a written fraction percent is a percent of the whole fraction', () => {
    const cases: [string, bigint, bigint][] = [
      ['1/2%', 1n, 200n],
      ['3/4%', 3n, 400n],
      ['-1/2%', -1n, 200n],
      ['−1/2%', -1n, 200n],
      ['1/(2%)', 50n, 1n],
    ];
    for (const [text, num, den] of cases) {
      const parsed = parseMathAnswer(text);
      expect(parsed.ok && equalsRational(parsed.value, rational(num, den)), text).toBe(true);
    }
  });

  it('is a single percent value for simplest-form purposes', () => {
    const reduced = parseMathAnswerDetailed('1/2%');
    expect(reduced.ok && reduced.value.form).toEqual({ kind: 'percent', reduced: true });
    const unreduced = parseMathAnswerDetailed('2/4%');
    expect(unreduced.ok && unreduced.value.form).toEqual({ kind: 'percent', reduced: false });
  });

  it('a percent sign after any other division is ambiguous, never guessed', () => {
    for (const text of ['6 ÷ 2%', '1.5/2%', '3 × 1/2%', '1/(2)%', '2 1/2%']) {
      const parsed = parseMathAnswer(text);
      expect(parsed.ok ? 'ok' : parsed.error.code, text).toBe('AMBIGUOUS_FORMAT');
    }
  });

  it('percent notation stays rejected where the quantity layer owns "%"', () => {
    const parsed = parseMathAnswer('1/2%', { percent: 'reject' });
    expect(parsed.ok ? 'ok' : parsed.error.code).toBe('UNSUPPORTED_EXPRESSION');
  });

  it('agrees with the unit-encoded key', () => {
    expect(numeric('1/2%', { value: '0.5', unit: '%' })).toEqual({
      verdict: 'correct',
      reason: 'EXACT_MATCH',
    });
    expect(numeric('1/2%', { value: '1/2%' })).toEqual({
      verdict: 'correct',
      reason: 'EXACT_MATCH',
    });
  });
});

describe('[RV-grading-3] neighbours: a key written as "N%" behaves like { value: N, unit: "%" }', () => {
  const encodings: [string, NumericExpected, NumericExpected][] = [
    ['25%', { value: '25%' }, { value: '25', unit: '%' }],
    ['12.5%', { value: '12.5%' }, { value: '12.5', unit: '%' }],
  ];

  it('gives the same verdict for every answer whichever way the key is encoded', () => {
    for (const [label, valueEncoded, unitEncoded] of encodings) {
      for (const answer of ['25', '25%', '0.25', '1/4', '12.5', '12.5%', '0.125', '30', '25 cm']) {
        expect(verdictOf(answer, valueEncoded), `${label} <- ${answer}`).toBe(
          verdictOf(answer, unitEncoded),
        );
      }
    }
  });

  it('rounding and tolerance apply in percent, the unit the key is written in', () => {
    // Before the fix this rounded the ratio 0.333333 to 0.3 and marked "33.3%" NOT_ROUNDED.
    expect(
      numeric('33.3%', {
        value: '33.3333%',
        tolerance: { kind: 'round_to_places', places: 1 },
      }),
    ).toEqual({ verdict: 'correct', reason: 'EXACT_MATCH' });
    expect(
      numeric('33%', { value: '33.3333%', tolerance: { kind: 'absolute', value: '0.5' } }),
    ).toEqual({ verdict: 'correct', reason: 'WITHIN_TOLERANCE' });
  });

  it('a key that writes "%" in both the value and the unit is still 25 percent', () => {
    expect(numeric('25%', { value: '25%', unit: '%' })).toEqual({
      verdict: 'correct',
      reason: 'EXACT_MATCH',
    });
    expect(numeric('25%', { value: '25%', unit: 'percent' })).toEqual({
      verdict: 'correct',
      reason: 'EXACT_MATCH',
    });
  });

  it('a percent value with a non-percent unit is an invalid key, not a guess', () => {
    expect(numeric('25', { value: '25%', unit: 'cm' })).toEqual({
      verdict: 'unresolved',
      reason: 'INVALID_ANSWER_KEY',
    });
  });

  it('keys without a percent sign are unchanged', () => {
    expect(numeric('50%', { value: '0.5' })).toEqual({ verdict: 'correct', reason: 'EXACT_MATCH' });
    expect(numeric('0.5', { value: '0.5' })).toEqual({ verdict: 'correct', reason: 'EXACT_MATCH' });
    expect(numeric('50%', { value: '50' })).toEqual({
      verdict: 'unresolved',
      reason: 'AMBIGUOUS_PERCENT',
    });
  });
});

describe('[RV-grading-4] neighbours: hyphenated mixed numbers', () => {
  it('every hyphen/minus + fraction glyph spelling is ambiguous', () => {
    for (const text of ['2-½', '2-¹⁄₂', '2−½', '2−1/2', '12-¾', '-2-½']) {
      const parsed = parseMathAnswer(text);
      expect(parsed.ok ? 'ok' : parsed.error.code, text).toBe('AMBIGUOUS_FORMAT');
    }
  });

  it('in a quantity it is unresolved, never incorrect', () => {
    for (const answer of ['2-½ in', '2-1/2 in', '2-¹⁄₂ ft']) {
      expect(numeric(answer, { value: '2.5', unit: 'in' }).verdict, answer).toBe('unresolved');
    }
  });

  it('a spaced subtraction is an expression (unresolved), and plain subtraction still parses', () => {
    expect(numeric('2 - ½', { value: '5/2' })).toEqual({
      verdict: 'unresolved',
      reason: 'UNEVALUATED_EXPRESSION',
    });
    const difference = parseMathAnswer('3-2');
    expect(difference.ok && equalsRational(difference.value, rational(1n))).toBe(true);
    const halves = parseMathAnswer('½-¼');
    expect(halves.ok && equalsRational(halves.value, rational(1n, 4n))).toBe(true);
  });
});

describe('[RV-grading-5] neighbours: ounces in capacity and weight work', () => {
  it('a bare "oz" is a fluid ounce only against a capacity key', () => {
    expect(numeric('8 ounces', { value: '1', unit: 'cup' })).toEqual({
      verdict: 'correct',
      reason: 'EQUIVALENT_UNIT',
    });
    expect(numeric('16 oz', { value: '1', unit: 'pt' })).toEqual({
      verdict: 'correct',
      reason: 'EQUIVALENT_UNIT',
    });
    expect(numeric('1 cup 2 oz', { value: '10', unit: 'fl oz' })).toEqual({
      verdict: 'correct',
      reason: 'EXACT_MATCH',
    });
    expect(numeric('9 oz', { value: '1', unit: 'cup' })).toEqual({
      verdict: 'incorrect',
      reason: 'VALUE_MISMATCH',
    });
  });

  it('weight answers are still weights', () => {
    expect(numeric('16 oz', { value: '1', unit: 'lb' })).toEqual({
      verdict: 'correct',
      reason: 'EQUIVALENT_UNIT',
    });
    // "1 lb 4 oz" is a weight even against a capacity key.
    expect(numeric('1 lb 4 oz', { value: '20', unit: 'fl oz' })).toEqual({
      verdict: 'incorrect',
      reason: 'WRONG_UNIT_DIMENSION',
    });
    expect(numeric('3 kg', { value: '1', unit: 'cup' })).toEqual({
      verdict: 'incorrect',
      reason: 'WRONG_UNIT_DIMENSION',
    });
    const parsed = parseQuantity('8 oz');
    expect(parsed.ok && parsed.value.dimension).toBe('mass');
  });

  it('a key in bare "oz" answered with a capacity is unresolved, not wrong dimension', () => {
    for (const answer of ['8 fl oz', '1 cup']) {
      expect(numeric(answer, { value: '8', unit: 'oz' }), answer).toEqual({
        verdict: 'unresolved',
        reason: 'AMBIGUOUS_UNIT',
      });
    }
    expect(numeric('3 m', { value: '8', unit: 'oz' })).toEqual({
      verdict: 'incorrect',
      reason: 'WRONG_UNIT_DIMENSION',
    });
  });
});

describe('[RV-grading-6] neighbours: worksheet capture flags', () => {
  it('reports every need across items, whatever reason decides each verdict', () => {
    const result = gradeWorksheet([
      {
        questionId: 'a',
        page: 1,
        label: '1',
        question: {
          kind: 'exact_text',
          studentAnswer: 'Sam',
          expected: { accepted: ['Sam'] },
          captureIssues: ['missing_passage', 'glare', 'answer_source_uncertain'],
        },
      },
      {
        questionId: 'b',
        page: 1,
        label: '2',
        question: { kind: 'numeric', studentAnswer: '4', expected: { value: '4' } },
      },
    ]);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.results.map((r) => r.reason)).toEqual(['NEEDS_RESCAN', 'EXACT_MATCH']);
    expect(result.value.needsRescan).toBe(true);
    expect(result.value.needsSourcePassage).toBe(true);
  });

  it('an item with no capture issues raises neither flag', () => {
    const result = gradeWorksheet([
      {
        questionId: 'a',
        page: 1,
        label: '1',
        question: { kind: 'numeric', studentAnswer: '4', expected: { value: '4' } },
      },
    ]);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.needsRescan).toBe(false);
    expect(result.value.needsSourcePassage).toBe(false);
  });
});

describe('[RV-grading-7] neighbours: nullable or malformed key fields', () => {
  it('null optional fields mean "absent"', () => {
    const nullable = <T>(value: object) => value as unknown as T;
    expect(numeric('5', nullable({ value: '5', unit: null, tolerance: null }))).toEqual({
      verdict: 'correct',
      reason: 'EXACT_MATCH',
    });
    expect(
      checkDivisionWithRemainder('7 R 2', nullable({ quotient: 7, remainder: 2, divisor: null })),
    ).toEqual({ verdict: 'correct', reason: 'EXACT_MATCH' });
    expect(
      checkDivisionWithRemainder('7.4', nullable({ quotient: 7, remainder: 2, divisor: null })),
    ).toEqual({ verdict: 'unresolved', reason: 'NEEDS_DIVISOR' });
    expect(
      gradeObjectiveQuestion(
        nullable({
          kind: 'multiple_choice',
          studentAnswer: 'B',
          expected: { letters: ['B'], validLetters: null },
        }),
      ),
    ).toEqual({ verdict: 'correct', reason: 'EXACT_MATCH' });
    expect(
      gradeObjectiveQuestion(
        nullable({
          kind: 'numeric',
          studentAnswer: '5',
          expected: { value: '5' },
          captureIssues: null,
        }),
      ),
    ).toEqual({ verdict: 'correct', reason: 'EXACT_MATCH' });
    expect(checkSpelling('color', nullable({ target: 'color', acceptedVariants: null }))).toEqual({
      verdict: 'correct',
      reason: 'EXACT_MATCH',
    });
  });

  it('wrongly typed key fields are INVALID_ANSWER_KEY, never a crash', () => {
    const invalid = { verdict: 'unresolved', reason: 'INVALID_ANSWER_KEY' };
    const keys: unknown[] = [
      null,
      { value: '5', unit: 5 },
      { value: '5', tolerance: 'exact' },
      { value: '5', tolerance: { kind: 'absolute', value: 0.5 } },
      { value: '5', tolerance: { kind: 'round_to_places', places: '1' } },
      { value: '5', tolerance: { kind: 'nearest' } },
    ];
    for (const expected of keys) {
      expect(numeric('5', expected as NumericExpected), JSON.stringify(expected)).toEqual(invalid);
    }
    expect(checkDivisionWithRemainder('7 R 2', null as never)).toEqual(invalid);
    expect(checkMultipleChoice('B', null as never)).toEqual(invalid);
    expect(checkMultipleChoice('B', [2] as never)).toEqual(invalid);
    expect(checkMultipleChoice('B', ['B'], { validLetters: 7 as never })).toEqual(invalid);
    expect(checkSpelling('color', { target: null as never })).toEqual(invalid);
    expect(
      checkSpelling('color', { target: 'color', acceptedVariants: 'colour' as never }),
    ).toEqual(invalid);
    expect(checkExactText('Paris', { accepted: null as never })).toEqual(invalid);
  });

  it('a captureIssues value that is not a list fails closed to a rescan', () => {
    expect(
      gradeObjectiveQuestion({
        kind: 'numeric',
        studentAnswer: '5',
        expected: { value: '5' },
        captureIssues: 'blur' as never,
      }),
    ).toEqual({ verdict: 'unresolved', reason: 'NEEDS_RESCAN' });
  });

  it('one malformed key does not stop the rest of the worksheet from being graded', () => {
    const result = gradeWorksheet([
      {
        questionId: 'a',
        page: 1,
        label: '1',
        question: {
          kind: 'numeric',
          studentAnswer: '5',
          expected: { value: '5', tolerance: { kind: 'absolute', value: 0.5 } } as never,
        },
      },
      {
        questionId: 'b',
        page: 1,
        label: '2',
        question: { kind: 'numeric', studentAnswer: '3/4', expected: { value: '0.75' } },
      },
    ]);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.results.map((r) => `${r.verdict}/${r.reason}`)).toEqual([
      'unresolved/INVALID_ANSWER_KEY',
      'correct/EXACT_MATCH',
    ]);
  });
});
