// Candidate generation for daily sets and Thursday reviews. Everything returned here has passed
// `validateBankItem`; failed draws are discarded and redrawn (bounded), never emitted.
import type { RandomSource } from '../shared/random.ts';
import { factItems } from './facts.ts';
import { GRAMMAR_GENERATORS } from './grammar.ts';
import { MATH_GENERATORS, type GenContext } from './math.ts';
import { seededRandom } from './random.ts';
import { parentPassageItems, passageItems } from './reading.ts';
import { SKILLS, bankGrade, skillDefinition, skillsForGrade } from './skills.ts';
import { SPELLING_GENERATORS, parseSpellingList, teacherWordItems } from './spelling.ts';
import { BANK_SUBJECTS, type BankCategory, type BankItem, type BankSubject } from './types.ts';
import { validateBankItem } from './validate.ts';

type Generator = (ctx: GenContext) => BankItem;

const GENERATORS: Readonly<Record<string, Generator>> = {
  ...MATH_GENERATORS,
  ...GRAMMAR_GENERATORS,
  ...SPELLING_GENERATORS,
};

/** Skills produced by a parameterized generator (as opposed to curated or family material). */
export function hasGenerator(skill: string): boolean {
  return Object.hasOwn(GENERATORS, skill);
}

/** Bounded redraws per requested item before the generator is considered exhausted. */
const MAX_DRAWS_PER_ITEM = 12;

/**
 * Up to `count` distinct valid items from a parameterized generator. Returns fewer when valid
 * distinct draws run out (never an unvalidated item).
 */
export function generateSkillItems(
  skill: string,
  options: {
    readonly random: RandomSource;
    readonly grade: number;
    readonly category: BankCategory;
    readonly count: number;
  },
): BankItem[] {
  const generator = GENERATORS[skill];
  if (generator === undefined) return [];
  const ctx: GenContext = {
    random: options.random,
    grade: bankGrade(options.grade),
    category: options.category,
  };
  const out: BankItem[] = [];
  const seen = new Set<string>();
  for (
    let draws = 0;
    out.length < options.count && draws < options.count * MAX_DRAWS_PER_ITEM;
    draws += 1
  ) {
    const item = generator(ctx);
    if (seen.has(item.instanceKey)) continue;
    seen.add(item.instanceKey);
    if (validateBankItem(item).ok) out.push(item);
  }
  return out;
}

export interface FamilyMaterial {
  /** Teacher spelling lists (raw text), newest first. */
  readonly spellingLists?: readonly { readonly id: string; readonly text: string }[];
  /** Parent-supplied reading passages (raw text), newest first. */
  readonly readingPassages?: readonly { readonly id: string; readonly text: string }[];
}

export interface CandidateOptions {
  readonly subjects: readonly BankSubject[];
  /** Child grade 0..12 (clamped to the K-8 bank). */
  readonly grade: number;
  /** Seed for reproducible generation (e.g. the set key). */
  readonly seed: string;
  /** Instances per generated skill and category (default 2 standard, 1 accessible, 1 diagnostic). */
  readonly perSkill?: {
    readonly standard: number;
    readonly accessible: number;
    readonly diagnostic: number;
  };
  readonly material?: FamilyMaterial;
  /** Restrict to these skills (e.g. only what a review needs); default all grade skills. */
  readonly skills?: ReadonlySet<string>;
}

const DEFAULT_PER_SKILL = { standard: 2, accessible: 1, diagnostic: 1 } as const;

function uniqueByInstance(items: readonly BankItem[]): BankItem[] {
  const seen = new Set<string>();
  const out: BankItem[] = [];
  for (const item of items) {
    if (seen.has(item.instanceKey)) continue;
    seen.add(item.instanceKey);
    out.push(item);
  }
  return out;
}

/**
 * Validated candidate items for the given subjects and grade, including family material (teacher
 * spelling words, parent passages). Deterministic for a given seed.
 */
export function generateCandidates(options: CandidateOptions): BankItem[] {
  const childGrade = bankGrade(options.grade);
  const per = options.perSkill ?? DEFAULT_PER_SKILL;
  const random = seededRandom(`bank:${options.seed}`);
  const wanted = (skill: string): boolean =>
    options.skills === undefined || options.skills.has(skill);
  const items: BankItem[] = [];
  for (const subject of BANK_SUBJECTS) {
    if (!options.subjects.includes(subject)) continue;
    const grade = subjectGrade(subject, childGrade);
    for (const def of skillsForGrade(subject, grade)) {
      if (!wanted(def.skill) || !hasGenerator(def.skill)) continue;
      for (const [category, count] of [
        ['diagnostic', per.diagnostic],
        ['standard', per.standard],
        ['accessible', per.accessible],
      ] as const) {
        if (count > 0)
          items.push(...generateSkillItems(def.skill, { random, grade, category, count }));
      }
    }
    if (subject === 'reading') {
      // Family material first: selection breaks ties by candidate order, so the child's current
      // passage is preferred over a bank passage for the same skill (spec P7).
      for (const passage of options.material?.readingPassages ?? []) {
        items.push(
          ...parentPassageItems(random, passage.id, passage.text, childGrade).filter(
            (i) => wanted(i.skill) && validateBankItem(i).ok,
          ),
        );
      }
      for (const category of ['standard', 'accessible'] as const) {
        items.push(...passageItems(random, grade, category).filter((i) => wanted(i.skill)));
      }
    }
    if (subject === 'science' || subject === 'social_studies') {
      for (const category of ['standard', 'accessible'] as const) {
        items.push(...factItems(random, subject, grade, category).filter((i) => wanted(i.skill)));
      }
    }
    if (subject === 'spelling_vocabulary' && wanted('spelling.teacher_list')) {
      const list = options.material?.spellingLists?.[0];
      if (list !== undefined) {
        const words = parseSpellingList(list.text);
        for (const word of words) {
          items.push(
            ...teacherWordItems(random, word, words, childGrade).filter(
              (i) => validateBankItem(i).ok,
            ),
          );
        }
      }
    }
  }
  // Every path above validates (generators, curated `firstValid`, family material filters), so
  // nothing reaches a set without passing `validateBankItem`.
  return uniqueByInstance(items);
}

/**
 * The grade whose items a subject uses for a child. Decision: when a subject has no skill at the
 * child's grade (kindergarten grammar and spelling), the nearest supported grade is used and the
 * coverage report says so; grades above 8 use grade 8.
 */
export function subjectGrade(subject: BankSubject, grade: number): number {
  const g = bankGrade(grade);
  if (skillsForGrade(subject, g).some((d) => d.source !== 'family_material')) return g;
  const mins = SKILLS.filter((d) => d.subject === subject && d.source !== 'family_material').map(
    (d) => d.gradeMin,
  );
  return mins.length === 0 ? g : Math.min(...mins.filter((m) => m >= g), bankGrade(8));
}

/** The generated/curated skills a subject offers a child (grade fallback lists, diagnostics). */
export function gradeSkills(subject: BankSubject, grade: number): string[] {
  return skillsForGrade(subject, subjectGrade(subject, grade))
    .filter((d) => d.source !== 'family_material')
    .map((d) => d.skill);
}

export function isKnownSkill(skill: string): boolean {
  return skillDefinition(skill) !== undefined;
}
