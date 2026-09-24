// Arithmetic expressions in child-facing text, read as the value they disclose (spec P6: "No
// original problem's final numeric value ... in hints"; E4 "Answer protection"; AC_GRADING_07/08).
// "The answer is 6 × 7" discloses 42 as surely as "42" does.
//
// Candidates are found by a small tokenizer over the canonical text: two or more numbers (digits,
// number words, LaTeX fractions) joined by + - × ÷ * / ^ (and their look-alikes), "times", "plus",
// "minus", "divided by", "multiplied by", "to the power of", "take away", a standalone "x", the
// Spanish "mas", "menos", "por", "veces", "entre", "dividido entre/por", "multiplicado por", LaTeX
// \times \cdot \div (also glued to digits: "6\times7") and \frac{a}{b} of expressions, with
// optional brackets, a glued sign ("-3"), percent, "squared", "cubed", superscript exponents
// (canonicalize writes "6²" as "6^2"), a product written by juxtaposition with a bracket ("3(14)",
// "(6)(7)"), and vertical arithmetic (a number, then "+ 2" alone on the next line). Each candidate
// is evaluated by the grading module's safe exact-rational parser (`parseMathAnswer`: hand-written
// recursive descent with bounded input, tokens, nesting, exponents and magnitudes; never eval).
// Text stays data: nothing here executes it.
//
// Decisions:
// - On by default (`ScanOptions.evaluateExpressions` unless false; lead decision at integration,
//   so every child-facing caller fails closed). A problem statement ("What is 6 × 7?") contains an
//   expression equal to its own key by definition, so only a check of the problem itself (the
//   bank's prompt self-check) passes false; hints, worked examples and tutoring text never do.
// - Readings are only added: the literal numbers of an expression are still read on their own.
//   Reusing the grading parser can therefore only add readings, never hide a literal one.
// - A hint that restates the problem ("look again at 6 × 7") is blocked when, and only when, its
//   value equals a protected answer. The guard cannot tell a restatement from a disclosure; the
//   caller falls back to a safe template.
// - Standard precedence ("2 + 3 × 4" is 14). The whole chain is read, and so is every bracketed
//   group inside it ("(6 × 7) + 1" discloses 42 and 43; a \frac numerator is a group). Other
//   intermediate values are not read ("6 × 7 + 1" is 43 only). In algebra ("x^2 + 3") the numeric
//   part is read as if standalone.
// - Decorations do not end an operand: currency signs ("$20 − $8"), quotes, "°" (and "°C"),
//   markdown emphasis ("**6** × _7_"), LaTeX sizing/delimiters, and up to two unit words after the
//   number ("6 cm × 7 cm", "30 min + 12 min", "6 sq ft"; UNIT_WORDS). A "*" that wraps a single
//   number ("*6*") is emphasis in rendered markdown and a times sign in plain text: both readings
//   are taken ("2 *3* 4" discloses 24).
// - Fail closed: a candidate the parser cannot bound (input, token, nesting, exponent or magnitude
//   limits; more than MAX_OPERANDS numbers, MAX_READINGS locale readings or MAX_GROUPS brackets;
//   more than MAX_EXPRESSIONS candidates or MAX_PARSES parser calls in one text) is
//   `expression_unbounded`; one with two readings the parser will not guess between ("2^3^2",
//   "-2^2") is `expression_unevaluable`, and so is a chain of two or more operators, one not a "/",
//   that divides by zero ("6 × 7 − 0 ÷ 0" must not hide 42). A lone "5 ÷ 0", or a slash list
//   ("50/50/0", each "a/b" already read as a fraction), has no value and is not a finding. A
//   percent after a division ("15%/30%", "1/2%") is read both ways: each percent bound to its own
//   number, and the parser's own reading ("1/2%" is half a percent).
// - Not operators: ":" (a time, ratio or division), "by" ("a 3 by 4 grid"), "and", "of", "over"
//   (already read as a fraction), and a line-start "-", "*", "+", "·" that is a bullet. A line-start
//   sign is an operator only in vertical arithmetic: the previous line ends with a number, the
//   sign's line holds just one number, and the previous line is not itself a bullet of that sign.
// - A hyphen between numbers is a minus ("8-3"), except in a range: directly after a counting
//   noun ("pages 3-5", "ages 6-7", "score 3-1"; RANGE_NOUNS) or ascending before a unit ("5-10
//   minutes"), and in an ISO date ("2026-09-24"); a range followed or preceded by an operator is
//   still arithmetic. Measured on the repo's prose (see the slice record): ranges were most of the
//   remaining false positives.
// - A number glued to a letter ("2x", "H2O", "1s") is not an operand, except a standalone "x" used
//   as a times sign ("6x7"), a unit ("6cm"; not "s"), and a LaTeX command ("\times7").

import { parseMathAnswer, type ParseErrorCode } from '../grading/parse.ts';
import type { NumericMention, NumericReading } from './numbers.ts';
import { rational, type Rational } from './rational.ts';

/** Most numbers in one expression; a longer chain fails closed. */
export const MAX_OPERANDS = 24;
/** Most combinations of locale readings ("1,500" is 1500 or 1.5) evaluated for one expression. */
export const MAX_READINGS = 16;
/** Most expressions evaluated in one text (per reading pass); more fail closed. */
export const MAX_EXPRESSIONS = 2_000;
/** Most parser calls for one text (a cached result is free); more fail closed. */
export const MAX_PARSES = 1_000;
/** Most bracket groups read on their own in one expression; more fail closed. */
export const MAX_GROUPS = 12;
/** Unit words that may follow one number ("6 sq ft"). */
const MAX_UNITS = 2;
/** Parser results remembered per scan (one packet or one text). */
const CACHE_LIMIT = 4_096;

export type ExpressionFailureTechnique = 'expression_unbounded' | 'expression_unevaluable';

export interface ExpressionFailure {
  readonly start: number;
  readonly end: number;
  readonly technique: ExpressionFailureTechnique;
}

export interface ExpressionReadings {
  /** One mention (reading 'expression') per evaluated value, spanning the expression or group. */
  readonly mentions: readonly NumericMention[];
  readonly failures: readonly ExpressionFailure[];
}

type ParseOutcome =
  | { readonly ok: true; readonly value: Rational }
  | { readonly ok: false; readonly code: ParseErrorCode };

/**
 * Parser results shared by every text of one scan (a packet's fields, its joined text and decoded
 * views repeat the same expressions). Pure memoization: the parser is deterministic.
 */
export interface ExpressionCache {
  readonly results: Map<string, ParseOutcome>;
}

export function createExpressionCache(): ExpressionCache {
  return { results: new Map<string, ParseOutcome>() };
}

