import { describe, expect, it } from 'vitest';
import { BANK_SUBJECTS, type BankSubject } from './types.ts';
import { gradeSkills, generateCandidates, subjectGrade, subjectStartsAtGrade } from './generate.ts';
import { bankGrade, skillDefinition } from './skills.ts';

/**
 * OWNER RULE (2026-09-30): "the system should ask the kid's grade so that when that child is logged in,
 * no other grade level work is put into the system."
 *
 * The isolation already held for most of the band, but it held by three separate functions happening to
 * agree — `generateCandidates` bounding skills with `skillsForGrade(subject, subjectGrade(...))`, the
 * composer only picking from those candidates, and the planner passing the child's own grade — with
 * NOTHING asserting it. That is the shape this project has been burned by repeatedly: an invariant true
 * today because of a coincidence between three files. And it was in fact FALSE in two places, which is
 * how a rule with no test goes.
 *
 * These cases assert the property on the ITEMS, over every grade and every subject, so a later change
 * anywhere in the generation path reds rather than quietly widening what a child is shown.
 *
 * WHAT IS DELIBERATELY ALLOWED, and why it is not a hole:
 *   * Work BELOW the child's grade. A prerequisite that underlies a skill the child is weak on is
 *     usually a lower grade's skill, and giving it to them is the entire point of the prerequisite
 *     list. The rule is about work they are not ready for, not about revision.
 *   * Parent-supplied material (a reading passage, a spelling list the parent typed). The parent chose
 *     it for their own child; `parentPassageItems` still builds it at the CHILD's grade.
 */
const GRADES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;

/** The grade a generated item's skill is defined at. */
function skillGrade(skill: string): number | null {
  return skillDefinition(skill)?.gradeMin ?? null;
}

describe('no child is shown practice above their own grade (owner rule, 2026-09-30)', () => {
  it('bounds the grade a subject uses to the child’s own grade, for every subject and grade', () => {
    for (const grade of GRADES) {
      for (const subject of BANK_SUBJECTS) {
        expect(subjectGrade(subject, grade), `${subject} at grade ${grade}`).toBe(grade);
      }
    }
  });

  it('never reaches above the child’s grade even for a grade outside the 0-8 band', () => {
    // A grade above the band clamps DOWN to 8, which is below the child's stated grade and therefore
    // allowed; a negative one clamps up to 0, which is the floor of the band rather than a reach.
    expect(subjectGrade('math', 12)).toBe(bankGrade(12));
    expect(subjectGrade('math', 12)).toBeLessThanOrEqual(8);
    expect(subjectGrade('math', -3)).toBe(bankGrade(-3));
  });

  /**
   * The property on the ITEMS, which is what a child actually sees. The quantity that governs whether an
   * item may be shown is the ITEM's OWN grade band, not the grade its skill is first taught at — the two
   * differ for curated reading, and the first draft of this case asserted the wrong one and failed on
   * `reading.inference` (a grade-1 SKILL carried by a question on a passage banded for grade 0).
   */
  it('generates no candidate item whose own grade band STARTS above the child’s grade', () => {
    for (const grade of GRADES) {
      const items = generateCandidates({
        subjects: [...BANK_SUBJECTS],
        grade,
        seed: `grade-isolation:${grade}`,
      });
      expect(items.length, `grade ${grade} produced no candidates at all`).toBeGreaterThan(0);
      for (const item of items) {
        // Only the LOWER bound is the rule. An item whose band ends below the child's grade is
        // deliberate: the 'accessible' category draws from one band down (`passageItems` targets
        // `grade - 1`), which is revision, and revision is allowed. Asserting `gradeMax >= grade` here
        // would forbid exactly the easier practice a struggling child needs — the first draft of this
        // case did, and failed on a grade-1 passage offered to a grade-2 child.
        expect(
          item.gradeMin,
          `grade ${grade}: ${item.templateKey} starts at grade ${item.gradeMin}`,
        ).toBeLessThanOrEqual(grade);
      }
    }
  });

  /**
   * And the tighter property for GENERATED items, where the skill's own grade IS the item's grade: no
   * generator may be invoked for a skill the bank teaches later. The curated exception is stated and
   * bounded rather than left implicit — a curated passage is banded by the PASSAGE, and a question on a
   * grade-0 passage may exercise a skill first taught at grade 1 (drawing a conclusion from text a
   * five-year-old can read is not grade-1 work). Those items are identified by their template key
   * prefix, and the exception is asserted to cover ONLY reading, so it cannot quietly grow.
   */
  it('invokes no generator for a skill the bank teaches above the child’s grade', () => {
    const exceptions = new Map<string, Set<string>>();
    for (const grade of GRADES) {
      const items = generateCandidates({
        subjects: [...BANK_SUBJECTS],
        grade,
        seed: `grade-isolation:${grade}`,
      });
      for (const item of items) {
        const taught = skillGrade(item.skill);
        if (taught === null || taught <= grade) continue;
        // A curated passage question: allowed, recorded, and checked below.
        const subject = item.subject;
        if (!exceptions.has(subject)) exceptions.set(subject, new Set());
        exceptions.get(subject)!.add(`${item.skill}@${grade}`);
      }
    }
    // Only reading may hold an above-grade SKILL, and only through curated passages.
    expect([...exceptions.keys()].sort()).toEqual(['reading']);
    for (const entry of exceptions.get('reading') ?? []) {
      // Every one is a skill taught at most one grade above the child's, which is the band a curated
      // passage's questions may reach; two grades would be a curation error.
      const [skill, at] = entry.split('@');
      expect(skillGrade(skill!)! - Number(at), entry).toBeLessThanOrEqual(1);
    }
  });

  it('offers a subject’s grade-fallback skills only at or below the child’s grade', () => {
    for (const grade of GRADES) {
      for (const subject of BANK_SUBJECTS) {
        for (const skill of gradeSkills(subject, grade)) {
          const defined = skillGrade(skill);
          if (defined === null) continue;
          expect(
            defined,
            `grade ${grade} ${subject}: ${skill} is grade ${defined}`,
          ).toBeLessThanOrEqual(grade);
        }
      }
    }
  });
});

