import { err, ok, type Result } from '../shared/result.ts';
import {
  addRational,
  divideRational,
  isIntegerRational,
  multiplyRational,
  negateRational,
  powRational,
  rational,
  subtractRational,
  type Rational,
} from './rational.ts';
import { stripInvisible } from './text.ts';

/**
 * Safe math-answer parser (spec P5: "safe parsers ... never `eval` of model-generated code").
 * A hand-written tokenizer and recursive-descent parser evaluate directly into exact rationals.
 * Input size, token count, nesting depth, exponent size and result magnitude are all bounded so
 * hostile text cannot cause unbounded work. Ambiguous notations are reported, never guessed.
 */

export const PARSE_ERROR_CODES = [
  'EMPTY_INPUT',
  'INPUT_TOO_LONG',
  'TOO_COMPLEX',
  'INVALID_SYNTAX',
  'AMBIGUOUS_FORMAT',
  'UNSUPPORTED_EXPRESSION',
  'DIVISION_BY_ZERO',
  'EXPONENT_OUT_OF_RANGE',
  'RESULT_TOO_LARGE',
] as const;
export type ParseErrorCode = (typeof PARSE_ERROR_CODES)[number];

/** Maximum answer length in UTF-16 code units, checked before any other work. */
export const MAX_ANSWER_LENGTH = 200;
export const MAX_TOKENS = 120;
export const MAX_NESTING_DEPTH = 24;
/** Integer exponents only, |e| <= 12. */
export const MAX_EXPONENT = 12;
/**
 * Decision: every intermediate and final numerator/denominator must have at most 100 digits
 * (|n| < 10^100). School answers never approach this; it caps BigInt work on hostile input.
 */
export const MAX_RESULT_DIGITS = 100;
const MAGNITUDE_LIMIT = 10n ** BigInt(MAX_RESULT_DIGITS);

export type AnswerFormKind =
  'integer' | 'decimal' | 'fraction' | 'mixed_number' | 'percent' | 'expression';

/** How the student wrote the value; used by `requireSimplestForm`. */
export interface AnswerForm {
  readonly kind: AnswerFormKind;
  /** Every written fraction is in lowest terms (denominator > 1; mixed-number part proper). */
  readonly reduced: boolean;
}

export interface ParsedAnswer {
  readonly value: Rational;
  readonly form: AnswerForm;
}

export interface ParseOptions {
  /** 'value' (default): "50%" = 1/2. 'reject': a percent sign is UNSUPPORTED_EXPRESSION. */
  readonly percent?: 'value' | 'reject';
}

/**
 * Decision: a value is in simplest form when it is a single number (integer, decimal, fraction,
 * mixed number or percent, optionally signed or parenthesized) whose written fractions are in
 * lowest terms. Improper fractions in lowest terms ("5/2") count as simplest so a valid answer is
 * not marked wrong; unevaluated expressions ("1+1/2", "2²") do not.
 */
export function isSimplestForm(form: AnswerForm): boolean {
  return form.kind !== 'expression' && form.reduced;
}

// ---------------------------------------------------------------------------------------------
// Character tables
// ---------------------------------------------------------------------------------------------

const VULGAR_FRACTIONS: ReadonlyMap<string, readonly [bigint, bigint]> = new Map([
  ['½', [1n, 2n]],
  ['⅓', [1n, 3n]],
  ['⅔', [2n, 3n]],
  ['¼', [1n, 4n]],
  ['¾', [3n, 4n]],
  ['⅕', [1n, 5n]],
  ['⅖', [2n, 5n]],
  ['⅗', [3n, 5n]],
  ['⅘', [4n, 5n]],
  ['⅙', [1n, 6n]],
  ['⅚', [5n, 6n]],
  ['⅐', [1n, 7n]],
  ['⅛', [1n, 8n]],
  ['⅜', [3n, 8n]],
  ['⅝', [5n, 8n]],
  ['⅞', [7n, 8n]],
  ['⅑', [1n, 9n]],
  ['⅒', [1n, 10n]],
] as const);

const SUPERSCRIPTS: ReadonlyMap<string, string> = new Map([
  ['⁰', '0'],
  ['¹', '1'],
  ['²', '2'],
  ['³', '3'],
  ['⁴', '4'],
  ['⁵', '5'],
  ['⁶', '6'],
  ['⁷', '7'],
  ['⁸', '8'],
  ['⁹', '9'],
  ['⁻', '-'],
  ['⁺', '+'],
]);