/** Mention readings usable as operands. Fractions, mixed numbers and percents are parsed here. */
const OPERAND_READINGS: ReadonlySet<NumericReading> = new Set<NumericReading>([
  'integer',
  'decimal',
  'thousands',
  'alt_locale',
  'latex',
  'scaled',
  'words',
]);

const UNBOUNDED_CODES: ReadonlySet<ParseErrorCode> = new Set<ParseErrorCode>([
  'INPUT_TOO_LONG',
  'TOO_COMPLEX',
  'EXPONENT_OUT_OF_RANGE',
  'RESULT_TOO_LARGE',
]);

type Operator = '+' | '-' | '*' | '/' | '÷' | '^';
type Postfix = '%' | '^ 2' | '^ 3';

interface TokenBase {
  readonly start: number;
  readonly end: number;
  /** Line number in the canonical text (vertical arithmetic and bullets are line-based). */
  readonly line: number;
}

interface AtomToken extends TokenBase {
  readonly kind: 'atom';
  readonly values: readonly Rational[];
  /** A digit literal read only as an integer: a mixed-number part. */
  readonly integer: boolean;
  /** A digit literal with exactly one reading (integer or decimal): "a/b" of two is a fraction. */
  readonly plain: boolean;
  /** Glued to a standalone "x" before / after ("6x7"); valid only if that x is used as times. */
  readonly xBefore: boolean;
  readonly xAfter: boolean;
}

interface OperatorToken extends TokenBase {
  readonly kind: 'op';
  readonly op: Operator;
  /** The character written ("-", "×", ...); synthetic operators use their ASCII form. */
  readonly char: string;
  /** Written as "+" or "-" where a sign may stand: may be a unary sign if glued to a number. */
  readonly signable: boolean;
  /** "-", "*", "+", "·" as the first token of a line: a bullet unless vertical arithmetic. */
  readonly lineStart: boolean;
  /** Never a binary operator (resolved by resolveBullets). */
  readonly bullet: boolean;
  /** The standalone letter "x". */
  readonly letterX: boolean;
}

interface BracketToken extends TokenBase {
  readonly kind: 'open' | 'close';
  readonly char: string;
  /** Inserted by the \frac rewrite (never a juxtaposition product). */
  readonly synthetic?: true;
}

interface PostfixToken extends TokenBase {
  readonly kind: 'postfix';
  readonly postfix: Postfix;
}

interface BreakToken extends TokenBase {
  readonly kind: 'break';
  /** The letters of a word token (range nouns are recognized by it). */
  readonly word?: string;
}

type Token =
  | AtomToken
  | OperatorToken
  | BracketToken
  | PostfixToken
  | BreakToken
  | (TokenBase & { readonly kind: 'unit' | 'frac' });

const SYMBOL_OPERATORS: Readonly<Record<string, Operator>> = {
  '+': '+',
  '➕': '+',
  '-': '-',
  '➖': '-',
  '*': '*',
  '×': '*',
  '·': '*',
  '⋅': '*',
  '∙': '*',
  '∗': '*',
  '⁎': '*',
  '✕': '*',
  '✖': '*',
  '⨉': '*',
  '⨯': '*',
  '/': '/',
  '÷': '÷',
  '➗': '÷',
  '^': '^',
};
const BULLET_SYMBOLS = new Set(['-', '*', '+', '·', '∙']);
const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);
/** Brackets that form a product when glued to a number ("3(14)"); "{" is LaTeX grouping. */
const JUXTAPOSED_OPEN = new Set(['(', '[']);

/**
 * Characters that never end an operand: quotes and primes ('"6" × "7"', '6" × 7"'), markdown
 * underscore/strikethrough emphasis, and (by RegExp below) every currency sign. "°" is handled on
 * its own because a scale letter may follow it ("20°C").
 */
const TRANSPARENT = new Set([
  '"',
  "'",
  '`',
  '‘',
  '’',
  '‚',
  '‛',
  '“',
  '”',
  '„',
  '‟',
  '«',
  '»',
  '‹',
  '›',
  '′',
  '″',
  '‴',
  '_',
  '~',
]);
const CURRENCY_RE = /\p{Sc}/u;

const WORD_OPERATORS: Readonly<Record<string, Operator>> = {
  times: '*',
  plus: '+',
  minus: '-',
  x: '*',
  mas: '+',
  menos: '-',
  por: '*',
  veces: '*',
  entre: '÷',
};
const WORD_POSTFIX: Readonly<Record<string, Postfix>> = {
  percent: '%',
  pct: '%',
  porciento: '%',
  squared: '^ 2',
  cubed: '^ 3',
};
/** Multi-word phrases, tried before single words (so "por ciento" is a percent, not "times"). */
const PHRASES: readonly (readonly [RegExp, Operator | Postfix, 'op' | 'postfix'])[] = [
  [/(?:divided|divide)\s+by(?!\p{L})/uy, '÷', 'op'],
  [/multiplied\s+by(?!\p{L})/uy, '*', 'op'],
  [/to\s+the\s+power\s+of(?!\p{L})/uy, '^', 'op'],
  [/take\s+away(?!\p{L})/uy, '-', 'op'],
  [/dividido\s+(?:entre|por)(?!\p{L})/uy, '÷', 'op'],
  [/multiplicado\s+por(?!\p{L})/uy, '*', 'op'],
  [/elevado\s+a(?:\s+la)?(?!\p{L})/uy, '^', 'op'],
  [/per\s+cent(?!\p{L})/uy, '%', 'postfix'],
  [/por\s+cien(?:to)?(?!\p{L})/uy, '%', 'postfix'],
  [/al\s+cuadrado(?!\p{L})/uy, '^ 2', 'postfix'],
  [/al\s+cubo(?!\p{L})/uy, '^ 3', 'postfix'],
];
/** First words of PHRASES: only these words try the phrase patterns. */
const PHRASE_HEADS: ReadonlySet<string> = new Set([
  'divided',
  'divide',
  'multiplied',
  'to',
  'take',
  'dividido',
  'multiplicado',
  'elevado',
  'per',
  'por',
  'al',
]);

/**
 * Units that may follow a number inside an expression (English and Spanish, accents stripped by
 * canonicalize). A unit only joins the number before it; it is never an operand or an operator.
 */
