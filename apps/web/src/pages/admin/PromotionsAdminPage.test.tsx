import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  channelSchema,
  type campaignSummarySchema,
  type generationPreviewResponseSchema,
  type promoTemplateSchema,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import { CHANNEL_LABEL } from './components/template-form.ts';
import PromotionsAdminPage from './PromotionsAdminPage.tsx';

// Synthetic data only.
const TEMPLATE = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const CAMPAIGN = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const SCHOOL = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const CODE_ID = '9c4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b';
const AT = '2026-09-20T15:00:00.000Z';

type Template = z.infer<typeof promoTemplateSchema>;
type Campaign = z.infer<typeof campaignSummarySchema>;
type Preview = z.infer<typeof generationPreviewResponseSchema>;

function template(overrides: Partial<Template> = {}): Template {
  return {
    id: TEMPLATE,
    name: 'Back to school',
    schoolId: null,
    percentOff: 50,
    eligibleTiers: [1, 2],
    subscriberEligibility: ['new', 'existing'],
    redemptionCap: 500,
    budgetCapCents: 1_000_000,
    calendarTimezone: 'America/Chicago',
    timezoneConfirmed: true,
    windowStartDay: 1,
    windowEndDay: 'end_of_month',
    codeMode: 'shared',
    channels: ['app_store', 'stripe'],
    enabled: false,
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
    opensAt: '2026-10-01T05:00:00.000Z',
    closesAt: '2026-11-01T05:00:00.000Z',
    redemptionCap: 500,
    liveRedemptions: 120,
    confirmedRedemptions: 80,
    budgetCapCents: 1_000_000,
    committedDiscountCents: 25_000,
    offerMappings: [
      {
        channel: 'stripe',
        paidSlots: 2,
        status: 'ready',
        providerOfferId: 'promo_oct_t2',
        reason: null,
      },
    ],
    ...overrides,
  };
}

