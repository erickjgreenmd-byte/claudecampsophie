import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { SessionProvider } from '../../lib/session.tsx';
import { createSupabaseAuth } from '../../lib/supabase-auth.ts';
import MfaPage from './MfaPage.tsx';

/**
 * Owner two-step verification (spec P14, AC_MON_15). /admin/mfa is the only place a TOTP factor is
 * enrolled and the only place this session is raised to aal2, and until now it had no test at all.
 *
 * WEBR5-E-1 is the property under test: a two-step lookup that FAILED must never be spent as "this
 * account has no second factor". auth-js 2.116.0 answers a failed `mfa.listFactors()` or
 * `mfa.getAuthenticatorAssuranceLevel()` with `{ data: null, error }` and never rejects (`_getUser`
 * catches every AuthError, AuthRetryableFetchError included), so offline — a hotel captive portal, an
 * auth outage — the lookup used to come back indistinguishable from an empty factor list. This page
 * would then offer "Set up two-step verification" to an owner who already has one, and the enrollment
 * it started puts a second factor in the account that their authenticator app does not hold.
 *
 * The adapter under test is the REAL one, over a labeled fake Supabase client that answers with
 * auth-js's own value shapes: a fixture that rejects would prove the refusal only for an adapter
 * shape production does not have (L-046). No network, no real project URL or key; the email, factor
 * id, secret and code are synthetic.
 */

afterEach(cleanup);

const SUPABASE_CONFIG = {
  apiBaseUrl: '/api',
  supabasePublishableKey: 'sb_publishable_test',
  supabaseUrl: 'https://example.supabase.co',
};

/** The two MFA lookups the page settles its precondition from, as auth-js resolves them. */
interface FakeMfa {
  getAuthenticatorAssuranceLevel: () => Promise<unknown>;
  listFactors: () => Promise<unknown>;
}

const AAL1_OK = { data: { currentLevel: 'aal1' }, error: null };
const AAL2_OK = { data: { currentLevel: 'aal2' }, error: null };
/** Exactly what auth-js resolves with when the lookup could not be made (offline, outage). */
const FETCH_FAILED = { data: null, error: { message: 'Failed to fetch' } };
const NO_FACTORS = { data: { totp: [] }, error: null };
const VERIFIED_FACTOR = {
  data: { totp: [{ id: 'synthetic-factor', status: 'verified' }] },
  error: null,
};