const UNIT_WORDS: ReadonlySet<string> = new Set([
  // length
  'mm',
  'cm',
  'dm',
  'm',
  'km',
  'in',
  'inch',
  'inches',
  'ft',
  'foot',
  'feet',
  'yd',
  'yard',
  'yards',
  'mi',
  'mile',
  'miles',
  'meter',
  'meters',
  'metre',
  'metres',
  'centimeter',
  'centimeters',
  'centimetre',
  'centimetres',
  'millimeter',
  'millimeters',
  'kilometer',
  'kilometers',
  'metro',
  'metros',
  'centimetro',
  'centimetros',
  'milimetro',
  'milimetros',
  'kilometro',
  'kilometros',
  'pulgada',
  'pulgadas',
  'pie',
  'pies',
  'yarda',
  'yardas',
  'milla',
  'millas',
  // mass
  'mg',
  'g',
  'kg',
  'gram',
  'grams',
  'kilogram',
  'kilograms',
  'lb',
  'lbs',
  'pound',
  'pounds',
  'oz',
  'ounce',
  'ounces',
  'ton',
  'tons',
  'gramo',
  'gramos',
  'kilo',
  'kilos',
  'kilogramo',
  'kilogramos',
  'libra',
  'libras',
  'onza',
  'onzas',
  // volume
  'ml',
  'l',
  'liter',
  'liters',
  'litre',
  'litres',
  'cup',
  'cups',
  'pint',
  'pints',
  'quart',
  'quarts',
  'gallon',
  'gallons',
  'gal',
  'litro',
  'litros',
  'mililitro',
  'mililitros',
  'taza',
  'tazas',
  // time
  's',
  'sec',
  'secs',
  'second',
  'seconds',
  'min',
  'mins',
  'minute',
  'minutes',
  'h',
  'hr',
  'hrs',
  'hour',
  'hours',
  'day',
  'days',
  'week',
  'weeks',
  'month',
  'months',
  'year',
  'years',
  'segundo',
  'segundos',
  'minuto',
  'minutos',
  'hora',
  'horas',
  'dia',
  'dias',
  'semana',
  'semanas',
  'mes',
  'meses',
  'ano',
  'anos',
  // money
  'dollar',
  'dollars',
  'cent',
  'cents',
  'penny',
  'pennies',
  'nickel',
  'nickels',
  'dime',
  'dimes',
  'quarter',
  'quarters',
  'euro',
  'euros',
  'peso',
  'pesos',
  'centavo',
  'centavos',
  'dolar',
  'dolares',
  'usd',
  'eur',
  'mxn',
  // angles, points, area and volume qualifiers
  'deg',
  'degree',
  'degrees',
  'grado',
  'grados',
  'point',
  'points',
  'pts',
  'punto',
  'puntos',
  'unit',
  'units',
  'unidad',
  'unidades',
  'sq',
  'square',
  'cubic',
  'cu',
  'cuadrado',
  'cuadrados',
  'cubico',
  'cubicos',
]);
/** Units that may be glued to the number ("6cm"). Not "s": "1s", "10s" are numerals' plurals. */
const GLUED_UNIT_EXCLUDED = new Set(['s', 'in', 'pie', 'pies', 'ano', 'anos', 'mes']);

/** Counting nouns before "a-b" that make it a range ("pages 3-5"), never a subtraction. */
const RANGE_NOUNS: ReadonlySet<string> = new Set([
  'page',
  'pages',
  'pp',
  'problem',
  'problems',
  'question',
  'questions',
  'exercise',
  'exercises',
  'step',
  'steps',
  'item',
  'items',
  'line',
  'lines',
  'chapter',
  'chapters',
  'lesson',
  'lessons',
  'section',
  'sections',
  'part',
  'parts',
  'grade',
  'grades',
  'age',
  'ages',
  'level',
  'levels',
  'round',
  'rounds',
  'row',
  'rows',
  'column',
  'columns',
  'number',
  'numbers',
  'score',
  'scores',
  'pagina',
  'paginas',
  'problema',
  'problemas',
  'pregunta',
  'preguntas',
  'ejercicio',
  'ejercicios',
  'paso',
  'pasos',
  'linea',
  'lineas',
  'capitulo',
  'capitulos',
  'leccion',
  'lecciones',
  'seccion',
  'secciones',
  'parte',
  'partes',
  'grado',
  'grados',
  'edad',
  'edades',
  'nivel',
  'niveles',
  'fila',
  'filas',
  'columna',
  'columnas',
  'numero',
  'numeros',
  'marcador',
]);

const LATEX_OPERATORS: Readonly<Record<string, Operator>> = {
  times: '*',
  cdot: '*',
  ast: '*',
  div: '÷',
};
/** LaTeX fraction commands whose arguments are expressions ("\frac{6\times7}{2}"). */
const LATEX_FRACTIONS = new Set(['frac', 'dfrac', 'tfrac', 'cfrac']);
/** LaTeX sizing/spacing commands that render nothing between the numbers. */
const LATEX_IGNORED = new Set(['left', 'right', 'big', 'bigl', 'bigr', 'bigg', 'biggl', 'biggr']);

const LETTER_RE = /\p{L}/u;
const LETTER_RUN_RE = /\p{L}+/uy;
const ALNUM_RUN_RE = /[\p{L}\p{N}]+/uy;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const LATEX_COMMAND_RE = /\\([a-z]+|[,;:! ])/uy;
const ASCII_LETTER_RE = /[a-z]/u;
const PUNCTUATION_RE = /^[.,;:!?]+$/u;

function isLetter(c: string | undefined): boolean {
  return c !== undefined && LETTER_RE.test(c);
}

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && WORD_CHAR_RE.test(c);
}

function stickyMatch(re: RegExp, text: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(text);
}

function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

interface AtomEntry {
  end: number;
  values: Rational[];
  readings: Set<NumericReading>;
}

/** Longest operand mention starting at each offset, with every reading of that span. */
function atomTable(mentions: readonly NumericMention[]): Map<number, AtomEntry> {
  const table = new Map<number, AtomEntry>();
  for (const m of mentions) {
    if (!OPERAND_READINGS.has(m.reading)) continue;
    const current = table.get(m.start);
    if (current === undefined || m.end > current.end) {
      table.set(m.start, { end: m.end, values: [m.value], readings: new Set([m.reading]) });
    } else if (m.end === current.end) {
      current.readings.add(m.reading);
      if (!current.values.some((v) => v.num === m.value.num && v.den === m.value.den)) {
        current.values.push(m.value);
      }
    }
  }
  return table;
}

/** True when the letter run containing `at` is exactly the single letter "x". */
function standaloneX(text: string, at: number): boolean {
  return text[at] === 'x' && !isLetter(text[at - 1]) && !isLetter(text[at + 1]);
}

/** True when the letters just before `at` are a LaTeX command name ("\times7"). */
function latexCommandBefore(text: string, at: number): boolean {
  let j = at;
  while (j > 0 && ASCII_LETTER_RE.test(text[j - 1] ?? '')) j -= 1;
  return j < at && text[j - 1] === '\\';
}

