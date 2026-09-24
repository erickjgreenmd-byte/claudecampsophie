// Second round of the [capture-grading] expression note: shapes of arithmetic that the first
// expression reader missed (spec P6 "No original problem's final numeric value ... in hints"; E4
// "Answer protection"; AC_GRADING_07/08). Each case below was released with evaluation ON before
// this fix. Synthetic data only.
import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  guardChildContent,
  scanForLeaks,
  type LeakScanResult,
  type ProtectedAnswer,
} from './index.ts';
import { MAX_PARSES } from './expressions.ts';
import { numeric } from './test-helpers.ts';

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

function hint(text: string, value: string): string {
  return guardChildContent({
    packet: { steps: [{ kind: 'hint', text }], retryPrompt: 'Try again!' },
    answers: [numeric(value)],
    options: EVALUATE,
  }).decision;
}

describe('[capture-grading] LaTeX written without spaces (commands glued to digits)', () => {
  it.each([
    ['42', '$6\\times7$'],
    ['42', '$6 \\times7$'],
    ['42', '$6\\cdot7$'],
    ['7', '$42\\div6$'],
    ['42', '\\(6\\times7=?\\)'],
    ['42', '$$6\\times7$$'],
    ['42', '$6{\\times}7$'],
    ['42', '$(3+4)\\times6$'],
    ['42', '$\\left(3+4\\right)\\times6$'],
    ['42', '$\\frac12\\times84$'],
    ['42', '$\\tfrac{1}{2}\\times84$'],
    ['42', '$\\frac{6\\times7}{1}$'],
    ['21', '$\\frac{6\\times7}{2}$'],
    ['42', '$\\dfrac{84}{3-1}$'],
    ['42', '$50\\%\\times84$'],
  ])('answer %s: "%s" is flagged as an expression', (value, content) => {
    expect(expressionLeak(content, value)).toBe(true);
  });

  it('a tight LaTeX hint is blocked by the release gate', () => {
    expect(hint('Think about \\(6\\times7\\).', '42')).toBe('block');
  });

  it('a numerator expression is read on its own too (\\frac{6\\times7}{2} shows 42)', () => {
    expect(expressionLeak('$\\frac{6\\times7}{2}$', '42')).toBe(true);
  });
});

describe('[capture-grading] markup, quotes, currency, degrees and units around operands', () => {
  it.each([
    ['42', '**6** × **7**'],
    ['42', '*6* × *7*'],
    ['42', '***6*** × ***7***'],
    ['42', '_6_ × _7_'],
    ['42', '__6__ × __7__'],
    ['42', '~~6~~ × ~~7~~'],
    ['42', '"6" × "7"'],
    ['42', '“6” × “7”'],
    ['42', '`6` × `7`'],
    ['12', 'Find $20 − $8.'],
    ['13', 'You have $6 + $7.'],
    ['42', '€20 + €22'],
    ['42', '£20 + £22'],
    ['42', '20¢ + 22¢'],
    ['42', '$20.00 + $22.00'],
    ['42', '20 dollars + 22 dollars'],
    ['42', 'Angle = 180° − 138°'],
    ['42', '20°C + 22°C'],
    ['42', 'Area = 6 cm × 7 cm'],
    ['42', 'Area = 6cm × 7cm'],
    ['42', 'Area = 6 ft x 7 ft'],
    ['42', 'Area = 6 sq ft × 7'],
    ['42', 'Mass: 50 kg - 8 kg'],
    ['42', 'Time: 30 min + 12 min'],
    ['42', 'Tiempo: 30 minutos + 12 minutos'],
    ['42', '6" × 7"'],
  ])('answer %s: "%s" is flagged as an expression', (value, content) => {
    expect(expressionLeak(content, value)).toBe(true);
  });

  it('markdown-bold and money hints are blocked by the release gate', () => {
    expect(hint('Multiply **6** × **7** to finish.', '42')).toBe('block');
    expect(hint('Your change is $20 − $8.', '12')).toBe('block');
    expect(hint('The area is 6 cm × 7 cm.', '42')).toBe('block');
  });

  it('an ambiguous "*" is read both ways (emphasis and multiplication)', () => {
    // Rendered markdown shows "2 3 4"; plain text shows 2 × 3 × 4. Both readings count.
    expect(expressionLeak('Try 2 *3* 4 first.', '24')).toBe(true);
    // Programming power is unchanged.
    expect(expressionLeak('Try 2 ** 3.', '8')).toBe(true);
    expect(expressionLeak('Try 2**3.', '8')).toBe(true);
  });

  it('a unit word only joins an operand, it is never an operator or an operand itself', () => {
    expect(scanExpr('Walk 6 m, then rest 7 min.', numeric('42')).safe).toBe(true);
    expect(scanExpr('Use 6 cm of tape and 7 cm of string.', numeric('13')).safe).toBe(true);
    expect(scanExpr('Line up the 1s + the 10s.', numeric('11')).safe).toBe(true);
  });

  it.each([
    ['12', 'You have $20. The toy costs $8. How much is left? Try counting up from $8.'],
    ['42', 'Each ribbon is 6 cm long. How long are 7 ribbons laid end to end?'],
    ['13', 'The pot was 60°F at 1 pm and warmed up by noon; read both thermometers.'],
    ['42', 'Draw an array with **6** rows. Then count the dots in each of the 7 columns.'],
    ['30', 'It takes 10 minutes to walk and 20 minutes to ride. Which is faster?'],
  ])('answer %s: money, unit and markdown method prose %j stays releasable', (value, content) => {
    expect(scanExpr(content, numeric(value)).findings).toEqual([]);
  });
});

