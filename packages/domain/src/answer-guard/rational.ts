// Minimal exact rational arithmetic on BigInt, local to the guard by design (the guard reuses no
// parsing or arithmetic from other modules so a defect elsewhere cannot silently weaken it).

export interface Rational {
  /** Numerator; carries the sign. */
  readonly num: bigint;
  /** Denominator; always > 0 and coprime with `num`. */
  readonly den: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/** Normalized rational. Throws RangeError for a zero denominator (programmer error). */
export function rational(num: bigint, den = 1n): Rational {
  if (den === 0n) throw new RangeError('rational denominator must be non-zero');
  let n = num;
  let d = den;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return g > 1n ? { num: n / g, den: d / g } : { num: n, den: d };
}

export function add(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function multiply(a: Rational, b: Rational): Rational {
  return rational(a.num * b.num, a.den * b.den);
}

export function divide(a: Rational, b: Rational): Rational | null {
  if (b.num === 0n) return null;
  return rational(a.num * b.den, a.den * b.num);
}

export function abs(a: Rational): Rational {
  return a.num < 0n ? { num: -a.num, den: a.den } : a;
}

export function equals(a: Rational, b: Rational): boolean {
  return a.num === b.num && a.den === b.den;
}

export function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/**
 * True when |a - b| <= 0.5 * 10^-places, i.e. one value is the other rounded to `places`
 * decimal places (half-up or half-down).
 */
export function withinRounding(a: Rational, b: Rational, places: number): boolean {
  const diff = a.num * b.den - b.num * a.den;
  const absDiff = diff < 0n ? -diff : diff;
  return 2n * pow10(places) * absDiff <= a.den * b.den;
}

/** Terminating decimal string for a rational, or null if it does not terminate within 12 places. */
export function toDecimalString(value: Rational): string | null {
  const a = abs(value);
  for (let places = 0; places <= 12; places++) {
    const scale = pow10(places);
    if ((a.num * scale) % a.den === 0n) {
      const scaled = (a.num * scale) / a.den;
      if (places === 0) return scaled.toString();
      const digits = scaled.toString().padStart(places + 1, '0');
      return `${digits.slice(0, -places)}.${digits.slice(-places)}`;
    }
  }
  return null;
}
