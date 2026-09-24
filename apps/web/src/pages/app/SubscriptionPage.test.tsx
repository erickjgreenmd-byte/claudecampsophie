import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { BillingStatus } from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { unconfiguredAuth } from '../../lib/auth.ts';
import { renderPage } from '../../test/render.tsx';
import SubscriptionPage from './SubscriptionPage.tsx';

// Synthetic data only. Mid-day UTC dates so the calendar date is stable in every runner timezone.
const PERIOD_END = '2026-10-10T12:00:00.000Z';

const TIERS = [
  { paidSlots: 1, approvedMonthlyCents: 3999 },
  { paidSlots: 2, approvedMonthlyCents: 4998 },
  { paidSlots: 3, approvedMonthlyCents: 5997 },
  { paidSlots: 4, approvedMonthlyCents: 6996 },
];

function status(overrides: Partial<BillingStatus> = {}): BillingStatus {
  return {
    billingRef: 'fam_0123456789abcdef01234567',
    paidSlots: 2,
    assignedSlots: 1,
    managingChannel: 'app_store',
    conflict: null,
    pendingChange: null,
    requestedChange: null,
    entitlements: [
      {
        channel: 'app_store',
        productId: 'pl_family_2',
        paidSlots: 2,
        status: 'active',
        periodEnd: PERIOD_END,
        autoRenew: true,
      },
    ],
    products: [
      {
        channel: 'app_store',
        productId: 'pl_family_1',
        paidSlots: 1,
        storePriceCents: 3999,
        priceCheck: 'matches_approved',
      },
      {
        channel: 'app_store',
        productId: 'pl_family_2',
        paidSlots: 2,
        storePriceCents: 4999,
        priceCheck: 'differs_from_approved',
      },
      {
        channel: 'play_store',
        productId: 'pl_family_2',
        paidSlots: 2,
        storePriceCents: 4998,
        priceCheck: 'matches_approved',
      },
    ],
    tiers: TIERS,
    ...overrides,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Fake API that validates fixtures and responses through the real contract schemas. */
function fakeApi(options: { get?: () => unknown; send?: (call: Call) => unknown } = {}) {
  const gets: string[] = [];
  const sends: Call[] = [];
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      gets.push(path);
      try {
        const value = options.get ? options.get() : status();
        if (value instanceof Error) return Promise.reject(value);
        return Promise.resolve(schema.parse(value));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    send: <S extends z.ZodType>(
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      body: unknown,
      schema: S,
    ) => {
      const call = { method, path, body };
      sends.push(call);
      try {
        const value = options.send?.(call);
        if (value instanceof Error) return Promise.reject(value);
        return Promise.resolve(schema.parse(value));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
  return { api, gets, sends };
}

// Vitest globals are off, so Testing Library cannot register its automatic cleanup.
afterEach(() => {
  cleanup();
});

describe('SubscriptionPage (spec P11, P14 subscription)', () => {
  it('shows verified paid slots, assigned children, the managing store and store subscriptions', async () => {
    const { api, gets } = fakeApi();
    renderPage(<SubscriptionPage />, { api });
    const plan = await screen.findByRole('region', { name: 'Your plan' });
    expect(gets).toEqual(['/v1/billing/status']);
    expect(within(plan).getByText(/Your plan covers 2 children/)).toBeTruthy();
    // The store's charge is named; the approved price is never presented as it (RV-billing-4).
    expect(
      within(plan).getByText(
        /App Store charges \$49\.99 per month, which differs from PencilLift’s approved price of \$49\.98/,
      ),
    ).toBeTruthy();
    expect(within(plan).getByText('Paid child slots').nextElementSibling?.textContent).toBe('2');
    expect(within(plan).getByText('Children using a slot').nextElementSibling?.textContent).toBe(
      '1',
    );
    expect(within(plan).getByText('Billed by').nextElementSibling?.textContent).toBe('App Store');
    expect(within(plan).getByText(/1 unused paid slot/)).toBeTruthy();
    expect(within(plan).getByRole('link', { name: 'Children' }).getAttribute('href')).toBe(
      '/app/children',
    );

    const subs = screen.getByRole('region', { name: 'Store subscriptions' });
    const row = within(subs).getByRole('row', { name: /App Store/ });
    expect(within(row).getByText('2 children')).toBeTruthy();
    expect(within(row).getByText('Active')).toBeTruthy();
    expect(within(row).getByText('October 10, 2026')).toBeTruthy();
    expect(within(row).getByText('On')).toBeTruthy();
    // The opaque billing ref is for the app's store login, never displayed.
    expect(document.body.textContent).not.toContain('fam_0123456789abcdef01234567');
  });

  it('warns about duplicate subscriptions and explains pending store changes', async () => {
    const { api } = fakeApi({
      get: () =>
        status({
          conflict: 'duplicate_active_subscriptions',
          pendingChange: { targetSlots: 1, effectiveAt: PERIOD_END },
          requestedChange: {
            kind: 'downgrade',
            toSlots: 1,
            status: 'scheduled',
            keepCount: 1,
            createdAt: '2026-09-20T15:00:00.000Z',
          },
        }),
    });
    renderPage(<SubscriptionPage />, { api });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/more than one active subscription.*charged twice/);
    expect(
      screen.getByText(/The store will change your plan to 1 child on October 10, 2026/),
    ).toBeTruthy();
    expect(screen.getByText(/You chose 1 child with 1 child staying active/)).toBeTruthy();
  });

  it('shows the approved price table and store prices that differ, never rounded silently', async () => {
    const { api } = fakeApi();
    renderPage(<SubscriptionPage />, { api });
    const prices = await screen.findByRole('region', { name: 'Prices' });
    const rows = within(prices).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual([
      '$39.99',
      '$49.98',
      '$59.97',
      '$69.96',
    ]);
    const two = within(prices).getByRole('row', { name: /^2 children/ });
    // Approved | App Store (differs, stated) | Google Play (exact).
    expect(
      within(two)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual([
      '$49.98',
      '$49.99 (differs from the approved $49.98, so this plan isn’t sold there)',
      '$49.98',
    ]);
    const three = within(prices).getByRole('row', { name: /^3 children/ });
    expect(within(three).getAllByText('Not verified yet')).toHaveLength(2);
    expect(within(prices).getByText(/no separate family account fee/)).toBeTruthy();
  });

  it('a verified store price equal to the approved price is shown as the monthly price', async () => {
    const { api } = fakeApi({
      get: () =>
        status({
          managingChannel: 'play_store',
          entitlements: [
            {
              channel: 'play_store',
              productId: 'pl_family_2',
              paidSlots: 2,
              status: 'active',
              periodEnd: PERIOD_END,
              autoRenew: true,
            },
          ],
        }),
    });
    renderPage(<SubscriptionPage />, { api });
    const plan = await screen.findByRole('region', { name: 'Your plan' });
    expect(within(plan).getByText(/^\(\$49\.98 per month\)\.$/)).toBeTruthy();
    expect(plan.textContent).not.toMatch(/differs/);
  });

  it.each([
    ['billing_retry', /Paid access is paused\..*still retrying.*charged twice/],
    ['pending', /No paid access yet\..*waiting for approval.*charged twice/],
  ] as const)(
    'a %s subscription is never shown as “no subscription” (RV-billing-5)',
    async (storeStatus, message) => {
      const { api } = fakeApi({
        get: () =>
          status({
            paidSlots: 0,
            assignedSlots: 0,
            managingChannel: null,
            entitlements: [
              {
                channel: 'app_store',
                productId: 'pl_family_2',
                paidSlots: 2,
                status: storeStatus,
                periodEnd: PERIOD_END,
                autoRenew: true,
              },
            ],
          }),
      });
      renderPage(<SubscriptionPage />, { api });
      const plan = await screen.findByRole('region', { name: 'Your plan' });
      expect(plan.textContent).toMatch(message);
      expect(plan.textContent).not.toMatch(/No active subscription/);
    },
  );

  it('offers no purchase on the web, explains the stores, and links to promo codes', async () => {
    const { api } = fakeApi();
    renderPage(<SubscriptionPage />, { api });
    const changing = await screen.findByRole('region', { name: 'Changing your plan' });
    expect(within(changing).getByText(/can’t be bought on the web/)).toBeTruthy();
    expect(within(changing).getByText(/Ask to Buy/)).toBeTruthy();
    expect(within(changing).getByText(/doesn’t cancel a store subscription/)).toBeTruthy();
    expect(
      within(changing).getByRole('link', { name: 'School and promotions' }).getAttribute('href'),
    ).toBe('/app/school');
    expect(
      screen.queryByRole('button', { name: /buy|subscribe|purchase|upgrade|checkout/i }),
    ).toBeNull();
  });

  it('“Check with the store” asks the server to sync and shows the verified result', async () => {
    const { api, sends } = fakeApi({
      get: () =>
        status({ paidSlots: 0, assignedSlots: 0, managingChannel: null, entitlements: [] }),
      send: () => status({ paidSlots: 3, assignedSlots: 1 }),
    });
    renderPage(<SubscriptionPage />, { api });
    expect(await screen.findByText(/No active subscription/)).toBeTruthy();
    expect(screen.getByText('No store subscriptions yet.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Check with the store' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({ method: 'POST', path: '/v1/billing/sync', body: undefined });
    expect(await screen.findByText(/Your plan covers 3 children/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/Checked with the store/);
  });

  it('a sync failure is shown and changes nothing', async () => {
    const { api } = fakeApi({
      send: () =>
        new ApiRequestError('RATE_LIMITED', 'Too many attempts. Please wait and try again.', 429),
    });
    renderPage(<SubscriptionPage />, { api });
    await userEvent.click(await screen.findByRole('button', { name: 'Check with the store' }));
    expect(await screen.findByText('Too many attempts. Please wait and try again.')).toBeTruthy();
    expect(screen.getByText(/Your plan covers 2 children/)).toBeTruthy();
  });

  it('explains a missing family and shows retryable errors', async () => {
    const missing = fakeApi({ get: () => new ApiRequestError('NOT_FOUND', 'Create family', 404) });
    renderPage(<SubscriptionPage />, { api: missing.api });
    expect(await screen.findByRole('heading', { name: 'Create your family first' })).toBeTruthy();
    cleanup();
    const broken = fakeApi({
      get: () => new ApiRequestError('PROVIDER_UNAVAILABLE', 'Service unavailable', 503),
    });
    renderPage(<SubscriptionPage />, { api: broken.api });
    expect(await screen.findByText('Service unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('never renders billing details without a signed-in parent', async () => {
    const { api, gets } = fakeApi();
    renderPage(<SubscriptionPage />, { api, auth: unconfiguredAuth });
    expect(await screen.findByText(/Parent sign-in isn’t available yet/)).toBeTruthy();
    expect(gets).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Your plan' })).toBeNull();
  });
});
