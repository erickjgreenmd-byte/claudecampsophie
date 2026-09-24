import { describe, expect, it } from 'vitest';
import {
  checkDivisionWithRemainder,
  checkNumericAnswer,
  equalsRational,
  gradeWorksheet,
  parseMathAnswer,
  parseQuantity,
  rational,
  resolveGrading,
  type NumericExpected,
} from './index.ts';

// Independent adversarial review of the grading module (spec P5/P6, AC_GRADING_01..04,
// AC_CAPTURE_03/04). Each [RV-grading-n] test is a regression for a confirmed defect and fails
// against the implementation it was written for. Synthetic worksheet content only.

describe('grading review: confirmed defects', () => {
  it('[RV-grading-1] restating the problem as an unevaluated expression is not graded correct', () => {
    // P5: deterministic checks decide acceptance, and resolveGrading makes a deterministic
    // "correct" final even against models. A child who copies "347 × 29" as the answer to
    // "347 × 29 = ?" has not answered the question, so this must not be a deterministic "correct".
    const copied = checkNumericAnswer({ studentAnswer: '347 × 29', expected: { value: '10063' } });
    expect(copied.verdict).not.toBe('correct');

    // Same false-right on the division checker's "alternative valid method" path.
    const division = checkDivisionWithRemainder('37 ÷ 5', {
      quotient: 7,
      remainder: 2,
      divisor: 5,
    });
    expect(division.verdict).not.toBe('correct');
  });

  it('[RV-grading-2] "1/2%" is not silently read as 1 ÷ 2% = 50', () => {
    // "½%", "(1/2)%" and parseQuantity("1/2%") all mean one half percent (1/200); the bare
    // parser alone reads "1/2%" as 50. Ambiguity must be unresolved, never "incorrect".
    const quantity = parseQuantity('1/2%');
    expect(quantity.ok && quantity.value.unit === 'percent').toBe(true);
    expect(quantity.ok && equalsRational(quantity.value.value, rational(1n, 2n))).toBe(true);

    const parsed = parseMathAnswer('1/2%');
    expect(parsed.ok && equalsRational(parsed.value, rational(50n))).toBe(false);

    expect(
      checkNumericAnswer({ studentAnswer: '1/2%', expected: { value: '0.005' } }).verdict,
    ).not.toBe('incorrect');
    // Key written the same way: a correct "0.5%" must not be marked wrong.
    expect(
      checkNumericAnswer({ studentAnswer: '0.5%', expected: { value: '1/2%' } }).verdict,
    ).not.toBe('incorrect');
  });

  it('[RV-grading-3] a bare number for a percent key is not incorrect just because the key embeds "%"', () => {
    // With the key encoded as { value: "25", unit: "%" } a bare "25" is read in the key's unit
    // and is correct. The same item encoded as { value: "25%" } marks it incorrect.
    const unitEncoded = checkNumericAnswer({
      studentAnswer: '25',
      expected: { value: '25', unit: '%' },
    });
    expect(unitEncoded).toEqual({ verdict: 'correct', reason: 'EXACT_MATCH' });

    const valueEncoded = checkNumericAnswer({ studentAnswer: '25', expected: { value: '25%' } });
    expect(valueEncoded.verdict).not.toBe('incorrect');
  });

  it('[RV-grading-4] a hyphenated mixed number with a fraction glyph ("2-½") is not guessed as 3/2', () => {
    // "2-1/2" is AMBIGUOUS_FORMAT by the module's own rule (mixed number 5/2 vs 2 − 1/2 = 3/2).
    // "2-½" and "2-¹⁄₂" have exactly the same two readings.
    expect(checkNumericAnswer({ studentAnswer: '2-1/2', expected: { value: '5/2' } })).toEqual({
      verdict: 'unresolved',
      reason: 'AMBIGUOUS_FORMAT',
    });
    for (const studentAnswer of ['2-½', '2-¹⁄₂']) {
      expect(
        checkNumericAnswer({ studentAnswer, expected: { value: '5/2' } }).verdict,
        studentAnswer,
      ).not.toBe('incorrect');
    }
    // Hardware/measurement notation: "2-½ in" is two and a half inches.
    expect(
      checkNumericAnswer({ studentAnswer: '2-½ in', expected: { value: '2.5', unit: 'in' } })
        .verdict,
    ).not.toBe('incorrect');
  });

  it('[RV-grading-5] "oz" written for a liquid-volume key is not marked wrong dimension', () => {
    // In US customary usage "oz" for a capacity is a fluid ounce ("1 cup = 8 oz"). The checker
    // hard-maps "oz" to mass, so a correct "8 oz" for "1 cup" is incorrect WRONG_UNIT_DIMENSION.
    expect(
      checkNumericAnswer({ studentAnswer: '8 oz', expected: { value: '1', unit: 'cup' } }).verdict,
    ).not.toBe('incorrect');
    expect(
      checkNumericAnswer({ studentAnswer: '8 oz', expected: { value: '8', unit: 'fl oz' } })
        .verdict,
    ).not.toBe('incorrect');
  });

  it('[RV-grading-6] a missing passage is still reported when the same item also needs a rescan', () => {
    // WorksheetGrading.needsSourcePassage: "At least one item depends on a passage/study guide
    // that was not provided." Spec P5: require a source passage when an answer depends on it.
    const result = gradeWorksheet([
      {
        questionId: 'r-1',
        page: 1,
        label: '1',
        question: {
          kind: 'open_response',
          studentAnswer: 'The fox was hungry.',
          captureIssues: ['blur', 'missing_passage'],
        },
      },
    ]);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.needsRescan).toBe(true);
    expect(result.value.needsSourcePassage).toBe(true);
  });

  it('[RV-grading-7] nullable-optional answer-key fields are data, not a crash', () => {
    // Model outputs model optional fields as null (strict structured outputs), and checks.ts
    // promises "a malformed key is data, not a crash". These keys currently throw TypeError,
    // which also aborts gradeWorksheet for the whole submission.
    const keys = [
      { value: '5', unit: null },
      { value: '5', tolerance: null },
      { value: '5', tolerance: { kind: 'absolute', value: 0.5 } },
    ] as unknown as NumericExpected[];
    for (const expected of keys) {
      expect(
        () => checkNumericAnswer({ studentAnswer: '5', expected }),
        JSON.stringify(expected),
      ).not.toThrow();
    }
    expect(() =>
      gradeWorksheet([
        {
          questionId: 'q-1',
          page: 1,
          label: '1',
          question: { kind: 'numeric', studentAnswer: '5', expected: keys[0]! },
        },
      ]),
    ).not.toThrow();
  });
});

