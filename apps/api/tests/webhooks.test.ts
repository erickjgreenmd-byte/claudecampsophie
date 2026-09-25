import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderSubscriptionSnapshot } from '@pencillift/domain/entitlements';
import { generatePromoCode } from '@pencillift/domain/promotions';
import { cryptoRandom } from '@pencillift/domain';
import { seedFamily, seedOwnerAdmin, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { mapRevenueCatSubscription } from '../src/providers/billing.ts';
import { hmacSha256, toHex } from '../src/security/crypto.ts';
import {
  mapRevenueCatEventToPeriod,
  verifyStripeSignature,
  type RevenueCatEvent,
} from '../src/services/billing-sync.ts';
import { createTestApi, json, type TestApi } from './helpers.ts';

const RC_AUTH = 'Bearer rc-webhook-secret-for-tests-0123456789';
const STRIPE_SECRET = 'whsec_test_secret_for_signature_checks';

let api: TestApi;

async function billingRef(fam: SeededFamily): Promise<string> {
  const [row] = await api.db.sql<
    { billing_ref: string }[]
  >`select billing_ref from public.families where id = ${fam.familyId}`;
  return row!.billing_ref;
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
    fetchedAt: new Date('2026-09-24T15:00:00Z'),
    ...overrides,
  };
}

function rcEvent(ref: string, overrides: Record<string, unknown> = {}) {
  return {
    event: {
      id: randomUUID(),
      type: 'RENEWAL',
      app_user_id: ref,
      product_id: 'pl_family_2',
      store: 'app_store',
      purchased_at_ms: Date.parse('2026-09-10T00:00:00Z'),
      expiration_at_ms: Date.parse('2026-10-10T00:00:00Z'),
      price_in_purchased_currency: 49.98,
      currency: 'USD',
      period_type: 'NORMAL',
      transaction_id: `tx_${randomUUID()}`,
      event_timestamp_ms: Date.parse('2026-09-10T00:05:00Z'),
      ...overrides,
    },
  };
}

const postRc = (body: unknown, auth: string | null = RC_AUTH) =>
  api.request('/webhooks/revenuecat', {
    method: 'POST',
    body,
    headers: auth ? { authorization: auth } : {},
  });

async function capacity(fam: SeededFamily) {
  const [row] = await api.db.sql<
    { paid_slots: number; conflict: string | null }[]
  >`select paid_slots, conflict from public.family_capacity where family_id = ${fam.familyId}`;
  return row;
}

beforeAll(async () => {
  api = await createTestApi({
    REVENUECAT_WEBHOOK_AUTH: RC_AUTH,
    STRIPE_WEBHOOK_SECRET: STRIPE_SECRET,
    OPTIONAL_STRIPE_WEB_BILLING_ENABLED: 'true',
  });
  await seedOwnerAdmin(api.db);
  for (const [channel, product, slots] of [
    ['app_store', 'pl_family_1', 1],
    ['app_store', 'pl_family_2', 2],
    ['play_store', 'pl_family_3', 3],
    ['stripe', 'price_family_2', 2],
    ['amazon_appstore', 'pl_family_2', 2],
  ] as const) {
    await api.db.sql`
      insert into public.store_product_mappings (channel, product_id, environment, paid_slots)
      values (${channel}, ${product}, 'sandbox', ${slots})
    `;
  }
});

afterAll(async () => {
  await api?.close();
});

