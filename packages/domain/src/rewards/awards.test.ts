import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REWARD_RULES,
  computeAwards,
  overrideAwards,
  type LearningEvent,
  type LedgerEntry,
  type RewardRules,
} from './index.ts';
import { RILEY, attemptEvent, errorCode, sumPoints, unwrap } from './test-fixtures.ts';

function awardsFor(
  event: LearningEvent,
  existing: readonly string[] = [],
  rules: RewardRules = DEFAULT_REWARD_RULES,
): readonly LedgerEntry[] {
  return unwrap(computeAwards(event, rules, new Set(existing)));
}

/** Feeds events through computeAwards the way the durable job does: keys accumulate. */
function processAll(
  events: readonly LearningEvent[],
  rules: RewardRules = DEFAULT_REWARD_RULES,
): LedgerEntry[] {
  const ledger: LedgerEntry[] = [];
  for (const event of events) {
    const keys = new Set(ledger.map((entry) => entry.idempotencyKey));
    ledger.push(...unwrap(computeAwards(event, rules, keys)));
  }
  return ledger;
}

describe('P9 earning rules (AC_REWARDS_01)', () => {
  it('a meaningful attempt earns effort points even when the answer is wrong', () => {
    const entries = awardsFor(attemptEvent({ independentCorrect: false }));
    expect(entries).toEqual([
      {
        idempotencyKey: 'attempt:qi-1',
        childId: RILEY,
        kind: 'award',
        points: 2,
        reason: 'practice_attempt',
        actor: 'system',
      },
    ]);
  });

  it('an independently correct response earns the 3-point bonus on top (5 total)', () => {
    const entries = awardsFor(attemptEvent({ independentCorrect: true }));
    expect(entries.map((entry) => [entry.idempotencyKey, entry.points])).toEqual([
      ['attempt:qi-1', 2],
      ['independent:qi-1', 3],
    ]);
  });

  it('completing a set earns 5 points, once per set', () => {
    const event: LearningEvent = { kind: 'set_completed', childId: RILEY, setId: 'set-mon' };
    expect(awardsFor(event)).toEqual([
      {
        idempotencyKey: 'set:set-mon',
        childId: RILEY,
        kind: 'award',
        points: 5,
        reason: 'set_completed',
        actor: 'system',
      },
    ]);
    expect(awardsFor(event, ['set:set-mon'])).toEqual([]);
  });

  it('uses the family-configured amounts', () => {
    const rules = { ...DEFAULT_REWARD_RULES, attemptPoints: 4, independentCorrectBonus: 6 };
    expect(sumPoints(awardsFor(attemptEvent({ independentCorrect: true }), [], rules))).toBe(10);
  });

  it('never copies the child answer text into the ledger (privacy)', () => {
    const entries = awardsFor(attemptEvent({ answerText: 'Riley-secret-answer-7' }));
    expect(JSON.stringify(entries)).not.toContain('Riley-secret-answer');
  });
});

