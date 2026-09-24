import {
  isSimplestForm,
  MAX_ANSWER_LENGTH,
  MAX_EXPONENT,
  normalizeMathText,
  parseMathAnswer,
  parseMathAnswerDetailed,
  type AnswerForm,
} from './parse.ts';
import {
  absRational,
  addRational,
  compareRational,
  equalsRational,
  isIntegerRational,
  multiplyRational,
  rational,
  roundRationalToPlaces,
  subtractRational,
  type Rational,
} from './rational.ts';
import { collapseWhitespace, foldQuotes, isBlankAnswer, stripInvisible } from './text.ts';
import { convertValue, lookupUnit, parseQuantityDetailed } from './units.ts';
import { outcome, type CheckResult } from './verdicts.ts';

// =============================================================================================
// Numeric answers (with optional units, tolerance and simplest-form requirement)
// =============================================================================================

export type Tolerance =
  | { readonly kind: 'exact' }
  | { readonly kind: 'absolute'; readonly value: string }
  | { readonly kind: 'round_to_places'; readonly places: number };

export interface NumericExpected {
  /** Exact expression for the key, e.g. "5/2" or "3.14159". */
  readonly value: string;
  /** Unit the key is expressed in ("m", "$", "cm^2", ...). */
  readonly unit?: string;
  readonly requireUnit?: boolean;
  /** Default true: "300 cm" is correct for "3 m". */
  readonly acceptEquivalentUnits?: boolean;
  readonly tolerance?: Tolerance;
  readonly requireSimplestForm?: boolean;
}

export interface NumericAnswerInput {
  readonly studentAnswer: string;
  readonly expected: NumericExpected;
}

type PreparedTolerance =
  | { readonly kind: 'exact' }
  | { readonly kind: 'absolute'; readonly value: Rational }
  | { readonly kind: 'round_to_places'; readonly places: number };

type Comparison = 'match' | 'within_tolerance' | 'not_rounded' | 'mismatch';

/** Answer keys may come from extraction models, so a malformed key is data, not a crash. */
function prepareTolerance(tolerance: Tolerance | undefined): PreparedTolerance | null {
  if (tolerance === undefined) return { kind: 'exact' };
  switch (tolerance.kind) {
    case 'exact':
      return tolerance;
    case 'absolute': {
      const parsed = parseMathAnswer(tolerance.value);
      if (!parsed.ok || parsed.value.num < 0n) return null;
      return { kind: 'absolute', value: parsed.value };
    }
    case 'round_to_places':
      return Number.isSafeInteger(tolerance.places) && Math.abs(tolerance.places) <= MAX_EXPONENT
        ? tolerance
        : null;
    default:
      return null;
  }
}

/**
 * round_to_places: the student must give the key rounded half-up to N places. Decision: an
 * unrounded answer whose rounding would match (3.14159 for "round to hundredths") is incorrect
 * with NOT_ROUNDED rather than correct, because the rounding instruction was not followed; a
 * value that rounds differently is a plain VALUE_MISMATCH.
 */
function compareValues(student: Rational, key: Rational, tolerance: PreparedTolerance): Comparison {
  switch (tolerance.kind) {
    case 'exact':
      return equalsRational(student, key) ? 'match' : 'mismatch';
    case 'absolute': {
      if (equalsRational(student, key)) return 'match';
      const distance = absRational(subtractRational(student, key));
      return compareRational(distance, tolerance.value) <= 0 ? 'within_tolerance' : 'mismatch';
    }
    case 'round_to_places': {
      const target = roundRationalToPlaces(key, tolerance.places);
      if (equalsRational(student, target)) return 'match';
      return equalsRational(roundRationalToPlaces(student, tolerance.places), target)
        ? 'not_rounded'
        : 'mismatch';
    }
  }
}