/** True when the letter run at `at` is a unit that may be glued to a number ("6cm"). */
function gluedUnitAt(text: string, at: number): boolean {
  const word = stickyMatch(LETTER_RUN_RE, text, at)?.[0];
  return (
    word !== undefined &&
    UNIT_WORDS.has(word) &&
    !GLUED_UNIT_EXCLUDED.has(word) &&
    !isWordChar(text[at + word.length])
  );
}

/** Characters skipped after "°": one scale letter ("°C", "°F", "°K"). */
function degreeScale(text: string, at: number): number {
  return /^[cfk]$/u.test(text[at] ?? '') && !isLetter(text[at + 1]) ? 1 : 0;
}

/**
 * A markdown emphasis run ("*", "**", "***") wrapping exactly one number ("**6**"), glued to it
 * on both sides and not to a word outside. Returns the run length and where the closing run is.
 */
function emphasisWrap(
  text: string,
  at: number,
  atoms: ReadonlyMap<number, AtomEntry>,
): { length: number; closeAt: number } | null {
  let length = 0;
  while (text[at + length] === '*' && length < 4) length += 1;
  if (length > 3 || isWordChar(text[at - 1]) || text[at - 1] === '*') return null;
  const atom = atoms.get(at + length);
  if (atom === undefined) return null;
  const closeAt = text[atom.end] === '%' ? atom.end + 1 : atom.end;
  if (text.slice(closeAt, closeAt + length) !== '*'.repeat(length)) return null;
  const after = text[closeAt + length];
  return after === '*' || isWordChar(after) ? null : { length, closeAt };
}

interface Tokenized {
  readonly tokens: Token[];
  /** An emphasis run was read as markup (only when `emphasis`). */
  readonly wrapped: boolean;
}

function tokenize(
  text: string,
  atoms: ReadonlyMap<number, AtomEntry>,
  emphasis: boolean,
): Tokenized {
  const tokens: Token[] = [];
  let line = 0;
  let fresh = true; // no token yet on this line
  let wrapped = false;
  let closeAt = -1;
  let closeLength = 0;
  const push = (token: Token): void => {
    tokens.push(token);
    fresh = false;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? '';
    if (c === '\n') {
      line += 1;
      fresh = true;
      i += 1;
      continue;
    }
    if (i === closeAt) {
      i += closeLength;
      closeAt = -1;
      continue;
    }
    if (/\s/u.test(c) || TRANSPARENT.has(c) || CURRENCY_RE.test(c)) {
      i += 1;
      continue;
    }
    if (c === '°') {
      i += 1 + degreeScale(text, i + 1);
      continue;
    }
    if (emphasis && c === '*') {
      const wrap = emphasisWrap(text, i, atoms);
      if (wrap !== null) {
        wrapped = true;
        closeAt = wrap.closeAt;
        closeLength = wrap.length;
        i += wrap.length;
        continue;
      }
    }
    const atom = atoms.get(i);
    if (atom !== undefined) {
      const before = text[i - 1];
      const after = text[atom.end];
      const xBefore = isLetter(before) && standaloneX(text, i - 1);
      const xAfter = isLetter(after) && standaloneX(text, atom.end);
      const gluedBefore = isLetter(before) && !xBefore && !latexCommandBefore(text, i);
      const gluedAfter = isLetter(after) && !xAfter && !gluedUnitAt(text, atom.end);
      if (!gluedBefore && !gluedAfter) {
        const plain = atom.values.length === 1 && [...atom.readings].every(isPlainLiteralReading);
        push({
          kind: 'atom',
          start: i,
          end: atom.end,
          line,
          values: atom.values,
          integer: plain && atom.readings.has('integer') && atom.readings.size === 1,
          plain,
          xBefore,
          xAfter,
        });
        i = atom.end;
        continue;
      }
      const run = stickyMatch(ALNUM_RUN_RE, text, i);
      const end = Math.max(atom.end, i + (run?.[0].length ?? 1));
      push({ kind: 'break', start: i, end, line });
      i = end;
      continue;
    }
    const symbol = lookup(SYMBOL_OPERATORS, c);
    if (symbol !== undefined) {
      // "**" is a power in programming notation.
      const power = c === '*' && text[i + 1] === '*';
      const end = power ? i + 2 : i + 1;
      const lineStart = fresh && BULLET_SYMBOLS.has(c);
      push({
        kind: 'op',
        start: i,
        end,
        line,
        op: power ? '^' : symbol,
        char: c,
        signable: (c === '-' || c === '+') && !isWordChar(text[i - 1]),
        lineStart,
        bullet: lineStart,
        letterX: false,
      });
      i = end;
      continue;
    }
    if (c === '%') {
      push({ kind: 'postfix', start: i, end: i + 1, line, postfix: '%' });
      i += 1;
      continue;
    }
    if (OPEN.has(c) || CLOSE.has(c)) {
      push({ kind: OPEN.has(c) ? 'open' : 'close', start: i, end: i + 1, line, char: c });
      i += 1;
      continue;
    }
    if (c === '\\') {
      i = latexToken(text, i, line, push);
      continue;
    }
    if (isLetter(c)) {
      const token = wordToken(text, i, line);
      push(token);
      i = token.end;
      continue;
    }
    const run = /\p{N}/u.test(c) ? stickyMatch(ALNUM_RUN_RE, text, i) : null;
    const end = i + (run?.[0].length ?? 1);
    push({ kind: 'break', start: i, end, line });
    i = end;
  }
  return { tokens, wrapped };
}

/** Reads the LaTeX command at `i` (a backslash); returns the offset after it. */
function latexToken(text: string, i: number, line: number, push: (t: Token) => void): number {
  const next = text[i + 1] ?? '';
  // "\(" "\)" "\[" "\]" delimit math; "\{" "\}" are literal braces: none ends an operand.
  if (next !== '' && '()[]{}'.includes(next)) return i + 2;
  if (next === '%') {
    push({ kind: 'postfix', start: i, end: i + 2, line, postfix: '%' });
    return i + 2;
  }
  const command = stickyMatch(LATEX_COMMAND_RE, text, i);
  const name = command?.[1] ?? '';
  const end = i + (command?.[0].length ?? 1);
  const op = lookup(LATEX_OPERATORS, name);
  if (op !== undefined) {
    push({
      kind: 'op',
      start: i,
      end,
      line,
      op,
      char: op,
      signable: false,
      lineStart: false,
      bullet: false,
      letterX: false,
    });
  } else if (LATEX_FRACTIONS.has(name)) {
    push({ kind: 'frac', start: i, end, line });
  } else if (!LATEX_IGNORED.has(name) && !/^[,;:! ]$/u.test(name)) {
    push({ kind: 'break', start: i, end, line });
  }
  return end;
}

