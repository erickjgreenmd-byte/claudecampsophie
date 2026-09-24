// Validates and normalizes protected answers into comparison targets.

import { err, ok, type Result } from '../shared/result.ts';
import { canonicalize } from './canonicalize.ts';
import { extractNumericMentionsDetailed, type NumericMention } from './numbers.ts';
import { abs, type Rational } from './rational.ts';
import {
  PROTECTED_ANSWER_KINDS,
  type AnswerGuardErrorCode,
  type ProtectedAnswer,
  type ProtectedAnswerKind,
} from './types.ts';

export const MAX_PROTECTED_ANSWERS = 32;
export const MAX_ANSWER_LENGTH = 2_000;
export const MAX_ALTERNATES = 32;

export interface NumericTarget {
  readonly value: Rational;
  /** Decimal places as written in the answer (for rounding comparison), else null. */
  readonly decimalPlaces: number | null;
  /** Absolute integer digits when the value is an integer, for separated/reversed digit checks. */
  readonly digits: string | null;
}

export interface TextTarget {
  /** Canonical lowercase words of the target, in order. */
  readonly words: readonly string[];
  /** Words concatenated (letters and digits only). */
  readonly letters: string;
  /** Detector that owns this target: the answer kind, or 'text' for a non-numeric alternate. */
  readonly detector: 'spelling' | 'text';
}

export interface NormalizedAnswer {
  readonly index: number;
  readonly kind: ProtectedAnswerKind;
  readonly numeric: readonly NumericTarget[];
  readonly choiceLetters: readonly string[];
  readonly targets: readonly TextTarget[];
  /** Short literal forms whose base64/hex encodings are searched for directly. */
  readonly literalForms: readonly string[];
}

const DECIMAL_READINGS = new Set(['decimal', 'thousands', 'alt_locale', 'percent']);

function ownString(source: object, field: string): unknown {
  return Object.hasOwn(source, field) ? (source as Record<string, unknown>)[field] : undefined;
}

/**
 * Numeric readings that cover the answer: mentions not strictly contained in a longer mention,
 * preferring the English reading when a locale-ambiguous reading has the same span.
 */
function maximalMentions(mentions: readonly NumericMention[]): NumericMention[] {
  const maximal = mentions.filter(
    (m) =>
      !mentions.some(
        (o) => o.start <= m.start && o.end >= m.end && o.end - o.start > m.end - m.start,
      ),
  );
  return maximal.filter(
    (m) =>
      m.reading !== 'alt_locale' ||
      !maximal.some((o) => o.start === m.start && o.end === m.end && o.reading !== 'alt_locale'),
  );
}

function numericTarget(value: Rational, decimalPlaces: number | null): NumericTarget {
  const a = abs(value);
  return { value: a, decimalPlaces, digits: a.den === 1n ? a.num.toString() : null };
}

interface NumericParse {
  readonly targets: NumericTarget[];
  /** True when letters remain outside the numeric spans (e.g. "12 apples"). */
  readonly hasOtherWords: boolean;
}

function parseNumeric(raw: string): NumericParse | null {
  const canon = canonicalize(raw);
  // Answers are not documents: no list-marker masking.
  const { mentions } = extractNumericMentionsDetailed(canon, { maskMarkers: false });
  const chosen = maximalMentions(mentions);
  if (chosen.length === 0) return null;
  const targets: NumericTarget[] = [];
  for (const m of chosen) {
    targets.push(numericTarget(m.value, DECIMAL_READINGS.has(m.reading) ? m.decimalPlaces : null));
    if (m.reading === 'percent') {
      // Decision: a percent answer ("50%") also protects its bare number ("50").
      const bare = mentions.find(
        (o) => o.start === m.start && o.reading !== 'percent' && o.end <= m.end,
      );
      if (bare !== undefined) targets.push(numericTarget(bare.value, bare.decimalPlaces));
    }
  }
  let rest = canon;
  for (const m of chosen)
    rest = rest.slice(0, m.start) + ' '.repeat(m.end - m.start) + rest.slice(m.end);
  return { targets, hasOtherWords: /\p{L}{2,}/u.test(rest) };
}

function textTarget(raw: string, detector: 'spelling' | 'text'): TextTarget | null {
  const words = canonicalize(raw).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return null;
  return { words, letters: words.join(''), detector };
}

const CHOICE_PREFIX_RE = /^(?:option|choice|letter|answer|opcion|letra|respuesta)\s*/u;