describe('RevenueCat webhook authentication and dedupe (AC_CONN_05, AC_BILLING_04)', () => {
  it('rejects missing or wrong authorization', async () => {
    const fam = await seedFamily(api.db);
    expect((await postRc(rcEvent(await billingRef(fam)), null)).status).toBe(401);
    expect((await postRc(rcEvent(await billingRef(fam)), 'Bearer wrong')).status).toBe(401);
  });

  it('grants capacity from fetched provider state and records the settled period exactly once', async () => {
    const fam = await seedFamily(api.db, { childCount: 2 });
    const ref = await billingRef(fam);
    api.providers.subscriptions.state.set(ref, [snapshot(ref)]);
    const body = rcEvent(ref);
    expect((await json<{ status: string }>(await postRc(body))).status).toBe('processed');
    expect((await json<{ status: string }>(await postRc(body))).status).toBe('duplicate');
    expect(await capacity(fam)).toEqual({ paid_slots: 2, conflict: null });
    const periods = await api.db
      .sql`select charged_amount_cents, discount_cents, settlement from public.billing_periods where family_id = ${fam.familyId}`;
    expect(periods).toEqual([
      { charged_amount_cents: 4998, discount_cents: 0, settlement: 'settled' },
    ]);
  });

  it('[BUG-006] two families buying the same store product each get their own capacity', async () => {
    const a = await seedFamily(api.db);
    const b = await seedFamily(api.db);
    for (const fam of [a, b]) {
      const ref = await billingRef(fam);
      api.providers.subscriptions.state.set(ref, [snapshot(ref)]);
      expect((await json<{ status: string }>(await postRc(rcEvent(ref)))).status).toBe('processed');
    }
    expect((await capacity(a))!.paid_slots).toBe(2);
    expect((await capacity(b))!.paid_slots).toBe(2);
  });

  it('[BUG-006] a provider subscription id owned by another family fails loudly instead of being skipped', async () => {
    const owner = await seedFamily(api.db);
    const other = await seedFamily(api.db);
    const ownerRef = await billingRef(owner);
    api.providers.subscriptions.state.set(ownerRef, [snapshot(ownerRef)]);
    await postRc(rcEvent(ownerRef));
    const otherRef = await billingRef(other);
    api.providers.subscriptions.state.set(otherRef, [snapshot(ownerRef)]);
    const res = await postRc(rcEvent(otherRef));
    expect(res.status).toBe(503);
    const [event] = await api.db.sql<{ status: string }[]>`
      select status from public.billing_provider_events where family_id = ${other.familyId} order by received_at desc limit 1`;
    expect(event!.status).toBe('failed');
    expect(await capacity(other)).toBeUndefined();
  });

  it('an older provider observation delivered late never regresses the ledger', async () => {
    const fam = await seedFamily(api.db);
    const ref = await billingRef(fam);
    api.providers.subscriptions.state.set(ref, [
      snapshot(ref, { providerUpdatedAt: new Date('2026-09-20T00:00:00Z') }),
    ]);
    await postRc(rcEvent(ref));
    api.providers.subscriptions.state.set(ref, [
      snapshot(ref, { status: 'expired', providerUpdatedAt: new Date('2026-09-01T00:00:00Z') }),
    ]);
    await postRc(rcEvent(ref, { type: 'EXPIRATION' }));
    expect((await capacity(fam))!.paid_slots).toBe(2);
  });

  it('[RV-entitlements-1] a future-dated provider timestamp cannot freeze the entitlement', async () => {
    const fam = await seedFamily(api.db, { childCount: 2 });
    const ref = await billingRef(fam);
    api.providers.subscriptions.state.set(ref, [
      snapshot(ref, { providerUpdatedAt: new Date('2027-01-01T00:00:00Z') }),
    ]);
    await postRc(rcEvent(ref));
    expect((await capacity(fam))?.paid_slots).toBe(2);
    // The genuine later observation (a revocation an hour later) must still apply.
    api.now.value = new Date(api.now.value.getTime() + 3600_000);
    try {
      api.providers.subscriptions.state.set(ref, [
        snapshot(ref, { status: 'revoked', providerUpdatedAt: new Date('2026-09-24T15:30:00Z') }),
      ]);
      await postRc(rcEvent(ref, { type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT' }));
    } finally {
      api.now.value = new Date(api.now.value.getTime() - 3600_000);
    }
    expect((await capacity(fam))?.paid_slots).toBe(0);
  });

  it('Apple + Google subscriptions never add up; the conflict is flagged (AC_CAPACITY_05)', async () => {
    const fam = await seedFamily(api.db);
    const ref = await billingRef(fam);
    api.providers.subscriptions.state.set(ref, [
      snapshot(ref),
      snapshot(ref, {
        channel: 'play_store',
        providerSubscriptionId: `rc:${ref}:play_store:pl_family_3`,
        productId: 'pl_family_3',
      }),
    ]);
    await postRc(rcEvent(ref));
    expect(await capacity(fam)).toEqual({
      paid_slots: 3,
      conflict: 'duplicate_active_subscriptions',
    });
  });

  it('ignores unknown subscribers and never writes to a deleted family', async () => {
    expect(
      (await json<{ status: string }>(await postRc(rcEvent('fam_does_not_exist')))).status,
    ).toBe('ignored');
    const fam = await seedFamily(api.db);
    const ref = await billingRef(fam);
    await api.db.sql`update public.families set deleted_at = now() where id = ${fam.familyId}`;
    api.providers.subscriptions.state.set(ref, [snapshot(ref)]);
    expect((await json<{ status: string }>(await postRc(rcEvent(ref)))).status).toBe('ignored');
    const rows = await api.db
      .sql`select id from public.family_entitlements where family_id = ${fam.familyId}`;
    expect(rows).toHaveLength(0);
  });

  it('expiry releases paid slots but keeps the children and their history', async () => {
    const fam = await seedFamily(api.db, { childCount: 2 });
    const ref = await billingRef(fam);
    api.providers.subscriptions.state.set(ref, [snapshot(ref)]);
    await postRc(rcEvent(ref));
    for (const child of fam.children) {
      await api.db
        .sql`insert into public.child_slot_assignments (family_id, child_id) values (${fam.familyId}, ${child.id})`;
    }
    api.providers.subscriptions.state.set(ref, [
      snapshot(ref, { status: 'expired', providerUpdatedAt: new Date('2026-10-11T00:00:00Z') }),
    ]);
    await postRc(rcEvent(ref, { type: 'EXPIRATION' }));
    const open = await api.db
      .sql`select id from public.child_slot_assignments where family_id = ${fam.familyId} and released_at is null`;
    expect(open).toHaveLength(0);
    const kids = await api.db
      .sql`select id from public.child_profiles where family_id = ${fam.familyId}`;
    expect(kids).toHaveLength(2);
  });
});

describe('promotion reconciliation (AC_PROMO_07/08/09)', () => {
  async function redemption(
    fam: SeededFamily,
    targetStart: string,
    state: 'reserved' | 'provider_pending',
  ) {
    const adminId = await api.db.createUser();
    const [tpl] = await api.db.sql<{ id: string }[]>`
      insert into public.promo_campaign_templates (name, percent_off, eligible_tiers, subscriber_eligibility, redemption_cap,
        budget_cap_cents, timezone_confirmed, code_mode, channels, enabled, created_by)
      values ('Webhook T', 50, '{1,2,3,4}', '{existing}', 10, 100000, true, 'shared', '{app_store}', true, ${adminId}) returning id`;
    const [camp] = await api.db.sql<{ id: string }[]>`
      insert into public.promo_campaigns (template_id, campaign_month, generation_key, percent_off, eligible_tiers,
        subscriber_eligibility, redemption_cap, budget_cap_cents, opens_at, closes_at, status)
      values (${tpl!.id}, '2026-09', ${tpl!.id + ':2026-09'}, 50, '{1,2,3,4}', '{existing}', 10, 100000,
        '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', 'active') returning id`;
    const [code] = await api.db.sql<{ id: string }[]>`
      insert into public.promo_codes (campaign_id, code_normalized) values (${camp!.id}, ${generatePromoCode(cryptoRandom).normalized}) returning id`;
    const [row] = await api.db.sql<{ id: string }[]>`
      insert into public.promo_redemptions (family_id, campaign_id, code_id, channel, target_period_key, target_period_start, state,
        idempotency_key, paid_slots, percent_off, regular_cents, discount_cents, charged_cents, redeemed_by)
      values (${fam.familyId}, ${camp!.id}, ${code!.id}, 'app_store', ${new Date(targetStart).toISOString()}, ${targetStart}, 'reserved',
        ${'idem-' + randomUUID()}, 2, 50, 4998, 2499, 2499, ${fam.ownerId}) returning id`;
    if (state === 'provider_pending')
      await api.db
        .sql`update public.promo_redemptions set state = 'provider_pending' where id = ${row!.id}`;
    return row!.id;
  }

  it('a discounted renewal for the target period confirms the redemption with the store amount', async () => {
    const fam = await seedFamily(api.db, { childCount: 2 });
    const ref = await billingRef(fam);
    api.providers.subscriptions.state.set(ref, [
      snapshot(ref, {
        periodStart: new Date('2026-10-10T00:00:00Z'),
        periodEnd: new Date('2026-11-10T00:00:00Z'),
      }),
    ]);
    const id = await redemption(fam, '2026-10-10T00:00:00Z', 'reserved');
    await postRc(
      rcEvent(ref, {
        purchased_at_ms: Date.parse('2026-10-10T00:00:30Z'),
        expiration_at_ms: Date.parse('2026-11-10T00:00:00Z'),
        price_in_purchased_currency: 24.49,
        period_type: 'PROMOTIONAL',
      }),
    );
    const [row] = await api.db.sql<
      { state: string; charged_cents: number; discount_cents: number }[]
    >`
      select state, charged_cents, discount_cents from public.promo_redemptions where id = ${id}`;
    // The store's actual amount (a price point) wins over the 50% preview.
    expect(row).toEqual({ state: 'confirmed', charged_cents: 2449, discount_cents: 2549 });
    const benefit = await api.db
      .sql`select provider_period_id from public.promo_benefit_periods where redemption_id = ${id}`;
    expect(benefit).toHaveLength(1);
  });

  it('a store promo discount with no PencilLift redemption is flagged for reconciliation', async () => {
    const fam = await seedFamily(api.db, { childCount: 2 });
    const ref = await billingRef(fam);
    api.providers.subscriptions.state.set(ref, [snapshot(ref)]);
    await postRc(rcEvent(ref, { price_in_purchased_currency: 24.49, period_type: 'PROMOTIONAL' }));
    const flags = await api.db.sql<{ action: string; metadata: { channel: string } }[]>`
      select action, metadata from public.audit_events
       where family_id = ${fam.familyId} and action = 'promo.unmatched_discount'`;
    expect(flags).toHaveLength(1);
    expect(flags[0]!.metadata.channel).toBe('app_store');
    // Full-price periods are never flagged.
    const other = await seedFamily(api.db, { childCount: 2 });
    const otherRef = await billingRef(other);
    api.providers.subscriptions.state.set(otherRef, [snapshot(otherRef)]);
    await postRc(rcEvent(otherRef));
    const none = await api.db.sql`
      select 1 from public.audit_events where family_id = ${other.familyId} and action = 'promo.unmatched_discount'`;
    expect(none).toHaveLength(0);
  });

  it('a full-price renewal of the targeted period rejects the in-flight redemption', async () => {
    const fam = await seedFamily(api.db, { childCount: 2 });
    const ref = await billingRef(fam);
    api.providers.subscriptions.state.set(ref, [snapshot(ref)]);
    const id = await redemption(fam, '2026-09-10T00:00:00Z', 'provider_pending');
    await postRc(rcEvent(ref));
    const [row] = await api.db.sql<
      { state: string }[]
    >`select state from public.promo_redemptions where id = ${id}`;
    expect(row!.state).toBe('rejected');
  });

  it('a refund reverses an accrued school donation exactly once, even if refund events repeat', async () => {
    const fam = await seedFamily(api.db, { childCount: 2 });
    const ref = await billingRef(fam);
    api.providers.subscriptions.state.set(ref, [snapshot(ref)]);
    const tx = `tx_refund_${randomUUID()}`;
    await postRc(rcEvent(ref, { transaction_id: tx }));
    const [school] = await api.db.sql<
      { id: string }[]
    >`insert into public.schools (name, status) values ('Spruce', 'active') returning id`;
    const [period] = await api.db.sql<
      { id: string }[]
    >`select id from public.billing_periods where provider_period_id = ${tx}`;
    await api.db.sql`
      insert into public.donation_accruals (family_id, school_id, donation_month, billing_period_id, eligibility_snapshot)
      values (${fam.familyId}, ${school!.id}, '2026-09', ${period!.id}, '{}')`;
    for (let i = 0; i < 2; i += 1) {
      await postRc(
        rcEvent(ref, {
          type: 'CANCELLATION',
          cancel_reason: 'CUSTOMER_SUPPORT',
          transaction_id: tx,
        }),
      );
    }
    const adjustments = await api.db
      .sql`select amount_cents, reason from public.donation_adjustments`;
    expect(adjustments).toEqual([{ amount_cents: -100, reason: 'refund' }]);
    const [p] = await api.db.sql<
      { settlement: string }[]
    >`select settlement from public.billing_periods where id = ${period!.id}`;
    expect(p!.settlement).toBe('refunded');
  });
});

describe('Stripe webhooks (optional web billing)', () => {
  async function signed(body: unknown, when = new Date('2026-09-24T15:00:00Z')) {
    const raw = JSON.stringify(body);
    const t = Math.floor(when.getTime() / 1000);
    const sig = toHex(await hmacSha256(new TextEncoder().encode(STRIPE_SECRET), `${t}.${raw}`));
    return { raw, header: `t=${t},v1=${sig}` };
  }

  it('verifies signatures in constant time with a timestamp tolerance', async () => {
    const { raw, header } = await signed({ id: 'evt_1' });
    const now = new Date('2026-09-24T15:00:00Z');
    expect(await verifyStripeSignature(raw, header, STRIPE_SECRET, now)).toBe(true);
    expect(await verifyStripeSignature(raw + ' ', header, STRIPE_SECRET, now)).toBe(false);
    expect(await verifyStripeSignature(raw, header, 'whsec_other', now)).toBe(false);
    expect(
      await verifyStripeSignature(raw, header, STRIPE_SECRET, new Date('2026-09-24T15:10:00Z')),
    ).toBe(false);
    expect(await verifyStripeSignature(raw, undefined, STRIPE_SECRET, now)).toBe(false);
  });

  it('attaches the web promotion only to the targeted renewal invoice, never a proration invoice', async () => {
    const fam = await seedFamily(api.db, { childCount: 2 });
    const ref = await billingRef(fam);
    const adminId = await api.db.createUser();
    const [tpl] = await api.db.sql<{ id: string }[]>`
      insert into public.promo_campaign_templates (name, percent_off, eligible_tiers, subscriber_eligibility, redemption_cap,
        budget_cap_cents, timezone_confirmed, code_mode, channels, enabled, created_by)
      values ('Stripe T', 50, '{2}', '{existing}', 10, 100000, true, 'shared', '{stripe}', true, ${adminId}) returning id`;
    const [camp] = await api.db.sql<{ id: string }[]>`
      insert into public.promo_campaigns (template_id, campaign_month, generation_key, percent_off, eligible_tiers,
        subscriber_eligibility, redemption_cap, budget_cap_cents, opens_at, closes_at, status)
      values (${tpl!.id}, '2026-09', ${tpl!.id + ':2026-09'}, 50, '{2}', '{existing}', 10, 100000, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', 'active') returning id`;
    await api.db
      .sql`insert into public.provider_offer_mappings (campaign_id, channel, paid_slots, provider_offer_id, status) values (${camp!.id}, 'stripe', 2, 'coupon_sep_50', 'ready')`;
    const [code] = await api.db.sql<
      { id: string }[]
    >`insert into public.promo_codes (campaign_id, code_normalized) values (${camp!.id}, ${generatePromoCode(cryptoRandom).normalized}) returning id`;
    await api.db.sql`
      insert into public.promo_redemptions (family_id, campaign_id, code_id, channel, target_period_key, target_period_start, state,
        idempotency_key, paid_slots, percent_off, regular_cents, discount_cents, charged_cents, redeemed_by)
      values (${fam.familyId}, ${camp!.id}, ${code!.id}, 'stripe', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00Z', 'reserved',
        ${'idem-' + randomUUID()}, 2, 50, 4998, 2499, 2499, ${fam.ownerId})`;
    await api.db
      .sql`update public.promo_redemptions set state = 'provider_pending' where family_id = ${fam.familyId}`;
    const invoice = (id: string, reason: string, start: string) => ({
      id: `evt_${randomUUID()}`,
      type: 'invoice.created',
      data: {
        object: {
          id,
          billing_reason: reason,
          status: 'draft',
          subscription_details: { metadata: { billing_ref: ref } },
          lines: {
            data: [
              {
                period: {
                  start: Date.parse(start) / 1000,
                  end: Date.parse(start) / 1000 + 2678400,
                },
                price: { id: 'price_family_2' },
              },
            ],
          },
        },
      },
    });
    for (const body of [
      invoice('in_proration', 'subscription_update', '2026-10-10T00:00:00Z'),
      invoice('in_cycle', 'subscription_cycle', '2026-10-10T00:00:00Z'),
    ]) {
      const { raw, header } = await signed(body);
      const res = await api.app.request('/webhooks/stripe', {
        method: 'POST',
        body: raw,
        headers: { 'stripe-signature': header, 'content-type': 'application/json' },
      });
      expect(res.status).toBe(200);
    }
    expect(api.providers.stripe.discounts).toEqual([
      { invoiceId: 'in_cycle', couponId: 'coupon_sep_50' },
    ]);
  });
});

describe('RevenueCat subscription mapping (pure)', () => {
  const now = new Date('2026-09-24T00:00:00Z');
  const base = {
    purchase_date: '2026-09-10T00:00:00Z',
    expires_date: '2026-10-10T00:00:00Z',
    store: 'app_store',
    is_sandbox: true,
  };

  it('maps provider states to entitlement statuses', () => {
    expect(mapRevenueCatSubscription('fam_x', 'p', base, now)?.status).toBe('active');
    expect(
      mapRevenueCatSubscription(
        'fam_x',
        'p',
        { ...base, unsubscribe_detected_at: '2026-09-15T00:00:00Z' },
        now,
      )?.status,
    ).toBe('cancelled_active');
    expect(
      mapRevenueCatSubscription(
        'fam_x',
        'p',
        { ...base, billing_issues_detected_at: '2026-09-20T00:00:00Z' },
        now,
      )?.status,
    ).toBe('billing_retry');
    expect(
      mapRevenueCatSubscription(
        'fam_x',
        'p',
        {
          ...base,
          billing_issues_detected_at: '2026-09-20T00:00:00Z',
          grace_period_expires_date: '2026-09-30T00:00:00Z',
        },
        now,
      )?.status,
    ).toBe('grace_period');
    expect(
      mapRevenueCatSubscription('fam_x', 'p', { ...base, refunded_at: '2026-09-21T00:00:00Z' }, now)
        ?.status,
    ).toBe('refunded');
    expect(
      mapRevenueCatSubscription(
        'fam_x',
        'p',
        { ...base, expires_date: '2026-09-20T00:00:00Z' },
        now,
      )?.status,
    ).toBe('expired');
  });

  it('ignores promotional grants and unknown stores; marks sandbox purchases as sandbox', () => {
    expect(
      mapRevenueCatSubscription('fam_x', 'p', { ...base, store: 'promotional' }, now),
    ).toBeNull();
    expect(mapRevenueCatSubscription('fam_x', 'p', base, now)?.environment).toBe('sandbox');
    expect(
      mapRevenueCatSubscription('fam_x', 'p', { ...base, is_sandbox: false }, now)?.environment,
    ).toBe('production');
  });
});

describe('RevenueCat webhook store names (BUG-113)', () => {
  it('records the billing period for an event whose store is spelled APP_STORE (webhook casing)', async () => {
    // RevenueCat's REST subscriber payload spells stores in lowercase, its webhook events in
    // uppercase (APP_STORE, PLAY_STORE, AMAZON, STRIPE, …). A lowercase-only map turned every real
    // event's store into "unknown", so no billing period, donation month or revenue row was
    // written while capacity still arrived through the subscriber fetch.
    const fam = await seedFamily(api.db, { childCount: 2 });
    const ref = await billingRef(fam);
    api.providers.subscriptions.state.set(ref, [snapshot(ref)]);
    const tx = `tx_upper_${randomUUID()}`;
    const res = await postRc(rcEvent(ref, { store: 'APP_STORE', transaction_id: tx }));
    expect((await json<{ status: string }>(res)).status).toBe('processed');
    expect((await capacity(fam))?.paid_slots).toBe(2);
    const periods = await api.db.sql`
      select channel, charged_amount_cents from public.billing_periods where provider_period_id = ${tx}`;
    expect(periods).toEqual([{ channel: 'app_store', charged_amount_cents: 4998 }]);
  });

  function pureEvent(store: string | undefined): RevenueCatEvent {
    return {
      id: 'evt_pure',
      type: 'RENEWAL',
      app_user_id: 'fam_x',
      product_id: 'pl_family_2',
      store,
      purchased_at_ms: Date.parse('2026-09-10T00:00:00Z'),
      expiration_at_ms: Date.parse('2026-10-10T00:00:00Z'),
      price_in_purchased_currency: 49.98,
      currency: 'USD',
      period_type: 'NORMAL',
      transaction_id: 'tx_pure',
      event_timestamp_ms: Date.parse('2026-09-10T00:05:00Z'),
    };
  }

  it.each([
    ['APP_STORE', 'app_store'],
    ['PLAY_STORE', 'play_store'],
    ['AMAZON', 'amazon_appstore'],
    ['STRIPE', 'stripe'],
    ['app_store', 'app_store'],
    ['amazon', 'amazon_appstore'],
  ])('maps the webhook store %s to the %s channel', (store, channel) => {
    expect(mapRevenueCatEventToPeriod(pureEvent(store))?.channel).toBe(channel);
  });

  it('stores PencilLift does not sell on never become billing periods', () => {
    for (const store of [
      'PROMOTIONAL',
      'MAC_APP_STORE',
      'RC_BILLING',
      'amazon_appstore',
      undefined,
    ]) {
      expect(mapRevenueCatEventToPeriod(pureEvent(store))).toBeNull();
    }
  });

  it('maps the subscriber payload’s lowercase amazon store to amazon_appstore', () => {
    const now = new Date('2026-09-24T00:00:00Z');
    const snap = mapRevenueCatSubscription(
      'fam_x',
      'pl_family_2',
      {
        purchase_date: '2026-09-10T00:00:00Z',
        expires_date: '2026-10-10T00:00:00Z',
        store: 'amazon',
        is_sandbox: true,
      },
      now,
    );
    expect(snap?.channel).toBe('amazon_appstore');
    expect(snap?.providerSubscriptionId).toBe('rc:fam_x:amazon_appstore:pl_family_2');
    expect(mapRevenueCatSubscription('fam_x', 'p', { store: 'AMAZON' }, now)).toBeNull(); // no dates
  });

  it('an Amazon Appstore purchase grants capacity, records its period and can be refunded', async () => {
    const fam = await seedFamily(api.db, { childCount: 2 });
    const ref = await billingRef(fam);
    api.providers.subscriptions.state.set(ref, [
      snapshot(ref, {
        channel: 'amazon_appstore',
        providerSubscriptionId: `rc:${ref}:amazon_appstore:pl_family_2`,
      }),
    ]);
    const tx = `tx_amzn_${randomUUID()}`;
    const purchase = await postRc(
      rcEvent(ref, { type: 'INITIAL_PURCHASE', store: 'AMAZON', transaction_id: tx }),
    );
    expect((await json<{ status: string }>(purchase)).status).toBe('processed');
    expect(await capacity(fam)).toEqual({ paid_slots: 2, conflict: null });
    const [period] = await api.db.sql<{ channel: string; settlement: string }[]>`
      select channel, settlement from public.billing_periods where provider_period_id = ${tx}`;
    expect(period).toEqual({ channel: 'amazon_appstore', settlement: 'settled' });
    await postRc(
      rcEvent(ref, {
        type: 'CANCELLATION',
        cancel_reason: 'CUSTOMER_SUPPORT',
        store: 'AMAZON',
        transaction_id: tx,
      }),
    );
    const [after] = await api.db.sql<{ settlement: string }[]>`
      select settlement from public.billing_periods where provider_period_id = ${tx}`;
    expect(after!.settlement).toBe('refunded');
  });
});
