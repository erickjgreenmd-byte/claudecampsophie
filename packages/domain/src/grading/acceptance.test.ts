import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkNumericAnswer,
  formatRational,
  GRADING_REASONS,
  gradeObjectiveQuestion,
  parseMathAnswer,
  rational,
  type GradeVerdict,
  type GradingReason,
  type ObjectiveQuestion,
} from './index.ts';

interface Case {
  readonly name: string;
  readonly question: ObjectiveQuestion;
  readonly verdict: GradeVerdict;
  readonly reason: GradingReason;
}

const num = (studentAnswer: string, value: string, extra: object = {}): ObjectiveQuestion => ({
  kind: 'numeric',
  studentAnswer,
  expected: { value, ...extra },
});
const qty = (studentAnswer: string, value: string, unit: string, extra: object = {}) =>
  ({ kind: 'quantity', studentAnswer, expected: { value, unit, ...extra } }) as ObjectiveQuestion;
const div = (
  studentAnswer: string,
  expected: { quotient: number; remainder: number; divisor?: number },
) => ({ kind: 'division_remainder', studentAnswer, expected }) as ObjectiveQuestion;
const mc = (
  studentAnswer: string,
  letters: string[],
  validLetters?: string[],
): ObjectiveQuestion => ({
  kind: 'multiple_choice',
  studentAnswer,
  expected: validLetters === undefined ? { letters } : { letters, validLetters },
});
const spell = (studentAnswer: string, target: string, extra: object = {}) =>
  ({ kind: 'spelling', studentAnswer, expected: { target, ...extra } }) as ObjectiveQuestion;
const text = (studentAnswer: string, accepted: string[], strict?: boolean): ObjectiveQuestion => ({
  kind: 'exact_text',
  studentAnswer,
  expected: strict === undefined ? { accepted } : { accepted, strict },
});

const round2 = { tolerance: { kind: 'round_to_places', places: 2 } };

