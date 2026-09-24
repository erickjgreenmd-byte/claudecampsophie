// Independent adversarial review of the learning module (spec P6, P7, P8, E4; AC_LEARNING_01/02/
// 04/05/07, AC_GRADING_09/10). Each "[RV-learning-<n>]" test is a regression for a reviewed
// defect; the "probe" tests pin down risky behaviour that was checked and found sound.
import { describe, expect, it } from 'vitest';
import {
  composeDailySet,
  composeThursdayReview,
  countUnsuccessfulTargetAttempts,
  evaluateRetry,
  prioritizeSkills,
  recomputeAfterOverride,
  summarizeSkill,
  summarizeSkills,
  type CandidateItem,
  type ItemCategory,
  type ReviewCandidateItem,
  type ThursdayReviewInput,
} from './index.ts';
import { NOW, RILEY, attempt, daysAgo, independentSeries, unwrap } from './test-fixtures.ts';

// Monday 00:00 to Thursday 12:00 in America/Los_Angeles (PDT, UTC-7).
const WINDOW = {
  from: new Date('2026-09-21T07:00:00Z'),
  cutoff: new Date('2026-09-24T19:00:00Z'),
};

function reviewBank(
  subject: string,
  skills: readonly string[],
  perSkill = 4,
): ReviewCandidateItem[] {
  return skills.flatMap((skill) =>
    Array.from({ length: perSkill }, (_, i) => ({
      templateKey: `${skill}#${i}`,
      skill,
      subject,
      category: 'standard' as const,
    })),
  );
}

function mathReview(overrides: Partial<ThursdayReviewInput> = {}): ThursdayReviewInput {
  return {
    enabledSubjects: ['math'],
    evidenceWindow: WINDOW,
    // Three distinct weekly weaknesses: fewer than the six weakness questions of a default review.
    subjectEvidence: new Map([['math', ['m.a', 'm.b', 'm.c']]]),
    cumulativeSkills: new Map([['math', ['m.cum1', 'm.cum2']]]),
    gradeFallback: new Map([['math', ['m.g']]]),
    candidateItems: reviewBank('math', [
      'm.a',
      'm.b',
      'm.c',
      'm.x',
      'm.pre',
      'm.cur',
      'm.cum1',
      'm.cum2',
      'm.g',
    ]),
    ...overrides,
  };
}

function dailyBank(
  skill: string,
  count: number,
  category: ItemCategory = 'standard',
): CandidateItem[] {
  return Array.from({ length: count }, (_, i) => ({
    templateKey: `${skill}#${category}#${i}`,
    skill,
    category,
  }));
}

