// AC_GRADING_10: a parent grading override is audited and changes learning evidence (by
// recomputation) without mutating the original immutable attempt.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { recomputeAfterOverride, summarizeSkill, type AttemptEvent } from './index.ts';
import { NOW, RILEY, SAM, attempt, daysAgo, errorCode, frozen, unwrap } from './test-fixtures.ts';

function fractionsEvents(): AttemptEvent[] {
  return [
    attempt({
      id: 'e1',
      questionInstanceId: 'q1',
      occurredAt: daysAgo(3),
      correctness: 'incorrect',
    }),
    attempt({ id: 'e2', questionInstanceId: 'q2', occurredAt: daysAgo(3) }),
    attempt({ id: 'e3', questionInstanceId: 'q3', occurredAt: daysAgo(2) }),
    attempt({ id: 'e4', questionInstanceId: 'q4', occurredAt: daysAgo(2) }),
    attempt({ id: 'e5', questionInstanceId: 'q5', occurredAt: daysAgo(1) }),
    attempt({
      id: 'r1',
      questionInstanceId: 'rq1',
      skill: 'reading.main-idea',
      subject: 'reading',
      occurredAt: daysAgo(1),
    }),
  ];
}

describe('AC_GRADING_10 recomputeAfterOverride', () => {
  it('recomputes only the affected skill and records an audit of the change', () => {
    const events = frozen(fractionsEvents());
    const snapshot = structuredClone(events);
    const before = summarizeSkill(
      events.filter((e) => e.skill === 'math.fractions.add'),
      NOW,
    );
    expect(before.independentCorrect).toBe(4);

    const result = unwrap(
      recomputeAfterOverride(
        events,
        { eventId: 'e1', correctness: 'correct', overriddenAt: daysAgo(0.5) },
        NOW,
      ),
    );
    expect(result.summaries.map((s) => s.skill)).toEqual(['math.fractions.add']);
    expect(result.summaries[0]!.independentCorrect).toBe(5);
    expect(result.summaries[0]!.status).toBe('strong');
    expect(result.audit).toEqual({
      eventId: 'e1',
      childId: RILEY,
      questionInstanceId: 'q1',
      skill: 'math.fractions.add',
      graderCorrectness: 'incorrect',
      previousCorrectness: 'incorrect',
      newCorrectness: 'correct',
      overriddenAt: daysAgo(0.5),
    });
    // The original event is untouched; the override lives on a new copy.
    expect(events).toEqual(snapshot);
    expect(result.overriddenEvent.correctness).toBe('incorrect');
    expect(result.overriddenEvent.parentOverride).toEqual({
      correctness: 'correct',
      overriddenAt: daysAgo(0.5),
    });
    expect(result.events.find((e) => e.id === 'e1')).toBe(result.overriddenEvent);
    expect(result.events.filter((e) => e.id !== 'e1')).toEqual(events.filter((e) => e.id !== 'e1'));
  });

  it('an override to "unresolved" removes the item from evidence without counting it wrong', () => {
    const result = unwrap(
      recomputeAfterOverride(
        fractionsEvents(),
        { eventId: 'e1', correctness: 'unresolved', overriddenAt: daysAgo(0.5) },
        NOW,
      ),
    );
    expect(result.summaries[0]!.distinctIndependentQuestions).toBe(4);
    expect(result.summaries[0]!.independentCorrect).toBe(4);
  });

  it('a later override supersedes an earlier one; an older or same-time one is rejected', () => {
    const first = unwrap(
      recomputeAfterOverride(
        fractionsEvents(),
        { eventId: 'e1', correctness: 'correct', overriddenAt: daysAgo(0.5) },
        NOW,
      ),
    );
    const second = unwrap(
      recomputeAfterOverride(
        first.events,
        { eventId: 'e1', correctness: 'incorrect', overriddenAt: daysAgo(0.25) },
        NOW,
      ),
    );
    expect(second.audit.previousCorrectness).toBe('correct');
    expect(second.summaries[0]!.independentCorrect).toBe(4);
    expect(
      errorCode(
        recomputeAfterOverride(
          first.events,
          { eventId: 'e1', correctness: 'incorrect', overriddenAt: daysAgo(0.5) },
          NOW,
        ),
      ),
    ).toBe('STALE_OVERRIDE');
  });

  it.each([
    [
      'unknown event',
      { eventId: 'nope', correctness: 'correct', overriddenAt: NOW },
      'EVENT_NOT_FOUND',
    ],
    [
      'before the attempt',
      { eventId: 'e1', correctness: 'correct', overriddenAt: daysAgo(4) },
      'OVERRIDE_BEFORE_ATTEMPT',
    ],
    [
      'in the future',
      { eventId: 'e1', correctness: 'correct', overriddenAt: new Date(NOW.getTime() + 1) },
      'OVERRIDE_IN_FUTURE',
    ],
    [
      'invalid correctness',
      { eventId: 'e1', correctness: 'maybe', overriddenAt: NOW },
      'INVALID_OVERRIDE',
    ],
    [
      'invalid date',
      { eventId: 'e1', correctness: 'correct', overriddenAt: new Date('x') },
      'INVALID_OVERRIDE',
    ],
  ] as const)('rejects an override %s', (_label, override, code) => {
    expect(errorCode(recomputeAfterOverride(fractionsEvents(), override as never, NOW))).toBe(code);
  });

  it('summarizes only the overridden child’s evidence when events include a sibling', () => {
    const events = [
      ...fractionsEvents(),
      {
        ...attempt({ questionInstanceId: 'sam-q', correctness: 'incorrect' }),
        id: 's1',
        childId: SAM,
      },
    ];
    const result = unwrap(
      recomputeAfterOverride(
        events,
        { eventId: 'e1', correctness: 'correct', overriddenAt: NOW },
        NOW,
      ),
    );
    expect(result.summaries[0]!.childId).toBe(RILEY);
    expect(result.summaries[0]!.distinctQuestions).toBe(5);
  });

  it('property: recomputation equals summarizing from scratch with the override applied', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4 }),
        fc.constantFrom('correct' as const, 'incorrect' as const, 'unresolved' as const),
        (index, correctness) => {
          const events = fractionsEvents();
          const target = events[index]!;
          const overriddenAt = daysAgo(0.1);
          const result = unwrap(
            recomputeAfterOverride(events, { eventId: target.id, correctness, overriddenAt }, NOW),
          );
          const expected = summarizeSkill(
            events
              .filter((e) => e.skill === target.skill)
              .map((e) =>
                e.id === target.id ? { ...e, parentOverride: { correctness, overriddenAt } } : e,
              ),
            NOW,
          );
          expect(result.summaries).toEqual([expected]);
        },
      ),
    );
  });
});
