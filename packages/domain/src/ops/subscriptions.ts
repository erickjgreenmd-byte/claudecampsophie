/**
 * Subscription movement for the owner's overview. Counts come from the entitlement ledger
 * (public.family_entitlements, one row per provider subscription); this module only turns them
 * into a rate and never rounds a rate up.
 */

export const BASIS_POINTS_PER_UNIT = 10_000;

/**
 * Churn for a month as whole basis points: lapsed ÷ active-at-month-start, rounded DOWN (2.57%
 * reads as 257, never 258). Null when nothing was active at the start of the month (no rate can
 * be stated, and 0% would be a false comfort).
 */
export function churnBasisPoints(lapsed: number, activeAtMonthStart: number): number | null {
  if (!Number.isInteger(lapsed) || lapsed < 0) throw new RangeError('lapsed must be a count');
  if (!Number.isInteger(activeAtMonthStart) || activeAtMonthStart < 0) {
    throw new RangeError('activeAtMonthStart must be a count');
  }
  if (activeAtMonthStart === 0) return null;
  return Math.floor((lapsed * BASIS_POINTS_PER_UNIT) / activeAtMonthStart);
}

/** Percentage of a cap already used, rounded DOWN to a whole percent; null without a cap. */
export function percentOfCap(used: bigint, cap: bigint | null): number | null {
  if (used < 0n) throw new RangeError('used must be non-negative');
  if (cap === null || cap <= 0n) return null;
  return Number((used * 100n) / cap);
}
