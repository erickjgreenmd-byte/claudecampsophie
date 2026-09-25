// The owner-approved, full-price-only donation rule (spec P17 "School attribution and donation
// ledger", F7 "Approved donation rule"): a settled, undiscounted, regular-tier monthly subscription
// period with a valid school designation generates exactly $1; anything else generates $0.
import {
  DEFAULT_MAX_PAID_SLOTS,
  isRegularTierPrice,
  tryMonthlyPriceCents,
} from '../pricing/index.ts';
import type {
  BillingChannel,
  BillingPeriodFact,
  BillingPeriodKind,
  DiscountSource,
  SettlementStatus,
} from '../shared/billing.ts';
import type { Cents } from '../shared/money.ts';
import { assertIanaZone, calendarMonthOf, type CalendarMonth } from '../shared/time.ts';
import { designationForMonth, type Designation } from './designation.ts';
import { assertId, assertInstant, assertNonNegativeCents } from './validation.ts';

/** PencilLift-funded contribution per eligible family per calendar month: USD $1. */
export const DONATION_CENTS = 100;
export type DonationCents = typeof DONATION_CENTS;

/** The only donation policy. There is deliberately no variant that allows discounted periods. */
export const DONATION_POLICY = 'full_price_only';

/** Version tag stored in every snapshot so audits know which rule text produced it. */
export const DONATION_RULES_VERSION = 'p17-f7-full-price-only-v2';

/**
 * Ineligibility reasons in evaluation order; the first failing rule is the reported reason.
 * NOT_SUBSCRIPTION_PERIOD: proration, add-on and tax invoices never qualify on their own.
 * NOT_SETTLED: pending or failed payment, an unrecognized settlement status, or no settlement
 *   time recorded.
 * REFUNDED_OR_CHARGED_BACK: refunded, partially refunded, charged back, or any refunded cents.
 * DISCOUNTED: ANY discount (1%..100%, promo code, promotional credit, intro offer) or a charge
 *   below the regular price disqualifies the whole period, even when a positive payment remains.
 * NOT_REGULAR_TIER_PRICE: the regular amount is not the approved tier price for the paid slots,
 *   or the charged amount differs from it.
 * NOT_USD_CURRENCY: the charge was made in another currency, so its amount is not USD cents.
 * NO_SCHOOL_DESIGNATION: no designated school for the donation month.
 * SCHOOL_INACTIVE: the designated school is inactive or unknown.
 */
export const DONATION_INELIGIBLE_REASONS = [
  'NOT_SUBSCRIPTION_PERIOD',
  'NOT_SETTLED',
  'REFUNDED_OR_CHARGED_BACK',
  'NOT_USD_CURRENCY',
  'DISCOUNTED',
  'NOT_REGULAR_TIER_PRICE',
  'NO_SCHOOL_DESIGNATION',
  'SCHOOL_INACTIVE',
] as const;
export type DonationIneligibleReason = (typeof DONATION_INELIGIBLE_REASONS)[number];

export type SchoolStatus = 'active' | 'inactive' | 'unknown';
export type SchoolStatusLookup = (schoolId: string) => SchoolStatus;

export type DonationRule =
  | 'subscription_period'
  | 'settled'
  | 'not_refunded'
  | 'usd_currency'
  | 'undiscounted'
  | 'regular_tier_price'
  | 'school_designated'
  | 'school_active';

const RULE_FAILURE: Readonly<Record<DonationRule, DonationIneligibleReason>> = {
  subscription_period: 'NOT_SUBSCRIPTION_PERIOD',
  settled: 'NOT_SETTLED',
  not_refunded: 'REFUNDED_OR_CHARGED_BACK',
  usd_currency: 'NOT_USD_CURRENCY',
  undiscounted: 'DISCOUNTED',
  regular_tier_price: 'NOT_REGULAR_TIER_PRICE',
  school_designated: 'NO_SCHOOL_DESIGNATION',
  school_active: 'SCHOOL_INACTIVE',
};

