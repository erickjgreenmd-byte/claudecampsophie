// Small builders shared by the bank generators.
import type { RandomSource } from '../shared/random.ts';
import { choiceLetters } from './grade.ts';
import { shortHash, shuffle } from './random.ts';
import { validateBankItem } from './validate.ts';
import {
  ORIGINAL_LICENSE,
  type AnswerSpec,
  type BankCategory,
  type BankItem,
  type BankSubject,
  type ChildPrompt,
  type ItemSource,
  type ResponseFormat,
  type WordProblemContext,
} from './types.ts';

export interface ItemDraft {
  readonly templateKey: string;
  readonly subject: BankSubject;
  readonly skill: string;
  readonly gradeMin: number;
  readonly gradeMax: number;
  readonly category: BankCategory;
  readonly prompt: ChildPrompt;
  readonly answerSpec: AnswerSpec;
  readonly explanation: string;
  readonly distractor: string;
  /** Parameters that identify the question (hashed into the opaque instance key). */
  readonly params: unknown;
  readonly source?: ItemSource;
  readonly license?: string;
  readonly wordProblem?: {
    readonly template: string;
    readonly numbers: readonly number[];
    readonly context: WordProblemContext;
  };
}

export function buildItem(d: ItemDraft): BankItem {
  return {
    templateKey: d.templateKey,
    instanceKey: `${d.templateKey}#${shortHash(JSON.stringify(d.params))}`,
    subject: d.subject,
    skill: d.skill,
    gradeMin: d.gradeMin,
    gradeMax: d.gradeMax,
    category: d.category,
    prompt: d.prompt,
    answerSpec: d.answerSpec,
    explanation: d.explanation,
    distractor: d.distractor,
    source: d.source ?? 'original',
    license: d.license ?? ORIGINAL_LICENSE,
    ...(d.wordProblem === undefined ? {} : { wordProblem: d.wordProblem }),
  };
}

export function prompt(
  text: string,
  responseFormat: ResponseFormat,
  options: {
    readonly unitHint?: string | null;
    readonly passage?: { readonly title: string; readonly text: string } | null;
    readonly choices?: readonly string[] | null;
  } = {},
): ChildPrompt {
  return {
    text,
    choices: options.choices ?? null,
    passage: options.passage ?? null,
    responseFormat,
    unitHint: options.unitHint ?? null,
  };
}

export function numericSpec(
  value: string | number,
  unit: string | null = null,
  alternates: readonly string[] = [],
): AnswerSpec {
  return { kind: 'numeric', value: String(value), unit, alternates };
}

export interface ChoiceSetup {
  readonly choices: readonly string[];
  readonly spec: AnswerSpec;
  /** A wrong letter (for self-validation). */
  readonly wrongLetter: string;
}

/**
 * Shuffles the correct choice among the distractors (seeded) and returns the private spec.
 * `fixedOrder` displays the choices in a natural fixed order instead (e.g. "<", "=", ">").
 */
export function choices(
  random: RandomSource,
  correct: string,
  distractors: readonly string[],
  fixedOrder?: readonly string[],
): ChoiceSetup {
  const ordered = fixedOrder ? [...fixedOrder] : shuffle(random, [correct, ...distractors]);
  const index = ordered.indexOf(correct);
  const letters = choiceLetters(ordered.length);
  const key = letters[index] ?? 'A';
  const wrong = letters.find((l) => l !== key) ?? 'A';
  return {
    choices: ordered,
    spec: { kind: 'multiple_choice', letters: [key], validLetters: letters, alternates: [] },
    wrongLetter: wrong,
  };
}

/** Plain (English) number formatting: thousands separators from 10,000 up. */
export function fmt(n: number): string {
  return Math.abs(n) >= 10_000 ? n.toLocaleString('en-US') : String(n);
}

export function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) [x, y] = [y, x % y];
  return x;
}

export function fraction(num: number, den: number): string {
  return `${num}/${den}`;
}

export function reducedFraction(num: number, den: number): string {
  const g = gcd(num, den);
  const n = num / g;
  const d = den / g;
  return d === 1 ? String(n) : `${n}/${d}`;
}

/**
 * Builds a curated item with up to `tries` different (seeded) choice orders and returns the first
 * that passes validation, or null. A leak-guard false positive on one letter order (for example
 * a passage word that reads like a cue before the key letter) then costs nothing.
 */
export function firstValid(make: () => BankItem, tries = 6): BankItem | null {
  for (let i = 0; i < tries; i += 1) {
    const item = make();
    if (validateBankItem(item).ok) return item;
  }
  return null;
}
