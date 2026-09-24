import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  campaignSummarySchema,
  type generationPreviewResponseSchema,
  type promoTemplateSchema,
} from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import PromotionsAdminPage from './PromotionsAdminPage.tsx';
import { emptyTemplateForm, validateTemplateForm } from './components/template-form.ts';

/**
 * Independent adversarial review of the p17-ui vertical (owner promotions console).
 * Synthetic data only; the fake API passes every response through the real contract schemas,
 * exactly like the production client does.
 */

const TEMPLATE = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const CAMPAIGN = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const AT = '2026-09-20T15:00:00.000Z';

type Template = z.infer<typeof promoTemplateSchema>;
type Campaign = z.infer<typeof campaignSummarySchema>;
type Preview = z.infer<typeof generationPreviewResponseSchema>;

function template(overrides: Partial<Template> = {}): Template {
  return {
    id: TEMPLATE,
    name: 'Back to school',
    schoolId: null,
    percentOff: 5,
    eligibleTiers: [1, 2],
    subscriberEligibility: ['new', 'existing'],
    redemptionCap: 500,
    budgetCapCents: 1_000_000,
    calendarTimezone: 'UTC',
    timezoneConfirmed: true,
    windowStartDay: 1,
    windowEndDay: 'end_of_month',
    codeMode: 'shared',
    channels: ['app_store', 'play_store'],
    enabled: true,
    paused: false,
    createdAt: AT,
    ...overrides,
  };
}

function campaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: CAMPAIGN,
    templateId: TEMPLATE,
    campaignMonth: '2026-10',
    status: 'active',
    percentOff: 5,
    schoolId: null,
    opensAt: '2026-10-01T00:00:00.000Z',
    closesAt: '2026-11-01T00:00:00.000Z',
    redemptionCap: 500,
    liveRedemptions: 3,
    confirmedRedemptions: 1,
    budgetCapCents: 1_000_000,
    committedDiscountCents: 600,
    offerMappings: [
      {
        channel: 'play_store',
        paidSlots: 2,
        status: 'ready',
        providerOfferId: 'play_offer_oct_t2',
        reason: null,
      },
    ],
    ...overrides,
  };
}

