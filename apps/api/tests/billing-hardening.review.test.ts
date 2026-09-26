import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { revenueResponseSchema } from '@pencillift/contracts';
import { cryptoRandom } from '@pencillift/domain';
import type { ProviderSubscriptionSnapshot } from '@pencillift/domain/entitlements';
import { seedFamily, seedOwnerAdmin, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { reconcileStaleEntitlements, type JobDeps } from '../src/jobs/dispatcher.ts';
import { mapRevenueCatSubscription } from '../src/providers/billing.ts';
import { hmacSha256, toHex } from '../src/security/crypto.ts';
import { applyRefund, type SettlementEvent } from '../src/services/billing-sync.ts';
import { loadRevenueMonths, loadStoreFeeRates } from '../src/services/ops-metrics.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * Billing hardening round 1 (BILL-R1-1..5): chargebacks are refunds for the revenue view, a
 * complete provider fetch that removes a state marker (cancel → uncancel) is observed, the
 * stale-entitlement sweep rotates and skips terminal rows, RevenueCat's documented TRANSFER shape
 * is accepted and a refused shape leaves a trace, and a non-USD store charge is recorded, audited
 * and kept out of the USD revenue sums. Real local Postgres, labeled mock providers, synthetic
 * families only.
 */
const RC_AUTH = 'Bearer rc-webhook-secret-for-hardening-0123456789';
const STRIPE_SECRET = 'whsec_hardening_secret_for_signature_checks';
const BASE_NOW = new Date('2026-09-24T15:00:00Z');

let api: TestApi;
let deps: JobDeps;

async function billingRef(fam: SeededFamily): Promise<string> {
  const [row] = await api.db.sql<{ billing_ref: string }[]>`
    select billing_ref from public.families where id = ${fam.familyId}`;
  return row!.billing_ref;
}

function rcEvent(ref: string, overrides: Record<string, unknown> = {}) {
  return {
    event: {
      id: randomUUID(),
      type: 'RENEWAL',
      app_user_id: ref,
      product_id: 'pl_family_2',
      store: 'APP_STORE',
      purchased_at_ms: Date.parse('2026-09-10T00:00:00Z'),
      expiration_at_ms: Date.parse('2026-10-10T00:00:00Z'),
      price_in_purchased_currency: 49.98,
      currency: 'USD',
      period_type: 'NORMAL',
      transaction_id: `tx_${randomUUID()}`,
      event_timestamp_ms: Date.parse('2026-09-10T00:05:00Z'),
      environment: 'SANDBOX',
      ...overrides,
    },
  };
}

const postRc = (body: unknown) =>
  api.request('/webhooks/revenuecat', {
    method: 'POST',
    body,
    headers: { authorization: RC_AUTH },
  });

async function postStripe(body: unknown) {
  const raw = JSON.stringify(body);
  const t = Math.floor(api.now.value.getTime() / 1000);
  const sig = toHex(await hmacSha256(new TextEncoder().encode(STRIPE_SECRET), `${t}.${raw}`));
  return api.app.request('/webhooks/stripe', {
    method: 'POST',
    body: raw,
    headers: { 'stripe-signature': `t=${t},v1=${sig}`, 'content-type': 'application/json' },
  });
}

function snapshot(
  ref: string,
  overrides: Partial<ProviderSubscriptionSnapshot> = {},
): ProviderSubscriptionSnapshot {
  return {
    channel: 'app_store',
    providerSubscriptionId: `rc:${ref}:app_store:pl_family_2`,
    productId: 'pl_family_2',
    status: 'active',
    periodStart: new Date('2026-09-10T00:00:00Z'),
    periodEnd: new Date('2026-10-10T00:00:00Z'),
    autoRenew: true,
    environment: 'sandbox',
    providerUpdatedAt: new Date('2026-09-10T00:00:00Z'),
    fetchedAt: BASE_NOW,
    ...overrides,
  };
}

async function stripeInvoicePaid(ref: string, invoiceId: string, startIso: string) {
  const start = Date.parse(startIso) / 1000;
  const res = await postStripe({
    id: `evt_${randomUUID()}`,
    type: 'invoice.paid',
    data: {
      object: {
        id: invoiceId,
        billing_reason: 'subscription_cycle',
        status: 'paid',
        amount_paid: 4998,
        subtotal: 4998,
        currency: 'usd',
        total_discount_amounts: [],
        subscription_details: { metadata: { billing_ref: ref } },
        status_transitions: { paid_at: start + 60 },
        lines: {
          data: [{ period: { start, end: start + 2592000 }, price: { id: 'price_family_2' } }],
        },
      },
    },
  });
  expect(res.status).toBe(200);
}

async function stripeDispute(
  invoiceId: string,
  amount: number,
  outcome: 'created' | 'won' | 'lost' = 'created',
) {
  const chargeId = `ch_${randomUUID()}`;
  api.providers.stripe.chargeInvoices.set(chargeId, invoiceId);
  const res = await postStripe({
    id: `evt_${randomUUID()}`,
    type: outcome === 'created' ? 'charge.dispute.created' : 'charge.dispute.closed',
    data: {
      object: {
        id: `dp_${randomUUID()}`,
        object: 'dispute',
        amount,
        currency: 'usd',
        charge: chargeId,
        payment_intent: `pi_${randomUUID()}`,
        reason: 'fraudulent',
        status: outcome === 'created' ? 'needs_response' : outcome,
      },
    },
  });
  expect(res.status).toBe(200);
}

async function seedSettledPeriod(fam: SeededFamily, pid: string): Promise<string> {
  const [row] = await api.db.sql<{ id: string }[]>`
    insert into public.billing_periods (family_id, channel, provider_period_id, kind, period_start, period_end,
      paid_slots, regular_amount_cents, charged_amount_cents, settlement, settled_at)
    values (${fam.familyId}, 'app_store', ${pid}, 'subscription_period', '2026-09-05T00:00:00Z', '2026-10-05T00:00:00Z',
            2, 4998, 4998, 'settled', '2026-09-05T00:00:00Z')
    returning id`;
  return row!.id;
}

/** An accrued $1 for the period; returns the accrual id. */
async function seedAccrual(fam: SeededFamily, periodId: string): Promise<string> {
  const [school] = await api.db.sql<{ id: string }[]>`
    insert into public.schools (name, status) values (${`Cedar ${randomUUID().slice(0, 8)}`}, 'active') returning id`;
  const [acc] = await api.db.sql<{ id: string }[]>`
    insert into public.donation_accruals (family_id, school_id, donation_month, billing_period_id, eligibility_snapshot)
    values (${fam.familyId}, ${school!.id}, '2026-09', ${periodId}, '{}') returning id`;
  return acc!.id;
}

async function adjustments(accrualId: string): Promise<number[]> {
  const rows = await api.db.sql<{ amount_cents: number }[]>`
    select amount_cents from public.donation_adjustments where accrual_id = ${accrualId} order by created_at, amount_cents`;
  return rows.map((r) => r.amount_cents);
}

const refund = (fam: SeededFamily, pid: string, kind: SettlementEvent, cents: number | null) =>
  api.apiDb.asService((tx) => applyRefund(tx, fam.familyId, 'app_store', pid, kind, cents));

async function revenue(months = 1) {
  return api.apiDb.asService(async (tx) => {
    const { rates } = await loadStoreFeeRates(tx);
    return loadRevenueMonths(tx, api.now.value, months, rates);
  });
}

async function periodRow(providerPeriodId: string) {
  const [row] = await api.db.sql<
    { settlement: string; refunded_cents: number; charged_amount_cents: number; currency: string }[]
  >`
    select settlement, refunded_cents, charged_amount_cents, currency from public.billing_periods
     where provider_period_id = ${providerPeriodId}`;
  return row!;
}

async function ledgerRow(fam: SeededFamily) {
  const [row] = await api.db.sql<
    {
      status: string;
      auto_renew: boolean;
      period_end: Date;
      provider_updated_at: Date;
      fetched_at: Date;
    }[]
  >`
    select status, auto_renew, period_end, provider_updated_at, fetched_at
      from public.family_entitlements where family_id = ${fam.familyId}`;
  return row!;
}

async function capacity(fam: SeededFamily): Promise<number> {
  const [row] = await api.db.sql<{ paid_slots: number }[]>`
    select paid_slots from public.family_capacity where family_id = ${fam.familyId}`;
  return row?.paid_slots ?? 0;
}

async function activateChildren(fam: SeededFamily) {
  for (const child of fam.children) {
    await api.db.sql`update public.child_profiles set status = 'active' where id = ${child.id}`;
    await api.db.sql`
      insert into public.child_slot_assignments (family_id, child_id) values (${fam.familyId}, ${child.id})
      on conflict do nothing`;
  }
}

async function childStatuses(fam: SeededFamily): Promise<string[]> {
  const rows = await api.db.sql<{ status: string }[]>`
    select status from public.child_profiles where family_id = ${fam.familyId} order by id`;
  return rows.map((r) => r.status);
}

const RC_SUB = {
  purchase_date: '2026-09-10T00:00:00Z',
  expires_date: '2026-10-10T00:00:00Z',
  store: 'app_store',
  is_sandbox: true,
};

beforeAll(async () => {
  api = await createTestApi({
    REVENUECAT_WEBHOOK_AUTH: RC_AUTH,
    STRIPE_WEBHOOK_SECRET: STRIPE_SECRET,
    OPTIONAL_STRIPE_WEB_BILLING_ENABLED: 'true',
  });
  await seedOwnerAdmin(api.db);
  for (const [channel, product, slots] of [
    ['app_store', 'pl_family_2', 2],
    ['play_store', 'pl_family_2', 2],
    ['stripe', 'price_family_2', 2],
  ] as const) {
    await api.db.sql`
      insert into public.store_product_mappings (channel, product_id, environment, paid_slots)
      values (${channel}, ${product}, 'sandbox', ${slots})`;
  }
  deps = {
    db: api.apiDb,
    config: api.config,
    providers: api.providers,
    clock: () => api.now.value,
    random: cryptoRandom,
    log: (e) => api.logs.push(e),
  };
});

afterAll(async () => {
  await api?.close();
});

// ---------------------------------------------------------------------------------------------

describe('BILL-R1-1: a chargeback is a refund for the revenue view', () => {
  it('a Stripe dispute records the disputed amount as refunded, so net revenue excludes it', async () => {
    api.now.value = BASE_NOW;
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const invoiceId = `in_${randomUUID()}`;
    await stripeInvoicePaid(ref, invoiceId, '2026-09-03T00:00:00Z');
    const before = (await revenue()).months[0]!.channels.find((c) => c.channel === 'stripe')!;
    const gross = before.grossChargedCents;
    expect(gross).toBeGreaterThanOrEqual(4998);

    await stripeDispute(invoiceId, 4998);
    expect(await periodRow(invoiceId)).toMatchObject({
      settlement: 'chargeback',
      refunded_cents: 4998,
    });
    const after = (await revenue()).months[0]!.channels.find((c) => c.channel === 'stripe')!;
    expect(after.grossChargedCents).toBe(gross);
    expect(after.refundedCents).toBe(before.refundedCents + 4998);
    expect(after.netCents).toBe(before.netCents - 4998);
  });

  it('a chargeback without a provider amount reverses the whole charge; a partial dispute keeps its amount', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const full = `tx_cb_${randomUUID()}`;
    const partial = `tx_cbp_${randomUUID()}`;
    for (const pid of [full, partial]) {
      await api.db.sql`
        insert into public.billing_periods (family_id, channel, provider_period_id, kind, period_start, period_end,
          paid_slots, regular_amount_cents, charged_amount_cents, settlement, settled_at)
        values (${fam.familyId}, 'app_store', ${pid}, 'subscription_period', '2026-09-05T00:00:00Z', '2026-10-05T00:00:00Z',
                2, 4998, 4998, 'settled', '2026-09-05T00:00:00Z')`;
    }
    await api.apiDb.asService((tx) =>
      applyRefund(tx, fam.familyId, 'app_store', full, 'chargeback', null),
    );
    expect(await periodRow(full)).toMatchObject({ settlement: 'chargeback', refunded_cents: 4998 });
    await api.apiDb.asService((tx) =>
      applyRefund(tx, fam.familyId, 'app_store', partial, 'chargeback', 1000),
    );
    expect(await periodRow(partial)).toMatchObject({
      settlement: 'chargeback',
      refunded_cents: 1000,
    });
    // A repeated dispute event never lowers what was already reversed.
    await api.apiDb.asService((tx) =>
      applyRefund(tx, fam.familyId, 'app_store', full, 'chargeback', 10),
    );
    expect((await periodRow(full)).refunded_cents).toBe(4998);
  });

  it('a chargeback parked before its charge arrived reverses the whole charge when it lands', async () => {
    api.now.value = BASE_NOW;
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const invoiceId = `in_${randomUUID()}`;
    await api.apiDb.asService((tx) =>
      applyRefund(tx, fam.familyId, 'stripe', invoiceId, 'chargeback', null),
    );
    await stripeInvoicePaid(ref, invoiceId, '2026-09-06T00:00:00Z');
    expect(await periodRow(invoiceId)).toMatchObject({
      settlement: 'chargeback',
      refunded_cents: 4998,
    });
  });

  it('a won Stripe dispute gives the disputed amount back: period settled, refunded 0, net revenue restored', async () => {
    api.now.value = BASE_NOW;
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const invoiceId = `in_${randomUUID()}`;
    await stripeInvoicePaid(ref, invoiceId, '2026-09-03T00:00:00Z');
    const before = (await revenue()).months[0]!.channels.find((c) => c.channel === 'stripe')!;
    await stripeDispute(invoiceId, 4998);
    expect(await periodRow(invoiceId)).toMatchObject({
      settlement: 'chargeback',
      refunded_cents: 4998,
    });
    await stripeDispute(invoiceId, 4998, 'won');
    expect(await periodRow(invoiceId)).toMatchObject({ settlement: 'settled', refunded_cents: 0 });
    const after = (await revenue()).months[0]!.channels.find((c) => c.channel === 'stripe')!;
    expect(after.refundedCents).toBe(before.refundedCents);
    expect(after.netCents).toBe(before.netCents);
    // A dispute lost afterwards changes nothing further; a second dispute on the same charge
    // reverses it again.
    await stripeDispute(invoiceId, 4998, 'lost');
    expect(await periodRow(invoiceId)).toMatchObject({ settlement: 'settled', refunded_cents: 0 });
    await stripeDispute(invoiceId, 4998);
    expect(await periodRow(invoiceId)).toMatchObject({
      settlement: 'chargeback',
      refunded_cents: 4998,
    });
  });

  it('chargeback then won on an accrued period reinstates the $1 donation exactly once', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const pid = `tx_cbw_${randomUUID()}`;
    const accrual = await seedAccrual(fam, await seedSettledPeriod(fam, pid));
    await refund(fam, pid, 'chargeback', null);
    expect(await adjustments(accrual)).toEqual([-100]);
    await refund(fam, pid, 'chargeback_reversed', null);
    expect(await periodRow(pid)).toMatchObject({ settlement: 'settled', refunded_cents: 0 });
    expect(await adjustments(accrual)).toEqual([-100, 100]);
    // A replayed win plans nothing more; a won dispute on a period that was never charged back
    // (or is refunded) leaves the row alone.
    await refund(fam, pid, 'chargeback_reversed', null);
    expect(await adjustments(accrual)).toEqual([-100, 100]);
    const refunded = `tx_cbr_${randomUUID()}`;
    await seedSettledPeriod(fam, refunded);
    await refund(fam, refunded, 'refund', null);
    await refund(fam, refunded, 'chargeback_reversed', null);
    expect(await periodRow(refunded)).toMatchObject({
      settlement: 'refunded',
      refunded_cents: 4998,
    });
  });

  it('a won dispute after a genuine partial refund keeps that refund and does not reinstate the $1', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const pid = `tx_cbpr_${randomUUID()}`;
    const accrual = await seedAccrual(fam, await seedSettledPeriod(fam, pid));
    await refund(fam, pid, 'partial_refund', 1000);
    expect(await periodRow(pid)).toMatchObject({
      settlement: 'partially_refunded',
      refunded_cents: 1000,
    });
    // Stripe disputes at most the un-refunded remainder; the chargeback adds to the refund.
    await refund(fam, pid, 'chargeback', 3998);
    expect(await periodRow(pid)).toMatchObject({ settlement: 'chargeback', refunded_cents: 4998 });
    await refund(fam, pid, 'chargeback_reversed', 3998);
    expect(await periodRow(pid)).toMatchObject({
      settlement: 'partially_refunded',
      refunded_cents: 1000,
    });
    expect(await adjustments(accrual)).toEqual([-100]);
  });

  it('the revenue definition says chargebacks count as refunds', async () => {
    const r = await revenue();
    expect(r.definition).toMatch(/a chargeback counts as a refund/i);
    revenueResponseSchema.parse(r);
  });
});

