// Arithmetic expressions that evaluate to a protected answer (spec P6: "No original problem's final
// numeric value ... in hints"; E4 "Answer protection"; AC_GRADING_07/08 analogous examples).
// Regression for the capture-grading coverage note: the guard documented that "6 × 7" was never
// evaluated, so a hint "the answer is 6 × 7" released 42. Synthetic data only.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  analogousExampleIsSafe,
  canonicalize,
  extractNumericMentions,
  guardChildContent,
  scanChildPacket,
  scanForLeaks,
  type LeakScanResult,
  type ProtectedAnswer,
} from './index.ts';
import { base64, numeric, spelling } from './test-helpers.ts';

const EVALUATE = { evaluateExpressions: true } as const;

function scanExpr(content: string, answer: ProtectedAnswer): LeakScanResult {
  return scanForLeaks(content, [answer], EVALUATE);
}

/** True when an expression reading (not a literal) matched the protected answer. */
function expressionLeak(content: string, value: string): boolean {
  return scanExpr(content, numeric(value)).findings.some(
    (f) => f.answerIndex === 0 && /expression/u.test(f.technique),
  );
}

function techniques(content: string, value: string): string[] {
  return scanExpr(content, numeric(value)).findings.map((f) => `${f.detector}:${f.technique}`);
}

