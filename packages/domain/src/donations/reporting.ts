// School reporting (spec P17): distinct family counts for administrators, and a suppressed,
// aggregate-only view for schools. No family, guardian, child or payment identifiers leave here.
import { assertCents, formatUsd, type Cents } from '../shared/money.ts';
import { parseCalendarMonth, type CalendarMonth } from '../shared/time.ts';
import { DONATION_CENTS } from './eligibility.ts';
import { assertId, assertNonNegativeCents } from './validation.ts';

/** One family's facts for the report month (upstream joins may repeat a family; see below). */
export interface SchoolFamilyFact {
  readonly familyId: string;
  /** School credited with the family's signup (referral attribution), if any. */
  readonly attributedSchoolId: string | null;
  /** School receiving the family's donations this month, if any. */
  readonly designatedSchoolId: string | null;
  readonly active: boolean;
  /** Subscription amount charged for this month's period(s). */
  readonly chargedCents: Cents;
  readonly discounted: boolean;
  readonly fullyDiscounted: boolean;
  readonly donationEligible: boolean;
}

export interface SummarizeSchoolMonthInput {
  readonly schoolId: string;
  readonly month: CalendarMonth;
  readonly familyFacts: readonly SchoolFamilyFact[];
  /** Gross accruals for this school/month (a multiple of 100 cents). */
  readonly accruedCents: Cents;
  /** Amount actually transferred for this school/month. */
  readonly paidCents: Cents;
}

/** Administrator summary: exact counts, still no identities. */
export interface SchoolMonthSummary {
  readonly schoolId: string;
  readonly month: CalendarMonth;
  readonly attributedSignups: number;
  readonly activeFamilies: number;
  readonly positivePayingFamilies: number;
  readonly fullyDiscountedFamilies: number;
  readonly donationEligibleFamilies: number;
  readonly accruedCents: Cents;
  readonly paidCents: Cents;
  /** accrued − paid; negative when a post-payout reversal is still to be carried forward. */
  readonly owedCents: Cents;
}

/**
 * Counts distinct families only; children, guardians and code redemptions never inflate counts.
 *
 * Decision: the school's family population for active/positive-paying/fully-discounted counts is
 * families ATTRIBUTED to OR DESIGNATING the school this month; attributedSignups counts only
 * attributed families and donationEligibleFamilies only designating families (the donation goes
 * to the designated school). Attribution is independent of discounts: a fully discounted family
 * still counts as a signup.
 * Decision: repeated rows for one family must be identical; conflicting rows throw because they
 * signal an upstream join bug that would make any count unreliable.
 */
export function summarizeSchoolMonth(input: SummarizeSchoolMonthInput): SchoolMonthSummary {
  assertId(input.schoolId, 'schoolId');
  parseCalendarMonth(input.month);
  assertNonNegativeCents(input.accruedCents, 'accruedCents');
  assertNonNegativeCents(input.paidCents, 'paidCents');

  const families = new Map<string, SchoolFamilyFact>();
  for (const f of input.familyFacts) {
    assertValidFact(f);
    const seen = families.get(f.familyId);
    if (seen === undefined) families.set(f.familyId, f);
    else if (!sameFact(seen, f)) {
      throw new RangeError('Conflicting facts for one family in a school report');
    }
  }

  let attributedSignups = 0;
  let activeFamilies = 0;
  let positivePayingFamilies = 0;
  let fullyDiscountedFamilies = 0;
  let donationEligibleFamilies = 0;
  for (const f of families.values()) {
    const attributed = f.attributedSchoolId === input.schoolId;
    const designated = f.designatedSchoolId === input.schoolId;
    if (attributed) attributedSignups++;
    if (!attributed && !designated) continue;
    if (f.active) activeFamilies++;
    if (f.chargedCents > 0) positivePayingFamilies++;
    if (f.fullyDiscounted) fullyDiscountedFamilies++;
    if (designated && f.donationEligible) donationEligibleFamilies++;
  }

  return {
    schoolId: input.schoolId,
    month: input.month,
    attributedSignups,
    activeFamilies,
    positivePayingFamilies,
    fullyDiscountedFamilies,
    donationEligibleFamilies,
    accruedCents: input.accruedCents,
    paidCents: input.paidCents,
    owedCents: input.accruedCents - input.paidCents,
  };
}