// ---------------------------------------------------------------------------------------------

describe('BILL-R1-1: a won dispute after a partial refund, through the webhook', () => {
  it('partial refund 1000, dispute 3998, won 3998: stays partially refunded at 1000', async () => {
    api.now.value = BASE_NOW;
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const invoiceId = `in_${randomUUID()}`;
    await stripeInvoicePaid(ref, invoiceId, '2026-09-03T00:00:00Z');
    const before = (await revenue()).months[0]!.channels.find((c) => c.channel === 'stripe')!;
    // A partial merchant refund first (Stripe charge.refunded with amount_refunded 1000).
    const chargeId = `ch_${randomUUID()}`;
    api.providers.stripe.chargeInvoices.set(chargeId, invoiceId);
    const refunded = await postStripe({
      id: `evt_${randomUUID()}`,
      type: 'charge.refunded',
      data: {
        object: {
          id: chargeId,
          object: 'charge',
          amount: 4998,
          amount_refunded: 1000,
          refunded: false,
          currency: 'usd',
          payment_intent: `pi_${randomUUID()}`,
        },
      },
    });
    expect(refunded.status).toBe(200);
    expect(await periodRow(invoiceId)).toMatchObject({
      settlement: 'partially_refunded',
      refunded_cents: 1000,
    });
    // The customer disputes the remaining 3998, then the merchant wins it. The webhook must pass
    // the Dispute's amount on both events: with null, the win would give back the whole charge
    // and drop the genuine partial refund (the checker's mutation M-C).
    await stripeDispute(invoiceId, 3998);
    expect(await periodRow(invoiceId)).toMatchObject({
      settlement: 'chargeback',
      refunded_cents: 4998,
    });
    await stripeDispute(invoiceId, 3998, 'won');
    expect(await periodRow(invoiceId)).toMatchObject({
      settlement: 'partially_refunded',
      refunded_cents: 1000,
    });
    const after = (await revenue()).months[0]!.channels.find((c) => c.channel === 'stripe')!;
    expect(after.netCents).toBe(before.netCents - 1000);
  });
});

