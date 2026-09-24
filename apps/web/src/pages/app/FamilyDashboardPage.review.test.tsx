import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { ConsentStatus, FamilyOverview } from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import FamilyDashboardPage from './FamilyDashboardPage.tsx';

/**
 * Independent review of the family vertical (web dashboard, consent banner). Synthetic data only.
 */

const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const CONSENT = 'ad5a6b7c-8d9e-4f0a-9b2c-3d4e5f6a7b8c';
const NEW_CONSENT = 'be6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';

const FAMILY: FamilyOverview = {
  id: '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60',
  displayName: 'The Test Family',
  timezone: 'America/Chicago',
  paidSlots: 1,
  billingConflict: null,
  managingChannel: null,
  children: [{ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'draft' }],
};

const PENDING: ConsentStatus = {
  state: 'pending',
  consentId: CONSENT,
  isTestProvider: false,
  configuredProviderIsTest: false,
  verifiedAt: null,
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
  const settle = <S extends z.ZodType>(value: unknown, schema: S) =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(schema.parse(value));
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(path: string, schema: S) =>
      settle(path === '/v1/consent' ? PENDING : FAMILY, schema),
    send: <S extends z.ZodType>(
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      body: unknown,
      schema: S,
    ) => {
      sends.push({ method, path, body });
      if (path === `/v1/consent/${CONSENT}/refresh`) {
        // Exactly what guardians.ts answers when the pending record's provider is no longer the
        // configured one (CONSENT_RULES.providerChanged).
        return settle(
          new ApiRequestError(
            'CONFLICT',
            'Start consent again with the current provider',
            409,
            'CONSENT_PROVIDER_CHANGED',
          ),
          schema,
        );
      }
      if (path === '/v1/consent/start') {
        return settle(
          {
            consentId: NEW_CONSENT,
            state: 'pending',
            redirectUrl: 'https://consent.example.test/start',
            isTestProvider: false,
          },
          schema,
        );
      }
      return settle(new Error(`unexpected ${method} ${path}`), schema);
    },
  };
  return { api, sends };
}

afterEach(cleanup);

describe('FamilyDashboardPage review', () => {
  it('[RV-family-5] a pending consent the API says must be restarted can actually be restarted', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi();
    renderPage(<FamilyDashboardPage />, { api });
    await user.click(await screen.findByRole('button', { name: 'Check status' }));
    expect(await screen.findByText('Start consent again with the current provider')).toBeTruthy();

    // The page tells the parent to start again, but hides "Start consent" in the pending state; the
    // only remaining control is "Withdraw consent" (a PIN step-up for a consent never given).
    const restart = screen.queryByRole('button', { name: /start consent/i });
    expect(restart, 'no way to restart a pending consent').not.toBeNull();
    await user.click(restart!);
    expect(sends.map((s) => s.path)).toContain('/v1/consent/start');
  });
});