const emptyPreview: Preview = { month: '2026-10', items: [] };

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeApi(options: { campaigns?: Campaign[]; send?: (call: Call) => unknown } = {}) {
  const sends: Call[] = [];
  const get = (path: string): unknown => {
    if (path === '/v1/admin/promo-templates') return { templates: [template()] };
    if (path === '/v1/admin/schools') return { schools: [] };
    if (path.startsWith('/v1/admin/promo-generation/preview')) return emptyPreview;
    if (path.startsWith('/v1/admin/campaigns?')) return { campaigns: options.campaigns ?? [] };
    return new Error(`unexpected GET ${path}`);
  };
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      try {
        const value = get(path);
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
        const value = options.send?.(call) ?? { ok: true };
        if (value instanceof Error) return Promise.reject(value);
        return Promise.resolve(schema.parse(value));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
  return { api, sends };
}

afterEach(() => {
  cleanup();
});

async function openMonth(month = '2026-10') {
  fireEvent.change(await screen.findByLabelText('Campaign month'), { target: { value: month } });
}

describe('[RV-p17-ui-1] a paused, revoked or ended campaign is not advertised as redeemable', () => {
  // Spec P17: "never advertise a code as usable until its channel mapping is ready"; the card's
  // own status line says the codes are no longer valid, so "Redeemable on" contradicts it.
  it.each([
    ['revoked', /Revoked – codes no longer valid/],
    ['paused', /Paused – no new redemptions/],
    ['ended', /Ended/],
  ] as const)(
    '[RV-p17-ui-1] a %s campaign with a ready store mapping does not say "Redeemable on"',
    async (status, statusText) => {
      const { api } = fakeApi({ campaigns: [campaign({ status })] });
      renderPage(<PromotionsAdminPage />, { api });
      await openMonth();
      const card = await screen.findByRole('article', { name: /Back to school · 5% off/ });
      expect(within(card).getByText(statusText)).toBeTruthy();
      expect(within(card).queryByText(/Redeemable on/)).toBeNull();
    },
  );
});

describe('[RV-p17-ui-2] the console only accepts budgets a generated campaign can carry', () => {
  // The template contract has no upper bound, but every generated campaign is returned through
  // campaignSummarySchema.budgetCapCents (centsSchema, max 10,000,000 cents). A template budget
  // the form accepts must therefore be displayable in the campaign list, or the whole month's
  // campaign section (with its pause/revoke controls) fails to load.
  it('[RV-p17-ui-2] a $150,000 budget is either rejected by the form or representable as a campaign budget', () => {
    const result = validateTemplateForm({
      ...emptyTemplateForm(),
      name: 'Big October',
      percentOff: '100',
      eligibleTiers: [1],
      subscriberEligibility: ['existing'],
      redemptionCap: '3000',
      budgetDollars: '150000',
      timezoneConfirmed: true,
      channels: ['play_store'],
    });
    const representable =
      result.ok &&
      campaignSummarySchema.shape.budgetCapCents.safeParse(result.input.budgetCapCents).success;
    expect(result.ok === false || representable).toBe(true);
  });

  // The bound is the contract's MAX_PROMO_BUDGET_CENTS ($1,000,000.00), shared by the template
  // input and every campaign listing; the lead raised it from the $100,000 price-sized cap, so the
  // over-limit value moved from $150,000 to $1,500,000 (same intent: never send an unlistable budget).
  it('[RV-p17-ui-2] the create form refuses a budget above the campaign budget bound before sending anything', async () => {
    const { api, sends } = fakeApi({ send: () => template({ budgetCapCents: 150_000_000 }) });
    renderPage(<PromotionsAdminPage />, { api });
    await userEvent.click(await screen.findByRole('button', { name: 'New template' }));
    const form = await screen.findByRole('form', { name: 'New template' });
    const w = within(form);
    await userEvent.type(w.getByLabelText('Template name'), 'Big October');
    await userEvent.type(w.getByLabelText(/Discount percent/), '100');
    await userEvent.click(w.getByRole('checkbox', { name: /^1 child/ }));
    await userEvent.click(w.getByRole('checkbox', { name: /Existing subscribers/ }));
    await userEvent.type(w.getByLabelText(/Redemption cap/), '3000');
    await userEvent.type(w.getByLabelText(/Budget cap/), '1500000');
    await userEvent.click(w.getByRole('checkbox', { name: /Google Play/ }));
    await userEvent.click(
      w.getByRole('checkbox', { name: /I confirm campaign months follow UTC/ }),
    );
    await userEvent.click(w.getByRole('button', { name: 'Create template' }));
    // Give a (wrong) submission time to happen.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sends.map((s) => (s.body as { budgetCapCents?: number }).budgetCapCents)).toEqual([]);
  });
});

describe('[RV-p17-ui-5] a non-price-point App Store cell cannot be left pending', () => {
  // Every generated campaign starts with a `pending` row for every channel × tier (see
  // apps/api/tests/admin-promotions.test.ts). 5% off $49.98 = $47.48 is not an App Store price
  // point, so the owner must record it as unsupported with a reason (spec P17: "expose a precise
  // unavailable status"; task: "Apple percentages that are not price points must be marked
  // unsupported with a reason").
  it('[RV-p17-ui-5] saving the editor unchanged does not store a blocked App Store cell as pending', async () => {
    const { api, sends } = fakeApi({
      campaigns: [
        campaign({
          status: 'provisioning',
          offerMappings: [
            {
              channel: 'app_store',
              paidSlots: 2,
              status: 'pending',
              providerOfferId: null,
              reason: null,
            },
          ],
        }),
      ],
    });
    renderPage(<PromotionsAdminPage />, { api });
    await openMonth();
    const card = await screen.findByRole('article', { name: /Back to school · 5% off/ });
    await userEvent.click(within(card).getByRole('button', { name: 'Edit App Store, 2 children' }));
    const editor = await within(card).findByRole('form', {
      name: 'Offer mapping: App Store, 2 children',
    });
    expect(within(editor).getByText(/\$47\.48 .*not an App Store price point/)).toBeTruthy();
    await userEvent.click(within(editor).getByRole('button', { name: 'Save mapping' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stored = sends.filter(
      (s) => s.method === 'PUT' && (s.body as { status?: string }).status !== 'unsupported',
    );
    expect(stored).toEqual([]);
  });
});

describe('[RV-p17-ui-7] confirmation prompts keep keyboard focus (AC_UX_01)', () => {
  it('[RV-p17-ui-7] opening the pause confirmation moves focus into the prompt instead of dropping it', async () => {
    const { api } = fakeApi({ campaigns: [campaign()] });
    renderPage(<PromotionsAdminPage />, { api });
    await openMonth();
    const card = await screen.findByRole('article', { name: /Back to school · 5% off/ });
    const pause = within(card).getByRole('button', { name: 'Pause campaign' });
    pause.focus();
    await userEvent.keyboard('{Enter}');
    const confirm = await within(card).findByRole('button', { name: /Yes, pause/ });
    const prompt = confirm.closest('[role="group"]');
    expect(prompt).toBeTruthy();
    expect(document.activeElement).not.toBe(document.body);
    expect(prompt!.contains(document.activeElement)).toBe(true);
  });
});
