// Extracts every number representation from canonical (lowercase) text as an exact rational.
// Spec P5/P6: deterministic safe parsers, never eval. Text is data; nothing here executes it.
//
// Decision: extraction is deliberately over-inclusive (fail closed). Ambiguous notations yield
// every plausible reading ("1,500" -> 1500 and 1.5; "1.500" -> 1.5 and 1500) and component digits
// are read too ("3/4" -> 3/4, 3 and 4). A false match blocks a packet (safe template fallback); a
// missed match leaks an answer.

import { add, divide, multiply, pow10, rational, type Rational } from './rational.ts';

export type NumericReading =
  | 'integer'
  | 'decimal'
  | 'thousands'
  | 'alt_locale'
  | 'repeating'
  | 'fraction'
  | 'mixed'
  | 'percent'
  | 'latex'
  | 'over'
  | 'scaled'
  | 'words'
  | 'place_value';

export interface NumericMention {
  readonly value: Rational;
  /** Offsets in the canonical text passed to extractNumericMentions. */
  readonly start: number;
  readonly end: number;
  readonly reading: NumericReading;
  /** Decimal places written, for rounding comparison; null when not a decimal literal. */
  readonly decimalPlaces: number | null;
}

/** Running last list number per marker style, shared across the strings of one packet. */
export type MarkerState = Map<string, number>;

export interface ExtractOptions {
  readonly markerState?: MarkerState;
  /** Mask structural list markers first (default true). Off for parsing an answer value. */
  readonly maskMarkers?: boolean;
}

export interface ExtractResult {
  readonly mentions: readonly NumericMention[];
  /** Canonical text with structural list-marker digits replaced by spaces (same offsets). */
  readonly masked: string;
}

const MAX_DIGITS = 40;

/**
 * Own-property table lookup. Tokens come from untrusted text, so a word such as "constructor"
 * must never resolve to an Object.prototype member (regression: it crashed BigInt conversion).
 */
function lookup<T>(table: Readonly<Record<string, T>>, key: string | undefined): T | undefined {
  return key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}
const NUM = String.raw`(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)`;

interface Literal {
  readonly value: Rational;
  readonly places: number;
}

/** Parses an English-style numeric literal ("1,500.25", ".5", "12"). */
function parseLiteral(raw: string): Literal | null {
  const cleaned = raw.replace(/,/g, '');
  const m = /^(\d*)(?:\.(\d+))?$/.exec(cleaned);
  if (m === null) return null;
  const intPart = m[1] ?? '';
  const fracPart = m[2] ?? '';
  if (intPart === '' && fracPart === '') return null;
  if (intPart.length + fracPart.length > MAX_DIGITS) return null;
  const num = BigInt(`${intPart === '' ? '0' : intPart}${fracPart}`);
  return { value: rational(num, pow10(fracPart.length)), places: fracPart.length };
}

// ---------------------------------------------------------------------------------------------
// Structural list markers
// ---------------------------------------------------------------------------------------------

const MARKER_WORDS: Readonly<Record<string, string>> = {
  step: 'step',
  paso: 'step',
  part: 'part',
  parte: 'part',
  question: 'question',
  pregunta: 'question',
  problem: 'problem',
  problema: 'problem',
};

