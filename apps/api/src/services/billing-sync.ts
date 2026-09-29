import {
  monthlyPriceCents,
  tryMonthlyPriceCents,
  type BillingChannel,
  type DiscountSource,
} from '@pencillift/domain';
import { planAdjustment } from '@pencillift/domain/donations';
import {
  computeFamilyCapacity,
  reconcileEntitlements,
  type BillingEnvironment,
  type EntitlementRecord,
  type EntitlementStatus,
  type FamilyCapacity,
  type ProviderSubscriptionSnapshot,
  type StoreProductMapping,
} from '@pencillift/domain/entitlements';
import { transitionRedemption, type RedemptionState } from '@pencillift/domain/promotions';
import type { Tx } from '../db.ts';
import type { AppDeps } from '../middleware/context.ts';
import { revenueCatStoreChannel } from '../providers/billing.ts';
import { hmacSha256, timingSafeEqual, toHex } from '../security/crypto.ts';

/**
 * Provider → ledger synchronization (docs/Architecture.md §5). Pure mappers are exported for unit
 * tests; `apply*` functions run inside the webhook transaction with the family row locked.
 */

/** What the whole-family sync needs; the request context and the scheduled tick both provide it. */
export type BillingSyncDeps = Pick<AppDeps, 'db' | 'providers' | 'config' | 'log'>;

/** A store subscription already belongs to another family's ledger (BUG-006); never skipped. */
export class SubscriptionBoundElsewhere extends Error {
  constructor() {
    super('Provider subscription is bound to a different family');
    this.name = 'SubscriptionBoundElsewhere';
  }
}

// ---------------------------------------------------------------------------------------------
// Normalized billing period (one provider invoice/transaction)
// ---------------------------------------------------------------------------------------------

export interface NormalizedPeriod {
  readonly channel: BillingChannel;
  readonly providerPeriodId: string;
  readonly productId: string;
  readonly kind: 'subscription_period' | 'proration' | 'addon' | 'tax_only';
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly chargedCents: number;
  /**
   * Sales tax that belongs to `chargedCents` — the tax on THIS period's charge, in integer cents; 0
   * when the channel reports no tax figure at all. NEVER revenue (HUNT5-C-2): it is carried only so a
   * refund amount, which the provider states INCLUDING tax, can be put back into `chargedCents`' unit
   * without dividing by the whole charge (see preTaxRefundCents). It is NOT the invoice's whole tax
   * when the invoice also carried lines this period never booked: a proration line's tax is no part
   * of this charge and may not scale a refund of it either (N1-TAX-APPORTION, subscriptionTaxCents).
   */
  readonly taxCents: number;
  /**
   * HUNT6-C-1: money this invoice ALSO collected for mid-cycle proration items Stripe left pending
   * and listed on it, net of any credit line beside them, in integer cents and never negative. It is
   * no part of `chargedCents` (BILL-R2-4 books the subscription line alone) and it is money the
   * family paid, so it is recorded as its own 'proration' period beside this one (see
   * `prorationPeriodFor`) instead of appearing in no month's gross at all. 0 when the invoice lists
   * no pending item, and on the store channels, which invoice nothing.
   */
  readonly pendingProrationNetCents: number;
  /**
   * HUNT7-C-4: the share of the invoice's sales tax levied on `pendingProrationNetCents`, in integer
   * cents — the tax the ':proration' period carries, computed the same way and floored in the same
   * direction as `taxCents` (see prorationTaxCents). It is NO part of `taxCents`, which is the
   * subscription charge's share alone, and the two shares can never sum above the invoice's tax. 0
   * when the invoice lists no pending item, on an untaxed invoice, and on the store channels.
   */
  readonly pendingProrationTaxCents: number;
  /** Provider-reported discount on the subscription charge, if the provider reports one. */
  readonly reportedDiscountCents: number | null;
  readonly discountSources: DiscountSource[];
  readonly currency: string;
  readonly settledAt: Date;
}

// ---------------------------------------------------------------------------------------------
// RevenueCat webhook events
// ---------------------------------------------------------------------------------------------

export interface RevenueCatEvent {
  readonly id: string;
  readonly type: string;
  readonly app_user_id: string;
  readonly original_app_user_id?: string | undefined;
  readonly aliases?: string[] | undefined;
  readonly product_id?: string | undefined;
  readonly store?: string | undefined;
  readonly purchased_at_ms?: number | undefined;
  readonly expiration_at_ms?: number | undefined;
  readonly price_in_purchased_currency?: number | undefined;
  readonly currency?: string | undefined;
  readonly period_type?: string | undefined;
  readonly offer_code?: string | null | undefined;
  readonly transaction_id?: string | undefined;
  readonly cancel_reason?: string | undefined;
  readonly event_timestamp_ms?: number | undefined;
}

/**
 * Charge-bearing RevenueCat events become billing periods; others only trigger a state refresh.
 * Store names arrive in the webhook's uppercase spelling (`APP_STORE`, `AMAZON`); the mapping
 * accepts either case (BUG-113).
 */
export function mapRevenueCatEventToPeriod(event: RevenueCatEvent): NormalizedPeriod | null {
  if (event.type !== 'INITIAL_PURCHASE' && event.type !== 'RENEWAL') return null;
  const channel = revenueCatStoreChannel(event.store);
  if (!channel || !event.transaction_id || !event.product_id) return null;
  if (event.purchased_at_ms === undefined || event.expiration_at_ms === undefined) return null;
  if (event.price_in_purchased_currency === undefined) return null;
  const promotional = event.period_type === 'PROMOTIONAL' || Boolean(event.offer_code);
  const intro = event.period_type === 'INTRO' || event.period_type === 'TRIAL';
  const discountSources: DiscountSource[] = promotional
    ? ['promo_code']
    : intro
      ? ['introductory_offer']
      : [];
  return {
    channel,
    providerPeriodId: event.transaction_id,
    productId: event.product_id,
    kind: 'subscription_period',
    periodStart: new Date(event.purchased_at_ms),
    periodEnd: new Date(event.expiration_at_ms),
    chargedCents: Math.round(event.price_in_purchased_currency * 100),
    // RevenueCat reports one price and no tax breakdown, so there is no tax figure to record and
    // nothing to convert a store refund with (a store refund reports no amount either).
    taxCents: 0,
    // A store transaction is one price: there are no invoice lines and so no pending proration item,
    // and therefore no tax on one either.
    pendingProrationNetCents: 0,
    pendingProrationTaxCents: 0,
    reportedDiscountCents: null,
    discountSources,
    currency: (event.currency ?? 'USD').toUpperCase(),
    settledAt: new Date(event.event_timestamp_ms ?? event.purchased_at_ms),
  };
}

export function isRevenueCatRefund(event: RevenueCatEvent): boolean {
  return event.type === 'CANCELLATION' && event.cancel_reason === 'CUSTOMER_SUPPORT';
}

/**
 * The store channel whose period a RevenueCat refund reverses: the App Store, Google Play or the
 * Amazon Appstore. Stripe refunds arrive through Stripe's own webhook, never through RevenueCat.
 */
export function revenueCatRefundChannel(
  event: RevenueCatEvent,
): 'app_store' | 'play_store' | 'amazon_appstore' | null {
  const channel = revenueCatStoreChannel(event.store);
  return channel === 'app_store' || channel === 'play_store' || channel === 'amazon_appstore'
    ? channel
    : null;
}

// ---------------------------------------------------------------------------------------------
// Stripe webhooks (optional web billing)
// ---------------------------------------------------------------------------------------------

/**
 * Verifies a `Stripe-Signature` header (`t=…,v1=…`) over `${t}.${rawBody}` with HMAC-SHA256 and a
 * timestamp tolerance, in constant time. Any v1 signature may match (secret rotation).
 */
