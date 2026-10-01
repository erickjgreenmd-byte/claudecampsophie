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
 *
 * `avoid` carries instance keys an EARLIER call already took, so a caller asking for a skill in
 * several categories gets distinct items instead of duplicates a later dedupe silently drops: the
 * collision redraws here, inside the draw budget, where there is still something to draw.
 */
export function generateSkillItems(
  skill: string,
  options: {
    readonly random: RandomSource;
    readonly grade: number;
    readonly category: BankCategory;
    readonly count: number;
    readonly avoid?: ReadonlySet<string>;
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
  const seen = new Set<string>(options.avoid);
  // The budget covers the items ALREADY taken as well as the ones wanted. A generator draws from a
  // pool it cannot see, so the last item of a four-word grade-1 pool needs about four draws per
  // attempt, not one: a budget of `count * MAX_DRAWS_PER_ITEM` gave the final `avoid`-constrained
  // call 12 draws at a 1-in-4 hit rate and came up short for one child in fifty (BUG-429).
  const budget = (options.count + seen.size) * MAX_DRAWS_PER_ITEM;
  for (let draws = 0; out.length < options.count && draws < budget; draws += 1) {
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
      // One set per SKILL, spanning its three category draws. Without it the accessible or
      // diagnostic draw could repeat a standard one, `uniqueByInstance` below would drop the
      // repeat, and that child's pool for the skill would be short by one for the rest of the
      // run — so the weak part of their daily set had one fewer question on the skill they are
      // failing, decided by nothing but their random id (BUG-429).
      const taken = new Set<string>();
      for (const [category, count] of [
        ['diagnostic', per.diagnostic],
        ['standard', per.standard],
        ['accessible', per.accessible],
      ] as const) {
        if (count === 0) continue;
        const drawn = generateSkillItems(def.skill, {
          random,
          grade,
          category,
          count,
          avoid: taken,
        });
        for (const item of drawn) taken.add(item.instanceKey);
        items.push(...drawn);
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
 * How far the bank may reach from a child's own grade when that grade has no content for a subject.
 *
 * OWNER RULE (2026-09-30, amended): "we can reach up or down 1 or 2." So a subject with nothing at the
 * child's grade uses the NEAREST grade that has content, provided it is within two grades; beyond that
 * the subject offers nothing and `subjectStartsAtGrade` says where it does begin.
 *
 * This bounds the SUBSTITUTION only — the grade the generator aims at when the child's own grade is
 * empty. It is NOT a cap on revision. A child's prerequisite work comes from skills they have actually
 * got wrong, and a grade-8 child with a grade-2 gap must still be given grade-2 practice; capping that
 * at two grades would forbid exactly the remediation the evidence calls for. The two are different
 * things: one is an assumption about a grade, the other is a response to a child.
 */
export const SUBJECT_GRADE_REACH = 2;

/**
 * The grade whose items a subject uses for a child: the child's own grade when it has content, else the
 * nearest grade within `SUBJECT_GRADE_REACH`, else the child's own grade (which yields nothing).
 *
 * This used to reach UPWARD without any bound — "the nearest supported grade is used and the coverage
 * report says so" — which put grade-1 spelling and grammar in front of KINDERGARTEN children with no
 * limit on how far it could go and no notice a parent would ever see. Those two were the only cases in
 * the band, and both are within the reach the owner has now set, so both are covered again; what has
 * changed is that the distance is bounded, asserted, and stated.
 *
 * Ties go DOWN. When the child's grade is equally far from content above and below, the lower grade is
 * chosen: easier practice is the safer error for a child whose own grade the bank cannot serve.
 *
 * `packages/domain/src/bank/grade-isolation.test.ts` asserts the bound on the ITEMS, over every grade
 * and subject, so a change anywhere in the generation path that reaches further reds.
 */
export function subjectGrade(subject: BankSubject, grade: number): number {
  const g = bankGrade(grade);
  if (hasBankContent(subject, g)) return g;
  for (let distance = 1; distance <= SUBJECT_GRADE_REACH; distance += 1) {
    const down = bankGrade(g - distance);
    if (down !== g && hasBankContent(subject, down)) return down;
    const up = bankGrade(g + distance);
    if (up !== g && hasBankContent(subject, up)) return up;
  }
  return g;
}

/** Whether a subject has any bank skill at a grade (family material is the parent's, not the bank's). */
function hasBankContent(subject: BankSubject, grade: number): boolean {
  return skillsForGrade(subject, grade).some((d) => d.source !== 'family_material');
}

/**
 * The lowest grade at which a subject has any bank skill, or null when it has none at all. What the
 * product tells a parent whose child's grade is further than `SUBJECT_GRADE_REACH` below a subject's
 * start, in place of a silent substitution. Family material is excluded: a parent's own spelling list is
 * theirs to set at any grade and is not what "the bank starts here" means.
 */
export function subjectStartsAtGrade(subject: BankSubject): number | null {
  const mins = SKILLS.filter((d) => d.subject === subject && d.source !== 'family_material').map(
    (d) => d.gradeMin,
  );
  return mins.length === 0 ? null : Math.min(...mins);
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