function isPlainLiteralReading(reading: NumericReading): boolean {
  return reading === 'integer' || reading === 'decimal';
}

function wordToken(text: string, i: number, line: number): Token {
  const run = stickyMatch(LETTER_RUN_RE, text, i);
  const word = run?.[0] ?? text[i] ?? '';
  const end = i + Math.max(word.length, 1);
  for (const [re, value, kind] of PHRASE_HEADS.has(word) ? PHRASES : []) {
    const m = stickyMatch(re, text, i);
    if (m === null) continue;
    const phraseEnd = i + m[0].length;
    return kind === 'op'
      ? {
          kind: 'op',
          start: i,
          end: phraseEnd,
          line,
          op: value as Operator,
          char: value,
          signable: false,
          lineStart: false,
          bullet: false,
          letterX: false,
        }
      : { kind: 'postfix', start: i, end: phraseEnd, line, postfix: value as Postfix };
  }
  const op = lookup(WORD_OPERATORS, word);
  if (op !== undefined) {
    return {
      kind: 'op',
      start: i,
      end,
      line,
      op,
      char: op,
      signable: false,
      lineStart: false,
      bullet: false,
      letterX: word === 'x',
    };
  }
  const postfix = lookup(WORD_POSTFIX, word);
  if (postfix !== undefined) return { kind: 'postfix', start: i, end, line, postfix };
  if (UNIT_WORDS.has(word)) return { kind: 'unit', start: i, end, line };
  return { kind: 'break', start: i, end, line, word };
}

// ---------------------------------------------------------------------------------------------
// Token post-passes: braced operators, \frac, ranges and dates, bullets
// ---------------------------------------------------------------------------------------------

function toBreak(token: Token): Token {
  return { kind: 'break', start: token.start, end: token.end, line: token.line };
}

/** "6{\times}7": braces around a lone operator group nothing. */
function collapseBracedOperators(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k] as Token;
    const op = tokens[k + 1];
    const close = tokens[k + 2];
    if (
      t.kind === 'open' &&
      t.char === '{' &&
      op?.kind === 'op' &&
      close?.kind === 'close' &&
      close.char === '}'
    ) {
      out.push(op);
      k += 2;
      continue;
    }
    out.push(t);
  }
  return out;
}

/** "\frac{A}{B}" -> "((A) / (B))"; a \frac without two brace groups ends an expression. */
function rewriteFractions(tokens: readonly Token[]): Token[] {
  if (!tokens.some((t) => t.kind === 'frac')) return [...tokens];
  const match = new Map<number, number>();
  const stack: number[] = [];
  tokens.forEach((t, k) => {
    if (t.kind === 'open') stack.push(k);
    else if (t.kind === 'close') {
      const open = stack.pop();
      if (open !== undefined) match.set(open, k);
    }
  });
  const replace = new Map<number, Token>();
  const after = new Map<number, Token>();
  tokens.forEach((t, k) => {
    if (t.kind !== 'frac') return;
    const numerator = tokens[k + 1];
    const numeratorEnd = match.get(k + 1);
    if (numerator?.kind !== 'open' || numerator.char !== '{' || numeratorEnd === undefined) return;
    const denominator = tokens[numeratorEnd + 1];
    const denominatorEnd = match.get(numeratorEnd + 1);
    if (denominator?.kind !== 'open' || denominator.char !== '{' || denominatorEnd === undefined) {
      return;
    }
    const n = tokens[numeratorEnd] as Token;
    const d = tokens[denominatorEnd] as Token;
    replace.set(k, { ...t, kind: 'open', char: '(', synthetic: true });
    after.set(numeratorEnd, {
      kind: 'op',
      start: n.end,
      end: n.end,
      line: n.line,
      op: '/',
      char: '/',
      signable: false,
      lineStart: false,
      bullet: false,
      letterX: false,
    });
    after.set(denominatorEnd, {
      kind: 'close',
      start: d.end,
      end: d.end,
      line: d.line,
      char: ')',
      synthetic: true,
    });
  });
  const out: Token[] = [];
  tokens.forEach((t, k) => {
    out.push(replace.get(k) ?? (t.kind === 'frac' ? toBreak(t) : t));
    const extra = after.get(k);
    if (extra !== undefined) out.push(extra);
  });
  return out;
}

function isIntegerAtom(token: Token | undefined): token is AtomToken {
  return token?.kind === 'atom' && token.integer;
}

/** "a-b": two integer literals joined by a hyphen with no space on either side. */
function gluedHyphen(a: Token | undefined, op: Token | undefined, b: Token | undefined): boolean {
  return (
    isIntegerAtom(a) &&
    op?.kind === 'op' &&
    op.char === '-' &&
    op.start === a.end &&
    isIntegerAtom(b) &&
    b.start === op.end
  );
}

function integerValue(token: AtomToken): bigint {
  return token.values[0]?.num ?? 0n;
}

function isoDate(tokens: readonly Token[], k: number): boolean {
  const [year, , month, , day] = tokens.slice(k, k + 5);
  if (!gluedHyphen(year, tokens[k + 1], month) || !gluedHyphen(month, tokens[k + 3], day)) {
    return false;
  }
  const y = year as AtomToken;
  const m = month as AtomToken;
  const d = day as AtomToken;
  const mv = integerValue(m);
  const dv = integerValue(d);
  return (
    y.end - y.start === 4 &&
    m.end - m.start === 2 &&
    d.end - d.start === 2 &&
    mv >= 1n &&
    mv <= 12n &&
    dv >= 1n &&
    dv <= 31n &&
    tokens[k + 5]?.kind !== 'op'
  );
}

/** Ranges ("pages 3-5", "5-10 minutes") and ISO dates are not subtraction (see header). */
function markRanges(tokens: Token[]): Token[] {
  for (let k = 0; k + 2 < tokens.length; k++) {
    const a = tokens[k];
    const b = tokens[k + 2];
    if (!gluedHyphen(a, tokens[k + 1], b)) continue;
    if (isoDate(tokens, k)) {
      tokens[k + 1] = toBreak(tokens[k + 1] as Token);
      tokens[k + 3] = toBreak(tokens[k + 3] as Token);
      k += 4;
      continue;
    }
    const prev = tokens[k - 1];
    const next = tokens[k + 3];
    if (
      prev?.kind === 'op' ||
      prev?.kind === 'close' ||
      next?.kind === 'op' ||
      next?.kind === 'postfix' ||
      (next?.kind === 'open' && next.start === (b as Token).end)
    ) {
      continue;
    }
    const noun = prev?.kind === 'break' && prev.word !== undefined && RANGE_NOUNS.has(prev.word);
    const ascending =
      next?.kind === 'unit' && integerValue(a as AtomToken) < integerValue(b as AtomToken);
    if (noun || ascending) tokens[k + 1] = toBreak(tokens[k + 1] as Token);
  }
  return tokens;
}