const MARKER_RE =
  /^(?:[-*\u2022\u00B7>]\s*)?(?:(step|paso|part|parte|question|pregunta|problem|problema)\s*#?\s*(\d{1,2})\s*(?:[:.)-]|$)|\((\d{1,2})\)|(\d{1,2})([.)])(?=\s|$))/u;

/**
 * Decision: a line-start marker ("1.", "1)", "(1)", "Step 1:", "Paso 1:", "Question 1:") is
 * structural only when it continues a sequence: its number is 1, or one more than the previous
 * marker of the same style. A lone "7." or "Step 7:" is therefore still treated as a number, so a
 * list marker cannot be used to smuggle the value. Numbers inside a sentence are never structural.
 */
function maskStructuralMarkers(text: string, state: MarkerState): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const m = MARKER_RE.exec(line);
    if (m === null) {
      out.push(line);
      continue;
    }
    const word = m[1];
    const digits = m[2] ?? m[3] ?? m[4] ?? '';
    const style =
      word !== undefined
        ? `word:${lookup(MARKER_WORDS, word) ?? word}`
        : m[3] !== undefined
          ? 'paren'
          : `suffix:${m[5] ?? ''}`;
    const n = Number(digits);
    const previous = state.get(style) ?? 0;
    if (n === 1 || n === previous + 1) {
      state.set(style, n);
      const at = m.index + m[0].indexOf(digits, word === undefined ? 0 : word.length);
      out.push(line.slice(0, at) + ' '.repeat(digits.length) + line.slice(at + digits.length));
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Digit-based notations
// ---------------------------------------------------------------------------------------------

function push(
  out: NumericMention[],
  value: Rational | null,
  start: number,
  end: number,
  reading: NumericReading,
  decimalPlaces: number | null = null,
): void {
  if (value === null) return;
  out.push({ value, start, end, reading, decimalPlaces });
}

function fractionOf(n: Literal | null, d: Literal | null): Rational | null {
  if (n === null || d === null) return null;
  return divide(n.value, d.value);
}

const LATEX_FRAC_RE = new RegExp(
  String.raw`(?<!\d)(?:(\d+)\s*)?\\[dt]?frac\s*(?:\{\s*(${NUM})\s*\}|(\d))\s*(?:\{\s*(${NUM})\s*\}|(\d))`,
  'gu',
);
const OVER_RE = new RegExp(
  String.raw`(?<![\d.])(${NUM})\s*(?:\\over|over|out of|de cada|sobre)\s*(${NUM})(?!\d)`,
  'gu',
);
const MIXED_RE = /(?<![\d.,/])(\d+)(?:\s+|-|\s+(?:and|y)\s+)(\d+)\s*\/\s*(\d+)(?![\d/])/gu;
const FRACTION_RE = new RegExp(String.raw`(?<![\d.])(${NUM})\s*\/\s*(${NUM})(?!\d)`, 'gu');
const PERCENT_RE = new RegExp(
  String.raw`(?<![\d.])(${NUM})\s*(?:%|\\%|percent\b|per cent\b|pct\b|por ?ciento\b)`,
  'gu',
);
const SCALE_RE = new RegExp(
  String.raw`(?<![\d.])(${NUM})\s*(hundred|thousand|million|billion|mil|millon|millones|dozen|docenas?)\b`,
  'gu',
);
const EN_THOUSANDS_RE = /(?<![\d.,])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?!\d)/gu;
const ES_THOUSANDS_RE = /(?<![\d.,])(\d{1,3}(?:\.\d{3})+)(?:,(\d+))?(?!\d)/gu;
const SPACE_THOUSANDS_RE = /(?<![\d.,])(\d{1,3}(?: \d{3})+)(?:[.,](\d+))?(?![\d]| \d)/gu;
const DECIMAL_COMMA_RE = /(?<![\d.,])(\d+),(\d+)(?!\d|,\d)/gu;
const DECIMAL_RE = /(?<![\d.])(\d*\.\d+)(?!\d)(\s*(?:\.\.\.|\u2026|repeating\b|periodico\b))?/gu;
const INTEGER_RE = /(?<!\d)(?<!\d\.)\d+(?!\d)(?!\.\d)/gu;

const SCALE_VALUES: Readonly<Record<string, bigint>> = {
  hundred: 100n,
  thousand: 1000n,
  million: 1_000_000n,
  billion: 1_000_000_000n,
  mil: 1000n,
  millon: 1_000_000n,
  millones: 1_000_000n,
  dozen: 12n,
  docena: 12n,
  docenas: 12n,
};

function repeatingReadings(literal: string, out: NumericMention[], start: number, end: number) {
  const fracPart = literal.split('.')[1] ?? '';
  if (fracPart.length === 0 || fracPart.length > 20) return;
  const base = parseLiteral(literal);
  if (base === null) return;
  for (let m = 1; m <= Math.min(fracPart.length, 6); m++) {
    const repetend = BigInt(fracPart.slice(-m));
    const tail = rational(repetend, pow10(fracPart.length) * (pow10(m) - 1n));
    push(out, add(base.value, tail), start, end, 'repeating');
  }
}

function extractDigitNotations(t: string, out: NumericMention[]): void {
  for (const m of t.matchAll(LATEX_FRAC_RE)) {
    const whole = m[1];
    const n = parseLiteral(m[2] ?? m[3] ?? '');
    const d = parseLiteral(m[4] ?? m[5] ?? '');
    const frac = fractionOf(n, d);
    const fracStart = m.index + (whole === undefined ? 0 : m[0].indexOf('\\'));
    push(out, frac, fracStart, m.index + m[0].length, 'latex');
    if (whole !== undefined && frac !== null) {
      const w = parseLiteral(whole);
      if (w !== null) push(out, add(w.value, frac), m.index, m.index + m[0].length, 'mixed');
    }
  }
  for (const m of t.matchAll(OVER_RE)) {
    push(
      out,
      fractionOf(parseLiteral(m[1] ?? ''), parseLiteral(m[2] ?? '')),
      m.index,
      m.index + m[0].length,
      'over',
    );
  }
  for (const m of t.matchAll(MIXED_RE)) {
    const w = parseLiteral(m[1] ?? '');
    const frac = fractionOf(parseLiteral(m[2] ?? ''), parseLiteral(m[3] ?? ''));
    if (w !== null && frac !== null) {
      push(out, add(w.value, frac), m.index, m.index + m[0].length, 'mixed');
    }
  }
  for (const m of t.matchAll(FRACTION_RE)) {
    push(
      out,
      fractionOf(parseLiteral(m[1] ?? ''), parseLiteral(m[2] ?? '')),
      m.index,
      m.index + m[0].length,
      'fraction',
    );
  }
  for (const m of t.matchAll(PERCENT_RE)) {
    const lit = parseLiteral(m[1] ?? '');
    if (lit === null) continue;
    push(
      out,
      divide(lit.value, rational(100n)),
      m.index,
      m.index + m[0].length,
      'percent',
      lit.places + 2,
    );
  }
  for (const m of t.matchAll(SCALE_RE)) {
    const lit = parseLiteral(m[1] ?? '');
    const scale = lookup(SCALE_VALUES, m[2]);
    if (lit === null || scale === undefined) continue;
    push(out, multiply(lit.value, rational(scale)), m.index, m.index + m[0].length, 'scaled');
  }
  for (const m of t.matchAll(EN_THOUSANDS_RE)) {
    const lit = parseLiteral(m[0]);
    if (lit !== null) push(out, lit.value, m.index, m.index + m[0].length, 'thousands', lit.places);
  }
  for (const m of t.matchAll(ES_THOUSANDS_RE)) {
    const lit = parseLiteral(
      `${(m[1] ?? '').replace(/\./g, '')}${m[2] === undefined ? '' : `.${m[2]}`}`,
    );
    if (lit !== null)
      push(out, lit.value, m.index, m.index + m[0].length, 'alt_locale', lit.places);
  }
  for (const m of t.matchAll(SPACE_THOUSANDS_RE)) {
    const lit = parseLiteral(
      `${(m[1] ?? '').replace(/ /g, '')}${m[2] === undefined ? '' : `.${m[2]}`}`,
    );
    if (lit !== null)
      push(out, lit.value, m.index, m.index + m[0].length, 'alt_locale', lit.places);
  }
  for (const m of t.matchAll(DECIMAL_COMMA_RE)) {
    const lit = parseLiteral(`${m[1] ?? ''}.${m[2] ?? ''}`);
    if (lit !== null)
      push(out, lit.value, m.index, m.index + m[0].length, 'alt_locale', lit.places);
  }
  for (const m of t.matchAll(DECIMAL_RE)) {
    const literal = m[1] ?? '';
    const lit = parseLiteral(literal);
    const end = m.index + literal.length;
    if (lit !== null) push(out, lit.value, m.index, end, 'decimal', lit.places);
    if (m[2] !== undefined) repeatingReadings(literal, out, m.index, m.index + m[0].length);
  }
  for (const m of t.matchAll(INTEGER_RE)) {
    const lit = parseLiteral(m[0]);
    if (lit !== null) push(out, lit.value, m.index, m.index + m[0].length, 'integer', 0);
  }
}

// ---------------------------------------------------------------------------------------------
// Number words (English up to billions; Spanish 0-100, "ciento", "mil")
// ---------------------------------------------------------------------------------------------

const EN_SMALL: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const EN_TENS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fourty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const EN_SCALES: Readonly<Record<string, bigint>> = {
  thousand: 1000n,
  million: 1_000_000n,
  billion: 1_000_000_000n,
};
const ES_SMALL: Readonly<Record<string, number>> = {
  cero: 0,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiuno: 21,
  veintiun: 21,
  veintiuna: 21,
  veintidos: 22,
  veintitres: 23,
  veinticuatro: 24,
  veinticinco: 25,
  veintiseis: 26,
  veintisiete: 27,
  veintiocho: 28,
  veintinueve: 29,
};
const ES_TENS: Readonly<Record<string, number>> = {
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
};
/** Denominator words (singular and plural). "second" is excluded: it is overwhelmingly time. */
const DENOMINATORS: Readonly<Record<string, number>> = {
  half: 2,
  halves: 2,
  third: 3,
  thirds: 3,
  fourth: 4,
  fourths: 4,
  quarter: 4,
  quarters: 4,
  fifth: 5,
  fifths: 5,
  sixth: 6,
  sixths: 6,
  seventh: 7,
  sevenths: 7,
  eighth: 8,
  eighths: 8,
  ninth: 9,
  ninths: 9,
  tenth: 10,
  tenths: 10,
  eleventh: 11,
  elevenths: 11,
  twelfth: 12,
  twelfths: 12,
  thirteenth: 13,
  thirteenths: 13,
  fourteenth: 14,
  fourteenths: 14,
  fifteenth: 15,
  fifteenths: 15,
  sixteenth: 16,
  sixteenths: 16,
  seventeenth: 17,
  seventeenths: 17,
  eighteenth: 18,
  eighteenths: 18,
  nineteenth: 19,
  nineteenths: 19,
  twentieth: 20,
  twentieths: 20,
  thirtieth: 30,
  thirtieths: 30,
  fortieth: 40,
  fortieths: 40,
  fiftieth: 50,
  fiftieths: 50,
  sixtieth: 60,
  sixtieths: 60,
  seventieth: 70,
  seventieths: 70,
  eightieth: 80,
  eightieths: 80,
  ninetieth: 90,
  ninetieths: 90,
  hundredth: 100,
  hundredths: 100,
  thousandth: 1000,
  thousandths: 1000,
  millionth: 1_000_000,
  millionths: 1_000_000,
  // Spanish
  medio: 2,
  media: 2,
  medios: 2,
  medias: 2,
  tercio: 3,
  tercios: 3,
  cuarto: 4,
  cuartos: 4,
  quinto: 5,
  quintos: 5,
  sexto: 6,
  sextos: 6,
  septimo: 7,
  septimos: 7,
  setimo: 7,
  setimos: 7,
  octavo: 8,
  octavos: 8,
  noveno: 9,
  novenos: 9,
  decimo: 10,
  decimos: 10,
  onceavo: 11,
  onceavos: 11,
  doceavo: 12,
  doceavos: 12,
  treceavo: 13,
  treceavos: 13,
  quinceavo: 15,
  quinceavos: 15,
  veinteavo: 20,
  veinteavos: 20,
  centesimo: 100,
  centesimos: 100,
  milesimo: 1000,
  milesimos: 1000,
};
/** Unit ordinals usable after a tens word ("twenty-fifths"). */
const UNIT_ORDINALS: Readonly<Record<string, number>> = {
  third: 3,
  thirds: 3,
  fourth: 4,
  fourths: 4,
  fifth: 5,
  fifths: 5,
  sixth: 6,
  sixths: 6,
  seventh: 7,
  sevenths: 7,
  eighth: 8,
  eighths: 8,
  ninth: 9,
  ninths: 9,
};
const ONE_ARTICLES = new Set(['a', 'an', 'un', 'una']);
const DIGIT_WORDS: Readonly<Record<string, string>> = {
  zero: '0',
  oh: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  cero: '0',
  uno: '1',
  dos: '2',
  tres: '3',
  cuatro: '4',
  cinco: '5',
  seis: '6',
  siete: '7',
  ocho: '8',
  nueve: '9',
};

/**
 * Decision: Spanish "once" (11) collides with the common English word. It is read as 11 only
 * when the text contains at least one Spanish function word; everything else Spanish is always
 * read. Documented limitation: "once" alone in otherwise English text is not read as 11.
 */
const SPANISH_MARKER_RE =
  /(?<![\p{L}\p{N}])(?:el|la|los|las|es|son|que|del|una|uno|por|para|con|pero|respuesta|hay|tiene|cuantos|cuantas|esta|muy|bien)(?![\p{L}\p{N}])/u;

interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly digit: boolean;
}