const SUBSCRIPTS: ReadonlyMap<string, string> = new Map([
  ['₀', '0'],
  ['₁', '1'],
  ['₂', '2'],
  ['₃', '3'],
  ['₄', '4'],
  ['₅', '5'],
  ['₆', '6'],
  ['₇', '7'],
  ['₈', '8'],
  ['₉', '9'],
]);

/** ASCII solidus, U+2044 FRACTION SLASH, U+2215 DIVISION SLASH: fraction bars. */
const FRACTION_SLASHES = new Set(['/', '\u2044', '\u2215']);
const MULTIPLY_SIGNS = new Set(['*', '×', '·', '⋅', '∙', '∗']);
/**
 * Decision: U+2212 MINUS SIGN is a minus anywhere (it is the typeset minus). Hyphen/figure/en
 * dashes (U+2010, U+2012, U+2013) are a minus only as the first symbol (en dash + "3" = -3);
 * between values they may mean a range (5 en-dash 3), so they are AMBIGUOUS_FORMAT, as are em
 * dashes anywhere.
 */
const LEADING_ONLY_DASHES = new Set(['\u2010', '\u2012', '\u2013']);
const AMBIGUOUS_DASHES = new Set(['\u2014', '\u2015', '\u2e3a', '\u2e3b']);

/**
 * Characters whose meaning NFKC would destroy: it rewrites "²" to "2" (turning 3² into 32) and
 * "½" to "1\u20442" (turning 2½ into 21\u20442). They are preserved and tokenized explicitly.
 */
function isPreserved(ch: string): boolean {
  return VULGAR_FRACTIONS.has(ch) || SUPERSCRIPTS.has(ch) || SUBSCRIPTS.has(ch);
}

/**
 * Decision: NFKC is applied per code point, except to superscripts, subscripts and vulgar
 * fractions, which carry structure NFKC would erase. Fullwidth digits/operators, NBSP and other
 * compatibility forms are still folded to ASCII.
 */
