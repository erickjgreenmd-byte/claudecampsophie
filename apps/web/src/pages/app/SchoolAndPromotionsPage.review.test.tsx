import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  familySchoolResponseSchema,
  promoQuoteResponseSchema,
  promoRedemptionSchema,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import SchoolAndPromotionsPage from './SchoolAndPromotionsPage.tsx';

/**
 * Independent adversarial review of the p17-ui vertical (parent school and promo page).
 * Synthetic data only; responses pass through the real contract schemas.
 */

const MAPLE = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const CEDAR = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const REDEMPTION = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const CODE = 'ABCDE-FGHJK-X';

type FamilySchool = z.infer<typeof familySchoolResponseSchema>;
type Quote = z.infer<typeof promoQuoteResponseSchema>;
type Redemption = z.infer<typeof promoRedemptionSchema>;

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

const stripeQuote: Quote = {
  campaignMonth: '2026-10',
  percentOff: 50,
  channel: 'stripe',
  targetPeriod: {
    kind: 'renewal_period',
    periodStart: '2026-10-15T12:00:00.000Z',
    isProjection: true,
  },
  regularCents: 4998,
  discountCents: 2499,
  chargedCents: 2499,
  nextRegularRenewalCents: 4998,
  isPreview: true,
};

const pendingRedemption: Redemption = {
  id: REDEMPTION,
  campaignMonth: '2026-10',
  channel: 'stripe',
  state: 'provider_pending',
  percentOff: 50,
  regularCents: 4998,
  discountCents: 2499,
  chargedCents: 2499,
  targetPeriodStart: '2026-10-15T12:00:00.000Z',
  createdAt: '2026-09-20T15:00:00.000Z',
  nextAction: { kind: 'await_provider' },
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeApi(options: { familySchool?: FamilySchool; send: (call: Call) => unknown }) {
  const sends: Call[] = [];
  const get = (path: string): unknown => {
    if (path === '/v1/family/school') return options.familySchool ?? school();
    if (path === '/v1/family/promotions') return { redemptions: [] };
    if (path.startsWith('/v1/schools')) return { schools: [maple, cedar] };
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
        const value = options.send(call);
        if (value instanceof Error) return Promise.reject(value);
        // A handler may return a promise to model a slow network.
        return Promise.resolve(value).then((v) => schema.parse(v));
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

async function chooseCedar() {
  await userEvent.type(await screen.findByLabelText(/Find your school/i), 'cedar');
  await userEvent.click(screen.getByRole('button', { name: /^Search$/ }));
  const results = await screen.findByRole('list', { name: 'School search results' });
  await userEvent.click(within(results).getByRole('button', { name: /Choose Cedar Park Middle/ }));
  await userEvent.click(screen.getByRole('button', { name: /Confirm Cedar Park Middle/ }));
}

describe('[RV-p17-ui-4] a failed school change is not explained as a bad promo code', () => {
  // PUT /v1/family/school answers NOT_FOUND "School not found" when the school is no longer
  // active (e.g. the owner deactivated it after the parent searched). Error mapping must be keyed
  // to the action: a school failure must never tell the parent their "code" is invalid.
  it('[RV-p17-ui-4] NOT_FOUND from PUT /v1/family/school does not say "That code isn’t valid"', async () => {
    const { api, sends } = fakeApi({
      send: () => new ApiRequestError('NOT_FOUND', 'School not found', 404),
    });
    renderPage(<SchoolAndPromotionsPage />, { api });
    await chooseCedar();
    await waitFor(() => expect(sends).toHaveLength(1));
    const yours = screen.getByRole('region', { name: 'Your school' });
    const alert = await within(yours).findByRole('alert');
    expect(alert.textContent ?? '').not.toMatch(/code/i);
    expect(alert.textContent ?? '').toMatch(/school/i);
  });
});

describe('[RV-p17-ui-8] a first school choice says when it takes effect', () => {
  // Task: "current + pending designation with the month it takes effect". A first designation
  // applies from the current program month (planSchoolDesignation); the success message must not
  // claim the school merely "stays" the family's school.
  it('[RV-p17-ui-8] the success message for a first designation does not say the school "stays"', async () => {
    const { api } = fakeApi({
      familySchool: school({ current: null }),
      send: () => school({ current: cedar, pending: null }),
    });
    renderPage(<SchoolAndPromotionsPage />, { api });
    expect(await screen.findByText(/No school chosen yet/)).toBeTruthy();
    await chooseCedar();
    const status = await screen.findByText(/^Saved\./);
    expect(status.textContent).toMatch(/Cedar Park Middle/);
    expect(status.textContent).not.toMatch(/stays your school/);
  });
});

describe('p17-ui review probes (passing): redemption safety', () => {
  it('probe: a double click on "Redeem code" sends at most one redemption, with the preview key', async () => {
    let release: () => void = () => undefined;
    // The redeem is held open (a slow network) so a second click lands while it is in flight.
    const { api, sends } = fakeApi({
      send: (call) =>
        call.path.endsWith('/quote')
          ? stripeQuote
          : new Promise((resolve) => {
              release = () => resolve(pendingRedemption);
            }),
    });
    renderPage(<SchoolAndPromotionsPage />, { api });
    const input = await screen.findByLabelText(/^Promo code$/i);
    await userEvent.type(input, CODE);
    await userEvent.click(screen.getByRole('radio', { name: /web billing/ }));
    await userEvent.click(screen.getByRole('button', { name: /Check code/i }));
    const card = await screen.findByRole('region', { name: 'Your code preview' });
    await userEvent.click(within(card).getByRole('checkbox'));
    await userEvent.dblClick(within(card).getByRole('button', { name: /Redeem code/ }));
    release();
    expect(await screen.findByRole('region', { name: 'Redemption status' })).toBeTruthy();
    const redeems = sends.filter((s) => s.path.endsWith('/redeem'));
    expect(redeems).toHaveLength(1);
  });

  it('probe: a STEP_UP_REQUIRED redeem shows the PIN notice and records no success', async () => {
    const { api } = fakeApi({
      send: (call) =>
        call.path.endsWith('/quote')
          ? stripeQuote
          : new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN to continue', 403),
    });
    renderPage(<SchoolAndPromotionsPage />, { api });
    await userEvent.type(await screen.findByLabelText(/^Promo code$/i), CODE);
    await userEvent.click(screen.getByRole('radio', { name: /web billing/ }));
    await userEvent.click(screen.getByRole('button', { name: /Check code/i }));
    const card = await screen.findByRole('region', { name: 'Your code preview' });
    await userEvent.click(within(card).getByRole('checkbox'));
    await userEvent.click(within(card).getByRole('button', { name: /Redeem code/ }));
    expect(await within(card).findByText(/Enter your parent PIN to continue/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Redemption status' })).toBeNull();
  });
});