/**
 * What each known settlement status means for the `settled` and `not_refunded` rules.
 * collected: the payment was taken and stands. reversed: it was taken, then refunded (in part) or
 * charged back. uncollected: no payment was taken.
 * Decision: both rules are allow-lists over this table (RV-donations-1). A status that is not in
 * it (a new provider state, a casing slip in a normalizer) fails `settled` and reports NOT_SETTLED,
 * so it can never earn a donation; that fails closed like the `kind` rule and `unknown` schools.
 * The Record type forces a decision here whenever SettlementStatus gains a member.
 */
const SETTLEMENT_OUTCOME: Readonly<
  Record<SettlementStatus, 'collected' | 'reversed' | 'uncollected'>
> = {
  settled: 'collected',
  refunded: 'reversed',
  partially_refunded: 'reversed',
  chargeback: 'reversed',
  pending: 'uncollected',
  failed: 'uncollected',
};
/** Map lookup, so inherited object keys such as "constructor" are never mistaken for a status. */
const SETTLEMENT_OUTCOMES: ReadonlyMap<string, 'collected' | 'reversed' | 'uncollected'> = new Map(
  Object.entries(SETTLEMENT_OUTCOME),
);

export interface EvaluatedRule {
  readonly rule: DonationRule;
  readonly passed: boolean;
}

/**
 * Immutable, JSON-serializable audit record of one evaluation (stored with the accrual or skip).
 * Decision: instants are ISO-8601 strings so the stored snapshot cannot drift with Date handling.
 */
export interface DonationEligibilitySnapshot {
  readonly rulesVersion: string;
  readonly policy: typeof DONATION_POLICY;
  readonly familyId: string;
  readonly channel: BillingChannel;
  readonly providerPeriodId: string;
  readonly kind: BillingPeriodKind;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly paidSlots: number;
  readonly regularAmountCents: Cents;
  /** Approved tier price for `paidSlots`, or null when the slot count is not a configured tier. */
  readonly approvedTierPriceCents: Cents | null;
  readonly chargedAmountCents: Cents;
  /** ISO 4217 code of the charge ('USD' when the fact carries none). */
  readonly currency: string;
  readonly discountCents: Cents;
  readonly discountSources: readonly DiscountSource[];
  readonly settlement: SettlementStatus;
  readonly settledAt: string | null;
  readonly refundedCents: Cents;
  readonly programZone: string;
  readonly donationMonth: CalendarMonth;
  readonly schoolId: string | null;
  readonly schoolStatus: SchoolStatus | null;
  /** Every rule, in evaluation order; `school_active` is omitted when no school is designated. */
  readonly evaluatedRules: readonly EvaluatedRule[];
}

export type DonationEligibility =
  | {
      readonly eligible: true;
      readonly donationMonth: CalendarMonth;
      readonly schoolId: string;
      readonly amountCents: DonationCents;
      readonly snapshot: DonationEligibilitySnapshot;
    }
  | {
      readonly eligible: false;
      readonly reason: DonationIneligibleReason;
      readonly donationMonth: CalendarMonth;
      readonly snapshot: DonationEligibilitySnapshot;
    };

export interface EvaluateDonationEligibilityInput {
  readonly period: BillingPeriodFact;
  /** The family's designation history. */
  readonly designations: readonly Designation[];
  /** Fixed program calendar zone (IANA). */
  readonly programZone: string;
  readonly schoolStatus: SchoolStatusLookup;
  readonly maxSlots?: number;
}

/**
 * Evaluates one provider billing period against the approved donation rule.
 *
 * The donation month is the program-zone calendar month containing `periodStart` — never the
 * settlement time — so late settlement is recorded against the original period, and overlapping
 * service from an earlier period cannot make a later discounted period eligible.
 *
 * There is no input that relaxes the rule: extra properties are ignored by construction.
 * Decision: an `unknown` school status is treated like `inactive` (fail closed).
 * Decision: a `settled` period without `settledAt` is treated as not settled (fail closed).
 * Decision: an unrecognized settlement status is treated as not settled (fail closed); see
 * SETTLEMENT_OUTCOME.
 */
