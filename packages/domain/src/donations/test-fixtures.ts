// Synthetic fixtures for donation tests (family "Riley", schools Maple/Oak/Pine). Not public API.
import { monthlyPriceCents, tryMonthlyPriceCents } from '../pricing/index.ts';
import type { BillingPeriodFact } from '../shared/billing.ts';
import { divideRoundHalfUp } from '../shared/money.ts';
import type { CalendarMonth } from '../shared/time.ts';
import type { Designation } from './designation.ts';
import type { SchoolStatus } from './eligibility.ts';

export const ZONE = 'America/Los_Angeles';
export const FAMILY = 'fam_riley';
export const OTHER_FAMILY = 'fam_sam';
export const MAPLE = 'sch_maple';
export const OAK = 'sch_oak';
export const PINE = 'sch_pine';

export const allActive = (_schoolId: string): SchoolStatus => 'active';

export const MAPLE_SINCE_JANUARY: readonly Designation[] = [
  { schoolId: MAPLE, effectiveFromMonth: '2026-01', effectiveToMonth: null },
];

/** A settled, undiscounted 2-slot monthly period starting 2026-09-10 10:00 PDT. */
export function period(overrides: Partial<BillingPeriodFact> = {}): BillingPeriodFact {
  const paidSlots = overrides.paidSlots ?? 2;
  // Out-of-range slot counts (used to test NOT_REGULAR_TIER_PRICE) default to the 2-slot price.
  const tier = tryMonthlyPriceCents(paidSlots);
  const regular = tier.ok ? tier.value : monthlyPriceCents(2);
  return {
    familyId: FAMILY,
    channel: 'app_store',
    providerPeriodId: 'txn_2026_09',
    kind: 'subscription_period',
    periodStart: new Date('2026-09-10T17:00:00.000Z'),
    periodEnd: new Date('2026-10-10T17:00:00.000Z'),
    paidSlots,
    regularAmountCents: regular,
    chargedAmountCents: regular,
    discountCents: 0,
    discountSources: [],
    settlement: 'settled',
    settledAt: new Date('2026-09-10T17:00:05.000Z'),
    refundedCents: 0,
    ...overrides,
  };
}

/** A full monthly period starting on day 10 of `month` (program zone), id `txn_<month>`. */
export function monthlyPeriod(
  month: CalendarMonth,
  overrides: Partial<BillingPeriodFact> = {},
): BillingPeriodFact {
  const start = new Date(`${month}-10T17:00:00.000Z`);
  const end = new Date(start.getTime());
  end.setUTCMonth(end.getUTCMonth() + 1);
  return period({
    providerPeriodId: `txn_${month}`,
    periodStart: start,
    periodEnd: end,
    settledAt: new Date(start.getTime() + 5_000),
    ...overrides,
  });
}

/** Provider-style promo discount: charged = round-half-up(regular × (100 − pct) / 100). */
export function discountFields(
  percent: number,
  paidSlots = 2,
): Pick<
  BillingPeriodFact,
  'regularAmountCents' | 'chargedAmountCents' | 'discountCents' | 'discountSources'
> {
  const regular = monthlyPriceCents(paidSlots);
  const charged = divideRoundHalfUp(regular * (100 - percent), 100);
  return {
    regularAmountCents: regular,
    chargedAmountCents: charged,
    discountCents: regular - charged,
    discountSources: ['promo_code'],
  };
}