interface Parsed {
  readonly value: Rational;
  readonly next: number;
}

class WordNumberParser {
  private readonly linked: boolean[];

  constructor(
    private readonly toks: readonly Token[],
    source: string,
    private readonly spanish: boolean,
  ) {
    this.linked = toks.map((tok, i) => {
      if (i === 0) return false;
      const prev = toks[i - 1];
      return prev !== undefined && /^[\s-]+$/u.test(source.slice(prev.end, tok.start));
    });
  }

  /** Token text at i, provided it is joined to token i-1 by spaces/hyphens only. */
  private at(i: number): string | undefined {
    return this.linked[i] === true ? this.toks[i]?.text : undefined;
  }

  private first(i: number): string | undefined {
    return this.toks[i]?.text;
  }

  private small(word: string | undefined): number | undefined {
    if (word === undefined) return undefined;
    const en = lookup(EN_SMALL, word);
    if (en !== undefined) return en;
    if (word === 'once' && !this.spanish) return undefined;
    return lookup(ES_SMALL, word);
  }

  private tens(word: string | undefined): number | undefined {
    if (word === undefined) return undefined;
    return lookup(EN_TENS, word) ?? lookup(ES_TENS, word);
  }

  /** 0..99 starting at i, where token i was already checked for linkage by the caller. */
  private belowHundred(word: string | undefined, i: number): Parsed | null {
    const t = this.tens(word);
    if (t !== undefined) {
      const nextTok = this.toks[i + 1];
      // "forty-2": a tens word joined to a single digit.
      if (this.linked[i + 1] === true && nextTok?.digit === true && /^[1-9]$/u.test(nextTok.text)) {
        return { value: rational(BigInt(t + Number(nextTok.text))), next: i + 2 };
      }
      const nextWord = this.at(i + 1);
      const unitEn = lookup(EN_SMALL, nextWord);
      if (
        lookup(EN_TENS, word) !== undefined &&
        unitEn !== undefined &&
        unitEn >= 1 &&
        unitEn <= 9
      ) {
        return { value: rational(BigInt(t + unitEn)), next: i + 2 };
      }
      if (lookup(ES_TENS, word) !== undefined && nextWord === 'y') {
        const unitEs = this.small(this.at(i + 2));
        if (unitEs !== undefined && unitEs >= 1 && unitEs <= 9) {
          return { value: rational(BigInt(t + unitEs)), next: i + 3 };
        }
      }
      return { value: rational(BigInt(t)), next: i + 1 };
    }
    const s = this.small(word);
    if (s !== undefined) return { value: rational(BigInt(s)), next: i + 1 };
    return null;
  }

