// Honest coverage report (AC_LEARNING_05: "All six subject areas have meaningful usable content or
// clearly identified unsupported coverage; no fake content completion").
import { SCIENCE_ITEMS, SOCIAL_STUDIES_ITEMS } from './facts.ts';
import { PASSAGES } from './reading.ts';
import { SKILLS, bankGrade, type SkillDefinition } from './skills.ts';
import { BANK_MAX_GRADE, BANK_SUBJECTS, type AnswerSpecKind, type BankSubject } from './types.ts';

export interface CoverageSkill {
  readonly skill: string;
  readonly label: string;
  readonly gradeMin: number;
  readonly gradeMax: number;
  readonly answerKinds: readonly AnswerSpecKind[];
  /** generated = parameterized templates; curated = fixed original items; family_material = needs the family's list. */
  readonly source: SkillDefinition['source'];
  /** Distinct fixed items for curated skills (null for generated/family skills). */
  readonly curatedItems: number | null;
}

export interface SubjectCoverage {
  readonly subject: BankSubject;
  readonly skills: readonly CoverageSkill[];
  /** Explicitly unsupported niches: no generated practice; custom generation/review needed. */
  readonly unsupported: readonly string[];
}

export interface BankCoverage {
  readonly gradeRange: { readonly min: number; readonly max: number };
  readonly subjects: readonly SubjectCoverage[];
  /** Applies to every subject. */
  readonly general: readonly string[];
}

/** Stable, reviewed list of what the bank does NOT cover. */
export const UNSUPPORTED_NICHES: Readonly<Record<BankSubject, readonly string[]>> = {
  math: [
    'Geometry beyond rectangle area/perimeter (angles, volume, proofs)',
    'Graphs, charts, number lines and anything that needs a picture or diagram',
    'Money and time-telling with clock faces',
    'Multi-step and multi-digit long division layouts; division without a whole-number quotient',
    'Negative numbers, exponents, ratios/rates and multi-step algebra (grades 6-8 beyond one-step equations and percent of a number)',
  ],
  reading: [
    'Inference, theme or main-idea questions on a family’s own passage (needs AI generation plus review)',
    'Chapter books, poetry analysis and paired-text comparison',
    'Open-ended written responses (rubric feedback only; never auto-graded)',
  ],
  spelling_vocabulary: [
    'Dictation or audio spelling (no audio)',
    'Definitions or example sentences for teacher-list words (only missing-letter and choose-the-spelling practice)',
    'Vocabulary from a specific classroom program beyond the words a parent enters',
  ],
  grammar_writing: [
    'Paragraph and essay writing (rubric feedback only; never generated as right/wrong practice)',
    'Sentence combining, editing whole passages, verb tenses beyond agreement, pronouns and apostrophes',
  ],
  science: [
    'Labs, experiments, diagrams and data tables',
    'Local or state-specific units and topics outside the curated set (e.g. chemistry equations, genetics)',
  ],
  social_studies: [
    'State and local history, current events and primary-source analysis',
    'Map-reading with images',
    'Topics outside the curated set',
  ],
};

export const GENERAL_UNSUPPORTED: readonly string[] = [
  'Grades 9-12 (the launch bank is kindergarten through grade 8; older children get grade-8 items)',
  'Kindergarten grammar and spelling (kindergartners get the easiest grade-1 items in those subjects)',
  'Custom parent-added subjects (no generated practice; add study material or review with the child)',
  'Languages other than English',
];

/** Curated item grade ranges for a skill (fact items and passage questions). */
function curatedRanges(def: SkillDefinition): readonly { gradeMin: number; gradeMax: number }[] {
  if (def.subject === 'science' || def.subject === 'social_studies') {
    const pool = def.subject === 'science' ? SCIENCE_ITEMS : SOCIAL_STUDIES_ITEMS;
    return pool.filter((i) => i.skill === def.skill);
  }
  if (def.subject === 'reading') {
    return PASSAGES.flatMap((p) => p.questions.filter((q) => q.skill === def.skill).map(() => p));
  }
  return [];
}

/**
 * Distinct fixed items a curated skill can serve (null for generated/family skills). With a grade,
 * only items the generator actually serves at that grade count: standard items target the grade
 * and accessible items one grade below (as `factItems`/`passageItems` do). A skill whose count is 0
 * at a grade is not listed as supported there (review finding RV-learning-bank-3).
 */
function curatedCount(def: SkillDefinition, grade: number | null): number | null {
  if (def.source !== 'curated') return null;
  const targets = grade === null ? null : [grade, Math.max(0, grade - 1)];
  return curatedRanges(def).filter(
    (r) => targets === null || targets.some((t) => r.gradeMin <= t && t <= r.gradeMax),
  ).length;
}

/**
 * Supported skills per subject (optionally only those the bank can serve at `grade`) plus the
 * explicitly unsupported niches. Nothing here claims completeness.
 */
export function bankCoverage(grade?: number): BankCoverage {
  const g = grade === undefined ? null : bankGrade(grade);
  return {
    gradeRange: { min: 0, max: BANK_MAX_GRADE },
    subjects: BANK_SUBJECTS.map((subject) => ({
      subject,
      skills: SKILLS.filter(
        (s) => s.subject === subject && (g === null || (s.gradeMin <= g && g <= s.gradeMax)),
      ).flatMap((s) => {
        const curatedItems = curatedCount(s, g);
        // A curated skill with no item at this grade is not supported here (no fake completion).
        if (curatedItems === 0) return [];
        return [
          {
            skill: s.skill,
            label: s.label,
            gradeMin: s.gradeMin,
            gradeMax: s.gradeMax,
            answerKinds: s.answerKinds,
            source: s.source,
            curatedItems,
          },
        ];
      }),
      unsupported: UNSUPPORTED_NICHES[subject],
    })),
    general: GENERAL_UNSUPPORTED,
  };
}
