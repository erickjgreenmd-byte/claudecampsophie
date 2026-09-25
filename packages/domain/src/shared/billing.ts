import type { Cents } from './money.ts';

/**
 * Billing channel. `amazon_appstore` is the Amazon Appstore on Fire tablets (Android without Google
 * services; RevenueCat names that store `AMAZON`). `stripe` is the optional, disabled-by-default
 * adult web route.
 */
export type BillingChannel = 'app_store' | 'play_store' | 'stripe' | 'amazon_appstore';

/** What a provider invoice/transaction line represents. Only full monthly periods count for P17. */
export type BillingPeriodKind = 'subscription_period' | 'proration' | 'addon' | 'tax_only';

export type SettlementStatus =
  'pending' | 'settled' | 'failed' | 'refunded' | 'partially_refunded' | 'chargeback';

/** Why an amount below the regular tier price was charged. Payment instruments are not discounts. */
export type DiscountSource =
  'promo_code' | 'promotional_credit' | 'introductory_offer' | 'other_discount';

/**
 * A provider-reported billing period for one family subscription, normalized from RevenueCat or
 * Stripe. Period boundaries come from the provider, never from `+30 days` arithmetic.
 */
export interface BillingPeriodFact {
  readonly familyId: string;
  readonly channel: BillingChannel;
  /** Provider-stable identifier for this period/invoice (e.g. Stripe invoice id, store transaction id). */
  readonly providerPeriodId: string;
  readonly kind: BillingPeriodKind;
  /** Monthly subscription period boundaries as reported by the provider (UTC instants). */
  readonly periodStart: Date;
  readonly periodEnd: Date;
  /** Paid child slots covered by this period (1..max tier). */
  readonly paidSlots: number;
  /** Approved regular tier price for `paidSlots` at the time of the period. */
  readonly regularAmountCents: Cents;
  /** Amount the family was charged for the subscription itself (excluding tax). */
  readonly chargedAmountCents: Cents;
  /**
   * ISO 4217 code of the charge; absent means USD. Amounts are minor units of this currency, so
   * only USD periods compare with the approved price table (BILL-R1-5; Owner action #38).
   */
  readonly currency?: string;
  /** Total discount applied to this period's subscription charge (0 when none). */
  readonly discountCents: Cents;
  readonly discountSources: readonly DiscountSource[];
  readonly settlement: SettlementStatus;
  readonly settledAt: Date | null;
  /** Cumulative amount refunded or charged back for this period. */
  readonly refundedCents: Cents;
}
