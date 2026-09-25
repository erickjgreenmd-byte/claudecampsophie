import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  familyPromotionsResponseSchema,
  familySchoolResponseSchema,
  promoQuoteResponseSchema,
  promoRedemptionSchema,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import SchoolAndPromotionsPage from './SchoolAndPromotionsPage.tsx';

// Synthetic data only. School names are invented.
const MAPLE = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const CEDAR = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const REDEMPTION = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const OLDER = '9c4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b';
const AT = '2026-09-20T15:00:00.000Z';
// Mid-day UTC so the calendar date is the same in every test-runner timezone from UTC-11 to UTC+11.
const RENEWAL = '2026-10-15T12:00:00.000Z';
const CODE = 'ABCDE-FGHJK-X';

type FamilySchool = z.infer<typeof familySchoolResponseSchema>;
type Quote = z.infer<typeof promoQuoteResponseSchema>;
type Redemption = z.infer<typeof promoRedemptionSchema>;
type History = z.infer<typeof familyPromotionsResponseSchema>;

const maple = { id: MAPLE, name: 'Maple Grove Elementary', city: 'Springfield', region: 'IL' };
const cedar = { id: CEDAR, name: 'Cedar Park Middle', city: null, region: null };

function school(overrides: Partial<FamilySchool> = {}): FamilySchool {
  return {
    current: maple,
    pending: null,
    programTimezone: 'America/Chicago',
    contributionIsPencilLiftFunded: true,
    ...overrides,
  };
}

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    campaignMonth: '2026-10',
    percentOff: 50,
    channel: 'app_store',
    targetPeriod: { kind: 'renewal_period', periodStart: RENEWAL, isProjection: true },
    regularCents: 4998,
    discountCents: 2499,
    chargedCents: 2499,
    nextRegularRenewalCents: 4998,
    isPreview: true,
    ...overrides,
  };
}