function pageOverFakeClient(mfa: FakeMfa) {
  const enroll = vi.fn(() =>
    Promise.resolve({
      data: {
        id: 'synthetic-new-factor',
        totp: { qr_code: 'data:image/svg+xml,synthetic', secret: 'SYNTHETICSECRET' },
      },
      error: null,
    }),
  );
  const challengeAndVerify = vi.fn(() => Promise.resolve({ error: null }));
  const adapter = createSupabaseAuth(
    SUPABASE_CONFIG,
    () =>
      ({
        auth: {
          mfa: { ...mfa, enroll, challengeAndVerify },
          getSession: () =>
            Promise.resolve({
              data: {
                session: {
                  access_token: 'synthetic-token',
                  user: { email: 'pat.parent@example.test' },
                },
              },
            }),
          onAuthStateChange: () => ({
            data: { subscription: { unsubscribe: () => undefined } },
          }),
        },
      }) as never,
  );
  const router = createMemoryRouter([{ path: '/admin/mfa', element: <MfaPage /> }], {
    initialEntries: ['/admin/mfa'],
  });
  render(
    <SessionProvider
      value={{
        config: { apiBaseUrl: '/api', supabaseUrl: null, supabasePublishableKey: null },
        auth: adapter,
        // This page talks only to the auth service; any API call here is a mistake.
        api: {
          get: () => Promise.reject(new Error('unexpected GET')),
          send: () => Promise.reject(new Error('unexpected send')),
        },
      }}
    >
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return { enroll, challengeAndVerify };
}

const START_SETUP = { name: 'Start setup' } as const;

describe('WEBR5-E-1 a failed two-step lookup never offers a fresh enrollment', () => {
  it('refuses, and offers no setup, when the factor list could not be read', async () => {
    const { enroll } = pageOverFakeClient({
      getAuthenticatorAssuranceLevel: () => Promise.resolve(AAL1_OK),
      listFactors: () => Promise.resolve(FETCH_FAILED),
    });

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /could not check your two-step verification/i,
    );
    // The owner may already have a factor. Offering a second one, or the heading that invites it, is
    // the loss WEBR5-E-1 exists to prevent — their authenticator app would not hold the new one.
    expect(screen.queryByRole('button', START_SETUP)).toBeNull();
    expect(screen.queryByRole('heading', { name: /set up two-step verification/i })).toBeNull();
    expect(enroll).not.toHaveBeenCalled();
    // Nor is the code form shown: there is no known factor to challenge.
    expect(screen.queryByLabelText('6-digit code')).toBeNull();
  });

  it('refuses, and offers no setup, when the assurance level could not be read beside a real factor', async () => {
    const { enroll } = pageOverFakeClient({
      getAuthenticatorAssuranceLevel: () => Promise.resolve(FETCH_FAILED),
      listFactors: () => Promise.resolve(VERIFIED_FACTOR),
    });

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /could not check your two-step verification/i,
    );
    expect(screen.queryByRole('button', START_SETUP)).toBeNull();
    expect(enroll).not.toHaveBeenCalled();
  });

  it('refuses, and offers no setup, when neither lookup could be made', async () => {
    const { enroll } = pageOverFakeClient({
      getAuthenticatorAssuranceLevel: () => Promise.resolve(FETCH_FAILED),
      listFactors: () => Promise.resolve(FETCH_FAILED),
    });

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /could not check your two-step verification/i,
    );
    expect(screen.queryByRole('button', START_SETUP)).toBeNull();
    expect(enroll).not.toHaveBeenCalled();
    // Honest about having changed nothing, so re-opening the page is safe.
    expect((await screen.findByRole('alert')).textContent).toMatch(/nothing has been changed/i);
  });

  /**
   * The refusal above only means something if a readable "this account has no factor" still reaches
   * the enrollment: an assertion that can never see the button is not an assertion. Same page, same
   * adapter, the one difference being that the lookups answered.
   */
  it('still offers the setup when the lookups answered and there is no factor', async () => {
    const { enroll } = pageOverFakeClient({
      getAuthenticatorAssuranceLevel: () => Promise.resolve(AAL1_OK),
      listFactors: () => Promise.resolve(NO_FACTORS),
    });

    const start = await screen.findByRole('button', START_SETUP);
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.setup().click(start);
    expect(await screen.findByText('SYNTHETICSECRET')).toBeTruthy();
    expect(enroll).toHaveBeenCalledWith({ factorType: 'totp' });
    // The enrolled factor is the one the code is then checked against.
    expect(await screen.findByLabelText('6-digit code')).toBeTruthy();
  });

  it('asks an owner who already has a verified factor for a code, not for a new enrollment', async () => {
    const { enroll, challengeAndVerify } = pageOverFakeClient({
      getAuthenticatorAssuranceLevel: () => Promise.resolve(AAL1_OK),
      listFactors: () => Promise.resolve(VERIFIED_FACTOR),
    });

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('6-digit code'), '284917');
    expect(screen.queryByRole('button', START_SETUP)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(challengeAndVerify).toHaveBeenCalledWith({
      factorId: 'synthetic-factor',
      code: '284917',
    });
    expect(enroll).not.toHaveBeenCalled();
    expect(await screen.findByText(/Verified\./)).toBeTruthy();
  });

  it('says two-step is already active for an aal2 session, and offers no setup', async () => {
    // An aal2 session has provably verified a factor already, so an unreadable factor list cannot
    // turn this into an enrollment offer either.
    const { enroll } = pageOverFakeClient({
      getAuthenticatorAssuranceLevel: () => Promise.resolve(AAL2_OK),
      listFactors: () => Promise.resolve(FETCH_FAILED),
    });

    expect(
      await screen.findByText(/Two-step verification is active for this session/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', START_SETUP)).toBeNull();
    expect(enroll).not.toHaveBeenCalled();
  });
});
