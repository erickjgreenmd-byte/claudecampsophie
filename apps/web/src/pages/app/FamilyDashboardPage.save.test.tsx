import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { ConsentStatus, FamilyOverview } from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import FamilyDashboardPage from './FamilyDashboardPage.tsx';

/**
 * Round-4 hardening of the WEB-R2-03 family-details form. Synthetic names only.
 *
 *  - WEBR4-04 the success message lived inside the collapsible form, which onSaved() unmounted, so a
 *    save that worked showed no confirmation at all; when the reload that followed failed,
 *    useLastGood kept the OLD name and zone on screen next to an error banner, so the parent
 *    concluded the save had failed and retried while the server had already changed the zone every
 *    release, review and report is planned in.
 *  - WEBR4-03 the form always sent displayName + timezone, so correcting only the name reverted the
 *    other guardian's time-zone change.
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

/** `familyReloadFails`: the GET after a successful PATCH rejects, as an offline blip would. */
function fakeApi(options: { familyReloadFails?: boolean } = {}) {
  const sends: Call[] = [];
  let familyGets = 0;
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      if (path.startsWith('/v1/consent')) return Promise.resolve(schema.parse(consent));
      familyGets += 1;
      if (options.familyReloadFails && familyGets > 1) {
        return Promise.reject(new ApiRequestError('NETWORK', 'Network request failed', 0));
      }
      return Promise.resolve(schema.parse(family));
    },
    send: <S extends z.ZodType>(
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      body: unknown,
      schema: S,
    ) => {
      sends.push({ method, path, body });
      const value = {
        family: { id: FAMILY, displayName: 'The Riveras', timezone: 'America/Chicago' },
      };
      return Promise.resolve(schema.parse(value));
    },
  };
  return { api, sends };
}

afterEach(cleanup);

async function openForm(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { name: 'Test Family' });
  await user.click(screen.getByRole('button', { name: /edit family name and time zone/i }));
}

describe('[WEBR4-04] a saved family change is confirmed where the parent can see it', () => {
  it('shows the success message after the form closes, even when the reload fails', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi({ familyReloadFails: true });
    renderPage(<FamilyDashboardPage />, { api });
    await openForm(user);
    const name = screen.getByLabelText(/family name/i);
    await user.clear(name);
    await user.type(name, 'The Riveras');
    await user.click(screen.getByRole('button', { name: /^save family details$/i }));

    await waitFor(() => expect(sends).toHaveLength(1));
    const status = await screen.findByRole('status');
    expect(status.textContent).toMatch(/saved/i);
    expect(status.textContent).toMatch(/The Riveras/);
  });
});

describe('[WEBR4-03] a family edit sends only the fields the parent changed', () => {
  it('sends the name alone, so the other guardian’s time-zone change survives', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi();
    renderPage(<FamilyDashboardPage />, { api });
    await openForm(user);
    const name = screen.getByLabelText(/family name/i);
    await user.clear(name);
    await user.type(name, 'The Riveras');
    await user.click(screen.getByRole('button', { name: /^save family details$/i }));

    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.body).toEqual({ displayName: 'The Riveras' });
  });

  it('keeps the save button disabled while nothing has been changed', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi();
    renderPage(<FamilyDashboardPage />, { api });
    await openForm(user);
    expect(screen.getByRole('button', { name: /^save family details$/i })).toHaveProperty(
      'disabled',
      true,
    );
  });
});
