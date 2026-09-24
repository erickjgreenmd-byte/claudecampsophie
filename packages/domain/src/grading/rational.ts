/**
 * Exact rational arithmetic for deterministic answer checking (spec P5: "Check work with
 * deterministic rational arithmetic ... never `eval`"). Values are BigInt numerator/denominator
 * pairs, always normalized: gcd(|num|, den) = 1 and den > 0 (zero is 0/1). Structural equality
 * (`toEqual`) therefore coincides with numeric equality.
 *
 * Invalid arguments (zero denominator, non-integer exponent) are programmer errors and throw;
 * the parser checks user-controlled cases first and reports them as Result values.
 */
export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

function bigAbs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = bigAbs(a);
  let y = bigAbs(b);
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function toBigInt(value: bigint | number, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer or bigint, received ${value}`);
  }
  return BigInt(value);
}

/** Builds a normalized rational. Throws RangeError for a zero denominator. */
export function rational(num: bigint | number, den: bigint | number = 1n): Rational {
  let n = toBigInt(num, 'numerator');
  let d = toBigInt(den, 'denominator');
  if (d === 0n) throw new RangeError('rational denominator must not be zero');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  if (n === 0n) return Object.freeze({ num: 0n, den: 1n });
  const g = gcd(n, d);
  return Object.freeze({ num: n / g, den: d / g });
}

export const RATIONAL_ZERO: Rational = rational(0n);
export const RATIONAL_ONE: Rational = rational(1n);

export function addRational(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function subtractRational(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den - b.num * a.den, a.den * b.den);
}

export function multiplyRational(a: Rational, b: Rational): Rational {
  return rational(a.num * b.num, a.den * b.den);
}

/** Throws RangeError when dividing by zero. */
export function divideRational(a: Rational, b: Rational): Rational {
  if (b.num === 0n) throw new RangeError('division by zero');
  return rational(a.num * b.den, a.den * b.num);
}

export function negateRational(a: Rational): Rational {
  return rational(-a.num, a.den);
}

export function absRational(a: Rational): Rational {
  return rational(bigAbs(a.num), a.den);
}

/** Integer powers only. Throws for a non-integer exponent or 0 raised to a negative power. */
export function powRational(base: Rational, exponent: number): Rational {
  if (!Number.isSafeInteger(exponent)) {
    throw new RangeError(`exponent must be a safe integer, received ${exponent}`);
  }
  if (exponent < 0) {
    if (base.num === 0n) throw new RangeError('zero cannot be raised to a negative power');
    const e = BigInt(-exponent);
    return rational(base.den ** e, base.num ** e);
  }
  const e = BigInt(exponent);
  return rational(base.num ** e, base.den ** e);
}

export function compareRational(a: Rational, b: Rational): -1 | 0 | 1 {
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function equalsRational(a: Rational, b: Rational): boolean {
  return a.num === b.num && a.den === b.den;
}

export function isIntegerRational(a: Rational): boolean {
  return a.den === 1n;
}

/**
 * Rounds to `places` decimal places (negative places round to tens, hundreds, ...).
 * Decision: ties round half away from zero ("round half up" on the magnitude, as taught in
 * school), so -2.5 -> -3 and the rule is symmetric for negative answers.
 */
export function roundRationalToPlaces(value: Rational, places: number): Rational {
  if (!Number.isSafeInteger(places)) {
    throw new RangeError(`places must be an integer, received ${places}`);
  }
  const scale =
    places >= 0 ? rational(10n ** BigInt(places)) : rational(1n, 10n ** BigInt(-places));
  const scaled = multiplyRational(value, scale);
  const magnitude = bigAbs(scaled.num);
  // floor(|x| + 1/2) = floor((2|n| + d) / 2d)
  const rounded = (2n * magnitude + scaled.den) / (2n * scaled.den);
  return divideRational(rational(scaled.num < 0n ? -rounded : rounded), scale);
}

/** "n/d" for non-integers, "n" for integers; parseMathAnswer reads this back exactly. */
export function formatRational(value: Rational): string {
  return value.den === 1n
    ? value.num.toString()
    : `${value.num.toString()}/${value.den.toString()}`;
}

/**
 * Exact decimal string for terminating decimals ("2.5", "-0.75"), or null when the decimal
 * expansion repeats (denominator has a prime factor other than 2 or 5).
 */
export function rationalToDecimalString(value: Rational): string | null {
  let rest = value.den;
  let twos = 0;
  let fives = 0;
  while (rest % 2n === 0n) {
    rest /= 2n;
    twos++;
  }
  while (rest % 5n === 0n) {
    rest /= 5n;
    fives++;
  }
  if (rest !== 1n) return null;
  const places = Math.max(twos, fives);
  const magnitude = bigAbs(value.num) * (10n ** BigInt(places) / value.den);
  const digits = magnitude.toString().padStart(places + 1, '0');
  const sign = value.num < 0n ? '-' : '';
  if (places === 0) return `${sign}${digits}`;
  return `${sign}${digits.slice(0, -places)}.${digits.slice(-places)}`;
}