const preview: Preview = {
  month: '2026-10',
  items: [
    {
      templateId: TEMPLATE,
      templateName: 'Back to school',
      generationKey: `${TEMPLATE}:2026-10`,
      percentOff: 50,
      opensAt: '2026-10-01T05:00:00.000Z',
      closesAt: '2026-11-01T05:00:00.000Z',
      codeCount: 1,
      alreadyGenerated: false,
    },
  ],
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeApi(
  options: {
    templates?: Template[];
    campaigns?: Campaign[];
    get?: (path: string) => unknown;
    send?: (call: Call) => unknown;
  } = {},
) {
  const gets: string[] = [];
  const sends: Call[] = [];
  const defaultGet = (path: string): unknown => {
    if (path === '/v1/admin/promo-templates')
      return { templates: options.templates ?? [template()] };
    if (path === '/v1/admin/schools') {
      return {
        schools: [
          {
            id: SCHOOL,
            name: 'Maple Grove Elementary',
            city: null,
            region: null,
            status: 'active',
            recipientVerified: false,
          },
        ],
      };
    }
    if (path.startsWith('/v1/admin/promo-generation/preview')) return preview;
    if (path.startsWith('/v1/admin/campaigns?'))
      return { campaigns: options.campaigns ?? [campaign()] };
    if (path === `/v1/admin/campaigns/${CAMPAIGN}/codes`) {
      return {
        campaignId: CAMPAIGN,
        codes: [{ id: CODE_ID, code: 'ABCDE-FGHJK-X', usageCap: null, status: 'active' }],
      };
    }
    return new Error(`unexpected GET ${path}`);
  };
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      gets.push(path);
      try {
        const value = options.get?.(path) ?? defaultGet(path);
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

afterEach(() => {
  cleanup();
});

async function openNewTemplateForm() {
  await userEvent.click(await screen.findByRole('button', { name: 'New template' }));
  return screen.findByRole('form', { name: 'New template' });
}

async function fillValidTemplate(form: HTMLElement) {
  const w = within(form);
  await userEvent.type(w.getByLabelText('Template name'), 'October families');
  await userEvent.type(w.getByLabelText(/Discount percent/), '25');
  await userEvent.click(w.getByRole('checkbox', { name: /^1 child/ }));
  await userEvent.click(w.getByRole('checkbox', { name: /^2 children/ }));
  await userEvent.click(w.getByRole('checkbox', { name: /Existing subscribers/ }));
  await userEvent.type(w.getByLabelText(/Redemption cap/), '300');
  await userEvent.type(w.getByLabelText(/Budget cap/), '2500.50');
  await userEvent.click(w.getByRole('checkbox', { name: /Google Play/ }));
  await userEvent.click(w.getByRole('checkbox', { name: /I confirm campaign months follow UTC/ }));
}

async function chooseMonth(month: string) {
  fireEvent.change(await screen.findByLabelText('Campaign month'), { target: { value: month } });
}

describe('PromotionsAdminPage — access (spec P17 administration, P14)', () => {
  it('shows the MFA requirement and nothing else when the API refuses', async () => {
    const { api } = fakeApi({
      get: () =>
        new ApiRequestError('FORBIDDEN', 'Owner administration requires an MFA session', 403),
    });
    renderPage(<PromotionsAdminPage />, { api });
    expect(await screen.findByText(/Owner administration requires an MFA session/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New template' })).toBeNull();
    expect(screen.queryByLabelText('Campaign month')).toBeNull();
  });
});

describe('PromotionsAdminPage — templates', () => {
  it('lists templates with their visible timezone, caps and status', async () => {
    const { api } = fakeApi();
    renderPage(<PromotionsAdminPage />, { api });
    const card = await screen.findByRole('article', { name: 'Back to school' });
    expect(within(card).getByText(/Draft – not generating/)).toBeTruthy();
    expect(within(card).getByText(/America\/Chicago \(confirmed\)/)).toBeTruthy();
    expect(within(card).getByText('500 redemptions')).toBeTruthy();
    expect(within(card).getByText('$10,000.00')).toBeTruthy();
  });

  it('validates the form against the contract ranges before sending anything', async () => {
    const { api, sends } = fakeApi();
    renderPage(<PromotionsAdminPage />, { api });
    const form = await openNewTemplateForm();
    const w = within(form);
    await userEvent.type(w.getByLabelText(/Discount percent/), '3');
    await userEvent.type(w.getByLabelText(/Budget cap/), '-5');
    await userEvent.click(w.getByRole('button', { name: 'Create template' }));
    expect(await w.findByText('Enter a name (up to 120 characters).')).toBeTruthy();
    expect(w.getByText('Discount must be a whole percentage from 5 to 100.')).toBeTruthy();
    expect(w.getByText('Choose at least one plan size.')).toBeTruthy();
    expect(w.getByText('Choose at least one subscriber group.')).toBeTruthy();
    expect(w.getByText('Enter a positive whole number of redemptions.')).toBeTruthy();
    expect(w.getByText(/Enter a positive dollar amount/)).toBeTruthy();
    expect(w.getByText('Choose at least one billing channel.')).toBeTruthy();
    expect(sends).toHaveLength(0);
  });

  it('creates a template with integer cents and an explicit timezone confirmation', async () => {
    const { api, sends } = fakeApi({
      send: () => template({ id: TEMPLATE, name: 'October families' }),
    });
    renderPage(<PromotionsAdminPage />, { api });
    const form = await openNewTemplateForm();
    await fillValidTemplate(form);
    // Discount preview per selected plan size.
    expect(within(form).getByText(/2 children: \$49\.98 → \$37\.49/)).toBeTruthy();
    await userEvent.click(within(form).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      method: 'POST',
      path: '/v1/admin/promo-templates',
      body: {
        name: 'October families',
        schoolId: null,
        percentOff: 25,
        eligibleTiers: [1, 2],
        subscriberEligibility: ['existing'],
        redemptionCap: 300,
        budgetCapCents: 250_050,
        calendarTimezone: 'UTC',
        timezoneConfirmed: true,
        windowStartDay: 1,
        windowEndDay: 'end_of_month',
        codeMode: 'shared',
        channels: ['play_store'],
      },
    });
    expect(await screen.findByText(/Template saved as a draft/)).toBeTruthy();
  });

  it('clears the timezone confirmation whenever the timezone changes', async () => {
    const { api } = fakeApi();
    renderPage(<PromotionsAdminPage />, { api });
    const form = await openNewTemplateForm();
    const confirm = within(form).getByRole('checkbox', {
      name: /I confirm campaign months follow UTC/,
    });
    await userEvent.click(confirm);
    expect((confirm as HTMLInputElement).checked).toBe(true);
    const zone = within(form).getByLabelText(/Calendar timezone/);
    await userEvent.clear(zone);
    await userEvent.type(zone, 'America/New_York');
    const again = within(form).getByRole('checkbox', {
      name: /I confirm campaign months follow America\/New_York/,
    });
    expect((again as HTMLInputElement).checked).toBe(false);
  });

  it('rejects an unknown timezone', async () => {
    const { api, sends } = fakeApi();
    renderPage(<PromotionsAdminPage />, { api });
    const form = await openNewTemplateForm();
    await fillValidTemplate(form);
    const zone = within(form).getByLabelText(/Calendar timezone/);
    await userEvent.clear(zone);
    await userEvent.type(zone, 'Mars/Olympus');
    await userEvent.click(within(form).getByRole('button', { name: 'Create template' }));
    expect(await within(form).findByText(/valid IANA timezone/)).toBeTruthy();
    expect(sends).toHaveLength(0);
  });

  it('shows activation problems as readable reasons', async () => {
    const { api, sends } = fakeApi({
      send: () => ({ ok: false, problems: ['TIMEZONE_NOT_CONFIRMED', 'MISSING_BUDGET_CAP'] }),
    });
    renderPage(<PromotionsAdminPage />, { api });
    const card = await screen.findByRole('article', { name: 'Back to school' });
    await userEvent.click(within(card).getByRole('button', { name: /Activate/ }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.path).toBe(`/v1/admin/promo-templates/${TEMPLATE}/activate`);
    const problems = await within(card).findByRole('list', { name: 'Activation problems' });
    expect(within(problems).getByText(/Confirm the calendar timezone/)).toBeTruthy();
    expect(within(problems).getByText(/budget cap/i)).toBeTruthy();
  });
});

describe('PromotionsAdminPage — monthly generation and campaigns', () => {
  it('previews a month and generates only after confirmation', async () => {
    const { api, gets, sends } = fakeApi({
      send: () => ({
        month: '2026-10',
        created: [{ campaignId: CAMPAIGN, generationKey: `${TEMPLATE}:2026-10`, codeCount: 1 }],
        skippedExisting: [],
      }),
    });
    renderPage(<PromotionsAdminPage />, { api });
    await chooseMonth('2026-10');
    await waitFor(() => expect(gets).toContain('/v1/admin/promo-generation/preview?month=2026-10'));
    const section = screen.getByRole('region', { name: 'Monthly generation' });
    expect(await within(section).findByText('Will be generated')).toBeTruthy();
    await userEvent.click(within(section).getByRole('button', { name: /Generate October 2026/ }));
    expect(sends).toHaveLength(0);
    await userEvent.click(within(section).getByRole('button', { name: /Yes, generate/ }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      method: 'POST',
      path: '/v1/admin/promo-generation/run',
      body: { month: '2026-10' },
    });
    expect(await within(section).findByText(/Created 1 campaign/)).toBeTruthy();
  });

  it('shows cap and budget usage and asks before pausing', async () => {
    const { api, sends } = fakeApi({ send: () => ({ ok: true }) });
    renderPage(<PromotionsAdminPage />, { api });
    await chooseMonth('2026-10');
    const card = await screen.findByRole('article', { name: /Back to school · 5% off/ });
    expect(within(card).getByText(/120 of 500 redemptions \(80 confirmed\)/)).toBeTruthy();
    expect(
      within(card).getByText(/\$250\.00 of \$10,000\.00 discount budget committed/),
    ).toBeTruthy();
    expect(within(card).getByText(/Status: Active/)).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: 'Pause campaign' }));
    expect(sends).toHaveLength(0);
    await userEvent.click(within(card).getByRole('button', { name: /Yes, pause/ }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      method: 'POST',
      path: `/v1/admin/campaigns/${CAMPAIGN}/action`,
      body: { action: 'pause' },
    });
  });

  it('warns when no channel is ready so the code is not advertised', async () => {
    const { api } = fakeApi({ campaigns: [campaign({ offerMappings: [] })] });
    renderPage(<PromotionsAdminPage />, { api });
    await chooseMonth('2026-10');
    const card = await screen.findByRole('article', { name: /Back to school · 5% off/ });
    expect(within(card).getByText(/Not redeemable on any store yet/)).toBeTruthy();
  });

  it('forces an unsupported App Store mapping with a reason when the price is not a price point', async () => {
    const { api, sends } = fakeApi({ send: () => ({ ok: true }) });
    renderPage(<PromotionsAdminPage />, { api });
    await chooseMonth('2026-10');
    const card = await screen.findByRole('article', { name: /Back to school · 5% off/ });
    await userEvent.click(within(card).getByRole('button', { name: 'Edit App Store, 2 children' }));
    const editor = await within(card).findByRole('form', {
      name: 'Offer mapping: App Store, 2 children',
    });
    const e = within(editor);
    expect(e.getByText(/\$47\.48 .*not an App Store price point/)).toBeTruthy();
    const ready = e.getByRole<HTMLOptionElement>('option', { name: /Ready/ });
    expect(ready.disabled).toBe(true);
    await userEvent.selectOptions(e.getByLabelText('Status'), 'unsupported');
    await userEvent.click(e.getByRole('button', { name: 'Save mapping' }));
    expect(await e.findByText(/Explain why this mapping is unsupported/)).toBeTruthy();
    expect(sends).toHaveLength(0);
    await userEvent.click(e.getByRole('button', { name: 'Use suggested reason' }));
    await userEvent.click(e.getByRole('button', { name: 'Save mapping' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.method).toBe('PUT');
    expect(sends[0]!.path).toBe(`/v1/admin/campaigns/${CAMPAIGN}/offer-mappings`);
    expect(sends[0]!.body).toEqual({
      channel: 'app_store',
      paidSlots: 2,
      status: 'unsupported',
      providerOfferId: null,
      reason: expect.stringMatching(/\$47\.48 .*not an App Store price point/),
    });
  });

  it('requires a provider offer id for a ready mapping', async () => {
    const { api, sends } = fakeApi({ send: () => ({ ok: true }) });
    renderPage(<PromotionsAdminPage />, { api });
    await chooseMonth('2026-10');
    const card = await screen.findByRole('article', { name: /Back to school · 5% off/ });
    await userEvent.click(within(card).getByRole('button', { name: 'Edit Google Play, 1 child' }));
    const editor = await within(card).findByRole('form', {
      name: 'Offer mapping: Google Play, 1 child',
    });
    await userEvent.selectOptions(within(editor).getByLabelText('Status'), 'ready');
    await userEvent.click(within(editor).getByRole('button', { name: 'Save mapping' }));
    expect(await within(editor).findByText(/Enter the provider offer id/)).toBeTruthy();
    expect(sends).toHaveLength(0);
  });

  it('shows the codes of a campaign on request', async () => {
    const { api, gets } = fakeApi();
    renderPage(<PromotionsAdminPage />, { api });
    await chooseMonth('2026-10');
    const card = await screen.findByRole('article', { name: /Back to school · 5% off/ });
    await userEvent.click(within(card).getByRole('button', { name: 'Show codes' }));
    expect(await within(card).findByText('ABCDE-FGHJK-X')).toBeTruthy();
    expect(gets).toContain(`/v1/admin/campaigns/${CAMPAIGN}/codes`);
    expect(within(card).getByText(/recorded in the audit log/)).toBeTruthy();
  });
});

describe('PromotionsAdminPage — review fixes (RV-p17-ui-3, RV-p17-ui-7)', () => {
  async function openEdit() {
    const card = await screen.findByRole('article', { name: 'Back to school' });
    await userEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    return screen.findByRole('form', { name: 'Edit Back to school' });
  }

  it('switches a saved individual-code template to one shared code in place', async () => {
    const { api, sends } = fakeApi({
      templates: [template({ codeMode: 'individual', individualCodeCount: 100 })],
    });
    renderPage(<PromotionsAdminPage />, { api });
    const form = await openEdit();
    const w = within(form);
    await userEvent.click(w.getByRole('radio', { name: 'One shared code for the audience' }));
    await userEvent.click(w.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    const body = sends[0]!.body as { codeMode?: string; individualCodeCount?: number };
    expect(sends[0]!.method).toBe('PATCH');
    expect(body.codeMode).toBe('shared');
    expect(body.individualCodeCount).toBeUndefined();
  });

  it('clears a saved shared-code usage cap in place', async () => {
    const { api, sends } = fakeApi({ templates: [template({ sharedCodeUsageCap: 50 })] });
    renderPage(<PromotionsAdminPage />, { api });
    const form = await openEdit();
    const w = within(form);
    await userEvent.clear(w.getByLabelText(/Shared code usage cap/));
    await userEvent.click(w.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    const body = sends[0]!.body as { codeMode?: string; sharedCodeUsageCap?: number };
    expect(body.codeMode).toBe('shared');
    expect(body.sharedCodeUsageCap).toBeUndefined();
  });

  it('reports a value the server kept instead of saying "Template updated."', async () => {
    const { api, sends } = fakeApi({
      templates: [template({ sharedCodeUsageCap: 50 })],
      // The (synthetic) server stores the edit but keeps the old usage cap.
      send: (call) => ({
        ...template({ sharedCodeUsageCap: 50 }),
        ...(call.body as object),
        sharedCodeUsageCap: 50,
      }),
    });
    renderPage(<PromotionsAdminPage />, { api });
    const form = await openEdit();
    const cap = within(form).getByLabelText(/Shared code usage cap/);
    await userEvent.clear(cap);
    await userEvent.type(cap, '75');
    await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.method).toBe('PATCH');
    expect((sends[0]!.body as { sharedCodeUsageCap?: number }).sharedCodeUsageCap).toBe(75);
    expect(
      await screen.findByText(/server kept different values for: shared code usage cap/),
    ).toBeTruthy();
    expect(screen.queryByText('Template updated.')).toBeNull();
  });

  it('returns focus to the action button when a confirmation is cancelled', async () => {
    const { api, sends } = fakeApi();
    renderPage(<PromotionsAdminPage />, { api });
    await chooseMonth('2026-10');
    const card = await screen.findByRole('article', { name: /Back to school · 5% off/ });
    within(card).getByRole('button', { name: 'Pause campaign' }).focus();
    await userEvent.keyboard('{Enter}');
    const confirm = await within(card).findByRole('button', { name: /Yes, pause/ });
    expect(document.activeElement).toBe(confirm);
    await userEvent.tab();
    expect(document.activeElement).toBe(within(card).getByRole('button', { name: 'Cancel' }));
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(card).getByRole('button', { name: 'Pause campaign' }),
      ),
    );
    expect(sends).toHaveLength(0);
  });
});

describe('PromotionsAdminPage — Amazon Appstore in promo campaigns (R2C-WEB-2)', () => {
  it('offers every billing channel from channelSchema, the Amazon Appstore included', async () => {
    const { api } = fakeApi();
    renderPage(<PromotionsAdminPage />, { api });
    const form = await openNewTemplateForm();
    const group = within(form).getByRole('group', { name: 'Billing channels' });
    expect(
      within(group)
        .getAllByRole('checkbox')
        .map((box) => box.closest('label')?.textContent),
    ).toEqual(channelSchema.options.map((channel) => CHANNEL_LABEL[channel]));
  });

  it('creates a campaign template that targets the Amazon Appstore', async () => {
    const { api, sends } = fakeApi({
      send: () =>
        template({ name: 'October families', channels: ['play_store', 'amazon_appstore'] }),
    });
    renderPage(<PromotionsAdminPage />, { api });
    const form = await openNewTemplateForm();
    await fillValidTemplate(form);
    await userEvent.click(
      within(form).getByRole('checkbox', { name: 'Amazon Appstore (no store codes)' }),
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.method).toBe('POST');
    expect((sends[0]!.body as { channels: string[] }).channels).toEqual([
      'play_store',
      'amazon_appstore',
    ]);
  });

  it('keeps the Amazon Appstore when a saved Amazon template is edited', async () => {
    const saved = template({ channels: ['app_store', 'amazon_appstore'] });
    const { api, sends } = fakeApi({
      templates: [saved],
      send: (call) => ({ ...saved, ...(call.body as object) }),
    });
    renderPage(<PromotionsAdminPage />, { api });
    const card = await screen.findByRole('article', { name: 'Back to school' });
    await userEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    const form = await screen.findByRole('form', { name: 'Edit Back to school' });
    const amazon = within(form).getByRole('checkbox', { name: 'Amazon Appstore (no store codes)' });
    expect((amazon as HTMLInputElement).checked).toBe(true);
    await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.method).toBe('PATCH');
    expect((sends[0]!.body as { channels: string[] }).channels).toEqual([
      'app_store',
      'amazon_appstore',
    ]);
    expect(await screen.findByText('Template updated.')).toBeTruthy();
  });
});
