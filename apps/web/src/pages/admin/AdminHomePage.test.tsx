import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  channelSchema,
  type AttentionItem,
  type OverviewResponse,
  type RevenueMonth,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import AdminHomePage from './AdminHomePage.tsx';
import { compactUsd } from './components/RevenueChart.tsx';

// Synthetic company numbers only. No family, child or case text appears in an overview.

afterEach(() => {
  cleanup();
});

function apiWith(get: (path: string) => unknown): Partial<ApiClient> {
  return {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      const value = get(path);
      if (value instanceof Error) return Promise.reject(value);
      try {
        return Promise.resolve(schema.parse(value));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

const AT = '2026-09-25T12:00:00.000Z';
type Channel = z.infer<typeof channelSchema>;
const CHANNELS = channelSchema.options;

function metric(value: number, source = 'public.families', definition = 'Rows counted.') {
  return { value, source, definition };
}

function line(channel: Channel, gross = 0, refunds = 0) {
  const feeRateBasisPoints = channel === 'stripe' ? 0 : 3000;
  const storeFeeCents = Math.floor(((gross - refunds) * feeRateBasisPoints) / 10_000);
  return {
    channel,
    periods: gross > 0 ? 1 : 0,
    grossChargedCents: gross,
    refundedCents: refunds,
    feeRateBasisPoints,
    storeFeeCents,
    netCents: gross - refunds - storeFeeCents,
  };
}

function month(
  key: string,
  amounts: Partial<Record<Channel, readonly [number, number]>> = {},
): RevenueMonth {
  const channels = CHANNELS.map((c) => line(c, ...(amounts[c] ?? [0, 0])));
  return {
    month: key,
    channels,
    totals: {
      grossChargedCents: channels.reduce((s, l) => s + l.grossChargedCents, 0),
      refundedCents: channels.reduce((s, l) => s + l.refundedCents, 0),
      storeFeeCents: channels.reduce((s, l) => s + l.storeFeeCents, 0),
      netCents: channels.reduce((s, l) => s + l.netCents, 0),
    },
  };
}

function item(
  kind: AttentionItem['kind'],
  count: number,
  oldestAgeHours: number | null,
  key: string | null = null,
): AttentionItem {
  return {
    kind,
    key,
    count,
    oldestAt:
      oldestAgeHours === null
        ? null
        : new Date(Date.parse(AT) - oldestAgeHours * 3_600_000).toISOString(),
    oldestAgeHours,
    source: kind === 'support_cases_open' ? 'public.support_cases' : `public.${kind}`,
    definition: `Rule ${kind}.`,
  };
}

const SUPPORT_KINDS = [
  'complaint',
  'refund_request',
  'billing_issue',
  'bug',
  'safety_question',
  'other',
] as const;

function overview(overrides: Partial<OverviewResponse> = {}): OverviewResponse {
  return {
    asOf: AT,
    month: '2026-09',
    families: {
      total: metric(42, 'public.families', 'Families without a deletion tombstone.'),
      newThisMonth: metric(5, 'public.families', 'Families created in 2026-09 UTC.'),
      activeChildrenWithPaidSlots: metric(
        31,
        'public.child_slot_assignments',
        'Open slot assignments whose child profile is active.',
      ),
    },
    subscriptions: {
      asOf: AT,
      month: '2026-09',
      active: metric(37, 'public.family_entitlements', 'Rows that grant paid access now.'),
      subscribedFamilies: metric(35, 'public.family_entitlements', 'Distinct families.'),
      byChannel: [
        { channel: 'app_store', count: 20 },
        { channel: 'play_store', count: 12 },
        { channel: 'stripe', count: 5 },
        { channel: 'amazon_appstore', count: 0 },
      ],
      byPaidSlots: [
        { paidSlots: 1, count: 25 },
        { paidSlots: 2, count: 12 },
      ],
      byStatus: [
        { status: 'active', count: 37 },
        { status: 'expired', count: 9 },
      ],
      newThisMonth: metric(4, 'public.family_entitlements', 'New in 2026-09.'),
      lapsedThisMonth: metric(2, 'public.family_entitlements', 'Lapsed in 2026-09.'),
      activeAtMonthStart: metric(35, 'public.family_entitlements', 'Active at month start.'),
      churn: {
        basisPoints: 571,
        source: 'public.family_entitlements',
        definition: 'lapsed ÷ active at month start, rounded down.',
      },
    },
    revenue: {
      asOf: AT,
      months: [
        month('2026-04'),
        month('2026-05', { app_store: [399_900, 0] }),
        month('2026-06', { app_store: [399_900, 0], play_store: [99_900, 0] }),
        month('2026-07', { app_store: [799_800, 39_990] }),
        month('2026-08', { play_store: [499_900, 0], stripe: [3_999, 0] }),
        month('2026-09', {
          app_store: [799_800, 3_999],
          play_store: [499_900, 0],
          stripe: [3_999, 0],
        }),
      ],
      feeRates: { app_store: 0.3, play_store: 0.3, stripe: 0, amazon_appstore: 0.3 },
      notes: [
        'Store fees are an estimate at the configured rate; the store statements are the truth.',
        'Stripe’s per-transaction fee is not modelled.',
      ],
      source: 'public.billing_periods',
      definition: 'Charged periods bucketed by the UTC month of settlement.',
    },
    promoRedemptions: {
      byState: [
        { state: 'confirmed', count: 3 },
        { state: 'expired', count: 1 },
      ],
      thisMonth: metric(1, 'public.promo_redemptions', 'Redemptions created in 2026-09 UTC.'),
      source: 'public.promo_redemptions',
      definition: 'Every redemption row by its current state.',
    },
    schoolContributions: {
      accruedCents: {
        cents: 12_000,
        source: 'public.school_contribution_accruals',
        definition: 'Accrued, all time.',
      },
      paidOutCents: { cents: 0, source: 'public.payout_batches', definition: 'Paid batches.' },
    },
    monetization: {
      recognizedThisMonthCents: {
        cents: 0,
        source: 'public.revenue_entries',
        definition: 'P16 recognized entries for 2026-09.',
      },
    },
    aiSpend: {
      month: '2026-09',
      spentMicros: '12345678',
      budgetMicros: '50000000',
      spentCents: 1234,
      budgetCents: 5000,
      percentOfCap: 24,
      source: 'public.ai_usage_events',
      definition: 'Sum of cost_micros for 2026-09 against the global budget row.',
    },
    attention: [
      item('jobs_failed', 0, null),
      item('billing_events_failed', 1, 24),
      item('safety_reports_open', 0, null),
      item('deletions_overdue', 0, null),
      ...SUPPORT_KINDS.map((kind) =>
        item(
          'support_cases_open',
          kind === 'refund_request' ? 2 : kind === 'complaint' ? 1 : 0,
          kind === 'refund_request' ? 72 : kind === 'complaint' ? 5 : null,
          kind,
        ),
      ),
      item('readiness_blocked', 2, null),
    ],
    readiness: {
      blocked: [
        { check: 'consent_provider', detail: 'Verifiable parental consent provider' },
        { check: 'billing_provider', detail: 'RevenueCat server credentials' },
      ],
      source: 'GET /v1/admin/readiness',
      definition: 'The readiness report’s blocked checks.',
    },
    ...overrides,
  };
}

const readiness = {
  environment: 'development',
  checks: [
    {
      check: 'consent_provider',
      status: 'blocked',
      detail: 'Verifiable parental consent provider',
    },
    { check: 'billing_provider', status: 'blocked', detail: 'RevenueCat server credentials' },
    { check: 'cors', status: 'ready', detail: 'Explicit CORS origins' },
  ],
};

function api(data: OverviewResponse = overview()): Partial<ApiClient> {
  return apiWith((path) => {
    if (path === '/v1/admin/overview') return data;
    if (path === '/v1/admin/readiness') return readiness;
    return new Error(`unexpected ${path}`);
  });
}

function tile(name: string): HTMLElement {
  const strip = screen.getByRole('list', { name: 'Company summary' });
  const label = within(strip).getByText(name);
  const card = label.closest('[role="listitem"]');
  if (!(card instanceof HTMLElement)) throw new Error(`tile ${name} not found`);
  return card;
}

describe('AdminHomePage access (spec P14 owner admin; AC_UX_02)', () => {
  it('shows the MFA requirement once and no admin data when the API refuses', async () => {
    const refused = apiWith(
      () => new ApiRequestError('FORBIDDEN', 'Owner administration requires an MFA session', 403),
    );
    renderPage(<AdminHomePage />, { api: refused });
    expect(await screen.findByText(/Owner administration requires an MFA session/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Company summary' })).toBeNull();
  });

  it('offers a retry for a non-permission failure and still shows readiness', async () => {
    const flaky = apiWith((path) =>
      path === '/v1/admin/readiness'
        ? readiness
        : new ApiRequestError('NETWORK', 'You appear to be offline.', 0),
    );
    renderPage(<AdminHomePage />, { api: flaky });
    expect(await screen.findByText(/You appear to be offline/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(await screen.findByRole('table', { name: /Production readiness/ })).toBeTruthy();
  });
});

describe('AdminHomePage company overview', () => {
  it('renders the summary strip from the overview with sources on every tile', async () => {
    renderPage(<AdminHomePage />, { api: api() });
    await screen.findByRole('list', { name: 'Company summary' });
    expect(within(tile('Families')).getByText('42')).toBeTruthy();
    expect(within(tile('Families')).getByText('5 new in September 2026')).toBeTruthy();
    expect(within(tile('Active subscriptions')).getByText('37')).toBeTruthy();
    expect(
      within(tile('Active subscriptions')).getByText(/35 families · 31 children on paid slots/),
    ).toBeTruthy();
    // September: 799,800 + 499,900 + 3,999 gross − 3,999 refunds − 30% fees on the store lines.
    const september = overview().revenue.months[5]!;
    expect(
      within(tile('Net revenue this month')).getByText(
        `$${(september.totals.netCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
      ),
    ).toBeTruthy();
    expect(within(tile('AI spend vs cap')).getByText('$12.34')).toBeTruthy();
    expect(within(tile('AI spend vs cap')).getByText('24% of the $50.00 cap')).toBeTruthy();
    expect(within(tile('Open support cases')).getByText('3')).toBeTruthy();
    expect(within(tile('Open support cases')).getByText('oldest 3d')).toBeTruthy();
    expect(within(tile('Open safety flags')).getByText('0')).toBeTruthy();
    // Every tile names its source table.
    for (const name of ['Families', 'AI spend vs cap', 'Open support cases']) {
      expect(within(tile(name)).getByText(/^Source:/)).toBeTruthy();
    }
    expect(within(tile('Families')).getByText('public.families')).toBeTruthy();
    expect(within(tile('AI spend vs cap')).getByText('public.ai_usage_events')).toBeTruthy();
  });

  it('lists every attention rule, live items first with the oldest at the top, linking to the right page', async () => {
    renderPage(<AdminHomePage />, { api: api() });
    const table = await screen.findByRole('table', { name: 'Needs attention' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(11); // jobs, billing events, safety, deletions, 6 case kinds, readiness
    expect(screen.getByText(/4 of 11 rules have items waiting/)).toBeTruthy();
    // Oldest first: refund requests (3 days), then failed billing events (1 day), complaints (5h).
    expect(within(rows[0]!).getByText('Open support cases: Refund request')).toBeTruthy();
    expect(within(rows[0]!).getByText('2')).toBeTruthy();
    expect(within(rows[0]!).getByText(/^3d/)).toBeTruthy();
    expect(within(rows[0]!).getByRole('link', { name: 'Support queue' }).getAttribute('href')).toBe(
      '/admin/support?kind=refund_request',
    );
    expect(within(rows[1]!).getByText('Billing provider events that failed')).toBeTruthy();
    // Failed provider events have no console: the row says so instead of linking to a page that
    // does not list them.
    expect(within(rows[1]!).getByText(/No provider-event console in this build/)).toBeTruthy();
    expect(within(rows[1]!).queryByRole('link')).toBeNull();
    expect(within(rows[2]!).getByText('Open support cases: Complaint')).toBeTruthy();
    expect(within(rows[3]!).getByText('Production readiness checks blocked')).toBeTruthy();
    expect(
      within(rows[3]!).getByRole('link', { name: 'Readiness checks (below)' }).getAttribute('href'),
    ).toBe('#readiness');
    // Zero rules say "None" and rules without a console say so instead of linking.
    const jobs = rows.find((r) => within(r).queryByText(/Jobs failed/))!;
    expect(within(jobs).getByText('None')).toBeTruthy();
    expect(within(jobs).getByText(/No job console in this build/)).toBeTruthy();
    expect(within(jobs).queryByRole('link')).toBeNull();
    const safety = rows.find((r) => within(r).queryByText(/Child safety reports/))!;
    expect(within(safety).getByText(/no owner console shows a report’s content/)).toBeTruthy();
    // Every row names its source table.
    expect(within(table).getAllByText(/^Source:/)).toHaveLength(11);
  });

  it('draws the six-month net revenue chart to scale from real values with a table beside it', async () => {
    renderPage(<AdminHomePage />, { api: api() });
    const chart = await screen.findByRole('img', { name: /Net revenue by month, 6 months/ });
    const data = overview().revenue.months;
    // Every month is labelled with its (truncated, never rounded up) net value and its name.
    for (const m of data) {
      expect(chart.textContent).toContain(compactUsd(m.totals.netCents));
    }
    expect(chart.textContent).toContain('Sep 26');
    expect(chart.textContent).toContain('Apr 26');
    // Columns exist only for non-zero months, and heights follow the values.
    const paths = chart.querySelectorAll('path');
    expect(paths).toHaveLength(5);
    const heights = [...paths].map((p) => {
      const d = p.getAttribute('d')!;
      const [, base] = /^M[\d.]+,([\d.]+)/.exec(d)!;
      const [, tip] = /V([\d.]+)/.exec(d)!;
      return Number(base) - Number(tip);
    });
    const nets = data.filter((m) => m.totals.netCents !== 0).map((m) => m.totals.netCents);
    const biggest = nets.indexOf(Math.max(...nets));
    expect(heights[biggest]).toBe(Math.max(...heights));
    expect(paths[0]!.getAttribute('fill')).toBe('var(--teal)');
    const table = screen.getByRole('table', { name: 'Revenue by month' });
    expect(within(table).getAllByRole('row')).toHaveLength(7);
    expect(within(table).getByText('September 2026')).toBeTruthy();
    expect(within(table).getByText('$7,998.00')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Channel breakdown, subscriptions and fee rates' }),
    ).toBeTruthy();
    expect(screen.getByText(/Stripe’s per-transaction fee is not modelled/)).toBeTruthy();
  });

  it('shows subscriptions by every channel the contract knows, by slots and churn', async () => {
    renderPage(<AdminHomePage />, { api: api() });
    const byChannel = await screen.findByRole('table', { name: 'Active subscriptions by channel' });
    const rows = within(byChannel).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual([
      'App Store',
      'Google Play',
      'Web billing (Stripe)',
      'Amazon Appstore',
    ]);
    expect(within(rows[3]!).getByText('0')).toBeTruthy();
    const bySlots = screen.getByRole('table', { name: 'Active subscriptions by paid slots' });
    expect(within(bySlots).getByText('25')).toBeTruthy();
    expect(screen.getByText(/churn 5\.71%/)).toBeTruthy();
    // Promo, school and P16 lines.
    expect(screen.getByText('confirmed 3 · expired 1')).toBeTruthy();
    expect(screen.getByText('$120.00')).toBeTruthy();
  });

  it('keeps the readiness checks last with blocked items visible, and links every console', async () => {
    renderPage(<AdminHomePage />, { api: api() });
    const table = await screen.findByRole('table', { name: /Production readiness/ });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(within(rows[1]!).getByText('Parental consent provider')).toBeTruthy();
    expect(within(rows[1]!).getByText(/Blocked/)).toBeTruthy();
    expect(within(rows[3]!).getByText(/Ready/)).toBeTruthy();
    expect(screen.getByText(/2 of 3 checks are blocked/)).toBeTruthy();
    expect(screen.getByText('development')).toBeTruthy();
    expect(document.getElementById('readiness')).toBeTruthy();
    const consoles = screen.getByRole('region', { name: 'Consoles' });
    for (const name of [
      'Support',
      'Subscriptions and revenue',
      'Promotions',
      'Schools and payouts',
      'Monetization',
    ]) {
      expect(within(consoles).getByRole('link', { name })).toBeTruthy();
    }
    expect(screen.getAllByRole('link', { name: 'Support' }).length).toBeGreaterThan(1);
  });

  it('is complete at rest: honest empty states when the company has no numbers yet', async () => {
    const empty = overview({
      revenue: {
        ...overview().revenue,
        months: ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map((m) =>
          month(m),
        ),
      },
      subscriptions: { ...overview().subscriptions, byPaidSlots: [], byStatus: [] },
      promoRedemptions: { ...overview().promoRedemptions, byState: [] },
      aiSpend: {
        ...overview().aiSpend,
        budgetMicros: null,
        budgetCents: null,
        percentOfCap: null,
        spentMicros: '0',
        spentCents: 0,
      },
      attention: overview().attention.map((i) => ({
        ...i,
        count: 0,
        oldestAt: null,
        oldestAgeHours: null,
      })),
    });
    renderPage(<AdminHomePage />, { api: api(empty) });
    expect(await screen.findByText(/No charged billing periods in the last 6 months/)).toBeTruthy();
    expect(screen.queryByRole('img', { name: /Net revenue/ })).toBeNull();
    expect(screen.getByText('No active subscriptions yet.')).toBeTruthy();
    expect(screen.getByText('No redemptions yet')).toBeTruthy();
    expect(screen.getByText('Nothing needs a person right now', { exact: false })).toBeTruthy();
    expect(within(tile('AI spend vs cap')).getByText(/No cap set for this month/)).toBeTruthy();
    expect(within(tile('Open support cases')).getByText('None open')).toBeTruthy();
    const attention = screen.getByRole('table', { name: 'Needs attention' });
    expect(within(attention).getAllByText('None')).toHaveLength(11);
  });
});
