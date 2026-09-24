import { QUANTITY_ERROR_CODES } from './units.ts';

/**
 * Deterministic check outcomes (spec P5/P6, AC_GRADING_01). `unresolved` means the checker cannot
 * decide (ambiguous notation, unknown unit, needs a model or a person); it is never a synonym for
 * `incorrect`. `unanswered` means the student left the item blank.
 */
export type CheckVerdict = 'correct' | 'incorrect' | 'unresolved' | 'unanswered';

/** Writing is evaluated against a rubric for feedback; it never receives a binary grade. */
export type GradeVerdict = CheckVerdict | 'rubric';

/** Stable SCREAMING_SNAKE reason codes explaining every verdict. */
export const GRADING_REASONS = [
  // correct
  'EXACT_MATCH',
  'EQUIVALENT_UNIT',
  'EQUIVALENT_VALUE',
  'WITHIN_TOLERANCE',
  'ACCEPTED_VARIANT',
  // incorrect
  'VALUE_MISMATCH',
  'NOT_SIMPLIFIED',
  'NOT_ROUNDED',
  'MISSING_UNIT',
  'WRONG_UNIT_DIMENSION',
  'UNIT_NOT_ACCEPTED',
  'MISSING_REMAINDER',
  'REMAINDER_NOT_LESS_THAN_DIVISOR',
  'CHOICE_MISMATCH',
  'MISSPELLED',
  // unanswered
  'BLANK',
  // unresolved: parse/unit failures, then checker-specific reasons
  ...QUANTITY_ERROR_CODES,
  'INVALID_ANSWER_KEY',
  'UNEXPECTED_UNIT',
  'AMBIGUOUS_PERCENT',
  'NEEDS_DIVISOR',
  'UNRECOGNIZED_CHOICE',
  'UNEXPECTED_CHARACTERS',
  'NEEDS_SEMANTIC_GRADING',
  'NEEDS_RESCAN',
  'NEEDS_SOURCE_PASSAGE',
  'ANSWER_SOURCE_UNCERTAIN',
  'ANSWER_MAPPING_UNCERTAIN',
  // rubric
  'RUBRIC_FEEDBACK_ONLY',
] as const;
export type GradingReason = (typeof GRADING_REASONS)[number];

export interface CheckResult {
  readonly verdict: CheckVerdict;
  readonly reason: GradingReason;
}

export interface GradeOutcome {
  readonly verdict: GradeVerdict;
  readonly reason: GradingReason;
}

export function outcome<V extends GradeVerdict>(
  verdict: V,
  reason: GradingReason,
): { readonly verdict: V; readonly reason: GradingReason } {
  return { verdict, reason };
}
