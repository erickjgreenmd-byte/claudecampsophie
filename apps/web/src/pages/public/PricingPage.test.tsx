import { cleanup, screen, within } from '@testing-library/react';
import { priceTable } from '@pencillift/domain/pricing';
import { formatUsd } from '@pencillift/domain/shared/money';
import { afterEach, describe, expect, it } from 'vitest';
import { renderPage } from '../../test/render.tsx';
import PricingPage from './PricingPage.tsx';

afterEach(cleanup);

async function renderPricing() {
  const view = renderPage(<PricingPage />, { path: '/pricing' });
  await screen.findByRole('heading', { level: 1, name: 'Pricing' });
  return view;
}

describe('PricingPage (spec P11, P17, AC_CAPACITY_11)', () => {
  it('renders exactly the four approved monthly prices from the domain price table', async () => {
    await renderPricing();
    const table = screen.getByRole('table', { name: /monthly price by number of children/i });
    const [header, ...rows] = within(table).getAllByRole('row');
    expect(
      within(header!)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual(['Children', 'Monthly price']);

    const expected = priceTable().map((tier) => formatUsd(tier.cents));
    // The domain table is the source; this cross-checks it still matches the owner-approved totals.
    expect(expected).toEqual(['$39.99', '$49.98', '$59.97', '$69.96']);
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
      '1 child',
      '2 children',
      '3 children',
      '4 children',
    ]);
    expect(rows.map((row) => within(row).getByRole('cell').textContent)).toEqual(expected);
  });

  it('explains $9.99 per additional child and never says $9.99 for the first child', async () => {
    const { container } = await renderPricing();
    const text = container.textContent;
    expect(text).toMatch(/\$39\.99 per month includes your first child/);
    expect(text).toMatch(/each additional child is \$9\.99 per month/i);
    expect(text).not.toMatch(/\$9\.99 for the first child/i);
    expect(text).not.toMatch(/first child[^.]{0,20}\$9\.99/i);
    expect(text).toMatch(/no separate family account fee/i);
  });

  it('states USD, store-provided checkout amounts, and that plans are not yet purchasable', async () => {
    const { container } = await renderPricing();
    const text = container.textContent;
    expect(text).toMatch(/US dollars/);
    expect(text).toMatch(/App Store/);
    expect(text).toMatch(/Google Play/);
    expect(text).toMatch(/may differ by storefront/i);
    expect(text).toMatch(/not yet available for purchase/i);
    expect(text).toMatch(/children can.t make purchases/i);
    // Honest state (AC_UX_02): nothing on the page pretends to start a purchase.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('link', { name: /buy|subscribe|start|checkout/i })).toBeNull();
  });

  it('describes the school contribution as PencilLift-funded, full-price only, and not tax-deductible', async () => {
    await renderPricing();
    const section = screen.getByRole('region', { name: /supporting your school/i });
    const text = section.textContent;
    expect(text).toMatch(/one school/i);
    expect(text).toMatch(/full regular price with no discount/i);
    expect(text).toMatch(/PencilLift contributes \$1 to that school/);
    expect(text).toMatch(/funded by PencilLift/i);
    expect(text).toMatch(/not a customer donation/i);
    expect(text).toMatch(/not tax-deductible for your family/i);
    expect(text).toMatch(/any discount or promotion/i);
  });

  it('points parents to store cancellation instead of implying account deletion cancels billing', async () => {
    await renderPricing();
    expect(screen.getByText(/deleting your PencilLift account doesn.t cancel/i)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: /how to delete your account/i }).getAttribute('href'),
    ).toBe('/account-deletion');
  });
});