describe('[capture-grading] vertical arithmetic, implicit products, Spanish and other shapes', () => {
  it.each([
    ['42', '40\n+ 2'],
    ['42', '40\n+2'],
    ['42', '  40\n+ 2\n----'],
    ['42', 'Try 6\n* 7'],
    ['42', 'Try 6\n· 7'],
    ['42', 'Try 6\n+ 36'],
    ['42', 'Try 6\n- (-36)'],
    ['47', '  12\n+ 30\n+ 5'],
    ['42', 'Try 3(14).'],
    ['42', 'Try (6)(7).'],
    ['14', 'Try 2(3 + 4).'],
    ['42', 'Prueba seis veces siete.'],
    ['42', 'Prueba 6 veces 7.'],
    ['7', 'Try 13 take away 6.'],
    ['42', 'Try (6 × 7) + 1.'],
    ['42', 'Try 2 × (6 × 7).'],
    ['42', 'Try 6² + 6.'],
    ['8', 'Work out 2³.'],
  ])('answer %s: %j is flagged as an expression', (value, content) => {
    expect(expressionLeak(content, value)).toBe(true);
  });

  it('a division-by-zero tail cannot hide the rest of a chain (fail closed)', () => {
    const result = scanExpr('Try 6 × 7 − 0 ÷ 0.', numeric('42'));
    expect(result.safe).toBe(false);
    expect(techniques('Try 6 × 7 − 0 ÷ 0.', '17')).toContain('fail_closed:expression_unevaluable');
    // A single division by zero has no value and is still not a finding.
    expect(scanExpr('What is 5 ÷ 0?', numeric('17')).findings).toEqual([]);
    // Nor is a slash-separated list: each "a/b" in it is already read as a fraction.
    expect(scanExpr('Split it 50/50/0 over the months.', numeric('17')).findings).toEqual([]);
    expect(scanExpr('Split it 84/2/0 over the months.', numeric('42')).safe).toBe(false);
    // Any other operator in the chain keeps it fail-closed.
    expect(techniques('Try 6 × 7 / 0.', '17')).toContain('fail_closed:expression_unevaluable');
  });

  it('bullet lists stay lists: a line-start sign is an operator only in vertical arithmetic', () => {
    expect(scanExpr('- 3 apples are red.\n- 2 apples are green.', numeric('5')).safe).toBe(true);
    expect(scanExpr('You have 7\n- 2 of them are left.', numeric('5')).safe).toBe(true);
    expect(scanExpr('Numbers to use:\n- 3\n- 4', numeric('1')).safe).toBe(true);
    expect(scanExpr('* 6 red\n* 7 blue', numeric('42')).safe).toBe(true);
  });

  it('implicit products need brackets glued to the number (prose stays prose)', () => {
    expect(scanExpr('Look at problem 3 (the one with 14 apples).', numeric('42')).safe).toBe(true);
    expect(scanExpr('Step 2 (3 + 4) is next.', numeric('14')).safe).toBe(true);
  });

  it('superscript exponents are powers, and the digits they are written with still count', () => {
    expect(canonicalize('6² + 6')).toBe('6^2 + 6');
    expect(canonicalize('10⁻²')).toBe('10^-2');
    // A superscript run with no base is plain digits, as before.
    expect(canonicalize('The answer is ⁴²')).toBe('the answer is 42');
    // "4²" may be misread as 42: still a leak of a protected 42 without evaluation.
    expect(scanForLeaks('The answer is 4².', [numeric('42')]).safe).toBe(false);
  });
});

