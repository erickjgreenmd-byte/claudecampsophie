import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { PointsHistory, RewardsOverview } from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { unconfiguredAuth } from '../../lib/auth.ts';
import { renderPage } from '../../test/render.tsx';
import RewardsPage from './RewardsPage.tsx';

// Synthetic data only (Riley, Sam).
const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const SAM = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const REWARD = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const REQUEST = '9c4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b';
const APPROVED = 'ad5a6b7c-8d9e-4f0a-9b2c-3d4e5f6a7b8c';
const AT = '2026-09-20T15:00:00.000Z';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function overview(overrides: Partial<RewardsOverview> = {}): RewardsOverview {
  return {
    rewards: [
      {
        id: REWARD,
        title: 'Trip to the library',
        pointCost: 10,
        instructions: 'Saturday morning',
        childId: null,
        active: true,
        createdAt: AT,
        updatedAt: AT,
      },
    ],
    children: [
      { childId: RILEY, nickname: 'Riley', balance: 12, status: 'active' },
      { childId: SAM, nickname: 'Sam', balance: 0, status: 'active' },
    ],
    openRequests: [
      {
        id: REQUEST,
        childId: RILEY,
        childNickname: 'Riley',
        rewardId: REWARD,
        rewardTitle: 'Trip to the library',
        pointCost: 10,
        state: 'pending',
        requestedAt: AT,
        decidedAt: null,
        fulfilledAt: null,
        cancelledBy: null,
      },
      {
        id: APPROVED,
        childId: SAM,
        childNickname: 'Sam',
        rewardId: REWARD,
        rewardTitle: 'Trip to the library',
        pointCost: 10,
        state: 'approved',
        requestedAt: AT,
        decidedAt: AT,
        fulfilledAt: null,
        cancelledBy: null,
      },
    ],
    recentRequests: [],
    ...overrides,
  };
}