  /** 0..999 (English "hundred", Spanish "cien"/"ciento"). */
  private belowThousand(word: string | undefined, i: number): Parsed | null {
    if (word === 'cien') return { value: rational(100n), next: i + 1 };
    if (word === 'ciento') {
      const rest = this.belowHundred(this.at(i + 1), i + 1);
      return rest === null
        ? { value: rational(100n), next: i + 1 }
        : { value: add(rational(100n), rest.value), next: rest.next };
    }
    let head: Parsed | null;
    if (word !== undefined && (word === 'a' || word === 'an') && this.at(i + 1) === 'hundred') {
      head = { value: rational(1n), next: i + 1 };
    } else {
      head = this.belowHundred(word, i);
    }
    if (head === null) return null;
    if (this.at(head.next) === 'hundred' && head.value.num >= 1n && head.value.num <= 99n) {
      let value = multiply(head.value, rational(100n));
      let next = head.next + 1;
      const afterAnd = this.at(next) === 'and' ? next + 1 : next;
      const rest = this.belowHundred(this.at(afterAnd), afterAnd);
      if (rest !== null) {
        value = add(value, rest.value);
        next = rest.next;
      }
      return { value, next };
    }
    if (word === 'a' || word === 'an') return null;
    return head;
  }

  /** Full cardinal starting at token i (token i itself need not be linked). */
  cardinal(i: number): Parsed | null {
    let total = rational(0n);
    let j = i;
    let word = this.first(i);
    let lastScale = Number.POSITIVE_INFINITY;
    let matched = false;
    for (;;) {
      let group = this.belowThousand(word, j);
      if (group === null && word !== undefined && ONE_ARTICLES.has(word)) {
        const scaleWord = this.at(j + 1);
        if (
          scaleWord !== undefined &&
          (lookup(EN_SCALES, scaleWord) !== undefined || scaleWord === 'mil')
        ) {
          group = { value: rational(1n), next: j + 1 };
        }
      }
      if (group === null && word === 'mil' && lastScale > 1000) {
        // Spanish "mil" on its own is 1000 ("mil" never takes an article).
        total = add(total, rational(1000n));
        lastScale = 1000;
        matched = true;
        j += 1;
        word = this.at(j);
        if (word === undefined || this.belowThousand(word, j) === null) break;
        continue;
      }
      if (group === null) break;
      const scaleWord = this.at(group.next);
      const scale =
        scaleWord === undefined
          ? undefined
          : (lookup(EN_SCALES, scaleWord) ?? (scaleWord === 'mil' ? 1000n : undefined));
      if (scale !== undefined && Number(scale) < lastScale) {
        total = add(total, multiply(group.value, rational(scale)));
        lastScale = Number(scale);
        matched = true;
        j = group.next + 1;
        const maybeAnd = this.at(j) === 'and' ? j + 1 : j;
        word = this.at(maybeAnd);
        if (word === undefined) break;
        const probe = this.belowThousand(word, maybeAnd);
        if (probe === null) break;
        j = maybeAnd;
        continue;
      }
      total = add(total, group.value);
      matched = true;
      j = group.next;
      break;
    }
    return matched ? { value: total, next: j } : null;
  }

