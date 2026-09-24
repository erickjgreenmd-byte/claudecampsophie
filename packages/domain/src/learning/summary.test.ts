// P7 transparent evidence rules, AC_LEARNING_01 and AC_LEARNING_02.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RECENCY_HALF_LIFE_DAYS,
  SKILL_STATUSES,
  SKILL_STATUS_RULES,
  summarizeSkill,
  summarizeSkills,
  type AttemptEvent,
} from './index.ts';
import {
  DAY_MS,
  NOW,
  RILEY,
  SAM,
  attempt,
  daysAgo,
  frozen,
  independentSeries,
} from './test-fixtures.ts';

describe('AC_LEARNING_01 initial accuracy vs eventual completion', () => {
  it('keeps first-try accuracy separate from success reached after hints and retries', () => {
    const events = [0, 1, 2, 3, 4].flatMap((i) => [
      attempt({
        questionInstanceId: `q${i}`,
        occurredAt: daysAgo(1 + (i % 2)),
        correctness: 'incorrect',
      }),
      attempt({
        questionInstanceId: `q${i}`,
        occurredAt: new Date(daysAgo(1 + (i % 2)).getTime() + 60_000),
        attemptNumber: 2,
        hintsUsed: 1,
        correctness: 'correct',
      }),
    ]);
    const summary = summarizeSkill(events, NOW);
    expect(summary.initialAccuracy).toBe(0);
    expect(summary.eventualCompletionRate).toBe(1);
    expect(summary.independentCorrect).toBe(0);
    expect(summary.distinctIndependentQuestions).toBe(5);
    expect(summary.weightedIndependentAccuracy).toBe(0);
  });

  it('a correct answer after hints counts toward completion, not independent mastery', () => {
    const events = [0, 1, 2, 3, 4, 5].map((i) =>
      attempt({ questionInstanceId: `q${i}`, occurredAt: daysAgo(i), hintsUsed: 1 }),
    );
    const summary = summarizeSkill(events, NOW);
    expect(summary.distinctIndependentQuestions).toBe(0);
    expect(summary.independentCorrect).toBe(0);
    expect(summary.weightedIndependentAccuracy).toBeNull();
    expect(summary.eventualCompletionRate).toBe(1);
    // Decision: a hint-assisted first try is attempted but is never an initial success.
    expect(summary.initialAccuracy).toBe(0);
    expect(summary.status).toBe('not_enough_evidence');
  });

  it('resubmitting the same question instance never adds samples', () => {
    const original = attempt({ questionInstanceId: 'q-same', occurredAt: daysAgo(3) });
    const resubmissions = [1, 2, 3, 4, 5, 6].map((n) =>
      attempt({ questionInstanceId: 'q-same', occurredAt: daysAgo(3 - n * 0.4) }),
    );
    const summary = summarizeSkill([original, ...resubmissions], NOW);
    expect(summary.distinctQuestions).toBe(1);
    expect(summary.distinctIndependentQuestions).toBe(1);
    expect(summary.independentCorrect).toBe(1);
    expect(summary.status).toBe('not_enough_evidence');
  });

  it('a reset that re-sends attempt 1 after retries cannot replace the original initial result', () => {
    const events = [
      attempt({ questionInstanceId: 'q', occurredAt: daysAgo(1), correctness: 'incorrect' }),
      attempt({
        questionInstanceId: 'q',
        occurredAt: daysAgo(0.9),
        attemptNumber: 2,
        correctness: 'incorrect',
      }),
      attempt({ questionInstanceId: 'q', occurredAt: daysAgo(0.8), correctness: 'correct' }),
    ];
    const summary = summarizeSkill(events, NOW);
    expect(summary.independentCorrect).toBe(0);
    expect(summary.initialAccuracy).toBe(0);
    expect(summary.eventualCompletionRate).toBe(1);
  });

  it('property: duplicating or retrying existing question instances never changes independent evidence', () => {
    const resultArb = fc.array(
      fc.tuple(fc.boolean(), fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 1 })),
      { minLength: 1, maxLength: 12 },
    );
    const extraArb = fc.array(
      fc.record({
        index: fc.nat(),
        laterHours: fc.integer({ min: 1, max: 48 }),
        attemptNumber: fc.integer({ min: 1, max: 4 }),
        hintsUsed: fc.integer({ min: 0, max: 2 }),
        correctness: fc.constantFrom(
          'correct' as const,
          'incorrect' as const,
          'unresolved' as const,
        ),
      }),
      { maxLength: 20 },
    );
    fc.assert(
      fc.property(resultArb, extraArb, (results, extras) => {
        const base = results.map(([correct, ago, hints], i) =>
          attempt({
            questionInstanceId: `q${i}`,
            occurredAt: daysAgo(ago + 3),
            hintsUsed: hints,
            correctness: correct ? 'correct' : 'incorrect',
          }),
        );
        const later = extras.map((extra, n) => {
          const target = base[extra.index % base.length]!;
          return attempt({
            id: `extra-${n}`,
            questionInstanceId: target.questionInstanceId,
            occurredAt: new Date(target.occurredAt.getTime() + extra.laterHours * 3_600_000),
            attemptNumber: extra.attemptNumber,
            hintsUsed: extra.hintsUsed,
            correctness: extra.correctness,
          });
        });
        const before = summarizeSkill(base, NOW);
        const after = summarizeSkill([...base, ...later], NOW);
        expect(after.distinctQuestions).toBe(before.distinctQuestions);
        expect(after.distinctIndependentQuestions).toBe(before.distinctIndependentQuestions);
        expect(after.independentCorrect).toBe(before.independentCorrect);
        expect(after.initialAccuracy).toBe(before.initialAccuracy);
        expect(after.weightedIndependentAccuracy).toBe(before.weightedIndependentAccuracy);
      }),
    );
  });
});

