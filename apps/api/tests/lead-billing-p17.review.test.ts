import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cryptoRandom } from '@pencillift/domain';
import type { ProviderSubscriptionSnapshot } from '@pencillift/domain/entitlements';
import { generatePromoCode } from '@pencillift/domain/promotions';
import {
  grantAdultUnlock,
  seedFamily,
  seedOwnerAdmin,
  type SeededFamily,
} from '@pencillift/db/testing/fixtures';
import {
  expireStaleReservations,
  reconcileStaleEntitlements,
  type JobDeps,
} from '../src/jobs/dispatcher.ts';
import { hmacSha256, toHex } from '../src/security/crypto.ts';
import { runDonationAccrual } from '../src/services/p17-jobs.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * Adversarial review of the billing / P17 slice (RV-lead-billing-p17-*). Every test here encodes the
 * spec-required outcome and FAILS against the current implementation; see the finding ids.
 * Mocks are labeled mocks (subscriber-state and Stripe client mocks from helpers.ts).
 */

const RC_AUTH = 'Bearer rc-webhook-secret-for-review-0123456789';
const STRIPE_SECRET = 'whsec_review_secret_for_signature_checks';
const SESSION = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
const BASE_NOW = new Date('2026-09-24T15:00:00Z');

let api: TestApi;
let adminId: string;
let schoolId: string;
let jobDeps: JobDeps;

