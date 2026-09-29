import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revenueResponseSchema } from '@pencillift/contracts';
import { seedFamily, seedOwnerAdmin, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { cryptoRandom } from '@pencillift/domain';
import type { ProviderSubscriptionSnapshot } from '@pencillift/domain/entitlements';
import { reconcileStaleEntitlements } from '../src/jobs/dispatcher.ts';
import { createRevenueCatProvider, createStripeClient } from '../src/providers/billing.ts';
import { hmacSha256, toHex } from '../src/security/crypto.ts';
import {
  loadRevenueMonths,
  loadStoreFeeRates,
  loadSubscriptions,
} from '../src/services/ops-metrics.ts';
import {
  mapStripeInvoiceToPeriod,
  preTaxRefundCents,
  syncFamilyFromProvider,
  type StripeInvoice,
} from '../src/services/billing-sync.ts';
import { runDonationAccrual } from '../src/services/p17-jobs.ts';
import { createTestApi, parentToken, type TestApi } from './helpers.ts';

/**
 * Round-2 hardening review, billing and owner metrics (BILL-R2-1..6, JOBS-R2-04). Each test is the
 * regression test of one finding and failed before the fix in the same commit. Real local Postgres,
 * synthetic families, labeled mock providers; every fixture timestamp comes from the pinned clock's
 * month (L-027) and no test reads another test's rows.
 */

const STRIPE_SECRET = 'whsec_billing_r2_secret_for_signature_checks_1';
const RC_AUTH = 'Bearer rc-webhook-secret-for-billing-r2-0123456789ab';
const SEPTEMBER = new Date('2026-09-24T15:00:00Z');

let api: TestApi;
let adminId: string;
let adminToken: string;

const deps = () => ({
  db: api.apiDb,
  config: api.config,
  providers: api.providers,
  clock: () => api.now.value,
  random: cryptoRandom,
  log: (e: unknown) => api.logs.push(e as never),
});

async function billingRef(fam: SeededFamily): Promise<string> {
  const [row] = await api.db.sql<{ billing_ref: string }[]>`
    select billing_ref from public.families where id = ${fam.familyId}`;
  return row!.billing_ref;
}

const subscriptions = () => api.apiDb.asService((tx) => loadSubscriptions(tx, api.now.value));

/** A ledger row written directly, so a history older than the pinned clock can be stated exactly. */
async function entitlement(
  familyId: string,
  row: {
    channel?: string;
    productId?: string;
    status: string;
    createdAt: string;
    periodStart: string;
    periodEnd: string;
    slots?: number;
    /** When the provider last changed this row: the refund or revocation instant, if any. */
    providerUpdatedAt?: string;
    /** When PencilLift last observed the row; defaults to the provider instant (BILL-R4-1). */
    fetchedAt?: string;
  },
): Promise<void> {
  const observedAt = row.providerUpdatedAt ?? row.createdAt;
  const fetchedAt = row.fetchedAt ?? observedAt;
  await api.db.sql`
    insert into public.family_entitlements (family_id, channel, provider_subscription_id, product_id, paid_slots,
      status, environment, period_start, period_end, provider_updated_at, fetched_at, created_at)
    values (${familyId}, ${row.channel ?? 'app_store'}, ${`rc:probe:${randomUUID()}`},
            ${row.productId ?? 'pl_family_1'}, ${row.slots ?? 1}, ${row.status}, 'sandbox',
            ${row.periodStart}, ${row.periodEnd}, ${observedAt}, ${fetchedAt}, ${row.createdAt})`;
}

beforeAll(async () => {
  api = await createTestApi({
    STRIPE_WEBHOOK_SECRET: STRIPE_SECRET,
    OPTIONAL_STRIPE_WEB_BILLING_ENABLED: 'true',
    REVENUECAT_WEBHOOK_AUTH: RC_AUTH,
    PAYOUT_TRANSFERS_ENABLED: 'true',
  });
  adminId = await seedOwnerAdmin(api.db);
  adminToken = await parentToken(adminId, { aal: 'aal2' });
  for (const [channel, product, slots] of [
    ['app_store', 'pl_family_1', 1],
    ['app_store', 'pl_family_2', 2],
    ['stripe', 'price_family_1', 1],
  ] as const) {
    await api.db.sql`
      insert into public.store_product_mappings (channel, product_id, environment, paid_slots)
      values (${channel}, ${product}, 'sandbox', ${slots})`;
  }
});

afterAll(async () => {
  await api?.close();
});

describe('BILL-R2-1: churn is measured per family and can never exceed 100%', () => {
  it('a subscription that starts and lapses inside the month does not inflate the rate', async () => {
    api.now.value = SEPTEMBER;
    await api.db.sql`delete from public.family_entitlements`;
    const base = await seedFamily(api.db, { childCount: 1 });
    await entitlement(base.familyId, {
      status: 'active',
      createdAt: '2026-08-10T00:00:00Z',
      periodStart: '2026-09-10T00:00:00Z',
      periodEnd: '2026-10-10T00:00:00Z',
    });
    // Three families whose store trial / first month started and ended inside September: they were
    // never in the base, so they can never be part of the base's churn.
    for (let i = 0; i < 3; i += 1) {
      const fam = await seedFamily(api.db, { childCount: 1 });
      await entitlement(fam.familyId, {
        channel: 'play_store',
        status: 'expired',
        createdAt: '2026-09-02T00:00:00Z',
        periodStart: '2026-09-02T00:00:00Z',
        periodEnd: '2026-09-09T00:00:00Z',
      });
    }
    const s = await subscriptions();
    expect(s.activeAtMonthStart.value).toBe(1);
    // Before the fix: lapsed 3 against a base of 1, i.e. churn 30000 basis points (300%).
    expect(s.lapsedThisMonth.value).toBe(0);
    expect(s.churn.basisPoints).toBe(0);
    expect(s.churn.basisPoints).toBeLessThanOrEqual(10_000);
  });

  it('a tier upgrade is neither a new subscription nor a lapse', async () => {
    await api.db.sql`delete from public.family_entitlements`;
    const fam = await seedFamily(api.db, { childCount: 2 });
    const ref = await billingRef(fam);
    const base: Omit<ProviderSubscriptionSnapshot, 'fetchedAt'> = {
      channel: 'app_store',
      providerSubscriptionId: `rc:${ref}:app_store:pl_family_1`,
      productId: 'pl_family_1',
      status: 'active',
      periodStart: new Date('2026-08-12T00:00:00Z'),
      periodEnd: new Date('2026-09-12T00:00:00Z'),
      autoRenew: true,
      environment: 'sandbox',
      providerUpdatedAt: new Date('2026-08-12T00:00:00Z'),
    };
    api.now.value = new Date('2026-08-20T00:00:00Z');
    api.providers.subscriptions.state.set(ref, [{ ...base, fetchedAt: api.now.value }]);
    await syncFamilyFromProvider(deps(), fam.familyId, ref, api.now.value);
    await api.db.sql`
      update public.family_entitlements set created_at = '2026-08-12T00:00:00Z'
       where family_id = ${fam.familyId}`;
    // 14 September: the same store subscription moves to the 2-child product. RevenueCat keys a
    // ledger row by product, so the old row expires and a second row appears.
    api.now.value = SEPTEMBER;
    api.providers.subscriptions.state.set(ref, [
      {
        ...base,
        status: 'expired',
        periodEnd: new Date('2026-09-14T00:00:00Z'),
        providerUpdatedAt: new Date('2026-09-14T00:00:00Z'),
        fetchedAt: api.now.value,
      },
      {
        ...base,
        providerSubscriptionId: `rc:${ref}:app_store:pl_family_2`,
        productId: 'pl_family_2',
        periodStart: new Date('2026-09-14T00:00:00Z'),
        periodEnd: new Date('2026-10-14T00:00:00Z'),
        providerUpdatedAt: new Date('2026-09-14T00:00:00Z'),
        fetchedAt: api.now.value,
      },
    ]);
    await syncFamilyFromProvider(deps(), fam.familyId, ref, api.now.value);
    const s = await subscriptions();
    expect(s.activeAtMonthStart.value).toBe(1);
    // Before the fix: 1 new + 1 lapsed + 100% churn for a family that upgraded and never left.
    expect(s.newThisMonth.value).toBe(0);
    expect(s.lapsedThisMonth.value).toBe(0);
    expect(s.churn.basisPoints).toBe(0);
  });

  it("a family's first subscription of the month is still counted as new", async () => {
    await api.db.sql`delete from public.family_entitlements`;
    api.now.value = SEPTEMBER;
    const fam = await seedFamily(api.db, { childCount: 1 });
    await entitlement(fam.familyId, {
      status: 'active',
      createdAt: '2026-09-03T00:00:00Z',
      periodStart: '2026-09-03T00:00:00Z',
      periodEnd: '2026-10-03T00:00:00Z',
    });
    const s = await subscriptions();
    expect(s.newThisMonth.value).toBe(1);
    expect(s.activeAtMonthStart.value).toBe(0);
    expect(s.churn.basisPoints).toBeNull();
  });

  // BILL-R2-1-a (re-fix): the first fix made "lapsed" mean "grants nothing at the request instant",
  // with no requirement that the ending fall in the reported month. A refund is exactly that state:
  // providers/billing.ts keeps the provider's expires_date when it marks a row refunded, so a
  // subscription refunded on 20 August still carries period_end 1 December. Such a family stayed in
  // the base and out of the active set every month until December, so the owner was shown a fresh
  // 100% churn month after month for one family that left once (monthly plans were double counted,
  // annual plans counted every month to their original expiry).
  it('a family that left once is counted in that month only, not in every month to its period end', async () => {
    await api.db.sql`delete from public.family_entitlements`;
    const fam = await seedFamily(api.db, { childCount: 1 });
    await entitlement(fam.familyId, {
      status: 'refunded',
      createdAt: '2026-07-01T00:00:00Z',
      periodStart: '2026-07-01T00:00:00Z',
      periodEnd: '2026-12-01T00:00:00Z',
      providerUpdatedAt: '2026-08-20T00:00:00Z',
    });
    const monthOf = async (iso: string) => {
      api.now.value = new Date(iso);
      const s = await subscriptions();
      return {
        base: s.activeAtMonthStart.value,
        lapsed: s.lapsedThisMonth.value,
        churn: s.churn.basisPoints,
      };
    };
    // August is the month it left: it was paying on 1 August and the refund ended it on 20 August.
    expect(await monthOf('2026-08-24T15:00:00Z')).toEqual({ base: 1, lapsed: 1, churn: 10_000 });
    // Before this re-fix: base 1, lapsed 1, churn 10000 in each of September, October and November.
    expect(await monthOf('2026-09-24T15:00:00Z')).toEqual({ base: 0, lapsed: 0, churn: null });
    expect(await monthOf('2026-10-24T15:00:00Z')).toEqual({ base: 0, lapsed: 0, churn: null });
    expect(await monthOf('2026-11-24T15:00:00Z')).toEqual({ base: 0, lapsed: 0, churn: null });
    api.now.value = SEPTEMBER;
  });

  // The other way the same rule can go wrong: an `active` row whose 30-day access bound ran out
  // (no renewal was ever observed) stops granting inside a later month than its period_end. Its
  // ending is period_end + the bound, so it is counted in the month access actually stopped.
  it('a subscription whose access bound runs out is counted in the month access stopped', async () => {
    await api.db.sql`delete from public.family_entitlements`;
    const fam = await seedFamily(api.db, { childCount: 1 });
    // Period ended 20 August, never renewed; the bound (30 days) carries access to 19 September.
    await entitlement(fam.familyId, {
      status: 'active',
      createdAt: '2026-07-20T00:00:00Z',
      periodStart: '2026-07-20T00:00:00Z',
      periodEnd: '2026-08-20T00:00:00Z',
    });
    api.now.value = new Date('2026-08-24T15:00:00Z');
    const aug = await subscriptions();
    // Still granting in August (inside the bound), so August is not its churn month.
    expect(aug.active.value).toBe(1);
    expect(aug.lapsedThisMonth.value).toBe(0);
    api.now.value = SEPTEMBER;
    const sep = await subscriptions();
    expect(sep.active.value).toBe(0);
    expect(sep.activeAtMonthStart.value).toBe(1);
    expect(sep.lapsedThisMonth.value).toBe(1);
    expect(sep.churn.basisPoints).toBe(10_000);
    // And October does not count it again.
    api.now.value = new Date('2026-10-24T15:00:00Z');
    const oct = await subscriptions();
    expect(oct.activeAtMonthStart.value).toBe(0);
    expect(oct.lapsedThisMonth.value).toBe(0);
    api.now.value = SEPTEMBER;
  });
});

describe('BILL-R2-2: a deleted family is out of the subscription counts and counts as churn', () => {
  it('a base family deleted during the month is not active and is counted as lapsed', async () => {
    await api.db.sql`delete from public.family_entitlements`;
    api.now.value = new Date('2026-10-24T15:00:00Z');
    const stays = await seedFamily(api.db, { childCount: 1 });
    await entitlement(stays.familyId, {
      status: 'active',
      createdAt: '2026-08-05T00:00:00Z',
      periodStart: '2026-10-05T00:00:00Z',
      periodEnd: '2026-11-05T00:00:00Z',
    });
    const leaves = await seedFamily(api.db, { childCount: 1 });
    await entitlement(leaves.familyId, {
      status: 'active',
      createdAt: '2026-08-06T00:00:00Z',
      periodStart: '2026-10-06T00:00:00Z',
      periodEnd: '2026-11-06T00:00:00Z',
    });
    // The parent closed the account on 10 October; the store subscription's own state is frozen
    // (FAMILY_DELETED ignores its webhooks and the stale-entitlement sweep skips it).
    await api.db.sql`
      update public.families set deleted_at = '2026-10-10T00:00:00Z' where id = ${leaves.familyId}`;
    const s = await subscriptions();
    // Before the fix: active 2, subscribedFamilies 2, lapsed 0, churn 0.
    expect(s.active.value).toBe(1);
    expect(s.subscribedFamilies.value).toBe(1);
    expect(s.activeAtMonthStart.value).toBe(2);
    expect(s.lapsedThisMonth.value).toBe(1);
    expect(s.churn.basisPoints).toBe(5000);
  });

  it('a family deleted before the month began is in no October figure at all', async () => {
    await api.db.sql`delete from public.family_entitlements`;
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    api.now.value = new Date('2026-09-10T00:00:00Z');
    const snap: ProviderSubscriptionSnapshot = {
      channel: 'app_store',
      providerSubscriptionId: `rc:${ref}:app_store:pl_family_1`,
      productId: 'pl_family_1',
      status: 'active',
      periodStart: new Date('2026-09-05T00:00:00Z'),
      periodEnd: new Date('2026-10-05T00:00:00Z'),
      autoRenew: true,
      environment: 'sandbox',
      providerUpdatedAt: new Date('2026-09-05T00:00:00Z'),
      fetchedAt: api.now.value,
    };
    api.providers.subscriptions.state.set(ref, [snap]);
    await syncFamilyFromProvider(deps(), fam.familyId, ref, api.now.value);
    await api.db.sql`
      update public.family_entitlements set created_at = '2026-09-05T00:00:00Z'
       where family_id = ${fam.familyId}`;
    await api.db.sql`
      update public.families set deleted_at = '2026-09-20T00:00:00Z' where id = ${fam.familyId}`;
    api.providers.subscriptions.state.set(ref, [{ ...snap, status: 'expired', autoRenew: false }]);
    api.now.value = new Date('2026-10-24T15:00:00Z');
    // The sweep still skips the tombstoned family, so the row stays 'active' in the ledger.
    expect(await reconcileStaleEntitlements(deps() as never)).toBe(0);
    const [row] = await api.db.sql<{ status: string }[]>`
      select status from public.family_entitlements where family_id = ${fam.familyId}`;
    expect(row!.status).toBe('active');
    const s = await subscriptions();
    // Before the fix: active 1 and subscribedFamilies 1 for a family that no longer exists.
    expect(s.active.value).toBe(0);
    expect(s.subscribedFamilies.value).toBe(0);
    // The BILL-R2-2 probe expected October lapsed = 1 here. That expectation is wrong: this family
    // was deleted on 20 September, so it left in September and is not part of October's base (the
    // lead's rule: the base is families granting access at the month start). It is in no October
    // figure — and it did not subscribe before September either, so no month's base ever held it.
    expect(s.activeAtMonthStart.value).toBe(0);
    expect(s.lapsedThisMonth.value).toBe(0);
    expect(s.churn.basisPoints).toBeNull();
  });
});

describe('BILL-R2-3: the overview agrees with the P16 revenue summary', () => {
  it('network revenue on inventory sold as a sponsorship is excluded from both', async () => {
    api.now.value = SEPTEMBER;
    const [imp] = await api.db.sql<{ id: string }[]>`
      insert into public.revenue_imports (source, file_sha256, period_month, imported_by, row_count)
      values ('manual', ${'d'.repeat(64)}, '2026-09', ${adminId}, 2) returning id`;
    await api.db.sql`
      insert into public.revenue_entries (import_id, source, external_ref, category, provider, placement,
        amount_cents, period_month)
      values (${imp!.id}, 'manual', 'r2-sponsor-1', 'recognized', 'sponsor_direct', 'adult_dashboard', 50000, '2026-09'),
             (${imp!.id}, 'manual', 'r2-network-1', 'recognized', 'ad_network', 'adult_dashboard', 12000, '2026-09')`;
    const summary = (await (
      await api.request('/v1/admin/monetization/revenue/summary?month=2026-09', {
        token: adminToken,
      })
    ).json()) as { recognizedCents: number; excludedDoubleCountCents: number };
    const overview = (await (
      await api.request('/v1/admin/overview', { token: adminToken })
    ).json()) as { monetization: { recognizedThisMonthCents: { cents: number } } };
    expect(summary.excludedDoubleCountCents).toBe(12000);
    // Before the fix the overview reported 62000: the raw SUM counted the excluded network revenue.
    expect(overview.monetization.recognizedThisMonthCents.cents).toBe(summary.recognizedCents);
    expect(overview.monetization.recognizedThisMonthCents.cents).toBe(50000);
  });
});

async function postStripe(body: unknown): Promise<Response> {
  const raw = JSON.stringify(body);
  const t = Math.floor(api.now.value.getTime() / 1000);
  const sig = toHex(await hmacSha256(new TextEncoder().encode(STRIPE_SECRET), `${t}.${raw}`));
  return api.app.request('/webhooks/stripe', {
    method: 'POST',
    body: raw,
    headers: { 'stripe-signature': `t=${t},v1=${sig}`, 'content-type': 'application/json' },
  });
}

function stripeInvoicePaid(
  invoiceId: string,
  ref: string,
  start: number,
  amounts: {
    subtotal?: number;
    tax?: number;
    amountPaid: number;
    totalExcludingTax?: number;
    /** Stripe's customer credit balance applied to this invoice (negative; BILL-R4-4). */
    startingBalance?: number;
    /** Stripe's reason for the invoice; 'subscription_update' is a standalone proration invoice. */
    billingReason?: string;
    lines?: unknown[];
  },
): unknown {
  return {
    id: `evt_${randomUUID()}`,
    type: 'invoice.paid',
    data: {
      object: {
        id: invoiceId,
        billing_reason: amounts.billingReason ?? 'subscription_cycle',
        status: 'paid',
        ...(amounts.subtotal === undefined ? {} : { subtotal: amounts.subtotal }),
        ...(amounts.tax === undefined ? {} : { tax: amounts.tax }),
        ...(amounts.totalExcludingTax === undefined
          ? {}
          : { total_excluding_tax: amounts.totalExcludingTax }),
        amount_paid: amounts.amountPaid,
        ...(amounts.startingBalance === undefined
          ? {}
          : { starting_balance: amounts.startingBalance }),
        currency: 'usd',
        total_discount_amounts: [],
        subscription_details: { metadata: { billing_ref: ref } },
        status_transitions: { paid_at: start + 60 },
        lines: {
          data: amounts.lines ?? [
            { period: { start, end: start + 30 * 86400 }, price: { id: 'price_family_1' } },
          ],
        },
      },
    },
  };
}

/** The owner's revenue view for the pinned clock's month, as the admin pages render it. */
async function revenueView() {
  return api.apiDb.asService(async (tx) => {
    const { rates } = await loadStoreFeeRates(tx);
    return loadRevenueMonths(tx, api.now.value, 1, rates);
  });
}

/** The Stripe line of the owner's revenue view for the pinned clock's month. */
async function stripeRevenue(): Promise<{ gross: number; refunds: number }> {
  const rev = await revenueView();
  const line = rev.months[0]!.channels.find((c) => c.channel === 'stripe');
  return { gross: line!.grossChargedCents, refunds: line!.refundedCents };
}

describe('BILL-R2-4: sales tax is not part of the Stripe subscription charge', () => {
  it('a full-price taxed renewal earns the $1 donation and books no tax as revenue', async () => {
    api.now.value = SEPTEMBER;
    const before = await stripeRevenue();
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const [school] = await api.db.sql<{ id: string }[]>`
      insert into public.schools (name, status) values ('R2 Oak Elementary', 'active') returning id`;
    await api.db.sql`
      insert into public.family_school_designations (family_id, school_id, effective_from, created_by)
      values (${fam.familyId}, ${school!.id}, '2026-08-01', ${fam.ownerId})`;
    const start = Date.parse('2026-09-03T00:00:00Z') / 1000;
    const invoiceId = `in_r2_${randomUUID()}`;
    // $39.99 renewal plus $3.30 state sales tax: the family paid 4329, PencilLift earned 3999.
    const res = await postStripe(
      stripeInvoicePaid(invoiceId, ref, start, { subtotal: 3999, tax: 330, amountPaid: 4329 }),
    );
    expect(res.status).toBe(200);
    const [period] = await api.db.sql<
      { charged_amount_cents: number; regular_amount_cents: number; discount_cents: number }[]
    >`
      select charged_amount_cents, regular_amount_cents, discount_cents from public.billing_periods
       where provider_period_id = ${invoiceId}`;
    // Before the fix: charged 4329 against a regular 3999.
    expect(period).toMatchObject({
      charged_amount_cents: 3999,
      regular_amount_cents: 3999,
      discount_cents: 0,
    });
    // The owner's revenue view books the subscription money only: the $3.30 of tax is a state's.
    const after = await stripeRevenue();
    expect(after.gross - before.gross).toBe(3999);
    const accrual = await runDonationAccrual(api.apiDb, '2026-09', api.config.programTimezone);
    expect(accrual).toMatchObject({ accrued: 1, skipped: 0 });
    const [accrued] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.donation_accruals where family_id = ${fam.familyId}`;
    expect(accrued!.n).toBe(1);
  });

  it('a pending proration line on a renewal invoice is not part of the period charge', async () => {
    api.now.value = SEPTEMBER;
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const start = Date.parse('2026-09-07T00:00:00Z') / 1000;
    const invoiceId = `in_r2_prorate_${randomUUID()}`;
    const res = await postStripe(
      stripeInvoicePaid(invoiceId, ref, start, {
        subtotal: 5199,
        tax: 0,
        amountPaid: 5199,
        lines: [
          {
            period: { start: start - 86400, end: start },
            price: { id: 'price_family_1' },
            proration: true,
            amount: 1200,
          },
          {
            period: { start, end: start + 30 * 86400 },
            price: { id: 'price_family_1' },
            amount: 3999,
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const [period] = await api.db.sql<{ charged_amount_cents: number }[]>`
      select charged_amount_cents from public.billing_periods where provider_period_id = ${invoiceId}`;
    // Before the fix: 5199, the whole invoice including the mid-cycle proration item.
    expect(period!.charged_amount_cents).toBe(3999);
  });

  it('a refund of the taxed total is capped at the charge, so net revenue is not negative', async () => {
    api.now.value = SEPTEMBER;
    const before = await stripeRevenue();
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const start = Date.parse('2026-09-09T00:00:00Z') / 1000;
    const invoiceId = `in_r2_refund_${randomUUID()}`;
    expect(
      (
        await postStripe(
          stripeInvoicePaid(invoiceId, ref, start, { subtotal: 3999, tax: 330, amountPaid: 4329 }),
        )
      ).status,
    ).toBe(200);
    const chargeId = `ch_${randomUUID()}`;
    api.providers.stripe.chargeInvoices.set(chargeId, invoiceId);
    const refunded = await postStripe({
      id: `evt_${randomUUID()}`,
      type: 'charge.refunded',
      data: {
        object: {
          id: chargeId,
          object: 'charge',
          amount: 4329,
          amount_refunded: 4329,
          refunded: true,
          invoice: invoiceId,
          metadata: { billing_ref: ref },
        },
      },
    });
    expect(refunded.status).toBe(200);
    const [period] = await api.db.sql<
      { settlement: string; charged_amount_cents: number; refunded_cents: number }[]
    >`
      select settlement, charged_amount_cents, refunded_cents from public.billing_periods
       where provider_period_id = ${invoiceId}`;
    expect(period).toMatchObject({
      settlement: 'refunded',
      charged_amount_cents: 3999,
      refunded_cents: 3999,
    });
    // Gross is the pre-tax subscription money and the refund reverses exactly that, never more:
    // this charge and its refund cancel out. Before the fix both figures carried the $3.30 of tax.
    const after = await stripeRevenue();
    expect(after.gross - before.gross).toBe(3999);
    expect(after.refunds - before.refunds).toBe(3999);
  });

  /**
   * The case that tells the denominators apart: an invoice with BOTH a proration line AND tax. With
   * no tax the conversion is skipped outright, and on a tax-only invoice the Charge total and
   * charge + tax are the same number — so neither of the two cases above can catch a denominator that
   * is still the whole Charge, nor one that is the charge plus the WHOLE invoice's tax.
   *
   * N1-TAX-APPORTION: the tax on this invoice was added to BOTH lines, and the proration line is no
   * part of this period's charge, so the tax that belongs to that line may no more scale a refund of
   * subscription money than the line's own amount may. The denominator is the charge plus the tax
   * apportioned TO THE CHARGE (subscriptionTaxCents), which is what the period stores.
   */
  it('converts a partial refund by the tax on the subscription portion, not the whole invoice’s tax', async () => {
    api.now.value = SEPTEMBER;
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const start = Date.parse('2026-09-13T00:00:00Z') / 1000;
    const invoiceId = `in_r5_prorate_taxed_${randomUUID()}`;
    // $39.99 renewal + a $10 proration item, with 8.25% sales tax on the 4999: the family paid 5411,
    // and the charge booked as revenue is the subscription line's 3999 (BILL-R2-4).
    expect(
      (
        await postStripe(
          stripeInvoicePaid(invoiceId, ref, start, {
            subtotal: 4999,
            tax: 412,
            amountPaid: 5411,
            lines: [
              {
                period: { start: start - 86400, end: start },
                price: { id: 'price_family_1' },
                proration: true,
                amount: 1000,
              },
              {
                period: { start, end: start + 30 * 86400 },
                price: { id: 'price_family_1' },
                amount: 3999,
              },
            ],
          }),
        )
      ).status,
    ).toBe(200);
    const chargeId = `ch_${randomUUID()}`;
    api.providers.stripe.chargeInvoices.set(chargeId, invoiceId);
    const refunded = await postStripe({
      id: `evt_${randomUUID()}`,
      type: 'charge.refunded',
      data: {
        object: {
          id: chargeId,
          object: 'charge',
          amount: 5411,
          amount_refunded: 2000,
          refunded: false,
          invoice: invoiceId,
          metadata: { billing_ref: ref },
        },
      },
    });
    expect(refunded.status).toBe(200);
    const [period] = await api.db.sql<
      { charged_amount_cents: number; tax_amount_cents: number; refunded_cents: number }[]
    >`
      select charged_amount_cents, tax_amount_cents, refunded_cents from public.billing_periods
       where provider_period_id = ${invoiceId}`;
    // The $20 came back out of a charge whose taxed part was the $39.99 subscription at 8.25%, so
    // 1848 of it was subscription revenue (2000 x 3999 / (3999 + 329)) and the remaining 152 was the
    // state's. The stored tax is the invoice's 412 apportioned to the charge:
    // floor(412 x 3999 / (3999 + 1000)) = 329, the proration line's ~83 cents of tax left out of it.
    //
    // The two denominators this rules out: the whole Charge, round(2000 x 3999 / 5411) = 1478, which
    // hands the proration line a 370-cent share of a refund it never received; and the charge plus
    // the WHOLE invoice tax, round(2000 x 3999 / (3999 + 412)) = 1813, which still scales the refund
    // down by the tax of a line this period never booked as revenue. Both overstate net revenue.
    expect(period).toMatchObject({
      charged_amount_cents: 3999,
      tax_amount_cents: 329,
      refunded_cents: 1848,
    });
    // Nothing of the proration's money is in either figure: the period books the subscription line
    // (3999) and 1848 of it came back.
  });
});

describe('BILL-R2-5: a payout batch nets only the reversals it is allowed to', () => {
  it("an August batch is not reduced by the reversal of September's unpaid accrual", async () => {
    api.now.value = SEPTEMBER;
    const [school] = await api.db.sql<{ id: string }[]>`
      insert into public.schools (name, status, recipient_verified)
      values ('R2 Birch Elementary', 'active', true) returning id`;
    const famAug = await seedFamily(api.db, { childCount: 1 });
    const famSep = await seedFamily(api.db, { childCount: 1 });
    const periodFor = async (familyId: string, startIso: string): Promise<string> => {
      const [row] = await api.db.sql<{ id: string }[]>`
        insert into public.billing_periods (family_id, channel, provider_period_id, kind, period_start,
          period_end, paid_slots, regular_amount_cents, charged_amount_cents, settlement, settled_at)
        values (${familyId}, 'app_store', ${`r2-payout-${randomUUID()}`}, 'subscription_period',
                ${startIso}, ${startIso}::timestamptz + interval '30 days', 1, 3999, 3999, 'settled', ${startIso})
        returning id`;
      return row!.id;
    };
    await api.db.sql`
      insert into public.donation_accruals (family_id, school_id, donation_month, billing_period_id, eligibility_snapshot)
      values (${famAug.familyId}, ${school!.id}, '2026-08',
              ${await periodFor(famAug.familyId, '2026-08-05T00:00:00Z')}, '{}'::text::jsonb)`;
    const [sep] = await api.db.sql<{ id: string }[]>`
      insert into public.donation_accruals (family_id, school_id, donation_month, billing_period_id, eligibility_snapshot)
      values (${famSep.familyId}, ${school!.id}, '2026-09',
              ${await periodFor(famSep.familyId, '2026-09-05T00:00:00Z')}, '{}'::text::jsonb)
      returning id`;
    // September's charge was refunded: the reversal nets against September's own unpaid accrual.
    await api.db.sql`
      insert into public.donation_adjustments (accrual_id, amount_cents, reason, idempotency_key)
      values (${sep!.id}, -100, 'refund', ${`${sep!.id}:reversal`})`;
    const august = await api.request('/v1/admin/payouts/prepare', {
      method: 'POST',
      token: adminToken,
      body: { schoolId: school!.id, throughMonth: '2026-08' },
    });
    // Before the fix: 200 {"status":"carried_forward","netCents":0} — August's $1 was withheld.
    expect(august.status).toBe(200);
    expect(await august.json()).toMatchObject({
      status: 'created',
      payout: { totalCents: 100 },
    });
    // September's reversal is still unbatched, so the September batch nets it against its accrual.
    const [stillOpen] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.donation_adjustments
       where accrual_id = ${sep!.id} and payout_batch_id is null`;
    expect(stillOpen!.n).toBe(1);
    const september = await api.request('/v1/admin/payouts/prepare', {
      method: 'POST',
      token: adminToken,
      body: { schoolId: school!.id, throughMonth: '2026-09' },
    });
    expect(await september.json()).toMatchObject({ status: 'carried_forward', netCents: 0 });
  });

  it('a reversal of an accrual already batched is carried forward into the next batch', async () => {
    api.now.value = SEPTEMBER;
    const [school] = await api.db.sql<{ id: string }[]>`
      insert into public.schools (name, status, recipient_verified)
      values ('R2 Cedar Elementary', 'active', true) returning id`;
    const paidFamily = await seedFamily(api.db, { childCount: 1 });
    const [period] = await api.db.sql<{ id: string }[]>`
      insert into public.billing_periods (family_id, channel, provider_period_id, kind, period_start,
        period_end, paid_slots, regular_amount_cents, charged_amount_cents, settlement, settled_at)
      values (${paidFamily.familyId}, 'app_store', ${`r2-carry-${randomUUID()}`}, 'subscription_period',
              '2026-08-05T00:00:00Z', '2026-09-04T00:00:00Z', 1, 3999, 3999, 'settled', '2026-08-05T00:00:00Z')
      returning id`;
    const [accrual] = await api.db.sql<{ id: string }[]>`
      insert into public.donation_accruals (family_id, school_id, donation_month, billing_period_id, eligibility_snapshot)
      values (${paidFamily.familyId}, ${school!.id}, '2026-08', ${period!.id}, '{}'::text::jsonb)
      returning id`;
    const first = await api.request('/v1/admin/payouts/prepare', {
      method: 'POST',
      token: adminToken,
      body: { schoolId: school!.id, throughMonth: '2026-08' },
    });
    expect(await first.json()).toMatchObject({ status: 'created', payout: { totalCents: 100 } });
    // The refund arrives after the batch was cut: the reversal is carried forward.
    await api.db.sql`
      insert into public.donation_adjustments (accrual_id, amount_cents, reason, idempotency_key)
      values (${accrual!.id}, -100, 'refund', ${`${accrual!.id}:reversal`})`;
    const second = await api.request('/v1/admin/payouts/prepare', {
      method: 'POST',
      token: adminToken,
      body: { schoolId: school!.id, throughMonth: '2026-09' },
    });
    expect(await second.json()).toMatchObject({ status: 'carried_forward', netCents: -100 });
  });
});

describe('BILL-R2-6: a refused webhook body is visible and its retry is processed', () => {
  it('a shape the schema refuses is a failed event the owner sees, and the retry records it', async () => {
    api.now.value = SEPTEMBER;
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const eventId = randomUUID();
    const txId = `tx_${randomUUID()}`;
    const event = {
      id: eventId,
      type: 'RENEWAL',
      app_user_id: ref,
      product_id: 'pl_family_1',
      store: 'APP_STORE',
      purchased_at_ms: Date.parse('2026-09-10T00:00:00Z'),
      expiration_at_ms: Date.parse('2026-10-10T00:00:00Z'),
      price_in_purchased_currency: 39.99,
      currency: 'USD',
      period_type: 'NORMAL',
      transaction_id: txId,
      event_timestamp_ms: Date.parse('2026-09-10T00:05:00Z'),
      environment: 'SANDBOX',
    };
    // A field shape the schema refuses (a period_type past the 40-character limit stands in for
    // any field RevenueCat sends that the schema does not expect).
    const refused = await api.request('/webhooks/revenuecat', {
      method: 'POST',
      body: { event: { ...event, period_type: 'X'.repeat(41) } },
      headers: { authorization: RC_AUTH },
    });
    expect(refused.status).toBe(400);
    const [row] = await api.db.sql<{ status: string; error_code: string }[]>`
      select status, error_code from public.billing_provider_events where provider_event_id = ${eventId}`;
    // Before the fix the row was 'ignored', which no attention rule counts.
    expect(row).toMatchObject({ status: 'failed', error_code: 'UNEXPECTED_SHAPE' });
    const overview = (await (
      await api.request('/v1/admin/overview', { token: adminToken })
    ).json()) as { attention: { kind: string; count: number }[] };
    const attention = overview.attention.find((a) => a.kind === 'billing_events_failed');
    expect(attention!.count).toBeGreaterThan(0);
    // RevenueCat retries the same event id; by then the deploy accepts the body.
    api.providers.subscriptions.state.set(ref, []);
    const retry = await api.request('/webhooks/revenuecat', {
      method: 'POST',
      body: { event },
      headers: { authorization: RC_AUTH },
    });
    // Before the fix: 200 {"status":"duplicate"} and the renewal was lost for good.
    expect(await retry.json()).toMatchObject({ status: 'processed' });
    const [period] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.billing_periods where provider_period_id = ${txId}`;
    expect(period!.n).toBe(1);
  });
});

describe('JOBS-R2-04: every RevenueCat and Stripe request carries a timeout', () => {
  /** A fetch that never answers, as a stalled TCP connection does, but honours the abort signal. */
  const stalledFetch = (seen: (signal: AbortSignal | null | undefined) => void): typeof fetch =>
    ((_url: string, init?: RequestInit) => {
      seen(init?.signal);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      });
    }) as unknown as typeof fetch;

  it('a stalled RevenueCat subscriber fetch aborts instead of holding the caller for ever', async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const provider = createRevenueCatProvider(
      'sk_test_not_a_secret',
      stalledFetch((s) => signals.push(s)),
      25,
    );
    // Before the fix no signal was passed and this promise never settled: the whole scheduled tick
    // (and the job ledger step behind it) waited on the stalled connection.
    await expect(provider.fetchSubscriptions('ref_synthetic', SEPTEMBER)).rejects.toThrow(/abort/i);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it('every stalled Stripe request aborts as well', async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const client = createStripeClient(
      'sk_test_not_a_secret',
      stalledFetch((s) => signals.push(s)),
      25,
    );
    await expect(client.addDiscountToDraftInvoice('in_x', 'coupon_x')).rejects.toThrow(/abort/i);
    await expect(client.invoiceForCharge('ch_x', 'pi_x')).rejects.toThrow(/abort/i);
    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });
});

// -------------------------------------------------------------------------------------------------
// Round-4 hardening review (BILL-R4-1..5). These live in this file on purpose: the churn fixtures
// reset public.family_entitlements for the whole database, and vitest runs two files at a time, so
// every test that needs an exact whole-table count has to be serialized with the BILL-R2-1 ones.
// -------------------------------------------------------------------------------------------------

describe('BILL-R4-1: a lapse is dated by when paid access ended, never by provider_updated_at', () => {
  it('a subscription that simply ran out is in the base and lapses in the month it ran out', async () => {
    await api.db.sql`delete from public.family_entitlements`;
    api.now.value = SEPTEMBER;
    const fam = await seedFamily(api.db, { childCount: 1 });
    // Bought on 5 August, auto-renew turned off on 20 August, the paid period ran to 5 September.
    // mapRevenueCatSubscription derives provider_updated_at from the markers it has and deliberately
    // EXCLUDES expires_date, so for an expiry it is the cancellation instant (or the purchase), never
    // the instant access stopped.
    await entitlement(fam.familyId, {
      status: 'expired',
      createdAt: '2026-08-05T00:00:00Z',
      periodStart: '2026-08-05T00:00:00Z',
      periodEnd: '2026-09-05T00:00:00Z',
      providerUpdatedAt: '2026-08-20T00:00:00Z',
    });
    const s = await subscriptions();
    // Before the fix: least(period_end, provider_updated_at) dated the ending 20 August, so the
    // family was in NEITHER figure — base 0, lapsed 0, churn null — although it was paying on
    // 1 September and left on 5 September.
    expect(s.activeAtMonthStart.value).toBe(1);
    expect(s.lapsedThisMonth.value).toBe(1);
    expect(s.churn.basisPoints).toBe(10_000);
    // And it is counted in that month only: October's figures no longer hold it.
    api.now.value = new Date('2026-10-24T15:00:00Z');
    const oct = await subscriptions();
    expect(oct.activeAtMonthStart.value).toBe(0);
    expect(oct.lapsedThisMonth.value).toBe(0);
    api.now.value = SEPTEMBER;
  });

  it('a store subscription transferred away lapses in the month the transfer was observed', async () => {
    await api.db.sql`delete from public.family_entitlements`;
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const snap: ProviderSubscriptionSnapshot = {
      channel: 'app_store',
      providerSubscriptionId: `rc:${ref}:app_store:pl_family_1`,
      productId: 'pl_family_1',
      status: 'active',
      periodStart: new Date('2026-08-20T00:00:00Z'),
      periodEnd: new Date('2026-09-20T00:00:00Z'),
      autoRenew: true,
      environment: 'sandbox',
      providerUpdatedAt: new Date('2026-08-20T00:00:00Z'),
      fetchedAt: new Date('2026-08-20T00:00:00Z'),
    };
    api.now.value = new Date('2026-08-21T00:00:00Z');
    api.providers.subscriptions.state.set(ref, [snap]);
    await syncFamilyFromProvider(deps(), fam.familyId, ref, api.now.value);
    await api.db.sql`
      update public.family_entitlements set created_at = '2026-08-20T00:00:00Z'
       where family_id = ${fam.familyId}`;
    // 12 September: the purchase was restored onto another subscriber identity, so the complete
    // fetch no longer lists it. vanishedSnapshots re-observes the row as 'revoked' and KEEPS the
    // stored provider instant on purpose (the purchase date), stamping only the observation.
    api.now.value = new Date('2026-09-12T00:00:00Z');
    api.providers.subscriptions.state.set(ref, []);
    await syncFamilyFromProvider(deps(), fam.familyId, ref, api.now.value);
    const [row] = await api.db.sql<
      { status: string; provider_updated_at: Date; fetched_at: Date }[]
    >`
      select status, provider_updated_at, fetched_at from public.family_entitlements
       where family_id = ${fam.familyId}`;
    expect(row!.status).toBe('revoked');
    expect(row!.provider_updated_at.toISOString()).toBe('2026-08-20T00:00:00.000Z');
    api.now.value = SEPTEMBER;
    const s = await subscriptions();
    // Before the fix: the ending was dated by the (stale) provider instant, 20 August, so the
    // transfer-away appeared in no month's churn at all.
    expect(s.activeAtMonthStart.value).toBe(1);
    expect(s.lapsedThisMonth.value).toBe(1);
    expect(s.churn.basisPoints).toBe(10_000);
  });

  it('a mid-period refund is still dated by the provider refund instant', async () => {
    await api.db.sql`delete from public.family_entitlements`;
    const fam = await seedFamily(api.db, { childCount: 1 });
    // Refunded on 20 August inside a period running to 1 December (RevenueCat leaves expires_date
    // untouched on a refund): the family left in August, not in December.
    await entitlement(fam.familyId, {
      status: 'refunded',
      createdAt: '2026-07-01T00:00:00Z',
      periodStart: '2026-07-01T00:00:00Z',
      periodEnd: '2026-12-01T00:00:00Z',
      providerUpdatedAt: '2026-08-20T00:00:00Z',
    });
    api.now.value = new Date('2026-08-24T15:00:00Z');
    const aug = await subscriptions();
    expect(aug.activeAtMonthStart.value).toBe(1);
    expect(aug.lapsedThisMonth.value).toBe(1);
    api.now.value = SEPTEMBER;
    const sep = await subscriptions();
    expect(sep.activeAtMonthStart.value).toBe(0);
    expect(sep.lapsedThisMonth.value).toBe(0);
  });
});

describe('BILL-R4-5: the movement figures are counted in SQL, not one row per family', () => {
  /** Wraps a transaction so every query's decoded row count is recorded. */
  function recordingTx(
    tx: Parameters<Parameters<typeof api.apiDb.asService>[0]>[0],
    sizes: number[],
  ) {
    return new Proxy(tx, {
      apply(target, thisArg, args) {
        const result = Reflect.apply(target, thisArg, args) as Promise<unknown>;
        return Promise.resolve(result).then((rows) => {
          sizes.push(Array.isArray(rows) ? rows.length : 0);
          return rows;
        });
      },
    });
  }

  const widestResult = async (): Promise<number> => {
    const sizes: number[] = [];
    await api.apiDb.asService((tx) => loadSubscriptions(recordingTx(tx, sizes), api.now.value));
    return Math.max(...sizes);
  };

  it('adding families does not widen any result set the overview decodes', async () => {
    await api.db.sql`delete from public.family_entitlements`;
    api.now.value = SEPTEMBER;
    // Families that were in the base and lapsed this month: they hold no granting row, so the only
    // queries whose size could grow with them are the movement ones.
    const lapse = async (day: string): Promise<void> => {
      const fam = await seedFamily(api.db, { childCount: 1 });
      await entitlement(fam.familyId, {
        status: 'expired',
        createdAt: '2026-08-02T00:00:00Z',
        periodStart: '2026-08-02T00:00:00Z',
        periodEnd: `2026-09-${day}T00:00:00Z`,
        providerUpdatedAt: '2026-08-15T00:00:00Z',
      });
    };
    for (const day of ['02', '03', '04', '05']) await lapse(day);
    const withFour = await widestResult();
    for (const day of ['06', '07', '08', '09', '10', '11', '12', '13']) await lapse(day);
    const withTwelve = await widestResult();
    const s = await subscriptions();
    expect(s.activeAtMonthStart.value).toBe(12);
    expect(s.lapsedThisMonth.value).toBe(12);
    // Before the fix the base query returned one row per family (4, then 12) and the two integers
    // were counted in JS, so one Worker invocation held an array the size of the customer base.
    expect(withTwelve).toBe(withFour);
    expect(withTwelve).toBeLessThanOrEqual(4);
  });
});

describe('BILL-R4-2: the failed-webhook attention count can return to zero', () => {
  it('a refused body older than the provider retry window is no longer counted', async () => {
    api.now.value = SEPTEMBER;
    const failedCount = async (): Promise<number> => {
      const overview = (await (
        await api.request('/v1/admin/overview', { token: adminToken })
      ).json()) as { attention: { kind: string; count: number }[] };
      return overview.attention.find((a) => a.kind === 'billing_events_failed')!.count;
    };
    const before = await failedCount();
    const traced = async (receivedAt: string): Promise<void> => {
      await api.db.sql`
        insert into public.billing_provider_events (provider, provider_event_id, event_type,
          payload_sha256, status, received_at, processed_at, error_code)
        values ('revenuecat', ${`r4-shape-${randomUUID()}`}, 'TRANSFER', ${'e'.repeat(64)},
                'failed', ${receivedAt}, ${receivedAt}, 'UNEXPECTED_SHAPE')`;
    };
    // One refused body from a year ago, whose payload was never stored and which no provider will
    // ever redeliver, and one from this week that the owner can still act on.
    await traced('2025-09-20T00:00:00Z');
    await traced('2026-09-22T00:00:00Z');
    // Before the fix the rule had no window, so the stale row raised the count for ever and hid
    // genuinely new failures behind it.
    expect((await failedCount()) - before).toBe(1);
  });
});

describe('BILL-R4-3: a partial refund is recorded in the same unit as the charge', () => {
  it('the tax share of a partial refund is not taken off pre-tax revenue', async () => {
    api.now.value = SEPTEMBER;
    const before = await stripeRevenue();
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const start = Date.parse('2026-09-11T00:00:00Z') / 1000;
    const invoiceId = `in_r4_partial_${randomUUID()}`;
    // $39.99 renewal plus $3.30 state sales tax: charged_amount_cents is the pre-tax 3999.
    expect(
      (
        await postStripe(
          stripeInvoicePaid(invoiceId, ref, start, { subtotal: 3999, tax: 330, amountPaid: 4329 }),
        )
      ).status,
    ).toBe(200);
    const chargeId = `ch_${randomUUID()}`;
    api.providers.stripe.chargeInvoices.set(chargeId, invoiceId);
    // The owner refunds $20 of the tax-inclusive charge: 2000 of 4329 paid, i.e. 1848 of the 3999
    // of subscription revenue (the rest of the $20 was the state's tax), rounded half up.
    const refunded = await postStripe({
      id: `evt_${randomUUID()}`,
      type: 'charge.refunded',
      data: {
        object: {
          id: chargeId,
          object: 'charge',
          amount: 4329,
          amount_refunded: 2000,
          refunded: false,
          invoice: invoiceId,
          metadata: { billing_ref: ref },
        },
      },
    });
    expect(refunded.status).toBe(200);
    const [period] = await api.db.sql<
      {
        settlement: string;
        charged_amount_cents: number;
        tax_amount_cents: number;
        refunded_cents: number;
      }[]
    >`
      select settlement, charged_amount_cents, tax_amount_cents, refunded_cents
        from public.billing_periods where provider_period_id = ${invoiceId}`;
    // Before the fix: refunded_cents 2000, the tax-inclusive provider figure, against a pre-tax
    // charge of 3999, so the owner's net revenue was understated by the tax share of the refund.
    // HUNT5-C-2: 1848 now comes from the invoice's OWN tax, recorded with the period at invoice.paid
    // time (migration 0900) — stop writing tax_amount_cents and the ratio becomes 1 and this reads
    // 2000 again, so the assertion covers the stored column as well as the conversion.
    expect(period).toMatchObject({
      settlement: 'partially_refunded',
      charged_amount_cents: 3999,
      tax_amount_cents: 330,
      refunded_cents: 1848,
    });
    const after = await stripeRevenue();
    expect(after.gross - before.gross).toBe(3999);
    expect(after.refunds - before.refunds).toBe(1848);
  });

  /**
   * HUNT5-C-2: the conversion may only take the TAX off the provider's figure. A renewal invoice that
   * also carries a mid-cycle proration line is the normal shape for a family that added a child
   * (Stripe puts the pending proration item on the next renewal invoice), and that line is no part of
   * THIS period's charge (BILL-R2-4 — it is revenue on its own invoice instead, HUNT5-C-4), so it must
   * stay out of the denominator: dividing by the whole Charge attributes part of the refund to money
   * this period's gross never counted.
   */
  it('a partial refund on an invoice that also carried a proration line is not scaled down', async () => {
    api.now.value = SEPTEMBER;
    const before = await stripeRevenue();
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const start = Date.parse('2026-09-12T00:00:00Z') / 1000;
    const invoiceId = `in_r5_prorate_refund_${randomUUID()}`;
    // No sales tax: $39.99 for the renewal plus a $10 proration item from a mid-cycle plan change.
    // charged_amount_cents is the subscription line alone, 3999 (BILL-R2-4).
    expect(
      (
        await postStripe(
          stripeInvoicePaid(invoiceId, ref, start, {
            subtotal: 4999,
            tax: 0,
            amountPaid: 4999,
            lines: [
              {
                period: { start: start - 86400, end: start },
                price: { id: 'price_family_1' },
                proration: true,
                amount: 1000,
              },
              {
                period: { start, end: start + 30 * 86400 },
                price: { id: 'price_family_1' },
                amount: 3999,
              },
            ],
          }),
        )
      ).status,
    ).toBe(200);
    const chargeId = `ch_${randomUUID()}`;
    api.providers.stripe.chargeInvoices.set(chargeId, invoiceId);
    // The owner gives the $39.99 subscription back and keeps the $10 proration: nothing of this
    // period's revenue was kept, so the whole 3999 of gross is reversed. There is no tax to convert.
    const refunded = await postStripe({
      id: `evt_${randomUUID()}`,
      type: 'charge.refunded',
      data: {
        object: {
          id: chargeId,
          object: 'charge',
          amount: 4999,
          amount_refunded: 3999,
          refunded: false,
          invoice: invoiceId,
          metadata: { billing_ref: ref },
        },
      },
    });
    expect(refunded.status).toBe(200);
    const [period] = await api.db.sql<
      { charged_amount_cents: number; tax_amount_cents: number; refunded_cents: number }[]
    >`
      select charged_amount_cents, tax_amount_cents, refunded_cents from public.billing_periods
       where provider_period_id = ${invoiceId}`;
    // Before the fix: refunded_cents 3199, i.e. round(3999 x 3999 / 4999) — the refund scaled by the
    // proration's share of the Charge, so 800 cents of it reversed nothing at all. The invoice states
    // no tax, so the stored tax is 0, the ratio charged/(charged + 0) is 1 and there is nothing to
    // convert: the whole 3999 comes back.
    expect(period).toMatchObject({
      charged_amount_cents: 3999,
      tax_amount_cents: 0,
      refunded_cents: 3999,
    });
    const after = await stripeRevenue();
    // HUNT6-C-1: gross rises by 4999, the whole invoice's collection — 3999 for this period plus the
    // 1000 it also collected for the pending proration item, which is now recorded as its own period.
    // The refund names the invoice, so it reverses THIS period's charge; the $10 of mid-cycle service
    // the family kept is still revenue, and net for the invoice is 1000.
    expect(after.gross - before.gross).toBe(4999);
    expect(after.refunds - before.refunds).toBe(3999);
  });
});

describe('BILL-R4-4: a renewal settled from a credit balance books what was collected', () => {
  it('a credit-balance renewal is not a full-price month and earns no school donation', async () => {
    api.now.value = SEPTEMBER;
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const [school] = await api.db.sql<{ id: string }[]>`
      insert into public.schools (name, status) values ('R4 Maple Elementary', 'active') returning id`;
    await api.db.sql`
      insert into public.family_school_designations (family_id, school_id, effective_from, created_by)
      values (${fam.familyId}, ${school!.id}, '2026-08-01', ${fam.ownerId})`;
    const start = Date.parse('2026-09-13T00:00:00Z') / 1000;
    const invoiceId = `in_r4_credit_${randomUUID()}`;
    // A $25 customer credit balance left by an earlier downgrade settles most of this renewal:
    // Stripe collected $14.99. The subscription line still states the full 3999 and carries no
    // discount, so nothing but the payment figures says what came in.
    const res = await postStripe(
      stripeInvoicePaid(invoiceId, ref, start, {
        subtotal: 3999,
        tax: 0,
        amountPaid: 1499,
        startingBalance: -2500,
        lines: [
          {
            period: { start, end: start + 30 * 86400 },
            price: { id: 'price_family_1' },
            amount: 3999,
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const [period] = await api.db.sql<
      { charged_amount_cents: number; regular_amount_cents: number }[]
    >`
      select charged_amount_cents, regular_amount_cents from public.billing_periods
       where provider_period_id = ${invoiceId}`;
    // Before the fix: charged 3999 for a month in which $14.99 was collected.
    expect(period).toMatchObject({ charged_amount_cents: 1499, regular_amount_cents: 3999 });
    const accrual = await runDonationAccrual(api.apiDb, '2026-09', api.config.programTimezone);
    expect(accrual.skipped).toBeGreaterThan(0);
    const [accrued] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.donation_accruals where family_id = ${fam.familyId}`;
    // Before the fix the regular_tier_price rule passed and the school accrued $1 for it.
    expect(accrued!.n).toBe(0);
  });
});

describe('HUNT5-C-3 / HUNT6-C-2: every refund figure is in the recorded charge’s unit', () => {
  it('a partial chargeback on a taxed charge is restated in the pre-tax unit, and the note says so', async () => {
    api.now.value = SEPTEMBER;
    const before = await stripeRevenue();
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const start = Date.parse('2026-09-14T00:00:00Z') / 1000;
    const invoiceId = `in_r5_dispute_${randomUUID()}`;
    // $39.99 renewal plus $3.30 state sales tax: the recorded charge is the pre-tax 3999.
    expect(
      (
        await postStripe(
          stripeInvoicePaid(invoiceId, ref, start, { subtotal: 3999, tax: 330, amountPaid: 4329 }),
        )
      ).status,
    ).toBe(200);
    const chargeId = `ch_${randomUUID()}`;
    api.providers.stripe.chargeInvoices.set(chargeId, invoiceId);
    // A real Stripe Dispute: it states the disputed part of the charge and references the charge, and
    // carries no charge total — which is exactly why the conversion may not be inferred from one
    // (HUNT6-C-2). A Dispute `amount` is still a Charge figure, i.e. what the family paid INCLUDING
    // tax, and the tax it has to be restated by is the tax stored with this period.
    const dispute = await postStripe({
      id: `evt_${randomUUID()}`,
      type: 'charge.dispute.created',
      data: {
        object: {
          id: `dp_${randomUUID()}`,
          object: 'dispute',
          amount: 2000,
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
    const [period] = await api.db.sql<{ refunded_cents: number }[]>`
      select refunded_cents from public.billing_periods where provider_period_id = ${invoiceId}`;
    // $20 of the 4329 the family paid is 1848 of the 3999 that was booked as revenue:
    // round(2000 × 3999 ÷ 4329). Before HUNT6-C-2 the dispute amount was written unconverted at
    // 2000, a tax-inclusive figure against a pre-tax gross, so refunded_cents mixed two units.
    expect(period!.refunded_cents).toBe(1848);
    const after = await stripeRevenue();
    expect(after.refunds - before.refunds).toBe(1848);
    // So the note the owner reads beside that column may now promise ONE unit for every refund
    // figure, because there is one. It may no longer say a chargeback is kept at its own amount.
    const rev = await revenueView();
    const refundNote = rev.notes.find((n) => n.includes('Gross is the money collected'));
    expect(refundNote).toBeDefined();
    expect(refundNote).toMatch(
      /a chargeback and a won dispute are all recorded in that same pre-tax unit/,
    );
    expect(refundNote).not.toMatch(/at its own amount/);
    expect(rev.definition).toMatch(/restated in that same pre-tax unit/);
    expect(rev.definition).not.toMatch(/where the provider states the charge total/);
  });
});

describe('HUNT5-C-4: a proration charge is revenue, counted exactly once', () => {
  /**
   * REOPENED by the lead, reversing the previous fix. A mid-cycle proration charge is money a family
   * paid for service in that month, so it belongs in the owner's gross: understating revenue is worse
   * than an imprecise note, and the note is what was wrong. What BILL-R2-4 established is narrower —
   * a proration LINE listed on a RENEWAL invoice is not part of that renewal's charge — and both
   * halves together are what makes the money count once: the standalone proration invoice carries it,
   * and a renewal that lists the same item as a pending line does not carry it again.
   */
  it('a standalone proration invoice is counted once in gross, and a renewal does not count it again', async () => {
    api.now.value = SEPTEMBER;
    const before = await stripeRevenue();
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const start = Date.parse('2026-09-16T00:00:00Z') / 1000;
    const invoiceId = `in_r5_proration_only_${randomUUID()}`;
    // Stripe configured to invoice a mid-cycle change immediately: billing_reason
    // 'subscription_update' and a single proration line, which billing-sync maps to kind 'proration'.
    const prorationInvoice = () =>
      stripeInvoicePaid(invoiceId, ref, start, {
        subtotal: 1000,
        tax: 0,
        amountPaid: 1000,
        billingReason: 'subscription_update',
        lines: [
          {
            period: { start, end: start + 30 * 86400 },
            price: { id: 'price_family_1' },
            proration: true,
            amount: 1000,
          },
        ],
      });
    expect((await postStripe(prorationInvoice())).status).toBe(200);
    const [period] = await api.db.sql<{ kind: string; charged_amount_cents: number }[]>`
      select kind, charged_amount_cents from public.billing_periods
       where provider_period_id = ${invoiceId}`;
    expect(period).toMatchObject({ kind: 'proration', charged_amount_cents: 1000 });
    // The $10 the family really paid this month is in the owner's gross. The previous fix excluded
    // kind 'proration' from loadRevenueMonths, so this read 0 and the owner's revenue was understated
    // by every mid-cycle upgrade.
    const afterProration = await stripeRevenue();
    expect(afterProration.gross - before.gross).toBe(1000);
    expect(afterProration.refunds - before.refunds).toBe(0);

    // Counted ONCE: the same invoice.paid delivered again (a provider retry, a new event id) writes
    // no second period and adds nothing.
    expect((await postStripe(prorationInvoice())).status).toBe(200);
    const [rows] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.billing_periods where provider_period_id = ${invoiceId}`;
    expect(rows!.n).toBe(1);
    expect((await stripeRevenue()).gross - before.gross).toBe(1000);

    // And not counted a second time through a renewal: when Stripe leaves an item pending instead, it
    // lists it on the next renewal invoice, whose CHARGE is the subscription line alone (BILL-R2-4).
    // The renewal below carries a pending item of its own, so whichever way Stripe bills a mid-cycle
    // change the money it collected lands in gross exactly once — the standalone invoice's $10 on
    // that invoice, and this renewal's own $10 beside its $39.99 (HUNT6-C-1).
    const renewalStart = Date.parse('2026-09-18T00:00:00Z') / 1000;
    const renewalId = `in_r5_proration_renewal_${randomUUID()}`;
    expect(
      (
        await postStripe(
          stripeInvoicePaid(renewalId, ref, renewalStart, {
            subtotal: 4999,
            tax: 0,
            amountPaid: 4999,
            lines: [
              {
                period: { start: renewalStart - 86400, end: renewalStart },
                price: { id: 'price_family_1' },
                proration: true,
                amount: 1000,
              },
              {
                period: { start: renewalStart, end: renewalStart + 30 * 86400 },
                price: { id: 'price_family_1' },
                amount: 3999,
              },
            ],
          }),
        )
      ).status,
    ).toBe(200);
    const [renewal] = await api.db.sql<{ charged_amount_cents: number }[]>`
      select charged_amount_cents from public.billing_periods
       where provider_period_id = ${renewalId}`;
    expect(renewal!.charged_amount_cents).toBe(3999);
    // HUNT6-C-1: the renewal's own pending proration line is money the invoice COLLECTED (amount_paid
    // 4999), so it is recorded as its own 'proration' period beside the renewal. Before the fix the
    // renewal wrote one row of 3999 and the other 1000 was in no month's gross at all, although the
    // note, the definition, the SQL comment and this test all said it was counted.
    const [pending] = await api.db.sql<
      { kind: string; charged_amount_cents: number; tax_amount_cents: number }[]
    >`
      select kind, charged_amount_cents, tax_amount_cents from public.billing_periods
       where provider_period_id = ${`${renewalId}:proration`}`;
    expect(pending).toMatchObject({
      kind: 'proration',
      charged_amount_cents: 1000,
      tax_amount_cents: 0,
    });
    const end = await stripeRevenue();
    expect(end.gross - before.gross).toBe(1000 + 4999);

    // The owner-facing prose now says what is true. It may NOT say a proration item is never revenue:
    // this test just counted one. (The previous note did, which is what reopened this.)
    const rev = await revenueView();
    const grossNote = rev.notes.find((n) => n.includes('Gross is the money collected'));
    expect(grossNote).toBeDefined();
    expect(grossNote).not.toMatch(/proration[^.]*never revenue/);
    expect(grossNote).toMatch(/mid-cycle proration charge is collected money/);
    // US sales tax is still never revenue, and the refund-unit sentence HUNT5-C-3 added survives.
    expect(grossNote).toMatch(/US sales tax[^;]*never revenue/);
    expect(grossNote).toMatch(/chargeback/);
    expect(rev.definition).toMatch(/proration charge included/);
    // The owner reads both verbatim, so they have to fit the contract's own caps (400 per note, 600
    // for the definition). Parsed against the contract rather than against a copied number, so a
    // longer rewrite fails here instead of at the admin endpoint.
    expect(() => revenueResponseSchema.shape.notes.parse(rev.notes)).not.toThrow();
    expect(() => revenueResponseSchema.shape.definition.parse(rev.definition)).not.toThrow();
  });
});

describe('HUNT6-C-1: a renewal’s pending proration is money collected, so it is recorded', () => {
  it('a taxed renewal records its pending proration as a second period, once', async () => {
    api.now.value = SEPTEMBER;
    const before = await stripeRevenue();
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const [school] = await api.db.sql<{ id: string }[]>`
      insert into public.schools (name, status) values ('R6 Birch Elementary', 'active') returning id`;
    await api.db.sql`
      insert into public.family_school_designations (family_id, school_id, effective_from, created_by)
      values (${fam.familyId}, ${school!.id}, '2026-08-01', ${fam.ownerId})`;
    const start = Date.parse('2026-09-19T00:00:00Z') / 1000;
    const invoiceId = `in_r6_pending_${randomUUID()}`;
    // Stripe's default `create_prorations`, which billing-sync itself calls the normal shape for a
    // family that added a child: the mid-cycle item is left pending and listed on the next renewal.
    // The family paid 5411 — 3999 subscription + 1000 proration + 412 state sales tax.
    const renewal = () =>
      stripeInvoicePaid(invoiceId, ref, start, {
        subtotal: 4999,
        tax: 412,
        amountPaid: 5411,
        lines: [
          {
            period: { start: start - 86400, end: start },
            price: { id: 'price_family_1' },
            proration: true,
            amount: 1000,
          },
          {
            period: { start, end: start + 30 * 86400 },
            price: { id: 'price_family_1' },
            amount: 3999,
          },
        ],
      });
    expect((await postStripe(renewal())).status).toBe(200);
    const rows = await api.db.sql<
      {
        provider_period_id: string;
        kind: string;
        charged_amount_cents: number;
        tax_amount_cents: number;
      }[]
    >`
      select provider_period_id, kind, charged_amount_cents, tax_amount_cents
        from public.billing_periods
       where provider_period_id in (${invoiceId}, ${`${invoiceId}:proration`})
       order by provider_period_id`;
    // The renewal's own charge is the subscription line alone (BILL-R2-4), carrying the share of the
    // invoice's tax that was levied on it (N1-TAX-APPORTION: floor(412 × 3999 ÷ 4999) = 329)...
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      provider_period_id: invoiceId,
      kind: 'subscription_period',
      charged_amount_cents: 3999,
      tax_amount_cents: 329,
    });
    // ...and the 1000 the same invoice collected for the pending item is its own 'proration' period,
    // carrying the rest of that apportionment: floor(412 × 1000 ÷ 4999) = 82. HUNT7-C-4: not 0. A
    // refund of this invoice reaches THIS row too (C-PRORATION-REVERSAL walks the leftover onto it),
    // and the leftover is a provider figure stated including tax like every other, so the row needs
    // its own share to restate it in its charge's unit. Each share is floored, so the two together
    // (329 + 82) never exceed the tax the invoice really levied.
    expect(rows[1]).toMatchObject({
      provider_period_id: `${invoiceId}:proration`,
      kind: 'proration',
      charged_amount_cents: 1000,
      tax_amount_cents: 82,
    });
    // Gross is exactly what the invoice collected less the state's tax: 5411 − 412. Before the fix it
    // was 3999 and the other $10 the family paid appeared in no month at all.
    const after = await stripeRevenue();
    expect(after.gross - before.gross).toBe(4999);

    // Counted ONCE: a provider retry of the same invoice.paid writes no third row and adds nothing.
    expect((await postStripe(renewal())).status).toBe(200);
    const [count] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.billing_periods
       where provider_period_id in (${invoiceId}, ${`${invoiceId}:proration`})`;
    expect(count!.n).toBe(2);
    expect((await stripeRevenue()).gross - before.gross).toBe(4999);

    // And the $1 school donation is untouched: eligibility reads subscription periods only, so the
    // new row neither earns a second dollar nor makes the month miss the regular tier price.
    const accrual = await runDonationAccrual(api.apiDb, '2026-09', api.config.programTimezone);
    expect(accrual.accrued).toBeGreaterThanOrEqual(1);
    const [accrued] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.donation_accruals where family_id = ${fam.familyId}`;
    expect(accrued!.n).toBe(1);
  });

  it('a credit balance that settled the invoice bounds what the proration row may record', async () => {
    api.now.value = SEPTEMBER;
    const before = await stripeRevenue();
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const start = Date.parse('2026-09-20T00:00:00Z') / 1000;
    const invoiceId = `in_r6_pending_credit_${randomUUID()}`;
    // The same renewal shape, except a $25 customer credit balance settled most of it: Stripe
    // collected 2499 of the 4999 invoiced (BILL-R4-4). Gross is money COLLECTED, so the subscription
    // line takes what came in and the pending item may add nothing on top of it.
    expect(
      (
        await postStripe(
          stripeInvoicePaid(invoiceId, ref, start, {
            subtotal: 4999,
            tax: 0,
            amountPaid: 2499,
            startingBalance: -2500,
            lines: [
              {
                period: { start: start - 86400, end: start },
                price: { id: 'price_family_1' },
                proration: true,
                amount: 1000,
              },
              {
                period: { start, end: start + 30 * 86400 },
                price: { id: 'price_family_1' },
                amount: 3999,
              },
            ],
          }),
        )
      ).status,
    ).toBe(200);
    const [subscription] = await api.db.sql<{ charged_amount_cents: number }[]>`
      select charged_amount_cents from public.billing_periods where provider_period_id = ${invoiceId}`;
    expect(subscription!.charged_amount_cents).toBe(2499);
    const pending = await api.db.sql<{ id: string }[]>`
      select id from public.billing_periods where provider_period_id = ${`${invoiceId}:proration`}`;
    expect(pending).toHaveLength(0);
    expect((await stripeRevenue()).gross - before.gross).toBe(2499);
  });
});

describe('HUNT6-C-3: a refund that arrives before its invoice is recorded in the same unit', () => {
  it('the same partial refund records 1848 whichever order the two events arrive in', async () => {
    api.now.value = SEPTEMBER;
    const recordRefund = async (order: 'refund_first' | 'invoice_first'): Promise<number> => {
      const fam = await seedFamily(api.db, { childCount: 1 });
      const ref = await billingRef(fam);
      const start = Date.parse('2026-09-21T00:00:00Z') / 1000;
      const invoiceId = `in_r6_parked_${order}_${randomUUID()}`;
      const chargeId = `ch_${randomUUID()}`;
      api.providers.stripe.chargeInvoices.set(chargeId, invoiceId);
      // $39.99 plus $3.30 of state sales tax; $20 of the 4329 the family paid comes back.
      const invoice = () =>
        postStripe(
          stripeInvoicePaid(invoiceId, ref, start, { subtotal: 3999, tax: 330, amountPaid: 4329 }),
        );
      const refund = () =>
        postStripe({
          id: `evt_${randomUUID()}`,
          type: 'charge.refunded',
          data: {
            object: {
              id: chargeId,
              object: 'charge',
              amount: 4329,
              amount_refunded: 2000,
              refunded: false,
              currency: 'usd',
              invoice: invoiceId,
              payment_intent: `pi_${randomUUID()}`,
              metadata: { billing_ref: ref },
            },
          },
        });
      if (order === 'refund_first') {
        expect((await refund()).status).toBe(200);
        // Nothing to apply it to yet, so it is parked (RV-lead-billing-p17-3).
        const [parked] = await api.db.sql<{ n: number }[]>`
          select count(*)::int as n from public.pending_refunds
           where family_id = ${fam.familyId} and provider_period_id = ${invoiceId}`;
        expect(parked!.n).toBe(1);
        expect((await invoice()).status).toBe(200);
        // The park is consumed when the period lands.
        const [left] = await api.db.sql<{ n: number }[]>`
          select count(*)::int as n from public.pending_refunds where family_id = ${fam.familyId}`;
        expect(left!.n).toBe(0);
      } else {
        expect((await invoice()).status).toBe(200);
        expect((await refund()).status).toBe(200);
      }
      const [period] = await api.db.sql<{ refunded_cents: number; settlement: string }[]>`
        select refunded_cents, settlement from public.billing_periods
         where provider_period_id = ${invoiceId}`;
      expect(period!.settlement).toBe('partially_refunded');
      return period!.refunded_cents;
    };
    // Both orders state the refund in the unit of the recorded pre-tax charge:
    // round(2000 × 3999 ÷ 4329) = 1848. Before the fix the parked replay passed no provider total and
    // the conversion was inferred from its absence, so the early refund was written at 2000 — the same
    // refund recorded two different ways depending on which webhook Stripe delivered first.
    expect(await recordRefund('refund_first')).toBe(1848);
    expect(await recordRefund('invoice_first')).toBe(1848);
  });
});

describe('HUNT6-C-4: the same-tax-rate assumption is stated as untracked, with the case that bites', () => {
  /**
   * A prose finding (L-053): subscriptionTaxCents' docstring closed with “it is recorded as an open
   * item rather than guessed at here”, and no such item existed in any record CLAUDE.md names. The
   * lead records the item; this fixer makes the comment true. There is no behaviour to change, so the
   * assertion is over the sentence itself — together with the arithmetic the sentence now states, so
   * that the two cannot drift apart again.
   */
  it('apportions an exempt line’s tax onto the charge, which is the direction that overstates net', () => {
    const start = Date.parse('2026-09-22T00:00:00Z') / 1000;
    // $1 of tax levied on a $10 add-on beside a $39.99 subscription line that is exempt. The
    // apportionment has no per-line tax to read, so it splits by pre-tax amount.
    const period = mapStripeInvoiceToPeriod({
      id: `in_r6_rates_${randomUUID()}`,
      billing_reason: 'subscription_cycle',
      status: 'paid',
      subtotal: 4999,
      tax: 100,
      amount_paid: 5099,
      currency: 'usd',
      total_discount_amounts: [],
      status_transitions: { paid_at: start + 60 },
      lines: {
        data: [
          {
            period: { start: start - 86400, end: start + 30 * 86400 },
            price: { id: 'price_addon_workbook' },
            amount: 1000,
          },
          {
            period: { start, end: start + 30 * 86400 },
            price: { id: 'price_family_1' },
            amount: 3999,
          },
        ],
      },
    });
    expect(period!.chargedCents).toBe(3999);
    // floor(100 × 3999 ÷ 4999) = 79 cents of tax attributed to a charge whose own tax is 0 …
    expect(period!.taxCents).toBe(79);
    // … and that 79 then shrinks every partial refund of this charge by its share: $20 returned is
    // recorded as 1961 pre-tax instead of 2000, so 39 cents of returned money read as kept revenue.
    // Net revenue overstated is the unsafe direction, which is why the docstring may not claim the
    // assumption is tracked when it is not.
    expect(preTaxRefundCents(2000, true, 3999, 79)).toBe(1961);
  });

  it('the docstring says plainly that it is not tracked, and names the case', () => {
    const src = readFileSync(new URL('../src/services/billing-sync.ts', import.meta.url), 'utf8');
    const from = src.indexOf(' * ASSUMPTION');
    const to = src.indexOf('function subscriptionTaxCents');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const assumption = src.slice(from, to);
    // The false claim, which is what the finding is: there was no open item anywhere.
    expect(assumption).not.toMatch(/recorded as an open item/);
    // What is true: nothing tracks it, and the exempt subscription line is the case that bites.
    expect(assumption).toMatch(/\bnot tracked\b/i);
    expect(assumption).toMatch(/exempt/);
  });
});

describe('C-PRORATION-REVERSAL: a provider refund reaches BOTH periods of one invoice', () => {
  /**
   * HUNT6-C-1 records a renewal's deferred proration money as a SECOND period whose provider id is
   * `<invoice>:proration`. Every Stripe refund and dispute event names the INVOICE, and applyRefund
   * matched the primary period id alone, so that second row was unreachable: a FULLY refunded renewal
   * that had carried a deferred proration left the proration's money in gross with nothing reversing
   * it — clawed-back money reading as kept revenue, which is the direction the whole tax-conversion
   * work (BILL-R2-4 / BILL-R4-3 / HUNT5-C-2) exists to avoid.
   *
   * WHICH ROWS ONE PROVIDER REFUND NOW TOUCHES. The invoice's primary period first, in that period's
   * own unit — the provider figure restated by the tax stored on it (preTaxRefundCents) and capped at
   * its charge. Whatever of the provider's tax-inclusive amount is LEFT OVER above that period's
   * bucket (its charge plus that charge's tax) then reaches `<invoice>:proration`, capped at its
   * charge. So a refund that fits inside the primary bucket touches one row, and a FULL refund always
   * reaches both, because amount_paid = charge + pending net + the invoice's whole tax while the
   * primary bucket holds the charge and only its own apportioned share of that tax:
   * leftover = pending net + (whole tax − apportioned share) >= pending net. Integer cents throughout.
   */
  const renewalWithDeferredProration = (invoiceId: string, ref: string, start: number): unknown =>
    // $39.99 renewal + a $10 mid-cycle item Stripe left pending, with 8.25% sales tax on the 4999:
    // the family paid 5411. Two periods: 3999 (tax 329) and 1000 (tax 0).
    stripeInvoicePaid(invoiceId, ref, start, {
      subtotal: 4999,
      tax: 412,
      amountPaid: 5411,
      lines: [
        {
          period: { start: start - 86400, end: start },
          price: { id: 'price_family_1' },
          proration: true,
          amount: 1000,
        },
        {
          period: { start, end: start + 30 * 86400 },
          price: { id: 'price_family_1' },
          amount: 3999,
        },
      ],
    });

  /** Both rows an invoice can write, primary first (its id is a prefix of the proration row's). */
  const bothPeriods = (invoiceId: string) =>
    api.db.sql<
      {
        provider_period_id: string;
        kind: string;
        settlement: string;
        charged_amount_cents: number;
        tax_amount_cents: number;
        refunded_cents: number;
      }[]
    >`
      select provider_period_id, kind, settlement, charged_amount_cents, tax_amount_cents,
             refunded_cents
        from public.billing_periods
       where provider_period_id in (${invoiceId}, ${`${invoiceId}:proration`})
       order by provider_period_id`;

  const chargeRefunded = (
    chargeId: string,
    invoiceId: string,
    ref: string,
    amountRefunded: number,
    full: boolean,
    /** What the Charge totals; 5411 is the taxed fixture, 4999 the untaxed one below. */
    chargeTotal = 5411,
  ): unknown => ({
    id: `evt_${randomUUID()}`,
    type: 'charge.refunded',
    data: {
      object: {
        id: chargeId,
        object: 'charge',
        amount: chargeTotal,
        amount_refunded: amountRefunded,
        refunded: full,
        currency: 'usd',
        invoice: invoiceId,
        payment_intent: `pi_${randomUUID()}`,
        metadata: { billing_ref: ref },
      },
    },
  });

  it('a fully refunded renewal reverses its deferred proration too, so net is zero', async () => {
    api.now.value = SEPTEMBER;
    const before = await stripeRevenue();
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const start = Date.parse('2026-09-11T00:00:00Z') / 1000;
    const invoiceId = `in_r6_rev_full_${randomUUID()}`;
    const chargeId = `ch_${randomUUID()}`;
    api.providers.stripe.chargeInvoices.set(chargeId, invoiceId);
    expect((await postStripe(renewalWithDeferredProration(invoiceId, ref, start))).status).toBe(
      200,
    );
    const recorded = await stripeRevenue();
    expect(recorded.gross - before.gross).toBe(4999);

    // Stripe refunds the whole charge: every cent the family paid, tax included.
    expect((await postStripe(chargeRefunded(chargeId, invoiceId, ref, 5411, true))).status).toBe(
      200,
    );
    const rows = await bothPeriods(invoiceId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      provider_period_id: invoiceId,
      kind: 'subscription_period',
      settlement: 'refunded',
      refunded_cents: 3999,
    });
    // Before the fix this row was untouched — 'settled', refunded_cents 0 — because the refund event
    // names the invoice and only the primary period id matched it.
    expect(rows[1]).toMatchObject({
      provider_period_id: `${invoiceId}:proration`,
      kind: 'proration',
      settlement: 'refunded',
      refunded_cents: 1000,
    });
    const after = await stripeRevenue();
    expect(after.refunds - before.refunds).toBe(4999);
    // The whole invoice came back, so the owner's month keeps nothing of it.
    expect(after.gross - before.gross - (after.refunds - before.refunds)).toBe(0);
  });

  it('a partial refund that fits inside the primary period leaves the proration row alone', async () => {
    api.now.value = SEPTEMBER;
    const before = await stripeRevenue();
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const start = Date.parse('2026-09-12T00:00:00Z') / 1000;
    const invoiceId = `in_r6_rev_part_${randomUUID()}`;
    const chargeId = `ch_${randomUUID()}`;
    api.providers.stripe.chargeInvoices.set(chargeId, invoiceId);
    expect((await postStripe(renewalWithDeferredProration(invoiceId, ref, start))).status).toBe(
      200,
    );
    // $20 back out of the 5411 paid. The primary period's own bucket is 3999 + 329 = 4328, so the
    // whole $20 is spent there and nothing is left over: the pending item's money was not returned.
    expect((await postStripe(chargeRefunded(chargeId, invoiceId, ref, 2000, false))).status).toBe(
      200,
    );
    const rows = await bothPeriods(invoiceId);
    expect(rows[0]).toMatchObject({ settlement: 'partially_refunded', refunded_cents: 1848 });
    expect(rows[1]).toMatchObject({ settlement: 'settled', refunded_cents: 0 });
    const after = await stripeRevenue();
    expect(after.refunds - before.refunds).toBe(1848);
  });

  it('a full refund parked before the invoice still reaches both rows when it is replayed', async () => {
    api.now.value = SEPTEMBER;
    const before = await stripeRevenue();
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const start = Date.parse('2026-09-15T00:00:00Z') / 1000;
    const invoiceId = `in_r6_rev_parked_${randomUUID()}`;
    const chargeId = `ch_${randomUUID()}`;
    api.providers.stripe.chargeInvoices.set(chargeId, invoiceId);
    // Stripe delivers the refund first, so there is nothing to apply it to and it is parked
    // (RV-lead-billing-p17-3). The replay happens while the invoice is being recorded, which is why
    // the proration period is written BEFORE the subscription period: recording the subscription
    // period is what consumes the park, and the leftover has to have somewhere to go.
    expect((await postStripe(chargeRefunded(chargeId, invoiceId, ref, 5411, true))).status).toBe(
      200,
    );
    const [parked] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.pending_refunds where provider_period_id = ${invoiceId}`;
    expect(parked!.n).toBe(1);
    expect((await postStripe(renewalWithDeferredProration(invoiceId, ref, start))).status).toBe(
      200,
    );
    const rows = await bothPeriods(invoiceId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ settlement: 'refunded', refunded_cents: 3999 });
    expect(rows[1]).toMatchObject({ settlement: 'refunded', refunded_cents: 1000 });
    const after = await stripeRevenue();
    expect(after.gross - before.gross).toBe(4999);
    expect(after.refunds - before.refunds).toBe(4999);
    // Nothing is ever parked against the derived id: its absence is the normal case, not an ordering.
    const [left] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.pending_refunds
       where provider_period_id in (${invoiceId}, ${`${invoiceId}:proration`})`;
    expect(left!.n).toBe(0);
  });

  it('a dispute of the whole charge, and the win that follows it, round-trip across both rows', async () => {
    api.now.value = SEPTEMBER;
    const before = await stripeRevenue();
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const start = Date.parse('2026-09-13T00:00:00Z') / 1000;
    const invoiceId = `in_r6_rev_disp_${randomUUID()}`;
    const chargeId = `ch_${randomUUID()}`;
    api.providers.stripe.chargeInvoices.set(chargeId, invoiceId);
    expect((await postStripe(renewalWithDeferredProration(invoiceId, ref, start))).status).toBe(
      200,
    );
    const dispute = (type: 'charge.dispute.created' | 'charge.dispute.closed'): unknown => ({
      id: `evt_${randomUUID()}`,
      type,
      data: {
        object: {
          id: `dp_r6_rev_${randomUUID()}`,
          object: 'dispute',
          amount: 5411,
          currency: 'usd',
          charge: chargeId,
          payment_intent: `pi_${randomUUID()}`,
          reason: 'fraudulent',
          status: type === 'charge.dispute.closed' ? 'won' : 'needs_response',
          metadata: { billing_ref: ref },
        },
      },
    });
    expect((await postStripe(dispute('charge.dispute.created'))).status).toBe(200);
    const disputed = await bothPeriods(invoiceId);
    expect(disputed[0]).toMatchObject({ settlement: 'chargeback', refunded_cents: 3999 });
    // Before the fix the disputed money sitting in the proration row was never clawed back.
    expect(disputed[1]).toMatchObject({ settlement: 'chargeback', refunded_cents: 1000 });
    expect((await stripeRevenue()).refunds - before.refunds).toBe(4999);

    // Winning the dispute gives the same amount back on both rows: one unit, so add and subtract are
    // the same number on each period and the invoice returns to settled with nothing refunded.
    expect((await postStripe(dispute('charge.dispute.closed'))).status).toBe(200);
    const won = await bothPeriods(invoiceId);
    expect(won[0]).toMatchObject({ settlement: 'settled', refunded_cents: 0 });
    expect(won[1]).toMatchObject({ settlement: 'settled', refunded_cents: 0 });
    const after = await stripeRevenue();
    expect(after.refunds - before.refunds).toBe(0);
    expect(after.gross - before.gross).toBe(4999);
  });

  /**
   * The same renewal with NO sales tax, so every figure below is an exact integer in one unit: $39.99
   * of subscription plus a $10 mid-cycle item Stripe left pending, and the family paid 4999.
   */
  const untaxedRenewalWithDeferredProration = (
    invoiceId: string,
    ref: string,
    start: number,
  ): unknown =>
    stripeInvoicePaid(invoiceId, ref, start, {
      subtotal: 4999,
      tax: 0,
      amountPaid: 4999,
      lines: [
        {
          period: { start: start - 86400, end: start },
          price: { id: 'price_family_1' },
          proration: true,
          amount: 1000,
        },
        {
          period: { start, end: start + 30 * 86400 },
          price: { id: 'price_family_1' },
          amount: 3999,
        },
      ],
    });

  const disputeEvent = (
    chargeId: string,
    ref: string,
    amount: number,
    status: 'needs_response' | 'won',
  ): unknown => ({
    id: `evt_${randomUUID()}`,
    type: status === 'won' ? 'charge.dispute.closed' : 'charge.dispute.created',
    data: {
      object: {
        id: `dp_r7_${randomUUID()}`,
        object: 'dispute',
        amount,
        currency: 'usd',
        charge: chargeId,
        payment_intent: `pi_${randomUUID()}`,
        reason: 'fraudulent',
        status,
        metadata: { billing_ref: ref },
      },
    },
  });

  it('[HUNT7-C-1] a chargeback after a partial refund spills what the primary bucket has LEFT, not nothing', async () => {
    api.now.value = SEPTEMBER;
    const before = await stripeRevenue();
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const start = Date.parse('2026-09-16T00:00:00Z') / 1000;
    const invoiceId = `in_r7_spill_${randomUUID()}`;
    const chargeId = `ch_${randomUUID()}`;
    api.providers.stripe.chargeInvoices.set(chargeId, invoiceId);
    expect(
      (await postStripe(untaxedRenewalWithDeferredProration(invoiceId, ref, start))).status,
    ).toBe(200);
    expect((await stripeRevenue()).gross - before.gross).toBe(4999);

    // $10 back first. `Charge.amount_refunded` is CUMULATIVE, so it is measured against the primary
    // period's whole bucket (3999) and fits inside it: nothing spills.
    expect(
      (await postStripe(chargeRefunded(chargeId, invoiceId, ref, 1000, false, 4999))).status,
    ).toBe(200);
    const refunded = await bothPeriods(invoiceId);
    expect(refunded[0]).toMatchObject({ settlement: 'partially_refunded', refunded_cents: 1000 });
    expect(refunded[1]).toMatchObject({ settlement: 'settled', refunded_cents: 0 });

    // The family then disputes the 3999 they did NOT get back. A dispute amount is INCREMENTAL: it
    // states only the newly disputed part and is added on top. The primary period has 3999 − 1000 =
    // 2999 of room left, so 1000 of the dispute belongs to the ':proration' row — which is where the
    // other $10 the family paid is recorded. Measured against the bucket's SIZE the leftover was 0,
    // the cap swallowed the excess, and 1000 cents of clawed-back money stayed in gross as revenue.
    expect((await postStripe(disputeEvent(chargeId, ref, 3999, 'needs_response'))).status).toBe(
      200,
    );
    const disputed = await bothPeriods(invoiceId);
    expect(disputed[0]).toMatchObject({ settlement: 'chargeback', refunded_cents: 3999 });
    expect(disputed[1]).toMatchObject({
      provider_period_id: `${invoiceId}:proration`,
      settlement: 'chargeback',
      refunded_cents: 1000,
    });
    // Every cent the family paid is now back with them, so the month keeps nothing of this invoice.
    const after = await stripeRevenue();
    expect(after.refunds - before.refunds).toBe(4999);
    expect(after.gross - before.gross - (after.refunds - before.refunds)).toBe(0);
  });

  it('[HUNT7-C-2] winning that dispute gives back only what the dispute added, so the real refund survives and the $1 is not reinstated', async () => {
    api.now.value = SEPTEMBER;
    const before = await stripeRevenue();
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const [school] = await api.db.sql<{ id: string }[]>`
      insert into public.schools (name, status) values ('R7 Cedar Elementary', 'active') returning id`;
    await api.db.sql`
      insert into public.family_school_designations (family_id, school_id, effective_from, created_by)
      values (${fam.familyId}, ${school!.id}, '2026-08-01', ${fam.ownerId})`;
    const start = Date.parse('2026-09-17T00:00:00Z') / 1000;
    const invoiceId = `in_r7_roundtrip_${randomUUID()}`;
    const chargeId = `ch_${randomUUID()}`;
    api.providers.stripe.chargeInvoices.set(chargeId, invoiceId);
    expect(
      (await postStripe(untaxedRenewalWithDeferredProration(invoiceId, ref, start))).status,
    ).toBe(200);

    /** This family's donation adjustments, oldest first: −100 is a reversal, +100 a reinstatement. */
    const adjustments = async (): Promise<number[]> => {
      const rows = await api.db.sql<{ amount_cents: number }[]>`
        select a.amount_cents from public.donation_adjustments a
          join public.donation_accruals c on c.id = a.accrual_id
         where c.family_id = ${fam.familyId}
         order by a.created_at, a.id`;
      return rows.map((r) => r.amount_cents);
    };

    // The full-price month earns the school its $1 before anything goes wrong.
    await runDonationAccrual(api.apiDb, '2026-09', api.config.programTimezone);
    const [accrued] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.donation_accruals where family_id = ${fam.familyId}`;
    expect(accrued!.n).toBe(1);
    expect(await adjustments()).toEqual([]);

    // A genuine $10 refund reverses the dollar, then the un-refunded 3999 is disputed and WON.
    expect(
      (await postStripe(chargeRefunded(chargeId, invoiceId, ref, 1000, false, 4999))).status,
    ).toBe(200);
    expect(await adjustments()).toEqual([-100]);
    expect((await postStripe(disputeEvent(chargeId, ref, 3999, 'needs_response'))).status).toBe(
      200,
    );
    expect((await postStripe(disputeEvent(chargeId, ref, 3999, 'won'))).status).toBe(200);

    // The win returns exactly what the dispute added — 2999 on the primary row and 1000 on the
    // ':proration' row — and leaves the family's real refund on the record. While the win subtracted
    // the whole converted amount from a figure the cap had clipped, the primary row went back to
    // 'settled' with refunded_cents 0: the parent's own support case then told them the store had
    // reported no refund at all, and the school's $1 was reinstated for a month they were partly
    // refunded for.
    const won = await bothPeriods(invoiceId);
    expect(won[0]).toMatchObject({
      provider_period_id: invoiceId,
      settlement: 'partially_refunded',
      refunded_cents: 1000,
    });
    expect(won[1]).toMatchObject({
      provider_period_id: `${invoiceId}:proration`,
      settlement: 'settled',
      refunded_cents: 0,
    });
    const after = await stripeRevenue();
    expect(after.refunds - before.refunds).toBe(1000);
    expect(after.gross - before.gross).toBe(4999);
    // No reinstatement: the period is not settled in full, so P17 keeps the dollar reversed.
    expect(await adjustments()).toEqual([-100]);
  });

  it('[HUNT7-C-4] both rows of one invoice carry their own floored share of its tax', async () => {
    api.now.value = SEPTEMBER;
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const start = Date.parse('2026-09-18T00:00:00Z') / 1000;
    const invoiceId = `in_r7_shares_${randomUUID()}`;
    expect((await postStripe(renewalWithDeferredProration(invoiceId, ref, start))).status).toBe(
      200,
    );
    // The invoice's 412 of tax is apportioned to the two charges it was added to, each share FLOORED
    // so no row ever stores more tax than was really levied on it (N1-TAX-APPORTION): 329 on the
    // 3999 and 82 on the 1000, and 329 + 82 <= 412 because both are floored. The second row's share
    // is not 0: the amount that reaches it is the LEFTOVER of a provider figure, which is stated
    // including tax like every other, so the row needs its own share to restate it.
    const paid = await bothPeriods(invoiceId);
    expect(paid[0]).toMatchObject({ charged_amount_cents: 3999, tax_amount_cents: 329 });
    expect(paid[1]).toMatchObject({ charged_amount_cents: 1000, tax_amount_cents: 82 });
    expect(paid[0]!.tax_amount_cents + paid[1]!.tax_amount_cents).toBeLessThanOrEqual(412);
  });

  it('[HUNT7-C-4] a partial refund that spills is recorded on the proration row in that row’s own unit', async () => {
    api.now.value = SEPTEMBER;
    const before = await stripeRevenue();
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const start = Date.parse('2026-09-18T00:00:00Z') / 1000;
    const invoiceId = `in_r7_unit_${randomUUID()}`;
    const chargeId = `ch_${randomUUID()}`;
    api.providers.stripe.chargeInvoices.set(chargeId, invoiceId);
    expect((await postStripe(renewalWithDeferredProration(invoiceId, ref, start))).status).toBe(
      200,
    );
    // $44 back of the 5411 paid. The primary period's bucket is its charge plus its own tax share
    // (3999 + 329 = 4328), so 72 of the provider's figure is left over — and 72 tax-INCLUSIVE cents
    // are 67 of the proration charge's pre-tax cents (the exact pre-tax spill is 66; the floored tax
    // share puts the recorded refund at or above it, never below). Written straight in, they recorded
    // 72 cents of refund against a pre-tax charge: the owner's refunds column in one unit and the
    // charge in another, on the one row whose stated purpose is to hold pre-tax collected money.
    expect((await postStripe(chargeRefunded(chargeId, invoiceId, ref, 4400, false))).status).toBe(
      200,
    );
    const rows = await bothPeriods(invoiceId);
    expect(rows[0]).toMatchObject({ settlement: 'partially_refunded', refunded_cents: 3999 });
    expect(rows[1]).toMatchObject({ settlement: 'partially_refunded', refunded_cents: 67 });
    const after = await stripeRevenue();
    expect(after.refunds - before.refunds).toBe(4066);
  });

  it('[HUNT7-C-1] the walk’s docstring says which provider figures are cumulative and which are incremental', () => {
    const src = readFileSync(new URL('../src/services/billing-sync.ts', import.meta.url), 'utf8');
    // The block that states the provider's amount in the row's unit and works out what is left over,
    // bracketed by the two statements around it so the slice survives a rewording of its own opening.
    const from = src.indexOf('  const inCharge =');
    const to = src.indexOf('  const effective: SettlementEvent =');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const comment = src.slice(from, to);
    // The false claim: one expression served a cumulative figure and an incremental one, and the
    // comment described only the bucket's SIZE.
    expect(comment).not.toMatch(/are the most of a provider figure this period can account for/);
    expect(comment).toMatch(/\bcumulative(ly)?\b/i);
    expect(comment).toMatch(/\bincremental(ly)?\b/i);
    expect(comment).toMatch(/still has room|has LEFT|left of/i);
    // And it names which provider figure is which, not just that the two differ.
    expect(comment).toMatch(/amount_refunded/);
    expect(comment).toMatch(/Dispute's `amount`/);
  });

  it('[HUNT7-C-4] prorationPeriodFor justifies its tax by the unit of the amount that reaches the row', () => {
    const src = readFileSync(new URL('../src/services/billing-sync.ts', import.meta.url), 'utf8');
    const from = src.indexOf(' * The second billing period a renewal');
    const to = src.indexOf('export function prorationPeriodFor');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const docstring = src.slice(from, to);
    // The false justification: the row's CHARGE is pre-tax, but the figure that reaches the row is
    // the leftover, which is the provider's tax-inclusive amount.
    expect(docstring).not.toMatch(/It carries no tax/);
    expect(docstring).toMatch(/tax-inclusive/);
    expect(docstring).toMatch(/apportioned|its own share/);
  });
});

describe('C-NEGATIVE-NET: the periods of one invoice never exceed what it collected', () => {
  /**
   * `pendingProrationNetCents` drops a NEGATIVE net on the grounds that "a net credit lowers what the
   * invoice collected, which the subscription charge already reflects through amount_paid". That was
   * false: `subscriptionChargeCents`' first branch returns the subscription LINE's own amount, and
   * `amount_paid` bounded it only when Stripe had applied a customer credit BALANCE (a negative
   * starting_balance, BILL-R4-4) — a credit LINE leaves starting_balance untouched. So the claim held
   * for one Stripe field and not for the thing it was claiming. With the bound unconditional the
   * sentence is true, and the two rows an invoice may write are bounded at collected and at
   * collected − charge, so their sum can never exceed the pre-tax money the invoice took.
   */
  type InvoiceLine = NonNullable<NonNullable<StripeInvoice['lines']>['data']>[number];
  const invoice = (
    invoiceId: string,
    start: number,
    amounts: { subtotal: number; tax: number; amountPaid: number; lines: InvoiceLine[] },
  ): StripeInvoice => ({
    id: invoiceId,
    billing_reason: 'subscription_cycle',
    status: 'paid',
    subtotal: amounts.subtotal,
    tax: amounts.tax,
    amount_paid: amounts.amountPaid,
    currency: 'usd',
    total_discount_amounts: [],
    status_transitions: { paid_at: start + 60 },
    lines: { data: amounts.lines },
  });

  it('a net proration CREDIT on a renewal lowers the charge, because amount_paid bounds it', () => {
    const start = Date.parse('2026-09-16T00:00:00Z') / 1000;
    // A mid-cycle downgrade Stripe deferred: a $5 credit and a $3 charge beside the $39.99 renewal.
    // Subtotal 3799 and that is what was collected; the renewal LINE still states 3999.
    const period = mapStripeInvoiceToPeriod(
      invoice(`in_r6_negnet_${randomUUID()}`, start, {
        subtotal: 3799,
        tax: 0,
        amountPaid: 3799,
        lines: [
          {
            period: { start: start - 86400, end: start },
            price: { id: 'price_family_1' },
            proration: true,
            amount: -500,
          },
          {
            period: { start: start - 86400, end: start },
            price: { id: 'price_family_1' },
            proration: true,
            amount: 300,
          },
          {
            period: { start, end: start + 30 * 86400 },
            price: { id: 'price_family_1' },
            amount: 3999,
          },
        ],
      }),
    );
    // Before the fix: 3999 booked against 3799 collected — the net credit reflected nowhere.
    expect(period!.chargedCents).toBe(3799);
    // A net credit is still no billing period of its own, and now the reason given for that is true.
    expect(period!.pendingProrationNetCents).toBe(0);
  });

  it('an immediate credit+charge proration pair books the collection, whichever line leads', () => {
    const start = Date.parse('2026-09-17T00:00:00Z') / 1000;
    // Stripe's `always_invoice`: one invoice for the change, a credit for the unused old plan and a
    // charge for the new one, both proration lines over the same period. The family paid 1000.
    const pair = (lines: InvoiceLine[]) =>
      mapStripeInvoiceToPeriod({
        ...invoice(`in_r6_pair_${randomUUID()}`, start, {
          subtotal: 1000,
          tax: 0,
          amountPaid: 1000,
          lines,
        }),
        billing_reason: 'subscription_update',
      });
    const credit = {
      period: { start, end: start + 20 * 86400 },
      price: { id: 'price_family_1' },
      proration: true,
      amount: -2000,
    };
    const charge = {
      period: { start, end: start + 20 * 86400 },
      price: { id: 'price_family_1' },
      proration: true,
      amount: 3000,
    };
    // Which of the two `subscriptionLine` picks is a tie broken by line order, so the bound has to
    // hold either way: the invoice collected 1000 and gross may be 1000, never 3000.
    for (const lines of [
      [credit, charge],
      [charge, credit],
    ]) {
      const period = pair(lines);
      expect(period).not.toBeNull();
      // Before the fix: 0 + 3000 with the credit first, 3000 + 0 with the charge first.
      expect(period!.chargedCents + period!.pendingProrationNetCents).toBe(1000);
    }
  });

  it('gross for such an invoice is what it collected, across both recorded rows', async () => {
    api.now.value = SEPTEMBER;
    const before = await stripeRevenue();
    const fam = await seedFamily(api.db, { childCount: 1 });
    const ref = await billingRef(fam);
    const start = Date.parse('2026-09-18T00:00:00Z') / 1000;
    const invoiceId = `in_r6_pair_e2e_${randomUUID()}`;
    expect(
      (
        await postStripe(
          stripeInvoicePaid(invoiceId, ref, start, {
            subtotal: 1000,
            tax: 0,
            amountPaid: 1000,
            billingReason: 'subscription_update',
            lines: [
              {
                period: { start, end: start + 20 * 86400 },
                price: { id: 'price_family_1' },
                proration: true,
                amount: -2000,
              },
              {
                period: { start, end: start + 20 * 86400 },
                price: { id: 'price_family_1' },
                proration: true,
                amount: 3000,
              },
            ],
          }),
        )
      ).status,
    ).toBe(200);
    const rows = await api.db.sql<{ charged_amount_cents: number }[]>`
      select charged_amount_cents from public.billing_periods
       where provider_period_id in (${invoiceId}, ${`${invoiceId}:proration`})`;
    expect(rows.reduce((sum, r) => sum + r.charged_amount_cents, 0)).toBe(1000);
    // Before the fix the owner's month gained 3000 for a change the family paid 1000 for.
    expect((await stripeRevenue()).gross - before.gross).toBe(1000);
  });
});