function redemption(overrides: Partial<Redemption> = {}): Redemption {
  return {
    id: REDEMPTION,
    campaignMonth: '2026-10',
    channel: 'app_store',
    state: 'provider_pending',
    percentOff: 50,
    regularCents: 4998,
    discountCents: 2499,
    chargedCents: 2499,
    targetPeriodStart: RENEWAL,
    createdAt: AT,
    nextAction: { kind: 'await_provider' },
    ...overrides,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Fake API that validates fixtures and responses through the real contract schemas. */
function fakeApi(
  options: {
    get?: (path: string) => unknown;
    send?: (call: Call) => unknown;
    familySchool?: FamilySchool;
    history?: History;
  } = {},
) {
  const gets: string[] = [];
  const sends: Call[] = [];
  const defaultGet = (path: string): unknown => {
    if (path === '/v1/family/school') return options.familySchool ?? school();
    if (path === '/v1/family/promotions') return options.history ?? { redemptions: [] };
    if (path.startsWith('/v1/schools')) return { schools: [maple, cedar] };
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

const rule = (code: string, message = 'Server wording') =>
  new ApiRequestError('BUSINESS_RULE', message, 422, code);

async function enterCode(code = CODE, store: RegExp = /App Store/) {
  const input = await screen.findByLabelText(/^Promo code$/i);
  await userEvent.clear(input);
  await userEvent.type(input, code);
  await userEvent.click(screen.getByRole('radio', { name: store }));
  await userEvent.click(screen.getByRole('button', { name: /Check code/i }));
}

describe('SchoolAndPromotionsPage — school designation (spec P17, AC_PROMO_14)', () => {
  it('shows the current school, the one-school rule and the PencilLift-funded contribution copy', async () => {
    const { api } = fakeApi();
    renderPage(<SchoolAndPromotionsPage />, { api });
    expect(await screen.findByRole('heading', { name: 'School and promotions' })).toBeTruthy();
    const yours = await screen.findByRole('region', { name: 'Your school' });
    expect(await within(yours).findByText(/Maple Grove Elementary/)).toBeTruthy();
    expect(within(yours).getByText(/One school per family/i)).toBeTruthy();
    expect(within(yours).getByText(/a change starts next month/i)).toBeTruthy();
    expect(within(yours).getByText(/America\/Chicago/)).toBeTruthy();
    const how = screen.getByRole('region', { name: 'How the school contribution works' });
    expect(
      within(how).getByText(
        /PencilLift contributes \$1\/month for each month your family pays full price/i,
      ),
    ).toBeTruthy();
    // Discounted months, however small the discount, contribute $0.
    expect(within(how).getByText(/any code, 5%–100%\) contribute \$0/i)).toBeTruthy();
    expect(within(how).getByText(/not a tax-deductible donation/i)).toBeTruthy();
  });

  it('shows a pending change with the month it takes effect and lets the parent keep the current school', async () => {
    const { api, sends } = fakeApi({
      familySchool: school({ pending: { school: cedar, effectiveFromMonth: '2026-10' } }),
      send: () => school(),
    });
    renderPage(<SchoolAndPromotionsPage />, { api });
    const yours = await screen.findByRole('region', { name: 'Your school' });
    expect(await within(yours).findByText(/Cedar Park Middle/)).toBeTruthy();
    expect(within(yours).getByText(/from October 1, 2026/)).toBeTruthy();
    await userEvent.click(
      within(yours).getByRole('button', { name: /Keep Maple Grove Elementary/ }),
    );
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      method: 'PUT',
      path: '/v1/family/school',
      body: { schoolId: MAPLE },
    });
    expect(await within(yours).findByText(/Maple Grove Elementary stays your school/)).toBeTruthy();
  });

  it('says no contribution is made until a school is chosen', async () => {
    const { api } = fakeApi({ familySchool: school({ current: null }) });
    renderPage(<SchoolAndPromotionsPage />, { api });
    const yours = await screen.findByRole('region', { name: 'Your school' });
    expect(await within(yours).findByText(/No school chosen yet/)).toBeTruthy();
    expect(within(yours).getByText(/no school contribution/i)).toBeTruthy();
  });

  it('searches schools and saves only the school id, then shows when the change starts', async () => {
    const { api, gets, sends } = fakeApi({
      send: () => school({ pending: { school: cedar, effectiveFromMonth: '2026-10' } }),
    });
    renderPage(<SchoolAndPromotionsPage />, { api });
    await userEvent.type(await screen.findByLabelText(/Find your school/i), 'cedar park');
    await userEvent.click(screen.getByRole('button', { name: /^Search$/ }));
    await waitFor(() => expect(gets).toContain('/v1/schools?query=cedar%20park'));
    const results = await screen.findByRole('list', { name: 'School search results' });
    await userEvent.click(
      within(results).getByRole('button', { name: /Choose Cedar Park Middle/ }),
    );
    // Confirmation explains the next-month rule before anything is saved.
    expect(sends).toHaveLength(0);
    expect(screen.getByText(/starts on the first day of next month/i)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Confirm Cedar Park Middle/ }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      method: 'PUT',
      path: '/v1/family/school',
      body: { schoolId: CEDAR },
    });
    expect(
      await screen.findByText(/Cedar Park Middle becomes your school on October 1, 2026/),
    ).toBeTruthy();
  });

  it('shows an empty search result honestly', async () => {
    const { api } = fakeApi({
      get: (path) => (path.startsWith('/v1/schools') ? { schools: [] } : undefined),
    });
    renderPage(<SchoolAndPromotionsPage />, { api });
    await userEvent.type(await screen.findByLabelText(/Find your school/i), 'zzz');
    await userEvent.click(screen.getByRole('button', { name: /^Search$/ }));
    expect(await screen.findByText(/No schools match “zzz”/)).toBeTruthy();
  });

  it('says a first school choice is now the family’s school, starting this month (RV-p17-ui-8)', async () => {
    const { api } = fakeApi({
      familySchool: school({ current: null }),
      send: () => school({ current: cedar }),
    });
    renderPage(<SchoolAndPromotionsPage />, { api });
    await userEvent.type(await screen.findByLabelText(/Find your school/i), 'cedar');
    await userEvent.click(screen.getByRole('button', { name: /^Search$/ }));
    const results = await screen.findByRole('list', { name: 'School search results' });
    await userEvent.click(
      within(results).getByRole('button', { name: /Choose Cedar Park Middle/ }),
    );
    expect(screen.getByText(/it applies from this month/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Confirm Cedar Park Middle/ }));
    expect(
      await screen.findByText(
        'Saved. Cedar Park Middle is now your school, starting this month (America/Chicago time).',
      ),
    ).toBeTruthy();
  });

  it('explains a failed search or keep-current in terms of the school, not a code (RV-p17-ui-4)', async () => {
    const { api } = fakeApi({
      familySchool: school({ pending: { school: cedar, effectiveFromMonth: '2026-10' } }),
      get: (path) =>
        path.startsWith('/v1/schools')
          ? new ApiRequestError('NOT_FOUND', 'Not found', 404)
          : undefined,
      send: () => new ApiRequestError('NOT_FOUND', 'School not found', 404),
    });
    renderPage(<SchoolAndPromotionsPage />, { api });
    const yours = await screen.findByRole('region', { name: 'Your school' });
    await userEvent.click(
      await within(yours).findByRole('button', { name: /Keep Maple Grove Elementary/ }),
    );
    const message =
      'That school isn’t available to choose anymore. Search again and pick a school from the list.';
    expect(await within(yours).findByText(message)).toBeTruthy();
    await userEvent.type(within(yours).getByLabelText(/Find your school/i), 'maple');
    await userEvent.click(within(yours).getByRole('button', { name: /^Search$/ }));
    await waitFor(() => expect(within(yours).getAllByText(message)).toHaveLength(2));
    expect(within(yours).queryByText(/code/i)).toBeNull();
  });

  it('asks the parent to create a family first when there is none', async () => {
    const { api } = fakeApi({
      get: (path) =>
        path === '/v1/family/school'
          ? new ApiRequestError('NOT_FOUND', 'Create your family first', 404)
          : undefined,
    });
    renderPage(<SchoolAndPromotionsPage />, { api });
    expect(await screen.findByText(/Create your family first/)).toBeTruthy();
  });
});