  /** Denominator word at i (linked), including "twenty-fifths". */
  private denominator(i: number): { value: number; next: number } | null {
    const word = this.at(i);
    if (word === undefined) return null;
    const tens = lookup(EN_TENS, word);
    const unitOrdinal = lookup(UNIT_ORDINALS, this.at(i + 1));
    if (tens !== undefined && unitOrdinal !== undefined)
      return { value: tens + unitOrdinal, next: i + 2 };
    const d = lookup(DENOMINATORS, word);
    return d === undefined ? null : { value: d, next: i + 1 };
  }

  /** "a half", "three quarters", "un medio", "3 fourths" starting at i. */
  private fractionPhrase(i: number, requireLinkAtStart: boolean): Parsed | null {
    const word = requireLinkAtStart ? this.at(i) : this.first(i);
    if (word === undefined) return null;
    // Bare "medio"/"media" only after "y"/"and" ("dos y medio"); alone they mean middle/media.
    if (requireLinkAtStart && ['half', 'medio', 'media', 'mitad'].includes(word)) {
      return { value: rational(1n, 2n), next: i + 1 };
    }
    let numerator: Parsed | null;
    if (ONE_ARTICLES.has(word)) numerator = { value: rational(1n), next: i + 1 };
    else if (this.toks[i]?.digit === true) {
      const lit = BigInt(word);
      numerator = { value: rational(lit), next: i + 1 };
    } else numerator = this.cardinal(i);
    if (numerator === null) return null;
    const d = this.denominator(numerator.next);
    if (d === null) return null;
    return { value: multiply(numerator.value, rational(1n, BigInt(d.value))), next: d.next };
  }

