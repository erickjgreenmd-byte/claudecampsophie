import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { BillingStatus, FamilyOverview } from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import ChildrenPage from './ChildrenPage.tsx';
import SchoolAndPromotionsPage from './SchoolAndPromotionsPage.tsx';
import SubscriptionPage from './SubscriptionPage.tsx';

/**
 * WEB-R1-04: the Amazon Appstore (Fire tablets) is a real billing channel. The signed-in portal names
 * it wherever it names a store, shows its price column and lets an Amazon-billed family pick it.
 *
 * WEB-R1-06: until the in-app offer step ships, the portal never claims a redemption path it does
 * not have: School and promotions says up front that codes are only previewed, the Subscription
 * page no longer invites parents to "enter" a code, and "PencilLift web billing" is not offered
 * while web billing is disabled.
 */

// Synthetic data only.
const FAMILY = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const PERIOD_END = '2026-10-10T12:00:00.000Z';
const RENEWAL = '2026-10-15T12:00:00.000Z';

afterEach(cleanup);

function api(get: (path: string) => unknown, send?: (path: string) => unknown): Partial<ApiClient> {
  const settle = <S extends z.ZodType>(value: unknown, schema: S) => {
    try {
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(schema.parse(value));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  return {
    get: <S extends z.ZodType>(path: string, schema: S) => settle(get(path), schema),
    send: <S extends z.ZodType>(
      _method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      _body: unknown,
      schema: S,
    ) => settle(send ? send(path) : new Error(`unexpected send ${path}`), schema),
  };
}

function amazonStatus(): BillingStatus {
  return {
    billingRef: 'fam_0123456789abcdef01234567',
    paidSlots: 1,
    assignedSlots: 1,
    managingChannel: 'amazon_appstore',
    conflict: null,
    pendingChange: null,
    requestedChange: null,
    entitlements: [
      {
        channel: 'amazon_appstore',
        productId: 'pl_family_1',
        paidSlots: 1,
        status: 'active',
        periodEnd: PERIOD_END,
        autoRenew: true,
      },
    ],
    products: [
      {
        channel: 'amazon_appstore',
        productId: 'pl_family_1',
        paidSlots: 1,
        storePriceCents: 3999,
        priceCheck: 'matches_approved',
      },
    ],
    tiers: [
      { paidSlots: 1, approvedMonthlyCents: 3999 },
      { paidSlots: 2, approvedMonthlyCents: 4998 },
      { paidSlots: 3, approvedMonthlyCents: 5997 },
      { paidSlots: 4, approvedMonthlyCents: 6996 },
    ],
  };
}

describe('WEB-R1-04 SubscriptionPage names the Amazon Appstore', () => {
  it('shows an Amazon Appstore price column and no web-billing column', async () => {
    renderPage(<SubscriptionPage />, { api: api(() => amazonStatus()) });
    const prices = await screen.findByRole('region', { name: 'Prices' });
    const headers = within(prices)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual([
      'Children',
      'Approved price',
      'App Store price',
      'Google Play price',
      'Amazon Appstore price',
    ]);
    const one = within(prices).getByRole('row', { name: /^1 child/ });
    expect(
      within(one)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['$39.99', 'Not verified yet', 'Not verified yet', '$39.99']);
  });

  it('says plans are sold and cancelled through every store, including the Amazon Appstore', async () => {
    renderPage(<SubscriptionPage />, { api: api(() => amazonStatus()) });
    const plan = await screen.findByRole('region', { name: 'Your plan' });
    expect(within(plan).getByText('Billed by').nextElementSibling?.textContent).toBe(
      'Amazon Appstore',
    );
    const changing = screen.getByRole('region', { name: 'Changing your plan' });
    const text = changing.textContent ?? '';
    expect(text).toMatch(
      /sold through the App Store, Google Play and, on Fire tablets, the Amazon Appstore/,
    );
    expect(text).toMatch(/the store that bills you \(App Store, Google Play or Amazon Appstore\)/);
    expect(text).not.toMatch(/sold through the App Store and Google Play\./);
  });

  it('WEB-R1-06: no longer invites the parent to enter a promo code it cannot redeem', async () => {
    renderPage(<SubscriptionPage />, { api: api(() => amazonStatus()) });
    const changing = await screen.findByRole('region', { name: 'Changing your plan' });
    expect(changing.textContent).not.toMatch(/Have a monthly promo code\? Enter it/);
    expect(within(changing).queryByRole('link', { name: 'School and promotions' })).toBeNull();
  });
});

describe('WEB-R1-04 ChildrenPage names the Amazon Appstore', () => {
  it('says new slots are bought through the App Store, Google Play or the Amazon Appstore', async () => {
    const overview: FamilyOverview = {
      id: FAMILY,
      displayName: 'Test Family',
      timezone: 'America/Chicago',
      paidSlots: 1,
      billingConflict: null,
      managingChannel: 'amazon_appstore',
      children: [
        { id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' },
      ],
    };
    renderPage(<ChildrenPage />, { api: api(() => overview) });
    const slots = await screen.findByRole('region', { name: 'Paid child slots' });
    expect(slots.textContent).toMatch(
      /bought in the PencilLift app through the App Store, Google Play or the Amazon Appstore/,
    );
  });
});

function promoApi() {
  return api(
    (path) => {
      if (path === '/v1/family/school')
        return {
          current: null,
          pending: null,
          programTimezone: 'America/Chicago',
          contributionIsPencilLiftFunded: true,
        };
      if (path === '/v1/family/promotions') return { redemptions: [] };
      return new Error(`unexpected GET ${path}`);
    },
    () => ({
      campaignMonth: '2026-10',
      percentOff: 50,
      channel: 'amazon_appstore',
      targetPeriod: { kind: 'renewal_period', periodStart: RENEWAL, isProjection: true },
      regularCents: 3999,
      discountCents: 2000,
      chargedCents: 1999,
      nextRegularRenewalCents: 3999,
      isPreview: true,
    }),
  );
}

describe('WEB-R1-04 / WEB-R1-06 School and promotions store choice', () => {
  it('offers the App Store, Google Play and the Amazon Appstore, and not web billing while it is off', async () => {
    renderPage(<SchoolAndPromotionsPage />, { api: promoApi() });
    const group = await screen.findByRole('group', { name: 'Where is your subscription billed?' });
    const radios = within(group)
      .getAllByRole('radio')
      .map((r) => r.closest('label')!.textContent);
    expect(radios).toEqual([
      'App Store (iPhone or iPad)',
      'Google Play (Android)',
      'Amazon Appstore (Fire tablet)',
    ]);
    expect(screen.queryByRole('radio', { name: /web billing/i })).toBeNull();
  });

  it('says up front that codes are previewed here and used in the app once that step exists', async () => {
    renderPage(<SchoolAndPromotionsPage />, { api: promoApi() });
    const promo = await screen.findByRole('region', { name: 'Monthly promo code' });
    const notice = within(promo).getByRole('note');
    expect(notice.textContent).toMatch(/previewed here/i);
    expect(notice.textContent).toMatch(/used in the PencilLift app/i);
    expect(notice.textContent).toMatch(/isn’t available yet/);
    expect(screen.getByRole('heading', { level: 1 }).nextElementSibling?.textContent).toMatch(
      /preview this month’s PencilLift promo code/,
    );
  });

  it('an Amazon-billed family can preview a code for its own store', async () => {
    const user = userEvent.setup();
    renderPage(<SchoolAndPromotionsPage />, { api: promoApi() });
    await user.type(await screen.findByLabelText(/^Promo code$/i), 'ABCDE-FGHJK-X');
    await user.click(screen.getByRole('radio', { name: /Amazon Appstore/ }));
    await user.click(screen.getByRole('button', { name: /Check code/i }));
    const card = await screen.findByRole('region', { name: 'Your code preview' });
    expect(
      within(card).getByText(/Amazon Appstore codes are redeemed inside the PencilLift app/),
    ).toBeTruthy();
    expect(within(card).queryByRole('button', { name: /Redeem code/ })).toBeNull();
  });

  it('offers web billing only when web billing is enabled', async () => {
    renderPage(<SchoolAndPromotionsPage webBillingEnabled />, { api: promoApi() });
    expect(await screen.findByRole('radio', { name: /PencilLift web billing/ })).toBeTruthy();
  });
});