describe('AC_LEARNING_02 not enough evidence and multi-day mastery', () => {
  it('fewer than five distinct independent questions is "not enough evidence", however accurate', () => {
    const four = independentSeries([
      [true, 0],
      [true, 1],
      [true, 2],
      [true, 3],
    ]);
    const hinted = [10, 11, 12].map((i) =>
      attempt({ questionInstanceId: `h${i}`, occurredAt: daysAgo(1), hintsUsed: 2 }),
    );
    expect(summarizeSkill([...four, ...hinted], NOW).status).toBe('not_enough_evidence');
    const five = independentSeries([
      [true, 0],
      [true, 1],
      [true, 2],
      [true, 3],
      [true, 4],
    ]);
    expect(summarizeSkill(five, NOW).status).toBe('strong');
  });

  it('independent success on a single day is never "strong"', () => {
    const oneDay = independentSeries(
      Array.from({ length: 10 }, (_, i) => [true, i * 0.005] as const),
    );
    const summary = summarizeSkill(oneDay, NOW);
    expect(summary.weightedIndependentAccuracy).toBe(1);
    expect(summary.distinctIndependentDays).toBe(1);
    expect(summary.status).toBe('developing');

    const twoDays = independentSeries(
      Array.from({ length: 10 }, (_, i) => [true, i < 5 ? 0 : 1] as const),
    );
    expect(summarizeSkill(twoDays, NOW).status).toBe('strong');
  });

  it('counts days in the family time zone, so one evening session is one day', () => {
    // 23:30Z and 00:30Z are one evening (4:30 p.m. and 5:30 p.m.) in Los Angeles.
    const evening = [
      ...independentSeries([
        [true, 0],
        [true, 0],
        [true, 0],
      ]).map((e, i) => ({ ...e, occurredAt: new Date(`2026-09-22T23:3${i}:00Z`) })),
      ...independentSeries(
        [
          [true, 0],
          [true, 0],
          [true, 0],
        ],
        {},
        'late',
      ).map((e, i) => ({ ...e, occurredAt: new Date(`2026-09-23T00:3${i}:00Z`) })),
    ];
    expect(summarizeSkill(evening, NOW).distinctIndependentDays).toBe(2);
    const local = summarizeSkill(evening, NOW, { timeZone: 'America/Los_Angeles' });
    expect(local.distinctIndependentDays).toBe(1);
    expect(local.status).toBe('developing');
  });

  it('"strong" also requires independent practice within the last 30 days', () => {
    const stale = independentSeries(
      Array.from({ length: 8 }, (_, i) => [true, 31 + (i % 2)] as const),
    );
    expect(summarizeSkill(stale, NOW).status).toBe('developing');
    const recent = independentSeries(
      Array.from({ length: 8 }, (_, i) => [true, 29 + (i % 2)] as const),
    );
    expect(summarizeSkill(recent, NOW).status).toBe('strong');
  });

  it('"needs practice" requires low accuracy and errors on two instances across two days', () => {
    const spread = independentSeries([
      [true, 0],
      [false, 0],
      [false, 0],
      [false, 1],
      [false, 1],
    ]);
    expect(summarizeSkill(spread, NOW).status).toBe('needs_practice');
    const oneBadDay = independentSeries([
      [true, 0.1],
      [false, 0],
      [false, 0],
      [false, 0],
      [false, 0],
    ]);
    const summary = summarizeSkill(oneBadDay, NOW);
    expect(summary.weightedIndependentAccuracy).toBeLessThan(0.6);
    expect(summary.status).toBe('developing');
  });

  it('status rules are the transparent published thresholds, and "mastered" is not a status', () => {
    expect(SKILL_STATUS_RULES).toEqual({
      minDistinctIndependentQuestions: 5,
      needsPracticeAccuracyBelow: 0.6,
      needsPracticeMinErrorInstances: 2,
      needsPracticeMinErrorDays: 2,
      strongAccuracyAtLeast: 0.85,
      strongMinCorrectDays: 2,
      strongMaxDaysSinceIndependentPractice: 30,
    });
    expect(SKILL_STATUSES).not.toContain('mastered');
    expect(DEFAULT_RECENCY_HALF_LIFE_DAYS).toBe(14);
  });

  it('an AI confidence value on the input has no effect on status', () => {
    const events = independentSeries([
      [true, 0],
      [false, 0],
      [true, 0],
    ]);
    const withConfidence = events.map((e) => ({ ...e, aiConfidence: 1, confidence: 1 }));
    expect(summarizeSkill(withConfidence, NOW)).toEqual(summarizeSkill(events, NOW));
    expect(summarizeSkill(withConfidence, NOW).status).toBe('not_enough_evidence');
  });
});

