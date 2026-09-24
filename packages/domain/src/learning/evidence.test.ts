// P7: attempts are immutable evidence events. Validation treats every field as untrusted data.
import { describe, expect, it } from 'vitest';
import {
  effectiveCorrectness,
  isIndependentAttempt,
  validateAttemptEvent,
  type AttemptEvent,
} from './index.ts';
import { NOW, attempt, daysAgo, errorCode, unwrap } from './test-fixtures.ts';

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...attempt({ questionInstanceId: 'qi-1' }), ...overrides };
}

describe('P7 attempt event validation', () => {
  it('accepts a complete event and returns a normalized copy without unknown fields', () => {
    const input = raw({ aiConfidence: 0.99, sourceAssignmentId: 'asg-1' });
    const event = unwrap(validateAttemptEvent(input));
    expect(event).not.toBe(input);
    expect(event).toMatchObject({ questionInstanceId: 'qi-1', sourceAssignmentId: 'asg-1' });
    expect('aiConfidence' in event).toBe(false);
    expect(Object.isFrozen(event)).toBe(true);
  });

  it.each([
    ['not an object', null, 'INVALID_EVENT'],
    ['array', [], 'INVALID_EVENT'],
    ['empty id', raw({ id: '' }), 'INVALID_IDENTIFIER'],
    ['blank skill', raw({ skill: '   ' }), 'INVALID_IDENTIFIER'],
    ['oversized subject', raw({ subject: 'x'.repeat(300) }), 'INVALID_IDENTIFIER'],
    ['numeric child id', raw({ childId: 7 }), 'INVALID_IDENTIFIER'],
    ['empty source assignment', raw({ sourceAssignmentId: '' }), 'INVALID_IDENTIFIER'],
    ['string date', raw({ occurredAt: NOW.toISOString() }), 'INVALID_OCCURRED_AT'],
    ['invalid date', raw({ occurredAt: new Date('nope') }), 'INVALID_OCCURRED_AT'],
    ['attempt zero', raw({ attemptNumber: 0 }), 'INVALID_ATTEMPT_NUMBER'],
    ['fractional attempt', raw({ attemptNumber: 1.5 }), 'INVALID_ATTEMPT_NUMBER'],
    ['negative hints', raw({ hintsUsed: -1 }), 'INVALID_HINTS_USED'],
    ['unknown correctness', raw({ correctness: 'mostly' }), 'INVALID_CORRECTNESS'],
    [
      'override before the attempt',
      raw({ parentOverride: { correctness: 'correct', overriddenAt: daysAgo(1) } }),
      'INVALID_OVERRIDE',
    ],
    [
      'override with unknown correctness',
      raw({ parentOverride: { correctness: 'yes', overriddenAt: NOW } }),
      'INVALID_OVERRIDE',
    ],
  ])('rejects %s', (_label, input, code) => {
    expect(errorCode(validateAttemptEvent(input))).toBe(code);
  });
});

describe('P7 independence and parent override', () => {
  it('independent means the initial attempt with no hints', () => {
    expect(isIndependentAttempt(attempt({ questionInstanceId: 'q' }))).toBe(true);
    expect(isIndependentAttempt(attempt({ questionInstanceId: 'q', hintsUsed: 1 }))).toBe(false);
    expect(isIndependentAttempt(attempt({ questionInstanceId: 'q', attemptNumber: 2 }))).toBe(
      false,
    );
  });

  it('a parent override replaces correctness for evidence without mutating the event', () => {
    const event: AttemptEvent = Object.freeze(
      attempt({
        questionInstanceId: 'q',
        correctness: 'incorrect',
        parentOverride: { correctness: 'correct', overriddenAt: NOW },
      }),
    );
    expect(effectiveCorrectness(event)).toBe('correct');
    expect(event.correctness).toBe('incorrect');
  });

  it('an override recorded after the as-of instant is not yet in effect', () => {
    const event = attempt({
      questionInstanceId: 'q',
      occurredAt: daysAgo(2),
      correctness: 'incorrect',
      parentOverride: { correctness: 'correct', overriddenAt: NOW },
    });
    expect(effectiveCorrectness(event, daysAgo(1))).toBe('incorrect');
    expect(effectiveCorrectness(event, NOW)).toBe('correct');
  });
});