  private digitString(i: number): { digits: string; next: number } | null {
    let digits = '';
    let j = i;
    for (;;) {
      const w = this.at(j);
      const d = lookup(DIGIT_WORDS, w);
      if (d === undefined) break;
      digits += d;
      j += 1;
    }
    if (digits !== '') return { digits, next: j };
    const word = this.at(i);
    const two = this.belowHundred(word, i);
    if (two === null || word === undefined) return null;
    return { digits: two.value.num.toString(), next: two.next };
  }

  /** Longest number phrase starting at token i, plus component readings. */
  phraseAt(i: number): { readings: Parsed[]; next: number } | null {
    const word = this.first(i);
    if (word === undefined) return null;
    const tok = this.toks[i];
    const isDigit = tok?.digit === true;

    // "point five" with no leading cardinal
    if (word === 'point' || word === 'punto') {
      const frac = this.digitString(i + 1);
      if (frac === null) return null;
      return {
        readings: [
          { value: rational(BigInt(frac.digits), pow10(frac.digits.length)), next: frac.next },
        ],
        next: frac.next,
      };
    }
    if (word === 'half' || word === 'quarter' || word === 'mitad') {
      const value = word === 'quarter' ? rational(1n, 4n) : rational(1n, 2n);
      return { readings: [{ value, next: i + 1 }], next: i + 1 };
    }

    const fraction = this.fractionPhrase(i, false);
    if (fraction !== null) {
      const readings = [fraction];
      const numeratorOnly = isDigit ? null : this.cardinal(i);
      if (numeratorOnly !== null && numeratorOnly.next < fraction.next)
        readings.push(numeratorOnly);
      return { readings, next: fraction.next };
    }

    let numerator: Parsed | null;
    if (isDigit) numerator = { value: rational(BigInt(word)), next: i + 1 };
    else if (ONE_ARTICLES.has(word)) numerator = { value: rational(1n), next: i + 1 };
    else numerator = this.cardinal(i);
    if (numerator === null) return null;

    const next = this.at(numerator.next);
    const readings: Parsed[] = [];
    // mixed: "three and a half", "dos y medio", "2 and 3 quarters"
    if (next === 'and' || next === 'y') {
      const frac = this.fractionPhrase(numerator.next + 1, true);
      if (frac !== null)
        readings.push({ value: add(numerator.value, frac.value), next: frac.next });
    }
    // "three over four", "three out of four"
    const overAt = next === 'over' || next === 'sobre' ? numerator.next + 1 : null;
    const outOfAt =
      (next === 'out' && this.at(numerator.next + 1) === 'of') ||
      (next === 'de' && this.at(numerator.next + 1) === 'cada')
        ? numerator.next + 2
        : null;
    const denomStart = overAt ?? outOfAt;
    if (denomStart !== null && this.linked[denomStart] === true) {
      const den =
        this.toks[denomStart]?.digit === true
          ? { value: rational(BigInt(this.toks[denomStart]?.text ?? '0')), next: denomStart + 1 }
          : this.cardinal(denomStart);
      if (den !== null) {
        const v = divide(numerator.value, den.value);
        if (v !== null) readings.push({ value: v, next: den.next });
      }
    }
    // "two point five", "dos punto cinco", "cero coma cinco"
    if (next === 'point' || next === 'punto' || next === 'coma') {
      const frac = this.digitString(numerator.next + 1);
      if (frac !== null) {
        readings.push({
          value: add(numerator.value, rational(BigInt(frac.digits), pow10(frac.digits.length))),
          next: frac.next,
        });
      }
    }
    // "fifty percent", "cincuenta por ciento"
    if (next === 'percent' || next === 'porciento') {
      readings.push({
        value: multiply(numerator.value, rational(1n, 100n)),
        next: numerator.next + 1,
      });
    } else if (
      (next === 'per' && this.at(numerator.next + 1) === 'cent') ||
      (next === 'por' && this.at(numerator.next + 1) === 'ciento')
    ) {
      readings.push({
        value: multiply(numerator.value, rational(1n, 100n)),
        next: numerator.next + 2,
      });
    }
    // "three dozen"
    if (next === 'dozen' || next === 'docena' || next === 'docenas') {
      readings.push({ value: multiply(numerator.value, rational(12n)), next: numerator.next + 1 });
    }

    if (isDigit || ONE_ARTICLES.has(word)) {
      // Bare digits are read by the digit pass; bare articles are not numbers.
      if (readings.length === 0) return null;
    } else {
      readings.push(numerator);
    }
    const end = Math.max(...readings.map((r) => r.next));
    return { readings, next: end };
  }
}