export async function verifyStripeSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  now: Date,
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.trim().split('=') as [string, string | undefined]);
  const timestamp = Number(parts.find(([k]) => k === 't')?.[1]);
  const signatures = parts
    .filter(([k, v]) => k === 'v1' && typeof v === 'string')
    .map(([, v]) => v!);
  if (!Number.isSafeInteger(timestamp) || signatures.length === 0) return false;
  if (Math.abs(now.getTime() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = toHex(
    await hmacSha256(new TextEncoder().encode(secret), `${timestamp}.${rawBody}`),
  );
  const enc = new TextEncoder();
  return signatures.some(
    (sig) =>
      sig.length === expected.length && timingSafeEqual(enc.encode(sig), enc.encode(expected)),
  );
}

export interface StripeInvoice {
  readonly id: string;
  readonly billing_reason?: string | null;
  readonly status?: string | null;
  readonly amount_paid?: number;
  readonly subtotal?: number;
  /**
   * The customer credit balance Stripe applied to this invoice: negative when a credit (from an
   * earlier proration) settled part of it, so `amount_paid` is below the invoice total (BILL-R4-4).
   */
  readonly starting_balance?: number | null;
  /** Sales tax Stripe added on top of the subscription price; never PencilLift revenue. */
  readonly tax?: number | null;
  /** Stripe's own pre-tax total (total − tax, i.e. after discounts). */
  readonly total_excluding_tax?: number | null;
  readonly currency?: string;
  readonly total_discount_amounts?: { amount: number }[] | null;
  readonly period_start?: number;
  readonly period_end?: number;
  readonly lines?: {
    data?: {
      period?: { start: number; end: number };
      price?: { id?: string } | null;
      proration?: boolean | null;
      /** The line's own pre-tax amount in cents. */
      amount?: number | null;
      /** Discounts applied to this line only. */
      discount_amounts?: { amount: number }[] | null;
    }[];
  } | null;
  readonly metadata?: Record<string, string> | null;
  readonly subscription_details?: { metadata?: Record<string, string> | null } | null;
  readonly status_transitions?: { paid_at?: number | null } | null;
}

export function stripeBillingRef(invoice: StripeInvoice): string | null {
  return (
    invoice.subscription_details?.metadata?.billing_ref ?? invoice.metadata?.billing_ref ?? null
  );
}

/**
 * The subscription line defines the period and price. A renewal invoice can list pending proration
 * lines (mid-cycle plan changes) first; they never define the period (RV-lead-billing-p17-8).
 */
function subscriptionLine(invoice: StripeInvoice) {
  const lines = (invoice.lines?.data ?? []).filter((l) => l.period && l.price?.id);
  const regular = lines.filter((l) => l.proration !== true);
  const pool = regular.length > 0 ? regular : lines;
  return pool.reduce<(typeof lines)[number] | undefined>(
    (best, l) => (best === undefined || l.period!.start > best.period!.start ? l : best),
    undefined,
  );
}

type StripeLine = NonNullable<NonNullable<StripeInvoice['lines']>['data']>[number];

const sumAmounts = (list: readonly { amount: number }[] | null | undefined): number =>
  (list ?? []).reduce((sum, d) => sum + d.amount, 0);

const cents = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

/**
 * BILL-R4-4: the pre-tax money this invoice actually COLLECTED — what it took (`amount_paid`) less
 * the sales tax it took with it, in integer cents. An `invoice.paid` event states a paid-in-full
 * invoice, so that difference is the money that came in for PencilLift. Null only when the invoice
 * states no payment figure at all, i.e. there is nothing to bound anything by.
 *
 * C-NEGATIVE-NET: it used to be computed ONLY when a negative `starting_balance` showed that a
 * customer credit BALANCE had settled part of the invoice, which made the bound below an accident of
 * one Stripe field. A credit LINE does the same thing to what the invoice collects and leaves
 * `starting_balance` untouched, and `subscriptionChargeCents`' first branch returns the subscription
 * LINE's own amount — so a renewal listing a net proration credit of 200 beside its 3999 line
 * collected 3799 and booked 3999, and `pendingProrationNetCents` justified dropping that negative net
 * with "the subscription charge already reflects it through amount_paid" while it did not. The bound
 * is therefore unconditional: the claim is now true of every invoice, and the two periods one invoice
 * can write are bounded at the collection (the charge) and at what is left of it (the pending net), so
 * their sum can never exceed what the invoice took. A bound that never bites on an ordinary invoice —
 * a full-price renewal collects exactly its line amount plus tax — is the point: it bites exactly when
 * the lines say more came in than did.
 */
function collectedPreTaxCents(invoice: StripeInvoice): number | null {
  const paid = cents(invoice.amount_paid);
  if (paid === null) return null;
  return Math.max(0, paid - (cents(invoice.tax) ?? 0));
}

/**
 * BILL-R2-4: what the family was charged FOR THE SUBSCRIPTION, which is what the $1 school donation
 * rule compares with the regular tier price (donations eligibility regular_tier_price) and what the
 * owner's revenue view books as gross. It is not `amount_paid`: that total also carries US sales tax
 * (tax is a state's money, never PencilLift revenue) and any pending proration items a mid-cycle
 * plan change added to the renewal invoice. Booking those made a full-price $39.99 renewal in a
 * taxing state read as 4329 against a regular 3999, so the month was skipped as
 * NOT_REGULAR_TIER_PRICE and the school never got its $1 for a full-price month.
 *
 * In order: the subscription line's own amount net of that line's discounts; Stripe's pre-tax total
 * (`total_excluding_tax`, already net of discounts); the pre-tax `subtotal` less invoice-level
 * discounts; finally what was paid less the reported tax. The last two invoice-level figures still
 * include other lines, so any proration line that states its own amount is taken back off.
 *
 * BILL-R4-4: gross is money COLLECTED for the subscription, so the figure is bounded by what the
 * invoice actually took (`collectedPreTaxCents`). A negative `starting_balance` (a credit left by an
 * earlier proration) lowers `amount_due`/`amount_paid` while the line amount, the subtotal and
 * `total_excluding_tax` stay at full price and no discount is reported: booking the line amount then
 * counted money that was never collected in that month as revenue AND made the month pass the donation
 * rule's regular_tier_price equality, so the $1 school accrual was created for a month whose
 * collection was below the tier price.
 *
 * C-NEGATIVE-NET: that bound is unconditional, not a credit-balance special case. A proration CREDIT
 * LINE lowers what the invoice collects in exactly the same way and touches no `starting_balance`, and
 * an immediate mid-cycle change is billed as a credit line beside a charge line — so on both shapes
 * the line amount stated more than came in, and every reader who was told `amount_paid` already
 * reflected a credit was being told something true of one Stripe field only.
 */
function subscriptionChargeCents(
  invoice: StripeInvoice,
  line: StripeLine,
  invoiceDiscountCents: number,
): number {
  const collectedPreTax = collectedPreTaxCents(invoice);
  const collected = (amount: number): number =>
    collectedPreTax === null ? amount : Math.min(amount, collectedPreTax);
  const lineAmount = cents(line.amount);
  if (lineAmount !== null)
    return collected(Math.max(0, lineAmount - sumAmounts(line.discount_amounts)));
  const prorationCents = (invoice.lines?.data ?? [])
    .filter((l) => l !== line && l.proration === true)
    .reduce((sum, l) => sum + (cents(l.amount) ?? 0), 0);
  const excludingTax = cents(invoice.total_excluding_tax);
  const subtotal = cents(invoice.subtotal);
  const preTax =
    excludingTax !== null
      ? excludingTax
      : subtotal !== null
        ? subtotal - invoiceDiscountCents
        : (cents(invoice.amount_paid) ?? 0) - (cents(invoice.tax) ?? 0);
  return collected(Math.max(0, preTax - prorationCents));
}

/**
 * N1-TAX-APPORTION: the sales tax that belongs to THIS period's charge, which is the only tax a
 * refund of this period's money carries. `invoice.tax` is the WHOLE invoice's tax, and a renewal
 * invoice routinely also carries a mid-cycle proration line that is no part of this charge
 * (BILL-R2-4; that money is revenue on its own invoice, HUNT5-C-4). Converting a partial refund by
 * charged / (charged + WHOLE tax) therefore still scaled it down by tax belonging to a line this
 * period never booked as revenue — the residual of HUNT5-C-2, about 2% of that defect and in the same
 * direction (net revenue overstated): on subtotal 4999 = proration 1000 + subscription 3999 with tax
 * 412, a $20 refund was recorded as 1813 where the subscription's own tax gives 1848.
 *
 * So the invoice's tax is apportioned to the charge in proportion to the pre-tax amounts it was added
 * to: tax x charged / (charged + every other line's amount). All integer cents — the product is well
 * inside the safe integer range at any invoice a family can be sent, and no float rate is formed.
 * Other lines are counted whatever they are (a proration, an add-on): a larger denominator can only
 * make the share smaller, which is the safe direction below. An invoice whose only line is this
 * charge keeps the whole tax, so a tax-only renewal converts exactly as before.
 *
 * Rounding: the share is FLOORED, so it is never more than the tax really on this charge. A smaller
 * stored tax makes the refund denominator smaller and the recorded pre-tax refund larger by at most a
 * cent, i.e. net revenue understated by at most a cent rather than overstated — the same safe
 * direction migration 0900 chose for a period recorded with no tax at all, and the direction that
 * cannot make clawed-back money look like kept revenue.
 *
 * ASSUMPTION, stated because it is not free: apportioning by pre-tax amount assumes every line on the
 * invoice carries the SAME tax rate. Stripe states tax per invoice LINE, so the exact figure exists —
 * the `StripeInvoice` shape this module models simply does not carry it (it models each line's amount
 * and discount_amounts only). Where the rates really differ, this share is wrong in whichever
 * direction the other line's rate differs, and if the subscription line were the exempt one the share
 * would be overstated, which is the unsafe direction. That case needs the provider's per-line tax in
 * the model, not a cleverer ratio.
 *
 * It is NOT tracked (HUNT6-C-4, correcting a comment that sent the reader to an open item no record
 * ever held): nothing here detects differing per-line rates and nothing fails safe on them, so a
 * later reader may not assume someone is watching for this. The exact condition under
 * which it bites: the invoice carries another line whose tax rate differs from the subscription
 * line's AND the subscription line is the lower-taxed one — an exempt subscription line beside a
 * taxed add-on is the worst case. $1 of tax levied on a $10 add-on beside an exempt $39.99
 * subscription line stores floor(100 × 3999 ÷ 4999) = 79 cents of tax against a charge whose own tax
 * is 0, and every partial refund of that charge is then recorded 79/4078 of itself smaller ($20 back
 * recorded as 1961), i.e. net revenue overstated. Those numbers are pinned by the HUNT6-C-4 case in
 * apps/api/tests/billing-r2.review.test.ts so the arithmetic and this comment cannot drift apart;
 * what closes the item is modelling `lines.data[].tax_amounts` and using the subscription line's own
 * tax instead of this ratio. Every invoice PencilLift bills today is one subscription line plus
 * proration lines for the same product, so one rate applies and the share is exact.
 */
function subscriptionTaxCents(
  invoice: StripeInvoice,
  line: StripeLine,
  chargedCents: number,
): number {
  const tax = Math.max(0, cents(invoice.tax) ?? 0);
  if (tax === 0 || chargedCents <= 0) return 0;
  const otherLinesCents = (invoice.lines?.data ?? [])
    .filter((l) => l !== line)
    .reduce((sum, l) => sum + Math.max(0, cents(l.amount) ?? 0), 0);
  if (otherLinesCents <= 0) return tax;
  return Math.floor((tax * chargedCents) / (chargedCents + otherLinesCents));
}

/**
 * HUNT6-C-1: the NET of the pending proration lines an invoice lists BESIDE its subscription line.
 * Stripe's default `create_prorations` leaves a mid-cycle change to the next renewal and states it
 * there as a credit line plus a charge line, so the net of those lines is what the change really
 * added to this invoice, and `amount_paid` collected it. `subscriptionChargeCents` books the
 * subscription line alone and takes these lines back off the invoice-level fallbacks (BILL-R2-4),
 * which is right for THIS period's charge and left the money nowhere: one row was written per
 * invoice, so no month's gross held it (the owner's page understated every deferred upgrade).
 *
 * Only a positive net is money in: a net credit lowers what the invoice collected, which the
 * subscription charge already reflects through `amount_paid` (`collectedPreTaxCents` bounds it on
 * every invoice, C-NEGATIVE-NET — while that bound applied only to a credit BALANCE this sentence was
 * false of the credit LINE it was about), and a negative charge is not a billing period.
 *
 * BILL-R4-4: gross is money COLLECTED, so the net is bounded by what the collection left after the
 * subscription charge — without that bound this would book cents the invoice never took, and with it
 * the charge and the net together can never exceed the collection: charge <= collected and
 * net <= collected - charge, both in integer cents.
 */
function pendingProrationNetCents(
  invoice: StripeInvoice,
  line: StripeLine,
  chargedCents: number,
): number {
  const net = (invoice.lines?.data ?? [])
    .filter((l) => l !== line && l.proration === true)
    .reduce((sum, l) => sum + (cents(l.amount) ?? 0), 0);
  if (net <= 0) return 0;
  const collected = collectedPreTaxCents(invoice);
  return collected === null ? net : Math.max(0, Math.min(net, collected - chargedCents));
}

/**
 * HUNT7-C-4: the sales tax that belongs to the PENDING PRORATION money, i.e. to the second period this
 * invoice writes — the same apportionment `subscriptionTaxCents` performs for the first one, with the
 * pending net in the numerator instead of the subscription charge. The denominator is identical (this
 * charge plus every other line's amount), so the two shares sum to at most the invoice's tax: each is
 * FLOORED and their numerators sum to at most the denominator.
 *
 * Why the row needs a tax figure at all, when its CHARGE is already pre-tax: the figure that reaches
 * it is not its charge but the LEFTOVER of a provider amount, which is stated INCLUDING tax like every
 * other provider amount (applyRefund's walk, C-PRORATION-REVERSAL). With 0 stored, `preTaxRefundCents`
 * short-circuits and writes those tax-inclusive cents straight against a pre-tax charge — the one
 * mixed unit the whole of BILL-R4-3 / HUNT5-C-2 / HUNT6-C-2 exists to remove, on the one row whose
 * stated purpose is to hold pre-tax collected money. Flooring keeps the stored share at or below the
 * tax really levied, which can only over-record a refund (net revenue understated), never under-record
 * one: the same safe direction migration 0900 chose, and the direction that cannot make clawed-back
 * money look like kept revenue. The same-rate assumption and the case that breaks it are
 * `subscriptionTaxCents`' ASSUMPTION note, which applies here unchanged.
 */
function prorationTaxCents(
  invoice: StripeInvoice,
  line: StripeLine,
  chargedCents: number,
  pendingNetCents: number,
): number {
  const tax = Math.max(0, cents(invoice.tax) ?? 0);
  if (tax === 0 || pendingNetCents <= 0) return 0;
  const otherLinesCents = (invoice.lines?.data ?? [])
    .filter((l) => l !== line)
    .reduce((sum, l) => sum + Math.max(0, cents(l.amount) ?? 0), 0);
  const denominator = chargedCents + otherLinesCents;
  if (denominator <= 0) return 0;
  return Math.min(tax, Math.floor((tax * pendingNetCents) / denominator));
}

export function mapStripeInvoiceToPeriod(invoice: StripeInvoice): NormalizedPeriod | null {
  const line = subscriptionLine(invoice);
  const period = line?.period;
  if (!period || !line?.price?.id) return null;
  const kind =
    invoice.billing_reason === 'subscription_cycle' ||
    invoice.billing_reason === 'subscription_create'
      ? 'subscription_period'
      : invoice.billing_reason === 'subscription_update'
        ? 'proration'
        : 'addon';
  const discount = sumAmounts(invoice.total_discount_amounts);
  const chargedCents = subscriptionChargeCents(invoice, line, discount);
  const pendingNetCents = pendingProrationNetCents(invoice, line, chargedCents);
  return {
    channel: 'stripe',
    providerPeriodId: invoice.id,
    productId: line.price.id,
    kind,
    periodStart: new Date(period.start * 1000),
    periodEnd: new Date(period.end * 1000),
    chargedCents,
    // The tax on THIS charge, kept beside the pre-tax charge so a later refund can be stated in the
    // charge's unit without going back to Stripe for this invoice (HUNT5-C-2) — the invoice's tax
    // apportioned to the subscription portion, never the tax of lines this period never booked
    // (N1-TAX-APPORTION).
    taxCents: subscriptionTaxCents(invoice, line, chargedCents),
    // Money this invoice also collected for a proration item listed as pending, recorded as its own
    // period by `prorationPeriodFor` (HUNT6-C-1); no part of the charge above. Its own share of the
    // invoice's tax travels with it (HUNT7-C-4), because a refund reaches that period too and every
    // provider amount that does is stated including tax.
    pendingProrationNetCents: pendingNetCents,
    pendingProrationTaxCents: prorationTaxCents(invoice, line, chargedCents, pendingNetCents),
    reportedDiscountCents: discount,
    discountSources: discount > 0 ? ['promo_code'] : [],
    currency: (invoice.currency ?? 'usd').toUpperCase(),
    settledAt: new Date((invoice.status_transitions?.paid_at ?? period.start) * 1000),
  };
}

/**
 * The suffix that makes the second period's provider id out of the invoice's own. It is the whole link
 * between the two rows: `applyRefund` derives it to reach the proration period of the invoice a refund
 * or dispute names (C-PRORATION-REVERSAL), so it is defined once here rather than spelled out twice.
 */
export const PRORATION_PERIOD_SUFFIX = ':proration';

/**
 * The second billing period a renewal's PENDING proration money is recorded as (HUNT6-C-1): the same
 * family, channel, product and settlement instant, kind 'proration', charged the net computed above.
 * Null when the invoice listed no pending item, which is every invoice but a deferred mid-cycle
 * change. The id is derived from the invoice's own, so `recordBillingPeriod`'s (channel,
 * provider_period_id) key makes a provider retry of the same invoice.paid update this row rather
 * than write a second one.
 *
 * C-PRORATION-REVERSAL: a refund or dispute names the INVOICE, and while it was applied to the
 * primary period alone this money was unreachable — a fully refunded renewal kept its deferred
 * proration in gross with nothing reversing it. `applyRefund` walks from the invoice's period to this
 * one with whatever the primary period's own bucket could not account for.
 *
 * It therefore carries its OWN share of the invoice's tax (`pendingProrationTaxCents`,
 * HUNT7-C-4) — not 0, and not the subscription charge's share. The tax figure exists so a provider
 * amount, which is always stated INCLUDING tax, can be restated in the unit of the charge it is
 * written against (`preTaxRefundCents`); what justifies a row's tax figure is the unit of the AMOUNT
 * that reaches the row, never the unit of its charge. The amount that reaches this row is the
 * leftover, which is still tax-inclusive, so with 0 stored the conversion short-circuited and
 * tax-inclusive cents were written straight against a pre-tax charge. Tax is still never revenue: no
 * query sums this column (it is read only inside applyRefund), and a share apportioned to the
 * proration amount is the tax the family paid ON that amount.
 */
export function prorationPeriodFor(period: NormalizedPeriod): NormalizedPeriod | null {
  if (period.pendingProrationNetCents <= 0) return null;
  return {
    ...period,
    providerPeriodId: `${period.providerPeriodId}${PRORATION_PERIOD_SUFFIX}`,
    kind: 'proration',
    chargedCents: period.pendingProrationNetCents,
    taxCents: period.pendingProrationTaxCents,
    pendingProrationNetCents: 0,
    pendingProrationTaxCents: 0,
    reportedDiscountCents: 0,
    discountSources: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Ledger application
// ---------------------------------------------------------------------------------------------

export async function loadProductMappings(tx: Tx): Promise<StoreProductMapping[]> {
  const rows = await tx<
    {
      channel: BillingChannel;
      product_id: string;
      paid_slots: number;
      environment: 'sandbox' | 'production';
      active: boolean;
    }[]
  >`
    select channel, product_id, paid_slots, environment, active from public.store_product_mappings
  `;
  return rows.map((r) => ({
    channel: r.channel,
    productId: r.product_id,
    paidSlots: r.paid_slots,
    environment: r.environment,
    active: r.active,
  }));
}

async function loadRecords(tx: Tx, familyId: string): Promise<EntitlementRecord[]> {
  const rows = await tx<
    {
      channel: BillingChannel;
      provider_subscription_id: string;
      product_id: string;
      paid_slots: number;
      status: EntitlementRecord['status'];
      environment: 'sandbox' | 'production';
      period_start: Date;
      period_end: Date;
      auto_renew: boolean;
      pending_product_id: string | null;
      pending_effective_at: Date | null;
      provider_updated_at: Date;
      fetched_at: Date;
    }[]
  >`
    select channel, provider_subscription_id, product_id, paid_slots, status, environment, period_start, period_end,
           auto_renew, pending_product_id, pending_effective_at, provider_updated_at, fetched_at
      from public.family_entitlements where family_id = ${familyId} and period_start is not null and period_end is not null
  `;
  return rows.map((r) => ({
    channel: r.channel,
    providerSubscriptionId: r.provider_subscription_id,
    productId: r.product_id,
    status: r.status,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    autoRenew: r.auto_renew,
    environment: r.environment,
    providerUpdatedAt: r.provider_updated_at,
    fetchedAt: r.fetched_at,
    ...(r.pending_product_id === null ? {} : { pendingProductId: r.pending_product_id }),
    ...(r.pending_effective_at === null ? {} : { pendingEffectiveAt: r.pending_effective_at }),
    paidSlots: r.paid_slots,
    mappingError: null,
    pendingPaidSlots: null,
  }));
}

/** The provider state of a ledger row, without its observation instants. */
function materialState(r: ProviderSubscriptionSnapshot): string {
  return JSON.stringify([
    r.productId,
    r.status,
    r.periodStart.toISOString(),
    r.periodEnd.toISOString(),
    r.autoRenew,
    r.pendingProductId ?? null,
    r.pendingEffectiveAt?.toISOString() ?? null,
  ]);
}

/**
 * BILL-R1-2: every snapshot reaching the ledger comes from a COMPLETE provider fetch (never from an
 * event payload), and a complete fetch is authoritative for state removals. RevenueCat derives no
 * last-modified instant, so `providerUpdatedAt` is the latest of the markers present; when a
 * marker is cleared (auto-renew turned back on clears `unsubscribe_detected_at`, a recovered
 * billing issue clears `billing_issues_detected_at`) the new snapshot's instant falls back to an
 * older one and the domain would discard the provider's current answer as stale until the next
 * renewal. A fetch made LATER than the stored observation that reports DIFFERENT state is
 * therefore ordered by its fetch instant. Every LATER fetch of the same, unchanged state still
 * carries the provider's older instant (the stamp lives only in our row), so it is ordered by the
 * stored observation instead: the domain records it as `refreshed` and `fetched_at` advances,
 * which the stale-entitlement sweep relies on to rotate past the family (BILL-R1-3). A fetch made
 * earlier (two reconciliations racing, the older one committing last) keeps the provider's own
 * instant and stays ignored, and a fetch at the very same instant falls back to the domain's
 * fail-closed tie rule. Replayed webhook events never reach this code with their own timestamps.
 */
function orderCompleteFetch(
  records: readonly EntitlementRecord[],
  snapshot: ProviderSubscriptionSnapshot,
): ProviderSubscriptionSnapshot {
  const stored = records.find(
    (r) =>
      r.channel === snapshot.channel &&
      r.providerSubscriptionId === snapshot.providerSubscriptionId,
  );
  if (!stored) return snapshot;
  const storedObservedAt = Math.min(stored.providerUpdatedAt.getTime(), stored.fetchedAt.getTime());
  if (
    snapshot.providerUpdatedAt.getTime() < storedObservedAt &&
    snapshot.fetchedAt.getTime() > stored.fetchedAt.getTime()
  ) {
    return materialState(snapshot) !== materialState(stored)
      ? { ...snapshot, providerUpdatedAt: snapshot.fetchedAt }
      : { ...snapshot, providerUpdatedAt: new Date(storedObservedAt) };
  }
  return snapshot;
}

/**
 * Reconciles fetched provider snapshots into the family ledger and recomputes paid capacity (MAX,
 * never a sum). If capacity falls below the number of assigned slots, the most recently assigned
 * slots outside a scheduled downgrade's keep-list are released; history is never deleted.
 */
export async function applySnapshots(
  tx: Tx,
  familyId: string,
  snapshots: readonly ProviderSubscriptionSnapshot[],
  runtimeEnvironment: 'sandbox' | 'production',
  now: Date,
): Promise<FamilyCapacity> {
  const mappings = await loadProductMappings(tx);
  let records = await loadRecords(tx, familyId);
  // A provider timestamp later than our own observation time (clock skew or bad data) would make
  // every later genuine observation, including a refund, look stale (RV-entitlements-1). Clamp it.
  // The domain also rejects providerUpdatedAt > fetchedAt and fetchedAt > now, so bound both.
  const bounded = snapshots.map((s) => {
    const fetchedAt = s.fetchedAt.getTime() > now.getTime() ? now : s.fetchedAt;
    const providerUpdatedAt =
      s.providerUpdatedAt.getTime() > fetchedAt.getTime() ? fetchedAt : s.providerUpdatedAt;
    return { ...s, fetchedAt, providerUpdatedAt };
  });
  for (const snapshot of bounded) {
    records = [
      ...reconcileEntitlements(
        records,
        orderCompleteFetch(records, snapshot),
        mappings,
        runtimeEnvironment,
        now,
      ).records,
    ];
  }
  for (const r of records) {
    const written = await tx`
      insert into public.family_entitlements (family_id, channel, provider_subscription_id, product_id, paid_slots, status,
        environment, period_start, period_end, auto_renew, pending_product_id, pending_effective_at, provider_updated_at, fetched_at)
      values (${familyId}, ${r.channel}, ${r.providerSubscriptionId}, ${r.productId}, ${r.paidSlots}, ${r.status},
        ${r.environment}, ${r.periodStart}, ${r.periodEnd}, ${r.autoRenew}, ${r.pendingProductId ?? null},
        ${r.pendingEffectiveAt ?? null}, ${r.providerUpdatedAt}, ${r.fetchedAt})
      on conflict (channel, provider_subscription_id) do update set
        product_id = excluded.product_id, paid_slots = excluded.paid_slots, status = excluded.status,
        period_start = excluded.period_start, period_end = excluded.period_end, auto_renew = excluded.auto_renew,
        pending_product_id = excluded.pending_product_id, pending_effective_at = excluded.pending_effective_at,
        provider_updated_at = excluded.provider_updated_at, fetched_at = excluded.fetched_at
      where public.family_entitlements.family_id = ${familyId}
      returning id
    `;
    // A provider subscription id already owned by another family must fail loudly, never be skipped
    // silently (BUG-006): capacity would otherwise be computed from rows that were not stored.
    if (written.length !== 1) throw new SubscriptionBoundElsewhere();
  }
  const capacity = computeFamilyCapacity(records, runtimeEnvironment, now);
  await tx`
    insert into public.family_capacity (family_id, paid_slots, managing_channel, conflict, pending_target_slots, pending_effective_at)
    values (${familyId}, ${capacity.paidSlots}, ${capacity.managingChannel}, ${capacity.conflict},
            ${capacity.pendingChange?.targetSlots ?? null}, ${capacity.pendingChange?.effectiveAt ?? null})
    on conflict (family_id) do update set
      paid_slots = excluded.paid_slots, managing_channel = excluded.managing_channel, conflict = excluded.conflict,
      pending_target_slots = excluded.pending_target_slots, pending_effective_at = excluded.pending_effective_at
  `;
  const open = await tx<{ id: string; child_id: string }[]>`
    select id, child_id from public.child_slot_assignments where family_id = ${familyId} and released_at is null
     order by assigned_at desc
  `;
  const excess = open.length - capacity.paidSlots;
  if (excess > 0) {
    const [keep] = await tx<{ keep_child_ids: string[] }[]>`
      select keep_child_ids from public.capacity_changes
       where family_id = ${familyId} and kind = 'downgrade' and status = 'scheduled' order by created_at desc limit 1
    `;
    const keepSet = new Set(keep?.keep_child_ids ?? []);
    const ordered = [
      ...open.filter((o) => !keepSet.has(o.child_id)),
      ...open.filter((o) => keepSet.has(o.child_id)),
    ];
    for (const slot of ordered.slice(0, excess)) {
      await tx`
        update public.child_slot_assignments set released_at = ${now},
          release_reason = ${capacity.paidSlots === 0 ? 'expired' : 'downgrade'}
         where id = ${slot.id}
      `;
    }
  }
  return capacity;
}

function resolveSlots(
  period: NormalizedPeriod,
  mappings: readonly StoreProductMapping[],
  env: 'sandbox' | 'production',
): number | null {
  const mapping = mappings.find(
    (m) =>
      m.channel === period.channel &&
      m.productId === period.productId &&
      m.environment === env &&
      m.active,
  );
  return mapping ? mapping.paidSlots : null;
}

/**
 * The only currency the price table, the donation rule and the revenue view are defined in. The
 * launch market is the United States (Owner action #38); a period in any other currency is still
 * recorded with its currency, audited, and left out of every USD sum (BILL-R1-5).
 */
export const REVENUE_CURRENCY = 'USD';

/** Records a provider billing period (idempotent by channel + provider id). Returns its row id. */
export async function recordBillingPeriod(
  tx: Tx,
  familyId: string,
  period: NormalizedPeriod,
  runtimeEnvironment: 'sandbox' | 'production',
): Promise<{ id: string; paidSlots: number; regularCents: number } | null> {
  const mappings = await loadProductMappings(tx);
  const paidSlots = resolveSlots(period, mappings, runtimeEnvironment);
  if (paidSlots === null) return null;
  const regular = tryMonthlyPriceCents(paidSlots);
  const regularCents = regular.ok ? regular.value : monthlyPriceCents(Math.min(paidSlots, 4));
  const discountCents =
    period.reportedDiscountCents ??
    (period.discountSources.length > 0 ? Math.max(0, regularCents - period.chargedCents) : 0);
  const [row] = await tx<{ id: string; inserted: boolean }[]>`
    insert into public.billing_periods (family_id, channel, provider_period_id, kind, period_start, period_end, paid_slots,
      regular_amount_cents, charged_amount_cents, discount_cents, discount_sources, settlement, settled_at, currency,
      tax_amount_cents)
    values (${familyId}, ${period.channel}, ${period.providerPeriodId}, ${period.kind}, ${period.periodStart}, ${period.periodEnd},
      ${paidSlots}, ${regularCents}, ${period.chargedCents}, ${discountCents}, ${period.discountSources}, 'settled',
      ${period.settledAt}, ${period.currency}, ${period.taxCents})
    on conflict (channel, provider_period_id) do update set
      settlement = case when public.billing_periods.settlement in ('refunded', 'partially_refunded', 'chargeback')
                        then public.billing_periods.settlement else 'settled' end,
      settled_at = coalesce(public.billing_periods.settled_at, excluded.settled_at)
    returning id, (xmax = 0) as inserted
  `;
  if (row!.inserted && period.currency !== REVENUE_CURRENCY) {
    // BILL-R1-5 / Owner action #38: launch is US-only and every amount downstream is USD cents.
    // The period is kept with its currency for the record; the owner is told (no amounts: the
    // audit trail states the fact, the period row holds the figure).
    await tx`
      insert into public.audit_events (family_id, actor_kind, action, target_type, target_id, metadata)
      values (${familyId}, 'system', 'billing.unexpected_currency', 'billing_period', ${period.providerPeriodId},
              ${JSON.stringify({ channel: period.channel, currency: period.currency })}::text::jsonb)
    `;
  }
  // A refund that arrived before this charge is applied now (RV-lead-billing-p17-3), in the SAME unit
  // as one that arrives after it (HUNT6-C-3): a Stripe amount is tax-inclusive whenever it was
  // delivered, and the tax it is restated by is in the row inserted just above, in this transaction.
  // `pending_refunds` records no provider total, which is why the unit may not be inferred from one.
  const [parked] = await tx<{ kind: SettlementEvent; refunded_cents: number | null }[]>`
    delete from public.pending_refunds
     where channel = ${period.channel} and provider_period_id = ${period.providerPeriodId} and family_id = ${familyId}
    returning kind, refunded_cents
  `;
  if (parked) {
    await applyRefund(
      tx,
      familyId,
      period.channel,
      period.providerPeriodId,
      parked.kind,
      parked.refunded_cents,
      period.channel === 'stripe',
    );
  }
  return { id: row!.id, paidSlots, regularCents };
}

const MATCH_TOLERANCE_MS = 6 * 3600 * 1000;

/**
 * Promotion reconciliation (spec P17): a charged period on a channel resolves that family's in-flight
 * redemption targeting it. A discounted charge confirms it with the provider's actual amounts; a
 * full-price charge for the targeted period means the offer did not apply, so it is rejected. The
 * previously confirmed benefit of another period is never touched.
 */
export async function reconcilePromotionsForPeriod(
  tx: Tx,
  familyId: string,
  period: NormalizedPeriod,
  regularCents: number,
  isFirstPurchase: boolean,
): Promise<{ confirmed: string[]; rejected: string[] }> {
  const candidates = await tx<
    {
      id: string;
      state: RedemptionState;
      target_period_key: string;
      target_period_start: Date | null;
    }[]
  >`
    select id, state, target_period_key, target_period_start from public.promo_redemptions
     where family_id = ${familyId} and channel = ${period.channel} and state in ('reserved', 'provider_pending')
     for update
  `;
  const firstPrefix = `first:${period.channel}`;
  const matching = candidates.filter((r) => {
    const key = r.target_period_key;
    if (key === firstPrefix) return isFirstPurchase;
    if (key.startsWith(`${firstPrefix}:`)) {
      // A lapsed family's first period after the lapse (RV-lead-billing-p17-1): the store may
      // report the re-subscription as an initial purchase or as a renewal.
      const lapsedEnd = Date.parse(key.slice(firstPrefix.length + 1));
      return (
        !Number.isNaN(lapsedEnd) && period.periodStart.getTime() >= lapsedEnd - MATCH_TOLERANCE_MS
      );
    }
    return (
      !isFirstPurchase &&
      r.target_period_start !== null &&
      Math.abs(r.target_period_start.getTime() - period.periodStart.getTime()) <= MATCH_TOLERANCE_MS
    );
  });
  const confirmed: string[] = [];
  const rejected: string[] = [];
  const discounted = period.discountSources.includes('promo_code');
  for (const r of matching) {
    let state = r.state;
    if (state === 'reserved') {
      const submitted = transitionRedemption(state, 'submit_to_provider');
      if (!submitted.ok) continue;
      state = submitted.value;
    }
    const next = transitionRedemption(
      state,
      discounted ? 'reconcile_applied' : 'reconcile_not_applied',
    );
    if (!next.ok) continue;
    if (next.value === 'confirmed') {
      const charged = Math.min(period.chargedCents, regularCents);
      await tx`
        update public.promo_redemptions set state = 'provider_pending' where id = ${r.id} and state = 'reserved'
      `;
      await tx`
        update public.promo_redemptions
           set state = 'confirmed', confirmed_at = now(), charged_cents = ${charged}, discount_cents = ${regularCents - charged},
               regular_cents = ${regularCents}, provider_reference = ${period.providerPeriodId}, target_period_start = ${period.periodStart}
         where id = ${r.id}
      `;
      await tx`
        insert into public.promo_benefit_periods (redemption_id, family_id, channel, provider_period_id, period_start, period_end)
        values (${r.id}, ${familyId}, ${period.channel}, ${period.providerPeriodId}, ${period.periodStart}, ${period.periodEnd})
        on conflict do nothing
      `;
      confirmed.push(r.id);
    } else {
      await tx`update public.promo_redemptions set state = 'provider_pending' where id = ${r.id} and state = 'reserved'`;
      await tx`update public.promo_redemptions set state = 'rejected' where id = ${r.id}`;
      rejected.push(r.id);
    }
  }
  if (discounted && matching.length === 0) {
    // A store-applied promo discount with no PencilLift redemption (e.g. a shared App Store code
    // redeemed outside the app). The charged amount already zeroes the donation for this period;
    // flag it so the owner reconciles campaign caps/budget instead of silently under-counting.
    await tx`
      insert into public.audit_events (family_id, actor_kind, action, target_type, target_id, metadata)
      values (${familyId}, 'system', 'promo.unmatched_discount', 'billing_period', ${period.providerPeriodId},
              ${JSON.stringify({ channel: period.channel, periodStart: period.periodStart.toISOString() })}::text::jsonb)
    `;
  }
  return { confirmed, rejected };
}

/** Refund/chargeback: marks the period and records exactly one donation reversal if it had accrued. */
export type SettlementEvent = 'refund' | 'partial_refund' | 'chargeback' | 'chargeback_reversed';

/**
 * BILL-R4-3: a provider refund amount is money the family got back INCLUDING US sales tax, while
 * `charged_amount_cents` is the pre-tax subscription amount (BILL-R2-4). The cap at the charge makes
 * a FULL refund exact (everything came back), but a PARTIAL refund of a taxed charge recorded the
 * tax-inclusive figure against a pre-tax gross, and the revenue view computes net = gross − refunds,
 * so net revenue was understated by the tax share of every partial refund.
 *
 * HUNT5-C-2: the ratio may take off the TAX and nothing else. It used to divide by the whole Charge —
 * i.e. by the invoice total — and a renewal invoice carrying a mid-cycle proration line is the normal
 * shape for a family that added a child, Stripe putting the pending proration item on the next
 * renewal. That line is no part of THIS period's charge (BILL-R2-4, `subscriptionChargeCents` books
 * the subscription line only; the proration money is revenue on its own invoice, HUNT5-C-4), so
 * dividing by a total that includes it attributed part of the refund to money this period's gross
 * never counted: a $39.99 refund on a 3999 + 1000 invoice was recorded as
 * round(3999 × 3999 ÷ 4999) = 3199, and the owner's net revenue read 799 cents of kept subscription
 * revenue for a period whose whole charge had come back.
 *
 * So the denominator is the charge plus THAT charge's tax: pre-tax refund =
 * refunded × charged ÷ (charged + tax), rounded half up to the cent and never above the charge.
 * `taxCents` is the tax stored with the period at invoice.paid time (billing_periods.tax_amount_cents,
 * migration 0900) — the refund webhook never goes back to the provider for the invoice. N1-TAX-APPORTION:
 * it is the invoice's tax APPORTIONED TO THIS CHARGE (subscriptionTaxCents), because a proration line's
 * tax is as much outside this period's revenue as the proration line itself; passing the invoice's
 * whole tax here scaled a partial refund down by tax this period never booked. A period recorded
 * BEFORE that migration has tax 0, which makes the ratio 1 and this an exact no-op; that is the
 * pre-BILL-R4-3 behaviour, not a bug.
 *
 * `amountIsTaxInclusive` says the amount is a provider figure stated INCLUDING tax, and it is
 * threaded from the call site rather than inferred from anything that merely correlates with it
 * (HUNT6-C-2, HUNT6-C-3). It is true for EVERY Stripe figure — a Charge's `amount_refunded`, a
 * Dispute's `amount`, and a Stripe refund replayed from `pending_refunds` — because all three are
 * parts of what the family paid; a Dispute states no charge total, and a parked row stores none, but
 * neither fact says anything about the unit, and inferring the conversion from a total's presence
 * left a dispute and an early-arriving refund recorded in a different unit from the refund beside
 * them. It is false for the RevenueCat store path, whose refunds carry no amount at all. A refund of
 * the whole charge converts to the whole charge, which is what the cap would have said anyway.
 */
export function preTaxRefundCents(
  refundedCents: number,
  amountIsTaxInclusive: boolean,
  chargedCents: number,
  taxCents: number,
): number {
  if (!amountIsTaxInclusive || !Number.isSafeInteger(taxCents) || taxCents <= 0) {
    return refundedCents;
  }
  return Math.min(
    chargedCents,
    Math.round((refundedCents * chargedCents) / (chargedCents + taxCents)),
  );
}

/**
 * What one period absorbed of a provider settlement event. `applied: false` means no such period is
 * recorded (the event was parked, or a won dispute had nothing to give back).
 */
type PeriodSettlement =
  | { readonly applied: false; readonly pending: boolean }
  | {
      readonly applied: true;
      readonly adjusted: boolean;
      /**
       * What is LEFT of the caller's amount above what this period could account for, still in the
       * caller's unit and never negative. What it can account for is the room its bucket has — its
       * whole charge for a CUMULATIVE provider figure, the charge less what was already genuinely
       * refunded for an INCREMENTAL one (HUNT7-C-1) — plus, for a tax-inclusive amount, the tax
       * proportional to that room. Null when the event carried no amount at all, which means "the
       * whole charge" for every period it reaches. This is what walks a refund on to the invoice's
       * proration period (C-PRORATION-REVERSAL).
       */
      readonly leftoverCents: number | null;
    };

/**
 * Refund/chargeback (and a won dispute) for the ONE period `providerPeriodId` names: marks it and
 * records at most one donation reversal (or reinstatement). A full `refund` with a provider amount
 * below the charge is recorded as partial (RV-lead-billing-p17-7). An event for a period we have not
 * recorded yet is parked in `pending_refunds` and applied when the period arrives
 * (RV-lead-billing-p17-3) — but only when `park`, because the second period of an invoice is absent
 * from almost every invoice and its absence is not something to wait for. A `chargeback` reverses the
 * disputed amount, or the whole charge when the provider reports none (BILL-R1-1): the revenue view
 * and the admin case detail read `refunded_cents`, so a lost dispute must never look like kept
 * revenue. A `chargeback_reversed` (dispute won) gives that amount back, so the period returns to
 * settled/0 (and the $1 donation is reinstated) unless an earlier partial refund remains;
 * `refundedCents` is then the reversed amount, null meaning the whole charge.
 *
 * `amountIsTaxInclusive` says the caller's amount is a provider figure stated INCLUDING sales tax, so
 * it is restated in the unit of `charged_amount_cents` before anything is decided by it — by the tax
 * stored for this period's own charge (see preTaxRefundCents, BILL-R4-3 / HUNT5-C-2 /
 * N1-TAX-APPORTION / HUNT6-C-2). It is true for every Stripe amount, including a Dispute's and a
 * Stripe refund replayed from `pending_refunds`, and false for the store channels, which report no
 * amount.
 *
 * HUNT7-C-2: one unit is what makes the two figures COMPARABLE; it is not what makes a chargeback that
 * ADDS and a won dispute that SUBTRACTS round-trip. The addition is capped at the charge, so on any
 * invoice where `refunded + disputed` exceeds it the cap clips the addition while the subtraction took
 * the whole amount — and a genuine earlier refund was erased. What the dispute added is recorded
 * (`chargeback_cents`) and the reversal gives back exactly that, so the round trip is exact whatever
 * the cap did and whatever was refunded before.
 */
async function applySettlementToPeriod(
  tx: Tx,
  familyId: string,
  channel: BillingChannel,
  providerPeriodId: string,
  kind: SettlementEvent,
  refundedCents: number | null,
  amountIsTaxInclusive: boolean,
  park: boolean,
): Promise<PeriodSettlement> {
  if (refundedCents !== null && (!Number.isSafeInteger(refundedCents) || refundedCents < 0)) {
    throw new RangeError('refundedCents must be null or a non-negative integer number of cents');
  }
  const [current] = await tx<
    {
      id: string;
      charged_amount_cents: number;
      tax_amount_cents: number;
      refunded_cents: number;
      chargeback_cents: number;
      settlement: string;
    }[]
  >`
    select id, charged_amount_cents, tax_amount_cents, refunded_cents, chargeback_cents, settlement
      from public.billing_periods
     where family_id = ${familyId} and channel = ${channel} and provider_period_id = ${providerPeriodId}
     for update
  `;
  if (!current) {
    // C-PRORATION-REVERSAL: a won dispute has nothing to give back, and a period that is not this
    // invoice's primary one is simply not there on almost every invoice — parking either would leave a
    // `pending_refunds` row that no future period can ever consume.
    if (kind === 'chargeback_reversed' || !park) return { applied: false, pending: false };
    await tx`
      insert into public.pending_refunds (family_id, channel, provider_period_id, kind, refunded_cents)
      values (${familyId}, ${channel}, ${providerPeriodId}, ${kind}, ${refundedCents})
      on conflict (channel, provider_period_id) do update
        set kind = case when excluded.kind = 'chargeback' or public.pending_refunds.kind = 'chargeback' then 'chargeback'
                        when excluded.kind = 'refund' or public.pending_refunds.kind = 'refund' then 'refund'
                        else 'partial_refund' end,
            refunded_cents = greatest(public.pending_refunds.refunded_cents, excluded.refunded_cents)
        where public.pending_refunds.family_id = ${familyId}
    `;
    return { applied: false, pending: true };
  }
  // BILL-R4-3: state the provider's amount in the unit of the recorded charge before anything is
  // decided by it (a partial refund of a taxed charge is otherwise compared with, and written
  // against, a pre-tax figure). HUNT5-C-2 / N1-TAX-APPORTION: by the tax on THIS charge, stored with
  // the period at invoice.paid time (the invoice's tax apportioned to the subscription portion) — 0
  // for a period recorded before migration 0900, which makes the ratio 1 and the conversion a no-op
  // rather than a wrong number.
  const inCharge =
    refundedCents === null
      ? null
      : preTaxRefundCents(
          refundedCents,
          amountIsTaxInclusive,
          current.charged_amount_cents,
          current.tax_amount_cents,
        );
  // HUNT7-C-1: a provider states some of these figures CUMULATIVELY and some INCREMENTALLY, and one
  // expression was serving both.
  //   - `refund` and `partial_refund` carry a Charge's `amount_refunded`, which is everything refunded
  //     on that charge SO FAR. Such a figure already covers every earlier refund, so it is measured
  //     against this period's WHOLE bucket and the SQL below takes the greatest, never a sum.
  //   - `chargeback` and `chargeback_reversed` carry a Dispute's `amount`, which states only the newly
  //     disputed part. The SQL ADDS it, so it must be measured against what the bucket still has ROOM
  //     for — the charge less what has genuinely been refunded already. Measured against the bucket's
  //     SIZE, the leftover was 0 exactly when the cap clipped the addition, so the clipped cents
  //     reached no row at all: on an invoice with a ':proration' sibling a partial refund followed by
  //     a dispute of the remainder clawed back every cent the family paid while the owner's page still
  //     counted the proration money as kept revenue.
  const refundedPartCents = Math.max(0, current.refunded_cents - current.chargeback_cents);
  const statesOnlyTheNewPart = kind === 'chargeback' || kind === 'chargeback_reversed';
  const roomCents = statesOnlyTheNewPart
    ? Math.max(0, current.charged_amount_cents - refundedPartCents)
    : current.charged_amount_cents;
  // C-PRORATION-REVERSAL: what is LEFT of the caller's amount above what this period can account for,
  // still in the caller's unit — that room plus, for a tax-inclusive figure, the tax proportional to
  // it, which is the whole stored tax whenever the whole bucket is free (so a period nothing has
  // touched behaves exactly as it did). The share is FLOORED, so the leftover is never understated:
  // the direction that cannot leave clawed-back money reading as kept revenue. It is computed from
  // the genuinely REFUNDED part, which a chargeback and the won dispute that reverses it both leave
  // unchanged, so the two hand the next period the same number and round-trip on it exactly as here.
  const roomInProviderUnitCents =
    roomCents +
    (amountIsTaxInclusive && current.charged_amount_cents > 0
      ? Math.floor(
          (Math.max(0, current.tax_amount_cents) * roomCents) / current.charged_amount_cents,
        )
      : 0);
  const leftoverCents =
    refundedCents === null ? null : Math.max(0, refundedCents - roomInProviderUnitCents);
  const effective: SettlementEvent =
    kind === 'refund' && inCharge !== null && inCharge < current.charged_amount_cents
      ? 'partial_refund'
      : kind;
  // BILL-R1-1: a chargeback reverses the disputed amount (the whole charge when the provider
  // reports none) ON TOP of what was refunded before it, capped at the charge, so the revenue view
  // never counts clawed-back money as kept. A repeated dispute event for a period already in
  // 'chargeback' only ever raises the figure (idempotent replay, never a double count). A won
  // dispute (chargeback_reversed) gives the disputed amount back, so an earlier genuine partial
  // refund survives the win as 'partially_refunded'.
  //
  // HUNT7-C-2: the unit is what HUNT6-C-2 fixed and it is necessary, not sufficient. Add-then-cap and
  // subtract are the same number only while `refunded + disputed <= charged`, and HUNT6-C-1's second
  // period is exactly the invoice shape where they are not: the provider's total is this charge plus
  // the pending proration net plus the invoice's whole tax, while this row's cap is its own charge. So
  // what the dispute really ADDED is stored (`chargeback_cents`, migration 0950) and the reversal
  // gives back exactly that. While it subtracted the whole converted amount from a figure the cap had
  // clipped, a family refunded $10 who then lost and won a dispute of the remaining 3999 was recorded
  // as never refunded at all: their own support case said the store had reported no refund, and the
  // school's $1 was reinstated (planAdjustment reinstates only on settled-with-nothing-refunded) for a
  // month they were partly refunded for.
  //
  // The two figures below and the invariant between them: `refunded_cents` is everything clawed back
  // and `chargeback_cents` is the part of it an OPEN dispute contributed, so the family's genuine
  // refund is the difference, and 0 <= chargeback_cents <= refunded_cents <= charged (the 0950 checks
  // enforce it). A refund that grows takes room back from the dispute's part first, never from itself.
  //
  // BILL-R2-4: every per-row figure is still capped at charged_amount_cents, unchanged. A provider
  // reports what the family paid INCLUDING sales tax, while the charge recorded here is the pre-tax
  // subscription amount; without the cap a fully refunded taxed renewal would book a refund larger
  // than the revenue it reverses and the owner's net revenue would go negative.
  const [period] = await tx<
    {
      id: string;
      settlement: 'settled' | 'refunded' | 'partially_refunded' | 'chargeback';
      refunded_cents: number;
    }[]
  >`
    update public.billing_periods
       set settlement = case
             when ${effective} = 'chargeback_reversed' then
               case when plan.prior_settlement <> 'chargeback' then plan.prior_settlement
                    when plan.next_chargeback > 0 then 'chargeback'
                    when plan.next_refund >= plan.charged then 'refunded'
                    when plan.next_refund > 0 then 'partially_refunded'
                    else 'settled' end
             when ${effective} = 'chargeback' then 'chargeback'
             when ${effective} = 'partial_refund' then
               case when plan.prior_settlement in ('refunded', 'chargeback') then plan.prior_settlement
                    else 'partially_refunded' end
             else 'refunded' end,
           refunded_cents = least(plan.charged, plan.next_refund + plan.next_chargeback),
           chargeback_cents = plan.next_chargeback
      from (
        select p1.charged, p1.prior_settlement, p1.next_refund,
               -- What an OPEN dispute has contributed to refunded_cents after this event.
               case
                 when ${effective} = 'chargeback' then
                   -- The dispute states only its new part, so add what this row still has ROOM for and
                   -- record exactly that. A replay only ever raises it, never sums twice.
                   greatest(p1.dispute_part,
                            least(coalesce(${inCharge}::int, p1.charged),
                                  greatest(0, p1.charged - p1.refund_part)))
                 when ${effective} = 'chargeback_reversed' then
                   -- Give back what the dispute added and no more (HUNT7-C-2); a win on a row no
                   -- dispute touched changes nothing.
                   case when p1.prior_settlement <> 'chargeback' then p1.dispute_part
                        else p1.dispute_part
                               - least(p1.dispute_part, coalesce(${inCharge}::int, p1.dispute_part)) end
                 else least(p1.dispute_part, greatest(0, p1.charged - p1.next_refund))
               end as next_chargeback
          from (
            select p0.charged, p0.prior_settlement, p0.refund_part, p0.dispute_part,
                   -- What the family has genuinely been REFUNDED after this event. A provider refund
                   -- figure is cumulative, so it is taken at its greatest and never summed; a full
                   -- refund is the whole charge (a stated amount below it is 'partial_refund',
                   -- RV-lead-billing-p17-7).
                   case
                     when ${effective} = 'refund' then p0.charged
                     when ${effective} = 'partial_refund'
                       then least(p0.charged, greatest(p0.refund_part, ${inCharge ?? 0}))
                     else p0.refund_part
                   end as next_refund
              from (
                select charged_amount_cents as charged,
                       settlement as prior_settlement,
                       greatest(0, refunded_cents - chargeback_cents) as refund_part,
                       chargeback_cents as dispute_part
                  from public.billing_periods where id = ${current.id}
              ) p0
          ) p1
      ) plan
     where public.billing_periods.id = ${current.id}
     returning public.billing_periods.id, public.billing_periods.settlement,
               public.billing_periods.refunded_cents
  `;
  const [accrual] = await tx<
    { id: string; amount_cents: number; payout_batch_id: string | null }[]
  >`
    select id, amount_cents, payout_batch_id from public.donation_accruals where billing_period_id = ${period!.id}
  `;
  const settled = { applied: true, leftoverCents } as const;
  if (!accrual) return { ...settled, adjusted: false };
  const existing = await tx<
    { idempotency_key: string }[]
  >`select idempotency_key from public.donation_adjustments where accrual_id = ${accrual.id}`;
  const adjustment = planAdjustment({
    accrual: {
      id: accrual.id,
      amountCents: accrual.amount_cents,
      payoutStatus: accrual.payout_batch_id ? 'paid' : 'unpaid',
    },
    event: effective,
    existingAdjustmentKeys: new Set(existing.map((e) => e.idempotency_key)),
    providerState: { settlement: period!.settlement, refundedCents: period!.refunded_cents },
  });
  if (!adjustment) return { ...settled, adjusted: false };
  const rows = await tx`
    insert into public.donation_adjustments (accrual_id, amount_cents, reason, idempotency_key)
    values (${accrual.id}, ${adjustment.amountCents}, ${adjustment.event}, ${adjustment.idempotencyKey})
    on conflict (idempotency_key) do nothing
    returning id
  `;
  return { ...settled, adjusted: rows.length > 0 };
}

/**
 * A provider refund, chargeback or won dispute for ONE provider invoice/transaction, applied to EVERY
 * period that invoice wrote.
 *
 * C-PRORATION-REVERSAL — exactly which rows a given provider refund touches. Stripe names the
 * INVOICE (a Charge or a Dispute is resolved to it in webhooks.ts), and one invoice can hold two
 * periods: its subscription charge and, when Stripe listed a mid-cycle item on it as pending, the
 * ':proration' period that holds the money collected for that item (HUNT6-C-1, `prorationPeriodFor`).
 * The amount is applied to the primary period first, in that period's own unit and capped at its
 * charge; whatever is LEFT of the provider's amount above what that period could account for then
 * reaches the ':proration' period, in ITS own unit (it carries its own apportioned share of the
 * invoice's tax, HUNT7-C-4) and capped at its charge. What a period can account for is the room its
 * bucket has, which depends on how the provider states the figure (HUNT7-C-1):
 *   - a CUMULATIVE figure (a Charge's `amount_refunded`) already covers every earlier refund, so it is
 *     measured against the whole bucket: the charge plus, for a tax-inclusive amount, the tax on it;
 *   - an INCREMENTAL figure (a Dispute's `amount`, which the SQL adds on top) is measured against what
 *     the bucket has LEFT — the charge less what was already genuinely refunded, plus the tax
 *     proportional to that remainder. Measured against the bucket's size instead, the leftover was 0
 *     exactly when the cap clipped the addition, so a partial refund followed by a dispute of the
 *     remainder reached the ':proration' row with nothing and that money stayed in gross as revenue.
 * So:
 *   - a refund that fits inside the primary period's bucket touches the primary row only;
 *   - a FULL refund always reaches both, because the provider's amount is charge + pending net + the
 *     invoice's WHOLE tax while the primary bucket holds the charge and only its own apportioned share
 *     of that tax, so leftover = pending net + (whole tax − apportioned share) >= pending net;
 *   - an event with no amount at all (a store refund, a dispute that states none) is "the whole
 *     charge" on both rows;
 *   - an invoice with no pending item has no second row, and the extra lookup finds nothing.
 * While the match was the primary period id alone, a FULLY refunded renewal that had carried a
 * deferred proration left that money in gross with nothing reversing it: clawed-back money reading as
 * kept revenue, which is the direction every figure here is ordered to fail the other way.
 *
 * The leftover is computed from the genuinely refunded part, which a chargeback and the won dispute
 * that reverses it both leave unchanged, so for one dispute amount the two hand the proration period
 * the same number and round-trip on it exactly as they do on the primary. Nothing is ever parked
 * against the derived id: its absence is the normal case, not an ordering to wait for. Returns whether
 * a donation adjustment was written (only the primary period can carry an accrual: eligibility reads
 * subscription periods).
 */
export async function applyRefund(
  tx: Tx,
  familyId: string,
  channel: BillingChannel,
  providerPeriodId: string,
  kind: SettlementEvent,
  refundedCents: number | null,
  amountIsTaxInclusive = false,
): Promise<{ adjusted: boolean; pending?: boolean }> {
  const primary = await applySettlementToPeriod(
    tx,
    familyId,
    channel,
    providerPeriodId,
    kind,
    refundedCents,
    amountIsTaxInclusive,
    true,
  );
  if (!primary.applied) {
    return primary.pending ? { adjusted: false, pending: true } : { adjusted: false };
  }
  // Already the derived row (nothing calls it that way today); never derive a third id from it.
  if (providerPeriodId.endsWith(PRORATION_PERIOD_SUFFIX)) return { adjusted: primary.adjusted };
  const leftover = primary.leftoverCents;
  if (leftover !== null && leftover <= 0) return { adjusted: primary.adjusted };
  const secondary = await applySettlementToPeriod(
    tx,
    familyId,
    channel,
    `${providerPeriodId}${PRORATION_PERIOD_SUFFIX}`,
    kind,
    leftover,
    amountIsTaxInclusive,
    false,
  );
  return { adjusted: primary.adjusted || (secondary.applied && secondary.adjusted) };
}

const TARGET_ELAPSED_MS = 35 * 24 * 3600 * 1000;
const FIRST_PERIOD_TIMEOUT_MS = 30 * 24 * 3600 * 1000;
const ENDED_STATUSES = new Set(['expired', 'revoked', 'refunded']);

/**
 * Resolves in-flight (provider_pending) redemptions whose target can no longer happen
 * (RV-lead-billing-p17-2), so a family is never blocked for good and a cap slot never leaks. Only
 * provider-derived facts decide: the channel's subscription ended at or before the targeted
 * renewal, or the targeted month has fully elapsed without any matching charge, or a first-period
 * redemption saw no subscription start for 30 days. Resolved rows become `rejected` (the offer
 * cannot have applied); confirmed benefits are never touched.
 */
export async function resolveUnreachableRedemptions(
  tx: Tx,
  now: Date,
  familyId: string | null = null,
): Promise<string[]> {
  const pending = await tx<
    {
      id: string;
      family_id: string;
      channel: BillingChannel;
      target_period_key: string;
      target_period_start: Date | null;
      created_at: Date;
    }[]
  >`
    select id, family_id, channel, target_period_key, target_period_start, created_at
      from public.promo_redemptions
     where state = 'provider_pending' and (${familyId}::uuid is null or family_id = ${familyId}::uuid)
     order by created_at
     limit 200
     for update skip locked
  `;
  const resolved: string[] = [];
  for (const r of pending) {
    const entitlements = await tx<
      { status: string; period_start: Date | null; period_end: Date | null }[]
    >`
      select status, period_start, period_end from public.family_entitlements
       where family_id = ${r.family_id} and channel = ${r.channel}
    `;
    let reason: string | null = null;
    if (r.target_period_start !== null) {
      const start = r.target_period_start.getTime();
      const ended =
        entitlements.length > 0 &&
        entitlements.every(
          (e) =>
            ENDED_STATUSES.has(e.status) &&
            e.period_end !== null &&
            e.period_end.getTime() <= start + MATCH_TOLERANCE_MS,
        );
      if (ended && now.getTime() >= start) reason = 'TARGET_PERIOD_NOT_RENEWED';
      else if (now.getTime() > start + TARGET_ELAPSED_MS) reason = 'TARGET_PERIOD_ELAPSED';
    } else if (now.getTime() - r.created_at.getTime() > FIRST_PERIOD_TIMEOUT_MS) {
      const started = entitlements.some(
        (e) => e.period_start !== null && e.period_start.getTime() >= r.created_at.getTime(),
      );
      if (!started) reason = 'FIRST_PERIOD_NOT_STARTED';
    }
    if (reason === null) continue;
    const next = transitionRedemption('provider_pending', 'reconcile_not_applied');
    if (!next.ok) continue;
    await tx`update public.promo_redemptions set state = ${next.value} where id = ${r.id}`;
    await tx`
      insert into public.audit_events (family_id, actor_kind, action, target_type, target_id, metadata)
      values (${r.family_id}, 'system', 'promo.redemption_unreachable', 'promo_redemption', ${r.id},
              ${JSON.stringify({ reason })}::text::jsonb)
    `;
    resolved.push(r.id);
  }
  return resolved;
}

// ---------------------------------------------------------------------------------------------
// Whole-family reconciliation (sync route, webhooks, scheduled re-verification)
// ---------------------------------------------------------------------------------------------

type Channel = BillingChannel;

/**
 * Provider states after which a subscription can never grant again without a new observation.
 * The scheduled re-verification sweep skips rows in these states too (BILL-R1-3): a refunded row
 * stays past its period end forever and would otherwise be re-fetched on every tick.
 */
export const TERMINAL_STATUSES: ReadonlySet<EntitlementStatus> = new Set([
  'expired',
  'revoked',
  'refunded',
]);

/** How many other families one new claim may trigger a re-verification for (RV-billing-1). */
const MAX_FORMER_HOLDERS = 3;

/**
 * Marks the parent's open requests as applied once verified capacity reflects them. This only
 * updates the request record; paid capacity itself was already computed from provider state.
 */
export async function settleCapacityChanges(
  tx: Tx,
  familyId: string,
  paidSlots: number,
): Promise<void> {
  await tx`
    update public.capacity_changes set status = 'applied'
     where family_id = ${familyId}
       and ((kind = 'upgrade' and status = 'pending_purchase' and to_slots <= ${paidSlots})
         or (kind = 'downgrade' and status = 'scheduled' and ${paidSlots} > 0 and ${paidSlots} <= to_slots))
  `;
}

/**
 * RV-billing-2: `active` means "holds a paid slot" (child_profiles, migration 0001). When verified
 * provider state (expiry, revocation, a store-confirmed downgrade) released a child's slot, the
 * profile goes back to `draft`: paid AI and practice stop for it (spec P11 "stop paid AI for
 * inactive profiles"), its history, exports and rewards are kept, and the parent can later assign an
 * unused paid slot to it again without a new purchase (AC_CAPACITY_03). Profiles that never held a
 * slot and slots the parent released by archiving are left alone. Idempotent; call it inside the
 * transaction that holds the family row lock.
 */
export async function releaseSlotlessProfiles(tx: Tx, familyId: string): Promise<string[]> {
  const released = await tx<{ id: string }[]>`
    update public.child_profiles c set status = 'draft'
     where c.family_id = ${familyId} and c.status = 'active'
       and not exists (select 1 from public.child_slot_assignments s
                        where s.family_id = c.family_id and s.child_id = c.id and s.released_at is null)
       and (select s.release_reason from public.child_slot_assignments s
             where s.family_id = c.family_id and s.child_id = c.id
             order by s.released_at desc limit 1) in ('expired', 'downgrade')
    returning c.id
  `;
  for (const child of released) {
    await tx`
      insert into public.audit_events (family_id, actor_kind, action, target_type, target_id)
      values (${familyId}, 'system', 'child.paid_slot_released', 'child', ${child.id})
    `;
  }
  return released.map((child) => child.id);
}

interface LedgerRow {
  channel: Channel;
  provider_subscription_id: string;
  product_id: string;
  status: EntitlementStatus;
  environment: BillingEnvironment;
  period_start: Date;
  period_end: Date;
  provider_updated_at: Date;
}

function ledgerKey(channel: string, providerSubscriptionId: string): string {
  return JSON.stringify([channel, providerSubscriptionId]);
}

/**
 * RV-billing-1: a COMPLETE provider fetch that no longer lists one of the family's subscriptions
 * means the provider moved it to another subscriber (a RevenueCat restore/transfer) or removed it.
 * It must stop granting here, or one store purchase would give two families paid capacity. The row
 * is re-observed as `revoked` with the provider's own last-modified instant unchanged and a new
 * observation time: this observation wins over the stored one, and a later fetch that lists the
 * subscription again (moved back) is newer still and restores it. History is kept.
 */
function vanishedSnapshots(
  before: readonly LedgerRow[],
  fetched: readonly ProviderSubscriptionSnapshot[],
  environment: BillingEnvironment,
  now: Date,
): ProviderSubscriptionSnapshot[] {
  const listed = new Set(fetched.map((s) => ledgerKey(s.channel, s.providerSubscriptionId)));
  return before
    .filter(
      (r) =>
        r.environment === environment &&
        !TERMINAL_STATUSES.has(r.status) &&
        !listed.has(ledgerKey(r.channel, r.provider_subscription_id)),
    )
    .map((r) => ({
      channel: r.channel,
      providerSubscriptionId: r.provider_subscription_id,
      productId: r.product_id,
      status: 'revoked' as const,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      autoRenew: false,
      environment: r.environment,
      providerUpdatedAt: r.provider_updated_at,
      fetchedAt: now,
    }));
}

/** A live subscription this reconciliation newly added to the family's ledger. */
interface NewClaim {
  readonly channel: Channel;
  readonly productId: string;
  readonly environment: BillingEnvironment;
  readonly periodStart: Date;
  readonly periodEnd: Date;
}

export interface FamilyBillingResult {
  readonly capacity: FamilyCapacity;
  readonly newClaims: readonly NewClaim[];
}

/**
 * Reconciles one family from a COMPLETE provider fetch of its billing ref (never a single event's
 * payload). Must run inside a transaction that already holds the family row lock. Throws
 * SubscriptionBoundElsewhere (BUG-006) when a subscription is bound to another family.
 * `afterSnapshots` runs once the ledger reflects the fetch and before redemptions are resolved and
 * requests settled: the webhook records the event's billing period, promotions and refund there,
 * so a renewal being processed is never treated as missing.
 */
export async function reconcileFamilyBilling(
  tx: Tx,
  familyId: string,
  snapshots: readonly ProviderSubscriptionSnapshot[],
  environment: BillingEnvironment,
  now: Date,
  afterSnapshots?: (capacity: FamilyCapacity) => Promise<void>,
): Promise<FamilyBillingResult> {
  const before = await tx<LedgerRow[]>`
    select channel, provider_subscription_id, product_id, status, environment, period_start, period_end,
           provider_updated_at
      from public.family_entitlements
     where family_id = ${familyId} and period_start is not null and period_end is not null
  `;
  const vanished = vanishedSnapshots(before, snapshots, environment, now);
  const capacity = await applySnapshots(
    tx,
    familyId,
    [...snapshots, ...vanished],
    environment,
    now,
  );
  if (afterSnapshots) await afterSnapshots(capacity);
  await releaseSlotlessProfiles(tx, familyId);
  // A redemption whose target period can no longer happen is resolved now (RV-2).
  await resolveUnreachableRedemptions(tx, now, familyId);
  await settleCapacityChanges(tx, familyId, capacity.paidSlots);
  const known = new Set(before.map((r) => ledgerKey(r.channel, r.provider_subscription_id)));
  const newClaims = snapshots
    .filter(
      (s) =>
        s.environment === environment &&
        !TERMINAL_STATUSES.has(s.status) &&
        !known.has(ledgerKey(s.channel, s.providerSubscriptionId)),
    )
    .map((s) => ({
      channel: s.channel,
      productId: s.productId,
      environment: s.environment,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
    }));
  return { capacity, newClaims };
}

/** Fetches a family's provider state and reconciles it with the family row locked. */
export async function syncFamilyFromProvider(
  deps: BillingSyncDeps,
  familyId: string,
  billingRef: string,
  now: Date,
): Promise<FamilyBillingResult | null> {
  const snapshots = await deps.providers.subscriptions.fetchSubscriptions(billingRef, now);
  return deps.db.asService(async (tx) => {
    const [live] = await tx<{ deleted_at: Date | null }[]>`
      select deleted_at from public.families where id = ${familyId} for update
    `;
    if (!live || live.deleted_at) return null;
    return reconcileFamilyBilling(tx, familyId, snapshots, deps.config.billingEnvironment, now);
  });
}

/**
 * RV-billing-1: when this family newly holds a live store subscription that another family's ledger
 * also holds for the same store product and exact provider period (a restore or transfer moved it),
 * that family is re-verified with the provider at once, so one purchase never keeps paying for two
 * families while the other parent is away. Only the provider's answer for that family's OWN billing
 * ref decides; nothing from this request is written to it and nothing about it is returned. Best
 * effort after this family's own transaction committed (no nested family locks): a failure is
 * logged, and that family is corrected by its own next sync.
 */
export async function reverifyFormerHolders(
  deps: BillingSyncDeps,
  familyId: string,
  claims: readonly NewClaim[],
  now: Date,
  requestId: string,
): Promise<void> {
  if (claims.length === 0) return;
  const holders = new Map<string, string>();
  for (const claim of claims) {
    if (holders.size >= MAX_FORMER_HOLDERS) break;
    const rows = await deps.db.asService(
      (tx) => tx<{ id: string; billing_ref: string }[]>`
        select distinct f.id, f.billing_ref
          from public.family_entitlements e
          join public.families f on f.id = e.family_id and f.deleted_at is null
         where e.family_id <> ${familyId}
           and e.channel = ${claim.channel} and e.product_id = ${claim.productId}
           and e.environment = ${claim.environment}
           and e.period_start = ${claim.periodStart} and e.period_end = ${claim.periodEnd}
           and e.status not in ('expired', 'revoked', 'refunded')
         limit ${MAX_FORMER_HOLDERS}
      `,
    );
    for (const row of rows) {
      if (holders.size < MAX_FORMER_HOLDERS) holders.set(row.id, row.billing_ref);
    }
  }
  for (const [holderId, billingRef] of holders) {
    try {
      await syncFamilyFromProvider(deps, holderId, billingRef, now);
    } catch {
      deps.log({ level: 'warn', event: 'billing_former_holder_reverify_failed', requestId });
    }
  }
}