export function evaluateDonationEligibility(
  input: EvaluateDonationEligibilityInput,
): DonationEligibility {
  const { period, programZone } = input;
  const maxSlots = input.maxSlots ?? DEFAULT_MAX_PAID_SLOTS;
  assertValidPeriod(period);
  assertIanaZone(programZone);

  const donationMonth = calendarMonthOf(period.periodStart, programZone);
  const schoolId = designationForMonth(input.designations, donationMonth);
  const schoolStatus = schoolId === null ? null : input.schoolStatus(schoolId);

  const settlement = SETTLEMENT_OUTCOMES.get(period.settlement) ?? 'unrecognized';
  const rules: EvaluatedRule[] = [
    { rule: 'subscription_period', passed: period.kind === 'subscription_period' },
    {
      rule: 'settled',
      passed:
        (settlement === 'collected' || settlement === 'reversed') && period.settledAt !== null,
    },
    {
      rule: 'not_refunded',
      passed: settlement === 'collected' && period.refundedCents === 0,
    },
    // A charge in another currency is minor units of that currency, not USD cents, so no price
    // comparison below is meaningful for it (BILL-R1-5; the launch market is the US, Owner
    // action #38).
    { rule: 'usd_currency', passed: (period.currency ?? 'USD') === 'USD' },
    {
      rule: 'undiscounted',
      passed:
        period.discountCents === 0 &&
        period.discountSources.length === 0 &&
        period.chargedAmountCents >= period.regularAmountCents,
    },
    {
      rule: 'regular_tier_price',
      passed:
        isRegularTierPrice(period.paidSlots, period.regularAmountCents, maxSlots) &&
        period.chargedAmountCents === period.regularAmountCents,
    },
    { rule: 'school_designated', passed: schoolId !== null },
  ];
  if (schoolStatus !== null)
    rules.push({ rule: 'school_active', passed: schoolStatus === 'active' });

  const tier = tryMonthlyPriceCents(period.paidSlots, maxSlots);
  const snapshot: DonationEligibilitySnapshot = {
    rulesVersion: DONATION_RULES_VERSION,
    policy: DONATION_POLICY,
    familyId: period.familyId,
    channel: period.channel,
    providerPeriodId: period.providerPeriodId,
    kind: period.kind,
    periodStart: period.periodStart.toISOString(),
    periodEnd: period.periodEnd.toISOString(),
    paidSlots: period.paidSlots,
    regularAmountCents: period.regularAmountCents,
    approvedTierPriceCents: tier.ok ? tier.value : null,
    chargedAmountCents: period.chargedAmountCents,
    currency: period.currency ?? 'USD',
    discountCents: period.discountCents,
    discountSources: [...period.discountSources],
    settlement: period.settlement,
    settledAt: period.settledAt === null ? null : period.settledAt.toISOString(),
    refundedCents: period.refundedCents,
    programZone,
    donationMonth,
    schoolId,
    schoolStatus,
    evaluatedRules: rules,
  };

  const failed = rules.find((r) => !r.passed);
  if (failed !== undefined) {
    return { eligible: false, reason: RULE_FAILURE[failed.rule], donationMonth, snapshot };
  }
  if (schoolId === null) throw new Error('unreachable: school_designated passed without a school');
  return { eligible: true, donationMonth, schoolId, amountCents: DONATION_CENTS, snapshot };
}

function assertValidPeriod(period: BillingPeriodFact): void {
  assertId(period.familyId, 'period.familyId');
  assertId(period.providerPeriodId, 'period.providerPeriodId');
  assertInstant(period.periodStart, 'period.periodStart');
  assertInstant(period.periodEnd, 'period.periodEnd');
  if (period.periodEnd.getTime() <= period.periodStart.getTime()) {
    throw new RangeError('period.periodEnd must be after period.periodStart');
  }
  if (period.settledAt !== null) assertInstant(period.settledAt, 'period.settledAt');
  assertNonNegativeCents(period.regularAmountCents, 'period.regularAmountCents');
  assertNonNegativeCents(period.chargedAmountCents, 'period.chargedAmountCents');
  assertNonNegativeCents(period.discountCents, 'period.discountCents');
  assertNonNegativeCents(period.refundedCents, 'period.refundedCents');
}
