import { divideRoundHalfUp, formatUsd, tryMonthlyPriceCents } from '@pencillift/domain';

/**
 * Money helpers for the owner console. Customer money is integer cents only (spec F2); these
 * helpers never pass amounts through floating-point arithmetic.
 */

const DOLLARS_RE = /^(\d{1,9})(?:\.(\d{1,2}))?$/;

/** "1,234.5" / "$19.99" -> integer cents, or null for anything that is not a non-negative amount. */
export function parseDollarsToCents(input: string): number | null {
  const compact = input.trim().replace(/^\$/, '').replace(/,/g, '');
  const match = DOLLARS_RE.exec(compact);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  const cents = whole * 100 + fraction;
  return Number.isSafeInteger(cents) ? cents : null;
}

/** 123456 -> "1234.56" (the form input format). */
export function centsToDollarsInput(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * Preview of the discounted period price: round-half-up(regular × (100 − pct) / 100), matching
 * docs/Architecture.md §6 and finance/promo_school_model.py. The provider amount is authoritative.
 */
export function discountedCents(regularCents: number, percentOff: number): number {
  return divideRoundHalfUp(regularCents * (100 - percentOff), 100);
}

/**
 * Decision: the App Store USD price-point grid from docs/Provider_Capability_Matrix.md §1
 * (secondary evidence, not yet sandbox-verified): every $0.10 below $10 (x.x9), every $0.50 from
 * $10 to $50 (x.49 / x.99) and every $1 from $50 to $200 (x.99); a 100% offer uses Apple's "Free"
 * offer type. Whole-dollar alternates are NOT assumed. Failing closed here only blocks marking a
 * mapping "ready"; it can never make the store charge an amount the owner did not approve.
 */
export function isApplePricePoint(cents: number): boolean {
  if (!Number.isSafeInteger(cents) || cents < 0) return false;
  if (cents === 0) return true;
  if (cents >= 29 && cents < 1000) return cents % 10 === 9;
  if (cents >= 1000 && cents < 5000) return cents % 50 === 49;
  if (cents >= 5000 && cents < 20000) return cents % 100 === 99;
  return false;
}

/**
 * Why an App Store offer for `percentOff` on the `paidSlots` tier cannot be represented exactly,
 * or null when the discounted amount is on the price-point grid (still verify in App Store Connect).
 */
export function applePricePointProblem(paidSlots: number, percentOff: number): string | null {
  const regular = tryMonthlyPriceCents(paidSlots);
  if (!regular.ok) return `There is no approved price for ${paidSlots} paid child slots.`;
  const charged = discountedCents(regular.value, percentOff);
  if (isApplePricePoint(charged)) return null;
  return `${formatUsd(charged)} (${percentOff}% off ${formatUsd(regular.value)}) is not an App Store price point, so Apple cannot represent this exact discount.`;
}
