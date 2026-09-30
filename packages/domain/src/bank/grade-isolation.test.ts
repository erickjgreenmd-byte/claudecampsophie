import { describe, expect, it } from 'vitest';
import { BANK_SUBJECTS } from './types.ts';
import {
  gradeSkills,
  generateCandidates,
  subjectGrade,
  subjectStartsAtGrade,
  SUBJECT_GRADE_REACH,
} from './generate.ts';
import { bankGrade, skillDefinition } from './skills.ts';

/**
 * OWNER RULE (2026-09-30, as amended): the child's own grade is what practice is built for, and the bank
 * may "reach up or down 1 or 2" when that grade has no content for a subject. Anything further is not
 * put in front of them.
 *
 * WHAT THIS REPLACED. `subjectGrade` reached UPWARD with no bound, documented as "the nearest supported
 * grade is used and the coverage report says so". In practice that put grade-1 spelling and grammar in
 * front of KINDERGARTEN children — the only two cases in the whole band — with no limit on the distance
 * and no notice any parent would read. Both are within the reach now allowed, so both are served again;
 * what changed is that the distance is BOUNDED, ASSERTED, and stated in one place.
 *
 * WHY THESE CASES EXIST AT ALL. The isolation otherwise held because three separate functions happened
 * to agree — `generateCandidates` bounding skills through `skillsForGrade(subject, subjectGrade(...))`,
 * the composer only picking from those candidates, and the planner passing the child's own grade — and
 * NOTHING asserted it. It was in fact false in the one helper all three called, and the suite pinned the
 * false behaviour in a case whose own name described it as a feature. Three files agreeing is a
 * coincidence with good odds, not an invariant.
 *
 * WHAT IS DELIBERATELY NOT BOUNDED, and why none of it is a hole:
 *   * PREREQUISITE REVISION. A child's prerequisite work comes from skills they have actually got wrong,
 *     so a grade-8 child with a grade-2 gap is given grade-2 practice — six grades down. Capping that at
 *     two would forbid exactly the remediation the evidence calls for. The reach is an assumption about a
 *     GRADE; a prerequisite is a response to a CHILD, and only the first is bounded here.
 *   * The 'accessible' category, which draws one band down by design (`passageItems` targets `grade - 1`).
 *   * Parent-supplied material. The parent chose it, and `parentPassageItems` still builds it at the
 *     child's own grade.
 * So every assertion below bounds the UPPER side only.
 */
const GRADES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;

/** The grade the bank first teaches a skill at, or null when the skill is not a bank skill. */
function taughtAt(skill: string): number | null {
  return skillDefinition(skill)?.gradeMin ?? null;
}

describe('the grade a subject uses stays within the owner’s reach', () => {
  /**
   * THE NUMBER ITSELF, pinned. Every other assertion in this file is written in terms of
   * `SUBJECT_GRADE_REACH`, which means they all move when it moves: setting it to 5 leaves the whole file
   * green while a kindergarten child is handed grade-5 work. A test written against a constant cannot
   * fail on that constant, and the constant is the owner's decision — "we can reach up or down 1 or 2" —
   * so it is asserted literally, here, and changing it has to come with a decision recorded against this
   * line. (Found by mutation: widening the reach to 5 reddened nothing at all.)
   */
  it('reaches at most two grades, which is the owner’s number and not a tunable', () => {
    expect(SUBJECT_GRADE_REACH).toBe(2);
  });

  it('is the child’s own grade, or within the reach of it, for every subject and grade', () => {
    const reached: string[] = [];
    for (const grade of GRADES) {
      for (const subject of BANK_SUBJECTS) {
        const used = subjectGrade(subject, grade);
        expect(
          Math.abs(used - grade),
          `${subject} at grade ${grade} uses grade ${used}`,
        ).toBeLessThanOrEqual(SUBJECT_GRADE_REACH);
        if (used !== grade) reached.push(`${subject}@${grade}->${used}`);
      }
    }
    // The complete list of pairs the bank cannot serve at the child's own grade, and how far each
    // reaches. A third pair, or a longer reach, shows up here rather than arriving unnoticed.
    expect(reached).toEqual(['spelling_vocabulary@0->1', 'grammar_writing@0->1']);
  });

  /**
   * `subjectGrade` searches DOWN before UP at each distance, so an equidistant tie takes the lower grade:
   * easier practice is the safer error for a child whose own grade the bank cannot serve. That ordering is
   * UNREACHABLE with today's bank and this case does not pretend otherwise — the only two unserved pairs
   * are at grade 0, which has nothing below it, so no tie exists to break. Mutating the search order reds
   * nothing, and that is recorded here rather than left for someone to discover and file. The ordering is
   * a stated intention for the day a mid-band gap appears; the case below pins what IS reachable.
   */
  it('prefers the child’s own grade wherever the bank has content for it', () => {
    // The reach is a fallback and never a preference: no amount of reach may move a child off their own
    // grade when that grade is served. Proved by the complement of the list above — every other pair
    // uses the child's grade exactly, which the first case already asserts, so this pins the direction:
    // the two that DO reach are the two whose own grade is empty.
    for (const [subject, grade] of [
      ['spelling_vocabulary', 0],
      ['grammar_writing', 0],
    ] as const) {
      expect(gradeSkills(subject, grade).length, `${subject}@${grade} own grade`).toBeGreaterThan(
        0,
      );
      // ...via the reach. The child's own grade genuinely has no bank skill of its own:
      expect(subjectGrade(subject, grade)).not.toBe(grade);
    }
  });

  it('clamps a grade outside the 0-8 band rather than reaching from it', () => {
    // Above the band clamps DOWN to 8, below it clamps UP to 0. Neither is a reach: the band is the
    // whole product and `bankGrade` is the only thing that moved the number.
    expect(subjectGrade('math', 12)).toBe(bankGrade(12));
    expect(subjectGrade('math', 12)).toBe(8);
    expect(subjectGrade('math', -3)).toBe(bankGrade(-3));
    expect(subjectGrade('math', -3)).toBe(0);
  });
});

