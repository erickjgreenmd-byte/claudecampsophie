import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  channelSchema,
  type OverviewResponse,
  type RevenueMonth,
  type RevenueResponse,
  type StoreFeeRatesResponse,
  type SubscriptionsSummary,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import RevenueAdminPage, { parsePercent, percentInput } from './RevenueAdminPage.tsx';

// Synthetic company numbers only.

afterEach(() => {
  cleanup();
});

const AT = '2026-09-25T12:00:00.000Z';
type Channel = z.infer<typeof channelSchema>;
const CHANNELS = channelSchema.options;

function metric(value: number, source = 'public.family_entitlements', definition = 'Rows.') {
  return { value, source, definition };
}

function line(channel: Channel, gross = 0, refunds = 0, feeRateBasisPoints = 3000) {
  const storeFeeCents = Math.floor(((gross - refunds) * feeRateBasisPoints) / 10_000);
  return {
    channel,
    periods: gross > 0 ? 2 : 0,
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
  const channels = CHANNELS.map((c) =>
    line(c, ...(amounts[c] ?? [0, 0]), c === 'stripe' ? 0 : 3000),
  );
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

function revenue(months: RevenueMonth[]): RevenueResponse {
  return {
    asOf: AT,
    months,
    feeRates: { app_store: 0.3, play_store: 0.3, stripe: 0, amazon_appstore: 0.3 },
    notes: ['Store fees are an estimate.', 'Stripe’s per-transaction fee is not modelled.'],
    source: 'public.billing_periods',
    definition: 'Charged periods bucketed by the UTC month of settlement.',
  };
}

const sixMonths = [
  month('2026-04'),
  month('2026-05', { app_store: [399_900, 0] }),
  month('2026-06', { app_store: [399_900, 0], play_store: [99_900, 0] }),
  month('2026-07', { app_store: [799_800, 39_990] }),
  month('2026-08', { play_store: [499_900, 0], stripe: [3_999, 0] }),
  month('2026-09', { app_store: [799_800, 3_999], play_store: [499_900, 0], stripe: [3_999, 0] }),
];

const feeRates: StoreFeeRatesResponse = {
  rates: { app_store: 0.3, play_store: 0.3, stripe: 0, amazon_appstore: 0.3 },
  updatedAt: null,
  updatedBy: null,
  notes: ['Store fees are an estimate.', 'Stripe’s per-transaction fee is not modelled.'],
};

const subscriptions: SubscriptionsSummary = {
  asOf: AT,
  month: '2026-09',
  active: metric(37),
  subscribedFamilies: metric(35),
  byChannel: [
    { channel: 'app_store', count: 20 },
    { channel: 'play_store', count: 12 },
    { channel: 'stripe', count: 5 },
    { channel: 'amazon_appstore', count: 0 },
  ],
  byPaidSlots: [{ paidSlots: 1, count: 37 }],
  byStatus: [
    { status: 'active', count: 37 },
    { status: 'billing_retry', count: 1 },
  ],
  newThisMonth: metric(4),
  lapsedThisMonth: metric(2),
  activeAtMonthStart: metric(35),
  churn: { basisPoints: 571, source: 'public.family_entitlements', definition: 'lapsed ÷ base.' },
};

const overview: OverviewResponse = {
  asOf: AT,
  month: '2026-09',
  families: {
    total: metric(42, 'public.families'),
    newThisMonth: metric(5, 'public.families'),
    activeChildrenWithPaidSlots: metric(31, 'public.child_slot_assignments'),
  },
  subscriptions,
  revenue: revenue(sixMonths),
  promoRedemptions: {
    byState: [{ state: 'confirmed', count: 3 }],
    thisMonth: metric(1, 'public.promo_redemptions', 'Created this month.'),
    source: 'public.promo_redemptions',
    definition: 'By state.',
  },
  schoolContributions: {
    accruedCents: {
      cents: 12_000,
      source: 'public.school_contribution_accruals',
      definition: 'Accrued.',
    },
    paidOutCents: { cents: 2_500, source: 'public.payout_batches', definition: 'Paid.' },
  },
  monetization: {
    recognizedThisMonthCents: { cents: 0, source: 'public.revenue_entries', definition: 'P16.' },
  },
  aiSpend: {
    month: '2026-09',
    spentMicros: '0',
    budgetMicros: null,
    spentCents: 0,
    budgetCents: null,
    percentOfCap: null,
    source: 'public.ai_usage_events',
    definition: 'Spend.',
  },
  attention: [],
  readiness: { blocked: [], source: 'readiness', definition: 'Blocked checks.' },
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}
type Responder = (call: Call) => unknown;

function fakeApi(routes: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const defaults: Record<string, unknown> = {
    'GET /v1/admin/revenue': revenue(sixMonths),
    'GET /v1/admin/settings/store-fee-rates': feeRates,
    'GET /v1/admin/subscriptions': subscriptions,
    'GET /v1/admin/overview': overview,
  };
  const table = { ...defaults, ...routes };
  const respond = (call: Call): unknown => {
    const key = `${call.method} ${call.path.split('?')[0]}`;
    if (!(key in table)) return new Error(`unexpected ${key}`);
    const value = table[key];
    return typeof value === 'function' ? (value as Responder)(call) : value;
  };
  const settle = <S extends z.ZodType>(call: Call, schema: S) => {
    calls.push(call);
    try {
      const value = respond(call);
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(schema.parse(value));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const api: Partial<ApiClient> = {
    get: (path, schema) => settle({ method: 'GET', path, body: undefined }, schema),
    send: (method, path, body, schema) => settle({ method, path, body }, schema),
  };
  const sent = () => calls.filter((c) => c.method !== 'GET');
  const revenueCalls = () => calls.filter((c) => c.path.startsWith('/v1/admin/revenue'));
  return { api, calls, sent, revenueCalls };
}

describe('percent helpers', () => {
  it('turn fractions into percent text without rounding up, and back', () => {
    expect(percentInput(0.3)).toBe('30');
    expect(percentInput(0)).toBe('0');
    expect(percentInput(0.1525)).toBe('15.25');
    expect(percentInput(0.155)).toBe('15.5');
    expect(parsePercent('30')).toBe(0.3);
    expect(parsePercent('15.5')).toBe(0.155);
    expect(parsePercent('0')).toBe(0);
    expect(parsePercent('100')).toBe(1);
    expect(parsePercent('101')).toBeNull();
    expect(parsePercent('1.234')).toBeNull();
    expect(parsePercent('abc')).toBeNull();
    expect(parsePercent('-1')).toBeNull();
  });
});

describe('RevenueAdminPage access', () => {
  it('shows only the MFA-required state when the owner session is refused', async () => {
    const { api } = fakeApi({
      'GET /v1/admin/revenue': new ApiRequestError(
        'FORBIDDEN',
        'Owner administration requires an MFA session',
        403,
      ),
    });
    renderPage(<RevenueAdminPage />, { api });
    expect(await screen.findByText(/Owner administration requires an MFA session/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('form')).toBeNull();
  });
});

describe('RevenueAdminPage months × channels', () => {
  it('renders one line per channel per month with fee rate, fee and net, and a totals row', async () => {
    const { api, revenueCalls } = fakeApi();
    renderPage(<RevenueAdminPage />, { api });
    const table = await screen.findByRole('table', { name: 'Revenue by month and channel' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(6 * (CHANNELS.length + 1));
    expect(within(table).getAllByText('September 2026')).toHaveLength(1);
    const september = rows.slice(-(CHANNELS.length + 1));
    expect(within(september[0]!).getByText('App Store')).toBeTruthy();
    expect(within(september[0]!).getByText('$7,998.00')).toBeTruthy();
    expect(within(september[0]!).getByText('$39.99')).toBeTruthy();
    expect(within(september[0]!).getByText('30.00%')).toBeTruthy();
    expect(within(september[2]!).getByText('Web billing (Stripe)')).toBeTruthy();
    expect(within(september[2]!).getByText('0.00%')).toBeTruthy();
    expect(within(september[3]!).getByText('Amazon Appstore')).toBeTruthy();
    expect(within(september[4]!).getByText('All channels')).toBeTruthy();
    const totals = sixMonths[5]!.totals;
    expect(
      within(september[4]!).getByText(
        `$${(totals.netCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
      ),
    ).toBeTruthy();
    expect(screen.getByRole('img', { name: /Net revenue by month/ })).toBeTruthy();
    expect(
      screen.getAllByText('Stripe’s per-transaction fee is not modelled.').length,
    ).toBeGreaterThan(0);
    expect(revenueCalls()[0]!.path).toBe('/v1/admin/revenue?months=6');
    await userEvent.selectOptions(screen.getByLabelText('Months to show'), '12');
    await waitFor(() => expect(revenueCalls()).toHaveLength(2));
    expect(revenueCalls()[1]!.path).toBe('/v1/admin/revenue?months=12');
  });

  it('shows an honest empty state when nothing was charged', async () => {
    const { api } = fakeApi({
      'GET /v1/admin/revenue': revenue(['2026-08', '2026-09'].map((m) => month(m))),
    });
    renderPage(<RevenueAdminPage />, { api });
    expect(await screen.findByText(/No charged billing periods in the last 2 months/)).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Revenue by month and channel' })).toBeNull();
    expect(screen.queryByRole('img', { name: /Net revenue/ })).toBeNull();
  });

  it('shows subscriptions by channel, slots and ledger status plus the promo and school lines', async () => {
    const { api } = fakeApi();
    renderPage(<RevenueAdminPage />, { api });
    const statuses = await screen.findByRole('table', { name: 'Subscription rows by status' });
    expect(within(statuses).getByText('Billing retry')).toBeTruthy();
    const byChannel = screen.getByRole('table', { name: 'Active subscriptions by channel' });
    expect(within(byChannel).getAllByRole('row')).toHaveLength(CHANNELS.length + 1);
    expect(screen.getByText(/churn 5\.71%/)).toBeTruthy();
    expect(await screen.findByText('School contributions paid out')).toBeTruthy();
    expect(screen.getByText('$25.00')).toBeTruthy();
    expect(screen.getByText('confirmed 3')).toBeTruthy();
  });
});

describe('Store fee rates', () => {
  it('prefills every channel, validates, PUTs the fractions and reloads the revenue table', async () => {
    let current: StoreFeeRatesResponse = feeRates;
    const { api, sent, revenueCalls } = fakeApi({
      'GET /v1/admin/settings/store-fee-rates': () => current,
      'PUT /v1/admin/settings/store-fee-rates': (call: Call) => {
        current = {
          ...feeRates,
          rates: (call.body as { rates: StoreFeeRatesResponse['rates'] }).rates,
          updatedAt: AT,
          updatedBy: '7a8b9c0d-1111-4aaa-8bbb-00000000000a',
        };
        return current;
      },
    });
    renderPage(<RevenueAdminPage />, { api });
    const form = await screen.findByRole('form', { name: 'Store fee rates' });
    expect(within(form).getByLabelText('App Store fee (%)').getAttribute('value')).toBe('30');
    expect(within(form).getByLabelText('Web billing (Stripe) fee (%)').getAttribute('value')).toBe(
      '0',
    );
    expect(within(form).getByLabelText('Amazon Appstore fee (%)').getAttribute('value')).toBe('30');
    const play = within(form).getByLabelText('Google Play fee (%)');
    await userEvent.clear(play);
    await userEvent.type(play, '101');
    await userEvent.click(within(form).getByRole('button', { name: 'Save fee rates' }));
    expect(
      await within(form).findByText('Enter a percent from 0 to 100 with at most two decimals.'),
    ).toBeTruthy();
    expect(sent()).toHaveLength(0);
    await userEvent.clear(play);
    await userEvent.type(play, '15.5');
    await userEvent.click(within(form).getByRole('button', { name: 'Save fee rates' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({
      method: 'PUT',
      path: '/v1/admin/settings/store-fee-rates',
      body: { rates: { app_store: 0.3, play_store: 0.155, stripe: 0, amazon_appstore: 0.3 } },
    });
    expect(await screen.findByText(/Fee rates saved/)).toBeTruthy();
    await waitFor(() => expect(revenueCalls().length).toBeGreaterThanOrEqual(2));
    expect(
      await screen.findByText(/Last changed Sep 25, 2026, 12:00 UTC by 7a8b9c0d/),
    ).toBeTruthy();
    expect(within(form).getByLabelText('Google Play fee (%)').getAttribute('value')).toBe('15.5');
  });
});