describe('anti-farming: empty and rapid guesses earn nothing (AC_REWARDS_01)', () => {
  it.each([
    ['empty', ''],
    ['spaces', '    '],
    ['tabs and newlines', '\t\n\r\n'],
    ['non-breaking space', '  '],
    ['zero-width space', '​​'],
    ['question mark', '?'],
    ['ellipsis', '...'],
    ['dashes', '-- -'],
    ['mixed punctuation', '¿¡!?.,;:"\'()[]'],
    ['emoji only', '👍🙂'],
  ])('a %s answer earns no points', (_label, answerText) => {
    expect(awardsFor(attemptEvent({ answerText, independentCorrect: true }))).toEqual([]);
  });

  it.each(['7', 'x', 'B', '½', 'π', '<', '=', '3/4', '-2', '١٢'])(
    'a short but meaningful answer %s earns effort points',
    (answerText) => {
      expect(sumPoints(awardsFor(attemptEvent({ answerText })))).toBe(2);
    },
  );

  it('a response faster than minMeaningfulResponseMs earns nothing; exactly the minimum earns', () => {
    expect(awardsFor(attemptEvent({ responseTimeMs: 1499, independentCorrect: true }))).toEqual([]);
    expect(sumPoints(awardsFor(attemptEvent({ responseTimeMs: 1500 })))).toBe(2);
  });

  it('a farmed (empty) attempt does not use up the instance: a later real attempt still earns', () => {
    const ledger = processAll([
      attemptEvent({ answerText: '   ' }),
      attemptEvent({ answerText: '12', independentCorrect: true }),
    ]);
    expect(sumPoints(ledger)).toBe(5);
  });

  it('retries of the same question instance never award again, even when the retry is correct', () => {
    const ledger = processAll([
      attemptEvent({ answerText: '11', independentCorrect: false }),
      attemptEvent({ answerText: '12', independentCorrect: true }),
      attemptEvent({ answerText: '12', independentCorrect: true }),
    ]);
    expect(ledger.map((entry) => entry.idempotencyKey)).toEqual(['attempt:qi-1']);
    expect(sumPoints(ledger)).toBe(2);
  });

  it('with attemptPoints = 0 a wrong first attempt still consumes the instance (no bonus on retry)', () => {
    const rules = { ...DEFAULT_REWARD_RULES, attemptPoints: 0 };
    const ledger = processAll(
      [attemptEvent({ independentCorrect: false }), attemptEvent({ independentCorrect: true })],
      rules,
    );
    expect(ledger.map((entry) => [entry.idempotencyKey, entry.points])).toEqual([
      ['attempt:qi-1', 0],
    ]);
  });

  it('property: however a child hammers one question instance, it earns at most attempt + bonus', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            answerText: fc.oneof(fc.constantFrom('', ' ', '?', '...', '5', 'ten'), fc.string()),
            responseTimeMs: fc.integer({ min: 0, max: 10_000 }),
            independentCorrect: fc.boolean(),
          }),
          { maxLength: 40 },
        ),
        (attempts) => {
          const ledger = processAll(attempts.map((fields) => attemptEvent(fields)));
          expect(sumPoints(ledger)).toBeLessThanOrEqual(
            DEFAULT_REWARD_RULES.attemptPoints + DEFAULT_REWARD_RULES.independentCorrectBonus,
          );
          expect(ledger.length).toBeLessThanOrEqual(2);
          expect(new Set(ledger.map((entry) => entry.idempotencyKey)).size).toBe(ledger.length);
        },
      ),
    );
  });
});

describe('P5: duplicate upload/resume events do not double-award', () => {
  it('re-delivering the same practice attempt awards nothing the second time', () => {
    const event = attemptEvent({ independentCorrect: true });
    const ledger = processAll([event, event, event]);
    expect(sumPoints(ledger)).toBe(5);
  });

  it('property: replaying any batch of learning events adds no entries', () => {
    const eventArb: fc.Arbitrary<LearningEvent> = fc.oneof(
      fc.record({
        kind: fc.constant('practice_attempt' as const),
        childId: fc.constant(RILEY),
        questionInstanceId: fc.constantFrom('qi-1', 'qi-2', 'qi-3'),
        answerText: fc.constantFrom('', '4', 'nine', '!!'),
        responseTimeMs: fc.integer({ min: 0, max: 5_000 }),
        independentCorrect: fc.boolean(),
      }),
      fc.record({
        kind: fc.constant('set_completed' as const),
        childId: fc.constant(RILEY),
        setId: fc.constantFrom('set-a', 'set-b'),
      }),
    );
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 30 }), (events) => {
        const once = processAll(events);
        const twice = processAll([...events, ...events]);
        expect(twice).toEqual(once);
      }),
    );
  });
});

describe('P16.4: monetization activity can never award points (AC_MON_13)', () => {
  it.each([
    'ad_impression',
    'affiliate_click',
    'sponsor_click',
    'purchase',
    'referral',
    'affiliate_purchase',
    'workbook_purchase',
  ])('rejects a %s event with MONETIZATION_EVENT_CANNOT_AWARD', (kind) => {
    // Untyped input from a queue/webhook can claim any kind and carry learning-shaped fields.
    const untrusted = {
      ...attemptEvent({ independentCorrect: true }),
      setId: 'set-mon',
      kind,
    } as unknown as LearningEvent;
    expect(errorCode(computeAwards(untrusted, DEFAULT_REWARD_RULES, new Set()))).toBe(
      'MONETIZATION_EVENT_CANNOT_AWARD',
    );
  });

  it.each([
    '__proto__',
    'constructor',
    'toString',
    'PRACTICE_ATTEMPT',
    ' practice_attempt',
    'bonus',
  ])('fails closed for any other event kind %j (allowlist, not denylist)', (kind) => {
    const untrusted = { ...attemptEvent(), kind } as unknown as LearningEvent;
    expect(errorCode(computeAwards(untrusted, DEFAULT_REWARD_RULES, new Set()))).toBe(
      'MONETIZATION_EVENT_CANNOT_AWARD',
    );
  });

  it('monetization events are not representable as a LearningEvent at compile time', () => {
    const result = computeAwards(
      // @ts-expect-error -- an ad impression is not a learning event
      { kind: 'ad_impression', childId: RILEY },
      DEFAULT_REWARD_RULES,
      new Set<string>(),
    );
    expect(result.ok).toBe(false);
  });

  it('does not accept a learning kind inherited through the prototype chain', () => {
    const sneaky = Object.create({ kind: 'set_completed' }) as Record<string, unknown>;
    sneaky.childId = RILEY;
    sneaky.setId = 'set-a';
    expect(computeAwards(sneaky as unknown as LearningEvent, DEFAULT_REWARD_RULES, []).ok).toBe(
      false,
    );
  });
});

