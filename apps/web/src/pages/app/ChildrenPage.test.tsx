import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { FamilyOverview } from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import ChildrenPage from './ChildrenPage.tsx';

// Synthetic data only (Riley, Sam).
const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const SAM = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const FAMILY = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';

function family(overrides: Partial<FamilyOverview> = {}): FamilyOverview {
  return {
    id: FAMILY,
    displayName: 'Test Family',
    timezone: 'America/Chicago',
    paidSlots: 1,
    billingConflict: null,
    managingChannel: null,
    children: [
      { id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' },
      { id: SAM, nickname: 'Sam', gradeLevel: 0, ageBand: '5-7', status: 'draft' },
    ],
    ...overrides,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeApi(options: { get?: () => unknown; send?: (call: Call) => unknown } = {}) {
  const gets: string[] = [];
  const sends: Call[] = [];
  const settle = <S extends z.ZodType>(value: unknown, schema: S) => {
    try {
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(schema.parse(value));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      gets.push(path);
      return settle(options.get ? options.get() : family(), schema);
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

afterEach(cleanup);

describe('ChildrenPage', () => {
  it('lists children with text status labels and explains paid slots honestly', async () => {
    renderPage(<ChildrenPage />, { api: fakeApi().api });
    expect(await screen.findByRole('heading', { name: 'Riley' })).toBeTruthy();
    expect(screen.getByText('Status: Active: uses a paid slot')).toBeTruthy();
    expect(screen.getByText('Status: Draft: not active yet, no charge')).toBeTruthy();
    expect(screen.getByText('Kindergarten · ages 5-7')).toBeTruthy();
    expect(screen.getByText(/Assigning a slot from this portal isn’t available yet/)).toBeTruthy();
    // Draft children cannot be paired and say why (no dead button).
    const sam = screen.getByRole('heading', { name: 'Sam' }).closest('li')!;
    expect(within(sam).queryByRole('button')).toBeNull();
    expect(within(sam).getByText(/once Sam has a paid slot/)).toBeTruthy();
  });

  it('creates a pairing code, shows it once with expiry and instructions, then hides it', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi({
      send: () => ({ code: 'ABCD-EFGH', expiresAt: '2026-09-24T15:10:00.000Z' }),
    });
    renderPage(<ChildrenPage />, { api });
    const riley = (await screen.findByRole('heading', { name: 'Riley' })).closest('li')!;
    await user.click(within(riley).getByRole('button', { name: 'Create pairing code' }));
    expect(await within(riley).findByText('ABCD-EFGH')).toBeTruthy();
    expect(within(riley).getByText(/Expires at/)).toBeTruthy();
    expect(within(riley).getByText(/It works once and connects only Riley’s profile/)).toBeTruthy();
    expect(sends).toEqual([
      { method: 'POST', path: `/v1/children/${RILEY}/pairing-code`, body: undefined },
    ]);
    await user.click(within(riley).getByRole('button', { name: 'Done' }));
    expect(within(riley).queryByText('ABCD-EFGH')).toBeNull();
  });

  it('explains step-up when creating a pairing code needs the PIN', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi({
      send: () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403),
    });
    renderPage(<ChildrenPage />, { api });
    await user.click(await screen.findByRole('button', { name: 'Create pairing code' }));
    expect(
      await screen.findByText(/Creating a pairing code needs a recent PIN unlock/),
    ).toBeTruthy();
  });

  it('adds a draft child and reloads the list', async () => {
    const user = userEvent.setup();
    const { api, sends, gets } = fakeApi({
      send: () => ({ childId: '9c4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b', status: 'draft' }),
    });
    renderPage(<ChildrenPage />, { api });
    await user.type(await screen.findByLabelText('Nickname'), '  Jordan ');
    await user.selectOptions(screen.getByLabelText('Grade'), '4');
    await user.selectOptions(screen.getByLabelText('Age band'), '8-10');
    await user.click(screen.getByRole('button', { name: 'Add draft child' }));
    expect(await screen.findByText('Jordan was added as a draft profile.')).toBeTruthy();
    expect(sends).toEqual([
      {
        method: 'POST',
        path: '/v1/children',
        body: { nickname: 'Jordan', gradeLevel: 4, ageBand: '8-10' },
      },
    ]);
    await waitFor(() => expect(gets.length).toBe(2));
    // The refresh keeps the list mounted, so the confirmation stays visible.
    expect(screen.getByText('Jordan was added as a draft profile.')).toBeTruthy();
  });

  it('validates the nickname and explains step-up for adding a child', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi({
      send: () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403),
    });
    renderPage(<ChildrenPage />, { api });
    await user.click(await screen.findByRole('button', { name: 'Add draft child' }));
    expect(screen.getByText('Enter a nickname of 1 to 40 characters.')).toBeTruthy();
    expect(sends).toHaveLength(0);
    await user.type(screen.getByLabelText('Nickname'), 'Avery');
    await user.click(screen.getByRole('button', { name: 'Add draft child' }));
    expect(await screen.findByText(/Adding a child needs a recent PIN unlock/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Unlock on the Security page' })).toBeTruthy();
  });

  it('shows an empty state and a create-family prompt', async () => {
    renderPage(<ChildrenPage />, { api: fakeApi({ get: () => family({ children: [] }) }).api });
    expect(await screen.findByText('No children yet. Add your first child below.')).toBeTruthy();
    cleanup();
    renderPage(<ChildrenPage />, {
      api: fakeApi({ get: () => new ApiRequestError('NOT_FOUND', 'Create your family first', 404) })
        .api,
    });
    expect(await screen.findByRole('link', { name: 'family dashboard' })).toBeTruthy();
  });

  it('shows an error state with retry', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const { api } = fakeApi({
      get: () => {
        calls += 1;
        return calls === 1
          ? new ApiRequestError('NETWORK', 'You appear to be offline.', 0)
          : family();
      },
    });
    renderPage(<ChildrenPage />, { api });
    expect(await screen.findByText('You appear to be offline.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Riley' })).toBeTruthy();
  });
});