async function billingRef(target: TestApi, fam: SeededFamily): Promise<string> {
  const [row] = await target.db.sql<
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
    fetchedAt: BASE_NOW,
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

const postRc = (target: TestApi, body: unknown) =>
  target.request('/webhooks/revenuecat', {
    method: 'POST',
    body,
    headers: { authorization: RC_AUTH },
  });

async function signedStripe(body: unknown, when = BASE_NOW) {
  const raw = JSON.stringify(body);
  const t = Math.floor(when.getTime() / 1000);
  const sig = toHex(await hmacSha256(new TextEncoder().encode(STRIPE_SECRET), `${t}.${raw}`));
  return { raw, header: `t=${t},v1=${sig}` };
}

async function postStripe(body: unknown) {
  const { raw, header } = await signedStripe(body);
  return api.app.request('/webhooks/stripe', {
    method: 'POST',
    body: raw,
    headers: { 'stripe-signature': header, 'content-type': 'application/json' },
  });
}

async function createCampaign(
  target: TestApi,
  month: string,
  percent: number,
  channels: readonly string[] = ['app_store', 'play_store', 'stripe'],
): Promise<{ campaignId: string; code: string }> {
  const [tpl] = await target.db.sql<{ id: string }[]>`
    insert into public.promo_campaign_templates
      (name, percent_off, eligible_tiers, subscriber_eligibility, redemption_cap, budget_cap_cents, calendar_timezone,
       timezone_confirmed, code_mode, channels, enabled, created_by)
    values (${`Review ${month} ${percent} ${randomUUID()}`}, ${percent}, '{1,2,3,4}', '{new,existing,lapsed}', 100, 1000000,
            'UTC', true, 'shared', ${[...channels]}, true, ${adminId})
    returning id
  `;
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const [camp] = await target.db.sql<{ id: string }[]>`
    insert into public.promo_campaigns (template_id, campaign_month, generation_key, percent_off, eligible_tiers,
      subscriber_eligibility, redemption_cap, budget_cap_cents, opens_at, closes_at, status)
    values (${tpl!.id}, ${month}, ${tpl!.id + ':' + month}, ${percent}, '{1,2,3,4}', '{new,existing,lapsed}', 100, 1000000,
            ${month + '-01T00:00:00Z'}, ${next + '-01T00:00:00Z'}, 'active')
    returning id
  `;
  const code = generatePromoCode(cryptoRandom);
  await target.db
    .sql`insert into public.promo_codes (campaign_id, code_normalized) values (${camp!.id}, ${code.normalized})`;
  for (const channel of channels) {
    for (const slots of [1, 2, 3, 4]) {
      await target.db.sql`
        insert into public.provider_offer_mappings (campaign_id, channel, paid_slots, provider_offer_id, status)
        values (${camp!.id}, ${channel}, ${slots}, ${`offer_${month}_${channel}_${slots}`}, 'ready')
      `;
    }
  }
  return { campaignId: camp!.id, code: code.display };
}

/** A family whose verified entitlement row is inserted directly (as the webhook ledger would hold it). */
async function familyWithEntitlement(
  status: 'active' | 'cancelled_active' | 'expired',
  periodStart: string,
  periodEnd: string,
): Promise<SeededFamily & { token: string; ref: string }> {
  const fam = await seedFamily(api.db, { childCount: 2 });
  const ref = await billingRef(api, fam);
  if (status !== 'expired') {
    await api.db
      .sql`insert into public.family_capacity (family_id, paid_slots, managing_channel) values (${fam.familyId}, 2, 'app_store')`;
  }
  await api.db.sql`
    insert into public.family_entitlements (family_id, channel, provider_subscription_id, product_id, paid_slots, status,
      environment, period_start, period_end, auto_renew, provider_updated_at, fetched_at)
    values (${fam.familyId}, 'app_store', ${`rc:${ref}:app_store:pl_family_2`}, 'pl_family_2', 2, ${status}, 'sandbox',
            ${periodStart}, ${periodEnd}, ${status === 'active'}, ${periodStart}, ${BASE_NOW})
  `;
  await grantAdultUnlock(api.db, fam.ownerId, SESSION, 7200);
  return { ...fam, ref, token: await parentToken(fam.ownerId, { sessionId: SESSION }) };
}

const redeem = (token: string, code: string, channel = 'app_store') =>
  api.request('/v1/family/promotions/redeem', {
    method: 'POST',
    token,
    body: { code, channel, idempotencyKey: randomUUID() },
  });

async function designate(target: TestApi, familyId: string, school: string) {
  await target.db.sql`
    insert into public.family_school_designations (family_id, school_id, effective_from)
    values (${familyId}, ${school}, '2026-08-01')`;
}

beforeAll(async () => {
  api = await createTestApi({
    REVENUECAT_WEBHOOK_AUTH: RC_AUTH,
    STRIPE_WEBHOOK_SECRET: STRIPE_SECRET,
    OPTIONAL_STRIPE_WEB_BILLING_ENABLED: 'true',
  });
  adminId = await seedOwnerAdmin(api.db);
  for (const [channel, product, slots] of [
    ['app_store', 'pl_family_2', 2],
    ['stripe', 'price_family_2', 2],
    ['stripe', 'price_family_3', 3],
  ] as const) {
    await api.db.sql`
      insert into public.store_product_mappings (channel, product_id, environment, paid_slots)
      values (${channel}, ${product}, 'sandbox', ${slots})
    `;
  }
  const [school] = await api.db.sql<{ id: string }[]>`
    insert into public.schools (name, status, recipient_verified) values ('Review Elementary', 'active', true) returning id`;
  schoolId = school!.id;
  jobDeps = {
    db: api.apiDb,
    config: api.config,
    clock: () => api.now.value,
    random: cryptoRandom,
    providers: api.providers,
    log: (e) => api.logs.push(e),
  };
});

afterAll(async () => {
  await api?.close();
});

describe('RV-lead-billing-p17-1: a lapsed subscriber redemption is reconciled by its re-subscription', () => {
  it('a discounted re-subscription through the redeemed offer confirms the lapsed family redemption', async () => {
    // Lapsed: the family's last store period ended on 10 Aug.
    const fam = await familyWithEntitlement(
      'expired',
      '2026-07-10T00:00:00Z',
      '2026-08-10T00:00:00Z',
    );
    const campaign = await createCampaign(api, '2026-09', 50, ['app_store']);
    const res = await redeem(fam.token, campaign.code);
    expect(res.status).toBe(201);
    const body = await json<{ id: string; state: string }>(res);
    const submitted = await api.request(`/v1/family/promotions/${body.id}/submitted`, {
      method: 'POST',
      token: fam.token,
    });
    expect((await json<{ state: string }>(submitted)).state).toBe('provider_pending');
    const [stored] = await api.db.sql<{ target_period_key: string }[]>`
      select target_period_key from public.promo_redemptions where id = ${body.id}`;
    // What the redeem route stores for a lapsed family (lapse-suffixed first-period key).
    expect(stored!.target_period_key).toBe('first:app_store:2026-08-10T00:00:00.000Z');

    // The family re-subscribes through the presented offer: the store charges the 50% price.
    api.providers.subscriptions.state.set(fam.ref, [
      snapshot(fam.ref, {
        periodStart: new Date('2026-09-24T15:05:00Z'),
        periodEnd: new Date('2026-10-24T15:05:00Z'),
        providerUpdatedAt: new Date('2026-09-24T15:05:00Z'),
      }),
    ]);
    const hook = await postRc(
      api,
      rcEvent(fam.ref, {
        type: 'INITIAL_PURCHASE',
        purchased_at_ms: Date.parse('2026-09-24T15:05:00Z'),
        expiration_at_ms: Date.parse('2026-10-24T15:05:00Z'),
        price_in_purchased_currency: 24.99,
        period_type: 'PROMOTIONAL',
        offer_code: 'offer_2026-09_app_store_2',
        event_timestamp_ms: Date.parse('2026-09-24T15:05:30Z'),
      }),
    );
    expect(hook.status).toBe(200);

    const [row] = await api.db.sql<{ state: string }[]>`
      select state from public.promo_redemptions where id = ${body.id}`;
    // Actual: still 'provider_pending' forever (reconciliation compares the key with the bare
    // `first:app_store`), the discount is logged as an unmatched store discount, and the family can
    // never redeem another code (promo_redemptions_one_in_flight).
    expect(row!.state).toBe('confirmed');
    const unmatched = await api.db.sql`
      select 1 from public.audit_events where family_id = ${fam.familyId} and action = 'promo.unmatched_discount'`;
    expect(unmatched).toHaveLength(0);
  });
});

describe('RV-lead-billing-p17-2: an in-flight redemption whose target period never happens is resolved', () => {
  it('after the subscription expires without renewing, the family is not blocked from future codes', async () => {
    // Auto-renew is off but still paid (cancelled_active may redeem for its next period).
    const fam = await familyWithEntitlement(
      'cancelled_active',
      '2026-09-10T00:00:00Z',
      '2026-10-10T00:00:00Z',
    );
    const september = await createCampaign(api, '2026-09', 50, ['app_store']);
    const november = await createCampaign(api, '2026-11', 50, ['app_store']);
    const first = await redeem(fam.token, september.code);
    expect(first.status).toBe(201);
    const { id } = await json<{ id: string }>(first);
    await api.request(`/v1/family/promotions/${id}/submitted`, {
      method: 'POST',
      token: fam.token,
    });

    try {
      // The subscription simply ends on 10 Oct: there is no renewal, so the offer cannot have applied.
      api.now.value = new Date('2026-10-11T00:00:00Z');
      api.providers.subscriptions.state.set(fam.ref, [
        snapshot(fam.ref, {
          status: 'expired',
          autoRenew: false,
          providerUpdatedAt: new Date('2026-10-10T00:00:00Z'),
        }),
      ]);
      const exp = await postRc(
        api,
        rcEvent(fam.ref, {
          type: 'EXPIRATION',
          transaction_id: undefined,
          price_in_purchased_currency: undefined,
        }),
      );
      expect(exp.status).toBe(200);
      // Every scheduled safety net runs, a month later.
      api.now.value = new Date('2026-11-15T12:00:00Z');
      await expireStaleReservations(jobDeps);
      await reconcileStaleEntitlements(jobDeps);

      const [row] = await api.db.sql<{ state: string }[]>`
        select state from public.promo_redemptions where id = ${id}`;
      // Actual: 'provider_pending' forever — no path resolves it once the target period is gone.
      expect(['rejected', 'expired']).toContain(row!.state);

      // The lapsed family enters November's fresh code.
      const again = await redeem(fam.token, november.code);
      // Actual: 422 PENDING_PROMOTION_EXISTS (and the campaign cap/budget slot stays consumed).
      expect(again.status).toBe(201);
    } finally {
      api.now.value = BASE_NOW;
    }
  });
});

describe('RV-lead-billing-p17-3: a refund delivered before its charge event is not lost', () => {
  it('a refunded period never accrues a school donation, whatever the webhook order', async () => {
    const fam = await seedFamily(api.db, { childCount: 2 });
    const ref = await billingRef(api, fam);
    await designate(api, fam.familyId, schoolId);
    const tx = `tx_ooo_${randomUUID()}`;
    // Provider state (fetched on every webhook) already shows the refund.
    api.providers.subscriptions.state.set(ref, [
      snapshot(ref, { status: 'refunded', providerUpdatedAt: new Date('2026-09-12T00:00:00Z') }),
    ]);
    // The refund (CANCELLATION / CUSTOMER_SUPPORT) arrives first, e.g. while the RENEWAL delivery is
    // in the provider's retry backoff after a transient 503.
    const refund = await postRc(
      api,
      rcEvent(ref, {
        type: 'CANCELLATION',
        cancel_reason: 'CUSTOMER_SUPPORT',
        transaction_id: tx,
        event_timestamp_ms: Date.parse('2026-09-12T00:00:00Z'),
      }),
    );
    expect((await json<{ status: string }>(refund)).status).toBe('processed');
    // The retried charge event for the same transaction arrives afterwards.
    const renewal = await postRc(api, rcEvent(ref, { transaction_id: tx }));
    expect((await json<{ status: string }>(renewal)).status).toBe('processed');

    await runDonationAccrual(api.apiDb, '2026-09', 'UTC');
    const [period] = await api.db.sql<{ settlement: string }[]>`
      select settlement from public.billing_periods where provider_period_id = ${tx}`;
    const accruals = await api.db.sql<{ net: number }[]>`
      select (a.amount_cents + coalesce((select sum(j.amount_cents) from public.donation_adjustments j where j.accrual_id = a.id), 0))::int as net
        from public.donation_accruals a where a.family_id = ${fam.familyId}`;
    // Actual: the period is recorded 'settled' and $1 accrues for a refunded month.
    expect(period!.settlement).toBe('refunded');
    expect(accruals.reduce((sum, a) => sum + a.net, 0)).toBe(0);
  });
});

describe('RV-lead-billing-p17-5: a Stripe event whose processing failed is reprocessed on retry', () => {
  it('a transient failure attaching the renewal discount does not lose the promotion', async () => {
    const fam = await seedFamily(api.db, { childCount: 2 });
    const ref = await billingRef(api, fam);
    const campaign = await createCampaign(api, '2026-09', 50, ['stripe']);
    const [code] = await api.db.sql<{ id: string }[]>`
      select id from public.promo_codes where campaign_id = ${campaign.campaignId}`;
    const [red] = await api.db.sql<{ id: string }[]>`
      insert into public.promo_redemptions (family_id, campaign_id, code_id, channel, target_period_key, target_period_start, state,
        idempotency_key, paid_slots, percent_off, regular_cents, discount_cents, charged_cents, redeemed_by)
      values (${fam.familyId}, ${campaign.campaignId}, ${code!.id}, 'stripe', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00Z',
        'reserved', ${'idem-' + randomUUID()}, 2, 50, 4998, 2499, 2499, ${fam.ownerId}) returning id`;
    await api.db
      .sql`update public.promo_redemptions set state = 'provider_pending' where id = ${red!.id}`;

    const start = Date.parse('2026-10-10T00:00:00Z') / 1000;
    const event = {
      id: `evt_${randomUUID()}`,
      type: 'invoice.created',
      data: {
        object: {
          id: `in_${randomUUID()}`,
          billing_reason: 'subscription_cycle',
          status: 'draft',
          subscription_details: { metadata: { billing_ref: ref } },
          lines: {
            data: [{ period: { start, end: start + 2678400 }, price: { id: 'price_family_2' } }],
          },
        },
      },
    };
    // Labeled mock: the Stripe API call fails once (timeout / 5xx), then works.
    const stripe = api.providers.stripe;
    const original = stripe.addDiscountToDraftInvoice.bind(stripe);
    let failures = 1;
    (stripe as { addDiscountToDraftInvoice: typeof original }).addDiscountToDraftInvoice = (
      invoiceId,
      couponId,
    ) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error('stripe timeout (mock)'));
      }
      return original(invoiceId, couponId);
    };
    try {
      const firstTry = await postStripe(event);
      expect(firstTry.status).toBeGreaterThanOrEqual(500);
      // Stripe retries the SAME event id.
      const retry = await postStripe(event);
      expect(retry.status).toBe(200);
    } finally {
      (stripe as { addDiscountToDraftInvoice: typeof original }).addDiscountToDraftInvoice =
        original;
    }
    // Actual: the retry is answered 'duplicate' (the event row stays 'received', and only 'failed'
    // rows are re-opened), so the coupon is never attached and the family is billed full price.
    expect(stripe.discounts.filter((d) => d.invoiceId === event.data.object.id)).toEqual([
      { invoiceId: event.data.object.id, couponId: 'offer_2026-09_stripe_2' },
    ]);
  });
});

