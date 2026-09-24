// Numeric detector: flags any representation equal to a protected numeric value (spec P6).

import type { NormalizedAnswer, NumericTarget } from './answers.ts';
import type { ExpressionCache } from './expressions.ts';
import { extractNumericMentionsDetailed, type MarkerState } from './numbers.ts';
import { abs, equals, withinRounding } from './rational.ts';
import type { RawFinding, TextView } from './view.ts';

/**
 * Decision: comparison is sign-insensitive. A protected -5 leaks through "5" and a protected 5
 * through "-5"; negation is one step a child can take, and signs are often typographic noise.
 *
 * Decision: a written decimal with at least two places that rounds to the protected value (or
 * that the protected value rounds to) is a leak: "0.33" and "33%" reveal 1/3. One-place
 * roundings ("0.3") are not flagged, to leave room for estimates in method hints.
 */
function matchTechnique(
  mention: { value: NumericTarget['value']; decimalPlaces: number | null; reading: string },
  target: NumericTarget,
): string | null {
  const value = abs(mention.value);
  if (equals(value, target.value)) return mention.reading;
  if (
    mention.decimalPlaces !== null &&
    mention.decimalPlaces >= 2 &&
    withinRounding(value, target.value, mention.decimalPlaces)
  ) {
    return 'rounded';
  }
  if (
    target.decimalPlaces !== null &&
    target.decimalPlaces >= 2 &&
    withinRounding(value, target.value, target.decimalPlaces)
  ) {
    return 'rounded';
  }
  return null;
}

/**
 * Decision: "^" separates digits like "*" and "-" do. canonicalize writes a superscript exponent
 * as "^n" ("4²" -> "4^2"), and a child who does not know exponents may still read "4²" as 42.
 */
const DIGIT_SEPARATOR = String.raw`(?:[ \t]*[-_.*|^\u2022\u00B7][ \t]*|[ \t\n]+)`;

export function detectNumeric(
  view: TextView,
  answers: readonly NormalizedAnswer[],
  markerState: MarkerState,
  /** Evaluate arithmetic expressions (ScanOptions.evaluateExpressions), sharing this cache. */
  expressions: ExpressionCache | null = null,
): RawFinding[] {
  if (!answers.some((a) => a.numeric.length > 0)) return [];
  const { mentions, masked, overlong, expressionFailures } = extractNumericMentionsDetailed(
    view.lower,
    expressions === null
      ? { markerState }
      : { markerState, evaluateExpressions: true, expressionCache: expressions },
  );
  // Decision (regression RV-answer-guard-1): a numeral too long to compare exactly is a
  // fail-closed finding, never a silent pass.
  const findings: RawFinding[] = overlong.map((span) => ({
    detector: 'fail_closed',
    answerIndex: null,
    technique: 'numeral_too_long',
    start: span.start,
    end: span.end,
  }));
  // Decision ([capture-grading] expression note): an expression that cannot be bounded or
  // evaluated unambiguously is likewise a fail-closed finding (see expressions.ts).
  for (const failure of expressionFailures) {
    findings.push({
      detector: 'fail_closed',
      answerIndex: null,
      technique: failure.technique,
      start: failure.start,
      end: failure.end,
    });
  }
  for (const answer of answers) {
    for (const target of answer.numeric) {
      for (const mention of mentions) {
        const technique = matchTechnique(mention, target);
        if (technique !== null) {
          findings.push({
            detector: 'numeric',
            answerIndex: answer.index,
            technique,
            start: mention.start,
            end: mention.end,
          });
        }
      }
      const digits = target.digits;
      if (digits === null || digits.length < 2 || digits.length > 24) continue;
      // Digits written apart: "1 2 5", "1-2-5", one digit per line.
      const separated = new RegExp(`(?<!\\d)${[...digits].join(DIGIT_SEPARATOR)}(?!\\d)`, 'gu');
      for (const m of masked.matchAll(separated)) {
        findings.push({
          detector: 'numeric',
          answerIndex: answer.index,
          technique: 'separated_digits',
          start: m.index,
          end: m.index + m[0].length,
        });
      }
      // Digits reversed ("521" for 125), only for three or more digits.
      const reversed = [...digits].reverse().join('');
      if (digits.length >= 3 && reversed !== digits) {
        const re = new RegExp(`(?<![\\d.])${reversed}(?!\\d|\\.\\d)`, 'gu');
        for (const m of masked.matchAll(re)) {
          findings.push({
            detector: 'numeric',
            answerIndex: answer.index,
            technique: 'reversed_digits',
            start: m.index,
            end: m.index + m[0].length,
          });
        }
      }
    }
  }
  return findings;
}
