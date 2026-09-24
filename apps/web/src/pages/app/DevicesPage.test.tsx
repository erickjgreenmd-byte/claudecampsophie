import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { ChildDevices, FamilyOverview } from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import DevicesPage from './DevicesPage.tsx';

// Synthetic data only (Riley, Sam).
const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const SAM = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const TABLET = 'ad5a6b7c-8d9e-4f0a-9b2c-3d4e5f6a7b8c';
const OLD_PHONE = 'be6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c9d';

const FAMILY: FamilyOverview = {
  id: '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60',
  displayName: 'Test Family',
  timezone: 'America/Chicago',
  paidSlots: 2,
  billingConflict: null,
  managingChannel: null,
  children: [
    { id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' },
    { id: SAM, nickname: 'Sam', gradeLevel: 1, ageBand: '5-7', status: 'active' },
  ],
};

const DEVICES: ChildDevices = {
  devices: [
    {
      id: TABLET,
      childId: RILEY,
      label: 'Kitchen tablet',
      platform: 'ios',
      pairedAt: '2026-09-20T15:00:00.000Z',
      revokedAt: null,
    },
    {
      id: OLD_PHONE,
      childId: SAM,
      label: 'Old phone',
      platform: 'android',
      pairedAt: '2026-09-01T15:00:00.000Z',
      revokedAt: '2026-09-10T15:00:00.000Z',
    },
  ],
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeApi(options: { devices?: () => unknown; send?: (call: Call) => unknown } = {}) {
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
      if (path === '/v1/family') return settle(FAMILY, schema);
      return settle(options.devices ? options.devices() : DEVICES, schema);
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

describe('DevicesPage', () => {
  it('lists devices with child names and spelled-out status', async () => {
    renderPage(<DevicesPage />, { api: fakeApi().api });
    const tablet = (await screen.findByRole('heading', { name: 'Kitchen tablet' })).closest('li')!;
    expect(within(tablet).getByText(/Riley’s device · iPhone or iPad/)).toBeTruthy();
    expect(within(tablet).getByText('Status: Connected')).toBeTruthy();
    const phone = screen.getByRole('heading', { name: 'Old phone' }).closest('li')!;
    expect(within(phone).getByText(/Status: Disconnected on/)).toBeTruthy();
    expect(within(phone).queryByRole('button')).toBeNull();
  });

  it('disconnects a device after confirmation and reloads', async () => {
    const user = userEvent.setup();
    const { api, sends, gets } = fakeApi({ send: () => ({ ok: true }) });
    renderPage(<DevicesPage />, { api });
    const tablet = (await screen.findByRole('heading', { name: 'Kitchen tablet' })).closest('li')!;
    await user.click(within(tablet).getByRole('button', { name: 'Disconnect' }));
    expect(within(tablet).getByText(/Riley will be signed out on it/)).toBeTruthy();
    await user.click(within(tablet).getByRole('button', { name: 'Cancel' }));
    expect(sends).toHaveLength(0);
    await user.click(within(tablet).getByRole('button', { name: 'Disconnect' }));
    await user.click(within(tablet).getByRole('button', { name: 'Yes, disconnect' }));
    expect(sends).toEqual([
      { method: 'POST', path: `/v1/devices/${TABLET}/revoke`, body: undefined },
    ]);
    await waitFor(() => expect(gets.filter((p) => p === '/v1/devices').length).toBe(2));
  });

  it('explains step-up when disconnecting needs the PIN', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi({
      send: () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403),
    });
    renderPage(<DevicesPage />, { api });
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    await user.click(screen.getByRole('button', { name: 'Yes, disconnect' }));
    expect(
      await screen.findByText(/Disconnecting a device needs a recent PIN unlock/),
    ).toBeTruthy();
  });

  it('shows an empty state that points to pairing', async () => {
    renderPage(<DevicesPage />, { api: fakeApi({ devices: () => ({ devices: [] }) }).api });
    expect(await screen.findByText('No devices connected yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Children page' })).toBeTruthy();
  });

  it('shows an error state with retry', async () => {
    renderPage(<DevicesPage />, {
      api: fakeApi({
        devices: () => new ApiRequestError('NETWORK', 'You appear to be offline.', 0),
      }).api,
    });
    expect(await screen.findByText('You appear to be offline.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
