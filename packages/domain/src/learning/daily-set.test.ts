// P7 daily extra credit composition, AC_LEARNING_04 (and the composition side of AC_LEARNING_05).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DAILY_SET_COUNT,
  composeDailySet,
  dailyMix,
  type CandidateItem,
  type DailySetInput,
  type ItemCategory,
} from './index.ts';
import { errorCode, unwrap } from './test-fixtures.ts';

function bank(skill: string, count: number, category: ItemCategory = 'standard'): CandidateItem[] {
  return Array.from({ length: count }, (_, i) => ({
    templateKey: `${skill}#${category}#${i}`,
    skill,
    category,
  }));
}

function input(overrides: Partial<DailySetInput> = {}): DailySetInput {
  return {
    weakSkills: ['w1', 'w2', 'w3'],
    spacedReviewSkills: ['s1'],
    confidenceSkills: ['c1'],
    gradeFallbackSkills: ['g1'],
    recentlyUsedTemplateKeys: new Set(),
    candidateItems: [
      ...['w1', 'w2', 'w3', 's1', 'g1', 'p1', 'm1'].flatMap((s) => bank(s, 4)),
      ...bank('c1', 2),
      ...bank('c1', 2, 'accessible'),
    ],
    ...overrides,
  };
}

describe('AC_LEARNING_04 60/20/20 mix with short-set rounding', () => {
  it('produces exactly the documented table for 3..10 questions', () => {
    const table = Object.fromEntries(
      [3, 4, 5, 6, 7, 8, 9, 10].map((n) => {
        const mix = dailyMix(n);
        return [n, `${mix.weak}/${mix.spaced}/${mix.confidence}`];
      }),
    );
    expect(table).toEqual({
      3: '1/1/1',
      4: '2/1/1',
      5: '3/1/1',
      6: '4/1/1',
      7: '4/2/1',
      8: '5/2/1',
      9: '5/2/2',
      10: '6/2/2',
    });
  });

  it('property: every allowed size sums to the count and always includes a confidence item', () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 10 }), (n) => {
        const mix = dailyMix(n);
        expect(mix.weak + mix.spaced + mix.confidence).toBe(n);
        expect(mix.confidence).toBeGreaterThanOrEqual(1);
        expect(mix.weak).toBeGreaterThanOrEqual(mix.spaced);
        expect(mix.spaced).toBeGreaterThanOrEqual(mix.confidence);
      }),
    );
  });

  it('defaults to five questions and accepts only integers 3..10', () => {
    expect(DEFAULT_DAILY_SET_COUNT).toBe(5);
    const set = unwrap(composeDailySet(input()));
    expect(set.count).toBe(5);
    expect(set.items).toHaveLength(5);
    for (const count of [2, 11, 4.5, Number.NaN]) {
      expect(errorCode(composeDailySet(input({ count })))).toBe('INVALID_COUNT');
    }
  });

  it('fills weak, spaced and confidence slots from their own pools when evidence exists', () => {
    const set = unwrap(composeDailySet(input()));
    expect(set.mode).toBe('adaptive');
    expect(set.mix).toEqual({ weak: 3, spaced: 1, confidence: 1, diagnostic: 0 });
    expect(set.items.map((i) => [i.slot, i.source, i.skill])).toEqual([
      ['weak', 'weak', 'w1'],
      ['weak', 'weak', 'w2'],
      ['weak', 'weak', 'w3'],
      ['spaced', 'spaced_review', 's1'],
      ['confidence', 'confidence', 'c1'],
    ]);
    // Confidence-building practice prefers accessible items.
    expect(set.items[4]!.category).toBe('accessible');
    expect(set.notes).toEqual([]);
  });

  it('gives the most urgent weak skills more questions in longer sets', () => {
    const set = unwrap(composeDailySet(input({ count: 10, weakSkills: ['w1', 'w2'] })));
    const weakSkills = set.items.filter((i) => i.slot === 'weak').map((i) => i.skill);
    expect(weakSkills).toEqual(['w1', 'w2', 'w1', 'w2', 'w1', 'w2']);
  });
});