describe('[capture-grading] arithmetic expressions disclose their value (P6, E4)', () => {
  it('regression: "the answer is 6 × 7" is a leak of 42', () => {
    const result = scanExpr('The answer is 6 × 7.', numeric('42'));
    expect(result.safe).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ detector: 'numeric', answerIndex: 0, technique: 'expression' }),
    );
  });

  it.each([
    ['42', 'Think about 6 x 7.'],
    ['42', 'Think about 6x7.'],
    ['42', 'Think about 6 * 7.'],
    ['42', 'Think about 6 · 7.'],
    ['42', 'Think about 6 ⋅ 7.'],
    ['42', 'Think about 6 ✕ 7.'],
    ['42', 'Think about ６＊７.'],
    ['42', 'Think about 6 times 7.'],
    ['42', 'Think about six times seven.'],
    ['42', 'Think about 6 multiplied by 7.'],
    ['42', 'Piensa en 6 por 7.'],
    ['42', 'Piensa en seis por siete.'],
    ['42', 'Look: $6 \\times 7$'],
    ['42', 'Look: $6 \\cdot 7$'],
    ['42', 'Look: <math><mn>6</mn><mo>&times;</mo><mn>7</mn></math>'],
    ['13', 'Try 6 + 7.'],
    ['13', 'Try six plus seven.'],
    ['13', 'Prueba 6 mas 7.'],
    ['13', 'Prueba 6 más 7.'],
    ['5', 'Try 12 - 7.'],
    ['5', 'Try 12 − 7.'],
    ['5', 'Try 12 minus 7.'],
    ['5', 'Prueba 12 menos 7.'],
    ['6', 'Try 42 ÷ 7.'],
    ['6', 'Try 42 divided by 7.'],
    ['6', 'Try forty-two divided by seven.'],
    ['6', 'Prueba 42 dividido entre 7.'],
    ['6', 'Prueba 42 entre 7.'],
    ['6', 'Look: $42 \\div 7$'],
    ['14', 'Work out (3 + 4) × 2.'],
    ['14', 'Work out 2 × (3 + 4).'],
    ['14', 'Work out 2 + 3 × 4.'],
    ['21', 'Work out ((1 + 2) × 3 + 4) + 8.'],
    ['8', 'Work out 2^3.'],
    ['8', 'Work out 2 to the power of 3.'],
    ['25', 'Work out 5 squared.'],
    ['1/3', 'Share 1 ÷ 3 of it.'],
    ['1', 'Add 3/4 + 1/4.'],
    ['3/4', 'Add 0.5 + 0.25.'],
    ['3', 'Add 2 1/2 + 1/2.'],
    ['3', 'Add 2½ + ½.'],
    ['3', 'Suma 1,5 + 1,5.'],
    ['2000', 'Add 1,500 + 500.'],
    ['7/2', 'Add three and a half times one.'],
    ['1/2', 'Add 25% + 25%.'],
    ['2', 'Start at -3 + 5.'],
    ['24', 'Start at 3 × -8.'],
  ])('answer %s: "%s" is flagged as an expression', (value, content) => {
    expect(expressionLeak(content, value)).toBe(true);
    expect(scanExpr(content, numeric(value)).safe).toBe(false);
  });

  it('is exact rational arithmetic with standard precedence, never a guess', () => {
    // 2 + 3 × 4 is 14, not 20; the literals 2, 3, 4 are still read on their own.
    expect(expressionLeak('Work out 2 + 3 × 4.', '20')).toBe(false);
    expect(scanExpr('Work out 2 + 3 × 4.', numeric('20')).safe).toBe(true);
    // 0.1 + 0.2 is exactly 3/10 (no floating point).
    expect(expressionLeak('Add 0.1 + 0.2.', '0.3')).toBe(true);
    expect(expressionLeak('Add 0.1 + 0.2.', '0.30000000000000004')).toBe(false);
    // Comparison stays sign-insensitive: 3 - 8 discloses 5.
    expect(expressionLeak('Try 3 - 8.', '5')).toBe(true);
    // A leading sign glued to the number is part of the expression: -3 + 5 is 2, not 8.
    expect(expressionLeak('Start at -3 + 5.', '8')).toBe(false);
  });

  it('an expression that rounds to a protected decimal is a leak', () => {
    expect(techniques('Share 1 ÷ 3 of it.', '0.33')).toContain('numeric:rounded');
  });

  it('the literal readings of an expression are still reported', () => {
    // "6 × 7" also mentions 6 and 7 (existing behaviour, unchanged).
    expect(scanExpr('Try 6 × 7.', numeric('7')).safe).toBe(false);
  });

  it('decoded content is evaluated too (encodings, markup)', () => {
    expect(expressionLeak(`Code: ${base64('The answer is 6 x 7')}`, '42')).toBe(true);
    expect(expressionLeak('<b>6</b> &times; <b>7</b>', '42')).toBe(true);
  });

  it('a split across hint steps is caught by the joined-packet scan', () => {
    const packet = { steps: ['Multiply 6 ×', '7 and check.'] };
    const result = scanChildPacket(packet, [numeric('42')], EVALUATE);
    expect(result.safe).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ technique: 'expression', location: 'combined' }),
    );
  });

  it('property: a×b, a+b, a−b and (a×b)÷b disclose their exact value', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 999 }),
        fc.integer({ min: 2, max: 999 }),
        fc.constantFrom('×', '+', '-', 'times', 'plus', 'minus'),
        (a, b, op) => {
          const value =
            op === '×' || op === 'times' ? a * b : op === '+' || op === 'plus' ? a + b : a - b;
          fc.pre(value !== a && value !== b && value !== -a && value !== -b);
          const content = `Hint: work out ${a} ${op} ${b} first.`;
          expect(scanExpr(content, numeric(String(value))).safe).toBe(false);
          expect(scanExpr(`Hint: ${a * b} ÷ ${b}`, numeric(String(a))).safe).toBe(false);
        },
      ),
    );
  });
});