function judge(
  student: Rational,
  key: Rational,
  tolerance: PreparedTolerance,
  form: AnswerForm,
  requireSimplestForm: boolean,
  convertedUnit: boolean,
): CheckResult {
  const comparison = compareValues(student, key, tolerance);
  switch (comparison) {
    case 'mismatch':
      return outcome('incorrect', 'VALUE_MISMATCH');
    case 'not_rounded':
      return outcome('incorrect', 'NOT_ROUNDED');
    case 'match':
    case 'within_tolerance':
      if (requireSimplestForm && !isSimplestForm(form))
        return outcome('incorrect', 'NOT_SIMPLIFIED');
      if (convertedUnit) return outcome('correct', 'EQUIVALENT_UNIT');
      return outcome('correct', comparison === 'match' ? 'EXACT_MATCH' : 'WITHIN_TOLERANCE');
  }
}

/**
 * True when a value mismatch would disappear if the student's number were scaled by 100 (i.e.
 * the other reading of a percent). Only overrides VALUE_MISMATCH, never another verdict.
 */
function percentReadingMatches(
  result: CheckResult,
  value: Rational,
  key: Rational,
  tolerance: PreparedTolerance,
): boolean {
  return (
    result.reason === 'VALUE_MISMATCH' &&
    compareValues(multiplyRational(value, rational(100n)), key, tolerance) !== 'mismatch'
  );
}

/**
 * Deterministic numeric check (spec P5: equivalent fractions, units, rounding tolerance).
 * Blank -> unanswered; anything the parser cannot read unambiguously -> unresolved (never
 * incorrect); a malformed answer key -> unresolved INVALID_ANSWER_KEY.
 */
export function checkNumericAnswer({ studentAnswer, expected }: NumericAnswerInput): CheckResult {
  if (isBlankAnswer(studentAnswer)) return outcome('unanswered', 'BLANK');
  if (typeof expected.value !== 'string') return outcome('unresolved', 'INVALID_ANSWER_KEY');
  const key = parseMathAnswer(expected.value);
  const tolerance = prepareTolerance(expected.tolerance);
  if (!key.ok || tolerance === null) return outcome('unresolved', 'INVALID_ANSWER_KEY');
  const requireSimplestForm = expected.requireSimplestForm === true;

  if (expected.unit === undefined) {
    const parsed = parseMathAnswerDetailed(studentAnswer);
    if (!parsed.ok) {
      const quantity = parseQuantityDetailed(studentAnswer);
      if (quantity.ok && quantity.value.unit !== null) {
        return outcome('unresolved', 'UNEXPECTED_UNIT');
      }
      return outcome('unresolved', parsed.error.code);
    }
    const { value, form } = parsed.value;
    const result = judge(value, key.value, tolerance, form, requireSimplestForm, false);
    // Decision: "50%" for a unitless key of 50 may be a key that forgot its % unit; the student's
    // number would match without the percent reading, so a person decides.
    return form.kind === 'percent' && percentReadingMatches(result, value, key.value, tolerance)
      ? outcome('unresolved', 'AMBIGUOUS_PERCENT')
      : result;
  }

  const keyUnit = lookupUnit(expected.unit);
  if (keyUnit === null) return outcome('unresolved', 'INVALID_ANSWER_KEY');
  const parsed = parseQuantityDetailed(studentAnswer);
  if (!parsed.ok) return outcome('unresolved', parsed.error.code);
  const student = parsed.value;

  if (student.unit === null) {
    if (expected.requireUnit === true) return outcome('incorrect', 'MISSING_UNIT');
    // Decision: with the unit optional, a bare number is read in the key's unit. For a percent
    // key a bare "0.25" may instead be the same ratio written as a decimal, so a person decides.
    const result = judge(
      student.value,
      key.value,
      tolerance,
      student.form,
      requireSimplestForm,
      false,
    );
    return keyUnit.id === 'percent' &&
      percentReadingMatches(result, student.value, key.value, tolerance)
      ? outcome('unresolved', 'AMBIGUOUS_PERCENT')
      : result;
  }
  if (student.dimension !== keyUnit.dimension) return outcome('incorrect', 'WRONG_UNIT_DIMENSION');
  if (student.unit === keyUnit.id) {
    return judge(student.value, key.value, tolerance, student.form, requireSimplestForm, false);
  }
  if (expected.acceptEquivalentUnits === false) return outcome('incorrect', 'UNIT_NOT_ACCEPTED');
  const converted = convertValue(student.value, student.unit, keyUnit.id);
  if (!converted.ok) return outcome('incorrect', 'WRONG_UNIT_DIMENSION');
  // Tolerance and rounding apply in the key's unit.
  return judge(converted.value, key.value, tolerance, student.form, requireSimplestForm, true);
}