describe('AC_LEARNING_04 shortfalls and fallbacks', () => {
  it('backfills weak shortfalls with prerequisites, then current material, and says so', () => {
    const set = unwrap(
      composeDailySet(
        input({
          count: 10,
          weakSkills: ['w1'],
          prerequisiteSkills: ['p1'],
          currentMaterialSkills: ['m1'],
        }),
      ),
    );
    expect(set.items.filter((i) => i.slot === 'weak').map((i) => [i.skill, i.source])).toEqual([
      ['w1', 'weak'],
      ['w1', 'weak'],
      ['p1', 'prerequisite'],
      ['m1', 'current_material'],
      ['w1', 'weak'],
      ['w1', 'weak'],
    ]);
    expect(set.notes).toEqual([
      { code: 'BACKFILLED', slot: 'weak', source: 'prerequisite', count: 1 },
      { code: 'BACKFILLED', slot: 'weak', source: 'current_material', count: 1 },
    ]);
  });

  it('falls back to grade-level practice once weak, prerequisite and current items run out', () => {
    const set = unwrap(
      composeDailySet(
        input({
          weakSkills: ['w1'],
          candidateItems: [...bank('w1', 1), ...bank('s1', 2), ...bank('c1', 2), ...bank('g1', 5)],
        }),
      ),
    );
    expect(set.items.filter((i) => i.slot === 'weak').map((i) => i.source)).toEqual([
      'weak',
      'grade_fallback',
      'grade_fallback',
    ]);
    expect(set.notes).toContainEqual({
      code: 'BACKFILLED',
      slot: 'weak',
      source: 'grade_fallback',
      count: 2,
    });
  });

  it('with no history, runs a brief grade-level diagnostic from the parent-selected grade', () => {
    const set = unwrap(
      composeDailySet(
        input({
          weakSkills: [],
          spacedReviewSkills: [],
          confidenceSkills: [],
          gradeFallbackSkills: ['g1', 'g2'],
          candidateItems: [
            ...bank('g1', 3, 'diagnostic'),
            ...bank('g2', 3, 'diagnostic'),
            ...bank('g1', 3),
          ],
        }),
      ),
    );
    expect(set.mode).toBe('grade_diagnostic');
    expect(set.items).toHaveLength(5);
    expect(set.mix).toEqual({ weak: 0, spaced: 0, confidence: 0, diagnostic: 5 });
    expect(set.items.every((i) => i.slot === 'diagnostic')).toBe(true);
    expect(new Set(set.items.map((i) => i.skill))).toEqual(new Set(['g1', 'g2']));
    expect(set.items.every((i) => i.source === 'grade_fallback')).toBe(true);
    expect(set.items.every((i) => i.category === 'diagnostic')).toBe(true);
    expect(set.notes).toEqual([{ code: 'NO_HISTORY_GRADE_DIAGNOSTIC', count: 5 }]);
  });

  it('reports a short set instead of inventing content when candidates run out', () => {
    const set = unwrap(
      composeDailySet(input({ count: 5, candidateItems: [...bank('w1', 1), ...bank('c1', 1)] })),
    );
    expect(set.items).toHaveLength(2);
    expect(set.notes).toContainEqual({ code: 'INSUFFICIENT_CANDIDATES', count: 3 });
  });

  it('rejects compositions with no skills or no usable candidates', () => {
    expect(
      errorCode(
        composeDailySet(
          input({
            weakSkills: [],
            spacedReviewSkills: [],
            confidenceSkills: [],
            gradeFallbackSkills: [],
          }),
        ),
      ),
    ).toBe('NO_SKILLS_AVAILABLE');
    expect(errorCode(composeDailySet(input({ candidateItems: bank('zz', 3) })))).toBe(
      'NO_CANDIDATE_ITEMS',
    );
    expect(
      errorCode(
        composeDailySet(
          input({
            candidateItems: [{ templateKey: 'x', skill: 'w1', category: 'hard' as ItemCategory }],
          }),
        ),
      ),
    ).toBe('INVALID_CANDIDATE');
    expect(
      errorCode(
        composeDailySet(
          input({ candidateItems: [{ templateKey: '', skill: 'w1', category: 'standard' }] }),
        ),
      ),
    ).toBe('INVALID_CANDIDATE');
  });
});

describe('P7 no repeats of recently used templates', () => {
  it('prefers a fresh template of the same skill over a recently used one', () => {
    const set = unwrap(
      composeDailySet(
        input({ recentlyUsedTemplateKeys: new Set(['w1#standard#0', 'w1#standard#1']) }),
      ),
    );
    expect(set.items[0]!.templateKey).toBe('w1#standard#2');
    expect(set.items.some((i) => i.reusedRecentTemplate)).toBe(false);
  });

  it('reuses a recent template only when no alternative exists, and notes it', () => {
    const candidateItems = [...bank('w1', 1), ...bank('s1', 1), ...bank('c1', 1)];
    const set = unwrap(
      composeDailySet(
        input({
          count: 3,
          weakSkills: ['w1'],
          gradeFallbackSkills: [],
          candidateItems,
          recentlyUsedTemplateKeys: new Set(['w1#standard#0']),
        }),
      ),
    );
    expect(set.items.map((i) => i.templateKey)).toEqual([
      'w1#standard#0',
      's1#standard#0',
      'c1#standard#0',
    ]);
    expect(set.items[0]!.reusedRecentTemplate).toBe(true);
    expect(set.notes).toContainEqual({ code: 'RECENT_TEMPLATE_REUSED', count: 1 });
  });

  it('property: never repeats a recent template while a fresh relevant one is unused; no duplicates', () => {
    const skills = ['w1', 'w2', 's1', 'c1', 'g1', 'p1'] as const;
    const itemArb = fc.record({
      templateKey: fc.constantFrom(...Array.from({ length: 24 }, (_, i) => `t${i}`)),
      skill: fc.constantFrom(...skills),
      category: fc.constantFrom<ItemCategory>('standard', 'accessible', 'diagnostic'),
    });
    fc.assert(
      fc.property(
        fc.array(itemArb, { maxLength: 30 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 23 }), { maxLength: 24 }),
        fc.integer({ min: 3, max: 10 }),
        (items, recentIdx, count) => {
          const recent = new Set(recentIdx.map((i) => `t${i}`));
          const result = composeDailySet(
            input({
              count,
              weakSkills: ['w1', 'w2'],
              prerequisiteSkills: ['p1'],
              candidateItems: items,
              recentlyUsedTemplateKeys: recent,
            }),
          );
          if (!result.ok) {
            expect(result.error.code).toBe('NO_CANDIDATE_ITEMS');
            return;
          }
          const chosen = result.value.items.map((i) => i.templateKey);
          expect(new Set(chosen).size).toBe(chosen.length);
          expect(chosen.length).toBeLessThanOrEqual(count);
          const mix = result.value.mix;
          expect(mix.weak + mix.spaced + mix.confidence + mix.diagnostic).toBe(chosen.length);
          const firstByKey = new Map<string, CandidateItem>();
          for (const item of items)
            if (!firstByKey.has(item.templateKey)) firstByKey.set(item.templateKey, item);
          const unusedFresh = [...firstByKey.values()].filter(
            (c) => !recent.has(c.templateKey) && !chosen.includes(c.templateKey),
          );
          if (result.value.items.some((i) => i.reusedRecentTemplate)) {
            expect(unusedFresh).toEqual([]);
          }
          for (const item of result.value.items) {
            expect(item.reusedRecentTemplate).toBe(recent.has(item.templateKey));
          }
        },
      ),
    );
  });
});

