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
  type EntitlementRecord,
  type FamilyCapacity,
  type ProviderSubscriptionSnapshot,
  type StoreProductMapping,
} from '@pencillift/domain/entitlements';
import { transitionRedemption, type RedemptionState } from '@pencillift/domain/promotions';
import type { Tx } from '../db.ts';
import { hmacSha256, timingSafeEqual, toHex } from '../security/crypto.ts';

/**
 * Provider → ledger synchronization (docs/Architecture.md §5). Pure mappers are exported for unit
 * tests; `apply*` functions run inside the webhook transaction with the family row locked.
 */

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

const RC_STORE: Record<string, BillingChannel | undefined> = {
  app_store: 'app_store',
  play_store: 'play_store',
  stripe: 'stripe',
};

/** Charge-bearing RevenueCat events become billing periods; others only trigger a state refresh. */
export function mapRevenueCatEventToPeriod(event: RevenueCatEvent): NormalizedPeriod | null {
  if (event.type !== 'INITIAL_PURCHASE' && event.type !== 'RENEWAL') return null;
  const channel = event.store ? RC_STORE[event.store] : undefined;
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
    reportedDiscountCents: null,
    discountSources,
    currency: (event.currency ?? 'USD').toUpperCase(),
    settledAt: new Date(event.event_timestamp_ms ?? event.purchased_at_ms),
  };
}

export function isRevenueCatRefund(event: RevenueCatEvent): boolean {
  return event.type === 'CANCELLATION' && event.cancel_reason === 'CUSTOMER_SUPPORT';
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
  readonly currency?: string;
  readonly total_discount_amounts?: { amount: number }[] | null;
  readonly period_start?: number;
  readonly period_end?: number;
  readonly lines?: {
    data?: { period?: { start: number; end: number }; price?: { id?: string } | null }[];
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

export function mapStripeInvoiceToPeriod(invoice: StripeInvoice): NormalizedPeriod | null {
  const line = invoice.lines?.data?.[0];
  const period = line?.period;
  if (!period || !line?.price?.id) return null;
  const kind =
    invoice.billing_reason === 'subscription_cycle' ||
    invoice.billing_reason === 'subscription_create'
      ? 'subscription_period'
      : invoice.billing_reason === 'subscription_update'
        ? 'proration'
        : 'addon';
  const discount = (invoice.total_discount_amounts ?? []).reduce((sum, d) => sum + d.amount, 0);
  return {
    channel: 'stripe',
    providerPeriodId: invoice.id,
    productId: line.price.id,
    kind,
    periodStart: new Date(period.start * 1000),
    periodEnd: new Date(period.end * 1000),
    chargedCents: invoice.amount_paid ?? 0,
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
      ...reconcileEntitlements(records, snapshot, mappings, runtimeEnvironment, now).records,
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
    if (written.length !== 1) {
      throw new Error('Provider subscription is bound to a different family');
    }
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
  const [row] = await tx<{ id: string }[]>`
    insert into public.billing_periods (family_id, channel, provider_period_id, kind, period_start, period_end, paid_slots,
      regular_amount_cents, charged_amount_cents, discount_cents, discount_sources, settlement, settled_at, currency)
    values (${familyId}, ${period.channel}, ${period.providerPeriodId}, ${period.kind}, ${period.periodStart}, ${period.periodEnd},
      ${paidSlots}, ${regularCents}, ${period.chargedCents}, ${discountCents}, ${period.discountSources}, 'settled',
      ${period.settledAt}, ${period.currency})
    on conflict (channel, provider_period_id) do update set
      settlement = case when public.billing_periods.settlement in ('refunded', 'partially_refunded', 'chargeback')
                        then public.billing_periods.settlement else 'settled' end,
      settled_at = coalesce(public.billing_periods.settled_at, excluded.settled_at)
    returning id
  `;
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
  const matching = candidates.filter((r) =>
    isFirstPurchase
      ? r.target_period_key === `first:${period.channel}`
      : r.target_period_start !== null &&
        Math.abs(r.target_period_start.getTime() - period.periodStart.getTime()) <=
          MATCH_TOLERANCE_MS,
  );
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
export async function applyRefund(
  tx: Tx,
  familyId: string,
  channel: BillingChannel,
  providerPeriodId: string,
  kind: 'refund' | 'partial_refund' | 'chargeback',
  refundedCents: number | null,
): Promise<{ adjusted: boolean }> {
  const [period] = await tx<
    {
      id: string;
      charged_amount_cents: number;
      settlement: 'refunded' | 'partially_refunded' | 'chargeback';
      refunded_cents: number;
    }[]
  >`
    update public.billing_periods
       set settlement = ${kind === 'chargeback' ? 'chargeback' : kind === 'partial_refund' ? 'partially_refunded' : 'refunded'},
           refunded_cents = greatest(refunded_cents, ${refundedCents ?? 0}, case when ${kind} = 'refund' then charged_amount_cents else 0 end)
     where family_id = ${familyId} and channel = ${channel} and provider_period_id = ${providerPeriodId}
     returning id, charged_amount_cents, settlement, refunded_cents
  `;
  if (!period) return { adjusted: false };
  const [accrual] = await tx<
    { id: string; amount_cents: number; payout_batch_id: string | null }[]
  >`
    select id, amount_cents, payout_batch_id from public.donation_accruals where billing_period_id = ${period.id}
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
    event: kind,
    existingAdjustmentKeys: new Set(existing.map((e) => e.idempotency_key)),
    providerState: { settlement: period.settlement, refundedCents: period.refunded_cents },
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