describe('[capture-grading] a hint that restates the problem (documented fail-closed behaviour)', () => {
  it('"look again at 6 × 7" is blocked when, and only when, its value is protected', () => {
    const hint = { steps: ['Look again at 6 × 7. Count 6 groups of 7.'] };
    const blocked = guardChildContent({
      packet: hint,
      answers: [numeric('42')],
      options: EVALUATE,
    });
    expect(blocked.decision).toBe('block');
    expect(blocked.reasons).toContainEqual(
      expect.objectContaining({ code: 'LEAK_DETECTED', detector: 'numeric', answerIndex: 0 }),
    );
    // The same restatement with a different protected answer is released.
    expect(
      guardChildContent({ packet: hint, answers: [numeric('43')], options: EVALUATE }),
    ).toEqual({ decision: 'release', reasons: [] });
  });

  it('evaluation is on by default; only a problem statement opts out explicitly', () => {
    // Lead decision (integration of this slice): fail closed for every child-facing caller,
    // present and future. Bank prompts ("What is 6 × 7?") necessarily restate their own problem,
    // so the bank's self-check (bank/validate.ts) passes evaluateExpressions: false explicitly.
    const prompt = { text: 'What is 6 × 7?' };
    expect(guardChildContent({ packet: prompt, answers: [numeric('42')] }).decision).toBe('block');
    expect(scanForLeaks('What is 6 × 7?', [numeric('42')]).safe).toBe(false);
    expect(
      guardChildContent({ packet: prompt, answers: [numeric('42')], options: EVALUATE }).decision,
    ).toBe('block');
    const statement = { evaluateExpressions: false } as const;
    expect(
      guardChildContent({ packet: prompt, answers: [numeric('42')], options: statement }).decision,
    ).toBe('release');
    expect(scanForLeaks('What is 6 × 7?', [numeric('42')], statement).safe).toBe(true);
  });

  it('analogous worked examples are always evaluated (P6 "does not reveal the target answer")', () => {
    expect(
      analogousExampleIsSafe({
        exampleText: 'Here is one like it: 6 × 7 = ?',
        answers: [numeric('42')],
      }),
    ).toBe(false);
    expect(
      analogousExampleIsSafe({
        exampleText: 'Here is one like it: 5 × 8 = 40.',
        answers: [numeric('42')],
      }),
    ).toBe(true);
  });
});