// =============================================================================================
// Division with remainder
// =============================================================================================

export interface DivisionExpected {
  readonly quotient: number;
  readonly remainder: number;
  /** When given, equivalent values ("7 2/5", "7.4" for 37 ÷ 5) are accepted. */
  readonly divisor?: number;
}

const REMAINDER_FORM = /^([^\p{L}]+?)\s*(?:remainder|rem|r)\.?\s*(?:of\s+)?([^\p{L}]+)$/iu;

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validDivisionKey(expected: DivisionExpected): boolean {
  if (!isNonNegativeInteger(expected.quotient) || !isNonNegativeInteger(expected.remainder)) {
    return false;
  }
  if (expected.divisor === undefined) return true;
  return (
    isNonNegativeInteger(expected.divisor) &&
    expected.divisor > 0 &&
    expected.remainder < expected.divisor
  );
}

function wholeNumber(text: string): Rational | 'not_whole' | CheckResult {
  const parsed = parseMathAnswer(text);
  if (!parsed.ok) return outcome('unresolved', parsed.error.code);
  const value = parsed.value;
  return isIntegerRational(value) && value.num >= 0n ? value : 'not_whole';
}

/** Checks "7 R 2", "7 r2", "7 remainder 2" (and equivalent values when the divisor is known). */
export function checkDivisionWithRemainder(
  studentAnswer: string,
  expected: DivisionExpected,
): CheckResult {
  if (isBlankAnswer(studentAnswer)) return outcome('unanswered', 'BLANK');
  if (!validDivisionKey(expected)) return outcome('unresolved', 'INVALID_ANSWER_KEY');
  if (studentAnswer.length > MAX_ANSWER_LENGTH) return outcome('unresolved', 'INPUT_TOO_LONG');
  const text = stripInvisible(normalizeMathText(studentAnswer)).trim();
  const quotient = rational(expected.quotient);
  const remainder = rational(expected.remainder);

  const match = REMAINDER_FORM.exec(text);
  if (match !== null) {
    const q = wholeNumber(match[1] ?? '');
    const r = wholeNumber(match[2] ?? '');
    if (typeof q === 'object' && 'verdict' in q) return q;
    if (typeof r === 'object' && 'verdict' in r) return r;
    if (q === 'not_whole' || r === 'not_whole') return outcome('unresolved', 'INVALID_SYNTAX');
    if (expected.divisor !== undefined && compareRational(r, rational(expected.divisor)) >= 0) {
      return outcome('incorrect', 'REMAINDER_NOT_LESS_THAN_DIVISOR');
    }
    return equalsRational(q, quotient) && equalsRational(r, remainder)
      ? outcome('correct', 'EXACT_MATCH')
      : outcome('incorrect', 'VALUE_MISMATCH');
  }

  const parsed = parseMathAnswer(text);
  if (!parsed.ok) return outcome('unresolved', parsed.error.code);
  const value = parsed.value;
  if (isIntegerRational(value)) {
    if (!equalsRational(value, quotient)) return outcome('incorrect', 'VALUE_MISMATCH');
    return expected.remainder === 0
      ? outcome('correct', 'EXACT_MATCH')
      : outcome('incorrect', 'MISSING_REMAINDER');
  }
  // Alternative valid method (spec P5): a mixed number or decimal equal to q + r/d.
  if (expected.divisor === undefined) return outcome('unresolved', 'NEEDS_DIVISOR');
  const exact = addRational(quotient, rational(expected.remainder, expected.divisor));
  return equalsRational(value, exact)
    ? outcome('correct', 'EQUIVALENT_VALUE')
    : outcome('incorrect', 'VALUE_MISMATCH');
}

