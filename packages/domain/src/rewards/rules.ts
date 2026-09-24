// Configurable family earning rules (spec P9).
import { err, ok, type Result } from '../shared/result.ts';
import { isPlainRecord, ownField } from './text.ts';

export interface RewardRules {
  /** Points for a meaningful completed practice attempt, earned even when the answer is wrong. */
  readonly attemptPoints: number;
  /** Additional points when the response was independently correct. */
  readonly independentCorrectBonus: number;
  /** Points for completing a daily set, once per set. */
  readonly setCompletionPoints: number;
  /** Responses faster than this earn nothing (anti-farm). */
  readonly minMeaningfulResponseMs: number;
  /** P9 caps question awards at one per unique question instance; must be 1. */
  readonly maxAwardsPerQuestionInstance: number;
}

/** P9 suggested defaults. */
export const DEFAULT_REWARD_RULES: RewardRules = Object.freeze({
  attemptPoints: 2,
  independentCorrectBonus: 3,
  setCompletionPoints: 5,
  minMeaningfulResponseMs: 1500,
  maxAwardsPerQuestionInstance: 1,
});

/** Decision: no single rule may award more than 100 points (sane cap on a family config). */
export const MAX_POINTS_PER_AWARD = 100;
/**
 * Decision: the minimum meaningful response time is configurable only within 500 ms – 60 s. A
 * floor above zero keeps the P9 rapid-guess protection from being configured away; the ceiling
 * prevents a threshold so high that genuine effort can never earn.
 */
export const MIN_RESPONSE_THRESHOLD_MS = 500;
export const MAX_RESPONSE_THRESHOLD_MS = 60_000;

export const REWARD_RULES_ERROR_CODES = [
  'INVALID_RULES',
  'INVALID_POINTS',
  'INVALID_RESPONSE_THRESHOLD',
  'INVALID_AWARD_CAP',
] as const;
export type RewardRulesErrorCode = (typeof REWARD_RULES_ERROR_CODES)[number];

const POINT_FIELDS = ['attemptPoints', 'independentCorrectBonus', 'setCompletionPoints'] as const;

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Validates untrusted rule configuration (e.g. a stored family setting). Returns a normalized copy
 * containing only the known fields.
 */
export function validateRules(input: unknown): Result<RewardRules, RewardRulesErrorCode> {
  if (!isPlainRecord(input)) return err('INVALID_RULES', 'Reward rules must be an object');
  for (const field of POINT_FIELDS) {
    if (!isIntegerInRange(ownField(input, field), 0, MAX_POINTS_PER_AWARD)) {
      return err(
        'INVALID_POINTS',
        `${field} must be an integer from 0 to ${MAX_POINTS_PER_AWARD}`,
        { field },
      );
    }
  }
  const threshold = ownField(input, 'minMeaningfulResponseMs');
  if (!isIntegerInRange(threshold, MIN_RESPONSE_THRESHOLD_MS, MAX_RESPONSE_THRESHOLD_MS)) {
    return err(
      'INVALID_RESPONSE_THRESHOLD',
      `minMeaningfulResponseMs must be an integer from ${MIN_RESPONSE_THRESHOLD_MS} to ${MAX_RESPONSE_THRESHOLD_MS}`,
    );
  }
  if (ownField(input, 'maxAwardsPerQuestionInstance') !== 1) {
    return err('INVALID_AWARD_CAP', 'Question awards are capped at one per question instance');
  }
  return ok({
    attemptPoints: ownField(input, 'attemptPoints') as number,
    independentCorrectBonus: ownField(input, 'independentCorrectBonus') as number,
    setCompletionPoints: ownField(input, 'setCompletionPoints') as number,
    minMeaningfulResponseMs: threshold,
    maxAwardsPerQuestionInstance: 1,
  });
}

/** Rules reaching the award functions must already be validated; anything else is a bug. */
export function assertValidRules(rules: RewardRules): void {
  const result = validateRules(rules);
  if (!result.ok) throw new RangeError(`Invalid reward rules: ${result.error.message}`);
}
