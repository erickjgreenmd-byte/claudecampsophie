// P8 Thursday review composition, AC_LEARNING_07.
import { describe, expect, it } from 'vitest';
import {
  composeThursdayReview,
  rankWeeklyWeaknesses,
  reviewSplit,
  validateEvidenceWindow,
  type ReviewCandidateItem,
  type ThursdayReviewInput,
} from './index.ts';
import { SAM, attempt, errorCode, unwrap } from './test-fixtures.ts';

// Monday 00:00 to Thursday 12:00 in America/Los_Angeles (PDT, UTC-7).
const WINDOW = {
  from: new Date('2026-09-21T07:00:00Z'),
  cutoff: new Date('2026-09-24T19:00:00Z'),
};
const TUESDAY = new Date('2026-09-22T22:00:00Z');
const WEDNESDAY = new Date('2026-09-23T22:00:00Z');

function bank(subject: string, skills: readonly string[], perSkill = 4): ReviewCandidateItem[] {
  return skills.flatMap((skill) =>
    Array.from({ length: perSkill }, (_, i) => ({
      templateKey: `${skill}#${i}`,
      skill,
      subject,
      category: 'standard' as const,
    })),
  );
}

const MATH_SKILLS = [
  'm.a',
  'm.b',
  'm.c',
  'm.d',
  'm.x',
  'm.pre',
  'm.cur',
  'm.cum1',
  'm.cum2',
  'm.g',
];
const READING_SKILLS = ['r.a', 'r.b', 'r.c', 'r.cum', 'r.g'];
const SPELLING_SKILLS = ['s.a', 's.b', 's.c', 's.d', 's.e', 's.f', 's.g', 's.cum'];
const SCIENCE_SKILLS = ['sc.g1', 'sc.g2', 'sc.cum'];

function input(overrides: Partial<ThursdayReviewInput> = {}): ThursdayReviewInput {
  return {
    enabledSubjects: ['math', 'reading', 'spelling', 'science'],
    evidenceWindow: WINDOW,
    subjectEvidence: new Map([
      ['math', ['m.a', 'm.b', 'm.c', 'm.d']],
      ['reading', ['r.a', 'r.b', 'r.c']],
      ['spelling', ['s.a', 's.b', 's.c', 's.d', 's.e', 's.f']],
      ['social_studies', ['ss.a']],
    ]),
    testScope: new Map([['math', ['m.c', 'm.x']]]),
    cumulativeSkills: new Map([
      ['math', ['m.cum1', 'm.cum2']],
      ['reading', ['r.cum']],
      ['spelling', ['s.cum']],
      ['science', ['sc.cum']],
    ]),
    gradeFallback: new Map([
      ['math', ['m.g']],
      ['reading', ['r.g']],
      ['spelling', ['s.g']],
      ['science', ['sc.g1', 'sc.g2']],
      ['social_studies', ['ss.g']],
    ]),
    candidateItems: [
      ...bank('math', MATH_SKILLS),
      ...bank('reading', READING_SKILLS),
      ...bank('spelling', SPELLING_SKILLS),
      ...bank('science', SCIENCE_SKILLS),
      ...bank('social_studies', ['ss.a', 'ss.g']),
    ],
    ...overrides,
  };
}