describe('SchoolAndPromotionsPage — monthly promo codes (spec P17, AC_PROMO_14)', () => {
  it('shows the quote: percent, exact target period, amounts, regular renewal line and preview label', async () => {
    const { api, sends } = fakeApi({ send: () => quote() });
    renderPage(<SchoolAndPromotionsPage />, { api });
    await enterCode();
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      method: 'POST',
      path: '/v1/family/promotions/quote',
      body: { code: CODE, channel: 'app_store' },
    });
    const card = await screen.findByRole('region', { name: 'Your code preview' });
    expect(within(card).getByText(/50% off/)).toBeTruthy();
    expect(within(card).getByText(/October 2026 code/)).toBeTruthy();
    expect(within(card).getByText(/renewal starting October 15, 2026/)).toBeTruthy();
    expect(within(card).getByText('$49.98')).toBeTruthy();
    expect(within(card).getByText('−$24.99')).toBeTruthy();
    expect(within(card).getByText('$24.99')).toBeTruthy();
    expect(within(card).getByText('Without a new code your next renewal is $49.98.')).toBeTruthy();
    expect(within(card).getByText(/Preview — your store shows the final amount/)).toBeTruthy();
    // A discounted month earns the school nothing; the page says so before confirmation.
    expect(within(card).getByText(/contributes \$0 to your school/i)).toBeTruthy();
    expect(within(card).getByText(/one monthly billing period only/i)).toBeTruthy();
  });

  it('names the first full billing period for a family that has not subscribed yet', async () => {
    const { api, sends } = fakeApi({
      send: () =>
        quote({
          targetPeriod: { kind: 'first_full_period' },
          percentOff: 100,
          regularCents: 3999,
          discountCents: 3999,
          chargedCents: 0,
          nextRegularRenewalCents: 3999,
        }),
    });
    renderPage(<SchoolAndPromotionsPage />, { api });
    await userEvent.selectOptions(await screen.findByLabelText(/Plan size/i), '1');
    await enterCode();
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.body).toEqual({ code: CODE, channel: 'app_store', paidSlots: 1 });
    const card = await screen.findByRole('region', { name: 'Your code preview' });
    expect(within(card).getByText(/your first full monthly billing period/i)).toBeTruthy();
    expect(within(card).getByText('$0.00')).toBeTruthy();
    expect(within(card).getByText('Without a new code your next renewal is $39.99.')).toBeTruthy();
  });

  it('validates the code and store on the client before calling the API', async () => {
    const { api, sends } = fakeApi();
    renderPage(<SchoolAndPromotionsPage />, { api });
    const input = await screen.findByLabelText(/^Promo code$/i);
    await userEvent.type(input, 'ABC');
    await userEvent.click(screen.getByRole('button', { name: /Check code/i }));
    expect(await screen.findByText(/Enter the code exactly as shown/)).toBeTruthy();
    await userEvent.clear(input);
    await userEvent.type(input, CODE);
    await userEvent.click(screen.getByRole('button', { name: /Check code/i }));
    expect(await screen.findByText(/Choose where your subscription is billed/)).toBeTruthy();
    expect(sends).toHaveLength(0);
  });

  it('redeems a web-billing code with an idempotency key after confirmation and shows that the store must confirm', async () => {
    const { api, sends, gets } = fakeApi({
      send: (call) =>
        call.path.endsWith('/quote')
          ? quote({ channel: 'stripe' })
          : redemption({ channel: 'stripe', state: 'provider_pending' }),
    });
    // WEB-R1-06: web billing is hidden while it is disabled; this redemption-safety check runs with
    // it enabled, the only state in which a web redemption can happen.
    renderPage(<SchoolAndPromotionsPage webBillingEnabled />, { api });
    await enterCode(CODE, /web billing/);
    const card = await screen.findByRole('region', { name: 'Your code preview' });
    await userEvent.click(within(card).getByRole('button', { name: /Redeem code/ }));
    // The acknowledgement is required first.
    expect(await within(card).findByText(/Please confirm you understand/)).toBeTruthy();
    expect(sends).toHaveLength(1);
    await userEvent.click(within(card).getByRole('checkbox'));
    await userEvent.click(within(card).getByRole('button', { name: /Redeem code/ }));
    await waitFor(() => expect(sends).toHaveLength(2));
    const body = sends[1]!.body as { code: string; channel: string; idempotencyKey: string };
    expect(sends[1]!.path).toBe('/v1/family/promotions/redeem');
    expect(body.code).toBe(CODE);
    expect(body.channel).toBe('stripe');
    expect(body.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    const result = await screen.findByRole('region', { name: 'Redemption status' });
    expect(within(result).getByText(/Waiting for the store to confirm/)).toBeTruthy();
    expect(within(result).getByText(/not final until the store confirms/i)).toBeTruthy();
    await waitFor(() =>
      expect(gets.filter((p) => p === '/v1/family/promotions').length).toBeGreaterThan(1),
    );
  });

  it('reuses the same idempotency key when a redeem is retried after a network failure', async () => {
    let attempt = 0;
    const { api, sends } = fakeApi({
      send: (call) => {
        if (call.path.endsWith('/quote')) return quote({ channel: 'stripe' });
        attempt += 1;
        return attempt === 1
          ? new ApiRequestError('NETWORK', 'You appear to be offline.', 0)
          : redemption({ channel: 'stripe' });
      },
    });
    // WEB-R1-06: web billing is hidden while it is disabled; this redemption-safety check runs with
    // it enabled, the only state in which a web redemption can happen.
    renderPage(<SchoolAndPromotionsPage webBillingEnabled />, { api });
    await enterCode(CODE, /web billing/);
    const card = await screen.findByRole('region', { name: 'Your code preview' });
    await userEvent.click(within(card).getByRole('checkbox'));
    await userEvent.click(within(card).getByRole('button', { name: /Redeem code/ }));
    expect(await screen.findByText(/You appear to be offline/)).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: /Redeem code/ }));
    await waitFor(() => expect(sends).toHaveLength(3));
    const first = sends[1]!.body as { idempotencyKey: string };
    const second = sends[2]!.body as { idempotencyKey: string };
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it.each([
    ['App Store', /App Store/],
    ['Google Play', /Google Play/],
  ])(
    'previews a %s code but does not reserve it while the in-app store step is unavailable',
    async (_store, radio) => {
      const { api, sends } = fakeApi({ send: () => quote() });
      renderPage(<SchoolAndPromotionsPage />, { api });
      await enterCode(CODE, radio);
      const card = await screen.findByRole('region', { name: 'Your code preview' });
      expect(within(card).getByText(/in-app store step isn’t available yet/)).toBeTruthy();
      expect(within(card).getByText(/No code has been used/)).toBeTruthy();
      expect(within(card).queryByRole('button', { name: /Redeem code/ })).toBeNull();
      expect(sends).toHaveLength(1);
    },
  );

  it('asks for the parent PIN when the server requires a step-up', async () => {
    const { api } = fakeApi({
      send: () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403),
    });
    renderPage(<SchoolAndPromotionsPage />, { api });
    await enterCode();
    expect(await screen.findByText(/Enter your parent PIN to continue/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /unlock on the security page/i })).toBeTruthy();
  });

  it.each([
    ['FAMILY_ALREADY_REDEEMED_CAMPAIGN', /already used this month’s code/],
    ['TARGET_PERIOD_ALREADY_DISCOUNTED', /already has a discount/],
    ['PENDING_PROMOTION_EXISTS', /already have a discount waiting/],
    ['CHANNEL_UNAVAILABLE', /isn’t available for the store you chose yet/],
    ['CHANNEL_MISMATCH', /billed by a different store/],
    ['CODE_CHECKSUM_MISMATCH', /has a typo/],
    ['CODE_INVALID_FORMAT', /doesn’t look like a PencilLift code/],
    ['CODE_USAGE_CAP_REACHED', /reached its usage limit/],
    ['CAMPAIGN_BUDGET_EXHAUSTED', /fully used/],
    ['NEXT_PERIOD_ALREADY_FINALIZED', /already final/],
  ])('shows a specific message for %s', async (code, message) => {
    const { api } = fakeApi({ send: () => rule(code) });
    renderPage(<SchoolAndPromotionsPage />, { api });
    await enterCode();
    const alert = await screen.findByText(message);
    expect(alert.closest('[role="alert"]')).toBeTruthy();
  });

  it('falls back to the server wording for an unknown rule and hides no error', async () => {
    const { api } = fakeApi({ send: () => rule('SOMETHING_NEW', 'This code needs attention.') });
    renderPage(<SchoolAndPromotionsPage />, { api });
    await enterCode();
    expect(await screen.findByText('This code needs attention.')).toBeTruthy();
  });

  it('treats an unknown code as invalid without revealing whether it exists elsewhere', async () => {
    const { api } = fakeApi({
      send: () => new ApiRequestError('NOT_FOUND', 'That code isn’t valid.', 404),
    });
    renderPage(<SchoolAndPromotionsPage />, { api });
    await enterCode();
    expect(await screen.findByText(/That code isn’t valid. Check it and try again./)).toBeTruthy();
  });
});

