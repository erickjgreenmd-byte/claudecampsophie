// Plans donation accruals for one family: at most one $1 per family per program calendar month
// (spec P17). The database's unique (family_id, donation_month) key is the real guard against
// concurrent jobs; this planner makes retries, replays and anchor changes produce nothing new.
import type { BillingPeriodFact } from '../shared/billing.ts';
import { parseCalendarMonth, type CalendarMonth } from '../shared/time.ts';
import type { Designation } from './designation.ts';
import {
  evaluateDonationEligibility,
  type DonationCents,
  type DonationEligibilitySnapshot,
  type DonationIneligibleReason,
  type SchoolStatusLookup,
} from './eligibility.ts';

export type AccrualSkipReason =
  DonationIneligibleReason | 'MONTH_ALREADY_ACCRUED' | 'DUPLICATE_PERIOD';

export interface PlannedAccrual {
  /** `${familyId}:${donationMonth}` — matches the unique family/month database key. */
  readonly idempotencyKey: string;
  readonly familyId: string;
  readonly schoolId: string;
  readonly donationMonth: CalendarMonth;
  readonly amountCents: DonationCents;
  readonly providerPeriodId: string;
  readonly snapshot: DonationEligibilitySnapshot;
}

export interface SkippedPeriod {
  readonly providerPeriodId: string;
  readonly donationMonth: CalendarMonth;
  readonly reason: AccrualSkipReason;
}

export interface AccrualPlan {
  readonly accruals: readonly PlannedAccrual[];
  readonly skipped: readonly SkippedPeriod[];
}

export interface PlanAccrualsInput {
  /** Latest normalized provider facts for ONE family (one fact per provider period). */
  readonly periods: readonly BillingPeriodFact[];
  readonly designations: readonly Designation[];
  readonly programZone: string;
  readonly schoolStatus: SchoolStatusLookup;
  /** Donation months already accrued for this family (from the ledger). */
  readonly existingAccrualMonths: ReadonlySet<CalendarMonth>;
  readonly maxSlots?: number;
}

export function donationIdempotencyKey(familyId: string, donationMonth: CalendarMonth): string {
  return `${familyId}:${donationMonth}`;
}

/**
 * Evaluates every period and plans at most one accrual per donation month.
 *
 * Decision: periods are processed in (periodStart, providerPeriodId) order, so when a billing
 * anchor change starts two eligible periods in one month the earliest one accrues, whatever the
 * input order. Every input period appears exactly once in `accruals` or `skipped`.
 * Decision: an identical repeated fact (webhook replay) is skipped as DUPLICATE_PERIOD; two
 * DIFFERENT facts for one provider period throw, because the caller must pass the latest fact.
 */
export function planAccruals(input: PlanAccrualsInput): AccrualPlan {
  for (const month of input.existingAccrualMonths) parseCalendarMonth(month);
  const first = input.periods[0];
  if (first === undefined) return { accruals: [], skipped: [] };
  for (const p of input.periods) {
    if (p.familyId !== first.familyId) {
      throw new RangeError('planAccruals handles one family at a time');
    }
  }
  const byId = new Map<string, BillingPeriodFact>();
  for (const p of input.periods) {
    const seen = byId.get(p.providerPeriodId);
    if (seen === undefined) byId.set(p.providerPeriodId, p);
    else if (!sameFact(seen, p)) {
      throw new RangeError(`Conflicting facts for provider period ${p.providerPeriodId}`);
    }
  }

  const ordered = [...input.periods].sort(
    (a, b) =>
      a.periodStart.getTime() - b.periodStart.getTime() ||
      compareText(a.providerPeriodId, b.providerPeriodId),
  );
  const accruedMonths = new Set(input.existingAccrualMonths);
  const evaluatedIds = new Set<string>();
  const accruals: PlannedAccrual[] = [];
  const skipped: SkippedPeriod[] = [];

  for (const period of ordered) {
    const result = evaluateDonationEligibility({
      period,
      designations: input.designations,
      programZone: input.programZone,
      schoolStatus: input.schoolStatus,
      ...(input.maxSlots === undefined ? {} : { maxSlots: input.maxSlots }),
    });
    const skip = (reason: AccrualSkipReason) =>
      skipped.push({
        providerPeriodId: period.providerPeriodId,
        donationMonth: result.donationMonth,
        reason,
      });

    if (evaluatedIds.has(period.providerPeriodId)) {
      skip('DUPLICATE_PERIOD');
      continue;
    }
    evaluatedIds.add(period.providerPeriodId);
    if (!result.eligible) {
      skip(result.reason);
      continue;
    }
    if (accruedMonths.has(result.donationMonth)) {
      skip('MONTH_ALREADY_ACCRUED');
      continue;
    }
    accruedMonths.add(result.donationMonth);
    accruals.push({
      idempotencyKey: donationIdempotencyKey(period.familyId, result.donationMonth),
      familyId: period.familyId,
      schoolId: result.schoolId,
      donationMonth: result.donationMonth,
      amountCents: result.amountCents,
      providerPeriodId: period.providerPeriodId,
      snapshot: result.snapshot,
    });
  }
  return { accruals, skipped };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  return a === null || b === null ? a === b : a.getTime() === b.getTime();
}

function sameFact(a: BillingPeriodFact, b: BillingPeriodFact): boolean {
  return (
    a.familyId === b.familyId &&
    a.channel === b.channel &&
    a.providerPeriodId === b.providerPeriodId &&
    a.kind === b.kind &&
    sameInstant(a.periodStart, b.periodStart) &&
    sameInstant(a.periodEnd, b.periodEnd) &&
    a.paidSlots === b.paidSlots &&
    a.regularAmountCents === b.regularAmountCents &&
    a.chargedAmountCents === b.chargedAmountCents &&
    a.discountCents === b.discountCents &&
    a.discountSources.length === b.discountSources.length &&
    a.discountSources.every((s, i) => b.discountSources[i] === s) &&
    a.settlement === b.settlement &&
    sameInstant(a.settledAt, b.settledAt) &&
    a.refundedCents === b.refundedCents
  );
}
