// P7 prioritization: repeated independent errors, unresolved prerequisites, recent study relevance.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { prioritizeSkills, summarizeSkills, type SkillSummary } from './index.ts';
import { NOW, independentSeries } from './test-fixtures.ts';

const FRACTIONS = 'math.fractions.add';
const DECIMALS = 'math.decimals';
const DIVISION = 'math.division';
const MULTIPLICATION = 'math.multiplication';
const PERCENT = 'math.percent';
const GEOMETRY = 'math.geometry';

function fixtureSummaries(): readonly SkillSummary[] {
  const events = [
    // Repeated independent errors on several instances across two days.
    ...independentSeries(
      [
        [false, 1],
        [false, 1],
        [false, 0],
        [true, 0],
        [false, 0],
      ],
      { skill: FRACTIONS },
      'fr',
    ),
    // 60% on one day: developing, no repeated-error signal.
    ...independentSeries(
      [
        [true, 0],
        [true, 0],
        [true, 0],
        [false, 0],
        [false, 0],
      ],
      { skill: DECIMALS },
      'de',
    ),
    // Strong prerequisite.
    ...independentSeries(
      [
        [true, 0],
        [true, 1],
        [true, 2],
        [true, 3],
        [true, 4],
      ],
      { skill: MULTIPLICATION },
      'mu',
    ),
    // Recently studied, too little evidence.
    ...independentSeries(
      [
        [true, 0],
        [true, 1],
      ],
      { skill: PERCENT },
      'pc',
    ),
    // Strong and not recently studied.
    ...independentSeries(
      [
        [true, 2],
        [true, 3],
        [true, 4],
        [true, 5],
        [true, 6],
      ],
      { skill: GEOMETRY },
      'ge',
    ),
  ];
  return summarizeSkills(events, NOW);
}

const OPTIONS = {
  recentStudySkills: new Set([PERCENT]),
  prerequisites: new Map([[FRACTIONS, [DIVISION, MULTIPLICATION]]]),
  now: NOW,
};

describe('P7 prioritizeSkills', () => {
  it('ranks repeated independent errors, then unresolved prerequisites, then recent study', () => {
    const ranked = prioritizeSkills(fixtureSummaries(), OPTIONS);
    expect(ranked.map((r) => r.skill)).toEqual([FRACTIONS, DIVISION, PERCENT, DECIMALS]);
    expect(ranked.map((r) => r.reasons)).toEqual([
      ['REPEATED_INDEPENDENT_ERRORS', 'NOT_YET_STRONG'],
      ['UNRESOLVED_PREREQUISITE', 'NO_EVIDENCE'],
      ['RECENT_STUDY', 'NOT_YET_STRONG'],
      ['NOT_YET_STRONG'],
    ]);
  });

  it('never offers a strong skill (or a strong prerequisite) as a weak skill', () => {
    const skills = prioritizeSkills(fixtureSummaries(), OPTIONS).map((r) => r.skill);
    expect(skills).not.toContain(GEOMETRY);
    expect(skills).not.toContain(MULTIPLICATION);
  });

  it('recent study relevance boosts an otherwise identical skill', () => {
    const events = [
      ...independentSeries(
        [
          [true, 0],
          [false, 0],
        ],
        { skill: 'reading.a' },
        'a',
      ),
      ...independentSeries(
        [
          [true, 0],
          [false, 0],
        ],
        { skill: 'reading.b' },
        'b',
      ),
    ];
    const summaries = summarizeSkills(events, NOW);
    const plain = prioritizeSkills(summaries, { ...OPTIONS, recentStudySkills: new Set() });
    expect(plain.map((r) => r.skill)).toEqual(['reading.a', 'reading.b']);
    expect(plain[0]!.score).toBe(plain[1]!.score);
    const boosted = prioritizeSkills(summaries, {
      ...OPTIONS,
      recentStudySkills: new Set(['reading.b']),
    });
    expect(boosted.map((r) => r.skill)).toEqual(['reading.b', 'reading.a']);
  });

  it('errors older than the recency window no longer count as repeated errors', () => {
    const old = independentSeries(
      [
        [false, 45],
        [false, 44],
        [true, 44],
      ],
      { skill: FRACTIONS },
    );
    const [ranked] = prioritizeSkills(summarizeSkills(old, NOW), OPTIONS);
    expect(ranked!.reasons).not.toContain('REPEATED_INDEPENDENT_ERRORS');
  });

  it('property: ranking is deterministic, independent of input order, sorted by score then id', () => {
    const base = fixtureSummaries();
    fc.assert(
      fc.property(fc.shuffledSubarray([...base], { minLength: base.length }), (shuffled) => {
        const ranked = prioritizeSkills(shuffled, OPTIONS);
        expect(ranked).toEqual(prioritizeSkills(base, OPTIONS));
        for (let i = 1; i < ranked.length; i += 1) {
          const prev = ranked[i - 1]!;
          const cur = ranked[i]!;
          expect(
            prev.score > cur.score || (prev.score === cur.score && prev.skill < cur.skill),
          ).toBe(true);
        }
      }),
    );
  });

  it('rejects duplicate summaries and an invalid clock as programmer errors', () => {
    const [first] = fixtureSummaries();
    expect(() => prioritizeSkills([first!, first!], OPTIONS)).toThrow(RangeError);
    expect(() => prioritizeSkills([first!], { ...OPTIONS, now: new Date(Number.NaN) })).toThrow(
      RangeError,
    );
  });
});