describe('RV-lead-billing-p17-6: a Stripe chargeback reverses the accrued school donation', () => {
  it('charge.dispute.created (a Dispute object) records a -100 chargeback adjustment', async () => {
    const fam = await seedFamily(api.db, { childCount: 2 });
    const ref = await billingRef(api, fam);
    await designate(api, fam.familyId, schoolId);
    const invoiceId = `in_${randomUUID()}`;
    const start = Date.parse('2026-09-03T00:00:00Z') / 1000;
    const paid = await postStripe({
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
    expect(paid.status).toBe(200);
    await runDonationAccrual(api.apiDb, '2026-09', 'UTC');
    const [accrual] = await api.db.sql<{ id: string }[]>`
      select id from public.donation_accruals where family_id = ${fam.familyId}`;
    expect(accrual).toBeDefined();

    // A real Stripe Dispute object: it references the charge / payment intent, never an invoice.
    // (billing_ref metadata is included to give the handler every chance to find the family.)
    // Lead fix note: the handler resolves the charge to its invoice through the Stripe API; the
    // labeled mock is told what that API answers for this charge (it cannot guess a random id).
    const chargeId = `ch_${randomUUID()}`;
    api.providers.stripe.chargeInvoices.set(chargeId, invoiceId);
    const dispute = await postStripe({
      id: `evt_${randomUUID()}`,
      type: 'charge.dispute.created',
      data: {
        object: {
          id: `dp_${randomUUID()}`,
          object: 'dispute',
          amount: 4998,
          currency: 'usd',
          charge: chargeId,
          payment_intent: `pi_${randomUUID()}`,
          reason: 'fraudulent',
          status: 'needs_response',
          metadata: { billing_ref: ref },
        },
      },
    });
    expect(dispute.status).toBe(200);
    const adjustments = await api.db.sql<{ amount_cents: number; reason: string }[]>`
      select amount_cents, reason from public.donation_adjustments where accrual_id = ${accrual!.id}`;
    // Actual: [] — the handler requires `object.invoice`, which a Dispute never has.
    expect(adjustments).toEqual([{ amount_cents: -100, reason: 'chargeback' }]);
  });
});

describe('RV-lead-billing-p17-7: a Stripe partial refund is recorded as partial', () => {
  it('charge.refunded for part of the invoice keeps the true refunded amount', async () => {
    const fam = await seedFamily(api.db, { childCount: 2 });
    const ref = await billingRef(api, fam);
    const invoiceId = `in_${randomUUID()}`;
    const start = Date.parse('2026-09-05T00:00:00Z') / 1000;
    await postStripe({
      id: `evt_${randomUUID()}`,
      type: 'invoice.paid',
      data: {
        object: {
          id: invoiceId,
          billing_reason: 'subscription_cycle',
          status: 'paid',
          amount_paid: 4998,
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
    const res = await postStripe({
      id: `evt_${randomUUID()}`,
      type: 'charge.refunded',
      data: {
        object: {
          id: `ch_${randomUUID()}`,
          object: 'charge',
          amount: 4998,
          amount_refunded: 1000,
          refunded: false,
          invoice: invoiceId,
          metadata: { billing_ref: ref },
        },
      },
    });
    expect(res.status).toBe(200);
    const [period] = await api.db.sql<{ settlement: string; refunded_cents: number }[]>`
      select settlement, refunded_cents from public.billing_periods where provider_period_id = ${invoiceId}`;
    // Actual: { settlement: 'refunded', refunded_cents: 4998 } — a $10 refund is booked as $49.98.
    expect(period).toEqual({ settlement: 'partially_refunded', refunded_cents: 1000 });
  });
});

describe('RV-lead-billing-p17-8: a renewal invoice carrying proration lines still gets the promised coupon', () => {
  it('the target period is the subscription line, not the first (proration) line', async () => {
    const fam = await seedFamily(api.db, { childCount: 3 });
    const ref = await billingRef(api, fam);
    const campaign = await createCampaign(api, '2026-09', 50, ['stripe']);
    const [code] = await api.db.sql<{ id: string }[]>`
      select id from public.promo_codes where campaign_id = ${campaign.campaignId}`;
    const [red] = await api.db.sql<{ id: string }[]>`
      insert into public.promo_redemptions (family_id, campaign_id, code_id, channel, target_period_key, target_period_start, state,
        idempotency_key, paid_slots, percent_off, regular_cents, discount_cents, charged_cents, redeemed_by)
      values (${fam.familyId}, ${campaign.campaignId}, ${code!.id}, 'stripe', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00Z',
        'reserved', ${'idem-' + randomUUID()}, 2, 50, 4998, 2499, 2499, ${fam.ownerId}) returning id`;
    await api.db
      .sql`update public.promo_redemptions set state = 'provider_pending' where id = ${red!.id}`;
    const midCycle = Date.parse('2026-09-20T00:00:00Z') / 1000;
    const renewal = Date.parse('2026-10-10T00:00:00Z') / 1000;
    const invoiceId = `in_${randomUUID()}`;
    // The parent added a child on 20 Sep (default proration_behavior): Stripe puts the pending
    // proration items on the NEXT renewal invoice, listed before the subscription line.
    const res = await postStripe({
      id: `evt_${randomUUID()}`,
      type: 'invoice.created',
      data: {
        object: {
          id: invoiceId,
          billing_reason: 'subscription_cycle',
          status: 'draft',
          subscription_details: { metadata: { billing_ref: ref } },
          lines: {
            data: [
              {
                proration: true,
                period: { start: midCycle, end: renewal },
                price: { id: 'price_family_2' },
              },
              {
                proration: true,
                period: { start: midCycle, end: renewal },
                price: { id: 'price_family_3' },
              },
              {
                proration: false,
                period: { start: renewal, end: renewal + 2678400 },
                price: { id: 'price_family_3' },
              },
            ],
          },
        },
      },
    });
    expect(res.status).toBe(200);
    // Actual: [] — the period is read from lines.data[0] (20 Sep proration), so the 10 Oct target
    // never matches and the renewal is billed without the redeemed discount.
    expect(api.providers.stripe.discounts.filter((d) => d.invoiceId === invoiceId)).toHaveLength(1);
  });
});

describe('RV-lead-billing-p17-10: a family deleted while its webhook is in flight is not rebuilt', () => {
  it('the tombstone committed during the provider fetch stops every ledger write', async () => {
    const fam = await seedFamily(api.db, { childCount: 2 });
    const ref = await billingRef(api, fam);
    api.providers.subscriptions.state.set(ref, [snapshot(ref)]);
    // Labeled mock: the parent's deletion (public.request_deletion sets the tombstone) commits while
    // the webhook is waiting on the RevenueCat subscriber fetch (a network round trip).
    const subs = api.providers.subscriptions;
    const original = subs.fetchSubscriptions.bind(subs);
    (subs as { fetchSubscriptions: typeof original }).fetchSubscriptions = async (billing, now) => {
      await api.db.sql`
        update public.families set deletion_requested_at = now(), deleted_at = now() where id = ${fam.familyId}`;
      return original(billing, now);
    };
    const tx = `tx_deleted_${randomUUID()}`;
    try {
      const res = await postRc(api, rcEvent(ref, { transaction_id: tx }));
      expect(res.status).toBe(200);
    } finally {
      (subs as { fetchSubscriptions: typeof original }).fetchSubscriptions = original;
    }
    const entitlements = await api.db.sql`
      select 1 from public.family_entitlements where family_id = ${fam.familyId}`;
    const capacity = await api.db.sql`
      select 1 from public.family_capacity where family_id = ${fam.familyId}`;
    const periods = await api.db.sql`
      select 1 from public.billing_periods where provider_period_id = ${tx}`;
    // Actual: all three are written for the tombstoned family (the deleted_at check runs before the
    // fetch and is not repeated after `select ... for update`).
    expect({
      entitlements: entitlements.length,
      capacity: capacity.length,
      periods: periods.length,
    }).toEqual({ entitlements: 0, capacity: 0, periods: 0 });
  });
});

describe('RV-lead-billing-p17-4: sandbox store transactions never enter the production ledger', () => {
  let prod: TestApi;

  beforeAll(async () => {
    prod = await createTestApi({ APP_ENV: 'production', REVENUECAT_WEBHOOK_AUTH: RC_AUTH });
    await seedOwnerAdmin(prod.db);
    // Apple/Google use the SAME product ids in sandbox and production.
    await prod.db.sql`
      insert into public.store_product_mappings (channel, product_id, environment, paid_slots)
      values ('app_store', 'pl_family_2', 'production', 2)`;
  });

  afterAll(async () => {
    await prod?.close();
  });

  it('a RevenueCat SANDBOX renewal records no billing period and accrues no donation in production', async () => {
    expect(prod.config.billingEnvironment).toBe('production');
    const [school] = await prod.db.sql<{ id: string }[]>`
      insert into public.schools (name, status) values ('Prod Elementary', 'active') returning id`;
    const fam = await seedFamily(prod.db, { childCount: 2 });
    const ref = await billingRef(prod, fam);
    await designate(prod, fam.familyId, school!.id);
    // Labeled mock: RevenueCat reports the purchase as sandbox (TestFlight / App Review tester).
    prod.providers.subscriptions.state.set(ref, [snapshot(ref, { environment: 'sandbox' })]);
    const tx = `tx_sandbox_${randomUUID()}`;
    const body = rcEvent(ref, { transaction_id: tx });
    const res = await postRc(prod, { event: { ...body.event, environment: 'SANDBOX' } });
    expect(res.status).toBe(200);
    // Capacity is (correctly) not granted from a sandbox snapshot...
    const [cap] = await prod.db.sql<{ paid_slots: number }[]>`
      select paid_slots from public.family_capacity where family_id = ${fam.familyId}`;
    expect(cap?.paid_slots ?? 0).toBe(0);
    await runDonationAccrual(prod.apiDb, '2026-09', 'UTC');
    const periods = await prod.db.sql`
      select 1 from public.billing_periods where provider_period_id = ${tx}`;
    const accruals = await prod.db.sql`
      select 1 from public.donation_accruals where family_id = ${fam.familyId}`;
    // ...but actual: the sandbox transaction is booked as a settled production period and PencilLift
    // owes the school $1 for a purchase nobody paid for.
    expect(periods).toHaveLength(0);
    expect(accruals).toHaveLength(0);
  });
});
