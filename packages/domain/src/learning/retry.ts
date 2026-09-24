// Server-side target-answer retry limit (spec P6, AC_GRADING_09). After three unsuccessful
// target-answer attempts the child is offered method practice or parent help, which discourages
// answer enumeration without locking the child out of learning.
import { normalizeEvents, type AttemptEvent } from './evidence.ts';

export const RETRY_DECISIONS = ['allow_retry', 'redirect_method_practice_or_parent_help'] as const;
export type RetryDecision = (typeof RETRY_DECISIONS)[number];

export const DEFAULT_MAX_TARGET_ATTEMPTS = 3;
/**
 * Decision: the limit may be lowered (1..3) but never raised above the spec's three, so no
 * configuration can permit more answer guessing.
 */
export const MAX_ALLOWED_TARGET_ATTEMPTS = 3;

export interface RetryInput {
  /** Unsuccessful target-answer attempts so far on this question instance (server count). */
  readonly targetAnswerAttempts: number;
  readonly maxTargetAttempts?: number;
}

export function evaluateRetry(input: RetryInput): RetryDecision {
  const max = input.maxTargetAttempts ?? DEFAULT_MAX_TARGET_ATTEMPTS;
  if (!Number.isInteger(max) || max < 1 || max > MAX_ALLOWED_TARGET_ATTEMPTS) {
    throw new RangeError(
      `maxTargetAttempts must be an integer from 1 to ${MAX_ALLOWED_TARGET_ATTEMPTS}`,
    );
  }
  const attempts = input.targetAnswerAttempts;
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    throw new RangeError('targetAnswerAttempts must be a non-negative integer');
  }
  return attempts >= max ? 'redirect_method_practice_or_parent_help' : 'allow_retry';
}

/**
 * The server-side count of unsuccessful target-answer attempts for one child's question instance.
 *
 * Every stored `incorrect` answer counts, whatever attempt number the client claimed, so a reset or
 * resubmission can never lower the count. A replayed offline event (same id) counts once.
 * Decision: unresolved answers do not count (the child learned nothing about correctness from
 * them), and the grader's original judgment is used rather than a later parent override, because
 * the limit tracks what the child was told at the time.
 */
export function countUnsuccessfulTargetAttempts(
  events: readonly AttemptEvent[],
  target: { readonly childId: string; readonly questionInstanceId: string },
): number {
  return normalizeEvents(events).filter(
    (e) =>
      e.childId === target.childId &&
      e.questionInstanceId === target.questionInstanceId &&
      e.correctness === 'incorrect',
  ).length;
}