export function normalizeMathText(text: string): string {
  let out = '';
  for (const ch of text) out += isPreserved(ch) ? ch : ch.normalize('NFKC');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------------

type OperatorSymbol = '+' | '-' | '*' | '/' | '÷' | '^' | '%' | '(' | ')';

type Token =
  | {
      readonly kind: 'number';
      readonly whole: string;
      readonly fraction: string | null;
      readonly spaceBefore: boolean;
    }
  | {
      readonly kind: 'vulgar';
      readonly num: bigint;
      readonly den: bigint;
      readonly spaceBefore: boolean;
    }
  | { readonly kind: 'superscript'; readonly exponent: bigint; readonly spaceBefore: boolean }
  | { readonly kind: 'op'; readonly op: OperatorSymbol; readonly spaceBefore: boolean };

class ParseFailure extends Error {
  readonly code: ParseErrorCode;
  constructor(code: ParseErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Internal control flow only: every ParseFailure is converted to a Result at the API boundary. */
function fail(code: ParseErrorCode, message: string): never {
  throw new ParseFailure(code, message);
}

const isDigit = (ch: string | undefined): ch is string =>
  ch !== undefined && ch >= '0' && ch <= '9';

function tokenize(text: string): Token[] {
  const chars = Array.from(text);
  const tokens: Token[] = [];
  let i = 0;
  let spaceBefore = false;
  const push = (token: Token) => {
    tokens.push(token);
    spaceBefore = false;
    if (tokens.length > MAX_TOKENS) fail('TOO_COMPLEX', 'answer has too many symbols');
  };

  while (i < chars.length) {
    const ch = chars[i]!;
    if (/\s/.test(ch)) {
      spaceBefore = true;
      i++;
      continue;
    }
    if (isDigit(ch) || (ch === '.' && isDigit(chars[i + 1]))) {
      i = scanNumber(chars, i, (whole, fraction) =>
        push({ kind: 'number', whole, fraction, spaceBefore }),
      );
      continue;
    }
    const vulgar = VULGAR_FRACTIONS.get(ch);
    if (vulgar !== undefined) {
      push({ kind: 'vulgar', num: vulgar[0], den: vulgar[1], spaceBefore });
      i++;
      continue;
    }
    if (SUPERSCRIPTS.has(ch)) {
      i = scanSuperscript(chars, i, push, spaceBefore);
      continue;
    }
    if (SUBSCRIPTS.has(ch)) fail('UNSUPPORTED_EXPRESSION', 'subscript outside a fraction');
    if (ch === '.') fail('INVALID_SYNTAX', 'decimal point without digits');
    if (ch === ',') fail('AMBIGUOUS_FORMAT', 'comma is not a valid thousands separator here');
    if (ch === ':') fail('AMBIGUOUS_FORMAT', 'colon may be a ratio, a time or a division');
    if (AMBIGUOUS_DASHES.has(ch)) fail('AMBIGUOUS_FORMAT', 'dash may be a range or a minus');
    if (LEADING_ONLY_DASHES.has(ch)) {
      if (tokens.length > 0) fail('AMBIGUOUS_FORMAT', 'dash between values may be a range');
      push({ kind: 'op', op: '-', spaceBefore });
      i++;
      continue;
    }
    const op = operatorFor(ch);
    if (op === null) fail('UNSUPPORTED_EXPRESSION', 'unsupported symbol or letter in answer');
    push({ kind: 'op', op, spaceBefore });
    i++;
  }
  return tokens;
}

function operatorFor(ch: string): OperatorSymbol | null {
  if (ch === '+') return '+';
  if (ch === '-' || ch === '\u2212') return '-';
  if (MULTIPLY_SIGNS.has(ch)) return '*';
  if (FRACTION_SLASHES.has(ch)) return '/';
  if (ch === '÷') return '÷';
  if (ch === '^') return '^';
  if (ch === '%') return '%';
  if (ch === '(') return '(';
  if (ch === ')') return ')';
  return null;
}

/**
 * Reads digits with optional thousands separators and decimal part. Separators must form valid
 * 3-digit groups after a 1-3 digit leading group that does not start with 0; anything else
 * ("1,5", "1,00", "0,500", "1.000,5") is AMBIGUOUS_FORMAT because it may be a decimal comma.
 */
function scanNumber(
  chars: readonly string[],
  start: number,
  emit: (whole: string, fraction: string | null) => void,
): number {
  let i = start;
  let whole = '';
  while (isDigit(chars[i])) whole += chars[i++];
  if (chars[i] === ',' && whole !== '') {
    if (whole.length > 3 || whole.startsWith('0')) {
      fail('AMBIGUOUS_FORMAT', 'comma is not a valid thousands separator here');
    }
    while (chars[i] === ',') {
      const group = chars.slice(i + 1, i + 4);
      if (group.length !== 3 || !group.every(isDigit) || isDigit(chars[i + 4])) {
        fail('AMBIGUOUS_FORMAT', 'comma is not a valid thousands separator here');
      }
      whole += group.join('');
      i += 4;
    }
  }
  let fraction: string | null = null;
  if (chars[i] === '.') {
    i++;
    fraction = '';
    while (isDigit(chars[i])) fraction += chars[i++];
  }
  if (chars[i] === ',' || (fraction !== null && chars[i] === '.')) {
    fail('AMBIGUOUS_FORMAT', 'number has an ambiguous separator');
  }
  emit(whole, fraction);
  return i;
}

/**
 * A superscript run is an exponent ("10⁻²"), unless it is followed by a fraction slash and a
 * subscript run, in which case it is a stacked fraction glyph ("¹\u2044₂").
 */
function scanSuperscript(
  chars: readonly string[],
  start: number,
  push: (token: Token) => void,
  spaceBefore: boolean,
): number {
  let i = start;
  let run = '';
  while (chars[i] !== undefined && SUPERSCRIPTS.has(chars[i]!))
    run += SUPERSCRIPTS.get(chars[i++]!);
  const slash = chars[i];
  if (slash !== undefined && FRACTION_SLASHES.has(slash) && SUBSCRIPTS.has(chars[i + 1] ?? '')) {
    let den = '';
    i++;
    while (chars[i] !== undefined && SUBSCRIPTS.has(chars[i]!)) den += SUBSCRIPTS.get(chars[i++]!);
    if (!/^\d+$/.test(run)) fail('INVALID_SYNTAX', 'malformed stacked fraction');
    push({ kind: 'vulgar', num: BigInt(run), den: BigInt(den), spaceBefore });
    return i;
  }
  if (!/^[+-]?\d+$/.test(run)) fail('INVALID_SYNTAX', 'malformed superscript exponent');
  push({ kind: 'superscript', exponent: BigInt(run), spaceBefore });
  return i;
}

// ---------------------------------------------------------------------------------------------
// Parser / evaluator
// ---------------------------------------------------------------------------------------------

type NodeKind =
  | 'integer'
  | 'decimal'
  | 'fraction'
  | 'mixed'
  | 'percent'
  | 'signed'
  | 'group'
  | 'power'
  | 'binary';

interface Node {
  readonly kind: NodeKind;
  readonly value: Rational;
  readonly form: AnswerForm;
}

const EXPRESSION_FORM: AnswerForm = { kind: 'expression', reduced: false };
const SINGLE_NUMBER_KINDS: ReadonlySet<AnswerFormKind> = new Set([
  'integer',
  'decimal',
  'fraction',
  'mixed_number',
  'percent',
]);

function bigAbs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = bigAbs(a);
  let y = bigAbs(b);
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

function bounded(value: Rational): Rational {
  if (bigAbs(value.num) >= MAGNITUDE_LIMIT || value.den >= MAGNITUDE_LIMIT) {
    fail('RESULT_TOO_LARGE', `value exceeds ${MAX_RESULT_DIGITS} digits`);
  }
  return value;
}

function isIntegerLiteral(token: Token | undefined): token is Extract<Token, { kind: 'number' }> {
  return token?.kind === 'number' && token.fraction === null;
}

function isOp(token: Token | undefined, ...ops: OperatorSymbol[]): boolean {
  return token?.kind === 'op' && ops.includes(token.op);
}

function literalValue(token: Extract<Token, { kind: 'number' }>): Rational {
  const digits = `${token.whole}${token.fraction ?? ''}`;
  if (digits.length > MAX_RESULT_DIGITS * 2) fail('RESULT_TOO_LARGE', 'number literal too long');
  const scale = 10n ** BigInt(token.fraction?.length ?? 0);
  return bounded(rational(BigInt(digits === '' ? '0' : digits), scale));
}

function fractionNode(num: bigint, den: bigint): Node {
  if (den === 0n) fail('DIVISION_BY_ZERO', 'fraction has a zero denominator');
  return {
    kind: 'fraction',
    value: bounded(rational(num, den)),
    form: { kind: 'fraction', reduced: den > 1n && gcd(num, den) === 1n },
  };
}

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly options: ParseOptions,
  ) {}

  parse(): Node {
    const node = this.expression(0);
    const rest = this.tokens[this.pos];
    if (rest !== undefined) {
      // Decision: juxtaposition ("2 3", "2(3)", "1/2 1/2", "1 000") may be a list, an SI-spaced
      // number or implicit multiplication; only the mixed-number forms are accepted.
      if (rest.kind === 'number' || rest.kind === 'vulgar' || isOp(rest, '(')) {
        fail('AMBIGUOUS_FORMAT', 'values written side by side without an operator');
      }
      fail('INVALID_SYNTAX', 'unexpected symbol');
    }
    return node;
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  private next(): Token {
    const token = this.tokens[this.pos++];
    if (token === undefined) fail('INVALID_SYNTAX', 'answer ends unexpectedly');
    return token;
  }

  private expression(depth: number): Node {
    let left = this.term(depth);
    for (;;) {
      const token = this.peek();
      if (token?.kind !== 'op' || (token.op !== '+' && token.op !== '-')) return left;
      if (token.op === '-') this.rejectHyphenatedMixedNumber();
      this.pos++;
      const right = this.term(depth);
      const value =
        token.op === '+'
          ? addRational(left.value, right.value)
          : subtractRational(left.value, right.value);
      left = { kind: 'binary', value: bounded(value), form: EXPRESSION_FORM };
    }
  }

  /**
   * Decision: "2-1/2" (no spaces) is how many people write the mixed number 2½, but as an
   * expression it is 3/2. The two readings differ, so it is AMBIGUOUS_FORMAT, never guessed.
   */
  private rejectHyphenatedMixedNumber(): void {
    const minus = this.peek();
    const before = this.tokens[this.pos - 1];
    const numerator = this.peek(1);
    if (
      isIntegerLiteral(before) &&
      minus !== undefined &&
      !minus.spaceBefore &&
      isIntegerLiteral(numerator) &&
      !numerator.spaceBefore &&
      isOp(this.peek(2), '/') &&
      isIntegerLiteral(this.peek(3))
    ) {
      fail('AMBIGUOUS_FORMAT', 'hyphenated mixed number');
    }
  }

  private term(depth: number): Node {
    let left = this.unary(depth, true);
    for (;;) {
      const token = this.peek();
      if (token?.kind !== 'op' || (token.op !== '*' && token.op !== '/' && token.op !== '÷')) {
        return left;
      }
      this.pos++;
      // A mixed number may be a factor ("3 × 2 1/2") but not a divisor ("1/2 1/2" is ambiguous).
      const right = this.unary(depth, token.op === '*');
      if (token.op === '*') {
        left = {
          kind: 'binary',
          value: bounded(multiplyRational(left.value, right.value)),
          form: EXPRESSION_FORM,
        };
        continue;
      }
      if (right.value.num === 0n) fail('DIVISION_BY_ZERO', 'division by zero');
      left = {
        kind: 'binary',
        value: bounded(divideRational(left.value, right.value)),
        form: token.op === '/' ? writtenFractionForm(left, right) : EXPRESSION_FORM,
      };
    }
  }

  private unary(depth: number, allowMixed: boolean): Node {
    if (depth >= MAX_NESTING_DEPTH) fail('TOO_COMPLEX', 'answer is nested too deeply');
    const token = this.peek();
    if (token?.kind === 'op' && (token.op === '-' || token.op === '+')) {
      this.pos++;
      const operand = this.unary(depth + 1, allowMixed);
      // Decision: "-2^2" is -4 in algebra but 4 in spreadsheets; never guess.
      if (token.op === '-' && operand.kind === 'power') {
        fail('AMBIGUOUS_FORMAT', 'minus sign before an unparenthesized power');
      }
      const singleNumber = operand.kind !== 'signed' && SINGLE_NUMBER_KINDS.has(operand.form.kind);
      return {
        kind: 'signed',
        value: token.op === '-' ? negateRational(operand.value) : operand.value,
        form: singleNumber ? operand.form : EXPRESSION_FORM,
      };
    }
    return this.power(depth, allowMixed);
  }

  private power(depth: number, allowMixed: boolean): Node {
    const base = this.postfix(depth, allowMixed);
    const token = this.peek();
    let exponent: Rational;
    if (isOp(token, '^')) {
      this.pos++;
      const node = this.unary(depth + 1, false);
      // Decision: "2^3^2" is 512 by the math convention but 64 in many calculators; never guess.
      if (node.kind === 'power') fail('AMBIGUOUS_FORMAT', 'chained exponents need parentheses');
      exponent = node.value;
    } else if (token?.kind === 'superscript') {
      this.pos++;
      exponent = rational(token.exponent);
    } else {
      return base;
    }
    if (base.kind === 'mixed' || base.kind === 'percent') {
      fail('AMBIGUOUS_FORMAT', 'exponent on a mixed number or percent');
    }
    const after = this.peek();
    if (isOp(after, '^') || after?.kind === 'superscript') {
      fail('AMBIGUOUS_FORMAT', 'chained exponents need parentheses');
    }
    return { kind: 'power', value: applyPower(base.value, exponent), form: EXPRESSION_FORM };
  }

  private postfix(depth: number, allowMixed: boolean): Node {
    const node = this.primary(depth, allowMixed);
    if (!isOp(this.peek(), '%')) return node;
    this.pos++;
    if (this.options.percent === 'reject') {
      fail('UNSUPPORTED_EXPRESSION', 'percent notation is not accepted here');
    }
    if (node.kind === 'mixed') fail('AMBIGUOUS_FORMAT', 'percent applied to a mixed number');
    const literal = node.kind === 'integer' || node.kind === 'decimal';
    return {
      kind: 'percent',
      value: bounded(divideRational(node.value, rational(100n))),
      form: literal ? { kind: 'percent', reduced: true } : EXPRESSION_FORM,
    };
  }

  private primary(depth: number, allowMixed: boolean): Node {
    const token = this.next();
    switch (token.kind) {
      case 'number': {
        const value = literalValue(token);
        if (token.fraction === null && allowMixed) {
          const mixed = this.mixedNumber(value);
          if (mixed !== null) return mixed;
        }
        return {
          kind: token.fraction === null ? 'integer' : 'decimal',
          value,
          form: { kind: token.fraction === null ? 'integer' : 'decimal', reduced: true },
        };
      }
      case 'vulgar':
        return fractionNode(token.num, token.den);
      case 'superscript':
        return fail('INVALID_SYNTAX', 'exponent without a base');
      case 'op': {
        if (token.op !== '(') return fail('INVALID_SYNTAX', 'unexpected operator');
        const inner = this.expression(depth + 1);
        if (!isOp(this.peek(), ')')) fail('INVALID_SYNTAX', 'missing closing parenthesis');
        this.pos++;
        return { kind: 'group', value: inner.value, form: inner.form };
      }
    }
  }

  /**
   * Mixed numbers: whole number, whitespace, then a/b ("2 1/2"), or a whole number followed by a
   * fraction glyph ("2½", "2 ½", "2¹\u2044₂"). Returns null when the tokens are not a mixed number.
   */
  private mixedNumber(whole: Rational): Node | null {
    const first = this.peek();
    let num: bigint;
    let den: bigint;
    if (
      isIntegerLiteral(first) &&
      first.spaceBefore &&
      isOp(this.peek(1), '/') &&
      isIntegerLiteral(this.peek(2))
    ) {
      num = literalValue(first).num;
      den = literalValue(this.peek(2) as Extract<Token, { kind: 'number' }>).num;
      this.pos += 3;
    } else if (first?.kind === 'vulgar') {
      num = first.num;
      den = first.den;
      this.pos += 1;
    } else {
      return null;
    }
    if (den === 0n) fail('DIVISION_BY_ZERO', 'fraction has a zero denominator');
    const after = this.peek();
    if (isOp(after, '^', '%', '/', '÷') || after?.kind === 'superscript') {
      fail('AMBIGUOUS_FORMAT', 'operator applied to a mixed number');
    }
    return {
      kind: 'mixed',
      value: bounded(addRational(whole, rational(num, den))),
      form: {
        kind: 'mixed_number',
        reduced: whole.num > 0n && num > 0n && num < den && gcd(num, den) === 1n,
      },
    };
  }
}

/** "a/b" written with integer literals (optionally a signed numerator) is a fraction. */
function writtenFractionForm(left: Node, right: Node): AnswerForm {
  const numeratorIsInteger =
    left.kind === 'integer' || (left.kind === 'signed' && left.form.kind === 'integer');
  if (!numeratorIsInteger || right.kind !== 'integer') return EXPRESSION_FORM;
  return {
    kind: 'fraction',
    reduced: right.value.num > 1n && gcd(left.value.num, right.value.num) === 1n,
  };
}

function applyPower(base: Rational, exponent: Rational): Rational {
  if (!isIntegerRational(exponent)) fail('UNSUPPORTED_EXPRESSION', 'exponent must be an integer');
  if (bigAbs(exponent.num) > BigInt(MAX_EXPONENT)) {
    fail('EXPONENT_OUT_OF_RANGE', `exponent must be between -${MAX_EXPONENT} and ${MAX_EXPONENT}`);
  }
  const e = Number(exponent.num);
  if (base.num === 0n) {
    if (e === 0) fail('UNSUPPORTED_EXPRESSION', 'zero to the power zero is undefined');
    if (e < 0) fail('DIVISION_BY_ZERO', 'zero raised to a negative power');
  }
  return bounded(powRational(base, e));
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/**
 * Parses a student's (or answer key's) numeric answer into an exact value plus a description of
 * how it was written. Never throws for any input string; error messages never echo the input.
 */
export function parseMathAnswerDetailed(
  text: string,
  options: ParseOptions = {},
): Result<ParsedAnswer, ParseErrorCode> {
  if (text.length > MAX_ANSWER_LENGTH) {
    return err('INPUT_TOO_LONG', `answer exceeds ${MAX_ANSWER_LENGTH} characters`);
  }
  const normalized = stripInvisible(normalizeMathText(text));
  if (normalized.length > MAX_ANSWER_LENGTH) {
    return err('INPUT_TOO_LONG', `answer exceeds ${MAX_ANSWER_LENGTH} characters`);
  }
  // Decision: one leading "=" ("= 7") is dropped; any other "=" is an equation (unsupported).
  const body = normalized.trim().replace(/^=/, '').trim();
  if (body === '') return err('EMPTY_INPUT', 'answer is empty');
  try {
    const tokens = tokenize(body);
    if (tokens.length === 0) return err('EMPTY_INPUT', 'answer is empty');
    const node = new Parser(tokens, options).parse();
    return ok({ value: node.value, form: node.form });
  } catch (error) {
    if (error instanceof ParseFailure) return err(error.code, error.message);
    throw error;
  }
}

/** Parses a numeric answer to an exact rational. See parseMathAnswerDetailed. */
export function parseMathAnswer(
  text: string,
  options: ParseOptions = {},
): Result<Rational, ParseErrorCode> {
  const result = parseMathAnswerDetailed(text, options);
  return result.ok ? ok(result.value.value) : result;
}