describe('P7 weighting and exclusions', () => {
  it('uses exponential recency weights with a 14-day half-life by default', () => {
    const events = independentSeries([
      [true, 0],
      [false, 14],
    ]);
    expect(summarizeSkill(events, NOW).weightedIndependentAccuracy).toBeCloseTo(1 / 1.5, 12);
    expect(
      summarizeSkill(events, NOW, { halfLifeDays: 7 }).weightedIndependentAccuracy,
    ).toBeCloseTo(1 / 1.25, 12);
  });

  it('unresolved attempts are neither right nor wrong', () => {
    const graded = independentSeries([
      [true, 0],
      [false, 1],
      [true, 2],
      [true, 3],
      [false, 4],
    ]);
    const unresolved = [
      attempt({ questionInstanceId: 'u1', occurredAt: daysAgo(1), correctness: 'unresolved' }),
      attempt({ questionInstanceId: 'u2', occurredAt: daysAgo(2), correctness: 'unresolved' }),
      attempt({ questionInstanceId: 'qi-0', occurredAt: daysAgo(0.5), correctness: 'unresolved' }),
    ];
    const before = summarizeSkill(graded, NOW);
    const after = summarizeSkill([...graded, ...unresolved], NOW);
    expect(after.distinctIndependentQuestions).toBe(before.distinctIndependentQuestions);
    expect(after.weightedIndependentAccuracy).toBe(before.weightedIndependentAccuracy);
    expect(after.initialAccuracy).toBe(before.initialAccuracy);
    expect(after.eventualCompletionRate).toBe(before.eventualCompletionRate);
    expect(after.status).toBe(before.status);
  });

  it('a clearer resubmission of an unresolved first attempt is the first graded try', () => {
    const events = [
      attempt({ questionInstanceId: 'q', occurredAt: daysAgo(1), correctness: 'unresolved' }),
      attempt({ questionInstanceId: 'q', occurredAt: daysAgo(0.9), correctness: 'correct' }),
    ];
    expect(summarizeSkill(events, NOW).independentCorrect).toBe(1);
  });

  it('a hint seen before the first graded try makes that question non-independent', () => {
    const events = [
      attempt({
        questionInstanceId: 'q',
        occurredAt: daysAgo(1),
        hintsUsed: 1,
        correctness: 'unresolved',
      }),
      attempt({ questionInstanceId: 'q', occurredAt: daysAgo(0.9), correctness: 'correct' }),
    ];
    expect(summarizeSkill(events, NOW).distinctIndependentQuestions).toBe(0);
  });

  it('orders same-instant events by attempt number, so a retry never hides the initial try', () => {
    const at = daysAgo(1);
    const events = [
      attempt({ id: 'a-retry', questionInstanceId: 'q', occurredAt: at, attemptNumber: 2 }),
      attempt({
        id: 'b-initial',
        questionInstanceId: 'q',
        occurredAt: at,
        correctness: 'incorrect',
      }),
    ];
    const summary = summarizeSkill(events, NOW);
    expect(summary.distinctIndependentQuestions).toBe(1);
    expect(summary.independentIncorrect).toBe(1);
  });

  it('is an as-of summary: events and overrides after `now` are ignored', () => {
    const events = [
      ...independentSeries([
        [true, 2],
        [true, 3],
      ]),
      attempt({ questionInstanceId: 'future', occurredAt: new Date(NOW.getTime() + DAY_MS) }),
      attempt({
        questionInstanceId: 'q-over',
        occurredAt: daysAgo(1),
        correctness: 'incorrect',
        parentOverride: { correctness: 'correct', overriddenAt: new Date(NOW.getTime() + 1) },
      }),
    ];
    const summary = summarizeSkill(events, NOW);
    expect(summary.distinctQuestions).toBe(3);
    expect(summary.independentCorrect).toBe(2);
    expect(summary.lastPracticedAt).toEqual(daysAgo(1));
  });

  it('applies parent overrides as the correctness of record', () => {
    const events = [
      attempt({
        questionInstanceId: 'q',
        occurredAt: daysAgo(1),
        correctness: 'incorrect',
        parentOverride: { correctness: 'correct', overriddenAt: daysAgo(0.5) },
      }),
    ];
    const summary = summarizeSkill(events, NOW);
    expect(summary.independentCorrect).toBe(1);
    expect(summary.initialAccuracy).toBe(1);
  });

  it('property: weighted accuracy is a proportion and order of events does not matter', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.boolean(), fc.integer({ min: 0, max: 120 })), {
          minLength: 1,
          maxLength: 15,
        }),
        fc.integer(),
        (results, seed) => {
          const events = independentSeries(results);
          const shuffled = [...events].sort(
            (a, b) => ((hash(a.id) ^ seed) >>> 0) - ((hash(b.id) ^ seed) >>> 0),
          );
          const summary = summarizeSkill(events, NOW);
          expect(summarizeSkill(shuffled, NOW)).toEqual(summary);
          const accuracy = summary.weightedIndependentAccuracy!;
          expect(accuracy).toBeGreaterThanOrEqual(0);
          expect(accuracy).toBeLessThanOrEqual(1);
          const anyCorrect = results.some(([c]) => c);
          const allCorrect = results.every(([c]) => c);
          if (!anyCorrect) expect(accuracy).toBe(0);
          if (allCorrect) expect(accuracy).toBe(1);
        },
      ),
    );
  });

  it('never mutates its input', () => {
    const events = frozen(
      independentSeries([
        [true, 0],
        [false, 1],
      ]),
    );
    const snapshot = structuredClone(events);
    summarizeSkill(events, NOW);
    expect(events).toEqual(snapshot);
  });
});

