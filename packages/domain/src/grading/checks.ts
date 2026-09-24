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
import {
  convertValue,
  lookupUnit,
  parseQuantityDetailed,
  type QuantityOptions,
  type UnitDefinition,
} from './units.ts';
import { isAbsent, isIterable, stringList } from './untrusted.ts';
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

/**
 * Answer keys may come from extraction models, so a malformed key is data, not a crash. A null
 * tolerance (strict structured outputs' "absent") is exact; a wrongly typed one is invalid.
 */
function prepareTolerance(tolerance: unknown): PreparedTolerance | null {
  if (isAbsent(tolerance)) return { kind: 'exact' };
  if (typeof tolerance !== 'object') return null;
  const candidate = tolerance as { readonly kind?: unknown; value?: unknown; places?: unknown };
  switch (candidate.kind) {
    case 'exact':
      return { kind: 'exact' };
    case 'absolute': {
      if (typeof candidate.value !== 'string') return null;
      const parsed = parseMathAnswer(candidate.value);
      if (!parsed.ok || parsed.value.num < 0n) return null;
      return { kind: 'absolute', value: parsed.value };
    }
    case 'round_to_places': {
      const places = candidate.places;
      return typeof places === 'number' &&
        Number.isSafeInteger(places) &&
        Math.abs(places) <= MAX_EXPONENT
        ? { kind: 'round_to_places', places }
        : null;
    }
    default:
      return null;
  }
}

interface PreparedKey {
  readonly value: Rational;
  /** null: a plain-number key. */
  readonly unit: UnitDefinition | null;
  readonly tolerance: PreparedTolerance;
}

const PERCENT_UNIT = lookupUnit('percent');

/**
 * Validates and normalizes an answer key; null when it is malformed. Decision: a key whose value is
 * written with a percent sign ("25%", "1/2%") is a key in percent, exactly like
 * { value: "25", unit: "%" }, so a bare "25" or "0.25" and the tolerance/rounding scale are judged
 * the same way whichever way the extractor encoded it. A percent value with another unit is invalid.
 */
