import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REWARD_RULES,
  MAX_POINTS_PER_AWARD,
  MAX_RESPONSE_THRESHOLD_MS,
  MIN_RESPONSE_THRESHOLD_MS,
  validateRules,
} from './index.ts';
import { errorCode, unwrap } from './test-fixtures.ts';

describe('P9 published earning rules (AC_REWARDS_01)', () => {
  it('defaults are the suggested family rules: 2 effort, +3 independent, 5 per set, one award per instance', () => {
    expect(DEFAULT_REWARD_RULES).toEqual({
      attemptPoints: 2,
      independentCorrectBonus: 3,
      setCompletionPoints: 5,
      minMeaningfulResponseMs: 1500,
      maxAwardsPerQuestionInstance: 1,
    });
    expect(unwrap(validateRules(DEFAULT_REWARD_RULES))).toEqual(DEFAULT_REWARD_RULES);
  });

  it('a family may configure other non-negative integer amounts, including zero', () => {
    const custom = { ...DEFAULT_REWARD_RULES, attemptPoints: 0, independentCorrectBonus: 10 };
    expect(unwrap(validateRules(custom))).toEqual(custom);
  });

  it('keeps only the known rule fields from untrusted configuration', () => {
    const value = unwrap(validateRules({ ...DEFAULT_REWARD_RULES, cashPerPoint: 100 }));
    expect(Object.keys(value).sort()).toEqual(Object.keys(DEFAULT_REWARD_RULES).sort());
  });

  it.each([
    ['attemptPoints', -1],
    ['attemptPoints', 1.5],
    ['independentCorrectBonus', Number.NaN],
    ['setCompletionPoints', Number.POSITIVE_INFINITY],
    ['setCompletionPoints', '5'],
    ['attemptPoints', MAX_POINTS_PER_AWARD + 1],
  ])('rejects %s = %s (non-negative integers under a sane cap)', (field, value) => {
    expect(errorCode(validateRules({ ...DEFAULT_REWARD_RULES, [field]: value }))).toBe(
      'INVALID_POINTS',
    );
  });

  it.each([MIN_RESPONSE_THRESHOLD_MS - 1, MAX_RESPONSE_THRESHOLD_MS + 1, 0, -5, 1500.5])(
    'rejects minMeaningfulResponseMs = %s so the anti-farm gate cannot be switched off',
    (value) => {
      expect(
        errorCode(validateRules({ ...DEFAULT_REWARD_RULES, minMeaningfulResponseMs: value })),
      ).toBe('INVALID_RESPONSE_THRESHOLD');
    },
  );

  it.each([0, 2, 10, 1.5])(
    'rejects maxAwardsPerQuestionInstance = %s: P9 caps question awards at one per instance',
    (value) => {
      expect(
        errorCode(validateRules({ ...DEFAULT_REWARD_RULES, maxAwardsPerQuestionInstance: value })),
      ).toBe('INVALID_AWARD_CAP');
    },
  );

  it.each([null, undefined, 7, 'rules', [1, 2, 3]])('rejects non-object rules %s', (value) => {
    expect(errorCode(validateRules(value))).toBe('INVALID_RULES');
  });

  it('does not read rule values inherited through the prototype chain', () => {
    const inherited = Object.create(DEFAULT_REWARD_RULES) as object;
    expect(validateRules(inherited).ok).toBe(false);
  });

  it('property: every accepted rule set has non-negative integer amounts within the caps', () => {
    fc.assert(
      fc.property(
        fc.record({
          attemptPoints: fc.oneof(fc.integer({ min: -5, max: 150 }), fc.double()),
          independentCorrectBonus: fc.integer({ min: -5, max: 150 }),
          setCompletionPoints: fc.integer({ min: -5, max: 150 }),
          minMeaningfulResponseMs: fc.integer({ min: -10, max: 70_000 }),
          maxAwardsPerQuestionInstance: fc.integer({ min: 0, max: 3 }),
        }),
        (candidate) => {
          const result = validateRules(candidate);
          if (!result.ok) return;
          const rules = result.value;
          for (const points of [
            rules.attemptPoints,
            rules.independentCorrectBonus,
            rules.setCompletionPoints,
          ]) {
            expect(Number.isInteger(points)).toBe(true);
            expect(points).toBeGreaterThanOrEqual(0);
            expect(points).toBeLessThanOrEqual(MAX_POINTS_PER_AWARD);
          }
          expect(rules.minMeaningfulResponseMs).toBeGreaterThanOrEqual(MIN_RESPONSE_THRESHOLD_MS);
          expect(rules.maxAwardsPerQuestionInstance).toBe(1);
        },
      ),
    );
  });
});