describe('untrusted learning events are validated before awarding', () => {
  it.each([
    ['NaN response time (would slip past a < comparison)', { responseTimeMs: Number.NaN }],
    ['negative response time', { responseTimeMs: -1 }],
    ['infinite response time', { responseTimeMs: Number.POSITIVE_INFINITY }],
    ['string response time', { responseTimeMs: '4000' }],
    ['string independentCorrect', { independentCorrect: 'true' }],
    ['non-string answer', { answerText: 42 }],
    ['empty question instance id', { questionInstanceId: '' }],
    ['question id containing a key separator', { questionInstanceId: 'qi:1' }],
    ['missing child id', { childId: undefined }],
  ])('rejects %s with INVALID_EVENT', (_label, patch) => {
    const untrusted = { ...attemptEvent(), ...patch } as unknown as LearningEvent;
    expect(errorCode(computeAwards(untrusted, DEFAULT_REWARD_RULES, []))).toBe('INVALID_EVENT');
  });

  it.each([null, undefined, 'practice_attempt', 3, [], { childId: RILEY }])(
    'rejects a non-event %j with INVALID_EVENT',
    (value) => {
      expect(
        errorCode(computeAwards(value as unknown as LearningEvent, DEFAULT_REWARD_RULES, [])),
      ).toBe('INVALID_EVENT');
    },
  );

  it('treats unvalidated rules as a programmer error', () => {
    const broken = { ...DEFAULT_REWARD_RULES, attemptPoints: -2 };
    expect(() => computeAwards(attemptEvent(), broken, [])).toThrow(RangeError);
  });
});

describe('grading overrides never claw back earned points (AC_GRADING_10, P5)', () => {
  const earned = ['attempt:qi-1', 'independent:qi-1'];

  it('overriding a correct answer to incorrect returns no entries: earned points stay', () => {
    expect(
      overrideAwards(
        { childId: RILEY, questionInstanceId: 'qi-1', independentCorrect: false },
        DEFAULT_REWARD_RULES,
        new Set(earned),
      ),
    ).toEqual([]);
  });

  it('overriding an incorrect answer to independently correct grants the missing bonus once', () => {
    const override = { childId: RILEY, questionInstanceId: 'qi-1', independentCorrect: true };
    const first = overrideAwards(override, DEFAULT_REWARD_RULES, new Set(['attempt:qi-1']));
    expect(first).toEqual([
      {
        idempotencyKey: 'independent:qi-1',
        childId: RILEY,
        kind: 'award',
        points: 3,
        reason: 'grading_override',
        actor: 'system',
      },
    ]);
    const keys = new Set(['attempt:qi-1', ...first.map((entry) => entry.idempotencyKey)]);
    expect(overrideAwards(override, DEFAULT_REWARD_RULES, keys)).toEqual([]);
  });

  it('an override cannot turn a farmed (never-awarded) attempt into points', () => {
    expect(
      overrideAwards(
        { childId: RILEY, questionInstanceId: 'qi-9', independentCorrect: true },
        DEFAULT_REWARD_RULES,
        new Set<string>(),
      ),
    ).toEqual([]);
  });

  it('property: overrideAwards never returns a negative entry or reuses an existing key', () => {
    fc.assert(
      fc.property(
        fc.subarray(['attempt:qi-1', 'independent:qi-1', 'attempt:qi-2', 'set:set-a']),
        fc.constantFrom('qi-1', 'qi-2', 'qi-3'),
        fc.boolean(),
        (existing, questionInstanceId, independentCorrect) => {
          const entries = overrideAwards(
            { childId: RILEY, questionInstanceId, independentCorrect },
            DEFAULT_REWARD_RULES,
            new Set(existing),
          );
          for (const entry of entries) {
            expect(entry.points).toBeGreaterThanOrEqual(0);
            expect(entry.kind).toBe('award');
            expect(existing).not.toContain(entry.idempotencyKey);
          }
        },
      ),
    );
  });
});
