import { assertCents, type Cents } from '../shared/money.ts';
import { err, ok, type Result } from '../shared/result.ts';

/** Owner-approved list prices (spec P11, F4). Changing these requires an explicit owner decision. */
export const BASE_PRICE_CENTS: Cents = 3999;
export const ADDITIONAL_CHILD_PRICE_CENTS: Cents = 999;
/** Initial paid-slot tiers are 1–4; configurable for later expansion (spec P1/P11). */
export const DEFAULT_MAX_PAID_SLOTS = 4;

export type PricingErrorCode = 'INVALID_SLOT_COUNT';

/** `3999 + 999 × (n − 1)` for integer n in 1..maxSlots. No subscription means no recurring charge. */
export function monthlyPriceCents(paidSlots: number, maxSlots = DEFAULT_MAX_PAID_SLOTS): Cents {
  const result = tryMonthlyPriceCents(paidSlots, maxSlots);
  if (!result.ok) throw new RangeError(result.error.message);
  return result.value;
}

export function tryMonthlyPriceCents(
  paidSlots: number,
  maxSlots = DEFAULT_MAX_PAID_SLOTS,
): Result<Cents, PricingErrorCode> {
  if (!Number.isInteger(paidSlots) || paidSlots < 1 || paidSlots > maxSlots) {
    return err('INVALID_SLOT_COUNT', `Paid slots must be an integer from 1 to ${maxSlots}`, {
      paidSlots,
      maxSlots,
    });
  }
  return ok(assertCents(BASE_PRICE_CENTS + ADDITIONAL_CHILD_PRICE_CENTS * (paidSlots - 1)));
}

/** Price table for every configured tier, e.g. [{paidSlots:1, cents:3999}, …]. */
export function priceTable(
  maxSlots = DEFAULT_MAX_PAID_SLOTS,
): { paidSlots: number; cents: Cents }[] {
  return Array.from({ length: maxSlots }, (_, i) => ({
    paidSlots: i + 1,
    cents: monthlyPriceCents(i + 1, maxSlots),
  }));
}

/** True when `cents` is exactly the approved regular price for `paidSlots`. */
export function isRegularTierPrice(
  paidSlots: number,
  cents: Cents,
  maxSlots = DEFAULT_MAX_PAID_SLOTS,
): boolean {
  const price = tryMonthlyPriceCents(paidSlots, maxSlots);
  return price.ok && price.value === cents;
}