describe('[capture-grading] fail closed on expressions the evaluator cannot bound', () => {
  it.each([
    ['huge exponent', 'Think of 10^100.'],
    ['exponent past the bound', 'Think of 2^13.'],
    ['result past 100 digits', `Think of ${'9'.repeat(30)} × ${'9'.repeat(30)} ^ 3.`],
    ['too many operands', `Add ${Array.from({ length: 30 }, (_, i) => i + 2).join(' + ')}.`],
  ])('%s is an expression_unbounded finding (LIMIT_EXCEEDED)', (_label, content) => {
    const result = scanExpr(content, numeric('17'));
    expect(result.safe).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ detector: 'fail_closed', technique: 'expression_unbounded' }),
    );
    const decision = guardChildContent({
      packet: { hint: content },
      answers: [numeric('17')],
      options: EVALUATE,
    });
    expect(decision.decision).toBe('block');
    expect(decision.reasons.map((r) => r.code)).toContain('LIMIT_EXCEEDED');
  });

  it('an expression with two readings is not guessed ("2^3^2", "-2^2")', () => {
    expect(techniques('Think of 2^3^2.', '17')).toContain('fail_closed:expression_unevaluable');
    expect(techniques('Think of -2^2.', '17')).toContain('fail_closed:expression_unevaluable');
  });

  it('a percent after a division is read both ways, not failed closed ("15%/30%", "1/2%")', () => {
    expect(techniques('Compare 15%/30% of it.', '17')).toEqual([]);
    expect(expressionLeak('Compare 15%/30% of it.', '1/2')).toBe(true);
    expect(expressionLeak('Alerts at 50/80/100% of the cap.', '5/8')).toBe(true);
    // "1/2%": half a percent (the grading parser's reading) and 1 ÷ 2% = 50.
    expect(expressionLeak('Only 1/2% of it.', '1/200')).toBe(true);
    expect(expressionLeak('Only 1/2% of it.', '50')).toBe(true);
    expect(expressionLeak('Try 6 \u00F7 2%.', '300')).toBe(true);
  });

  it('too many locale readings fail closed instead of being dropped', () => {
    const content = 'Add 1,500 + 2,500 + 3,500 + 4,500 + 5,500.';
    expect(techniques(content, '17')).toContain('fail_closed:expression_unbounded');
  });

  it('only when a numeric answer is protected', () => {
    expect(scanExpr('Think of 10^100.', spelling('learn')).findings).toEqual([]);
  });

  it('division by zero has no value and is not a finding', () => {
    expect(scanExpr('What is 5 ÷ 0?', numeric('17')).findings).toEqual([]);
  });

  it('hostile text is data: no throw, no evaluation of code', () => {
    const hostile = 'constructor(1 + 2).__proto__ + process.exit(3) * (4 + 5)) ((( 6';
    expect(() => scanExpr(hostile, numeric('9'))).not.toThrow();
    expect(expressionLeak(hostile, '27')).toBe(true); // (3) * (4 + 5), unmatched ")" dropped
    expect(() =>
      scanExpr('('.repeat(5_000) + '1+1' + ')'.repeat(5_000), numeric('2')),
    ).not.toThrow();
    const long = Array.from({ length: 2_500 }, () => '1 + 1').join(', ');
    const started = performance.now();
    expect(scanExpr(long, numeric('2')).safe).toBe(false);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe('[capture-grading] the expression reader is total on untrusted text', () => {
  const PIECES = [
    '0',
    '1',
    '2',
    '7',
    '12',
    '1,500',
    '3.5',
    ' ',
    '\n',
    '+',
    '-',
    '*',
    '**',
    '/',
    '^',
    '%',
    '(',
    ')',
    '[',
    '}',
    'x',
    '×',
    '÷',
    '·',
    ' times ',
    ' plus ',
    ' minus ',
    ' divided by ',
    ' squared',
    ' por ',
    ' por ciento',
    'six',
    ' and a half',
    '\\times',
    '\\frac12',
    'a',
    '=',
    ':',
    '.',
    ',',
  ];

  it('property: never throws, and every finding is a value or a named fail-closed rule', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...PIECES), { maxLength: 60 }),
        fc.string({ maxLength: 40 }),
        (pieces, noise) => {
          const content = `${pieces.join('')}${noise}`;
          const result = scanExpr(content, numeric('42'));
          for (const f of result.findings) {
            if (f.detector === 'fail_closed') {
              expect(f.technique).toMatch(
                /^(?:expression_(?:unbounded|unevaluable)|numeral_too_long)$/u,
              );
            }
          }
          expect(() =>
            extractNumericMentions(canonicalize(content), { evaluateExpressions: true }),
          ).not.toThrow();
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('[capture-grading] ordinary method-hint prose stays releasable', () => {
  it.each([
    ['5', '- 3 apples are red.\n- 2 apples are green.'],
    ['5', 'You have 7\n- 2 of them are left.'],
    ['5', 'Solve 2x + 3 = 11 by undoing each step.'],
    ['5', 'Solve 3 + 2x = 11 by undoing each step.'],
    ['42', 'Multiply the tens first, then add the ones.'],
    ['8', 'Here is a similar problem: 3 + 4 = 7. Use the same steps on yours.'],
    ['12', 'Count the eggs in each row, then add the rows.'],
    ['6', 'Is it 2 + 3, or 3 + 4? Check both.'],
    ['4', 'The time is 10:30 and the score was 3:1.'],
    ['4', 'Use the H2O + CO2 example from class.'],
    ['12', 'Use a 3 by 4 grid.'],
    ['7', 'Three times a day, practice for 5 minutes.'],
  ])('answer %s: "%s" is safe', (value, content) => {
    const result = scanExpr(content, numeric(value));
    expect(result.findings).toEqual([]);
    expect(result.safe).toBe(true);
  });

  it('a plain fraction is read once, as a fraction, not again as an expression', () => {
    expect(techniques('Try 3/4 of it.', '3/4')).toEqual(['numeric:fraction']);
  });
});

describe('extractNumericMentions expression readings (opt-in)', () => {
  function values(content: string, evaluateExpressions: boolean): string[] {
    return extractNumericMentions(canonicalize(content), { evaluateExpressions }).map((m) =>
      m.value.den === 1n ? `${m.value.num}` : `${m.value.num}/${m.value.den}`,
    );
  }

  it('reads the value of an expression only when asked, through the safe parser', () => {
    expect(values('6 x 7', true)).toEqual(expect.arrayContaining(['6', '7', '42']));
    expect(values('6 x 7', false)).not.toContain('42');
  });
});