describe('grading review: risky behavior verified sound (passing guards)', () => {
  it('fraction glyph and parenthesized percent are both one half percent', () => {
    for (const text of ['½%', '(1/2)%']) {
      const parsed = parseMathAnswer(text);
      expect(parsed.ok && equalsRational(parsed.value, rational(1n, 200n)), text).toBe(true);
    }
  });

  it('en dash between values and a leading em dash stay ambiguous', () => {
    for (const text of ['2–½', '(–3)', '—5']) {
      const parsed = parseMathAnswer(text);
      expect(parsed.ok ? 'ok' : parsed.error.code, text).toBe('AMBIGUOUS_FORMAT');
    }
  });

  it('hostile budget inputs fail with typed codes', () => {
    const cases: [string, string][] = [
      ['2⁹⁹⁹⁹⁹⁹⁹⁹⁹⁹⁹⁹⁹⁹⁹⁹⁹⁹⁹⁹', 'EXPONENT_OUT_OF_RANGE'],
      [`0.${'0'.repeat(120)}1`, 'RESULT_TOO_LARGE'],
      ['(10^9)^12', 'RESULT_TOO_LARGE'],
      ['¹⁄₀', 'DIVISION_BY_ZERO'],
      ['2¹⁄₀', 'DIVISION_BY_ZERO'],
    ];
    for (const [text, code] of cases) {
      const parsed = parseMathAnswer(text);
      expect(parsed.ok ? 'ok' : parsed.error.code, text).toBe(code);
    }
  });

  it('exact customary conversions hold (in, lb, gal, cm³)', () => {
    expect(
      checkNumericAnswer({ studentAnswer: '1 mi', expected: { value: '160934.4', unit: 'cm' } }),
    ).toEqual({ verdict: 'correct', reason: 'EQUIVALENT_UNIT' });
    expect(
      checkNumericAnswer({ studentAnswer: '1 gal', expected: { value: '128', unit: 'fl oz' } }),
    ).toEqual({ verdict: 'correct', reason: 'EQUIVALENT_UNIT' });
    expect(
      checkNumericAnswer({ studentAnswer: '1000 cm³', expected: { value: '1', unit: 'L' } }),
    ).toEqual({ verdict: 'correct', reason: 'EQUIVALENT_UNIT' });
    expect(
      checkNumericAnswer({ studentAnswer: '1 kg', expected: { value: '1000000', unit: 'mg' } }),
    ).toEqual({ verdict: 'correct', reason: 'EQUIVALENT_UNIT' });
  });

  it('round half away from zero is symmetric for negative keys', () => {
    const tolerance = { kind: 'round_to_places', places: 1 } as const;
    expect(
      checkNumericAnswer({ studentAnswer: '-2.5', expected: { value: '-2.45', tolerance } }),
    ).toEqual({ verdict: 'correct', reason: 'EXACT_MATCH' });
  });

  it('an escalation corroborating neither side goes to a grown-up, not "incorrect"', () => {
    expect(
      resolveGrading({
        primary: { verdict: 'correct', confidence: 0.99 },
        verifier: { verdict: 'unresolved', confidence: 0.99 },
        escalation: { verdict: 'incorrect' },
        escalationBudgetRemaining: 0,
      }).final,
    ).toBe('needs_parent_review');
  });
});
