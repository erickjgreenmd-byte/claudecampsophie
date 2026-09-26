import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { ConsentStatus, FamilyOverview } from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import FamilyDashboardPage from './FamilyDashboardPage.tsx';

/**
 * WEB-R2-03: the family time zone was set once from the browser's guess when the family was created
 * and could never be corrected, although every schedule, review release and report is planned in
 * it; the family name had no edit either. Synthetic names only.
 */

const FAMILY = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';

const family: FamilyOverview = {
  id: FAMILY,
  displayName: 'Test Family',
  timezone: 'America/Chicago',
  paidSlots: 1,
  billingConflict: null,
  managingChannel: 'app_store',
  children: [{ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' }],
};

const consent: ConsentStatus = {
  state: 'verified',
  consentId: null,
  isTestProvider: true,
  configuredProviderIsTest: true,
  verifiedAt: '2026-09-01T12:00:00.000Z',
  withdrawnAt: null,
  policyVersion: '2026-09-v1',
  currentPolicyVersion: '2026-09-v1',
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeApi() {
  const sends: Call[] = [];
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      const value: unknown = path.startsWith('/v1/consent') ? consent : family;
      const parsed = schema.safeParse(value);
      return parsed.success ? Promise.resolve(parsed.data) : Promise.reject(parsed.error);
    },
    send: <S extends z.ZodType>(
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      body: unknown,
      schema: S,
    ) => {
      sends.push({ method, path, body });
      const value = {
        family: { id: FAMILY, displayName: 'The Riveras', timezone: 'Europe/Berlin' },
      };
      const parsed = schema.safeParse(value);
      return parsed.success ? Promise.resolve(parsed.data) : Promise.resolve(value as z.infer<S>);
    },
  };
  return { api, sends };
}

afterEach(cleanup);

describe('[WEB-R2-03] the family name and time zone can be corrected', () => {
  it('sends PATCH /v1/family with the new name and zone', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi();
    renderPage(<FamilyDashboardPage />, { api });
    await screen.findByRole('heading', { name: 'Test Family' });

    await user.click(screen.getByRole('button', { name: /edit family name and time zone/i }));
    const name = screen.getByLabelText(/family name/i);
    await user.clear(name);
    await user.type(name, 'The Riveras');
    const zone = screen.getByLabelText(/time zone/i);
    await user.clear(zone);
    await user.type(zone, 'Europe/Berlin');
    await user.click(screen.getByRole('button', { name: /^save family details$/i }));

    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({
      method: 'PATCH',
      path: '/v1/family',
      body: { displayName: 'The Riveras', timezone: 'Europe/Berlin' },
    });
  });

  it('refuses an empty name or zone in the browser without sending anything', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi();
    renderPage(<FamilyDashboardPage />, { api });
    await screen.findByRole('heading', { name: 'Test Family' });
    await user.click(screen.getByRole('button', { name: /edit family name and time zone/i }));
    await user.clear(screen.getByLabelText(/time zone/i));
    await user.click(screen.getByRole('button', { name: /^save family details$/i }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(sends).toHaveLength(0);
  });
});
