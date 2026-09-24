import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  convertValue,
  formatRational,
  lookupUnit,
  parseQuantity,
  rational,
  UNIT_IDS,
  type QuantityErrorCode,
  type Rational,
  type UnitId,
} from './index.ts';

function r(text: string): Rational {
  const [n, d = '1'] = text.split('/');
  return rational(BigInt(n!), BigInt(d));
}

function decimal(text: string): Rational {
  const negative = text.startsWith('-');
  const [whole, frac = ''] = text.replace('-', '').split('.');
  const value = rational(BigInt(whole! + frac), 10n ** BigInt(frac.length));
  return negative ? rational(-value.num, value.den) : value;
}

function quantity(text: string): { value: string; unit: string | null; dimension: string | null } {
  const result = parseQuantity(text);
  if (!result.ok) throw new Error(`${JSON.stringify(text)} -> ${result.error.code}`);
  return {
    value: formatRational(result.value.value),
    unit: result.value.unit,
    dimension: result.value.dimension,
  };
}

function convert(amount: string, from: UnitId, to: UnitId): Rational {
  const result = convertValue(decimal(amount), from, to);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe('P5 units: parseQuantity reads a number with a unit (AC_GRADING_02, AC_CAPTURE_03)', () => {
  it.each([
    ['300 cm', '300', 'cm', 'length'],
    ['$1.50', '3/2', 'usd', 'currency'],
    ['150¢', '150', 'cent', 'currency'],
    ['2 ft', '2', 'ft', 'length'],
    ['1.5 hours', '3/2', 'h', 'time'],
    ['3m', '3', 'm', 'length'],
    ['½ cup', '1/2', 'cup', 'volume'],
    ['2½ cups', '5/2', 'cup', 'volume'],
    ['2 1/2 ft', '5/2', 'ft', 'length'],
    ['-$5', '-5', 'usd', 'currency'],
    ['$ 5', '5', 'usd', 'currency'],
    ['$5 dollars', '5', 'usd', 'currency'],
    ['5$', '5', 'usd', 'currency'],
    ['75 cents', '75', 'cent', 'currency'],
    ['12 cm²', '12', 'cm2', 'area'],
    ['12 cm^2', '12', 'cm2', 'area'],
    ['12 sq ft', '12', 'ft2', 'area'],
    ['8 cm³', '8', 'cm3', 'volume'],
    ['90°', '90', 'deg', 'angle'],
    ['25%', '25', 'percent', 'ratio'],
    ['3 ft.', '3', 'ft', 'length'],
    ['2 fl. oz.', '2', 'fl_oz', 'volume'],
    ['2 fl oz', '2', 'fl_oz', 'volume'],
    ['1 hr', '1', 'h', 'time'],
    ['4 KG', '4', 'kg', 'mass'],
    ['7', '7', null, null],
  ])('%j -> %s %s (%s)', (input, value, unit, dimension) => {
    expect(quantity(input)).toEqual({ value, unit, dimension });
  });

  it('reads compound same-dimension quantities in the smallest unit given', () => {
    expect(quantity('5 ft 3 in')).toEqual({ value: '63', unit: 'in', dimension: 'length' });
    expect(quantity(`5' 3"`)).toEqual({ value: '63', unit: 'in', dimension: 'length' });
    expect(quantity('1 h 30 min')).toEqual({ value: '90', unit: 'min', dimension: 'time' });
    expect(quantity('1 lb 4 oz')).toEqual({ value: '20', unit: 'oz', dimension: 'mass' });
    expect(quantity('2 dollars 5 cents')).toEqual({
      value: '205',
      unit: 'cent',
      dimension: 'currency',
    });
  });

  it.each<[string, QuantityErrorCode]>([
    ['', 'EMPTY_INPUT'],
    ['5 blorps', 'UNKNOWN_UNIT'],
    ['5 °F', 'UNKNOWN_UNIT'], // temperature is affine, deliberately unsupported
    ['5 ft 3 kg', 'INCONSISTENT_UNITS'],
    ['3 in 5 ft', 'AMBIGUOUS_FORMAT'],
    ['5 ft 3', 'AMBIGUOUS_FORMAT'],
    ['$150 cents', 'AMBIGUOUS_FORMAT'],
    ['1,5 m', 'AMBIGUOUS_FORMAT'],
    ['cm 5', 'INVALID_SYNTAX'],
    ['5 m + 3 m', 'INVALID_SYNTAX'],
    ['5/0 m', 'DIVISION_BY_ZERO'],
    [`${'1'.repeat(199)} m`, 'INPUT_TOO_LONG'],
  ])('%j -> %s', (input, code) => {
    const result = parseQuantity(input);
    expect(result.ok ? 'ok' : result.error.code).toBe(code);
  });
});

describe('P5 units: aliases include plurals, abbreviations and symbols', () => {
  it.each<[string[], UnitId]>([
    [['m', 'meter', 'meters', 'metre', 'metres', 'M'], 'm'],
    [['cm', 'centimeter', 'centimeters', 'centimetre', 'centimetres'], 'cm'],
    [['mm', 'millimeter', 'millimeters'], 'mm'],
    [['km', 'kilometer', 'kilometers', 'kilometre'], 'km'],
    [['in', 'in.', 'inch', 'inches', '"', '″', '”'], 'in'],
    [['ft', 'foot', 'feet', "'", '′', '’'], 'ft'],
    [['yd', 'yds', 'yard', 'yards'], 'yd'],
    [['mi', 'mile', 'miles'], 'mi'],
    [['lb', 'lbs', 'pound', 'pounds'], 'lb'],
    [['oz', 'ounce', 'ounces'], 'oz'],
    [['kg', 'kilogram', 'kilograms'], 'kg'],
    [['g', 'gram', 'grams'], 'g'],
    [['mg', 'milligram', 'milligrams'], 'mg'],
    [['l', 'L', 'liter', 'liters', 'litre', 'litres'], 'L'],
    [['ml', 'mL', 'milliliter', 'milliliters', 'millilitre'], 'mL'],
    [['gal', 'gallon', 'gallons'], 'gal'],
    [['qt', 'quart', 'quarts'], 'qt'],
    [['pt', 'pint', 'pints'], 'pt'],
    [['cup', 'cups'], 'cup'],
    [['fl oz', 'fluid ounce', 'fluid ounces', 'floz'], 'fl_oz'],
    [['s', 'sec', 'secs', 'second', 'seconds'], 's'],
    [['min', 'mins', 'minute', 'minutes'], 'min'],
    [['h', 'hr', 'hrs', 'hour', 'hours'], 'h'],
    [['day', 'days'], 'day'],
    [['wk', 'week', 'weeks'], 'week'],
    [['$', 'dollar', 'dollars', 'usd'], 'usd'],
    [['¢', 'cent', 'cents'], 'cent'],
  ])('%j -> %s', (aliases, id) => {
    for (const alias of aliases) expect(lookupUnit(alias)?.id, alias).toBe(id);
  });

  it('returns null for unknown or empty unit text', () => {
    expect(lookupUnit('furlong')).toBeNull();
    expect(lookupUnit('')).toBeNull();
    expect(lookupUnit('c')).toBeNull(); // cups vs cents: never guessed
  });
});

describe('P5 units: exact rational conversion factors', () => {
  it.each<[string, UnitId, UnitId, string]>([
    ['1', 'in', 'cm', '2.54'],
    ['1', 'ft', 'in', '12'],
    ['1', 'yd', 'ft', '3'],
    ['1', 'mi', 'ft', '5280'],
    ['1', 'mi', 'km', '1.609344'],
    ['1', 'ft', 'cm', '30.48'],
    ['1', 'yd', 'm', '0.9144'],
    ['3', 'm', 'cm', '300'],
    ['1', 'km', 'm', '1000'],
    ['1', 'lb', 'kg', '0.45359237'],
    ['1', 'lb', 'oz', '16'],
    ['1', 'oz', 'g', '28.349523125'],
    ['1', 'kg', 'g', '1000'],
    ['1', 'L', 'mL', '1000'],
    ['1', 'gal', 'L', '3.785411784'],
    ['1', 'gal', 'qt', '4'],
    ['1', 'qt', 'pt', '2'],
    ['1', 'pt', 'cup', '2'],
    ['1', 'cup', 'fl_oz', '8'],
    ['1', 'fl_oz', 'mL', '29.5735295625'],
    ['1', 'h', 'min', '60'],
    ['1', 'min', 's', '60'],
    ['1', 'day', 'h', '24'],
    ['1', 'week', 'day', '7'],
    ['1.50', 'usd', 'cent', '150'],
    ['1', 'ft2', 'in2', '144'],
    ['1', 'm2', 'cm2', '10000'],
    ['1', 'cm3', 'mL', '1'],
    ['1', 'm3', 'L', '1000'],
    ['50', 'percent', 'percent', '50'],
  ])('%s %s = %s %s', (amount, from, to, expected) => {
    expect(convert(amount, from, to)).toEqual(decimal(expected));
  });

  it('refuses to convert across dimensions', () => {
    const result = convertValue(r('1'), 'm', 'kg');
    expect(result.ok ? 'ok' : result.error.code).toBe('INCOMPATIBLE_UNITS');
  });

  it('property: converting there and back is the identity for every same-dimension pair', () => {
    const pairs: [UnitId, UnitId][] = [];
    for (const a of UNIT_IDS) {
      for (const b of UNIT_IDS) {
        if (lookupUnit(a)?.dimension === lookupUnit(b)?.dimension) pairs.push([a, b]);
      }
    }
    const value = fc
      .tuple(
        fc.bigInt({ min: -(10n ** 9n), max: 10n ** 9n }),
        fc.bigInt({ min: 1n, max: 10n ** 6n }),
      )
      .map(([n, d]) => rational(n, d));
    fc.assert(
      fc.property(fc.constantFrom(...pairs), value, ([a, b], x) => {
        const there = convertValue(x, a, b);
        if (!there.ok) throw new Error(there.error.code);
        const back = convertValue(there.value, b, a);
        if (!back.ok) throw new Error(back.error.code);
        expect(back.value).toEqual(x);
      }),
    );
  });
});