describe('AC_LEARNING_07 Thursday review sections', () => {
  it('four enabled subjects x eight questions = 32, as six weakness + two cumulative per section', () => {
    const review = unwrap(composeThursdayReview(input()));
    expect(review.totalItems).toBe(32);
    expect(review.sections.map((s) => s.subject)).toEqual([
      'math',
      'reading',
      'spelling',
      'science',
    ]);
    for (const section of review.sections) {
      expect(section.items).toHaveLength(8);
      expect(section.items.filter((i) => i.part === 'weakness')).toHaveLength(6);
      expect(section.items.filter((i) => i.part === 'cumulative')).toHaveLength(2);
      expect(section.items.every((i) => i.subject === section.subject)).toBe(true);
    }
    const keys = review.sections.flatMap((s) => s.items.map((i) => i.templateKey));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every enabled subject a section and flags a grade-level fallback when there is no evidence', () => {
    const review = unwrap(composeThursdayReview(input()));
    const science = review.sections.find((s) => s.subject === 'science')!;
    expect(science.basis).toBe('fallback_no_evidence');
    expect(science.notes).toContainEqual({ code: 'FALLBACK_NO_EVIDENCE', count: 0 });
    expect(
      science.items
        .filter((i) => i.part === 'weakness')
        .every((i) => i.source === 'grade_fallback'),
    ).toBe(true);
    expect(review.sections.find((s) => s.subject === 'math')!.basis).toBe('weekly_evidence');
    // A subject that is not enabled gets no section, even with evidence.
    expect(review.sections.some((s) => s.subject === 'social_studies')).toBe(false);
  });

  it('prioritizes weekly weaknesses that are in the teacher test scope', () => {
    const math = unwrap(composeThursdayReview(input())).sections[0]!;
    expect(math.items.filter((i) => i.part === 'weakness').map((i) => i.skill)).toEqual([
      'm.c',
      'm.a',
      'm.b',
      'm.d',
      'm.c',
      'm.a',
    ]);
    expect(
      math.items.filter((i) => i.part === 'weakness').every((i) => i.source === 'weekly_weakness'),
    ).toBe(true);
  });

  it('test scope changes the selection when weekly weaknesses are few', () => {
    const base = input({
      subjectEvidence: new Map([['math', ['m.a']]]),
      enabledSubjects: ['math'],
    });
    const withoutScope = unwrap(composeThursdayReview({ ...base, testScope: new Map() }));
    const withScope = unwrap(composeThursdayReview(base));
    expect(withoutScope.sections[0]!.items.map((i) => i.skill)).not.toContain('m.x');
    expect(withScope.sections[0]!.items.map((i) => i.skill)).toContain('m.x');
  });

  it('with fewer than six distinct weaknesses fills from test scope, prerequisites and current material, and explains', () => {
    const review = unwrap(
      composeThursdayReview(
        input({
          enabledSubjects: ['math'],
          subjectEvidence: new Map([['math', ['m.a']]]),
          testScope: new Map([['math', ['m.x']]]),
          prerequisites: new Map([['m.a', ['m.pre']]]),
          currentMaterial: new Map([['math', ['m.cur']]]),
        }),
      ),
    );
    const math = review.sections[0]!;
    expect(math.items.filter((i) => i.part === 'weakness').map((i) => [i.skill, i.source])).toEqual(
      [
        ['m.a', 'weekly_weakness'],
        ['m.a', 'weekly_weakness'],
        ['m.x', 'test_scope'],
        ['m.pre', 'prerequisite'],
        ['m.cur', 'current_material'],
        ['m.a', 'weekly_weakness'],
      ],
    );
    expect(math.notes).toEqual([
      { code: 'FEWER_DISTINCT_WEAKNESSES', count: 1 },
      { code: 'FILLED', part: 'weakness', source: 'test_scope', count: 1 },
      { code: 'FILLED', part: 'weakness', source: 'prerequisite', count: 1 },
      { code: 'FILLED', part: 'weakness', source: 'current_material', count: 1 },
    ]);
  });

  it('parent-adjustable length keeps a cumulative share', () => {
    expect(reviewSplit(8)).toEqual({ weakness: 6, cumulative: 2 });
    expect(reviewSplit(4)).toEqual({ weakness: 3, cumulative: 1 });
    expect(reviewSplit(2)).toEqual({ weakness: 1, cumulative: 1 });
    const review = unwrap(composeThursdayReview(input({ perSubjectCount: 4 })));
    expect(review.totalItems).toBe(16);
    const allWeakness = unwrap(
      composeThursdayReview(input({ perSubjectCount: 6, cumulativeCount: 0 })),
    );
    expect(allWeakness.sections[0]!.items.every((i) => i.part === 'weakness')).toBe(true);
    for (const perSubjectCount of [1, 21, 7.5]) {
      expect(errorCode(composeThursdayReview(input({ perSubjectCount })))).toBe(
        'INVALID_ITEM_COUNT',
      );
    }
    expect(errorCode(composeThursdayReview(input({ cumulativeCount: 9 })))).toBe(
      'INVALID_ITEM_COUNT',
    );
  });

  it('avoids exact repeats of recently used templates when alternatives exist', () => {
    const review = unwrap(
      composeThursdayReview(input({ recentlyUsedTemplateKeys: new Set(['m.c#0', 'm.c#1']) })),
    );
    const math = review.sections[0]!;
    expect(math.items[0]!.templateKey).toBe('m.c#2');
    expect(math.items.some((i) => i.reusedRecentTemplate)).toBe(false);
  });

  it('backfills a cumulative shortfall and reports missing content instead of inventing it', () => {
    const review = unwrap(
      composeThursdayReview(
        input({
          enabledSubjects: ['reading'],
          candidateItems: [...bank('reading', ['r.a', 'r.cum'], 1), ...bank('reading', ['r.b'], 2)],
        }),
      ),
    );
    const reading = review.sections[0]!;
    expect(reading.items).toHaveLength(4);
    expect(reading.notes).toContainEqual({
      code: 'INSUFFICIENT_CANDIDATES',
      part: 'weakness',
      count: 3,
    });
    expect(reading.notes).toContainEqual({
      code: 'INSUFFICIENT_CANDIDATES',
      part: 'cumulative',
      count: 1,
    });
  });

  it('AC_LEARNING_05: a subject without bank content gets an honest empty section, never invented items', () => {
    const review = unwrap(
      composeThursdayReview(
        input({
          enabledSubjects: ['math', 'reading', 'spelling', 'grammar', 'science', 'social_studies'],
          gradeFallback: new Map([
            ['math', ['m.g']],
            ['reading', ['r.g']],
            ['spelling', ['s.g']],
            ['grammar', ['gr.g']],
            ['science', ['sc.g1', 'sc.g2']],
            ['social_studies', ['ss.g']],
          ]),
        }),
      ),
    );
    expect(review.sections.map((s) => s.subject)).toEqual([
      'math',
      'reading',
      'spelling',
      'grammar',
      'science',
      'social_studies',
    ]);
    const grammar = review.sections.find((s) => s.subject === 'grammar')!;
    expect(grammar.items).toEqual([]);
    expect(grammar.notes).toContainEqual({
      code: 'INSUFFICIENT_CANDIDATES',
      part: 'weakness',
      count: 6,
    });
    expect(grammar.notes).toContainEqual({
      code: 'INSUFFICIENT_CANDIDATES',
      part: 'cumulative',
      count: 2,
    });
    expect(review.totalItems).toBe(40);
  });

  it('rejects missing subjects, bad windows and malformed candidates', () => {
    expect(errorCode(composeThursdayReview(input({ enabledSubjects: [] })))).toBe(
      'NO_ENABLED_SUBJECTS',
    );
    const badWindows = [
      { from: WINDOW.cutoff, cutoff: WINDOW.from },
      { from: WINDOW.from, cutoff: WINDOW.from },
      { from: new Date('2026-09-14T07:00:00Z'), cutoff: WINDOW.cutoff },
      { from: new Date(Number.NaN), cutoff: WINDOW.cutoff },
    ];
    for (const evidenceWindow of badWindows) {
      expect(errorCode(composeThursdayReview(input({ evidenceWindow })))).toBe(
        'INVALID_EVIDENCE_WINDOW',
      );
      expect(errorCode(validateEvidenceWindow(evidenceWindow))).toBe('INVALID_EVIDENCE_WINDOW');
    }
    expect(
      errorCode(
        composeThursdayReview(
          input({
            candidateItems: [{ templateKey: 'k', skill: 'm.a', subject: '', category: 'standard' }],
          }),
        ),
      ),
    ).toBe('INVALID_CANDIDATE');
  });
});