/** Place-value words: "4 tens and 2 ones", "3 hundreds", "4 decenas y 2 unidades". */
const PLACE_VALUES: Readonly<Record<string, bigint>> = {
  thousands: 1000n,
  hundreds: 100n,
  tens: 10n,
  ten: 10n,
  ones: 1n,
  one: 1n,
  millares: 1000n,
  centenas: 100n,
  centena: 100n,
  decenas: 10n,
  decena: 10n,
  unidades: 1n,
  unidad: 1n,
};
const PLACE_CONNECTORS = new Set(['and', 'y', 'plus', 'mas']);
const PLACE_GAP_RE = /^[\s,+&-]*$/u;

function extractPlaceValues(
  t: string,
  toks: readonly Token[],
  parser: WordNumberParser,
  out: NumericMention[],
): void {
  const gapOk = (k: number): boolean => {
    const prev = toks[k - 1];
    const cur = toks[k];
    return (
      prev !== undefined && cur !== undefined && PLACE_GAP_RE.test(t.slice(prev.end, cur.start))
    );
  };
  const term = (k: number): { value: Rational; next: number } | null => {
    const tok = toks[k];
    if (tok === undefined) return null;
    const count = tok.digit
      ? { value: rational(BigInt(tok.text)), next: k + 1 }
      : parser.cardinal(k);
    if (count === null) return null;
    const place = lookup(PLACE_VALUES, toks[count.next]?.text);
    if (place === undefined || !gapOk(count.next)) return null;
    return { value: multiply(count.value, rational(place)), next: count.next + 1 };
  };
  let i = 0;
  while (i < toks.length) {
    const first = term(i);
    if (first === null) {
      i += 1;
      continue;
    }
    let total = first.value;
    let next = first.next;
    for (;;) {
      let k = next;
      if (k < toks.length && !gapOk(k)) break;
      if (PLACE_CONNECTORS.has(toks[k]?.text ?? '')) {
        k += 1;
        if (!gapOk(k)) break;
      }
      const more = term(k);
      if (more === null) break;
      total = add(total, more.value);
      next = more.next;
    }
    const start = toks[i]?.start ?? 0;
    const end = toks[next - 1]?.end ?? start;
    push(out, total, start, end, 'place_value');
    i = next;
  }
}