// =============================================================================================
// Multiple choice
// =============================================================================================

export interface MultipleChoiceOptions {
  /** Letters printed on the worksheet; a letter outside this set is unresolved, not wrong. */
  readonly validLetters?: ReadonlySet<string> | readonly string[];
}

function trimEdges(text: string, leading: string, trailing: string): string {
  const chars = Array.from(text.trim());
  let start = 0;
  let end = chars.length;
  while (start < end && (leading.includes(chars[start]!) || /\s/.test(chars[start]!))) start++;
  while (end > start && (trailing.includes(chars[end - 1]!) || /\s/.test(chars[end - 1]!))) end--;
  return chars.slice(start, end).join('');
}

/** "(b)", "B.", " b ", "b)", "[B]", "Ⓑ" -> "B"; anything that is not a single letter -> null. */
export function normalizeChoice(text: string): string | null {
  if (text.length > MAX_ANSWER_LENGTH) return null;
  const core = trimEdges(stripInvisible(text.normalize('NFKC')), '([{', ')]}.:');
  return /^[a-z]$/i.test(core) ? core.toUpperCase() : null;
}

function letterSet(letters: Iterable<string>): Set<string> | null {
  const set = new Set<string>();
  for (const letter of letters) {
    const normalized = normalizeChoice(letter);
    if (normalized === null) return null;
    set.add(normalized);
  }
  return set;
}

/**
 * Compares the chosen letter(s) with the key. Select-all answers may be separated by commas,
 * semicolons, "&", "/" or "and"; the chosen set must equal the key set exactly.
 */
export function checkMultipleChoice(
  studentAnswer: string,
  expectedLetters: ReadonlySet<string> | readonly string[],
  options: MultipleChoiceOptions = {},
): CheckResult {
  if (isBlankAnswer(studentAnswer)) return outcome('unanswered', 'BLANK');
  const key = letterSet(expectedLetters);
  const valid = options.validLetters === undefined ? null : letterSet(options.validLetters);
  if (key === null || key.size === 0 || (options.validLetters !== undefined && valid === null)) {
    return outcome('unresolved', 'INVALID_ANSWER_KEY');
  }
  if (valid !== null && [...key].some((letter) => !valid.has(letter))) {
    return outcome('unresolved', 'INVALID_ANSWER_KEY');
  }
  if (studentAnswer.length > MAX_ANSWER_LENGTH) return outcome('unresolved', 'INPUT_TOO_LONG');
  const parts = stripInvisible(studentAnswer.normalize('NFKC')).split(/,|;|&|\/|\band\b/i);
  const chosen = letterSet(parts);
  if (chosen === null || chosen.size === 0) return outcome('unresolved', 'UNRECOGNIZED_CHOICE');
  if (valid !== null && [...chosen].some((letter) => !valid.has(letter))) {
    return outcome('unresolved', 'UNRECOGNIZED_CHOICE');
  }
  const same = chosen.size === key.size && [...chosen].every((letter) => key.has(letter));
  return same ? outcome('correct', 'EXACT_MATCH') : outcome('incorrect', 'CHOICE_MISMATCH');
}

// =============================================================================================
// Spelling and exact short text
// =============================================================================================

export interface SpellingExpected {
  readonly target: string;
  readonly acceptedVariants?: readonly string[];
  /** Default false. */
  readonly caseSensitive?: boolean;
}

function stripTrailing(text: string, punctuation: string): string {
  const chars = Array.from(text);
  let end = chars.length;
  while (end > 0 && (punctuation.includes(chars[end - 1]!) || /\s/.test(chars[end - 1]!))) end--;
  return chars.slice(0, end).join('');
}