describe('BILL-R1-2: a complete provider fetch that clears a state marker is observed', () => {
  it('cancel → uncancel: the ledger returns to active with auto-renew on', async () => {
    api.now.value = new Date('2026-09-16T00:00:00Z');
    const fam = await seedFamily(api.db, { childCount: 2 });
    const ref = await billingRef(fam);
    api.providers.subscriptions.state.set(ref, [
      mapRevenueCatSubscription(
        ref,
        'pl_family_2',
        { ...RC_SUB, unsubscribe_detected_at: '2026-09-15T00:00:00Z' },
        api.now.value,
      )!,
    ]);
    expect(
      (
        await postRc(
          rcEvent(ref, {
            type: 'CANCELLATION',
            cancel_reason: 'UNSUBSCRIBE',
            event_timestamp_ms: api.now.value.getTime(),
          }),
        )
      ).status,
    ).toBe(200);
    expect(await ledgerRow(fam)).toMatchObject({ status: 'cancelled_active', auto_renew: false });

    // The parent turns auto-renew back on: RevenueCat clears unsubscribe_detected_at, so the
    // snapshot's provider timestamp falls back to the (older) purchase date.
    api.now.value = new Date('2026-09-25T00:00:00Z');
    const uncancelled = mapRevenueCatSubscription(
      ref,
      'pl_family_2',
      { ...RC_SUB, unsubscribe_detected_at: null },
      api.now.value,
    )!;
    expect(uncancelled.providerUpdatedAt.toISOString()).toBe('2026-09-10T00:00:00.000Z');
    api.providers.subscriptions.state.set(ref, [uncancelled]);
    expect(
      (
        await postRc(
          rcEvent(ref, { type: 'UNCANCELLATION', event_timestamp_ms: api.now.value.getTime() }),
        )
      ).status,
    ).toBe(200);
    expect(await ledgerRow(fam)).toMatchObject({ status: 'active', auto_renew: true });
  });

  it('a cancelled → uncancelled family keeps its capacity an hour past period end while the renewal is in flight', async () => {
    api.now.value = new Date('2026-09-16T00:00:00Z');
    const fam = await seedFamily(api.db, { childCount: 2 });
    const ref = await billingRef(fam);
    const token = await parentToken(fam.ownerId);
    api.providers.subscriptions.state.set(ref, [
      mapRevenueCatSubscription(
        ref,
        'pl_family_2',
        { ...RC_SUB, unsubscribe_detected_at: '2026-09-15T00:00:00Z' },
        api.now.value,
      )!,
    ]);
    expect(
      (
        await postRc(
          rcEvent(ref, {
            type: 'CANCELLATION',
            cancel_reason: 'UNSUBSCRIBE',
            event_timestamp_ms: api.now.value.getTime(),
          }),
        )
      ).status,
    ).toBe(200);
    await activateChildren(fam);
    api.now.value = new Date('2026-09-25T00:00:00Z');
    api.providers.subscriptions.state.set(ref, [
      mapRevenueCatSubscription(
        ref,
        'pl_family_2',
        { ...RC_SUB, unsubscribe_detected_at: null },
        api.now.value,
      )!,
    ]);
    expect(
      (
        await postRc(
          rcEvent(ref, { type: 'UNCANCELLATION', event_timestamp_ms: api.now.value.getTime() }),
        )
      ).status,
    ).toBe(200);
    expect(await capacity(fam)).toBe(2);

    // 10 Oct 01:00 UTC: the period ended an hour ago; the store renewed but the provider still
    // lists the old period unchanged (the mock keeps answering the 25 Sep state). The parent opens
    // the app, which syncs: an auto-renewing row keeps granting up to 30 days past its period end.
    api.now.value = new Date('2026-10-10T01:00:00Z');
    const res = await api.request('/v1/billing/sync', { method: 'POST', token, body: {} });
    expect(res.status).toBe(200);
    expect(await capacity(fam)).toBe(2);
    expect(await childStatuses(fam)).toEqual(['active', 'active']);
    api.now.value = BASE_NOW;
  });

  it('a fetch that started before the stored observation is still ignored (out-of-order fetches)', async () => {
    api.now.value = BASE_NOW;
    const fam = await seedFamily(api.db, { childCount: 0 });
    const ref = await billingRef(fam);
    api.providers.subscriptions.state.set(ref, [
      snapshot(ref, { providerUpdatedAt: new Date('2026-09-20T00:00:00Z') }),
    ]);
    expect((await postRc(rcEvent(ref))).status).toBe(200);
    expect(await capacity(fam)).toBe(2);
    // A fetch made an hour EARLIER (its transaction commits after the newer one): older provider
    // timestamp, different state, earlier fetch instant → not the provider's latest answer.
    api.now.value = new Date(BASE_NOW.getTime() - 3600_000);
    api.providers.subscriptions.state.set(ref, [
      snapshot(ref, { status: 'expired', providerUpdatedAt: new Date('2026-09-01T00:00:00Z') }),
    ]);
    expect((await postRc(rcEvent(ref, { type: 'EXPIRATION' }))).status).toBe(200);
    api.now.value = BASE_NOW;
    expect(await capacity(fam)).toBe(2);
    expect((await ledgerRow(fam)).status).toBe('active');
  });

  it('after the uncancel a later identical fetch still advances fetched_at, so the sweep rotates past the family', async () => {
    api.now.value = new Date('2026-09-16T00:00:00Z');
    const fam = await seedFamily(api.db, { childCount: 0 });
    const ref = await billingRef(fam);
    const token = await parentToken(fam.ownerId);
    api.providers.subscriptions.state.set(ref, [
      mapRevenueCatSubscription(
        ref,
        'pl_family_2',
        { ...RC_SUB, unsubscribe_detected_at: '2026-09-15T00:00:00Z' },
        api.now.value,
      )!,
    ]);
    expect(
      (
        await postRc(
          rcEvent(ref, {
            type: 'CANCELLATION',
            cancel_reason: 'UNSUBSCRIBE',
            event_timestamp_ms: api.now.value.getTime(),
          }),
        )
      ).status,
    ).toBe(200);
    api.now.value = new Date('2026-09-25T00:00:00Z');
    api.providers.subscriptions.state.set(ref, [
      mapRevenueCatSubscription(
        ref,
        'pl_family_2',
        { ...RC_SUB, unsubscribe_detected_at: null },
        api.now.value,
      )!,
    ]);
    expect(
      (
        await postRc(
          rcEvent(ref, { type: 'UNCANCELLATION', event_timestamp_ms: api.now.value.getTime() }),
        )
      ).status,
    ).toBe(200);
    expect(await ledgerRow(fam)).toMatchObject({
      status: 'active',
      auto_renew: true,
      provider_updated_at: new Date('2026-09-25T00:00:00Z'),
      fetched_at: new Date('2026-09-25T00:00:00Z'),
    });

    // Next day the parent opens the app; the provider answers the same (uncancelled) state whose
    // derived instant (the purchase date) is still older than our stamp.
    api.now.value = new Date('2026-09-26T12:00:00Z');
    const res = await api.request('/v1/billing/sync', { method: 'POST', token, body: {} });
    expect(res.status).toBe(200);
    expect(await ledgerRow(fam)).toMatchObject({
      status: 'active',
      auto_renew: true,
      provider_updated_at: new Date('2026-09-25T00:00:00Z'),
      fetched_at: new Date('2026-09-26T12:00:00Z'),
    });

    // Two days later the sweep runs twice: verified on the first tick, left alone on the second.
    api.now.value = new Date('2026-09-28T00:00:00Z');
    const spy = vi.spyOn(api.providers.subscriptions, 'fetchSubscriptions');
    try {
      await reconcileStaleEntitlements(deps);
      const tick1 = spy.mock.calls.map((c) => c[0]).filter((r) => r === ref);
      spy.mockClear();
      await reconcileStaleEntitlements(deps);
      const tick2 = spy.mock.calls.map((c) => c[0]).filter((r) => r === ref);
      expect(tick1).toHaveLength(1);
      expect(tick2).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
    expect(await ledgerRow(fam)).toMatchObject({
      status: 'active',
      auto_renew: true,
      fetched_at: new Date('2026-09-28T00:00:00Z'),
    });
    api.now.value = BASE_NOW;
  });
});

// ---------------------------------------------------------------------------------------------

describe('BILL-R1-3: the stale-entitlement sweep skips terminal rows and rotates', () => {
  async function seedLedger(
    fam: SeededFamily,
    ref: string,
    row: {
      status: string;
      periodStart: string;
      periodEnd: string;
      autoRenew: boolean;
      fetchedAt: string;
    },
  ) {
    await api.db.sql`
      insert into public.family_entitlements (family_id, channel, provider_subscription_id, product_id, paid_slots, status,
        environment, period_start, period_end, auto_renew, provider_updated_at, fetched_at)
      values (${fam.familyId}, 'app_store', ${`rc:${ref}:app_store:pl_family_2`}, 'pl_family_2', 2, ${row.status}, 'sandbox',
              ${row.periodStart}, ${row.periodEnd}, ${row.autoRenew}, ${row.periodStart}, ${row.fetchedAt})`;
  }

  it('refunded families are never re-fetched; a lost renewal behind 25 stale families is reached on the next tick', async () => {
    api.now.value = BASE_NOW;
    const families: { fam: SeededFamily; ref: string }[] = [];
    for (let i = 0; i < 40; i += 1) {
      const fam = await seedFamily(api.db, { childCount: 0 });
      families.push({ fam, ref: await billingRef(fam) });
    }
    families.sort((a, b) => (a.fam.familyId < b.fam.familyId ? -1 : 1));
    // 13 refunded families (period long over; the provider reports refunded_at forever).
    const refunded = families.slice(0, 13);
    // 26 families the provider keeps past their period end (cancelled, no renewal), last fetched
    // two days ago: legitimately stale, and always more than one tick's worth.
    const stale = families.slice(13, 39);
    // The target: highest id, last fetched most recently of all, renewal webhook lost.
    const target = families[39]!;
    for (const { fam, ref } of refunded) {
      await seedLedger(fam, ref, {
        status: 'refunded',
        periodStart: '2026-06-01T00:00:00Z',
        periodEnd: '2026-07-01T00:00:00Z',
        autoRenew: false,
        fetchedAt: '2026-07-01T00:00:00Z',
      });
      api.providers.subscriptions.state.set(ref, [
        snapshot(ref, {
          status: 'refunded',
          autoRenew: false,
          periodStart: new Date('2026-06-01T00:00:00Z'),
          periodEnd: new Date('2026-07-01T00:00:00Z'),
          providerUpdatedAt: new Date('2026-06-01T00:00:00Z'),
        }),
      ]);
    }
    for (const { fam, ref } of stale) {
      await seedLedger(fam, ref, {
        status: 'cancelled_active',
        periodStart: '2026-08-15T00:00:00Z',
        periodEnd: '2026-09-15T00:00:00Z',
        autoRenew: false,
        fetchedAt: '2026-09-22T00:00:00Z',
      });
      api.providers.subscriptions.state.set(ref, [
        snapshot(ref, {
          status: 'expired',
          autoRenew: false,
          periodStart: new Date('2026-08-15T00:00:00Z'),
          periodEnd: new Date('2026-09-15T00:00:00Z'),
          providerUpdatedAt: new Date('2026-08-15T00:00:00Z'),
        }),
      ]);
    }
    await seedLedger(target.fam, target.ref, {
      status: 'active',
      periodStart: '2026-08-21T00:00:00Z',
      periodEnd: '2026-09-21T00:00:00Z',
      autoRenew: true,
      fetchedAt: '2026-09-23T00:00:00Z',
    });
    api.providers.subscriptions.state.set(target.ref, [
      snapshot(target.ref, {
        periodStart: new Date('2026-09-21T00:00:00Z'),
        periodEnd: new Date('2026-10-21T00:00:00Z'),
        providerUpdatedAt: new Date('2026-09-21T00:00:00Z'),
      }),
    ]);

    const spy = vi.spyOn(api.providers.subscriptions, 'fetchSubscriptions');
    try {
      await reconcileStaleEntitlements(deps);
      const tick1 = spy.mock.calls.map((c) => c[0]);
      spy.mockClear();
      await reconcileStaleEntitlements(deps);
      const tick2 = spy.mock.calls.map((c) => c[0]);
      spy.mockClear();
      await reconcileStaleEntitlements(deps);
      const tick3 = spy.mock.calls.map((c) => c[0]);
      const fetched = [...tick1, ...tick2, ...tick3];
      expect(fetched.filter((r) => refunded.some((f) => f.ref === r))).toEqual([]);
      expect(tick1).toHaveLength(25);
      expect(tick1).not.toContain(target.ref);
      expect(tick2).toContain(target.ref);
      // Every stale family was verified exactly once across the ticks: no family fetched twice
      // within the re-check interval.
      for (const { ref } of stale) expect(fetched.filter((r) => r === ref)).toHaveLength(1);
      expect(fetched.filter((r) => r === target.ref)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
    expect((await ledgerRow(target.fam)).period_end.toISOString()).toBe('2026-10-21T00:00:00.000Z');
    expect(await capacity(target.fam)).toBe(2);
    for (const { fam } of stale) expect((await ledgerRow(fam)).status).toBe('expired');
  });
});

// ---------------------------------------------------------------------------------------------

describe('BILL-R1-4: RevenueCat TRANSFER shape and refused shapes', () => {
  it('the documented TRANSFER body (no app_user_id) re-verifies both families', async () => {
    api.now.value = BASE_NOW;
    const from = await seedFamily(api.db, { childCount: 0 });
    const to = await seedFamily(api.db, { childCount: 0 });
    const fromRef = await billingRef(from);
    const toRef = await billingRef(to);
    api.providers.subscriptions.state.set(fromRef, [snapshot(fromRef)]);
    expect((await postRc(rcEvent(fromRef))).status).toBe(200);
    expect(await capacity(from)).toBe(2);
    api.providers.subscriptions.state.set(fromRef, []);
    api.providers.subscriptions.state.set(toRef, [snapshot(toRef)]);
    // Field list of the documented TRANSFER sample, verbatim (Owner action: confirm against
    // https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields).
    const res = await postRc({
      api_version: '1.0',
      event: {
        app_id: 'app_synthetic',
        event_timestamp_ms: Date.parse('2026-09-24T14:00:00Z'),
        id: randomUUID(),
        store: 'APP_STORE',
        transferred_from: [fromRef],
        transferred_to: [toRef],
        type: 'TRANSFER',
      },
    });
    expect(res.status).toBe(200);
    expect((await json<{ status: string }>(res)).status).toBe('processed');
    expect(await capacity(from)).toBe(0);
    expect(await capacity(to)).toBe(2);
  });

  it('a TRANSFER without both subscriber lists, or any other event without app_user_id, is refused and traced', async () => {
    const fam = await seedFamily(api.db, { childCount: 0 });
    const ref = await billingRef(fam);
    const noTo = randomUUID();
    const res = await postRc({
      event: { id: noTo, type: 'TRANSFER', store: 'APP_STORE', transferred_from: [ref] },
    });
    expect(res.status).toBe(400);
    const noUser = randomUUID();
    const renewal = rcEvent(ref, { id: noUser }) as { event: Record<string, unknown> };
    delete renewal.event.app_user_id;
    expect((await postRc(renewal)).status).toBe(400);
    const traces = await api.db.sql<
      { status: string; error_code: string | null; event_type: string }[]
    >`
      select status, error_code, event_type from public.billing_provider_events
       where provider = 'revenuecat' and provider_event_id in (${noTo}, ${noUser}) order by event_type`;
    // BILL-R2-6: the trace is recorded as 'failed', not 'ignored'. A body the schema refuses is not
    // an event PencilLift chose to ignore: only 'failed' reaches the owner's attention list, and
    // only a 'failed' row is re-opened when the provider retries the same event id after a fix.
    // (The earlier 'ignored' expectation is what made the refusal invisible and unrecoverable.)
    expect(traces).toEqual([
      { status: 'failed', error_code: 'UNEXPECTED_SHAPE', event_type: 'RENEWAL' },
      { status: 'failed', error_code: 'UNEXPECTED_SHAPE', event_type: 'TRANSFER' },
    ]);
    // A retry of the same body is refused again; the trace stays a single row.
    expect((await postRc(renewal)).status).toBe(400);
    const [count] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.billing_provider_events where provider_event_id = ${noUser}`;
    expect(count!.n).toBe(1);
    expect(await capacity(fam)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe('BILL-R1-5: a store charge in another currency is recorded, audited and kept out of USD sums', () => {
  it('a GBP renewal is stored with its currency, audited, and excluded from the revenue sums with a note', async () => {
    api.now.value = BASE_NOW;
    const fam = await seedFamily(api.db, { childCount: 2 });
    const ref = await billingRef(fam);
    api.providers.subscriptions.state.set(ref, [snapshot(ref)]);
    const before = (await revenue()).months[0]!.channels.find((c) => c.channel === 'app_store')!;
    const gbp = `tx_gbp_${randomUUID()}`;
    const usd = `tx_usd_${randomUUID()}`;
    expect(
      (
        await postRc(
          rcEvent(ref, {
            transaction_id: gbp,
            price_in_purchased_currency: 39.99,
            currency: 'GBP',
            event_timestamp_ms: Date.parse('2026-09-10T00:05:00Z'),
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await postRc(
          rcEvent(ref, {
            transaction_id: usd,
            purchased_at_ms: Date.parse('2026-09-11T00:00:00Z'),
            expiration_at_ms: Date.parse('2026-10-11T00:00:00Z'),
            event_timestamp_ms: Date.parse('2026-09-11T00:05:00Z'),
          }),
        )
      ).status,
    ).toBe(200);
    expect(await periodRow(gbp)).toMatchObject({ charged_amount_cents: 3999, currency: 'GBP' });
    expect(await periodRow(usd)).toMatchObject({ charged_amount_cents: 4998, currency: 'USD' });
    // Paid capacity is unaffected: the entitlement comes from the provider fetch, not the charge.
    expect(await capacity(fam)).toBe(2);

    const audits = await api.db.sql<{ target_id: string; metadata: Record<string, unknown> }[]>`
      select target_id, metadata from public.audit_events
       where family_id = ${fam.familyId} and action = 'billing.unexpected_currency'`;
    expect(audits).toEqual([
      { target_id: gbp, metadata: { channel: 'app_store', currency: 'GBP' } },
    ]);
    expect(JSON.stringify(audits)).not.toMatch(/3999/);

    const after = (await revenue()).months[0]!.channels.find((c) => c.channel === 'app_store')!;
    expect(after.periods).toBe(before.periods + 1);
    expect(after.grossChargedCents).toBe(before.grossChargedCents + 4998);
    const r = await revenue();
    expect(r.notes.some((n) => /not charged in USD/.test(n) && /app_store/.test(n))).toBe(true);
    expect(r.definition).toMatch(/USD/);
    revenueResponseSchema.parse(r);
  });

  it('with only USD periods no currency note is shown', async () => {
    const fresh = await createTestApi();
    try {
      const r = await fresh.apiDb.asService(async (tx) => {
        const { rates } = await loadStoreFeeRates(tx);
        return loadRevenueMonths(tx, fresh.now.value, 1, rates);
      });
      expect(r.notes.some((n) => /not charged in USD/.test(n))).toBe(false);
    } finally {
      await fresh.close();
    }
  });
});
