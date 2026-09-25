import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { ConsentStatus, FamilyOverview } from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { unconfiguredAuth } from '../../lib/auth.ts';
import { renderPage } from '../../test/render.tsx';
import FamilyDashboardPage from './FamilyDashboardPage.tsx';

// Synthetic data only (Riley, Sam).
const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const SAM = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const CONSENT = 'ad5a6b7c-8d9e-4f0a-9b2c-3d4e5f6a7b8c';

const FAMILY: FamilyOverview = {
  id: '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60',
  displayName: 'The Test Family',
  timezone: 'America/Chicago',
  paidSlots: 1,
  billingConflict: null,
  managingChannel: null,
  children: [
    { id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' },
    { id: SAM, nickname: 'Sam', gradeLevel: 1, ageBand: '5-7', status: 'draft' },
  ],
};

function consent(overrides: Partial<ConsentStatus> = {}): ConsentStatus {
  return {
    state: 'none',
    consentId: null,
    isTestProvider: false,
    configuredProviderIsTest: true,
    verifiedAt: null,
    withdrawnAt: null,
    policyVersion: null,
    currentPolicyVersion: '2026-09-v1',
    ...overrides,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeApi(
  options: {
    family?: () => unknown;
    consent?: () => unknown;
    send?: (call: Call) => unknown;
  } = {},
) {
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
      if (path === '/v1/consent')
        return settle(options.consent ? options.consent() : consent(), schema);
      return settle(options.family ? options.family() : FAMILY, schema);
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

describe('FamilyDashboardPage', () => {
  it('never shows family data without a configured parent sign-in', async () => {
    renderPage(<FamilyDashboardPage />, { auth: unconfiguredAuth });
    expect(await screen.findByText(/Parent sign-in isn’t available yet/)).toBeTruthy();
  });

  it('shows the family, children with status text, paid slots and links', async () => {
    renderPage(<FamilyDashboardPage />, { api: fakeApi().api });
    expect(await screen.findByRole('heading', { name: 'The Test Family' })).toBeTruthy();
    expect(screen.getByText(/Paid child slots:/).textContent).toContain('1 (1 in use)');
    expect(screen.getByText(/Draft: not active yet, no charge/)).toBeTruthy();
    expect(screen.getByText(/Active: uses a paid slot/)).toBeTruthy();
    for (const name of [
      'Children and pairing codes',
      'Connected devices',
      'Guardians',
      'Support',
    ]) {
      expect(screen.getByRole('link', { name })).toBeTruthy();
    }
  });

  it('starts consent honestly and labels the test environment', async () => {
    const user = userEvent.setup();
    let started = false;
    const { api, sends } = fakeApi({
      consent: () =>
        started
          ? consent({ state: 'pending', consentId: CONSENT, isTestProvider: true })
          : consent(),
      send: () => {
        started = true;
        return {
          consentId: CONSENT,
          state: 'pending',
          redirectUrl: 'https://consent.example.test/start',
          isTestProvider: true,
        };
      },
    });
    renderPage(<FamilyDashboardPage />, { api });
    expect(
      await screen.findByText('Parental consent is needed before PencilLift can check homework.'),
    ).toBeTruthy();
    expect(screen.getByText(/A checkbox or your parent PIN can’t replace it/)).toBeTruthy();
    expect(screen.getByText(/uses a development test consent service/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Start consent' }));
    expect(await screen.findByText('Consent is waiting for verification.')).toBeTruthy();
    expect(sends).toEqual([{ method: 'POST', path: '/v1/consent/start', body: {} }]);
    const link = screen.getByRole('link', { name: /Continue with the consent provider/ });
    expect(link.getAttribute('href')).toBe('https://consent.example.test/start');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByText(/not a\s+real verification/)).toBeTruthy();
  });

  it('checks a pending consent with the provider', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi({
      consent: () => consent({ state: 'pending', consentId: CONSENT, isTestProvider: true }),
      send: () =>
        consent({
          state: 'verified',
          consentId: CONSENT,
          isTestProvider: true,
          verifiedAt: '2026-09-24T15:00:00.000Z',
          policyVersion: '2026-09-v1',
        }),
    });
    renderPage(<FamilyDashboardPage />, { api });
    await user.click(await screen.findByRole('button', { name: 'Check status' }));
    expect(await screen.findByText('Consent status updated.')).toBeTruthy();
    expect(sends).toEqual([
      { method: 'POST', path: `/v1/consent/${CONSENT}/refresh`, body: undefined },
    ]);
  });

  it('restarts a pending consent (e.g. the provider changed) and offers no withdrawal for it', async () => {
    const user = userEvent.setup();
    const NEW_CONSENT = 'be6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
    const { api, sends } = fakeApi({
      consent: () =>
        consent({ state: 'pending', consentId: CONSENT, configuredProviderIsTest: false }),
      send: (call) =>
        call.path === '/v1/consent/start'
          ? {
              consentId: NEW_CONSENT,
              state: 'pending',
              redirectUrl: 'https://consent.example.test/again',
              isTestProvider: false,
            }
          : new ApiRequestError(
              'CONFLICT',
              'Start consent again with the current provider',
              409,
              'CONSENT_PROVIDER_CHANGED',
            ),
    });
    renderPage(<FamilyDashboardPage />, { api });
    expect(await screen.findByText('Consent is waiting for verification.')).toBeTruthy();
    // A consent that was never given is not "withdrawn" behind a PIN; it is restarted.
    expect(screen.queryByRole('button', { name: 'Withdraw consent' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Check status' }));
    expect(await screen.findByText('Start consent again with the current provider')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Start consent again' }));
    const link = await screen.findByRole('link', { name: /Continue with the consent provider/ });
    expect(link.getAttribute('href')).toBe('https://consent.example.test/again');
    expect(sends.map((c) => c.path)).toEqual([
      `/v1/consent/${CONSENT}/refresh`,
      '/v1/consent/start',
    ]);
  });

  it('shows verified consent from a test provider with an honest note, and withdraws it', async () => {
    const user = userEvent.setup();
    let withdrawn = false;
    const { api, sends } = fakeApi({
      consent: () =>
        withdrawn
          ? consent({
              state: 'withdrawn',
              consentId: CONSENT,
              isTestProvider: true,
              withdrawnAt: '2026-09-25T15:00:00.000Z',
              policyVersion: '2026-09-v1',
            })
          : consent({
              state: 'verified',
              consentId: CONSENT,
              isTestProvider: true,
              verifiedAt: '2026-09-24T15:00:00.000Z',
              policyVersion: '2026-09-v1',
            }),
      send: () => {
        withdrawn = true;
        return { state: 'withdrawn', cancelledJobs: 2 };
      },
    });
    renderPage(<FamilyDashboardPage />, { api });
    expect(await screen.findByText(/^Consent verified on/)).toBeTruthy();
    expect(screen.getByText(/this consent came from a development test service/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Withdraw consent' }));
    // The confirmation says what withdrawal stops (CS-R1-01): devices out, no pairing, no practice,
    // and that an already-filed safety notice is still sent (CS-R1-02).
    const confirm = screen.getByRole('group', { name: 'Confirm withdrawal' }).textContent ?? '';
    expect(confirm).toMatch(/every paired child device is signed out/);
    expect(confirm).toMatch(/no device can be paired until consent is given again/);
    expect(confirm).toMatch(/no new practice is built/);
    expect(confirm).toMatch(/safety notice that was already on its way is still sent/);
    await user.click(screen.getByRole('button', { name: 'Yes, withdraw consent' }));
    expect(
      await screen.findByText(
        'Consent withdrawn. 2 waiting homework tasks were cancelled and your children’s devices were signed out.',
      ),
    ).toBeTruthy();
    expect(sends).toEqual([{ method: 'POST', path: '/v1/consent/withdraw', body: {} }]);
    expect(await screen.findByText('Consent was withdrawn.')).toBeTruthy();
    expect(
      screen.getByText(/devices stay signed out until you pair them again/).textContent,
    ).toMatch(/won’t process new homework or build practice/);
    expect(screen.getByRole('button', { name: 'Start consent' })).toBeTruthy();
  });

  it('explains step-up when withdrawing needs the PIN', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi({
      consent: () =>
        consent({
          state: 'verified',
          consentId: CONSENT,
          verifiedAt: '2026-09-24T15:00:00.000Z',
          policyVersion: '2026-09-v1',
        }),
      send: () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403),
    });
    renderPage(<FamilyDashboardPage />, { api });
    await user.click(await screen.findByRole('button', { name: 'Withdraw consent' }));
    await user.click(screen.getByRole('button', { name: 'Yes, withdraw consent' }));
    expect(await screen.findByText(/Withdrawing consent needs a recent PIN unlock/)).toBeTruthy();
  });

  it('creates a family on first run', async () => {
    const user = userEvent.setup();
    let created = false;
    const { api, sends } = fakeApi({
      family: () =>
        created ? FAMILY : new ApiRequestError('NOT_FOUND', 'Create your family first', 404),
      send: () => {
        created = true;
        return { familyId: FAMILY.id };
      },
    });
    renderPage(<FamilyDashboardPage />, { api });
    await user.type(await screen.findByLabelText('Family name'), '  The Test Family ');
    await user.clear(screen.getByLabelText('Time zone'));
    await user.type(screen.getByLabelText('Time zone'), 'America/Chicago');
    await user.click(screen.getByRole('button', { name: 'Create family' }));
    expect(await screen.findByRole('heading', { name: 'The Test Family' })).toBeTruthy();
    expect(sends).toEqual([
      {
        method: 'POST',
        path: '/v1/families',
        body: { displayName: 'The Test Family', timezone: 'America/Chicago' },
      },
    ]);
  });

  it('shows why an unverified adult cannot create a family', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi({
      family: () => new ApiRequestError('NOT_FOUND', 'Create your family first', 404),
      send: () => new ApiRequestError('FORBIDDEN', 'Verify your email first', 403),
    });
    renderPage(<FamilyDashboardPage />, { api });
    await user.type(await screen.findByLabelText('Family name'), 'Test');
    await user.click(screen.getByRole('button', { name: 'Create family' }));
    expect(await screen.findByText('Verify your email first')).toBeTruthy();
  });

  it('shows an error state with retry', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const { api } = fakeApi({
      family: () => {
        calls += 1;
        return calls === 1
          ? new ApiRequestError('NETWORK', 'You appear to be offline.', 0)
          : FAMILY;
      },
    });
    renderPage(<FamilyDashboardPage />, { api });
    expect(await screen.findByText('You appear to be offline.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'The Test Family' })).toBeTruthy(),
    );
  });
});
