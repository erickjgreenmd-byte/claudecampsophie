// Vocabulary of the original question bank (spec P7 "reusable original question/template bank with
// validated answers, skill/grade tags, variable constraints, source/license metadata").

export const BANK_SUBJECTS = [
  'math',
  'reading',
  'spelling_vocabulary',
  'grammar_writing',
  'science',
  'social_studies',
] as const;
export type BankSubject = (typeof BANK_SUBJECTS)[number];

export function isBankSubject(value: unknown): value is BankSubject {
  return typeof value === 'string' && (BANK_SUBJECTS as readonly string[]).includes(value);
}

/** Launch scope is kindergarten (0) through grade 8. */
export const BANK_MIN_GRADE = 0;
export const BANK_MAX_GRADE = 8;

/**
 * Matches `ItemCategory` in `@pencillift/domain/learning`: `accessible` items are the easier,
 * confidence-building variants; `diagnostic` items are grade-level placement questions.
 */
export type BankCategory = 'standard' | 'accessible' | 'diagnostic';

/** How the child enters an answer; the screen chooses its keyboard/control from this. */
export type ResponseFormat = 'number' | 'division' | 'choice' | 'word' | 'text';

/**
 * CHILD-SAFE rendered question. Contains no answer, key, explanation or grading data; every item
 * is checked with the answer-leak guard against its own key before it can be emitted.
 */
export interface ChildPrompt {
  readonly text: string;
  /** Choice texts in display order (the screen labels them A, B, C, ...); null if not a choice. */
  readonly choices: readonly string[] | null;
  readonly passage: { readonly title: string; readonly text: string } | null;
  readonly responseFormat: ResponseFormat;
  /** Unit the answer is written in, e.g. "cm" (shown next to the answer box), or null. */
  readonly unitHint: string | null;
}

/** PRIVATE answer specification. Lives only in private storage; never in a child DTO. */
export type AnswerSpec =
  | {
      readonly kind: 'numeric';
      /** Exact value, e.g. "85", "3/4", "0.75". Equivalent values are accepted. */
      readonly value: string;
      /** Unit of the value ("cm", "min") or null for a plain number. */
      readonly unit: string | null;
      readonly alternates: readonly string[];
    }
  | {
      readonly kind: 'division_remainder';
      readonly quotient: number;
      readonly remainder: number;
      readonly divisor: number;
      readonly alternates: readonly string[];
    }
  | {
      readonly kind: 'multiple_choice';
      /** Exactly one letter. */
      readonly letters: readonly string[];
      readonly validLetters: readonly string[];
      readonly alternates: readonly string[];
    }
  | {
      readonly kind: 'spelling';
      readonly target: string;
      readonly alternates: readonly string[];
    }
  | {
      readonly kind: 'exact_text';
      readonly accepted: readonly string[];
      readonly alternates: readonly string[];
    };

export type AnswerSpecKind = AnswerSpec['kind'];

export type ItemSource = 'original' | 'teacher_list' | 'parent_passage';

/** Story context of a word-problem template; the only part AI personalization may change. */
export interface WordProblemContext {
  readonly name: string;
  readonly things: string;
  readonly place: string;
}

export interface BankItem {
  /** Reusable, nonpersonal template/generator key, e.g. `math.addition_regrouping.v1`. */
  readonly templateKey: string;
  /**
   * Opaque unique key of this concrete question (template + parameters hashed). Used to avoid
   * exact repeats. Never derived from answer text in readable form.
   */
  readonly instanceKey: string;
  readonly subject: BankSubject;
  readonly skill: string;
  readonly gradeMin: number;
  readonly gradeMax: number;
  readonly category: BankCategory;
  readonly prompt: ChildPrompt;
  readonly answerSpec: AnswerSpec;
  /** Parent-only teaching explanation. */
  readonly explanation: string;
  /** An answer a child might give that MUST grade incorrect (self-validation). */
  readonly distractor: string;
  readonly source: ItemSource;
  /** `PencilLift original` for bank content; teacher/parent material stays the family's own. */
  readonly license: string;
  /** Present on word-problem items whose story context can be re-themed safely. */
  readonly wordProblem?: {
    readonly template: string;
    readonly numbers: readonly number[];
    readonly context: WordProblemContext;
  };
}

export const ORIGINAL_LICENSE = 'PencilLift original content';
