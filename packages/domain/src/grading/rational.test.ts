import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addRational,
  compareRational,
  divideRational,
  equalsRational,
  formatRational,
  isIntegerRational,
  multiplyRational,
  negateRational,
  powRational,
  rational,
  rationalToDecimalString,
  roundRationalToPlaces,
  subtractRational,
  type Rational,
} from './index.ts';

const nonZeroBigInt = fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }).filter((n) => n !== 0n);
const anyBigInt = fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n });
const arbRational = fc.tuple(anyBigInt, nonZeroBigInt).map(([n, d]) => rational(n, d));

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

function r(text: string): Rational {
  const [n, d = '1'] = text.split('/');
  return rational(BigInt(n!), BigInt(d));
}

describe('P5 exact rational arithmetic: Rational is always normalized', () => {
  it('reduces by the gcd and keeps the denominator positive', () => {
    expect(rational(2n, -4n)).toEqual({ num: -1n, den: 2n });
    expect(rational(-6, -8)).toEqual({ num: 3n, den: 4n });
    expect(rational(0n, 5n)).toEqual({ num: 0n, den: 1n });
    expect(rational(7)).toEqual({ num: 7n, den: 1n });
  });

  it('treats a zero denominator or a non-integer number as a programmer error', () => {
    expect(() => rational(1n, 0n)).toThrow(RangeError);
    expect(() => rational(0.5)).toThrow(RangeError);
  });

  it('property: every constructed rational has gcd(|num|, den) = 1 and den > 0', () => {
    fc.assert(
      fc.property(anyBigInt, nonZeroBigInt, (n, d) => {
        const value = rational(n, d);
        expect(value.den > 0n).toBe(true);
        expect(gcd(value.num, value.den)).toBe(1n);
        // Same value as n/d: value.num * d === n * value.den
        expect(value.num * d).toBe(n * value.den);
      }),
    );
  });
});

describe('P5 exact rational arithmetic: operations', () => {
  it('adds, subtracts, multiplies and divides exactly', () => {
    expect(addRational(r('1/2'), r('1/3'))).toEqual(r('5/6'));
    expect(subtractRational(r('1/2'), r('3/4'))).toEqual(r('-1/4'));
    expect(multiplyRational(r('2/3'), r('3/4'))).toEqual(r('1/2'));
    expect(divideRational(r('1/2'), r('1/4'))).toEqual(r('2'));
    expect(negateRational(r('3/4'))).toEqual(r('-3/4'));
  });

  it('floating-point traps are exact: 0.1 + 0.2 === 0.3', () => {
    expect(equalsRational(addRational(r('1/10'), r('2/10')), r('3/10'))).toBe(true);
  });

  it('dividing by zero is a programmer error at this layer (the parser reports it as a Result)', () => {
    expect(() => divideRational(r('1'), r('0'))).toThrow(RangeError);
  });

  it('raises to integer powers including negative exponents', () => {
    expect(powRational(r('2/3'), 3)).toEqual(r('8/27'));
    expect(powRational(r('2/3'), -2)).toEqual(r('9/4'));
    expect(powRational(r('-2'), 3)).toEqual(r('-8'));
    expect(powRational(r('5'), 0)).toEqual(r('1'));
    expect(() => powRational(r('0'), -1)).toThrow(RangeError);
    expect(() => powRational(r('2'), 0.5)).toThrow(RangeError);
  });

  it('compares and detects integers', () => {
    expect(compareRational(r('1/3'), r('1/2'))).toBe(-1);
    expect(compareRational(r('2/4'), r('1/2'))).toBe(0);
    expect(compareRational(r('-1/2'), r('-2/3'))).toBe(1);
    expect(isIntegerRational(r('6/3'))).toBe(true);
    expect(isIntegerRational(r('5/2'))).toBe(false);
  });

  it('property: a + b - b === a and (a * b) / b === a for b != 0', () => {
    fc.assert(
      fc.property(arbRational, arbRational, (a, b) => {
        expect(subtractRational(addRational(a, b), b)).toEqual(a);
        if (b.num !== 0n) expect(divideRational(multiplyRational(a, b), b)).toEqual(a);
      }),
    );
  });

  it('property: comparison is antisymmetric and consistent with subtraction', () => {
    fc.assert(
      fc.property(arbRational, arbRational, (a, b) => {
        expect(compareRational(a, b)).toBe(-compareRational(b, a) || 0);
        const diff = subtractRational(a, b);
        expect(compareRational(a, b)).toBe(diff.num === 0n ? 0 : diff.num > 0n ? 1 : -1);
      }),
    );
  });
});

describe('P5 rounding tolerance: round half-up (away from zero) to N places', () => {
  it.each([
    ['2345/1000', 2, '47/20'], // 2.345 -> 2.35
    ['5/2', 0, '3'], // 2.5 -> 3
    ['-5/2', 0, '-3'], // symmetric: -2.5 -> -3
    ['347', -1, '350'], // nearest ten
    ['344', -1, '340'],
    ['1/3', 2, '33/100'],
    ['2/3', 2, '67/100'],
    ['314159/100000', 4, '31416/10000'],
  ] as const)('round(%s, %i) = %s', (value, places, expected) => {
    expect(roundRationalToPlaces(r(value), places)).toEqual(r(expected));
  });

  it('rejects non-integer places as a programmer error', () => {
    expect(() => roundRationalToPlaces(r('1/3'), 1.5)).toThrow(RangeError);
  });
});

describe('formatting', () => {
  it('formats as a normalized fraction string', () => {
    expect(formatRational(r('-5/2'))).toBe('-5/2');
    expect(formatRational(r('6/2'))).toBe('3');
    expect(formatRational(r('0'))).toBe('0');
  });

  it('formats terminating decimals and refuses repeating ones', () => {
    expect(rationalToDecimalString(r('5/2'))).toBe('2.5');
    expect(rationalToDecimalString(r('1/8'))).toBe('0.125');
    expect(rationalToDecimalString(r('-3/4'))).toBe('-0.75');
    expect(rationalToDecimalString(r('7'))).toBe('7');
    expect(rationalToDecimalString(r('1/3'))).toBeNull();
  });
});