describe('SchoolAndPromotionsPage — history (spec P17 "confirmation status")', () => {
  it('lists redemptions with text states and target periods', async () => {
    const { api } = fakeApi({
      history: {
        redemptions: [
          redemption(),
          redemption({
            id: '0d5a6b7c-8d9e-4f0a-9b2c-3d4e5f6a7b8c',
            state: 'reserved',
            nextAction: { kind: 'present_store_offer', providerOfferId: 'offer_2026_10_t2' },
          }),
          redemption({
            id: OLDER,
            campaignMonth: '2026-09',
            state: 'confirmed',
            percentOff: 100,
            discountCents: 4998,
            chargedCents: 0,
            targetPeriodStart: '2026-09-15T12:00:00.000Z',
            nextAction: { kind: 'none' },
          }),
        ],
      },
    });
    renderPage(<SchoolAndPromotionsPage />, { api });
    const history = await screen.findByRole('region', { name: 'Your promo history' });
    const items = await within(history).findAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText(/October 2026 code · 50% off/)).toBeTruthy();
    expect(within(items[0]!).getByText(/Waiting for the store to confirm/)).toBeTruthy();
    // A reservation that still needs the store's own offer sheet says nothing was applied.
    expect(within(items[1]!).getByText(/Reserved – waiting for the store step/)).toBeTruthy();
    expect(within(items[1]!).getByText(/No discount has been applied/)).toBeTruthy();
    expect(within(items[2]!).getByText(/September 2026 code · 100% off/)).toBeTruthy();
    expect(within(items[2]!).getByText(/Confirmed by the store/)).toBeTruthy();
    expect(within(items[2]!).getByText(/billing period starting September 15, 2026/i)).toBeTruthy();
    expect(within(items[2]!).getByText(/\$0\.00 instead of \$49\.98/)).toBeTruthy();
  });

  it('shows an empty history and the no-carry-forward rule', async () => {
    const { api } = fakeApi();
    renderPage(<SchoolAndPromotionsPage />, { api });
    const history = await screen.findByRole('region', { name: 'Your promo history' });
    expect(await within(history).findByText(/No promo codes used yet/)).toBeTruthy();
    expect(screen.getByText(/codes never carry forward/i)).toBeTruthy();
  });

  it('offers a retry when the history cannot load', async () => {
    let fail = true;
    const { api } = fakeApi({
      get: (path) => {
        if (path === '/v1/family/promotions' && fail) {
          fail = false;
          return new ApiRequestError('NETWORK', 'You appear to be offline.', 0);
        }
        return undefined;
      },
    });
    renderPage(<SchoolAndPromotionsPage />, { api });
    const history = await screen.findByRole('region', { name: 'Your promo history' });
    fireEvent.click(await within(history).findByRole('button', { name: 'Try again' }));
    expect(await within(history).findByText(/No promo codes used yet/)).toBeTruthy();
  });
});