function normalizeSpelling(text: string, caseSensitive: boolean): string {
  const folded = collapseWhitespace(foldQuotes(stripInvisible(text.normalize('NFC'))));
  const stripped = stripTrailing(folded, '.!?');
  return caseSensitive ? stripped : stripped.toLowerCase();
}

/** Latin, Latin-1 and Latin Extended-A/B cover English spelling targets and common accents. */
const LATIN_LIMIT = 0x024f;

function unexpectedCharacters(student: string, allowed: readonly string[]): boolean {
  const known = new Set(allowed.flatMap((text) => Array.from(text)));
  return Array.from(student).some((ch) => ch.codePointAt(0)! > LATIN_LIMIT && !known.has(ch));
}

/**
 * Spelling is exact: the target or an explicitly accepted variant, after NFC, trimming, quote
 * folding and (by default) case folding. No fuzzy matching: a misspelling is incorrect.
 * Decision: trailing sentence punctuation (.!?) is ignored, and characters from other scripts
 * that appear in neither the target nor a variant (e.g. a Cyrillic U+0430 homoglyph from
 * transcription) make the item unresolved instead of a false "misspelled".
 */
export function checkSpelling(studentAnswer: string, expected: SpellingExpected): CheckResult {
  if (isBlankAnswer(studentAnswer)) return outcome('unanswered', 'BLANK');
  if (studentAnswer.length > MAX_ANSWER_LENGTH) return outcome('unresolved', 'INPUT_TOO_LONG');
  const caseSensitive = expected.caseSensitive === true;
  const target = normalizeSpelling(expected.target, caseSensitive);
  if (target === '') return outcome('unresolved', 'INVALID_ANSWER_KEY');
  const variants = (expected.acceptedVariants ?? [])
    .map((variant) => normalizeSpelling(variant, caseSensitive))
    .filter((variant) => variant !== '');
  const student = normalizeSpelling(studentAnswer, caseSensitive);
  if (student === target) return outcome('correct', 'EXACT_MATCH');
  if (variants.includes(student)) return outcome('correct', 'ACCEPTED_VARIANT');
  if (unexpectedCharacters(student, [target, ...variants])) {
    return outcome('unresolved', 'UNEXPECTED_CHARACTERS');
  }
  return outcome('incorrect', 'MISSPELLED');
}

export interface ExactTextExpected {
  readonly accepted: readonly string[];
  /** When true a non-matching answer is incorrect; otherwise it needs semantic grading. */
  readonly strict?: boolean;
}

function normalizeShortText(text: string): string {
  const folded = collapseWhitespace(foldQuotes(stripInvisible(text.normalize('NFKC'))));
  return stripTrailing(folded, '.!?,;:').toLowerCase();
}

/**
 * Exact short-text match ignoring case, whitespace runs and trailing punctuation. A non-match is
 * unresolved NEEDS_SEMANTIC_GRADING (a paraphrase may be right) unless the item is strict.
 */
export function checkExactText(studentAnswer: string, expected: ExactTextExpected): CheckResult {
  if (isBlankAnswer(studentAnswer)) return outcome('unanswered', 'BLANK');
  const accepted = expected.accepted.map(normalizeShortText).filter((text) => text !== '');
  if (accepted.length === 0) return outcome('unresolved', 'INVALID_ANSWER_KEY');
  if (studentAnswer.length > MAX_ANSWER_LENGTH) {
    return outcome(
      'unresolved',
      expected.strict === true ? 'INPUT_TOO_LONG' : 'NEEDS_SEMANTIC_GRADING',
    );
  }
  if (accepted.includes(normalizeShortText(studentAnswer)))
    return outcome('correct', 'EXACT_MATCH');
  return expected.strict === true
    ? outcome('incorrect', 'VALUE_MISMATCH')
    : outcome('unresolved', 'NEEDS_SEMANTIC_GRADING');
}
