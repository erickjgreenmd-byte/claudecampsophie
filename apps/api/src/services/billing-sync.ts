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
 * BILL-R4-4: gross is money COLLECTED for the subscription, so the figure is also bounded by what the
 * invoice actually took when a customer credit balance settled part of it. A negative
 * `starting_balance` (a credit left by an earlier proration) lowers `amount_due`/`amount_paid` while
 * the line amount, the subtotal and `total_excluding_tax` stay at full price and no discount is
 * reported: booking the line amount then counted money that was never collected in that month as
 * revenue AND made the month pass the donation rule's regular_tier_price equality, so the $1 school
 * accrual was created for a month whose collection was below the tier price.
 */
function subscriptionChargeCents(
  invoice: StripeInvoice,
  line: StripeLine,
  invoiceDiscountCents: number,
): number {
  const collectedPreTax =
    cents(invoice.starting_balance) !== null && cents(invoice.starting_balance)! < 0
      ? Math.max(0, (cents(invoice.amount_paid) ?? 0) - (cents(invoice.tax) ?? 0))
      : null;
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
 * the model, not a cleverer ratio, and it is recorded as an open item rather than guessed at here.
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
    reportedDiscountCents: discount,
    discountSources: discount > 0 ? ['promo_code'] : [],
    currency: (invoice.currency ?? 'usd').toUpperCase(),
    settledAt: new Date((invoice.status_transitions?.paid_at ?? period.start) * 1000),
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
  // A refund that arrived before this charge is applied now (RV-lead-billing-p17-3).
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
 * `providerChargeTotalCents` no longer scales anything; it only says whether the amount came from a
 * Charge whose total we know, which is what makes it a tax-inclusive figure worth converting. Null
 * for a RevenueCat store refund (no amount at all) and for a Stripe DISPUTE (whose `amount` is the
 * disputed part, not the charge total), and then nothing is converted and the cap alone applies,
 * exactly as before. A refund at or above the provider total took the whole charge back, so the cap
 * states it; a total no larger than the pre-tax charge carries no tax to strip.
 */
export function preTaxRefundCents(
  refundedCents: number,
  providerChargeTotalCents: number | null,
  chargedCents: number,
  taxCents: number,
): number {
  if (
    providerChargeTotalCents === null ||
    !Number.isSafeInteger(providerChargeTotalCents) ||
    providerChargeTotalCents <= chargedCents ||
    refundedCents >= providerChargeTotalCents ||
    !Number.isSafeInteger(taxCents) ||
    taxCents <= 0
  ) {
    return refundedCents;
  }
  return Math.min(
    chargedCents,
    Math.round((refundedCents * chargedCents) / (chargedCents + taxCents)),
  );
}

/**
 * Refund/chargeback (and a won dispute): marks the period and records at most one donation
 * reversal (or reinstatement). A full `refund` with a provider amount below the charge is recorded
 * as partial (RV-lead-billing-p17-7). An event for a period we have not recorded yet is parked in
 * `pending_refunds` and applied when the period arrives (RV-lead-billing-p17-3). A `chargeback`
 * reverses the disputed amount, or the whole charge when the provider reports none (BILL-R1-1):
 * the revenue view and the admin case detail read `refunded_cents`, so a lost dispute must never
 * look like kept revenue. A `chargeback_reversed` (dispute won) gives that amount back, so the
 * period returns to settled/0 (and the $1 donation is reinstated) unless an earlier partial refund
 * remains; `refundedCents` is then the reversed amount, null meaning the whole charge.
 *
 * `providerChargeTotalCents` is the provider's own total for the charge the amount came from; it says
 * the amount is a tax-inclusive Charge figure, so it is restated in the unit of
 * `charged_amount_cents` before anything is decided by it — by the tax stored for this period's own
 * charge, never by that total (see preTaxRefundCents, BILL-R4-3 / HUNT5-C-2 / N1-TAX-APPORTION). A refund parked in `pending_refunds`
 * keeps the provider's figure and is applied with no total, so the cap alone bounds it (that table
 * records no provider total).
 */
export async function applyRefund(
  tx: Tx,
  familyId: string,
  channel: BillingChannel,
  providerPeriodId: string,
  kind: SettlementEvent,
  refundedCents: number | null,
  providerChargeTotalCents: number | null = null,
): Promise<{ adjusted: boolean; pending?: boolean }> {
  if (refundedCents !== null && (!Number.isSafeInteger(refundedCents) || refundedCents < 0)) {
    throw new RangeError('refundedCents must be null or a non-negative integer number of cents');
  }
  const [current] = await tx<
    {
      id: string;
      charged_amount_cents: number;
      tax_amount_cents: number;
      settlement: string;
    }[]
  >`
    select id, charged_amount_cents, tax_amount_cents, settlement from public.billing_periods
     where family_id = ${familyId} and channel = ${channel} and provider_period_id = ${providerPeriodId}
     for update
  `;
  if (!current) {
    if (kind === 'chargeback_reversed') return { adjusted: false };
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
    return { adjusted: false, pending: true };
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
          providerChargeTotalCents,
          current.charged_amount_cents,
          current.tax_amount_cents,
        );
  const effective: SettlementEvent =
    kind === 'refund' && inCharge !== null && inCharge < current.charged_amount_cents
      ? 'partial_refund'
      : kind;
  // BILL-R1-1: a chargeback reverses the disputed amount (the whole charge when the provider
  // reports none) ON TOP of what was refunded before it, capped at the charge, so the revenue view
  // never counts clawed-back money as kept. A repeated dispute event for a period already in
  // 'chargeback' only ever raises the figure (idempotent replay, never a double count). A won
  // dispute (chargeback_reversed) gives the reversed amount back: with Stripe's dispute `amount`
  // (always present on a Dispute object) an earlier genuine partial refund survives the win as
  // 'partially_refunded'; without an amount the whole charge is treated as disputed and restored.
  // BILL-R2-4: every refunded/disputed figure is capped at charged_amount_cents. A provider reports
  // what the family paid INCLUDING sales tax, while the charge recorded here is the pre-tax
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
               case when settlement <> 'chargeback' then settlement
                    when greatest(0, refunded_cents - coalesce(${inCharge}::int, charged_amount_cents)) > 0
                      then 'partially_refunded'
                    else 'settled' end
             when ${effective} = 'chargeback' then 'chargeback'
             when ${effective} = 'partial_refund' then
               case when settlement in ('refunded', 'chargeback') then settlement else 'partially_refunded' end
             else 'refunded' end,
           refunded_cents = case
             when ${effective} = 'chargeback_reversed' then
               case when settlement <> 'chargeback' then refunded_cents
                    else greatest(0, refunded_cents - coalesce(${inCharge}::int, charged_amount_cents)) end
             when ${effective} = 'refund'
               then least(charged_amount_cents, greatest(refunded_cents, ${inCharge ?? 0}, charged_amount_cents))
             when ${effective} = 'chargeback' then
               case when settlement = 'chargeback'
                      then least(charged_amount_cents,
                                 greatest(refunded_cents, coalesce(${inCharge}::int, charged_amount_cents)))
                    else least(charged_amount_cents,
                               refunded_cents + coalesce(${inCharge}::int, charged_amount_cents)) end
             else least(charged_amount_cents, greatest(refunded_cents, ${inCharge ?? 0})) end
     where id = ${current.id}
     returning id, settlement, refunded_cents
  `;
  const [accrual] = await tx<
    { id: string; amount_cents: number; payout_batch_id: string | null }[]
  >`
    select id, amount_cents, payout_batch_id from public.donation_accruals where billing_period_id = ${period!.id}
  `;
  if (!accrual) return { adjusted: false };
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
  if (!adjustment) return { adjusted: false };
  const rows = await tx`
    insert into public.donation_adjustments (accrual_id, amount_cents, reason, idempotency_key)
    values (${accrual.id}, ${adjustment.amountCents}, ${adjustment.event}, ${adjustment.idempotencyKey})
    on conflict (idempotency_key) do nothing
    returning id
  `;
  return { adjusted: rows.length > 0 };
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
