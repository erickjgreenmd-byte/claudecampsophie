/** Integer USD cents. Never use floats for customer money (spec F2). */
export type Cents = number;

export function assertCents(value: number, label = 'amount'): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be an integer number of cents, received ${value}`);
  }
  return value;
}

/**
 * round-half-up(numerator / denominator) for non-negative integers, computed exactly with BigInt.
 * Used for previews that must match finance/promo_school_model.py (Decimal ROUND_HALF_UP).
 */
export function divideRoundHalfUp(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new RangeError('divideRoundHalfUp requires safe integers');
  }
  if (numerator < 0 || denominator <= 0) {
    throw new RangeError('divideRoundHalfUp requires numerator >= 0 and denominator > 0');
  }
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  return Number((n * 2n + d) / (d * 2n));
}

/** Formats cents as a USD display string, e.g. 4998 -> "$49.98". Presentation only. */
export function formatUsd(cents: Cents): string {
  assertCents(cents);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}