const history: PointsHistory = {
  childId: RILEY,
  balance: 12,
  entries: [
    {
      id: '3',
      kind: 'adjustment',
      points: -3,
      reason: 'Duplicate award reversed',
      actor: 'parent',
      redemptionId: null,
      rewardTitle: null,
      createdAt: AT,
    },
    {
      id: '2',
      kind: 'award',
      points: 15,
      reason: null,
      actor: 'system',
      redemptionId: null,
      rewardTitle: null,
      createdAt: AT,
    },
  ],
  hasMore: false,
  totals: { awarded: 15, adjustments: -3, reserved: 0, released: 0, net: 12 },
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Fake API that validates fixtures and responses through the real contract schemas. */
function fakeApi(
  options: {
    data?: RewardsOverview;
    get?: (path: string) => unknown;
    send?: (call: Call) => unknown;
  } = {},
) {
  const gets: string[] = [];
  const sends: Call[] = [];
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      gets.push(path);
      try {
        const value = options.get ? options.get(path) : (options.data ?? overview());
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

const stepUp = () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403);

describe('RewardsPage (spec P9, P14; AC_UX_02)', () => {
  it('shows rewards, balances and requests with text status labels', async () => {
    const { api } = fakeApi();
    renderPage(<RewardsPage />, { api });
    expect(await screen.findByRole('heading', { name: 'Rewards' })).toBeTruthy();
    const rewards = await screen.findByRole('region', { name: 'Family rewards' });
    expect(within(rewards).getByText('Trip to the library')).toBeTruthy();
    expect(within(rewards).getByText(/10 points · for every child/i)).toBeTruthy();
    const balances = screen.getByRole('region', { name: 'Points balances' });
    expect(within(balances).getByText('Riley')).toBeTruthy();
    expect(within(balances).getByText('12 points')).toBeTruthy();
    const requests = screen.getByRole('region', { name: 'Reward requests' });
    expect(within(requests).getByText(/Waiting for you/)).toBeTruthy();
    expect(within(requests).getByText(/Approved – give it when you can/)).toBeTruthy();
    expect(within(requests).getByRole('button', { name: /Approve Riley’s request/ })).toBeTruthy();
    expect(within(requests).getByRole('button', { name: /Mark Sam’s .* as given/ })).toBeTruthy();
    // Points are not money: the page says so and offers no payment action.
    expect(screen.getByText(/not money/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /pay|buy|purchase|cash/i })).toBeNull();
  });

  it('an archived child keeps a readable balance but is not offered for new rewards or adjustments', async () => {
    const ARCHIVED = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
    const { api } = fakeApi({
      data: overview({
        children: [
          { childId: RILEY, nickname: 'Riley', balance: 12, status: 'active' },
          { childId: ARCHIVED, nickname: 'Jordan', balance: 30, status: 'archived' },
        ],
      }),
    });
    renderPage(<RewardsPage />, { api });
    const balances = await screen.findByRole('region', { name: 'Points balances' });
    expect(within(balances).getByText('Jordan')).toBeTruthy();
    expect(within(balances).getByText(/archived — history only/)).toBeTruthy();
    const adjust = screen.getByRole('form', { name: 'Adjust points' });
    const childOptions = within(within(adjust).getByLabelText('Child')).getAllByRole('option');
    expect(childOptions.map((o) => o.textContent)).not.toContain('Jordan');
    const add = screen.getByRole('form', { name: 'Add a reward' });
    const audience = within(within(add).getByLabelText('Who can ask for it')).getAllByRole(
      'option',
    );
    expect(audience.map((o) => o.textContent).join(' ')).not.toMatch(/Jordan/);
  });

  it('approving a request posts the decision and refreshes the list', async () => {
    const { api, gets, sends } = fakeApi({
      send: () => ({
        request: { ...overview().openRequests[0]!, state: 'approved', decidedAt: AT },
        balance: 2,
      }),
    });
    renderPage(<RewardsPage />, { api });
    await userEvent.click(await screen.findByRole('button', { name: /Approve Riley’s request/ }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      method: 'POST',
      path: `/v1/reward-requests/${REQUEST}/decision`,
      body: { action: 'approve' },
    });
    expect(await screen.findByText(/Approved Riley’s request/)).toBeTruthy();
    await waitFor(() => expect(gets.filter((p) => p === '/v1/rewards')).toHaveLength(2));
  });

  it('asks for the parent PIN with a link to Security when a step-up is required', async () => {
    const { api } = fakeApi({ send: () => stepUp() });
    renderPage(<RewardsPage />, { api });
    await userEvent.click(await screen.findByRole('button', { name: /Decline Riley’s request/ }));
    const alert = await screen.findByText(/Enter your parent PIN/);
    expect(alert).toBeTruthy();
    const link = screen.getByRole('link', { name: /unlock on the security page/i });
    expect(link.getAttribute('href')).toBe('/app/security');
  });

  it('the adjustment form requires a reason and a non-zero whole number', async () => {
    const { api, sends } = fakeApi({
      send: () => ({ childId: SAM, balance: 5, applied: true }),
    });
    renderPage(<RewardsPage />, { api });
    const form = await screen.findByRole('form', { name: 'Adjust points' });
    await userEvent.selectOptions(within(form).getByLabelText('Child'), SAM);
    await userEvent.type(within(form).getByLabelText(/Points to add or remove/), '5');
    await userEvent.click(within(form).getByRole('button', { name: 'Save adjustment' }));
    expect(await within(form).findByText(/Add a reason/)).toBeTruthy();
    expect(sends).toHaveLength(0);

    await userEvent.clear(within(form).getByLabelText(/Points to add or remove/));
    await userEvent.type(within(form).getByLabelText(/Points to add or remove/), '0');
    await userEvent.type(within(form).getByLabelText('Reason'), 'Extra reading');
    await userEvent.click(within(form).getByRole('button', { name: 'Save adjustment' }));
    expect(await within(form).findByText(/whole number other than 0/)).toBeTruthy();
    expect(sends).toHaveLength(0);

    await userEvent.clear(within(form).getByLabelText(/Points to add or remove/));
    await userEvent.type(within(form).getByLabelText(/Points to add or remove/), '5');
    await userEvent.click(within(form).getByRole('button', { name: 'Save adjustment' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.method).toBe('POST');
    expect(sends[0]!.path).toBe('/v1/points/adjustments');
    expect(sends[0]!.body).toMatchObject({ childId: SAM, points: 5, reason: 'Extra reading' });
    expect((sends[0]!.body as { adjustmentId: string }).adjustmentId).toMatch(UUID);
    expect(await screen.findByText(/Sam now has 5 points/)).toBeTruthy();
  });

  it('a retried adjustment reuses its adjustment id so it cannot apply twice', async () => {
    let attempt = 0;
    const { api, sends } = fakeApi({
      send: () => {
        attempt += 1;
        return attempt === 1
          ? new ApiRequestError('NETWORK', 'You appear to be offline.', 0)
          : { childId: RILEY, balance: 9, applied: true };
      },
    });
    renderPage(<RewardsPage />, { api });
    const form = await screen.findByRole('form', { name: 'Adjust points' });
    await userEvent.selectOptions(within(form).getByLabelText('Child'), RILEY);
    await userEvent.type(within(form).getByLabelText(/Points to add or remove/), '-3');
    await userEvent.type(within(form).getByLabelText('Reason'), 'Duplicate award reversed');
    await userEvent.click(within(form).getByRole('button', { name: 'Save adjustment' }));
    expect(await within(form).findByText(/offline/)).toBeTruthy();
    await userEvent.click(within(form).getByRole('button', { name: 'Save adjustment' }));
    await waitFor(() => expect(sends).toHaveLength(2));
    const ids = sends.map((c) => (c.body as { adjustmentId: string }).adjustmentId);
    expect(ids[0]).toBe(ids[1]);
    expect(sends[1]!.body).toMatchObject({ points: -3 });
  });

  it('a removal can be entered with the Add/Remove choice on a digits-only keypad', async () => {
    const { api, sends } = fakeApi({
      send: () => ({ childId: RILEY, balance: 8, applied: true }),
    });
    renderPage(<RewardsPage />, { api });
    const form = await screen.findByRole('form', { name: 'Adjust points' });
    const field = within(form).getByLabelText(/Points to add or remove/);
    expect(field.getAttribute('inputmode')).toBe('numeric');
    expect(within(form).getByRole('radio', { name: 'Add points' })).toHaveProperty('checked', true);
    await userEvent.selectOptions(within(form).getByLabelText('Child'), RILEY);
    await userEvent.click(within(form).getByRole('radio', { name: 'Remove points' }));
    await userEvent.type(field, '4');
    await userEvent.type(within(form).getByLabelText('Reason'), 'Duplicate award reversed');
    await userEvent.click(within(form).getByRole('button', { name: 'Save adjustment' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.body).toMatchObject({ childId: RILEY, points: -4 });
    // After saving, the form returns to adding so the next entry is not a surprise removal.
    expect(await screen.findByText(/Riley now has 8 points/)).toBeTruthy();
    expect(within(form).getByRole('radio', { name: 'Add points' })).toHaveProperty('checked', true);
  });

  it('a typed minus sign selects Remove, and a typed plus sign selects Add', async () => {
    const { api } = fakeApi();
    renderPage(<RewardsPage />, { api });
    const form = await screen.findByRole('form', { name: 'Adjust points' });
    const field = within(form).getByLabelText(/Points to add or remove/);
    await userEvent.type(field, '-6');
    expect(field).toHaveProperty('value', '6');
    expect(within(form).getByRole('radio', { name: 'Remove points' })).toHaveProperty(
      'checked',
      true,
    );
    await userEvent.clear(field);
    await userEvent.type(field, '+2');
    expect(field).toHaveProperty('value', '2');
    expect(within(form).getByRole('radio', { name: 'Add points' })).toHaveProperty('checked', true);
  });

  it('a decision on a request that no longer exists refreshes the list', async () => {
    let loads = 0;
    const { api, gets } = fakeApi({
      get: () => {
        loads += 1;
        return loads === 1 ? overview() : overview({ openRequests: [] });
      },
      send: () => new ApiRequestError('NOT_FOUND', 'Request not found', 404),
    });
    renderPage(<RewardsPage />, { api });
    await userEvent.click(await screen.findByRole('button', { name: /Decline Riley’s request/ }));
    expect(await screen.findByText(/Request not found/)).toBeTruthy();
    await waitFor(() => expect(gets.filter((p) => p === '/v1/rewards')).toHaveLength(2));
    expect(await screen.findByText(/No requests waiting/)).toBeTruthy();
  });

  it('a step-up failure on a decision does not reload the list', async () => {
    const { api, gets } = fakeApi({ send: () => stepUp() });
    renderPage(<RewardsPage />, { api });
    await userEvent.click(await screen.findByRole('button', { name: /Approve Riley’s request/ }));
    expect(await screen.findByText(/Enter your parent PIN/)).toBeTruthy();
    expect(gets.filter((p) => p === '/v1/rewards')).toHaveLength(1);
  });

  it('shows the insufficient-points rule clearly', async () => {
    const { api } = fakeApi({
      send: () =>
        new ApiRequestError(
          'BUSINESS_RULE',
          'That would take the points balance below zero',
          422,
          'INSUFFICIENT_POINTS',
        ),
    });
    renderPage(<RewardsPage />, { api });
    const form = await screen.findByRole('form', { name: 'Adjust points' });
    await userEvent.selectOptions(within(form).getByLabelText('Child'), SAM);
    await userEvent.type(within(form).getByLabelText(/Points to add or remove/), '-4');
    await userEvent.type(within(form).getByLabelText('Reason'), 'Correction');
    await userEvent.click(within(form).getByRole('button', { name: 'Save adjustment' }));
    expect(await within(form).findByText(/below zero/)).toBeTruthy();
  });

  it('creates a reward for one child and refuses links', async () => {
    const { api, sends } = fakeApi({
      send: (call) => ({
        reward: {
          ...overview().rewards[0]!,
          ...(call.body as object),
          id: 'be6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c9d',
          instructions: null,
        },
      }),
    });
    renderPage(<RewardsPage />, { api });
    const form = await screen.findByRole('form', { name: 'Add a reward' });
    await userEvent.type(within(form).getByLabelText('Reward name'), 'Book from www.shop.com');
    await userEvent.type(within(form).getByLabelText('Points needed'), '25');
    await userEvent.click(within(form).getByRole('button', { name: 'Add reward' }));
    expect(await within(form).findByText(/Links aren’t allowed/)).toBeTruthy();
    expect(sends).toHaveLength(0);

    await userEvent.clear(within(form).getByLabelText('Reward name'));
    await userEvent.type(within(form).getByLabelText('Reward name'), 'Pick the movie');
    await userEvent.selectOptions(within(form).getByLabelText('Who can ask for it'), SAM);
    await userEvent.click(within(form).getByRole('button', { name: 'Add reward' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      method: 'POST',
      path: '/v1/rewards',
      body: { title: 'Pick the movie', pointCost: 25, childId: SAM },
    });
    expect(await screen.findByText(/Added “Pick the movie”/)).toBeTruthy();
  });

  it('edits a reward with a PATCH of its editable fields', async () => {
    const { api, sends } = fakeApi({
      send: () => ({ reward: { ...overview().rewards[0]!, pointCost: 15, active: false } }),
    });
    renderPage(<RewardsPage />, { api });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Trip to the library' }));
    const form = screen.getByRole('form', { name: 'Edit Trip to the library' });
    await userEvent.clear(within(form).getByLabelText('Points needed'));
    await userEvent.type(within(form).getByLabelText('Points needed'), '15');
    await userEvent.click(within(form).getByLabelText(/Children can ask for this reward/));
    await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      method: 'PATCH',
      path: `/v1/rewards/${REWARD}`,
      body: {
        title: 'Trip to the library',
        pointCost: 15,
        instructions: 'Saturday morning',
        active: false,
      },
    });
  });

  it('shows a child’s history with reasons and totals that match the balance', async () => {
    const { api, gets } = fakeApi({
      get: (path) => (path.startsWith('/v1/points/history') ? history : overview()),
    });
    renderPage(<RewardsPage />, { api });
    await userEvent.click(await screen.findByRole('button', { name: 'View Riley’s history' }));
    const section = await screen.findByRole('region', { name: 'Riley’s points history' });
    expect(await within(section).findByText('Duplicate award reversed')).toBeTruthy();
    expect(within(section).getByText('Earned for learning')).toBeTruthy();
    expect(
      within(section).getByText(/History adds up to 12 points, matching the balance/),
    ).toBeTruthy();
    expect(gets).toContain(`/v1/points/history?childId=${RILEY}`);
  });

  it('shows honest empty states with next steps', async () => {
    const { api } = fakeApi({
      data: overview({ rewards: [], children: [], openRequests: [], recentRequests: [] }),
    });
    renderPage(<RewardsPage />, { api });
    expect(await screen.findByText(/No rewards yet/)).toBeTruthy();
    expect(screen.getByText(/No requests waiting/)).toBeTruthy();
    const add = screen.getByRole('link', { name: /Add a child/ });
    expect(add.getAttribute('href')).toBe('/app/children');
    expect(screen.queryByRole('form', { name: 'Adjust points' })).toBeNull();
  });

  it('shows a load error with a working retry', async () => {
    let calls = 0;
    const { api } = fakeApi({
      get: () => {
        calls += 1;
        return calls === 1
          ? new ApiRequestError('NETWORK', 'You appear to be offline. Check your connection.', 0)
          : overview();
      },
    });
    renderPage(<RewardsPage />, { api });
    expect(await screen.findByText(/You appear to be offline/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    const rewards = await screen.findByRole('region', { name: 'Family rewards' });
    expect(within(rewards).getByText('Trip to the library')).toBeTruthy();
    expect(screen.queryByText(/You appear to be offline/)).toBeNull();
  });

  it('never calls the API when parent sign-in is not configured', async () => {
    const get = vi.fn();
    renderPage(<RewardsPage />, { api: { get }, auth: unconfiguredAuth });
    expect(await screen.findByText(/sign-in isn’t available yet/i)).toBeTruthy();
    expect(get).not.toHaveBeenCalled();
  });
});
