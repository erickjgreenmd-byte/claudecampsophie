import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_CASE_PAGE_SIZE,
  REFUND_PATH_BY_CHANNEL,
  adminCaseQueueResponseSchema,
  adminCaseResponseSchema,
  adminSupportCaseDetailResponseSchema,
  channelSchema,
  overviewResponseSchema,
  revenueResponseSchema,
  storeFeeRatesResponseSchema,
  subscriptionsSummarySchema,
  type OverviewResponse,
  supportPolicyResponseSchema,
} from '@pencillift/contracts';
import { seedFamily, seedOwnerAdmin, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { cryptoRandom } from '@pencillift/domain';
import { generatePromoCode } from '@pencillift/domain/promotions';
import { issueChildAccessToken } from '../src/auth/child.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * Owner operations console: the company overview with every number asserted against seeded rows,
 * revenue by month and channel net of the configured store fees, the subscription summary, the
 * support queue (filters, keyset paging, detail with billing periods and refunds, notes, updates)
 * and the fee-rate setting. Owner admin with MFA only. Real local Postgres; synthetic families
 * whose children (Riley, Sam) must never appear in any response.
 */

let api: TestApi;
let adminId: string;
let adminToken: string;
let adminNoMfa: string;
let famA: SeededFamily;
let famB: SeededFamily;
let tokenA: string;
let parentAal2: string;
let childToken: string;
let periodA1: string;

type ErrorBody = { error: { code: string; rule?: string; message: string } };
const CHILD_NAMES = ['Riley', 'Sam', 'Jordan', 'Avery'];

const admin = (path: string, method = 'GET', body?: unknown, token = adminToken) =>
  api.request(`/v1/admin${path}`, { method, token, ...(body === undefined ? {} : { body }) });

async function ok<T>(pending: Response | Promise<Response>, status = 200): Promise<T> {
  const res = await pending;
  if (res.status !== status)
    throw new Error(`expected ${status}, got ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

function expectNoChildText(body: unknown): void {
  const text = JSON.stringify(body);
  for (const name of CHILD_NAMES) expect(text).not.toContain(name);
  for (const child of [...famA.children, ...famB.children]) expect(text).not.toContain(child.id);
}

async function period(
  fam: SeededFamily,
  channel: string,
  providerPeriodId: string,
  start: string,
  end: string,
  cents: number,
  extra: { settlement?: string; refunded?: number; settledAt?: string | null; slots?: number } = {},
): Promise<string> {
  const settlement = extra.settlement ?? 'settled';
  const settledAt = extra.settledAt === undefined ? start : extra.settledAt;
  const [row] = await api.db.sql<{ id: string }[]>`
    insert into public.billing_periods (family_id, channel, provider_period_id, kind, period_start, period_end,
      paid_slots, regular_amount_cents, charged_amount_cents, settlement, settled_at, refunded_cents)
    values (${fam.familyId}, ${channel}, ${providerPeriodId}, 'subscription_period', ${start}, ${end},
            ${extra.slots ?? 1}, ${cents}, ${cents}, ${settlement}, ${settledAt}, ${extra.refunded ?? 0})
    returning id`;
  return row!.id;
}

async function entitlement(
  fam: SeededFamily,
  channel: string,
  status: string,
  slots: number,
  start: string,
  end: string,
  createdAt: string,
): Promise<void> {
  await api.db.sql`
    insert into public.family_entitlements (family_id, channel, provider_subscription_id, product_id, paid_slots, status,
      environment, period_start, period_end, provider_updated_at, fetched_at, created_at)
    values (${fam.familyId}, ${channel}, ${`sub_${randomUUID()}`}, ${`pl_family_${slots}`}, ${slots}, ${status},
            'sandbox', ${start}, ${end}, ${createdAt}, ${createdAt}, ${createdAt})`;
}

const openCase = (token: string, body: Record<string, unknown>) =>
  api.request('/v1/support/cases', { method: 'POST', token, body });

beforeAll(async () => {
  api = await createTestApi();
  adminId = await seedOwnerAdmin(api.db);
  adminToken = await parentToken(adminId, { aal: 'aal2' });
  adminNoMfa = await parentToken(adminId, { aal: 'aal1' });
  famA = await seedFamily(api.db, { childCount: 2 });
  famB = await seedFamily(api.db, { childCount: 1 });
  tokenA = await parentToken(famA.ownerId);
  parentAal2 = await parentToken(famA.ownerId, { aal: 'aal2' });
  const child = famA.children[0]!;
  childToken = (
    await issueChildAccessToken(
      api.config,
      { kind: 'child', childId: child.id, familyId: famA.familyId, sessionId: child.sessionId },
      api.now.value,
    )
  ).token;

  // Families: A created this month, B last month.
  await api.db
    .sql`update public.families set created_at = '2026-09-10T00:00:00Z' where id = ${famA.familyId}`;
  await api.db
    .sql`update public.families set created_at = '2026-08-10T00:00:00Z' where id = ${famB.familyId}`;
  // Paid slots: A has capacity 2 and both children assigned; B has none.
  await api.db
    .sql`insert into public.family_capacity (family_id, paid_slots) values (${famA.familyId}, 2)`;
  for (const c of famA.children) {
    await api.db
      .sql`insert into public.child_slot_assignments (family_id, child_id) values (${famA.familyId}, ${c.id})`;
  }
  // Subscriptions: A app_store active (new this month, 2 slots); B play_store active since August
  // (1 slot, period ended 15 Sep, inside the 30-day access bound); B stripe expired 10 Sep (lapsed).
  await entitlement(
    famA,
    'app_store',
    'active',
    2,
    '2026-09-05T00:00:00Z',
    '2026-10-05T00:00:00Z',
    '2026-09-05T00:00:00Z',
  );
  await entitlement(
    famB,
    'play_store',
    'active',
    1,
    '2026-08-15T00:00:00Z',
    '2026-09-15T00:00:00Z',
    '2026-08-15T00:00:00Z',
  );
  await entitlement(
    famB,
    'stripe',
    'expired',
    1,
    '2026-08-10T00:00:00Z',
    '2026-09-10T00:00:00Z',
    '2026-07-01T00:00:00Z',
  );
  // Billing periods: three charged across two months and channels, one refunded, one pending.
  periodA1 = await period(
    famA,
    'app_store',
    'ops-a-sep',
    '2026-09-05T00:00:00Z',
    '2026-10-05T00:00:00Z',
    4998,
    { slots: 2 },
  );
  await period(
    famB,
    'play_store',
    'ops-b-aug',
    '2026-08-15T00:00:00Z',
    '2026-09-15T00:00:00Z',
    3999,
    { settlement: 'refunded', refunded: 3999 },
  );
  const periodB3 = await period(
    famB,
    'stripe',
    'ops-b-aug-stripe',
    '2026-08-01T00:00:00Z',
    '2026-09-01T00:00:00Z',
    3999,
  );
  await period(
    famA,
    'app_store',
    'ops-a-pending',
    '2026-10-05T00:00:00Z',
    '2026-11-05T00:00:00Z',
    4998,
    { settlement: 'pending', settledAt: null, slots: 2 },
  );
  // A refund reported before its charge (parked).
  await api.db
    .sql`insert into public.pending_refunds (family_id, channel, provider_period_id, kind, refunded_cents)
                   values (${famA.familyId}, 'app_store', 'ops-a-early', 'refund', 4998)`;
  // A promo redemption (confirmed) this month.
  const [tpl] = await api.db.sql<{ id: string }[]>`
    insert into public.promo_campaign_templates
      (name, percent_off, eligible_tiers, subscriber_eligibility, redemption_cap, budget_cap_cents, calendar_timezone,
       timezone_confirmed, code_mode, channels, enabled, created_by)
    values ('Ops test', 50, '{1,2,3,4}', '{new,existing,lapsed}', 100, 1000000, 'UTC', true, 'shared',
            '{app_store,play_store,stripe}', true, ${adminId})
    returning id`;
  const [camp] = await api.db.sql<{ id: string }[]>`
    insert into public.promo_campaigns (template_id, campaign_month, generation_key, percent_off, eligible_tiers,
      subscriber_eligibility, redemption_cap, budget_cap_cents, opens_at, closes_at, status)
    values (${tpl!.id}, '2026-09', ${tpl!.id + ':2026-09'}, 50, '{1,2,3,4}', '{new,existing,lapsed}', 100, 1000000,
            '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', 'active')
    returning id`;
  const [code] = await api.db.sql<{ id: string }[]>`
    insert into public.promo_codes (campaign_id, code_normalized)
    values (${camp!.id}, ${generatePromoCode(cryptoRandom).normalized}) returning id`;
  await api.db.sql`
    insert into public.promo_redemptions (family_id, campaign_id, code_id, channel, target_period_key, target_period_start, state,
      idempotency_key, paid_slots, percent_off, regular_cents, discount_cents, charged_cents, redeemed_by, created_at, confirmed_at)
    values (${famA.familyId}, ${camp!.id}, ${code!.id}, 'app_store', 'first:app_store', '2026-09-05T00:00:00Z', 'confirmed',
            ${'idem-' + randomUUID()}, 2, 50, 4998, 2499, 2499, ${famA.ownerId}, '2026-09-04T00:00:00Z', '2026-09-05T00:00:00Z')`;
  // School contributions: two accruals, one reversed by a refund adjustment, one paid batch.
  const [school] = await api.db.sql<{ id: string }[]>`
    insert into public.schools (name, status, recipient_verified) values ('Ops Elementary', 'active', true) returning id`;
  const [accB] = await api.db.sql<{ id: string }[]>`
    insert into public.donation_accruals (family_id, school_id, donation_month, billing_period_id, eligibility_snapshot)
    values (${famB.familyId}, ${school!.id}, '2026-08', ${periodB3}, '{}'::text::jsonb) returning id`;
  await api.db.sql`
    insert into public.donation_accruals (family_id, school_id, donation_month, billing_period_id, eligibility_snapshot)
    values (${famA.familyId}, ${school!.id}, '2026-09', ${periodA1}, '{}'::text::jsonb)`;
  await api.db.sql`
    insert into public.donation_adjustments (accrual_id, amount_cents, reason, idempotency_key)
    values (${accB!.id}, -100, 'refund', ${'adj-' + randomUUID()})`;
  await api.db.sql`
    insert into public.donation_payout_batches (school_id, batch_key, total_cents, status, external_transfer_ref, approved_at, paid_at)
    values (${school!.id}, 'payout:ops-test:1', 100, 'paid', 'tr_synthetic_ops', now(), now())`;
  // P16 recognized revenue this month with a refund adjustment.
  const [imp] = await api.db.sql<{ id: string }[]>`
    insert into public.revenue_imports (source, file_sha256, period_month, imported_by, row_count)
    values ('manual', ${'a'.repeat(64)}, '2026-09', ${adminId}, 1) returning id`;
  const [entry] = await api.db.sql<{ id: string }[]>`
    insert into public.revenue_entries (import_id, source, external_ref, category, provider, placement, amount_cents, period_month)
    values (${imp!.id}, 'manual', 'inv-ops-1', 'recognized', 'sponsor_direct', 'adult_dashboard', 50000, '2026-09') returning id`;
  await api.db.sql`
    insert into public.revenue_adjustments (entry_id, kind, amount_cents, reason, idempotency_key, created_by)
    values (${entry!.id}, 'refund', -5000, 'partial refund (synthetic)', ${'radj-' + randomUUID()}, ${adminId})`;
  // AI spend: $2.50 this month against a $50 cap; $1 last month (excluded).
  await api.db.sql`
    insert into public.spend_budgets (scope, period_key, budget_micros, created_by)
    values ('global', '2026-09', 50000000, ${adminId})`;
  for (const [micros, at] of [
    [2_000_000, '2026-09-10T00:00:00Z'],
    [500_000, '2026-09-20T00:00:00Z'],
    [1_000_000, '2026-08-20T00:00:00Z'],
  ] as const) {
    await api.db.sql`
      insert into public.ai_usage_events (family_id, stage, model_id, prompt_version, status, input_tokens, output_tokens,
        latency_ms, cost_micros, rate_table_version, created_at)
      values (${famA.familyId}, 'grading', 'mock-model', 'v1', 'succeeded', 10, 5, 100, ${micros}, 'r1', ${at})`;
  }
  // Attention: a dead-letter job, a failed provider event, an open parent safety report, an
  // overdue deletion request (35 days old, still requested).
  await api.db.sql`
    insert into public.jobs (kind, idempotency_key, status, attempts, max_attempts)
    values ('entitlement_reconcile', 'ops-test:dead', 'dead_letter', 5, 5)`;
  await api.db.sql`
    insert into public.billing_provider_events (provider, provider_event_id, event_type, payload_sha256, status, received_at)
    values ('revenuecat', 'evt-ops-failed', 'RENEWAL', ${'b'.repeat(64)}, 'failed', '2026-09-23T15:00:00Z')`;
  await api.db.sql`
    insert into public.safety_reports (family_id, reporter_kind, category, note, status, created_at)
    values (${famA.familyId}, 'parent', 'other', 'synthetic parent note', 'open', '2026-09-22T15:00:00Z')`;
  await api.db.sql`
    insert into public.deletion_requests (family_id, scope, requested_by, status, requested_at, complete_by)
    values (${famB.familyId}, 'family', ${famB.ownerId}, 'requested', '2026-08-20T15:00:00Z', '2026-09-19T15:00:00Z')`;
  // One open refund request from family A (through the parent API).
  await ok(
    openCase(tokenA, {
      kind: 'refund_request',
      subject: 'Please refund September',
      message: 'Synthetic refund request.',
      billingPeriodId: periodA1,
    }),
    201,
  );
});

afterAll(async () => {
  await api?.close();
});

describe('owner-admin isolation', () => {
  const routes: [string, string, unknown?][] = [
    ['GET', '/overview'],
    ['GET', '/revenue?months=3'],
    ['GET', '/subscriptions'],
    ['GET', '/support/cases'],
    ['GET', '/support/cases/6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c'],
    [
      'POST',
      '/support/cases/6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c/messages',
      { message: 'x', internal: true },
    ],
    ['PATCH', '/support/cases/6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c', { status: 'closed' }],
    ['GET', '/settings/store-fee-rates'],
    [
      'PUT',
      '/settings/store-fee-rates',
      { rates: { app_store: 0, play_store: 0, stripe: 0, amazon_appstore: 0 } },
    ],
    ['GET', '/settings/support-policy'],
    [
      'PUT',
      '/settings/support-policy',
      {
        policy: {
          refundWindowDays: 14,
          responseTargetHours: {
            refund_request: 48,
            complaint: 48,
            billing_issue: 48,
            bug: 72,
            safety_question: 24,
            other: 72,
          },
          partialRefunds: true,
        },
      },
    ],
  ];

  it('a plain parent (even with MFA) and an admin without MFA get 403; children and anonymous get 401', async () => {
    for (const [method, path, body] of routes) {
      for (const token of [parentAal2, tokenA, adminNoMfa]) {
        const res = await admin(path, method, body, token);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(Object.keys(await json<Record<string, unknown>>(res))).toEqual(['error']);
      }
      expect((await admin(path, method, body, childToken)).status).toBe(401);
      expect((await api.request(`/v1/admin${path}`, { method })).status).toBe(401);
    }
    const [rates] = await api.db.sql<
      { value: Record<string, number> }[]
    >`select value from public.ops_settings where key = 'store_fee_rates'`;
    expect(rates!.value.app_store).toBe(0.3);
  });
});

describe('company overview', () => {
  let overview: OverviewResponse;

  it('is complete at rest, strict, and carries no child text', async () => {
    const raw = await ok(admin('/overview'));
    overview = overviewResponseSchema.parse(raw);
    expect(overview.asOf).toBe('2026-09-24T15:00:00.000Z');
    expect(overview.month).toBe('2026-09');
    expectNoChildText(raw);
  });

  it('families: total, new this month, active children with paid slots', () => {
    expect(overview.families.total).toMatchObject({ value: 2, source: 'public.families' });
    expect(overview.families.newThisMonth.value).toBe(1);
    expect(overview.families.activeChildrenWithPaidSlots).toMatchObject({
      value: 2,
      source: 'public.child_slot_assignments',
    });
  });

  it('subscriptions: active by channel and slots, new, lapsed, churn (never rounded up)', () => {
    const s = overview.subscriptions;
    expect(s.active.value).toBe(2);
    expect(s.subscribedFamilies.value).toBe(2);
    expect(s.byChannel).toEqual(
      channelSchema.options.map((channel) => ({
        channel,
        count: channel === 'app_store' || channel === 'play_store' ? 1 : 0,
      })),
    );
    expect(s.byPaidSlots).toEqual([
      { paidSlots: 1, count: 1 },
      { paidSlots: 2, count: 1 },
    ]);
    expect(s.byStatus).toEqual([
      { status: 'active', count: 2 },
      { status: 'expired', count: 1 },
    ]);
    expect(s.newThisMonth.value).toBe(1);
    expect(s.lapsedThisMonth.value).toBe(1);
    expect(s.activeAtMonthStart.value).toBe(2);
    expect(s.churn.basisPoints).toBe(5000);
    expect(s.churn.definition).toMatch(/rounded down/);
    expect(s.active.source).toBe('public.family_entitlements');
  });

  it('revenue: this month and the last six by channel, gross, refunds, estimated fee, net', () => {
    const r = overview.revenue;
    expect(r.months.map((m) => m.month)).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
    ]);
    const sep = r.months.at(-1)!;
    expect(sep.channels.find((c) => c.channel === 'app_store')).toEqual({
      channel: 'app_store',
      periods: 1,
      grossChargedCents: 4998,
      refundedCents: 0,
      feeRateBasisPoints: 3000,
      storeFeeCents: 1499, // 1499.4 rounds to 1499
      netCents: 3499,
    });
    expect(sep.totals).toEqual({
      grossChargedCents: 4998,
      refundedCents: 0,
      storeFeeCents: 1499,
      netCents: 3499,
    });
    const aug = r.months.at(-2)!;
    expect(aug.channels.find((c) => c.channel === 'play_store')).toMatchObject({
      periods: 1,
      grossChargedCents: 3999,
      refundedCents: 3999,
      storeFeeCents: 0,
      netCents: 0,
    });
    expect(aug.channels.find((c) => c.channel === 'stripe')).toMatchObject({
      periods: 1,
      grossChargedCents: 3999,
      refundedCents: 0,
      feeRateBasisPoints: 0,
      storeFeeCents: 0,
      netCents: 3999,
    });
    expect(aug.totals).toEqual({
      grossChargedCents: 7998,
      refundedCents: 3999,
      storeFeeCents: 0,
      netCents: 3999,
    });
    // The pending (uncharged) period is not revenue; every channel has a line, zero included.
    for (const month of r.months) {
      expect(month.channels.map((c) => c.channel)).toEqual([...channelSchema.options]);
    }
    expect(r.months.slice(0, 4).every((m) => m.totals.grossChargedCents === 0)).toBe(true);
    expect(r.feeRates).toEqual({
      app_store: 0.3,
      play_store: 0.3,
      amazon_appstore: 0.3,
      stripe: 0,
    });
    expect(r.notes.join(' ')).toMatch(/Stripe’s per-transaction fee/);
    expect(r.source).toBe('public.billing_periods');
  });

  it('promo redemptions, school contributions, P16 recognized revenue and AI spend vs the cap', () => {
    expect(overview.promoRedemptions.byState).toEqual([{ state: 'confirmed', count: 1 }]);
    expect(overview.promoRedemptions.thisMonth.value).toBe(1);
    expect(overview.schoolContributions.accruedCents).toMatchObject({ cents: 100 });
    expect(overview.schoolContributions.paidOutCents).toMatchObject({
      cents: 100,
      source: 'public.donation_payout_batches',
    });
    expect(overview.monetization.recognizedThisMonthCents.cents).toBe(45_000);
    expect(overview.aiSpend).toMatchObject({
      month: '2026-09',
      spentMicros: '2500000',
      budgetMicros: '50000000',
      spentCents: 250,
      budgetCents: 5000,
      percentOfCap: 5,
    });
  });

  it('attention: failed jobs, failed provider events, open safety reports, overdue deletions, open cases by kind, blocked readiness', async () => {
    const byKey = (kind: string, key: string | null = null) =>
      overview.attention.find((a) => a.kind === kind && a.key === key)!;
    expect(byKey('jobs_failed')).toMatchObject({ count: 1, source: 'public.jobs' });
    expect(byKey('jobs_failed').oldestAgeHours).toBeGreaterThanOrEqual(0);
    expect(byKey('billing_events_failed')).toMatchObject({
      count: 1,
      oldestAt: '2026-09-23T15:00:00.000Z',
      oldestAgeHours: 24,
    });
    expect(byKey('safety_reports_open')).toMatchObject({
      count: 1,
      oldestAt: '2026-09-22T15:00:00.000Z',
      oldestAgeHours: 48,
    });
    expect(byKey('deletions_overdue')).toMatchObject({
      count: 1,
      oldestAt: '2026-08-20T15:00:00.000Z',
      oldestAgeHours: 35 * 24,
    });
    expect(byKey('deletions_overdue').definition).toMatch(/25\+ days/);
    expect(byKey('support_cases_open', 'refund_request')).toMatchObject({ count: 1 });
    expect(byKey('support_cases_open', 'complaint')).toMatchObject({
      count: 0,
      oldestAt: null,
      oldestAgeHours: null,
    });
    expect(overview.attention.filter((a) => a.kind === 'support_cases_open')).toHaveLength(6);
    // The test configuration has blocked readiness checks (no ZDR evidence, mock providers).
    expect(overview.readiness.blocked.length).toBeGreaterThan(0);
    expect(byKey('readiness_blocked').count).toBe(overview.readiness.blocked.length);
    const readiness = await ok<{ checks: { check: string; status: string }[] }>(
      admin('/readiness'),
    );
    expect(overview.readiness.blocked.map((b) => b.check)).toEqual(
      readiness.checks.filter((c) => c.status === 'blocked').map((c) => c.check),
    );
  });

  it('every metric names its source table and definition', () => {
    const metrics = [
      ...Object.values(overview.families),
      overview.subscriptions.active,
      overview.subscriptions.newThisMonth,
      overview.subscriptions.lapsedThisMonth,
      overview.subscriptions.churn,
      overview.promoRedemptions.thisMonth,
      overview.schoolContributions.accruedCents,
      overview.schoolContributions.paidOutCents,
      overview.monetization.recognizedThisMonthCents,
      overview.aiSpend,
      ...overview.attention,
    ];
    for (const m of metrics) {
      expect(m.source).toMatch(/^(public\.|\/v1\/admin\/)/);
      expect(m.definition.length).toBeGreaterThan(20);
    }
  });
});

describe('revenue and subscriptions routes', () => {
  it('GET /revenue?months=N bounds N and buckets by UTC month', async () => {
    const two = revenueResponseSchema.parse(await ok(admin('/revenue?months=2')));
    expect(two.months.map((m) => m.month)).toEqual(['2026-08', '2026-09']);
    const one = revenueResponseSchema.parse(await ok(admin('/revenue?months=1')));
    expect(one.months).toHaveLength(1);
    const six = revenueResponseSchema.parse(await ok(admin('/revenue')));
    expect(six.months).toHaveLength(6);
    for (const bad of ['0', '37', 'six', '2.5']) {
      expect((await admin(`/revenue?months=${bad}`)).status).toBe(400);
    }
    // A period settled 30 Sep 23:30 in UTC-5 is October in UTC.
    await period(
      famB,
      'stripe',
      'ops-b-oct-utc',
      '2026-09-30T23:30:00-05:00',
      '2026-10-30T00:00:00Z',
      1000,
    );
    const after = revenueResponseSchema.parse(await ok(admin('/revenue?months=2')));
    expect(after.months[1]!.channels.find((c) => c.channel === 'stripe')!.grossChargedCents).toBe(
      0,
    );
    expect(after.asOf).toBe('2026-09-24T15:00:00.000Z');
  });

  it('GET /subscriptions matches the overview and follows the request clock', async () => {
    const now = subscriptionsSummarySchema.parse(await ok(admin('/subscriptions')));
    expect(now.active.value).toBe(2);
    // In November both periods (ended 15 Sep and 5 Oct) are past the 30-day access bound.
    api.now.value = new Date('2026-11-10T12:00:00Z');
    try {
      const later = subscriptionsSummarySchema.parse(await ok(admin('/subscriptions')));
      expect(later.month).toBe('2026-11');
      expect(later.active.value).toBe(0);
      expect(later.byChannel.every((c) => c.count === 0)).toBe(true);
      expect(later.churn.basisPoints).toBeNull();
    } finally {
      api.now.value = new Date('2026-09-24T15:00:00Z');
    }
  });
});

describe('support queue', () => {
  let refundCaseId: string;
  let complaintId: string;
  let bugId: string;

  it('lists open cases oldest first with filters by status, kind and age', async () => {
    const first = adminCaseQueueResponseSchema.parse(await ok(admin('/support/cases')));
    expect(first.cases).toHaveLength(1);
    refundCaseId = first.cases[0]!.id;
    expect(first.cases[0]).toMatchObject({
      familyId: famA.familyId,
      kind: 'refund_request',
      status: 'open',
      priority: 'normal',
      billingPeriod: { channel: 'app_store', providerPeriodId: 'ops-a-sep' },
      ageBucket: 'under_24h',
      messageCount: 0,
      lastMessageAt: null,
    });
    expect(first.nextCursor).toBeNull();

    complaintId = (
      await ok<{ case: { id: string } }>(
        openCase(tokenA, { kind: 'complaint', subject: 'Complaint', message: 'Synthetic.' }),
        201,
      )
    ).case.id;
    bugId = (
      await ok<{ case: { id: string } }>(
        openCase(await parentToken(famB.ownerId), {
          kind: 'bug',
          subject: 'Bug',
          message: 'Synthetic.',
        }),
        201,
      )
    ).case.id;
    // The complaint was opened four days ago.
    await api.db
      .sql`update public.support_cases set created_at = '2026-09-20T15:00:00Z' where id = ${complaintId}`;

    const all = adminCaseQueueResponseSchema.parse(await ok(admin('/support/cases')));
    expect(all.cases.map((c) => c.id)).toEqual([complaintId, refundCaseId, bugId]);
    expect(all.cases[0]).toMatchObject({ ageHours: 96, ageBucket: '3_to_7_days' });
    expectNoChildText(all);

    const byKind = adminCaseQueueResponseSchema.parse(await ok(admin('/support/cases?kind=bug')));
    expect(byKind.cases.map((c) => c.id)).toEqual([bugId]);
    const aged = adminCaseQueueResponseSchema.parse(await ok(admin('/support/cases?age=over_24h')));
    expect(aged.cases.map((c) => c.id)).toEqual([complaintId]);
    expect(
      adminCaseQueueResponseSchema.parse(await ok(admin('/support/cases?age=over_7d'))).cases,
    ).toEqual([]);
    for (const bad of ['?status=pending', '?kind=chat', '?age=yesterday', '?after=abc', '?x=1']) {
      expect((await admin(`/support/cases${bad}`)).status).toBe(400);
    }
  });

  it('pages with a keyset cursor and never hides an older case', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    await api.db.sql`
      insert into public.support_cases (family_id, opened_by_user_id, opened_by_kind, kind, subject, body, created_at)
      select ${fam.familyId}, ${fam.ownerId}, 'parent', 'other', 'Bulk ' || i, 'Synthetic.',
             timestamptz '2026-09-01T00:00:00Z' + (i * interval '1 minute')
        from generate_series(1, ${ADMIN_CASE_PAGE_SIZE + 2}) as i`;
    const page1 = adminCaseQueueResponseSchema.parse(await ok(admin('/support/cases')));
    expect(page1.cases).toHaveLength(ADMIN_CASE_PAGE_SIZE);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = adminCaseQueueResponseSchema.parse(
      await ok(admin(`/support/cases?after=${page1.nextCursor}`)),
    );
    expect(page2.nextCursor).toBeNull();
    const ids = [...page1.cases, ...page2.cases].map((c) => c.id);
    expect(new Set(ids).size).toBe(ADMIN_CASE_PAGE_SIZE + 2 + 3);
    expect(ids).toContain(refundCaseId);
    expect(ids).toContain(bugId);
    const scoped = adminCaseQueueResponseSchema.parse(
      await ok(admin('/support/cases?scope=all&kind=other')),
    );
    expect(scoped.cases).toHaveLength(ADMIN_CASE_PAGE_SIZE);
    await api.db.sql`delete from public.support_cases where family_id = ${fam.familyId}`;
  });

  it('a refund request’s detail shows the family’s billing periods, reported refunds and the store’s refund path', async () => {
    const raw = await ok(admin(`/support/cases/${refundCaseId}`));
    const detail = adminSupportCaseDetailResponseSchema.parse(raw);
    expectNoChildText(raw);
    expect(detail.family).toMatchObject({
      id: famA.familyId,
      displayName: 'Test Family',
      deletedAt: null,
    });
    expect(detail.billingPeriods.map((p) => [p.providerPeriodId, p.linkedToCase])).toEqual([
      ['ops-a-pending', false],
      ['ops-a-sep', true],
    ]);
    expect(detail.billingPeriods[1]).toMatchObject({
      chargedAmountCents: 4998,
      refundedCents: 0,
      settlement: 'settled',
    });
    expect(detail.pendingRefunds).toEqual([
      expect.objectContaining({
        providerPeriodId: 'ops-a-early',
        kind: 'refund',
        refundedCents: 4998,
      }),
    ]);
    expect(detail.refundPath).toBe(REFUND_PATH_BY_CHANNEL.app_store);
    expect(detail.refundPath).toMatch(/Apple issues/);
    expect(detail.stripeRefundFromCase).toBe(false);
    expect(detail.messages).toEqual([]);

    // The store reports the refund: the linked period on the case now shows it.
    await api.db
      .sql`update public.billing_periods set settlement = 'partially_refunded', refunded_cents = 2000 where id = ${periodA1}`;
    const after = adminSupportCaseDetailResponseSchema.parse(
      await ok(admin(`/support/cases/${refundCaseId}`)),
    );
    expect(after.billingPeriods.find((p) => p.linkedToCase)).toMatchObject({
      refundedCents: 2000,
      settlement: 'partially_refunded',
    });
    expect(
      adminSupportCaseDetailResponseSchema.parse(await ok(admin(`/support/cases/${complaintId}`)))
        .refundPath,
    ).toBeNull();
    expect((await admin('/support/cases/6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c')).status).toBe(404);
    expect((await admin('/support/cases/nope')).status).toBe(404);
  });

  it('staff add internal notes and public replies; the detail shows both, audited without text', async () => {
    const note = await ok<{
      message: { internal: boolean; id: string };
      case: { messageCount: number };
    }>(
      admin(`/support/cases/${refundCaseId}/messages`, 'POST', {
        message: 'INTERNAL: receipt checked, refund is Apple’s call',
        internal: true,
      }),
      201,
    );
    expect(note.message.internal).toBe(true);
    expect(note.case.messageCount).toBe(1);
    await ok(
      admin(`/support/cases/${refundCaseId}/messages`, 'POST', {
        message: 'Apple issues App Store refunds; here is how to request one.',
        internal: false,
      }),
      201,
    );
    const detail = adminSupportCaseDetailResponseSchema.parse(
      await ok(admin(`/support/cases/${refundCaseId}`)),
    );
    expect(detail.messages.map((m) => [m.internal, m.authorKind])).toEqual([
      [true, 'admin'],
      [false, 'admin'],
    ]);
    expect(detail.case.lastMessageAt).not.toBeNull();
    for (const bad of [
      { message: 'x' },
      { message: 'x', internal: 'yes' },
      { message: '', internal: true },
      // Staff free text refuses control characters like every other field (API-AUTH-R1-01).
      { message: 'checked\u0000 twice', internal: true },
      { message: 'see \u001b[31mred', internal: false },
    ]) {
      expect((await admin(`/support/cases/${refundCaseId}/messages`, 'POST', bad)).status).toBe(
        400,
      );
    }
    const audits = await api.db.sql<{ metadata: Record<string, unknown> }[]>`
      select metadata from public.audit_events
       where action = 'support.message_added' and target_id = ${refundCaseId} and actor_kind = 'admin' order by id`;
    expect(audits.map((a) => a.metadata.internal)).toEqual([true, false]);
    expect(JSON.stringify(audits)).not.toContain('receipt checked');
  });

  it('updates status, assignee, priority and resolution under the domain rules', async () => {
    const patch = (body: unknown, id = refundCaseId) =>
      admin(`/support/cases/${id}`, 'PATCH', body);
    const rule = async (res: Response) => (await json<ErrorBody>(res)).error.rule;

    expect(await rule(await patch({ status: 'resolved' }))).toBe('RESOLUTION_REQUIRED');
    expect(await rule(await patch({ resolution: 'answered' }))).toBe(
      'RESOLUTION_NEEDS_CLOSED_OUT_STATUS',
    );
    expect(
      await rule(await patch({ status: 'resolved', resolution: 'stripe_refund_issued' })),
    ).toBe('REFERENCE_REQUIRED');
    expect(await rule(await patch({ resolutionReference: 're_x' }))).toBe(
      'REFERENCE_WITHOUT_RESOLUTION',
    );
    expect(await rule(await patch({ assigneeUserId: famA.ownerId }))).toBe('ASSIGNEE_NOT_STAFF');
    expect((await patch({})).status).toBe(400);
    expect((await patch({ status: 'done' })).status).toBe(400);

    const assigned = adminCaseResponseSchema.parse(
      await ok(patch({ assigneeUserId: adminId, priority: 'high', status: 'in_progress' })),
    );
    expect(assigned.case).toMatchObject({
      assigneeUserId: adminId,
      priority: 'high',
      status: 'in_progress',
      resolvedAt: null,
    });
    const filtered = adminCaseQueueResponseSchema.parse(
      await ok(admin('/support/cases?status=in_progress')),
    );
    expect(filtered.cases.map((c) => c.id)).toEqual([refundCaseId]);

    // A store refund: recorded as the store's outcome, never as money PencilLift moved.
    const resolved = adminCaseResponseSchema.parse(
      await ok(patch({ status: 'resolved', resolution: 'refunded_by_store' })),
    );
    expect(resolved.case).toMatchObject({ status: 'resolved', resolution: 'refunded_by_store' });
    expect(resolved.case.resolvedAt).toBe('2026-09-24T15:00:00.000Z');
    expect(
      adminCaseQueueResponseSchema.parse(await ok(admin('/support/cases'))).cases.map((c) => c.id),
    ).not.toContain(refundCaseId);
    expect(
      adminCaseQueueResponseSchema
        .parse(await ok(admin('/support/cases?scope=all')))
        .cases.map((c) => c.id),
    ).toContain(refundCaseId);

    // Reopening keeps nothing stale: the resolution must be cleared with the status.
    expect(await rule(await patch({ status: 'in_progress' }))).toBe(
      'RESOLUTION_NEEDS_CLOSED_OUT_STATUS',
    );
    const reopened = adminCaseResponseSchema.parse(
      await ok(patch({ status: 'in_progress', resolution: null })),
    );
    expect(reopened.case).toMatchObject({
      status: 'in_progress',
      resolution: null,
      resolvedAt: null,
    });

    // A Stripe refund issued in the dashboard is recorded by its reference.
    const stripe = adminCaseResponseSchema.parse(
      await ok(
        patch({
          status: 'resolved',
          resolution: 'stripe_refund_issued',
          resolutionReference: ' re_synthetic_0042 ',
        }),
      ),
    );
    expect(stripe.case).toMatchObject({
      resolution: 'stripe_refund_issued',
      resolutionReference: 're_synthetic_0042',
    });

    const closed = adminCaseResponseSchema.parse(
      await ok(patch({ status: 'closed', assigneeUserId: null })),
    );
    expect(closed.case).toMatchObject({ status: 'closed', assigneeUserId: null });
    expect(closed.case.resolvedAt).toBe('2026-09-24T15:00:00.000Z');

    const audits = await api.db.sql<
      { metadata: { from: { status: string }; to: { status: string } } }[]
    >`
      select metadata from public.audit_events
       where action = 'support.case_updated' and target_id = ${refundCaseId} and actor_kind = 'admin' order by id`;
    expect(audits.map((a) => `${a.metadata.from.status}>${a.metadata.to.status}`)).toEqual([
      'open>in_progress',
      'in_progress>resolved',
      'resolved>in_progress',
      'in_progress>resolved',
      'resolved>closed',
    ]);
    expect(JSON.stringify(audits)).not.toContain('re_synthetic');
    expect((await patch({ status: 'closed' }, '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c')).status).toBe(
      404,
    );
  });
});

describe('store fee rates', () => {
  it('reads the seeded rates, validates and saves new ones, and the revenue view uses them', async () => {
    const before = storeFeeRatesResponseSchema.parse(await ok(admin('/settings/store-fee-rates')));
    expect(before.rates).toEqual({
      app_store: 0.3,
      play_store: 0.3,
      amazon_appstore: 0.3,
      stripe: 0,
    });
    expect(before.updatedBy).toBeNull();
    expect(before.notes.join(' ')).toMatch(/estimate/);

    for (const bad of [
      { rates: { app_store: 0.15, play_store: 0.3, stripe: 0 } },
      { rates: { app_store: 1.5, play_store: 0.3, amazon_appstore: 0.3, stripe: 0 } },
      { rates: { app_store: 0.12345, play_store: 0.3, amazon_appstore: 0.3, stripe: 0 } },
      { rates: { app_store: 0.3, play_store: 0.3, amazon_appstore: 0.3, stripe: 0, amazon: 0.3 } },
      {},
    ]) {
      expect(
        (await admin('/settings/store-fee-rates', 'PUT', bad)).status,
        JSON.stringify(bad),
      ).toBe(400);
    }

    const saved = storeFeeRatesResponseSchema.parse(
      await ok(
        admin('/settings/store-fee-rates', 'PUT', {
          rates: { app_store: 0.15, play_store: 0.15, amazon_appstore: 0.2, stripe: 0 },
        }),
      ),
    );
    expect(saved.rates).toEqual({
      app_store: 0.15,
      play_store: 0.15,
      amazon_appstore: 0.2,
      stripe: 0,
    });
    expect(saved.updatedBy).toBe(adminId);
    // Stamped by the row's touch trigger (database clock), so only its presence is asserted.
    expect(saved.updatedAt).not.toBeNull();
    const again = storeFeeRatesResponseSchema.parse(await ok(admin('/settings/store-fee-rates')));
    expect(again.rates.app_store).toBe(0.15);

    const revenue = revenueResponseSchema.parse(await ok(admin('/revenue?months=1')));
    const sep = revenue.months[0]!.channels.find((c) => c.channel === 'app_store')!;
    // 4998 − 2000 reported refunded = 2998 kept; 15% = 449.7 → 450; net = 4998 − 2000 − 450.
    expect(sep).toMatchObject({
      feeRateBasisPoints: 1500,
      grossChargedCents: 4998,
      refundedCents: 2000,
      storeFeeCents: 450,
      netCents: 2548,
    });
    const audits = await api.db.sql<
      { metadata: { from: { app_store: number }; to: { app_store: number } } }[]
    >`
      select metadata from public.audit_events where action = 'ops.store_fee_rates_updated'`;
    expect(audits.map((a) => [a.metadata.from.app_store, a.metadata.to.app_store])).toEqual([
      [0.3, 0.15],
    ]);
  });
});

describe('support policy (Owner action #32)', () => {
  const targets = {
    refund_request: 48,
    complaint: 48,
    billing_issue: 48,
    bug: 72,
    safety_question: 24,
    other: 72,
  };

  it('reads the defaults while no row exists, refuses bad values, saves and audits a new policy', async () => {
    const before = supportPolicyResponseSchema.parse(await ok(admin('/settings/support-policy')));
    expect(before).toMatchObject({
      usedDefault: true,
      updatedAt: null,
      updatedBy: null,
      policy: { refundWindowDays: 14, partialRefunds: true, responseTargetHours: targets },
    });

    for (const bad of [
      { policy: { refundWindowDays: 0, responseTargetHours: targets, partialRefunds: true } },
      { policy: { refundWindowDays: 91, responseTargetHours: targets, partialRefunds: true } },
      { policy: { refundWindowDays: 7.5, responseTargetHours: targets, partialRefunds: true } },
      {
        policy: {
          refundWindowDays: 7,
          responseTargetHours: { ...targets, bug: 0 },
          partialRefunds: true,
        },
      },
      {
        policy: {
          refundWindowDays: 7,
          responseTargetHours: { complaint: 48 },
          partialRefunds: true,
        },
      },
      { policy: { refundWindowDays: 7, responseTargetHours: targets, partialRefunds: 'yes' } },
      {
        policy: {
          refundWindowDays: 7,
          responseTargetHours: targets,
          partialRefunds: true,
          extra: 1,
        },
      },
      { rates: {} },
    ]) {
      expect(
        (await admin('/settings/support-policy', 'PUT', bad)).status,
        JSON.stringify(bad),
      ).toBe(400);
    }

    const saved = supportPolicyResponseSchema.parse(
      await ok(
        admin('/settings/support-policy', 'PUT', {
          policy: {
            refundWindowDays: 30,
            responseTargetHours: { ...targets, safety_question: 12 },
            partialRefunds: false,
          },
        }),
      ),
    );
    expect(saved).toMatchObject({
      usedDefault: false,
      updatedBy: adminId,
      policy: { refundWindowDays: 30, partialRefunds: false },
    });
    expect(saved.policy.responseTargetHours.safety_question).toBe(12);
    expect(saved.updatedAt).not.toBeNull();
    const again = supportPolicyResponseSchema.parse(await ok(admin('/settings/support-policy')));
    expect(again.policy.refundWindowDays).toBe(30);

    const audits = await api.db.sql<
      { metadata: { from: { refundWindowDays: number }; to: { refundWindowDays: number } } }[]
    >`
      select metadata from public.audit_events where action = 'ops.support_policy_updated'`;
    expect(
      audits.map((a) => [a.metadata.from.refundWindowDays, a.metadata.to.refundWindowDays]),
    ).toEqual([[14, 30]]);
    // The parent-facing view follows the saved policy at once.
    const parentView = await ok<{ refundWindowDays: number; refundWindowSentence: string }>(
      api.request('/v1/support/policy', { token: tokenA }),
    );
    expect(parentView.refundWindowDays).toBe(30);
    expect(parentView.refundWindowSentence).toMatch(/last 30 days/);
  });
});