describe('P8 weekly evidence window (Monday to cutoff)', () => {
  const events = [
    attempt({
      questionInstanceId: 'q1',
      skill: 'm.a',
      occurredAt: TUESDAY,
      correctness: 'incorrect',
    }),
    attempt({
      questionInstanceId: 'q2',
      skill: 'm.a',
      occurredAt: WEDNESDAY,
      correctness: 'incorrect',
    }),
    attempt({
      questionInstanceId: 'q2',
      skill: 'm.a',
      occurredAt: new Date(WEDNESDAY.getTime() + 60_000),
      correctness: 'incorrect',
    }),
    attempt({
      questionInstanceId: 'q3',
      skill: 'm.b',
      occurredAt: TUESDAY,
      correctness: 'incorrect',
    }),
    attempt({
      questionInstanceId: 'q3',
      skill: 'm.b',
      occurredAt: new Date(TUESDAY.getTime() + 60_000),
      attemptNumber: 2,
      hintsUsed: 1,
      correctness: 'correct',
    }),
    attempt({ questionInstanceId: 'q4', skill: 'm.c', occurredAt: TUESDAY }),
    // Before Monday and after the cutoff (a late scan): outside the window.
    attempt({
      questionInstanceId: 'q5',
      skill: 'm.d',
      occurredAt: new Date('2026-09-20T20:00:00Z'),
      correctness: 'incorrect',
    }),
    attempt({
      questionInstanceId: 'q6',
      skill: 'm.d',
      occurredAt: new Date('2026-09-24T19:30:00Z'),
      correctness: 'incorrect',
    }),
    attempt({
      questionInstanceId: 'q7',
      skill: 'r.a',
      subject: 'reading',
      occurredAt: TUESDAY,
      correctness: 'unresolved',
    }),
    attempt({
      questionInstanceId: 'q8',
      skill: 'r.b',
      subject: 'reading',
      occurredAt: TUESDAY,
      correctness: 'incorrect',
      parentOverride: { correctness: 'correct', overriddenAt: WEDNESDAY },
    }),
    attempt({
      questionInstanceId: 'q9',
      skill: 'r.c',
      subject: 'reading',
      occurredAt: WEDNESDAY,
      correctness: 'incorrect',
    }),
    attempt({
      questionInstanceId: 'q10',
      skill: 'r.d',
      subject: 'reading',
      occurredAt: WEDNESDAY,
      correctness: 'incorrect',
      parentOverride: { correctness: 'correct', overriddenAt: new Date('2026-09-25T01:00:00Z') },
    }),
  ];

  it('ranks the week’s errors by distinct question instance, inside [Monday, cutoff) only', () => {
    const ranked = rankWeeklyWeaknesses(events, WINDOW);
    expect([...ranked.entries()]).toEqual([
      ['math', ['m.a', 'm.b']],
      ['reading', ['r.c', 'r.d']],
    ]);
  });

  it('feeds the review so weekly errors drive the weakness part', () => {
    const review = unwrap(
      composeThursdayReview(
        input({ enabledSubjects: ['math'], subjectEvidence: rankWeeklyWeaknesses(events, WINDOW) }),
      ),
    );
    expect(review.sections[0]!.items[0]!.skill).toBe('m.a');
    expect(review.evidenceWindow).toEqual(WINDOW);
  });

  it('rejects mixed children and invalid windows as programmer errors', () => {
    const mixed = [...events, { ...events[0]!, id: 'sam-1', childId: SAM }];
    expect(() => rankWeeklyWeaknesses(mixed, WINDOW)).toThrow(RangeError);
    expect(() =>
      rankWeeklyWeaknesses(events, { from: WINDOW.cutoff, cutoff: WINDOW.from }),
    ).toThrow(RangeError);
  });
});