describe('a subject that starts later says so, instead of substituting a higher grade', () => {
  /**
   * The two cases the old upward reach existed for, named explicitly. If the bank later gains
   * kindergarten spelling or grammar these stop being empty, and this case says so rather than silently
   * passing — the count is asserted both ways.
   */
  it('offers nothing where the bank starts above the child’s grade, and names where it starts', () => {
    const empty: { subject: BankSubject; grade: number; startsAt: number | null }[] = [];
    for (const grade of GRADES) {
      for (const subject of BANK_SUBJECTS) {
        if (gradeSkills(subject, grade).length === 0) {
          empty.push({ subject, grade, startsAt: subjectStartsAtGrade(subject) });
        }
      }
    }
    // Exactly the two kindergarten subjects, measured. A new empty pair at any other grade is a bank
    // gap the parent would meet as a dead subject, so it has to be seen here first.
    expect(empty).toEqual([
      { subject: 'spelling_vocabulary', grade: 0, startsAt: 1 },
      { subject: 'grammar_writing', grade: 0, startsAt: 1 },
    ]);
    // And every one of them can tell the parent where the subject does start, which is the sentence
    // that replaces the substitution.
    for (const row of empty) expect(row.startsAt, `${row.subject}`).not.toBeNull();
  });

  it('reports a start grade for every subject the bank covers', () => {
    for (const subject of BANK_SUBJECTS) {
      const startsAt = subjectStartsAtGrade(subject);
      expect(startsAt, subject).not.toBeNull();
      expect(startsAt!, subject).toBeGreaterThanOrEqual(0);
      expect(startsAt!, subject).toBeLessThanOrEqual(8);
      // A subject starts where it starts: at that grade it must offer something.
      expect(gradeSkills(subject, startsAt!).length, subject).toBeGreaterThan(0);
    }
  });
});