describe('review findings', () => {
  it('[RV-learning-1] fewer than six distinct weekly weaknesses are filled with prerequisites/current material', () => {
    // P8: "Where six distinct weakness questions are not possible, fill with prerequisites/current
    // material and explain the mix to the parent." Module requirement: "fewer than 6 distinct
    // weaknesses => fill with prerequisites/current material and explain via notes".
    const review = unwrap(
      composeThursdayReview(
        mathReview({
          prerequisites: new Map([['m.a', ['m.pre']]]),
          currentMaterial: new Map([['math', ['m.cur']]]),
        }),
      ),
    );
    const math = review.sections[0]!;
    // The module itself reports that there are fewer distinct weaknesses than weakness slots...
    expect(math.notes).toContainEqual({ code: 'FEWER_DISTINCT_WEAKNESSES', count: 3 });
    // ...so the available prerequisite and current material must be used to fill the part.
    const weaknessSources = math.items.filter((i) => i.part === 'weakness').map((i) => i.source);
    expect(weaknessSources).toContain('prerequisite');
    expect(weaknessSources).toContain('current_material');
  });

  it('[RV-learning-2] the teacher test scope affects selection even when weekly weaknesses lie outside it', () => {
    // AC_LEARNING_07: "Teacher test scope and subject-specific dates affect selection." P8: reviews
    // "primarily use Monday-through-Thursday learning evidence and the supplied test scope".
    const withoutScope = unwrap(composeThursdayReview(mathReview({ testScope: new Map() })));
    const withScope = unwrap(
      composeThursdayReview(mathReview({ testScope: new Map([['math', ['m.x']]]) })),
    );
    const skills = (r: typeof withScope): string[] => r.sections[0]!.items.map((i) => i.skill);
    // The upcoming test covers m.x and a bank item exists for it, yet the review never mentions it.
    expect(skills(withScope)).toContain('m.x');
    expect(skills(withScope)).not.toEqual(skills(withoutScope));
  });

  it('[RV-learning-3] one homework session spanning UTC midnight is not two "sessions" for mastery', () => {
    // P7: "Require independent success across different questions and sessions"; AC_LEARNING_02:
    // "skill mastery requires independent success across sessions". Architecture: local-time rules
    // use an IANA zone, never a fixed offset. 7:35-8:25 p.m. in New York (EDT) is one evening.
    const oneEvening = [
      '2026-09-22T23:35:00Z',
      '2026-09-22T23:45:00Z',
      '2026-09-22T23:55:00Z',
      '2026-09-23T00:05:00Z',
      '2026-09-23T00:15:00Z',
      '2026-09-23T00:25:00Z',
    ].map((iso, i) => attempt({ questionInstanceId: `evening-${i}`, occurredAt: new Date(iso) }));
    // With the family zone the rule works: one evening is one session, so not "strong".
    expect(summarizeSkill(oneEvening, NOW, { timeZone: 'America/New_York' }).status).toBe(
      'developing',
    );
    // Without a zone the summary must not fail open to "strong" (rejecting the call is also fine).
    let status: string;
    try {
      status = summarizeSkill(oneEvening, NOW).status;
    } catch {
      status = 'rejected: time zone required';
    }
    expect(status).not.toBe('strong');
  });

  it('[RV-learning-4] a daily set includes a confidence item whenever an eligible candidate exists', () => {
    // Module requirement: "for count >= 3 at least one confidence item is included (take it from
    // weak)". P7: "20% accessible confidence-building practice, adapting rounding for short sets".
    const set = unwrap(
      composeDailySet({
        count: 5,
        weakSkills: ['w1'],
        spacedReviewSkills: ['s1'],
        confidenceSkills: ['c1'],
        gradeFallbackSkills: ['g1'],
        recentlyUsedTemplateKeys: new Set(),
        // No items for w1 or c1: the weak and confidence slots both fall back to grade level.
        candidateItems: [
          ...dailyBank('s1', 1),
          ...dailyBank('g1', 2),
          ...dailyBank('g1', 1, 'accessible'),
        ],
      }),
    );
    expect(set.items).toHaveLength(4);
    // The accessible grade-level item is eligible for the confidence slot (its backfill chain is
    // confidence -> spaced -> grade), but the weak slot's backfill consumes it first.
    expect(set.mix.confidence).toBeGreaterThanOrEqual(1);
  });

  it('[RV-learning-5] repeated recent independent errors are prioritized even on a "strong" skill', () => {
    // P7: "Prioritize concepts with repeated independent errors across at least two
    // instances/days". Module requirement: "repeated independent errors across >= 2 instances/days
    // first". Errors yesterday and today on two different questions, after 20 earlier successes.
    const events = [
      ...independentSeries(
        Array.from({ length: 20 }, (_, i) => [true, 2 + Math.floor(i / 2)] as const),
        {},
        'ok',
      ),
      ...independentSeries(
        [
          [false, 0],
          [false, 1],
        ],
        {},
        'err',
      ),
    ];
    const [summary] = summarizeSkills(events, NOW);
    // The two fresh errors are outweighed by earlier successes, so the skill reads "strong"...
    expect(summary!.status).toBe('strong');
    // ...while still meeting the repeated-independent-error rule exactly.
    expect(summary!.independentIncorrect).toBe(2);
    expect(summary!.distinctIndependentErrorDays).toBe(2);
    expect(summary!.lastIndependentErrorAt).toEqual(daysAgo(0));
    const ranked = prioritizeSkills([summary!], {
      recentStudySkills: new Set(),
      prerequisites: new Map(),
      now: NOW,
    });
    expect(ranked.map((r) => r.skill)).toContain('math.fractions.add');
    expect(ranked[0]?.reasons).toContain('REPEATED_INDEPENDENT_ERRORS');
  });
});

