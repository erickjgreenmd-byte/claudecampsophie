import { divideRoundHalfUp } from '../shared/money.ts';
import {
  AGGREGATE_REPORT_MIN_COUNT,
  type MonetizationProvider,
  type Placement,
  type RevenueAdjustmentKind,
  type RevenueCategory,
} from './types.ts';

/**
 * Owner revenue reporting (spec P16.5, AC_MON_17/18). Categories are kept separate: a projection is
 * never recognized revenue, a contract is not cash, and an affiliate report is its own line. The
 * summary takes no click or impression input, so a click can never become an invented sale.
 */

export interface RevenueEntryFact {
  readonly id: string;
  readonly category: RevenueCategory;
  readonly provider: MonetizationProvider;
  readonly placement: Placement | null;
  readonly periodMonth: string;
  /** Non-negative; refunds and reversals are separate adjustments. */
  readonly amountCents: number;
}

export interface RevenueAdjustmentFact {
  readonly entryId: string;
  readonly kind: RevenueAdjustmentKind;
  /** Signed delta: refunds/reversals are negative, corrections either sign. */
  readonly amountCents: number;
}

export interface RevenueCohorts {
  /** Every active family, including non-buyers, ad-free and hidden-card families. */
  readonly activeFamilies: number;
  /** Adults who could actually be shown sponsor placements. */
  readonly adEligibleAdults: number;
}

export interface DoubleCountConflict {
  readonly category: RevenueCategory;
  readonly placement: Placement;
  readonly periodMonth: string;
  readonly excludedNetworkCents: number;
}

export interface RevenueSummary {
  readonly projectedCents: number;
  readonly contractedCents: number;
  readonly recognizedCents: number;
  readonly receivedCents: number;
  readonly affiliateReportedCents: number;
  /** Net refunds/reversals/corrections applied above, by kind. */
  readonly adjustments: Readonly<Record<RevenueAdjustmentKind, number>>;
  /** Network revenue on inventory already sold as a fixed-fee sponsorship (not counted). */
  readonly excludedDoubleCountCents: number;
  readonly conflicts: readonly DoubleCountConflict[];
  readonly activeFamilies: number;
  readonly adEligibleAdults: number;
  /** Recognized revenue / ALL active families (null when there are none). */
  readonly recognizedPerActiveFamilyCents: number | null;
  /** Recognized revenue / ad-eligible adults (null when there are none). */
  readonly recognizedPerAdEligibleAdultCents: number | null;
}

function perCapita(totalCents: number, count: number): number | null {
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  const sign = totalCents < 0 ? -1 : 1;
  return sign * divideRoundHalfUp(Math.abs(totalCents), count);
}

/**
 * Fixed sponsor fees substitute for network revenue on the same sold inventory: when a sponsor_direct
 * entry exists for a (category, placement, month), ad_network entries for that same cell are
 * excluded and reported as a conflict for the owner to resolve.
 */
export function revenueSummary(
  entries: readonly RevenueEntryFact[],
  adjustments: readonly RevenueAdjustmentFact[],
  cohorts: RevenueCohorts,
): RevenueSummary {
  const sponsorCells = new Set(
    entries
      .filter((e) => e.provider === 'sponsor_direct' && e.placement !== null)
      .map((e) => `${e.category}|${e.placement}|${e.periodMonth}`),
  );
  const excluded = new Set<string>();
  const conflictCents = new Map<string, number>();
  for (const e of entries) {
    if (e.provider !== 'ad_network' || e.placement === null) continue;
    const cell = `${e.category}|${e.placement}|${e.periodMonth}`;
    if (sponsorCells.has(cell)) {
      excluded.add(e.id);
      conflictCents.set(cell, (conflictCents.get(cell) ?? 0) + e.amountCents);
    }
  }

  const byEntry = new Map(entries.map((e) => [e.id, e]));
  const totals: Record<RevenueCategory, number> = {
    projected: 0,
    contracted: 0,
    recognized: 0,
    received: 0,
    affiliate_reported: 0,
  };
  const adjustmentTotals: Record<RevenueAdjustmentKind, number> = {
    refund: 0,
    reversal: 0,
    correction: 0,
  };
  let excludedCents = 0;
  for (const e of entries) {
    if (excluded.has(e.id)) {
      excludedCents += e.amountCents;
      continue;
    }
    totals[e.category] += e.amountCents;
  }
  for (const a of adjustments) {
    const entry = byEntry.get(a.entryId);
    if (!entry) continue;
    if (excluded.has(entry.id)) {
      excludedCents += a.amountCents;
      continue;
    }
    totals[entry.category] += a.amountCents;
    adjustmentTotals[a.kind] += a.amountCents;
  }

  const conflicts: DoubleCountConflict[] = [...conflictCents.entries()]
    .map(([cell, cents]) => {
      const [category, placement, periodMonth] = cell.split('|') as [
        RevenueCategory,
        Placement,
        string,
      ];
      return { category, placement, periodMonth, excludedNetworkCents: cents };
    })
    .sort((a, b) =>
      `${a.periodMonth}${a.placement}${a.category}`.localeCompare(
        `${b.periodMonth}${b.placement}${b.category}`,
      ),
    );

  return {
    projectedCents: totals.projected,
    contractedCents: totals.contracted,
    recognizedCents: totals.recognized,
    receivedCents: totals.received,
    affiliateReportedCents: totals.affiliate_reported,
    adjustments: adjustmentTotals,
    excludedDoubleCountCents: excludedCents,
    conflicts,
    activeFamilies: cohorts.activeFamilies,
    adEligibleAdults: cohorts.adEligibleAdults,
    recognizedPerActiveFamilyCents: perCapita(totals.recognized, cohorts.activeFamilies),
    recognizedPerAdEligibleAdultCents: perCapita(totals.recognized, cohorts.adEligibleAdults),
  };
}

/** Whether a reversal/refund would take an entry below zero (never allowed). */
export function adjustmentAllowed(
  entryAmountCents: number,
  existingAdjustmentsCents: readonly number[],
  delta: number,
): boolean {
  const net = existingAdjustmentsCents.reduce((sum, v) => sum + v, entryAmountCents) + delta;
  return delta !== 0 && net >= 0;
}

/**
 * Small-cohort suppression for owner aggregate exports (spec P16.5): a non-zero count below the
 * threshold is replaced by null. Zero is shown (it identifies nobody).
 */
export function suppressSmallCount(
  count: number,
  threshold: number = AGGREGATE_REPORT_MIN_COUNT,
): number | null {
  return count > 0 && count < threshold ? null : count;
}