const OPERAND_END_KINDS: ReadonlySet<Token['kind']> = new Set<Token['kind']>([
  'atom',
  'close',
  'postfix',
  'unit',
]);

/**
 * Vertical arithmetic ("40" then "+ 2" on the next line): the previous line ends with a number,
 * the sign's line holds one number (then only punctuation), and the previous line does not start
 * with the same sign as a bullet ("- 3" then "- 4" is a list).
 */
function verticalOperator(
  tokens: readonly Token[],
  k: number,
  firstOfLine: ReadonlyMap<number, number>,
  text: string,
): boolean {
  const t = tokens[k] as OperatorToken;
  const prev = tokens[k - 1];
  if (prev === undefined || !OPERAND_END_KINDS.has(prev.kind)) return false;
  const first = tokens[firstOfLine.get(prev.line) ?? -1];
  if (first?.kind === 'op' && first.lineStart && first.char === t.char && first.bullet) {
    return false;
  }
  const operand = readOperand(tokens, k + 1, false);
  if (typeof operand === 'number') return false;
  for (let j = operand.next; j < tokens.length; j++) {
    const rest = tokens[j] as Token;
    if (rest.line !== t.line) break;
    if (rest.kind !== 'break' || !PUNCTUATION_RE.test(text.slice(rest.start, rest.end))) {
      return false;
    }
  }
  return true;
}

function resolveBullets(tokens: Token[], text: string): Token[] {
  const firstOfLine = new Map<number, number>();
  tokens.forEach((t, k) => {
    if (!firstOfLine.has(t.line)) firstOfLine.set(t.line, k);
  });
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t?.kind !== 'op' || !t.lineStart) continue;
    tokens[k] = { ...t, bullet: !verticalOperator(tokens, k, firstOfLine, text) };
  }
  return tokens;
}

function prepare(tokens: readonly Token[], text: string): Token[] {
  return resolveBullets(markRanges(rewriteFractions(collapseBracedOperators(tokens))), text);
}

// ---------------------------------------------------------------------------------------------
// Chains: operand (operator operand)*
// ---------------------------------------------------------------------------------------------

/** A piece of the expression: fixed text, or an operand atom whose reading is chosen later. */
type Part =
  | {
      readonly text: string;
      readonly start: number;
      readonly end: number;
      readonly paren?: 'open' | 'close';
      /** Brackets binding a percent sign to its own number: rendered in one of two readings. */
      readonly wrap?: true;
      /** A binary operator or a power postfix (counted for groups and division by zero). */
      readonly op?: true;
    }
  | { readonly atom: AtomToken };

interface Operand {
  readonly parts: readonly Part[];
  readonly next: number;
  readonly power: boolean;
  /** The last atom is glued to a following "x" that must be used as a times sign. */
  readonly xAfter: boolean;
}

interface Chain {
  readonly parts: readonly Part[];
  readonly next: number;
  readonly operands: number;
  readonly operators: number;
  readonly power: boolean;
  /** Two plain literals joined by one "/": already read as a fraction. */
  readonly plainFraction: boolean;
}

function fixed(token: Token, text: string, paren?: 'open' | 'close'): Part {
  return paren === undefined
    ? { text, start: token.start, end: token.end }
    : { text, start: token.start, end: token.end, paren };
}

/**
 * Reads one operand at `i`: opening brackets, an optional glued sign, a number (or a mixed number
 * "2 1/2"), an optional postfix, up to MAX_UNITS unit words (a unit may carry "^2"/"^3": "cm²"),
 * closing brackets. `afterX`: the previous token is a standalone "x" used as times, so a number
 * glued to it is allowed.
 */
function readOperand(tokens: readonly Token[], i: number, afterX: boolean): Operand | number {
  const parts: Part[] = [];
  let j = i;
  while (tokens[j]?.kind === 'open') {
    parts.push(fixed(tokens[j] as Token, '(', 'open'));
    j += 1;
  }
  const failAt = j;
  const operandStart = parts.length;
  const sign = tokens[j];
  const glued = tokens[j + 1];
  if (sign?.kind === 'op' && sign.signable && glued?.kind === 'atom' && glued.start === sign.end) {
    parts.push(fixed(sign, sign.op));
    j += 1;
  }
  const atom = tokens[j];
  if (atom?.kind !== 'atom') return failAt;
  if (atom.xBefore && !(afterX && j === i)) return failAt;
  j += 1;
  const whole = tokens[j];
  const slash = tokens[j + 1];
  const denominator = tokens[j + 2];
  let last: AtomToken = atom;
  if (
    atom.integer &&
    !atom.xAfter &&
    whole?.kind === 'atom' &&
    whole.integer &&
    whole.start > atom.end &&
    slash?.kind === 'op' &&
    slash.op === '/' &&
    denominator?.kind === 'atom' &&
    denominator.integer
  ) {
    // Mixed number "2 1/2": parenthesized so it may be a divisor or carry an operator.
    parts.push(
      { text: '(', start: atom.start, end: atom.start },
      { atom },
      { atom: whole },
      { text: '/', start: slash.start, end: slash.end },
      { atom: denominator },
      { text: ')', start: denominator.end, end: denominator.end },
    );
    last = denominator;
    j += 3;
  } else {
    parts.push({ atom });
  }
  let power = false;
  const postfix = (): void => {
    const post = tokens[j];
    if (post?.kind !== 'postfix') return;
    const isPower = post.postfix !== '%';
    parts.push(
      isPower
        ? { text: post.postfix, start: post.start, end: post.end, op: true }
        : fixed(post, post.postfix),
    );
    power ||= isPower;
    j += 1;
  };
  if (!last.xAfter) {
    postfix();
    const post = tokens[j - 1];
    if (post?.kind === 'postfix' && post.postfix === '%') {
      // "15%/30%": the percent binds to its own number in one reading (see renderings()).
      const at = parts[operandStart];
      const from = at === undefined ? post.start : 'atom' in at ? at.atom.start : at.start;
      parts.splice(operandStart, 0, { text: '(', start: from, end: from, wrap: true });
      parts.push({ text: ')', start: post.end, end: post.end, wrap: true });
    }
    j = skipUnits(tokens, j);
  }
  let closed = false;
  while (tokens[j]?.kind === 'close') {
    parts.push(fixed(tokens[j] as Token, ')', 'close'));
    closed = true;
    j += 1;
  }
  // "(3 + 4) squared": a postfix after a closing bracket applies to the group.
  if (closed) postfix();
  return { parts, next: j, power, xAfter: last.xAfter && tokens[j - 1] === last };
}