describe('review probes (behaviour verified sound)', () => {
  it('probe: a same-instant retry and reset cannot turn a wrong first try into independent success', () => {
    const at = daysAgo(1);
    const events = [
      attempt({ id: 'z-first', questionInstanceId: 'q', occurredAt: at, correctness: 'incorrect' }),
      attempt({ id: 'a-retry', questionInstanceId: 'q', occurredAt: at, attemptNumber: 2 }),
      attempt({ id: 'a-reset', questionInstanceId: 'q', occurredAt: new Date(at.getTime() + 1) }),
    ];
    const summary = summarizeSkill(events, NOW);
    expect(summary.distinctIndependentQuestions).toBe(1);
    expect(summary.independentCorrect).toBe(0);
    expect(summary.eventualCompletionRate).toBe(1);
  });

  it('probe: very old evidence does not underflow the recency weighting to NaN', () => {
    const ancient = independentSeries([
      [true, 40_000],
      [false, 40_001],
    ]);
    const accuracy = summarizeSkill(ancient, NOW).weightedIndependentAccuracy;
    expect(accuracy).not.toBeNaN();
    expect(accuracy).toBeGreaterThan(0.5);
  });

  it('probe: DST fall-back evening in the family zone is still one day', () => {
    // 2026-11-01 01:30 local happens twice in New York; both are the same calendar date.
    const events = ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z'].map((iso, i) =>
      attempt({ questionInstanceId: `dst-${i}`, occurredAt: new Date(iso) }),
    );
    const summary = summarizeSkill(events, new Date('2026-11-02T00:00:00Z'), {
      timeZone: 'America/New_York',
    });
    expect(summary.distinctIndependentDays).toBe(1);
  });

  it('probe: an override cannot be back-dated before an existing override, and the retry count ignores it', () => {
    const events = [
      attempt({
        id: 'e1',
        questionInstanceId: 'q',
        occurredAt: daysAgo(2),
        correctness: 'incorrect',
      }),
    ];
    const first = unwrap(
      recomputeAfterOverride(
        events,
        { eventId: 'e1', correctness: 'correct', overriddenAt: daysAgo(1) },
        NOW,
      ),
    );
    const stale = recomputeAfterOverride(
      first.events,
      { eventId: 'e1', correctness: 'incorrect', overriddenAt: daysAgo(1.5) },
      NOW,
    );
    expect(stale.ok).toBe(false);
    expect(
      countUnsuccessfulTargetAttempts(first.events, { childId: RILEY, questionInstanceId: 'q' }),
    ).toBe(1);
    expect(evaluateRetry({ targetAnswerAttempts: 3 })).toBe(
      'redirect_method_practice_or_parent_help',
    );
  });

  it('probe: four enabled subjects without any evidence still produce 4 x 8 = 32 fallback questions', () => {
    const subjects = ['math', 'reading', 'spelling', 'science'];
    const review = unwrap(
      composeThursdayReview({
        enabledSubjects: subjects,
        evidenceWindow: WINDOW,
        subjectEvidence: new Map(),
        gradeFallback: new Map(subjects.map((s) => [s, [`${s}.g1`, `${s}.g2`]])),
        candidateItems: subjects.flatMap((s) => reviewBank(s, [`${s}.g1`, `${s}.g2`], 5)),
      }),
    );
    expect(review.totalItems).toBe(32);
    expect(review.sections.every((s) => s.basis === 'fallback_no_evidence')).toBe(true);
    const keys = review.sections.flatMap((s) => s.items.map((i) => i.templateKey));
    expect(new Set(keys).size).toBe(32);
  });
});
