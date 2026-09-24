// Independent adversarial review of the rewards vertical (fresh context). Synthetic data only.
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { RewardsOverview } from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import RewardsPage from './RewardsPage.tsx';

const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const REWARD = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const REQUEST = '9c4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b';
const AT = '2026-09-20T15:00:00.000Z';

function overview(withPending: boolean): RewardsOverview {
  const request = {
    id: REQUEST,
    childId: RILEY,
    childNickname: 'Riley',
    rewardId: REWARD,
    rewardTitle: 'Trip to the library',
    pointCost: 10,
    requestedAt: AT,
    decidedAt: null,
    fulfilledAt: null,
  };
  return {
    rewards: [
      {
        id: REWARD,
        title: 'Trip to the library',
        pointCost: 10,
        instructions: null,
        childId: null,
        active: true,
        createdAt: AT,
        updatedAt: AT,
      },
    ],
    children: [{ childId: RILEY, nickname: 'Riley', balance: withPending ? 0 : 10 }],
    openRequests: withPending ? [{ ...request, state: 'pending', cancelledBy: null }] : [],
    recentRequests: withPending ? [] : [{ ...request, state: 'cancelled', cancelledBy: 'child' }],
  };
}

function fakeApi(options: { get: (n: number) => unknown; send: () => unknown }) {
  const gets: string[] = [];
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      gets.push(path);
      const value = options.get(gets.filter((p) => p === path).length);
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(schema.parse(value));
    },
    send: <S extends z.ZodType>(_m: string, _p: string, _b: unknown, schema: S) => {
      const value = options.send();
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(schema.parse(value));
    },
  };
  return { api, gets };
}

afterEach(() => {
  cleanup();
});

describe('RewardsPage review findings', () => {
  it('[RV-rewards-7] a decision refused because the request already changed does not leave a stale actionable request', async () => {
    // AC_UX_02 (meaningful error states) / P14 (no dead buttons): Riley cancelled on the child
    // device while this page was open. Approving now fails with INVALID_TRANSITION; the page must
    // refresh (or otherwise stop offering Approve/Decline for a request that is no longer pending).
    const { api, gets } = fakeApi({
      get: (n) => overview(n === 1),
      send: () =>
        new ApiRequestError(
          'BUSINESS_RULE',
          'This request can’t move to that state from where it is now',
          422,
          'INVALID_TRANSITION',
        ),
    });
    renderPage(<RewardsPage />, { api });
    await userEvent.click(await screen.findByRole('button', { name: /Approve Riley’s request/ }));
    expect(await screen.findByText(/can’t move to that state/)).toBeTruthy();
    await waitFor(
      () => {
        expect(gets.filter((p) => p === '/v1/rewards').length).toBeGreaterThan(1);
        expect(screen.queryByRole('button', { name: /Approve Riley’s request/ })).toBeNull();
      },
      { timeout: 1500 },
    );
  });
});

describe('RewardsPage review findings (input)', () => {
  it('[RV-rewards-8] a parent on a phone keyboard can enter a point deduction', async () => {
    // P9 / AC_REWARDS_05: parents adjust points (including removals) with a reason. The field says
    // "use a minus sign to remove" but inputMode="numeric" opens a digits-only keypad on iOS
    // (no minus key), and the form offers no add/remove choice, so removals are impossible there.
    const { api } = fakeApi({ get: () => overview(true), send: () => new Error('unused') });
    renderPage(<RewardsPage />, { api });
    const form = await screen.findByRole('form', { name: 'Adjust points' });
    const field = within(form).getByLabelText(/Points to add or remove/);
    const digitsOnlyKeypad = field.getAttribute('inputmode') === 'numeric';
    const hasRemoveChoice =
      within(form).queryByRole('radio', { name: /remove/i }) !== null ||
      within(form).queryByRole('option', { name: /remove/i }) !== null ||
      within(form).queryByRole('button', { name: /^remove/i }) !== null;
    expect(digitsOnlyKeypad && !hasRemoveChoice).toBe(false);
  });
});

describe('RewardsPage review probes (held up)', () => {
  it('probe: a step-up failure while adding a reward shows the PIN prompt with a Security link', async () => {
    const { api } = fakeApi({
      get: () => overview(true),
      send: () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403),
    });
    renderPage(<RewardsPage />, { api });
    const form = await screen.findByRole('form', { name: 'Add a reward' });
    await userEvent.type(within(form).getByLabelText('Reward name'), 'Pick the movie');
    await userEvent.type(within(form).getByLabelText('Points needed'), '20');
    await userEvent.click(within(form).getByRole('button', { name: 'Add reward' }));
    const link = await within(form).findByRole('link', { name: /unlock on the security page/i });
    expect(link.getAttribute('href')).toBe('/app/security');
    // The form keeps what the parent typed so they can retry after unlocking.
    expect(within(form).getByLabelText('Reward name')).toHaveProperty('value', 'Pick the movie');
  });
});