describe('no item a child is shown starts further above their grade than the reach', () => {
  it('holds for every generated candidate, at every grade', () => {
    for (const grade of GRADES) {
      const items = generateCandidates({
        subjects: [...BANK_SUBJECTS],
        grade,
        seed: `grade-isolation:${grade}`,
      });
      expect(items.length, `grade ${grade} produced no candidates at all`).toBeGreaterThan(0);
      for (const item of items) {
        expect(
          item.gradeMin,
          `grade ${grade}: ${item.templateKey} starts at grade ${item.gradeMin}`,
        ).toBeLessThanOrEqual(grade + SUBJECT_GRADE_REACH);
      }
    }
  });

  it('holds for the skills a subject offers as its grade fallback', () => {
    for (const grade of GRADES) {
      for (const subject of BANK_SUBJECTS) {
        for (const skill of gradeSkills(subject, grade)) {
          const taught = taughtAt(skill);
          if (taught === null) continue;
          expect(
            taught,
            `grade ${grade} ${subject}: ${skill} is taught at grade ${taught}`,
          ).toBeLessThanOrEqual(grade + SUBJECT_GRADE_REACH);
        }
      }
    }
  });

  /**
   * And the distance measured on the SKILL rather than the item, which is the tighter quantity: how far
   * above the child's grade the bank first TEACHES anything they are given. Two sources put an
   * above-grade skill in reach and both are legitimate:
   *   * the subject reach (kindergarten spelling and grammar, one grade up);
   *   * curated reading, which is banded by the PASSAGE — a question on a grade-0 passage may exercise a
   *     skill first taught at grade 1, and drawing a conclusion from text a five-year-old can read is not
   *     grade-1 work.
   * Both are bounded by the same number, so the assertion is on the DISTANCE and not on a list of
   * subjects that would have to be edited every time the bank grows.
   */
  it('never invokes a generator for a skill taught further above the child’s grade than the reach', () => {
    const distances = new Set<number>();
    for (const grade of GRADES) {
      const items = generateCandidates({
        subjects: [...BANK_SUBJECTS],
        grade,
        seed: `grade-isolation:${grade}`,
      });
      for (const item of items) {
        const taught = taughtAt(item.skill);
        if (taught === null || taught <= grade) continue;
        distances.add(taught - grade);
        expect(
          taught - grade,
          `grade ${grade}: ${item.skill} is taught ${taught - grade} grades up`,
        ).toBeLessThanOrEqual(SUBJECT_GRADE_REACH);
      }
    }
    // Every above-grade skill in the product today is exactly ONE grade up. If that ever becomes two,
    // this says so — the reach allows it, and it is worth knowing the day it starts happening.
    expect([...distances].sort()).toEqual([1]);
  });
});

describe('a subject the reach cannot cover would have to be explained, and none is', () => {
  it('leaves no subject dead at any grade', () => {
    // With the reach at two, every pair in the band is served. A pair that is NOT served is one a parent
    // meets as an empty subject, so it has to be seen here before they see it.
    const empty: string[] = [];
    for (const grade of GRADES) {
      for (const subject of BANK_SUBJECTS) {
        if (gradeSkills(subject, grade).length === 0) empty.push(`${subject}@${grade}`);
      }
    }
    expect(empty).toEqual([]);
  });

  it('knows where every subject starts, for the screen that would have to explain a gap', () => {
    // Nothing needs this sentence today, and that is the point of asserting it: the reach is finite, so
    // widening the bank's grade span or narrowing the reach puts some pair out of range, and the product
    // must then say "Spelling and vocabulary starts at grade 1" rather than show an empty subject.
    for (const subject of BANK_SUBJECTS) {
      const startsAt = subjectStartsAtGrade(subject);
      expect(startsAt, subject).not.toBeNull();
      expect(startsAt!, subject).toBeGreaterThanOrEqual(0);
      expect(startsAt!, subject).toBeLessThanOrEqual(8);
      // Every subject's start is within reach of kindergarten, which is why no pair is empty above.
      expect(
        startsAt!,
        `${subject} starts at ${startsAt}, beyond the reach from grade 0`,
      ).toBeLessThanOrEqual(SUBJECT_GRADE_REACH);
    }
  });
});
