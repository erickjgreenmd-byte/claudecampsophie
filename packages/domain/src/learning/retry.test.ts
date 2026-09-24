// P6 retry limit, AC_GRADING_09: after three unsuccessful target-answer attempts, redirect to
// method practice or parent help (never a lockout), and resets/resubmissions do not reset the count.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_TARGET_ATTEMPTS,
  countUnsuccessfulTargetAttempts,
  evaluateRetry,
} from './index.ts';
import { RILEY, SAM, attempt, daysAgo } from './test-fixtures.ts';

describe('AC_GRADING_09 evaluateRetry', () => {
  it('allows retries until the third unsuccessful attempt, then redirects', () => {
    expect(DEFAULT_MAX_TARGET_ATTEMPTS).toBe(3);
    expect(evaluateRetry({ targetAnswerAttempts: 0 })).toBe('allow_retry');
    expect(evaluateRetry({ targetAnswerAttempts: 1 })).toBe('allow_retry');
    expect(evaluateRetry({ targetAnswerAttempts: 2 })).toBe('allow_retry');
    expect(evaluateRetry({ targetAnswerAttempts: 3 })).toBe(
      'redirect_method_practice_or_parent_help',
    );
  });

  it('property: at or beyond the limit the answer is always a redirect, below it always a retry', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 0, max: 1_000 }), (max, n) => {
        const decision = evaluateRetry({ targetAnswerAttempts: n, maxTargetAttempts: max });
        expect(decision).toBe(n >= max ? 'redirect_method_practice_or_parent_help' : 'allow_retry');
      }),
    );
  });

  it('cannot be configured to permit more guessing than the spec allows', () => {
    expect(() => evaluateRetry({ targetAnswerAttempts: 0, maxTargetAttempts: 4 })).toThrow(
      RangeError,
    );
    expect(() => evaluateRetry({ targetAnswerAttempts: 0, maxTargetAttempts: 0 })).toThrow(
      RangeError,
    );
    expect(() => evaluateRetry({ targetAnswerAttempts: -1 })).toThrow(RangeError);
    expect(() => evaluateRetry({ targetAnswerAttempts: 1.5 })).toThrow(RangeError);
  });
});

describe('AC_GRADING_09 server-side unsuccessful attempt count', () => {
  const target = { childId: RILEY, questionInstanceId: 'q-target' };

  it('counts every unsuccessful answer on the instance, even after a reset re-sends attempt 1', () => {
    const events = [
      attempt({
        questionInstanceId: 'q-target',
        occurredAt: daysAgo(0.4),
        correctness: 'incorrect',
      }),
      attempt({
        questionInstanceId: 'q-target',
        occurredAt: daysAgo(0.3),
        attemptNumber: 2,
        correctness: 'incorrect',
      }),
      // A client reset or resubmission that claims to be a fresh first attempt.
      attempt({
        questionInstanceId: 'q-target',
        occurredAt: daysAgo(0.2),
        correctness: 'incorrect',
      }),
    ];
    const count = countUnsuccessfulTargetAttempts(events, target);
    expect(count).toBe(3);
    expect(evaluateRetry({ targetAnswerAttempts: count })).toBe(
      'redirect_method_practice_or_parent_help',
    );
  });

  it('counts a replayed offline event once and ignores other instances, children and unresolved reads', () => {
    const wrong = attempt({
      questionInstanceId: 'q-target',
      occurredAt: daysAgo(1),
      correctness: 'incorrect',
    });
    const events = [
      wrong,
      { ...wrong },
      attempt({ questionInstanceId: 'q-other', correctness: 'incorrect' }),
      {
        ...attempt({ questionInstanceId: 'q-target', correctness: 'incorrect' }),
        id: 'sam',
        childId: SAM,
      },
      attempt({
        questionInstanceId: 'q-target',
        occurredAt: daysAgo(0.5),
        correctness: 'unresolved',
      }),
    ];
    expect(countUnsuccessfulTargetAttempts(events, target)).toBe(1);
  });

  it('counts what the child was told at the time, even if a parent later overrides the grade', () => {
    const events = [
      attempt({
        questionInstanceId: 'q-target',
        occurredAt: daysAgo(1),
        correctness: 'incorrect',
        parentOverride: { correctness: 'correct', overriddenAt: daysAgo(0.5) },
      }),
    ];
    expect(countUnsuccessfulTargetAttempts(events, target)).toBe(1);
  });
});