describe('summarizeSkill input contract', () => {
  it('rejects empty, mixed-skill and mixed-child input as programmer errors', () => {
    expect(() => summarizeSkill([], NOW)).toThrow(RangeError);
    const a = attempt({ questionInstanceId: 'a' });
    expect(() => summarizeSkill([a, { ...a, id: 'b', skill: 'math.decimals' }], NOW)).toThrow(
      RangeError,
    );
    expect(() => summarizeSkill([a, { ...a, id: 'c', childId: SAM }], NOW)).toThrow(RangeError);
    expect(() => summarizeSkill([a], new Date('invalid'))).toThrow(RangeError);
    expect(() => summarizeSkill([a], NOW, { halfLifeDays: 0 })).toThrow(RangeError);
    expect(() => summarizeSkill([a], NOW, { timeZone: 'Mars/Olympus' })).toThrow(RangeError);
  });

  it('treats a replayed event id as one event but rejects conflicting duplicates', () => {
    const a = attempt({ questionInstanceId: 'a' });
    expect(summarizeSkill([a, { ...a }], NOW).distinctQuestions).toBe(1);
    expect(() => summarizeSkill([a, { ...a, correctness: 'incorrect' }], NOW)).toThrow(RangeError);
  });

  it('summarizeSkills groups one child’s events by skill in skill-id order', () => {
    const events: AttemptEvent[] = [
      attempt({ questionInstanceId: 'r1', skill: 'reading.main-idea', subject: 'reading' }),
      attempt({ questionInstanceId: 'm1' }),
      attempt({ questionInstanceId: 'm2', correctness: 'incorrect' }),
    ];
    const summaries = summarizeSkills(events, NOW);
    expect(summaries.map((s) => [s.skill, s.subject, s.childId, s.distinctQuestions])).toEqual([
      ['math.fractions.add', 'math', RILEY, 2],
      ['reading.main-idea', 'reading', RILEY, 1],
    ]);
    expect(summarizeSkills([], NOW)).toEqual([]);
  });
});

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h;
}