function extractWordNumbers(t: string, out: NumericMention[]): void {
  const toks: Token[] = [];
  for (const m of t.matchAll(/[a-z]+|\d+/gu)) {
    if (m[0].length > MAX_DIGITS) continue;
    toks.push({ text: m[0], start: m.index, end: m.index + m[0].length, digit: /^\d/u.test(m[0]) });
  }
  const parser = new WordNumberParser(toks, t, SPANISH_MARKER_RE.test(t));
  let i = 0;
  while (i < toks.length) {
    const phrase = parser.phraseAt(i);
    if (phrase === null) {
      i += 1;
      continue;
    }
    const start = toks[i]?.start ?? 0;
    for (const r of phrase.readings) {
      const endTok = toks[r.next - 1];
      push(out, r.value, start, endTok?.end ?? start, 'words');
    }
    i = Math.max(phrase.next, i + 1);
  }
  extractPlaceValues(t, toks, parser, out);
}

/**
 * Every numeric mention in canonical lowercase text (see `canonicalize`), with structural list
 * markers masked first. Offsets refer to the input text.
 */
export function extractNumericMentionsDetailed(
  canonicalText: string,
  options: ExtractOptions = {},
): ExtractResult {
  const masked =
    options.maskMarkers === false
      ? canonicalText
      : maskStructuralMarkers(canonicalText, options.markerState ?? new Map<string, number>());
  const out: NumericMention[] = [];
  extractDigitNotations(masked, out);
  extractWordNumbers(masked, out);
  return { mentions: out, masked };
}

/** Every numeric mention in canonical lowercase text, as exact rationals. */
export function extractNumericMentions(
  canonicalText: string,
  options: ExtractOptions = {},
): readonly NumericMention[] {
  return extractNumericMentionsDetailed(canonicalText, options).mentions;
}