// Each row names the spec rule it proves. Synthetic worksheet content only.
const CASES: Case[] = [
  // --- AC_GRADING_02: equivalent fractions/decimals, rounding, units -------------------------
  {
    name: 'decimal equals fraction key',
    question: num('2.5', '5/2'),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'mixed number equals improper key',
    question: num('2 1/2', '5/2'),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'vulgar mixed number',
    question: num('2½', '5/2'),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  { name: '0.5 == 1/2', question: num('0.5', '1/2'), verdict: 'correct', reason: 'EXACT_MATCH' },
  {
    name: 'equivalent fraction 2/4 == 1/2',
    question: num('2/4', '1/2'),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'simplest form required: 2/4',
    question: num('2/4', '1/2', { requireSimplestForm: true }),
    verdict: 'incorrect',
    reason: 'NOT_SIMPLIFIED',
  },
  {
    name: 'simplest form satisfied',
    question: num('1/2', '1/2', { requireSimplestForm: true }),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'improper fraction in lowest terms is simplest',
    question: num('5/2', '5/2', { requireSimplestForm: true }),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'unreduced mixed number',
    question: num('2 2/4', '5/2', { requireSimplestForm: true }),
    verdict: 'incorrect',
    reason: 'NOT_SIMPLIFIED',
  },
  {
    name: 'unevaluated expression is not simplest',
    question: num('1+1/2', '3/2', { requireSimplestForm: true }),
    verdict: 'incorrect',
    reason: 'NOT_SIMPLIFIED',
  },
  {
    name: 'wrong fraction',
    question: num('3/4', '1/2'),
    verdict: 'incorrect',
    reason: 'VALUE_MISMATCH',
  },
  {
    name: 'thousands separator',
    question: num('1,000', '1000'),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'fullwidth digits',
    question: num('１２', '12'),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'unicode minus',
    question: num('\u22124', '-4'),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'rounded to hundredths',
    question: num('3.14', '3.14159', round2),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'rounded with trailing zero',
    question: num('2.50', '2.4999', round2),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'rounded to 4 places',
    question: num('3.1416', '3.14159', { tolerance: { kind: 'round_to_places', places: 4 } }),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'rounds half up',
    question: num('2.35', '2.345', round2),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'wrong rounding direction',
    question: num('3.15', '3.14159', round2),
    verdict: 'incorrect',
    reason: 'VALUE_MISMATCH',
  },
  {
    name: 'rounding instruction not followed',
    question: num('3.14159', '3.14159', round2),
    verdict: 'incorrect',
    reason: 'NOT_ROUNDED',
  },
  {
    name: 'round to nearest ten',
    question: num('350', '347', { tolerance: { kind: 'round_to_places', places: -1 } }),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'absolute tolerance inside',
    question: num('3.1', '3.14159', { tolerance: { kind: 'absolute', value: '0.05' } }),
    verdict: 'correct',
    reason: 'WITHIN_TOLERANCE',
  },
  {
    name: 'absolute tolerance boundary is inclusive',
    question: num('3.1', '3.15', { tolerance: { kind: 'absolute', value: '0.05' } }),
    verdict: 'correct',
    reason: 'WITHIN_TOLERANCE',
  },
  {
    name: 'absolute tolerance outside',
    question: num('3.2', '3.14159', { tolerance: { kind: 'absolute', value: '0.05' } }),
    verdict: 'incorrect',
    reason: 'VALUE_MISMATCH',
  },
  {
    name: 'percent equals decimal key',
    question: num('50%', '0.5'),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'metres key, centimetres answer',
    question: qty('300 cm', '3', 'm'),
    verdict: 'correct',
    reason: 'EQUIVALENT_UNIT',
  },
  { name: 'same unit', question: qty('3 m', '3', 'm'), verdict: 'correct', reason: 'EXACT_MATCH' },
  {
    name: 'unit word alias',
    question: qty('3 meters', '3', 'm'),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'missing required unit',
    question: qty('3', '3', 'm', { requireUnit: true }),
    verdict: 'incorrect',
    reason: 'MISSING_UNIT',
  },
  {
    name: 'unit optional: bare number read in key unit',
    question: qty('3', '3', 'm'),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'wrong dimension',
    question: qty('3 kg', '3', 'm'),
    verdict: 'incorrect',
    reason: 'WRONG_UNIT_DIMENSION',
  },
  {
    name: 'equivalent unit not accepted when configured',
    question: qty('300 cm', '3', 'm', { acceptEquivalentUnits: false }),
    verdict: 'incorrect',
    reason: 'UNIT_NOT_ACCEPTED',
  },
  {
    name: 'dollar prefix',
    question: qty('$1.50', '1.5', '$'),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'cents for a dollar key',
    question: qty('150¢', '1.50', '$'),
    verdict: 'correct',
    reason: 'EQUIVALENT_UNIT',
  },
  {
    name: 'hours for a minutes key',
    question: qty('1.5 hours', '90', 'min'),
    verdict: 'correct',
    reason: 'EQUIVALENT_UNIT',
  },
  {
    name: 'compound feet and inches',
    question: qty('5 ft 3 in', '63', 'in'),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'mixed-number feet for inches key',
    question: qty('2 1/2 ft', '30', 'in'),
    verdict: 'correct',
    reason: 'EQUIVALENT_UNIT',
  },
  {
    name: 'exact inch definition',
    question: qty('2.54 cm', '1', 'in'),
    verdict: 'correct',
    reason: 'EQUIVALENT_UNIT',
  },
  {
    name: 'pounds for ounces key',
    question: qty('1 lb', '16', 'oz'),
    verdict: 'correct',
    reason: 'EQUIVALENT_UNIT',
  },
  {
    name: 'cups for a quart key',
    question: qty('4 cups', '1', 'qt'),
    verdict: 'correct',
    reason: 'EQUIVALENT_UNIT',
  },
  {
    name: 'area unit with superscript',
    question: qty('12 cm²', '12', 'cm^2'),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'wrong length value',
    question: qty('2 m', '3', 'm'),
    verdict: 'incorrect',
    reason: 'VALUE_MISMATCH',
  },
  {
    name: 'unsimplified quantity',
    question: qty('6/2 m', '3', 'm', { requireSimplestForm: true }),
    verdict: 'incorrect',
    reason: 'NOT_SIMPLIFIED',
  },
  {
    name: 'quantity with rounding in key unit',
    question: qty('3.14 m', '314.159', 'cm', round2),
    verdict: 'incorrect',
    reason: 'VALUE_MISMATCH',
  },
  {
    name: 'percent key answered with percent sign',
    question: qty('25%', '25', '%'),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'percent key answered as a bare decimal ratio is not judged',
    question: qty('0.25', '25', '%'),
    verdict: 'unresolved',
    reason: 'AMBIGUOUS_PERCENT',
  },
  {
    name: 'percent key answered with a wrong bare number',
    question: qty('0.3', '25', '%'),
    verdict: 'incorrect',
    reason: 'VALUE_MISMATCH',
  },

  // --- AC_GRADING_01: unanswered and unresolved are distinct from incorrect ---------------------
  { name: 'blank numeric', question: num('', '4'), verdict: 'unanswered', reason: 'BLANK' },
  {
    name: 'whitespace numeric',
    question: num('  \t ', '4'),
    verdict: 'unanswered',
    reason: 'BLANK',
  },
  {
    name: 'zero-width-only answer is blank',
    question: num('\u200b', '4'),
    verdict: 'unanswered',
    reason: 'BLANK',
  },
  {
    name: 'decimal comma is never guessed',
    question: num('1,5', '3/2'),
    verdict: 'unresolved',
    reason: 'AMBIGUOUS_FORMAT',
  },
  {
    name: 'two-digit group is never guessed',
    question: num('1,00', '100'),
    verdict: 'unresolved',
    reason: 'AMBIGUOUS_FORMAT',
  },
  {
    name: 'hyphenated mixed number is never guessed',
    question: num('2-1/2', '5/2'),
    verdict: 'unresolved',
    reason: 'AMBIGUOUS_FORMAT',
  },
  {
    name: 'unary minus on power is never guessed',
    question: num('-2^2', '-4'),
    verdict: 'unresolved',
    reason: 'AMBIGUOUS_FORMAT',
  },
  {
    name: 'division by zero is unresolved, not wrong',
    question: num('5/0', '5'),
    verdict: 'unresolved',
    reason: 'DIVISION_BY_ZERO',
  },
  {
    name: 'variables are unsupported',
    question: num('x = 4', '4'),
    verdict: 'unresolved',
    reason: 'UNSUPPORTED_EXPRESSION',
  },
  {
    name: 'number words are unsupported',
    question: num('seven', '7'),
    verdict: 'unresolved',
    reason: 'UNSUPPORTED_EXPRESSION',
  },
  {
    name: 'percent against a bare-number key',
    question: num('50%', '50'),
    verdict: 'unresolved',
    reason: 'AMBIGUOUS_PERCENT',
  },
  {
    name: 'unexpected unit on a unitless key',
    question: num('5 cm', '5'),
    verdict: 'unresolved',
    reason: 'UNEXPECTED_UNIT',
  },
  {
    name: 'unknown student unit',
    question: qty('5 blorps', '5', 'm'),
    verdict: 'unresolved',
    reason: 'UNKNOWN_UNIT',
  },
  {
    name: 'invalid answer key value',
    question: num('4', 'four'),
    verdict: 'unresolved',
    reason: 'INVALID_ANSWER_KEY',
  },
  {
    name: 'invalid answer key unit',
    question: qty('4 m', '4', 'furlongs'),
    verdict: 'unresolved',
    reason: 'INVALID_ANSWER_KEY',
  },
  {
    name: 'invalid tolerance places',
    question: num('4', '4', { tolerance: { kind: 'round_to_places', places: 1.5 } }),
    verdict: 'unresolved',
    reason: 'INVALID_ANSWER_KEY',
  },
  {
    name: 'negative absolute tolerance',
    question: num('4', '4', { tolerance: { kind: 'absolute', value: '-1' } }),
    verdict: 'unresolved',
    reason: 'INVALID_ANSWER_KEY',
  },

  // --- AC_CAPTURE_03: exponent placement from transcription ----------------------------------
  {
    name: 'superscript exponent',
    question: num('2³', '8'),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  { name: 'three squared', question: num('3²', '9'), verdict: 'correct', reason: 'EXACT_MATCH' },
  {
    name: 'juxtaposed digits are not an exponent',
    question: num('32', '9'),
    verdict: 'incorrect',
    reason: 'VALUE_MISMATCH',
  },
  {
    name: 'negative superscript exponent',
    question: num('10⁻²', '0.01'),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'stacked fraction transcription',
    question: num('³\u2044₄', '0.75'),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },

  // --- Long division with remainder ---------------------------------------------------------
  {
    name: 'remainder with R',
    question: div('7 R 2', { quotient: 7, remainder: 2 }),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'remainder lowercase r, no space',
    question: div('7 r2', { quotient: 7, remainder: 2 }),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'remainder word',
    question: div('7 remainder 2', { quotient: 7, remainder: 2 }),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'remainder compact',
    question: div('7R2', { quotient: 7, remainder: 2 }),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'remainder abbreviation',
    question: div('7 rem. 2', { quotient: 7, remainder: 2 }),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'wrong remainder',
    question: div('7 R 3', { quotient: 7, remainder: 2 }),
    verdict: 'incorrect',
    reason: 'VALUE_MISMATCH',
  },
  {
    name: 'wrong quotient',
    question: div('8 R 2', { quotient: 7, remainder: 2 }),
    verdict: 'incorrect',
    reason: 'VALUE_MISMATCH',
  },
  {
    name: 'remainder omitted',
    question: div('7', { quotient: 7, remainder: 2 }),
    verdict: 'incorrect',
    reason: 'MISSING_REMAINDER',
  },
  {
    name: 'exact division without remainder',
    question: div('7', { quotient: 7, remainder: 0 }),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'alternative method: mixed number',
    question: div('7 2/5', { quotient: 7, remainder: 2, divisor: 5 }),
    verdict: 'correct',
    reason: 'EQUIVALENT_VALUE',
  },
  {
    name: 'alternative method: decimal',
    question: div('7.4', { quotient: 7, remainder: 2, divisor: 5 }),
    verdict: 'correct',
    reason: 'EQUIVALENT_VALUE',
  },
  {
    name: 'alternative method needs the divisor',
    question: div('7.4', { quotient: 7, remainder: 2 }),
    verdict: 'unresolved',
    reason: 'NEEDS_DIVISOR',
  },
  {
    name: 'remainder not reduced',
    question: div('6 R 7', { quotient: 7, remainder: 2, divisor: 5 }),
    verdict: 'incorrect',
    reason: 'REMAINDER_NOT_LESS_THAN_DIVISOR',
  },
  {
    name: 'words in a remainder answer',
    question: div('seven R two', { quotient: 7, remainder: 2 }),
    verdict: 'unresolved',
    reason: 'UNSUPPORTED_EXPRESSION',
  },
  {
    name: 'blank remainder answer',
    question: div(' ', { quotient: 7, remainder: 2 }),
    verdict: 'unanswered',
    reason: 'BLANK',
  },

  // --- Multiple choice ----------------------------------------------------------------------
  {
    name: 'parenthesized letter',
    question: mc('(b)', ['B']),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'letter with period',
    question: mc('B.', ['B']),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'padded lowercase letter',
    question: mc(' b ', ['B']),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'letter with closing paren',
    question: mc('b)', ['B']),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'wrong letter',
    question: mc('C', ['B']),
    verdict: 'incorrect',
    reason: 'CHOICE_MISMATCH',
  },
  {
    name: 'select-all exact set',
    question: mc('A, C', ['A', 'C']),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'select-all with "and"',
    question: mc('c and a', ['A', 'C']),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'select-all partial',
    question: mc('A', ['A', 'C']),
    verdict: 'incorrect',
    reason: 'CHOICE_MISMATCH',
  },
  {
    name: 'hedged single answer',
    question: mc('A, B', ['B']),
    verdict: 'incorrect',
    reason: 'CHOICE_MISMATCH',
  },
  {
    name: 'prose is not a letter',
    question: mc('the second one', ['B']),
    verdict: 'unresolved',
    reason: 'UNRECOGNIZED_CHOICE',
  },
  {
    name: 'letter outside the printed options',
    question: mc('E', ['B'], ['A', 'B', 'C', 'D']),
    verdict: 'unresolved',
    reason: 'UNRECOGNIZED_CHOICE',
  },
  { name: 'blank choice', question: mc('', ['B']), verdict: 'unanswered', reason: 'BLANK' },

  // --- Spelling (no fuzzy matching) -----------------------------------------------------------
  {
    name: 'spelling exact',
    question: spell('because', 'because'),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'spelling case-insensitive by default',
    question: spell('Because', 'because'),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'spelling case-sensitive when configured',
    question: spell('monday', 'Monday', { caseSensitive: true }),
    verdict: 'incorrect',
    reason: 'MISSPELLED',
  },
  {
    name: 'transposed letters are a misspelling',
    question: spell('becuase', 'because'),
    verdict: 'incorrect',
    reason: 'MISSPELLED',
  },
  {
    name: 'one-letter slip is still a misspelling',
    question: spell('becaus', 'because'),
    verdict: 'incorrect',
    reason: 'MISSPELLED',
  },
  {
    name: 'explicit variant accepted',
    question: spell('colour', 'color', { acceptedVariants: ['colour'] }),
    verdict: 'correct',
    reason: 'ACCEPTED_VARIANT',
  },
  {
    name: 'variant not configured',
    question: spell('colour', 'color'),
    verdict: 'incorrect',
    reason: 'MISSPELLED',
  },
  {
    name: 'curly apostrophe folded',
    question: spell('don\u2019t', "don't"),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'trim and trailing period',
    question: spell('  because. ', 'because'),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'NFC composed vs decomposed accent',
    question: spell('cafe\u0301', 'caf\u00e9'),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'homoglyph from another script is not judged',
    question: spell('bec\u0430use', 'because'),
    verdict: 'unresolved',
    reason: 'UNEXPECTED_CHARACTERS',
  },
  {
    name: 'blank spelling',
    question: spell('', 'because'),
    verdict: 'unanswered',
    reason: 'BLANK',
  },

  // --- Exact short text -----------------------------------------------------------------------
  {
    name: 'exact text',
    question: text('Paris', ['Paris']),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'exact text normalized',
    question: text('  paris. ', ['Paris']),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'exact text whitespace collapsed',
    question: text('New   York', ['new york']),
    verdict: 'correct',
    reason: 'EXACT_MATCH',
  },
  {
    name: 'paraphrase needs semantic grading',
    question: text('The capital is Paris', ['Paris']),
    verdict: 'unresolved',
    reason: 'NEEDS_SEMANTIC_GRADING',
  },
  {
    name: 'strict exact text mismatch',
    question: text('London', ['Paris'], true),
    verdict: 'incorrect',
    reason: 'VALUE_MISMATCH',
  },
  {
    name: 'blank exact text',
    question: text('', ['Paris']),
    verdict: 'unanswered',
    reason: 'BLANK',
  },

  // --- AC_GRADING_03: open responses and writing ---------------------------------------------
  {
    name: 'open response goes to semantic grading',
    question: { kind: 'open_response', studentAnswer: 'Plants need light to make food.' },
    verdict: 'unresolved',
    reason: 'NEEDS_SEMANTIC_GRADING',
  },
  {
    name: 'blank open response',
    question: { kind: 'open_response', studentAnswer: '' },
    verdict: 'unanswered',
    reason: 'BLANK',
  },
  {
    name: 'writing gets rubric feedback only',
    question: { kind: 'writing', studentAnswer: 'My summer with Riley and Sam at the lake.' },
    verdict: 'rubric',
    reason: 'RUBRIC_FEEDBACK_ONLY',
  },
  {
    name: 'blank writing',
    question: { kind: 'writing', studentAnswer: '   ' },
    verdict: 'unanswered',
    reason: 'BLANK',
  },

  // --- AC_CAPTURE_04: capture problems produce rescan/review states, never grades -------------
  {
    name: 'blur blocks a would-be correct grade',
    question: { ...num('4', '4'), captureIssues: ['blur'] },
    verdict: 'unresolved',
    reason: 'NEEDS_RESCAN',
  },
  {
    name: 'glare blocks a would-be incorrect grade',
    question: { ...num('5', '4'), captureIssues: ['glare'] },
    verdict: 'unresolved',
    reason: 'NEEDS_RESCAN',
  },
  {
    name: 'cut-off question',
    question: { ...mc('B', ['B']), captureIssues: ['cut_off'] },
    verdict: 'unresolved',
    reason: 'NEEDS_RESCAN',
  },
  {
    name: 'uncorrected rotation',
    question: { ...spell('because', 'because'), captureIssues: ['rotated'] },
    verdict: 'unresolved',
    reason: 'NEEDS_RESCAN',
  },
  {
    name: 'blank-looking but unreadable is not unanswered',
    question: { ...num('', '4'), captureIssues: ['unreadable'] },
    verdict: 'unresolved',
    reason: 'NEEDS_RESCAN',
  },
  {
    name: 'missing passage',
    question: { ...text('Paris', ['Paris']), captureIssues: ['missing_passage'] },
    verdict: 'unresolved',
    reason: 'NEEDS_SOURCE_PASSAGE',
  },
  {
    name: 'writing on a blurred page gets no rubric',
    question: { kind: 'writing', studentAnswer: 'An essay.', captureIssues: ['blur'] },
    verdict: 'unresolved',
    reason: 'NEEDS_RESCAN',
  },
  {
    name: 'answer may be a teacher mark or printed key',
    question: { ...num('4', '4'), captureIssues: ['answer_source_uncertain'] },
    verdict: 'unresolved',
    reason: 'ANSWER_SOURCE_UNCERTAIN',
  },
  {
    name: 'answer may belong to another question',
    question: { ...num('4', '4'), captureIssues: ['answer_mapping_uncertain'] },
    verdict: 'unresolved',
    reason: 'ANSWER_MAPPING_UNCERTAIN',
  },
];

describe('P5 deterministic checks: acceptance table (AC_GRADING_01/02/03, AC_CAPTURE_03/04)', () => {
  it('covers at least 60 cases', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(60);
  });

  it.each(CASES)('$name', ({ question, verdict, reason }) => {
    expect(gradeObjectiveQuestion(question)).toEqual({ verdict, reason });
  });

  it('every reason used is in the exported stable reason list', () => {
    for (const c of CASES) expect(GRADING_REASONS).toContain(c.reason);
  });
});

describe('P5 deterministic checks: properties', () => {
  const small = fc.bigInt({ min: -10_000n, max: 10_000n });
  const positive = fc.bigInt({ min: 1n, max: 10_000n });
  const factor = fc.bigInt({ min: 2n, max: 50n });

  it('equivalent fractions k*a/k*b are correct unless simplest form is required', () => {
    fc.assert(
      fc.property(small, positive, factor, (a, b, k) => {
        const key = formatRational(rational(a, b));
        const student = `${(k * a).toString()}/${(k * b).toString()}`;
        expect(checkNumericAnswer({ studentAnswer: student, expected: { value: key } })).toEqual({
          verdict: 'correct',
          reason: 'EXACT_MATCH',
        });
        const strict = checkNumericAnswer({
          studentAnswer: student,
          expected: { value: key, requireSimplestForm: true },
        });
        expect(strict).toEqual({ verdict: 'incorrect', reason: 'NOT_SIMPLIFIED' });
      }),
    );
  });

  it('uncertainty never becomes "incorrect": unparseable input is always unresolved or unanswered', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 240 }), (studentAnswer) => {
        const result = checkNumericAnswer({ studentAnswer, expected: { value: '7' } });
        if (!parseMathAnswer(studentAnswer).ok) expect(result.verdict).not.toBe('incorrect');
        if (result.verdict === 'incorrect') expect(result.reason).toBe('VALUE_MISMATCH');
      }),
      { numRuns: 500 },
    );
  });

  it('a correct value is never marked incorrect by surrounding whitespace or Unicode width', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.constantFrom(' ', '  ', '\t', '\u00a0', ''),
        (n, pad) => {
          const fullwidth = String(Math.abs(n)).replace(/[0-9]/g, (d) =>
            String.fromCharCode(0xff10 + Number(d)),
          );
          const student = `${pad}${n < 0 ? '-' : ''}${fullwidth}${pad}`;
          expect(
            checkNumericAnswer({ studentAnswer: student, expected: { value: String(n) } }).verdict,
          ).toBe('correct');
        },
      ),
    );
  });
});
