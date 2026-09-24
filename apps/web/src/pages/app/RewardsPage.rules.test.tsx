import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  FamilyRewardRules,
  RewardRulesResponse,
  RewardsOverview,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import RewardsPage from './RewardsPage.tsx';

// "How points are earned" (spec P9 configurable earning rules; AC_REWARDS_01, AC_UX_02).
// Synthetic data only (Riley).
const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const AT = '2026-09-20T15:00:00.000Z';
const RULES_PATH = '/v1/reward-rules';

const SUGGESTED: FamilyRewardRules = {
  attemptPoints: 2,
  independentCorrectBonus: 3,
  setCompletionPoints: 5,
  minMeaningfulResponseMs: 1500,
};

const overview: RewardsOverview = {
  rewards: [],
  children: [{ childId: RILEY, nickname: 'Riley', balance: 12, status: 'active' }],
  openRequests: [],
  recentRequests: [],
};

function rulesResponse(overrides: Partial<RewardRulesResponse> = {}): RewardRulesResponse {
  return { rules: SUGGESTED, suggested: SUGGESTED, updatedAt: null, ...overrides };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Fake API that validates fixtures and responses through the real contract schemas. */
function fakeApi(options: { rules?: () => unknown; send?: (call: Call) => unknown }) {
  const gets: string[] = [];
  const sends: Call[] = [];
  const settle = <S extends z.ZodType>(value: unknown, schema: S) => {
    if (value instanceof Promise) return value as Promise<z.infer<S>>;
    if (value instanceof Error) return Promise.reject(value);
    try {
      return Promise.resolve(schema.parse(value));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      gets.push(path);
      if (path === RULES_PATH)
        return settle(options.rules ? options.rules() : rulesResponse(), schema);
      if (path === '/v1/rewards') return settle(overview, schema);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    },
    send: <S extends z.ZodType>(
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      body: unknown,
      schema: S,
    ) => {
      const call = { method, path, body };
      sends.push(call);
      return settle(options.send?.(call), schema);
    },
  };
  return { api, gets, sends };
}

afterEach(() => {
  cleanup();
});

async function rulesRegion() {
  return screen.findByRole('region', { name: 'How points are earned' });
}

async function openForm() {
  const region = await rulesRegion();
  await userEvent.click(
    await within(region).findByRole('button', { name: 'Change how points are earned' }),
  );
  return within(region).getByRole('form', { name: 'Edit how points are earned' });
}

async function replace(form: HTMLElement, label: RegExp | string, value: string) {
  const field = within(form).getByLabelText(label);
  await userEvent.clear(field);
  if (value !== '') await userEvent.type(field, value);
}

describe('RewardsPage: how points are earned (spec P9, AC_REWARDS_01)', () => {
  it('shows the family’s rules and caps in words, and says when they are the suggested ones', async () => {
    const { api, gets } = fakeApi({});
    renderPage(<RewardsPage />, { api });
    const region = await rulesRegion();
    expect(await within(region).findByText(/2 points for each meaningful try/)).toBeTruthy();
    expect(within(region).getByText(/even when the answer is wrong/)).toBeTruthy();
    expect(within(region).getByText(/3 points extra when the first try is right/)).toBeTruthy();
    expect(within(region).getByText(/5 points for finishing a daily practice set/)).toBeTruthy();
    expect(
      within(region).getByText(
        /Blank answers, and answers given in under 1.5 seconds, earn nothing/,
      ),
    ).toBeTruthy();
    expect(within(region).getByText(/Each question earns its points once/)).toBeTruthy();
    expect(within(region).getByText(/suggested starting rules/)).toBeTruthy();
    expect(within(region).getByText(/points already earned never change/i)).toBeTruthy();
    expect(gets).toContain(RULES_PATH);
  });

  it('shows the date of the last change and a zero rule in words', async () => {
    const { api } = fakeApi({
      rules: () =>
        rulesResponse({
          rules: { ...SUGGESTED, attemptPoints: 0, minMeaningfulResponseMs: 2000 },
          updatedAt: AT,
        }),
    });
    renderPage(<RewardsPage />, { api });
    const region = await rulesRegion();
    expect(await within(region).findByText(/A try on its own earns no points/)).toBeTruthy();
    expect(within(region).getByText(/under 2 seconds/)).toBeTruthy();
    expect(within(region).getByText(/Last changed on/)).toBeTruthy();
    expect(within(region).queryByText(/suggested starting rules/)).toBeNull();
  });

  it('shows a loading state while the rules load, with nothing to edit yet', async () => {
    const { api } = fakeApi({ rules: () => new Promise(() => undefined) });
    renderPage(<RewardsPage />, { api });
    const region = await rulesRegion();
    expect(within(region).getByText('Loading how points are earned…')).toBeTruthy();
    expect(
      within(region).queryByRole('button', { name: 'Change how points are earned' }),
    ).toBeNull();
  });

  it('a load error is explained and can be retried', async () => {
    let calls = 0;
    const { api } = fakeApi({
      rules: () => {
        calls += 1;
        return calls === 1
          ? new ApiRequestError('NETWORK', 'You appear to be offline.', 0)
          : rulesResponse();
      },
    });
    renderPage(<RewardsPage />, { api });
    const region = await rulesRegion();
    expect(await within(region).findByText(/You appear to be offline/)).toBeTruthy();
    await userEvent.click(within(region).getByRole('button', { name: 'Try again' }));
    expect(await within(region).findByText(/2 points for each meaningful try/)).toBeTruthy();
    expect(within(region).queryByText(/You appear to be offline/)).toBeNull();
  });

  it('edits the rules with labelled fields and saves them as one PUT', async () => {
    const saved: FamilyRewardRules = {
      attemptPoints: 4,
      independentCorrectBonus: 6,
      setCompletionPoints: 10,
      minMeaningfulResponseMs: 2500,
    };
    const { api, sends } = fakeApi({
      send: () => ({ rules: saved, suggested: SUGGESTED, updatedAt: AT, changed: true }),
    });
    renderPage(<RewardsPage />, { api });
    const form = await openForm();
    expect(within(form).getByLabelText('Points for each try')).toHaveProperty('value', '2');
    expect(within(form).getByLabelText(/Minimum answer time/)).toHaveProperty('value', '1.5');
    await replace(form, 'Points for each try', '4');
    await replace(form, 'Bonus when the first try is right', '6');
    await replace(form, 'Points for finishing a practice set', '10');
    await replace(form, /Minimum answer time/, '2.5');
    await userEvent.click(within(form).getByRole('button', { name: 'Save rules' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({ method: 'PUT', path: RULES_PATH, body: saved });
    const region = await rulesRegion();
    const status = await within(region).findByRole('status');
    expect(status.textContent).toMatch(/Saved\. The new rules apply to points earned from now on/);
    expect(within(region).getByText(/4 points for each meaningful try/)).toBeTruthy();
    expect(within(region).getByText(/under 2.5 seconds/)).toBeTruthy();
    expect(within(region).queryByRole('form', { name: 'Edit how points are earned' })).toBeNull();
  });

  it('validates before sending: whole points from 0 to 100 and at least 0.5 seconds', async () => {
    const { api, sends } = fakeApi({});
    renderPage(<RewardsPage />, { api });
    const form = await openForm();
    const save = () => userEvent.click(within(form).getByRole('button', { name: 'Save rules' }));

    await replace(form, 'Points for each try', '101');
    await save();
    expect(
      await within(form).findByText(/Points for each try.*whole number from 0 to 100/),
    ).toBeTruthy();
    expect(within(form).getByLabelText('Points for each try').getAttribute('aria-invalid')).toBe(
      'true',
    );

    await replace(form, 'Points for each try', '2');
    await replace(form, 'Bonus when the first try is right', '1.5');
    await save();
    expect(
      await within(form).findByText(/Bonus when the first try is right.*whole number/),
    ).toBeTruthy();
    expect(within(form).getByLabelText('Points for each try').getAttribute('aria-invalid')).toBe(
      'false',
    );

    await replace(form, 'Bonus when the first try is right', '3');
    await replace(form, 'Points for finishing a practice set', '');
    await save();
    expect(
      await within(form).findByText(/Points for finishing a practice set.*whole number/),
    ).toBeTruthy();

    await replace(form, 'Points for finishing a practice set', '5');
    await replace(form, /Minimum answer time/, '0.4');
    await save();
    const timeError = await within(form).findByText(/from 0.5 to 60 seconds/);
    expect(timeError.getAttribute('role')).toBe('alert');
    const time = within(form).getByLabelText(/Minimum answer time/);
    expect(time.getAttribute('aria-invalid')).toBe('true');
    expect(time.getAttribute('aria-describedby')).toContain(timeError.id);

    await replace(form, /Minimum answer time/, '61');
    await save();
    expect(await within(form).findByText(/from 0.5 to 60 seconds/)).toBeTruthy();
    expect(sends).toHaveLength(0);

    // The lowest allowed values are accepted.
    await replace(form, 'Points for each try', '0');
    await replace(form, /Minimum answer time/, '0.5');
    await save();
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.body).toEqual({
      ...SUGGESTED,
      attemptPoints: 0,
      minMeaningfulResponseMs: 500,
    });
  });

  it('asks for the parent PIN when saving needs a step-up and keeps what was typed', async () => {
    const { api } = fakeApi({
      send: () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403),
    });
    renderPage(<RewardsPage />, { api });
    const form = await openForm();
    await replace(form, 'Points for each try', '7');
    await userEvent.click(within(form).getByRole('button', { name: 'Save rules' }));
    const link = await within(form).findByRole('link', { name: /unlock on the security page/i });
    expect(link.getAttribute('href')).toBe('/app/security');
    expect(within(form).getByLabelText('Points for each try')).toHaveProperty('value', '7');
  });

  it('shows a server validation error inside the form', async () => {
    const { api } = fakeApi({
      send: () =>
        new ApiRequestError(
          'VALIDATION_FAILED',
          'Check the points and the minimum answer time',
          400,
        ),
    });
    renderPage(<RewardsPage />, { api });
    const form = await openForm();
    await userEvent.click(within(form).getByRole('button', { name: 'Save rules' }));
    expect(
      await within(form).findByText(/Check the points and the minimum answer time/),
    ).toBeTruthy();
  });

  it('saving unchanged rules says nothing changed; the suggested rules can be filled in', async () => {
    const { api, sends } = fakeApi({
      rules: () =>
        rulesResponse({ rules: { ...SUGGESTED, setCompletionPoints: 9 }, updatedAt: AT }),
      send: (call) => ({
        rules: call.body,
        suggested: SUGGESTED,
        updatedAt: AT,
        changed: false,
      }),
    });
    renderPage(<RewardsPage />, { api });
    const form = await openForm();
    expect(within(form).getByLabelText('Points for finishing a practice set')).toHaveProperty(
      'value',
      '9',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Use the suggested rules' }));
    expect(within(form).getByLabelText('Points for finishing a practice set')).toHaveProperty(
      'value',
      '5',
    );
    expect(sends).toHaveLength(0); // filling in is not saving
    await userEvent.click(within(form).getByRole('button', { name: 'Save rules' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.body).toEqual(SUGGESTED);
    const region = await rulesRegion();
    expect(await within(region).findByText(/already in place/)).toBeTruthy();
  });

  it('cancelling an edit closes the form without saving', async () => {
    const { api, sends } = fakeApi({});
    renderPage(<RewardsPage />, { api });
    const form = await openForm();
    await replace(form, 'Points for each try', '9');
    await userEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    const region = await rulesRegion();
    expect(within(region).queryByRole('form', { name: 'Edit how points are earned' })).toBeNull();
    expect(within(region).getByText(/2 points for each meaningful try/)).toBeTruthy();
    expect(sends).toHaveLength(0);
  });
});