/** Skips unit words after a number, with a glued "^2"/"^3" that belongs to the unit ("cm²"). */
function skipUnits(tokens: readonly Token[], at: number): number {
  let j = at;
  let units = 0;
  while (tokens[j]?.kind === 'unit' && units < MAX_UNITS) {
    const unit = tokens[j] as Token;
    j += 1;
    units += 1;
    const caret = tokens[j];
    const exponent = tokens[j + 1];
    if (
      caret?.kind === 'op' &&
      caret.op === '^' &&
      caret.start === unit.end &&
      isIntegerAtom(exponent) &&
      exponent.start === caret.end &&
      (integerValue(exponent) === 2n || integerValue(exponent) === 3n)
    ) {
      j += 2;
    }
  }
  return j;
}

function readChain(tokens: readonly Token[], i: number): Chain | number {
  const first = readOperand(tokens, i, false);
  if (typeof first === 'number') return first;
  const parts: Part[] = [...first.parts];
  let next = first.next;
  let operands = 1;
  let operators = 0;
  let power = first.power;
  let xAfter = first.xAfter;
  let slashOnly = true;
  // Last state that does not end in a number glued to an unused "x" ("3 + 2x": drop "+ 2").
  let committed: Chain | null = xAfter
    ? null
    : { parts: [...parts], next, operands, operators, power, plainFraction: false };
  for (;;) {
    const op = tokens[next];
    const prev = tokens[next - 1];
    // "3(14)", "(6)(7)", "2(3 + 4)": a bracket glued to a number or a bracket is a product.
    const juxtaposed =
      !xAfter &&
      op?.kind === 'open' &&
      op.synthetic !== true &&
      JUXTAPOSED_OPEN.has(op.char) &&
      (prev?.kind === 'atom' || prev?.kind === 'close') &&
      prev.end === op.start;
    if (!juxtaposed && (op?.kind !== 'op' || op.bullet)) break;
    if (!juxtaposed && xAfter && !(op as OperatorToken).letterX) break;
    if (operands >= MAX_OPERANDS + 1) break;
    const operand = juxtaposed
      ? readOperand(tokens, next, false)
      : readOperand(tokens, next + 1, (op as OperatorToken).letterX);
    if (typeof operand === 'number') break;
    const operatorPart: Part = juxtaposed
      ? { text: '*', start: op.start, end: op.start, op: true }
      : { text: (op as OperatorToken).op, start: op.start, end: op.end, op: true };
    parts.push(operatorPart, ...operand.parts);
    if (operatorPart.text !== '/') slashOnly = false;
    operands += 1;
    operators += 1;
    power ||= operatorPart.text === '^' || operand.power;
    next = operand.next;
    xAfter = operand.xAfter;
    if (!xAfter) {
      committed = { parts: [...parts], next, operands, operators, power, plainFraction: false };
    }
  }
  if (committed === null) return first.next;
  const atoms = committed.parts.filter((p): p is { atom: AtomToken } => 'atom' in p);
  const plainFraction =
    slashOnly &&
    committed.operators === 1 &&
    committed.parts.length === 3 &&
    atoms.length === 2 &&
    atoms.every((p) => p.atom.plain);
  return { ...committed, plainFraction };
}

/** Drops brackets that are not matched inside the chain ("(see 3 + 4)" -> "3 + 4"). */
function balance(parts: readonly Part[]): Part[] {
  const drop = new Set<number>();
  const stack: number[] = [];
  parts.forEach((p, index) => {
    if (!('paren' in p) || p.paren === undefined) return;
    if (p.paren === 'open') stack.push(index);
    else if (stack.length > 0) stack.pop();
    else drop.add(index);
  });
  for (const index of stack) drop.add(index);
  return parts.filter((_p, index) => !drop.has(index));
}

function isOperatorPart(p: Part): boolean {
  return 'text' in p && p.op === true;
}

/**
 * Bracketed groups of a balanced chain worth reading on their own: not the whole chain, not a
 * redundant double bracket, and holding an operator ("(6)" is just 6).
 */
function bracketGroups(parts: readonly Part[]): [number, number][] {
  const stack: number[] = [];
  const match = new Map<number, number>();
  const groups: [number, number][] = [];
  parts.forEach((p, index) => {
    if (!('paren' in p) || p.paren === undefined) return;
    if (p.paren === 'open') {
      stack.push(index);
      return;
    }
    const open = stack.pop();
    if (open === undefined) return;
    match.set(open, index);
    groups.push([open, index]);
  });
  return groups.filter(([open, close]) => {
    if (open === 0 && close === parts.length - 1) return false;
    const inner = parts[open + 1];
    if (inner !== undefined && 'paren' in inner && inner.paren === 'open') {
      if (match.get(open + 1) === close - 1) return false;
    }
    return parts.slice(open + 1, close).some(isOperatorPart);
  });
}

function spanOf(parts: readonly Part[]): { start: number; end: number } {
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  for (const p of parts) {
    const s = 'atom' in p ? p.atom.start : p.start;
    const e = 'atom' in p ? p.atom.end : p.end;
    if ('atom' in p || p.end > p.start) {
      start = Math.min(start, s);
      end = Math.max(end, e);
    }
  }
  return { start, end };
}

function renderValue(value: Rational): string {
  if (value.den === 1n) return value.num < 0n ? `(${value.num})` : value.num.toString();
  return `(${value.num}/${value.den})`;
}

function readingCount(parts: readonly Part[]): number {
  let count = 1;
  for (const p of parts) {
    if ('atom' in p) {
      count *= p.atom.values.length;
      if (count > MAX_READINGS) return count;
    }
  }
  return count;
}

/**
 * Every rendering of the chain: one group per combination of operand readings, and in each group
 * one string per reading of a percent after a division ("15%/30%": each percent bound to its own
 * number, and the grading parser's own reading, where "1/2%" is half a percent).
 */