function choiceLetter(raw: string): string | null {
  const letters = canonicalize(raw)
    .replace(CHOICE_PREFIX_RE, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
  return /^[a-z]$/u.test(letters) ? letters : null;
}

function literalFormsFor(
  numeric: readonly NumericTarget[],
  targets: readonly TextTarget[],
  choiceLetters: readonly string[],
): string[] {
  const forms = new Set<string>();
  for (const letter of choiceLetters) {
    forms.add(letter);
    forms.add(letter.toUpperCase());
  }
  for (const t of numeric) {
    const { num, den } = t.value;
    if (den === 1n) forms.add(num.toString());
    else forms.add(`${num}/${den}`);
    // terminating decimal form, e.g. 0.5
    for (let places = 1; places <= 6; places++) {
      const scale = 10n ** BigInt(places);
      if ((num * scale) % den === 0n && den !== 1n) {
        const scaled = ((num * scale) / den).toString().padStart(places + 1, '0');
        forms.add(`${scaled.slice(0, -places)}.${scaled.slice(-places)}`);
        break;
      }
    }
  }
  for (const t of targets) {
    const phrase = t.words.join(' ');
    if (phrase.length > 32) continue;
    forms.add(phrase);
    forms.add(phrase.toUpperCase());
    forms.add(phrase.charAt(0).toUpperCase() + phrase.slice(1));
  }
  return [...forms];
}

type Checked = Result<NormalizedAnswer, AnswerGuardErrorCode>;

function normalizeOne(item: unknown, index: number): Checked {
  if (typeof item !== 'object' || item === null) {
    return err('INVALID_ANSWER_KIND', `answer ${index} is not an object`);
  }
  const kind = ownString(item, 'kind');
  if (typeof kind !== 'string' || !(PROTECTED_ANSWER_KINDS as readonly string[]).includes(kind)) {
    return err('INVALID_ANSWER_KIND', `answer ${index} has an unknown kind`);
  }
  const answerKind = kind as ProtectedAnswerKind;
  const value = ownString(item, 'value');
  if (typeof value !== 'string' || !/[\p{L}\p{N}]/u.test(canonicalize(value))) {
    return err('EMPTY_ANSWER_VALUE', `answer ${index} has no value`);
  }
  if (value.length > MAX_ANSWER_LENGTH) {
    return err('ANSWER_TOO_LONG', `answer ${index} exceeds ${MAX_ANSWER_LENGTH} characters`);
  }
  const rawAlternates = ownString(item, 'alternates');
  let alternates: readonly string[] = [];
  if (rawAlternates !== undefined) {
    if (
      !Array.isArray(rawAlternates) ||
      rawAlternates.length > MAX_ALTERNATES ||
      !rawAlternates.every(
        (a): a is string =>
          typeof a === 'string' &&
          a.length <= MAX_ANSWER_LENGTH &&
          /[\p{L}\p{N}]/u.test(canonicalize(a)),
      )
    ) {
      return err('INVALID_ALTERNATES', `answer ${index} has invalid alternates`);
    }
    alternates = rawAlternates;
  }

  const numeric: NumericTarget[] = [];
  const choiceLetters: string[] = [];
  const targets: TextTarget[] = [];

  switch (answerKind) {
    case 'numeric': {
      const parsed = parseNumeric(value);
      if (parsed === null) {
        return err('UNPARSEABLE_NUMERIC_ANSWER', `answer ${index} is not a readable number`);
      }
      numeric.push(...parsed.targets);
      break;
    }
    case 'multiple_choice': {
      const letter = choiceLetter(value);
      if (letter === null) {
        return err('INVALID_MULTIPLE_CHOICE_VALUE', `answer ${index} is not a single letter`);
      }
      choiceLetters.push(letter);
      break;
    }
    case 'spelling':
    case 'text': {
      const target = textTarget(value, answerKind);
      if (target === null) return err('EMPTY_ANSWER_VALUE', `answer ${index} has no value`);
      targets.push(target);
      break;
    }
  }

  // Decision: alternates are protected by what they look like. A single letter is a choice
  // letter (multiple choice only); a readable number is a numeric target; anything else (or any
  // words left beside a number) is a text target. Spelling/text alternates stay text targets.
  for (const alternate of alternates) {
    if (answerKind === 'spelling' || answerKind === 'text') {
      const target = textTarget(alternate, answerKind);
      if (target !== null) targets.push(target);
      continue;
    }
    const letter = answerKind === 'multiple_choice' ? choiceLetter(alternate) : null;
    if (letter !== null) {
      choiceLetters.push(letter);
      continue;
    }
    const parsed = parseNumeric(alternate);
    if (parsed !== null) numeric.push(...parsed.targets);
    if (parsed === null || parsed.hasOtherWords) {
      const target = textTarget(alternate, 'text');
      if (target !== null) targets.push(target);
    }
  }

  return ok({
    index,
    kind: answerKind,
    numeric,
    choiceLetters: [...new Set(choiceLetters)],
    targets,
    literalForms: literalFormsFor(numeric, targets, choiceLetters),
  });
}

/** Validates and normalizes a protected-answer list. Expected failures are Result errors. */
export function normalizeProtectedAnswers(
  answers: unknown,
): Result<readonly NormalizedAnswer[], AnswerGuardErrorCode> {
  if (!Array.isArray(answers)) return err('INVALID_ANSWER_LIST', 'answers must be an array');
  if (answers.length > MAX_PROTECTED_ANSWERS) {
    return err('TOO_MANY_ANSWERS', `at most ${MAX_PROTECTED_ANSWERS} protected answers`);
  }
  const out: NormalizedAnswer[] = [];
  for (let i = 0; i < answers.length; i++) {
    const checked = normalizeOne(answers[i] as unknown, i);
    if (!checked.ok) return checked;
    out.push(checked.value);
  }
  return ok(out);
}

/** Public validation entry point: the same checks as the scanners, without scanning. */
export function validateProtectedAnswers(
  answers: unknown,
): Result<readonly ProtectedAnswer[], AnswerGuardErrorCode> {
  const normalized = normalizeProtectedAnswers(answers);
  return normalized.ok ? ok(answers as readonly ProtectedAnswer[]) : normalized;
}