/** Minimum cohort below which school-facing figures are suppressed. */
export const DEFAULT_MIN_COHORT = 5;

export type SuppressedCount = number | `<${number}`;
export type SuppressedAmount = Cents | `<${string}`;

/** What a school administrator may see: suppressed aggregates only. */
export interface SchoolFacingReport {
  readonly schoolId: string;
  readonly month: CalendarMonth;
  readonly attributedSignups: SuppressedCount;
  readonly activeFamilies: SuppressedCount;
  readonly donationEligibleFamilies: SuppressedCount;
  /** PencilLift-funded contribution accrued for the month (not a customer donation). */
  readonly contributionAccruedCents: SuppressedAmount;
  readonly contributionPaidCents: SuppressedAmount;
}

/**
 * Builds the school-facing view: any count in 1..minCohort−1 becomes `<minCohort` (e.g. "<5").
 *
 * Decision: internal fields are omitted — owedCents and the payment-status breakdown
 * (positivePayingFamilies, fullyDiscountedFamilies) — because payment status is family financial
 * data, and publishing it next to activeFamilies would let a school subtract its way to a
 * suppressed small group.
 * Decision: a contribution amount in 1..(minCohort × $1 − 1¢) is shown as e.g. "<$5.00", since each
 * family contributes exactly $1 and the exact amount would reveal a suppressed count.
 * Decision: minCohort below the default of 5 is refused (privacy can be tightened, not weakened).
 */
export function toSchoolFacingReport(
  summary: SchoolMonthSummary,
  minCohort: number = DEFAULT_MIN_COHORT,
): SchoolFacingReport {
  if (!Number.isSafeInteger(minCohort) || minCohort < DEFAULT_MIN_COHORT) {
    throw new RangeError(`minCohort must be an integer of at least ${DEFAULT_MIN_COHORT}`);
  }
  const count = (value: number): SuppressedCount => {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError('Report counts must be non-negative integers');
    }
    return value > 0 && value < minCohort ? `<${minCohort}` : value;
  };
  const moneyThreshold = minCohort * DONATION_CENTS;
  const amount = (value: Cents): SuppressedAmount => {
    assertCents(value, 'contribution amount');
    return value > 0 && value < moneyThreshold ? `<${formatUsd(moneyThreshold)}` : value;
  };
  return {
    schoolId: summary.schoolId,
    month: summary.month,
    attributedSignups: count(summary.attributedSignups),
    activeFamilies: count(summary.activeFamilies),
    donationEligibleFamilies: count(summary.donationEligibleFamilies),
    contributionAccruedCents: amount(summary.accruedCents),
    contributionPaidCents: amount(summary.paidCents),
  };
}

function assertValidFact(f: SchoolFamilyFact): void {
  assertId(f.familyId, 'familyFact.familyId');
  if (f.attributedSchoolId !== null)
    assertId(f.attributedSchoolId, 'familyFact.attributedSchoolId');
  if (f.designatedSchoolId !== null)
    assertId(f.designatedSchoolId, 'familyFact.designatedSchoolId');
  assertNonNegativeCents(f.chargedCents, 'familyFact.chargedCents');
  if (f.fullyDiscounted && !f.discounted) {
    throw new RangeError('A fully discounted family must also be marked discounted');
  }
}

function sameFact(a: SchoolFamilyFact, b: SchoolFamilyFact): boolean {
  return (
    a.attributedSchoolId === b.attributedSchoolId &&
    a.designatedSchoolId === b.designatedSchoolId &&
    a.active === b.active &&
    a.chargedCents === b.chargedCents &&
    a.discounted === b.discounted &&
    a.fullyDiscounted === b.fullyDiscounted &&
    a.donationEligible === b.donationEligible
  );
}