function renderings(parts: readonly Part[]): string[][] {
  const atoms = parts.filter((p): p is { atom: AtomToken } => 'atom' in p);
  const modes = parts.some((p) => 'wrap' in p) ? [true, false] : [false];
  const groups: string[][] = [];
  const choice = atoms.map(() => 0);
  for (;;) {
    const group: string[] = [];
    for (const wrapped of modes) {
      let k = 0;
      const pieces: string[] = [];
      for (const p of parts) {
        if ('atom' in p) {
          pieces.push(renderValue(p.atom.values[choice[k] ?? 0] ?? rational(0n)));
          k += 1;
        } else if (wrapped || !('wrap' in p)) {
          pieces.push(p.text);
        }
      }
      group.push(pieces.join(' '));
    }
    groups.push(group);
    // Next combination (mixed-radix counter over the operands' readings).
    let d = 0;
    while (d < atoms.length) {
      const size = atoms[d]?.atom.values.length ?? 1;
      const c = (choice[d] ?? 0) + 1;
      if (c < size) {
        choice[d] = c;
        break;
      }
      choice[d] = 0;
      d += 1;
    }
    if (d === atoms.length) return groups;
  }
}

interface EvalState {
  readonly cache: Map<string, ParseOutcome>;
  /** Parser calls made for this text (cache hits are free). */
  parses: number;
}

/** The parser's result for one rendering, or null when the text's parse budget is spent. */
function parseCached(source: string, state: EvalState): ParseOutcome | null {
  const cached = state.cache.get(source);
  if (cached !== undefined) return cached;
  if (state.parses >= MAX_PARSES) return null;
  state.parses += 1;
  const result = parseMathAnswer(source);
  const outcome: ParseOutcome = result.ok
    ? { ok: true, value: rational(result.value.num, result.value.den) }
    : { ok: false, code: result.error.code };
  if (state.cache.size < CACHE_LIMIT) state.cache.set(source, outcome);
  return outcome;
}

interface Evaluation {
  readonly values: Rational[];
  readonly failure: ExpressionFailureTechnique | null;
  /** The text's parse budget ran out: stop reading this text (it already fails closed). */
  readonly exhausted: boolean;
}

/** Values of one chain or group, or the fail-closed technique when a reading has no value. */
function evaluate(parts: readonly Part[], state: EvalState): Evaluation {
  const operators = parts.filter(isOperatorPart);
  // A slash-only chain ("50/50/0") hides nothing: each "a/b" in it is read as a fraction.
  const hidesValues = operators.length >= 2 && operators.some((p) => 'text' in p && p.text !== '/');
  const values: Rational[] = [];
  const seen = new Set<string>();
  let failure: ExpressionFailureTechnique | null = null;
  for (const group of renderings(parts)) {
    let any = false;
    let unevaluable = false;
    let divisionByZero = false;
    for (const source of group) {
      const outcome = parseCached(source, state);
      if (outcome === null) return { values, failure: 'expression_unbounded', exhausted: true };
      if (outcome.ok) {
        any = true;
        const key = `${outcome.value.num}/${outcome.value.den}`;
        if (!seen.has(key)) {
          seen.add(key);
          values.push(outcome.value);
        }
      } else if (UNBOUNDED_CODES.has(outcome.code)) {
        // Fails closed whatever the other readings are: skip them.
        return { values, failure: 'expression_unbounded', exhausted: false };
      } else if (outcome.code === 'DIVISION_BY_ZERO') {
        divisionByZero = true;
      } else {
        unevaluable = true;
      }
    }
    // A lone "5 ÷ 0" has no value; a longer chain must not hide its other values behind one.
    if (!any && (unevaluable || (divisionByZero && hidesValues))) {
      failure ??= 'expression_unevaluable';
    }
  }
  return { values, failure, exhausted: false };
}

interface Collector {
  readonly mentions: Map<string, NumericMention>;
  readonly failures: Map<string, ExpressionFailure>;
}

function addFailure(
  out: Collector,
  start: number,
  end: number,
  technique: ExpressionFailureTechnique,
): void {
  out.failures.set(`${start}:${end}:${technique}`, { start, end, technique });
}

/** Reads every chain of one token stream. Returns false when the text must stop being read. */
function readChains(tokens: readonly Token[], state: EvalState, out: Collector): boolean {
  let chains = 0;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const chain = token === undefined || token.kind === 'break' ? i + 1 : readChain(tokens, i);
    if (typeof chain === 'number') {
      i = Math.max(chain, i + 1);
      continue;
    }
    i = Math.max(chain.next, i + 1);
    if ((chain.operators === 0 && !chain.power) || chain.plainFraction) continue;
    const parts = balance(chain.parts);
    const { start, end } = spanOf(parts);
    if (chain.operands > MAX_OPERANDS || readingCount(parts) > MAX_READINGS) {
      addFailure(out, start, end, 'expression_unbounded');
      continue;
    }
    chains += 1;
    if (chains > MAX_EXPRESSIONS) {
      addFailure(out, start, end, 'expression_unbounded');
      return false;
    }
    const groups = bracketGroups(parts);
    if (groups.length > MAX_GROUPS) {
      addFailure(out, start, end, 'expression_unbounded');
      continue;
    }
    const pieces = [parts, ...groups.map(([open, close]) => parts.slice(open + 1, close))];
    for (const piece of pieces) {
      const { values, failure, exhausted } = evaluate(piece, state);
      const span = piece === parts ? { start, end } : spanOf(piece);
      for (const value of values) {
        out.mentions.set(`${span.start}:${span.end}:${value.num}/${value.den}`, {
          value,
          start: span.start,
          end: span.end,
          reading: 'expression',
          decimalPlaces: null,
        });
      }
      if (failure !== null) addFailure(out, start, end, failure);
      if (exhausted) return false;
      // The chain already fails closed; its groups add nothing.
      if (failure === 'expression_unbounded') break;
    }
  }
  return true;
}

/**
 * Expression readings of canonical lowercase text. `mentions` are the text's own numeric
 * mentions (operands are read from them, so every notation the guard reads is an operand).
 * `cache` shares parser results across the texts of one scan.
 */
export function extractExpressionReadings(
  text: string,
  mentions: readonly NumericMention[],
  cache: ExpressionCache = createExpressionCache(),
): ExpressionReadings {
  const atoms = atomTable(mentions);
  const state: EvalState = { cache: cache.results, parses: 0 };
  const out: Collector = { mentions: new Map(), failures: new Map() };
  // Rendered markdown hides "*" around a lone number; plain text shows it as a times sign.
  const emphasized = tokenize(text, atoms, true);
  const passes = emphasized.wrapped
    ? [tokenize(text, atoms, false).tokens, emphasized.tokens]
    : [emphasized.tokens];
  for (const tokens of passes) {
    if (!readChains(prepare(tokens, text), state, out)) break;
  }
  return { mentions: [...out.mentions.values()], failures: [...out.failures.values()] };
}