function prepareKey(expected: NumericExpected): PreparedKey | null {
  if (typeof expected !== 'object' || expected === null) return null;
  if (typeof expected.value !== 'string') return null;
  const parsed = parseMathAnswerDetailed(expected.value);
  const tolerance = prepareTolerance(expected.tolerance);
  if (!parsed.ok || tolerance === null) return null;
  const unitText: unknown = expected.unit;
  let unit: UnitDefinition | null = null;
  if (!isAbsent(unitText)) {
    if (typeof unitText !== 'string') return null;
    unit = lookupUnit(unitText);
    if (unit === null) return null;
  }
  const { value, form } = parsed.value;
  if (form.kind !== 'percent') return { value, unit, tolerance };
  if (PERCENT_UNIT === null || (unit !== null && unit.id !== PERCENT_UNIT.id)) return null;
  return { value: multiplyRational(value, rational(100n)), unit: PERCENT_UNIT, tolerance };
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

/**
 * Decision: an unevaluated expression ("347 × 29", "37 ÷ 5", "3²", "2 + 1/2") is not a final
 * answer. It may simply restate the question, and a deterministic "correct" is final (resolve.ts
 * rule 1), so it is unresolved UNEVALUATED_EXPRESSION for a model or a grown-up with the question
 * in view. With requireSimplestForm it is NOT_SIMPLIFIED as before (VALUE_MISMATCH if the value is
 * wrong). Single numbers (integers, decimals, fractions, mixed numbers, percents) are graded.
 */
function judge(
  student: Rational,
  key: Rational,
  tolerance: PreparedTolerance,
  form: AnswerForm,
  requireSimplestForm: boolean,
  convertedUnit: boolean,
): CheckResult {
  if (form.kind === 'expression' && !requireSimplestForm) {
    return outcome('unresolved', 'UNEVALUATED_EXPRESSION');
  }
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
  const key = prepareKey(expected);
  if (key === null) return outcome('unresolved', 'INVALID_ANSWER_KEY');
  const { tolerance, unit: keyUnit } = key;
  const requireSimplestForm = expected.requireSimplestForm === true;

  if (keyUnit === null) {
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

  // A capacity key tells us that a bare "oz" in the answer is a fluid ounce ("8 oz" for 1 cup).
  const quantityOptions: QuantityOptions =
    keyUnit.dimension === 'volume' ? { ounces: 'fluid' } : {};
  const parsed = parseQuantityDetailed(studentAnswer, quantityOptions);
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
  // Decision: a key in bare "oz" answered with a capacity ("1 cup", "8 fl oz") may be a key that
  // meant fluid ounces; a person decides rather than a false WRONG_UNIT_DIMENSION.
  if (keyUnit.id === 'oz' && student.dimension === 'volume') {
    return outcome('unresolved', 'AMBIGUOUS_UNIT');
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

interface DivisionKey {
  readonly quotient: number;
  readonly remainder: number;
  readonly divisor: number | undefined;
}

/** A null divisor (strict structured outputs' "absent") means the divisor is not known. */
function divisionKey(expected: DivisionExpected): DivisionKey | null {
  if (typeof expected !== 'object' || expected === null) return null;
  const { quotient, remainder } = expected;
  if (!isNonNegativeInteger(quotient) || !isNonNegativeInteger(remainder)) return null;
  const divisor: unknown = expected.divisor;
  if (isAbsent(divisor)) return { quotient, remainder, divisor: undefined };
  return isNonNegativeInteger(divisor) && divisor > 0 && remainder < divisor
    ? { quotient, remainder, divisor }
    : null;
}

/** An unevaluated expression ("37 ÷ 5", "3 + 4") restates the problem; see `judge`. */
function unevaluated(form: AnswerForm): boolean {
  return form.kind === 'expression';
}

function wholeNumber(text: string): Rational | 'not_whole' | CheckResult {
  const parsed = parseMathAnswerDetailed(text);
  if (!parsed.ok) return outcome('unresolved', parsed.error.code);
  if (unevaluated(parsed.value.form)) return outcome('unresolved', 'UNEVALUATED_EXPRESSION');
  const value = parsed.value.value;
  return isIntegerRational(value) && value.num >= 0n ? value : 'not_whole';
}

/** Checks "7 R 2", "7 r2", "7 remainder 2" (and equivalent values when the divisor is known). */
export function checkDivisionWithRemainder(
  studentAnswer: string,
  expected: DivisionExpected,
): CheckResult {
  if (isBlankAnswer(studentAnswer)) return outcome('unanswered', 'BLANK');
  const key = divisionKey(expected);
  if (key === null) return outcome('unresolved', 'INVALID_ANSWER_KEY');
  if (studentAnswer.length > MAX_ANSWER_LENGTH) return outcome('unresolved', 'INPUT_TOO_LONG');
  const text = stripInvisible(normalizeMathText(studentAnswer)).trim();
  const quotient = rational(key.quotient);
  const remainder = rational(key.remainder);

  const match = REMAINDER_FORM.exec(text);
  if (match !== null) {
    const q = wholeNumber(match[1] ?? '');
    const r = wholeNumber(match[2] ?? '');
    if (typeof q === 'object' && 'verdict' in q) return q;
    if (typeof r === 'object' && 'verdict' in r) return r;
    if (q === 'not_whole' || r === 'not_whole') return outcome('unresolved', 'INVALID_SYNTAX');
    if (key.divisor !== undefined && compareRational(r, rational(key.divisor)) >= 0) {
      return outcome('incorrect', 'REMAINDER_NOT_LESS_THAN_DIVISOR');
    }
    return equalsRational(q, quotient) && equalsRational(r, remainder)
      ? outcome('correct', 'EXACT_MATCH')
      : outcome('incorrect', 'VALUE_MISMATCH');
  }

  const parsed = parseMathAnswerDetailed(text);
  if (!parsed.ok) return outcome('unresolved', parsed.error.code);
  // "37 ÷ 5" for 37 ÷ 5, or "35 ÷ 5" for 35 ÷ 5: the problem restated is not an answer, on the
  // quotient path or the alternative-method path.
  if (unevaluated(parsed.value.form)) return outcome('unresolved', 'UNEVALUATED_EXPRESSION');
  const value = parsed.value.value;
  if (isIntegerRational(value)) {
    if (!equalsRational(value, quotient)) return outcome('incorrect', 'VALUE_MISMATCH');
    return key.remainder === 0
      ? outcome('correct', 'EXACT_MATCH')
      : outcome('incorrect', 'MISSING_REMAINDER');
  }
  // Alternative valid method (spec P5): a mixed number or decimal equal to q + r/d.
  if (key.divisor === undefined) return outcome('unresolved', 'NEEDS_DIVISOR');
  const exact = addRational(quotient, rational(key.remainder, key.divisor));
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

/** Null when any entry is not a single letter, or the value is not a list at all (malformed key). */
function letterSet(letters: unknown): Set<string> | null {
  if (!isIterable(letters)) return null;
  const set = new Set<string>();
  for (const letter of letters) {
    if (typeof letter !== 'string') return null;
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
  const validLetters: unknown = options.validLetters;
  const valid = isAbsent(validLetters) ? null : letterSet(validLetters);
  if (key === null || key.size === 0 || (!isAbsent(validLetters) && valid === null)) {
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
  if (typeof expected !== 'object' || expected === null || typeof expected.target !== 'string') {
    return outcome('unresolved', 'INVALID_ANSWER_KEY');
  }
  const acceptedVariants: unknown = expected.acceptedVariants;
  const variantList = isAbsent(acceptedVariants) ? [] : stringList(acceptedVariants);
  if (variantList === null) return outcome('unresolved', 'INVALID_ANSWER_KEY');
  const caseSensitive = expected.caseSensitive === true;
  const target = normalizeSpelling(expected.target, caseSensitive);
  if (target === '') return outcome('unresolved', 'INVALID_ANSWER_KEY');
  const variants = variantList
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
  const acceptedList =
    typeof expected === 'object' && expected !== null ? stringList(expected.accepted) : null;
  if (acceptedList === null) return outcome('unresolved', 'INVALID_ANSWER_KEY');
  const accepted = acceptedList.map(normalizeShortText).filter((text) => text !== '');
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