describe('[capture-grading] ranges and dates are not subtraction', () => {
  it.each([
    ['1', 'Look at problems 4-5.'],
    ['1', 'Ages 6-7 love this.'],
    ['2', 'Steps 1-3 show how.'],
    ['2', 'Score 3-1 in the game.'],
    ['2', 'Read pages 10-12 again.'],
    ['5', 'Spend 10-15 minutes on it.'],
    ['1', 'Mira las preguntas 4-5.'],
    ['1993', 'Due 2026-09-24.'],
  ])('answer %s: %j is safe', (value, content) => {
    expect(scanExpr(content, numeric(value)).findings).toEqual([]);
  });

  it('a hyphen between numbers is still a minus everywhere else (fail closed)', () => {
    expect(expressionLeak('Try 12-7.', '5')).toBe(true);
    expect(expressionLeak('What is 50-8?', '42')).toBe(true);
    expect(expressionLeak('Check 8-3 = ?', '5')).toBe(true);
    // Descending with a unit, or a range noun followed by more arithmetic: still read.
    expect(expressionLeak('Spend 50-8 minutes on it.', '42')).toBe(true);
    expect(expressionLeak('Pages 50-8 + 1 now.', '43')).toBe(true);
  });
});

describe('[capture-grading] evaluator cost is bounded per text', () => {
  const HOSTILE = '1,500%/2,500 ^ 12 × 3,500 ^ 12 ÷ 4,500 ^ 11';

  it(`more than ${MAX_PARSES} parser calls in one text fail closed (LIMIT_EXCEEDED)`, () => {
    // Distinct chains so no cached result can be reused.
    const text = Array.from({ length: 450 }, (_, i) => HOSTILE.replace('3,500', `3,${500 + i}`))
      .join('. ')
      .slice(0, 20_000);
    const result = scanExpr(text, numeric('42'));
    expect(result.findings).toContainEqual(
      expect.objectContaining({ detector: 'fail_closed', technique: 'expression_unbounded' }),
    );
    const decision = guardChildContent({
      packet: { steps: [text] },
      answers: [numeric('42')],
      options: EVALUATE,
    });
    expect(decision.decision).toBe('block');
    expect(decision.reasons.map((r) => r.code)).toContain('LIMIT_EXCEEDED');
  });

  it('a hostile maximum-size packet costs at most a small multiple of the literal scan', () => {
    const text = Array.from({ length: 450 }, (_, i) => HOSTILE.replace('3,500', `3,${500 + i}`))
      .join('. ')
      .slice(0, 20_000);
    const packet = { steps: Array.from({ length: 5 }, () => text) };
    const answers = [numeric('42')];
    guardChildContent({ packet, answers }); // warm up
    const t0 = performance.now();
    guardChildContent({ packet, answers });
    const literal = performance.now() - t0;
    const t1 = performance.now();
    guardChildContent({ packet, answers, options: EVALUATE });
    const evaluated = performance.now() - t1;
    // Was ~22x before the parse budget. Loose bound for a loaded CI machine.
    expect(evaluated).toBeLessThan(Math.max(8 * literal, 1_500));
  });

  it('repeated identical expressions are parsed once (cached)', () => {
    const text = Array.from({ length: 1_500 }, () => '6 × 7').join(', ');
    expect(techniques(text, '17')).not.toContain('fail_closed:expression_unbounded');
    expect(expressionLeak(text, '42')).toBe(true);
  });
});