describe("RV-learning-4 the confidence slot is not starved by other slots' backfill", () => {
  it('property: an empty confidence slot means no other slot took an item it could have used', () => {
    const skills = ['w1', 'w2', 's1', 'c1', 'g1', 'p1'] as const;
    const itemArb = fc.record({
      templateKey: fc.constantFrom(...Array.from({ length: 16 }, (_, i) => `t${i}`)),
      skill: fc.constantFrom(...skills),
      category: fc.constantFrom<ItemCategory>('standard', 'accessible'),
    });
    fc.assert(
      fc.property(
        fc.array(itemArb, { maxLength: 16 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 15 }), { maxLength: 16 }),
        fc.integer({ min: 3, max: 10 }),
        (items, recentIdx, count) => {
          const result = composeDailySet(
            input({
              count,
              weakSkills: ['w1', 'w2'],
              prerequisiteSkills: ['p1'],
              candidateItems: items,
              recentlyUsedTemplateKeys: new Set(recentIdx.map((i) => `t${i}`)),
            }),
          );
          if (!result.ok || result.value.mix.confidence > 0) return;
          // Grade-level and spaced-review items are confidence candidates (its chain is
          // confidence -> spaced -> grade), so only the slots' own pools may hold them.
          for (const item of result.value.items) {
            const ownPool =
              ['weak', 'prerequisite', 'current_material'].includes(item.source) ||
              (item.slot === 'spaced' && item.source === 'spaced_review');
            expect(ownPool).toBe(true);
          }
        },
      ),
    );
  });

  it('takes the guaranteed confidence item from the weak slot, preferring an accessible item', () => {
    // Four questions (2/1/1) but only three items: the weak slot's grade fallback used to take
    // both grade items, leaving the confidence slot empty.
    const set = unwrap(
      composeDailySet(
        input({
          count: 4,
          weakSkills: ['w1'],
          candidateItems: [...bank('g1', 1), ...bank('g1', 1, 'accessible'), ...bank('s1', 1)],
        }),
      ),
    );
    expect(set.items.map((i) => [i.slot, i.source, i.category])).toEqual([
      ['weak', 'grade_fallback', 'standard'],
      ['spaced', 'spaced_review', 'standard'],
      ['confidence', 'grade_fallback', 'accessible'],
    ]);
    expect(set.notes).toContainEqual({ code: 'INSUFFICIENT_CANDIDATES', count: 1 });
  });
});

describe('P7 daily practice is weekend-agnostic', () => {
  it('composes the same set on a Saturday, a Sunday and a Wednesday', () => {
    const saturday = unwrap(composeDailySet(input({ localDate: '2026-09-26' })));
    const sunday = unwrap(composeDailySet(input({ localDate: '2026-09-27' })));
    const wednesday = unwrap(composeDailySet(input({ localDate: '2026-09-23' })));
    expect(saturday.items).toEqual(wednesday.items);
    expect(sunday.items).toEqual(wednesday.items);
    expect(saturday.localDate).toBe('2026-09-26');
  });

  it('property: every calendar day composes successfully with an identical selection', () => {
    const reference = unwrap(composeDailySet(input())).items;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 730 }), (offset) => {
        const date = new Date(Date.UTC(2026, 0, 1) + offset * 86_400_000)
          .toISOString()
          .slice(0, 10);
        const set = unwrap(composeDailySet(input({ localDate: date })));
        expect(set.items).toEqual(reference);
      }),
    );
  });

  it('rejects a malformed local date', () => {
    for (const localDate of ['2026-02-30', '26-09-26', 'saturday']) {
      expect(errorCode(composeDailySet(input({ localDate })))).toBe('INVALID_LOCAL_DATE');
    }
  });
});
