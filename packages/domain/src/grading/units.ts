import { err, ok, type Result } from '../shared/result.ts';
import {
  isSimplestForm,
  MAX_ANSWER_LENGTH,
  normalizeMathText,
  parseMathAnswerDetailed,
  PARSE_ERROR_CODES,
  type AnswerForm,
} from './parse.ts';
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  negateRational,
  powRational,
  rational,
  RATIONAL_ZERO,
  type Rational,
} from './rational.ts';
import { foldQuotes, stripInvisible } from './text.ts';

/**
 * Units with exact rational conversion factors (spec P5: "units ... must be supported").
 * Every factor is exact: 1 in = 2.54 cm and 1 lb = 0.45359237 kg by international definition,
 * 1 US gal = 3.785411784 L. Temperature is deliberately absent (affine, not a ratio scale).
 */
export const DIMENSIONS = [
  'length',
  'area',
  'volume',
  'mass',
  'time',
  'currency',
  'angle',
  'ratio',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const UNIT_IDS = [
  'mm',
  'cm',
  'm',
  'km',
  'in',
  'ft',
  'yd',
  'mi',
  'mm2',
  'cm2',
  'm2',
  'km2',
  'in2',
  'ft2',
  'yd2',
  'mi2',
  'cm3',
  'm3',
  'in3',
  'ft3',
  'yd3',
  'mg',
  'g',
  'kg',
  'oz',
  'lb',
  'mL',
  'L',
  'fl_oz',
  'cup',
  'pt',
  'qt',
  'gal',
  's',
  'min',
  'h',
  'day',
  'week',
  'usd',
  'cent',
  'deg',
  'percent',
] as const;
export type UnitId = (typeof UNIT_IDS)[number];

/** `factor` converts one of this unit to the dimension's base unit (m, m², L, g, s, $, °, 1). */
export interface UnitDefinition {
  readonly id: UnitId;
  readonly dimension: Dimension;
  readonly factor: Rational;
}

export const QUANTITY_ERROR_CODES = [
  ...PARSE_ERROR_CODES,
  'UNKNOWN_UNIT',
  'INCONSISTENT_UNITS',
] as const;
export type QuantityErrorCode = (typeof QUANTITY_ERROR_CODES)[number];

export interface Quantity {
  readonly value: Rational;
  /** null when the answer is a bare number. */
  readonly unit: UnitId | null;
  readonly dimension: Dimension | null;
}

export interface DetailedQuantity extends Quantity {
  readonly form: AnswerForm;
}

export interface QuantityOptions {
  /**
   * How a bare "oz" / "ounce(s)" is read. 'weight' (default): the avoirdupois ounce. 'fluid': a
   * fluid ounce, for capacity answers; in US customary usage "oz" for a capacity is a fluid ounce
   * ("1 cup = 8 oz"). "fl oz" is always a fluid ounce.
   */
  readonly ounces?: 'weight' | 'fluid';
}

// ---------------------------------------------------------------------------------------------
// Unit table
// ---------------------------------------------------------------------------------------------

const dec = (text: string): Rational => {
  const [whole = '0', frac = ''] = text.split('.');
  return rational(BigInt(whole + frac), 10n ** BigInt(frac.length));
};

const INCH_M = dec('0.0254');
const FOOT_M = multiplyRational(INCH_M, rational(12n));
const YARD_M = multiplyRational(FOOT_M, rational(3n));
const MILE_M = multiplyRational(FOOT_M, rational(5280n));
const POUND_G = dec('453.59237');
const GALLON_L = dec('3.785411784');
const QUART_L = divideRational(GALLON_L, rational(4n));
const PINT_L = divideRational(QUART_L, rational(2n));
const CUP_L = divideRational(PINT_L, rational(2n));
const LITRES_PER_CUBIC_METRE = rational(1000n);

interface LengthSpec {
  readonly id: 'mm' | 'cm' | 'm' | 'km' | 'in' | 'ft' | 'yd' | 'mi';
  readonly factor: Rational;
  readonly symbols: readonly string[];
  readonly names: readonly string[];
}

const LENGTHS: readonly LengthSpec[] = [
  {
    id: 'mm',
    factor: rational(1n, 1000n),
    symbols: ['mm'],
    names: ['millimeter', 'millimeters', 'millimetre', 'millimetres'],
  },
  {
    id: 'cm',
    factor: rational(1n, 100n),
    symbols: ['cm'],
    names: ['centimeter', 'centimeters', 'centimetre', 'centimetres'],
  },
  { id: 'm', factor: rational(1n), symbols: ['m'], names: ['meter', 'meters', 'metre', 'metres'] },
  {
    id: 'km',
    factor: rational(1000n),
    symbols: ['km'],
    names: ['kilometer', 'kilometers', 'kilometre', 'kilometres'],
  },
  { id: 'in', factor: INCH_M, symbols: ['in'], names: ['inch', 'inches'] },
  { id: 'ft', factor: FOOT_M, symbols: ['ft'], names: ['foot', 'feet'] },
  { id: 'yd', factor: YARD_M, symbols: ['yd'], names: ['yard', 'yards', 'yds'] },
  { id: 'mi', factor: MILE_M, symbols: ['mi'], names: ['mile', 'miles'] },
];

const UNITS = new Map<UnitId, UnitDefinition>();
const ALIASES = new Map<string, UnitId>();

function define(id: UnitId, dimension: Dimension, factor: Rational, aliases: readonly string[]) {
  UNITS.set(id, Object.freeze({ id, dimension, factor }));
  for (const alias of aliases) {
    const key = normalizeUnitText(alias);
    const existing = ALIASES.get(key);
    if (existing !== undefined && existing !== id) {
      throw new Error(`unit alias "${key}" is defined for both ${existing} and ${id}`);
    }
    ALIASES.set(key, id);
  }
}

/**
 * Unit text normalization: NFKC (so "cm²" -> "cm2", "″" -> "′′"), curly quotes and primes to
 * ASCII, two apostrophes to an inch mark, lower case, periods and "^" removed, whitespace
 * collapsed. Decision: unit matching is case-insensitive ("M", "KG" and "mL" are accepted);
 * no supported unit pair differs only by case.
 */
function normalizeUnitText(text: string): string {
  return foldQuotes(stripInvisible(text.normalize('NFKC')))
    .replace(/''/g, '"')
    .toLowerCase()
    .replace(/[.^]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

for (const length of LENGTHS) {
  define(length.id, 'length', length.factor, [...length.symbols, ...length.names]);
}
define('in', 'length', INCH_M, ['"']);
define('ft', 'length', FOOT_M, ["'"]);

for (const length of LENGTHS) {
  define(`${length.id}2` as UnitId, 'area', powRational(length.factor, 2), [
    ...length.symbols.flatMap((s) => [`${s}2`, `sq ${s}`, `square ${s}`]),
    ...length.names.map((n) => `square ${n}`),
  ]);
}
for (const length of LENGTHS.filter((l) => ['cm', 'm', 'in', 'ft', 'yd'].includes(l.id))) {
  define(
    `${length.id}3` as UnitId,
    'volume',
    multiplyRational(powRational(length.factor, 3), LITRES_PER_CUBIC_METRE),
    [
      ...length.symbols.flatMap((s) => [`${s}3`, `cu ${s}`, `cubic ${s}`]),
      ...length.names.map((n) => `cubic ${n}`),
      ...(length.id === 'cm' ? ['cc'] : []),
    ],
  );
}

define('mg', 'mass', rational(1n, 1000n), ['mg', 'milligram', 'milligrams']);
define('g', 'mass', rational(1n), ['g', 'gm', 'gram', 'grams']);
define('kg', 'mass', rational(1000n), ['kg', 'kgs', 'kilogram', 'kilograms', 'kilo', 'kilos']);
define('lb', 'mass', POUND_G, ['lb', 'lbs', 'pound', 'pounds']);
define('oz', 'mass', divideRational(POUND_G, rational(16n)), ['oz', 'ounce', 'ounces']);

define('mL', 'volume', rational(1n, 1000n), [
  'ml',
  'milliliter',
  'milliliters',
  'millilitre',
  'millilitres',
]);
define('L', 'volume', rational(1n), ['l', 'liter', 'liters', 'litre', 'litres']);
define('gal', 'volume', GALLON_L, ['gal', 'gallon', 'gallons']);
define('qt', 'volume', QUART_L, ['qt', 'quart', 'quarts']);
define('pt', 'volume', PINT_L, ['pt', 'pint', 'pints']);
define('cup', 'volume', CUP_L, ['cup', 'cups']);
define('fl_oz', 'volume', divideRational(CUP_L, rational(8n)), [
  'fl oz',
  'floz',
  'fl ounce',
  'fl ounces',
  'fluid ounce',
  'fluid ounces',
]);

define('s', 'time', rational(1n), ['s', 'sec', 'secs', 'second', 'seconds']);
define('min', 'time', rational(60n), ['min', 'mins', 'minute', 'minutes']);
define('h', 'time', rational(3600n), ['h', 'hr', 'hrs', 'hour', 'hours']);
define('day', 'time', rational(86_400n), ['day', 'days']);
define('week', 'time', rational(604_800n), ['wk', 'wks', 'week', 'weeks']);

define('usd', 'currency', rational(1n), ['$', 'dollar', 'dollars', 'usd']);
define('cent', 'currency', rational(1n, 100n), ['¢', 'cent', 'cents']);

define('deg', 'angle', rational(1n), ['°', 'deg', 'degree', 'degrees']);
define('percent', 'ratio', rational(1n, 100n), ['%', 'percent', 'per cent', 'pct']);

/** Looks up a unit by id ("fl_oz") or by any alias ("fluid ounces", "″", "cm^2"). */
export function lookupUnit(text: string): UnitDefinition | null {
  const direct = UNITS.get(text as UnitId);
  if (direct !== undefined) return direct;
  const id = ALIASES.get(normalizeUnitText(text));
  return id === undefined ? null : (UNITS.get(id) ?? null);
}

function unitById(id: UnitId): UnitDefinition {
  const unit = UNITS.get(id);
  if (unit === undefined) throw new Error(`unknown unit id ${id}`);
  return unit;
}

/** Exact conversion between units of the same dimension. */
export function convertValue(
  value: Rational,
  from: UnitId,
  to: UnitId,
): Result<Rational, 'INCOMPATIBLE_UNITS'> {
  const source = unitById(from);
  const target = unitById(to);
  if (source.dimension !== target.dimension) {
    return err('INCOMPATIBLE_UNITS', `cannot convert ${source.dimension} to ${target.dimension}`);
  }
  return ok(divideRational(multiplyRational(value, source.factor), target.factor));
}

// ---------------------------------------------------------------------------------------------
// Quantity parsing
// ---------------------------------------------------------------------------------------------

const UNIT_SYMBOLS = new Set(['"', "'", '′', '″', '‘', '’', '“', '”', '¢', '%', '°', '$']);
const SIGN_CHARS = new Set(['-', '+', '\u2212', '\u2010', '\u2012', '\u2013']);
const CURRENCY_PREFIX = /^([-+\u2212\u2010\u2012\u2013]?)\s*\$\s*/;

interface Segment {
  kind: 'number' | 'unit';
  text: string;
}

class QuantityFailure extends Error {
  readonly code: QuantityErrorCode;
  constructor(code: QuantityErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function fail(code: QuantityErrorCode, message: string): never {
  throw new QuantityFailure(code, message);
}

/**
 * Splits "5 ft 3 in" into number and unit runs. Letters, quote/prime marks, ¢, %, ° and $ start a
 * unit run; inside a unit run, ".", "²", "³" and "^n" continue it ("fl. oz.", "cm²", "cm^2").
 */
function segment(text: string): Segment[] {
  const segments: Segment[] = [];
  for (const ch of text) {
    const current = segments.at(-1);
    if (/\s/.test(ch)) {
      if (current !== undefined) current.text += ch;
      continue;
    }
    const previous = current?.text.trimEnd().at(-1);
    const continuesUnit: boolean =
      current?.kind === 'unit' &&
      (ch === '.' || ch === '²' || ch === '³' || ch === '^' || (previous === '^' && /\d/.test(ch)));
    const kind: Segment['kind'] =
      continuesUnit || /\p{L}/u.test(ch) || UNIT_SYMBOLS.has(ch) ? 'unit' : 'number';
    if (current?.kind === kind) current.text += ch;
    else segments.push({ kind, text: ch });
  }
  return segments.map((s) => ({ kind: s.kind, text: s.text.trim() }));
}

function parseNumber(text: string): { value: Rational; form: AnswerForm } {
  const parsed = parseMathAnswerDetailed(text, { percent: 'reject' });
  if (!parsed.ok) fail(parsed.error.code, parsed.error.message);
  return parsed.value;
}

function resolveUnit(text: string): UnitDefinition {
  const unit = lookupUnit(text);
  if (unit === null) fail('UNKNOWN_UNIT', 'unit is not recognized');
  return unit;
}

/**
 * Decision: with `ounces: 'fluid'` a bare "oz" is a fluid ounce, but only when no other part of the
 * answer is a weight: "1 lb 4 oz" stays a weight (and is judged as one), "1 cup 2 oz" is 10 fl oz.
 */
function readOunces(
  pairs: readonly { text: string; unit: UnitDefinition }[],
  options: QuantityOptions,
): readonly { text: string; unit: UnitDefinition }[] {
  if (options.ounces !== 'fluid') return pairs;
  const weightPart = pairs.some((p) => p.unit.dimension === 'mass' && p.unit.id !== 'oz');
  if (weightPart) return pairs;
  const fluid = unitById('fl_oz');
  return pairs.map((pair) => (pair.unit.id === 'oz' ? { ...pair, unit: fluid } : pair));
}

function parseSegments(segments: readonly Segment[], options: QuantityOptions): DetailedQuantity {
  const first = segments[0];
  if (first === undefined) fail('EMPTY_INPUT', 'answer is empty');
  if (first.kind === 'unit') fail('INVALID_SYNTAX', 'unit appears before the number');
  if (segments.length === 1) {
    const { value, form } = parseNumber(first.text);
    return { value, unit: null, dimension: null, form };
  }
  if (segments.length % 2 === 1) {
    fail('AMBIGUOUS_FORMAT', 'number after the last unit has no unit');
  }
  const written: { text: string; unit: UnitDefinition }[] = [];
  for (let i = 0; i < segments.length; i += 2) {
    written.push({ text: segments[i]!.text, unit: resolveUnit(segments[i + 1]!.text) });
  }
  const pairs = readOunces(written, options);
  const dimension = pairs[0]!.unit.dimension;
  if (pairs.some((p) => p.unit.dimension !== dimension)) {
    fail('INCONSISTENT_UNITS', 'units of different kinds in one answer');
  }
  if (pairs.length === 1) {
    const { value, form } = parseNumber(pairs[0]!.text);
    const unit = pairs[0]!.unit;
    return { value, unit: unit.id, dimension: unit.dimension, form };
  }
  return compound(pairs);
}

/**
 * "5 ft 3 in", "1 h 30 min": each part a plain non-negative number, units strictly decreasing.
 * The result is expressed in the last (smallest) unit. Decision: a compound is treated like a
 * mixed number for simplest-form purposes (simplest when every part is).
 */
function compound(pairs: readonly { text: string; unit: UnitDefinition }[]): DetailedQuantity {
  const smallest = pairs.at(-1)!.unit;
  const parts = pairs.map((pair, index) => {
    if (SIGN_CHARS.has(Array.from(pair.text)[0] ?? '')) {
      fail(
        index === 0 ? 'AMBIGUOUS_FORMAT' : 'INVALID_SYNTAX',
        'signed part in a compound quantity',
      );
    }
    const parsed = parseNumber(pair.text);
    if (parsed.form.kind === 'expression' || parsed.form.kind === 'percent') {
      fail('INVALID_SYNTAX', 'compound quantity parts must be plain numbers');
    }
    return { ...parsed, unit: pair.unit };
  });
  let total = RATIONAL_ZERO;
  let reduced = true;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const next = parts[i + 1];
    if (next !== undefined && compareRational(part.unit.factor, next.unit.factor) <= 0) {
      fail('AMBIGUOUS_FORMAT', 'compound units must go from largest to smallest');
    }
    reduced &&= isSimplestForm(part.form);
    total = addRational(
      total,
      divideRational(multiplyRational(part.value, part.unit.factor), smallest.factor),
    );
  }
  return {
    value: total,
    unit: smallest.id,
    dimension: smallest.dimension,
    form: { kind: 'mixed_number', reduced },
  };
}

/** Like parseQuantity, plus how the number was written (for simplest-form checks). */
export function parseQuantityDetailed(
  text: string,
  options: QuantityOptions = {},
): Result<DetailedQuantity, QuantityErrorCode> {
  if (text.length > MAX_ANSWER_LENGTH) {
    return err('INPUT_TOO_LONG', `answer exceeds ${MAX_ANSWER_LENGTH} characters`);
  }
  const normalized = stripInvisible(normalizeMathText(text)).trim();
  if (normalized.length > MAX_ANSWER_LENGTH) {
    return err('INPUT_TOO_LONG', `answer exceeds ${MAX_ANSWER_LENGTH} characters`);
  }
  if (normalized === '') return err('EMPTY_INPUT', 'answer is empty');
  try {
    const prefix = CURRENCY_PREFIX.exec(normalized);
    if (prefix === null) return ok(parseSegments(segment(normalized), options));
    return ok(dollarPrefixed(prefix[1] ?? '', normalized.slice(prefix[0].length), options));
  } catch (error) {
    if (error instanceof QuantityFailure) return err(error.code, error.message);
    throw error;
  }
}

/** "$1.50", "-$5", "$5 dollars". "$150 cents" names two currency units and is ambiguous. */
function dollarPrefixed(sign: string, rest: string, options: QuantityOptions): DetailedQuantity {
  if (SIGN_CHARS.has(Array.from(rest)[0] ?? '') && sign !== '') {
    fail('INVALID_SYNTAX', 'two signs around a currency symbol');
  }
  const parsed = parseSegments(segment(rest), options);
  if (parsed.unit !== null) {
    if (parsed.dimension !== 'currency') {
      fail('INCONSISTENT_UNITS', 'currency symbol with a non-currency unit');
    }
    if (parsed.unit !== 'usd') fail('AMBIGUOUS_FORMAT', 'dollar sign with another currency unit');
  }
  const usd = unitById('usd');
  const negative = sign !== '' && sign !== '+';
  return {
    value: negative ? negateRational(parsed.value) : parsed.value,
    unit: usd.id,
    dimension: usd.dimension,
    form: parsed.form,
  };
}

/** Parses "300 cm", "$1.50", "150¢", "2 ft", "1.5 hours", "5 ft 3 in" into an exact quantity. */
export function parseQuantity(text: string): Result<Quantity, QuantityErrorCode> {
  const result = parseQuantityDetailed(text);
  if (!result.ok) return result;
  const { value, unit, dimension } = result.value;
  return ok({ value, unit, dimension });
}
