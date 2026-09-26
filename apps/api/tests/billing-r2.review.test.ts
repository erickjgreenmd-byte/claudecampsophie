import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { syncFamilyFromProvider } from '../src/services/billing-sync.ts';
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
    lines?: unknown[];
  },
): unknown {
  return {
    id: `evt_${randomUUID()}`,
    type: 'invoice.paid',
    data: {
      object: {
        id: invoiceId,
        billing_reason: 'subscription_cycle',
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

/** The Stripe line of the owner's revenue view for the pinned clock's month. */
async function stripeRevenue(): Promise<{ gross: number; refunds: number }> {
  const rev = await api.apiDb.asService(async (tx) => {
    const { rates } = await loadStoreFeeRates(tx);
    return loadRevenueMonths(tx, api.now.value, 1, rates);
  });
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
      { settlement: string; charged_amount_cents: number; refunded_cents: number }[]
    >`
      select settlement, charged_amount_cents, refunded_cents from public.billing_periods
       where provider_period_id = ${invoiceId}`;
    // Before the fix: refunded_cents 2000, the tax-inclusive provider figure, against a pre-tax
    // charge of 3999, so the owner's net revenue was understated by the tax share of the refund.
    expect(period).toMatchObject({
      settlement: 'partially_refunded',
      charged_amount_cents: 3999,
      refunded_cents: 1848,
    });
    const after = await stripeRevenue();
    expect(after.gross - before.gross).toBe(3999);
    expect(after.refunds - before.refunds).toBe(1848);
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
