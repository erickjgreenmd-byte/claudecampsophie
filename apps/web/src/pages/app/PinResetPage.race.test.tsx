import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { ApiClient } from '@pencillift/contracts/client';
import {
  isTwoStepLookupUnavailable,
  type AccountAuth,
  type AuthAdapter,
  type AuthOutcome,
  type ParentSession,
} from '../../lib/auth.ts';
import { SessionProvider } from '../../lib/session.tsx';
import { createSupabaseAuth } from '../../lib/supabase-auth.ts';
import PinResetPage from './PinResetPage.tsx';

/**
 * WEBR4-05: WEB-R2-08's two-step re-verification only protects an owner if the decision is a
 * resolved precondition of the password grant. `verifiedTotpFactorId()` is a network call
 * (auth.mfa.listFactors()), so gating the step on state filled by an unawaited effect loses the race
 * whenever the parent submits an autofilled password first, and a rejected lookup read as "no
 * two-step" has the same effect. Either way the grant replaces the aal2 session with a fresh aal1
 * one, the warning is never shown, the two-step form is never rendered, and every /admin page then
 * refuses with "Owner administration requires an MFA session" — the exact failure WEB-R2-08 exists to
 * prevent. Synthetic email, PIN and code only; no network.
 */

afterEach(cleanup);

const SESSION: ParentSession = { accessToken: 'synthetic-token', email: 'pat.parent@example.test' };

function baseAccount(overrides: Partial<AccountAuth>): AccountAuth {
  return {
    signInWithPassword: () => Promise.resolve<AuthOutcome>({ ok: true, next: 'signed_in' }),
    signUp: () => Promise.resolve({ ok: true, next: 'check_email' }),
    sendMagicLink: () => Promise.resolve({ ok: true, next: 'check_email' }),
    sendPasswordReset: () => Promise.resolve({ ok: true, next: 'check_email' }),
    updatePassword: () => Promise.resolve({ ok: true, next: 'done' }),
    assuranceLevel: () => Promise.resolve('aal2'),
    enrollTotp: () => Promise.resolve({ error: 'not used here' }),
    verifyTotp: () => Promise.resolve<AuthOutcome>({ ok: true, next: 'done' }),
    verifiedTotpFactorId: () => Promise.resolve('synthetic-factor'),
    ...overrides,
  };
}

function renderPage(account: AccountAuth, send: ApiClient['send']) {
  return renderWithAuth(
    {
      configured: true,
      account,
      currentSession: () => Promise.resolve(SESSION),
      signOut: () => Promise.resolve(),
    },
    send,
  );
}

function renderWithAuth(auth: AuthAdapter, send: ApiClient['send']) {
  const router = createMemoryRouter(
    [{ path: '/app/security/reset-pin', element: <PinResetPage /> }],
    { initialEntries: ['/app/security/reset-pin'] },
  );
  render(
    <SessionProvider
      value={{
        config: { apiBaseUrl: '/api', supabaseUrl: null, supabasePublishableKey: null },
        auth,
        api: { get: () => Promise.reject(new Error('unexpected GET')), send },
      }}
    >
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return router;
}

async function confirmPassword() {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Account password'), 'synthetic-current-pass');
  await user.click(screen.getByRole('button', { name: 'Confirm it’s you' }));
  return user;
}

describe('WEBR4-05 the owner’s aal2 path does not depend on a race', () => {
  it('still asks for the two-step code when the factor lookup lands after the password submit', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const signInWithPassword = vi.fn(() =>
      Promise.resolve<AuthOutcome>({ ok: true, next: 'signed_in' }),
    );
    const send = vi.fn(() => Promise.resolve({ ok: true }));
    const account = baseAccount({
      signInWithPassword,
      // The lookup is a network call; here it resolves only once the parent has already submitted.
      verifiedTotpFactorId: () => gate.then(() => 'synthetic-factor'),
    });
    renderPage(account, send as unknown as ApiClient['send']);
    const user = await confirmPassword();
    release();

    expect(await screen.findByLabelText('Six-digit code from your authenticator app')).toBeTruthy();
    expect(screen.queryByLabelText('New 6-digit PIN')).toBeNull();
    // The grant may only happen once the decision is known, and the PIN must not be reachable
    // before the authenticator code has restored aal2.
    expect(send).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Six-digit code from your authenticator app'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirm two-step code' }));
    expect(await screen.findByLabelText('New 6-digit PIN')).toBeTruthy();
  });

  it('refuses the password submit when the factor lookup fails, instead of reading it as “no two-step”', async () => {
    const signInWithPassword = vi.fn(() =>
      Promise.resolve<AuthOutcome>({ ok: true, next: 'signed_in' }),
    );
    const send = vi.fn(() => Promise.resolve({ ok: true }));
    const account = baseAccount({
      signInWithPassword,
      verifiedTotpFactorId: () => Promise.reject(new Error('synthetic listFactors failure')),
    });
    renderPage(account, send as unknown as ApiClient['send']);
    await confirmPassword();

    expect((await screen.findByRole('alert')).textContent).toMatch(/two-step verification/i);
    // Nothing destructive happened: the aal2 session is untouched and the PIN step is unreachable.
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('New 6-digit PIN')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('retries the lookup on the next attempt rather than caching the failure', async () => {
    // Two rejections: the first is consumed by the lookup started on mount, the second by the
    // parent's first submit (which is therefore refused). The third call succeeds.
    const factorId = vi
      .fn()
      .mockRejectedValueOnce(new Error('synthetic listFactors failure'))
      .mockRejectedValueOnce(new Error('synthetic listFactors failure'))
      .mockResolvedValue('synthetic-factor');
    const send = vi.fn(() => Promise.resolve({ ok: true }));
    const account = baseAccount({ verifiedTotpFactorId: factorId as () => Promise<string> });
    renderPage(account, send as unknown as ApiClient['send']);
    const user = await confirmPassword();
    expect(await screen.findByRole('alert')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Confirm it’s you' }));
    expect(await screen.findByLabelText('Six-digit code from your authenticator app')).toBeTruthy();
  });

  it('still goes straight to the new PIN for a parent with no two-step factor', async () => {
    const send = vi.fn(() => Promise.resolve({ ok: true }));
    const account = baseAccount({
      assuranceLevel: () => Promise.resolve('aal1'),
      verifiedTotpFactorId: () => Promise.resolve(null),
    });
    renderPage(account, send as unknown as ApiClient['send']);
    const user = await confirmPassword();
    await user.type(await screen.findByLabelText('New 6-digit PIN'), '284917');
    await user.type(screen.getByLabelText('Repeat the new PIN'), '284917');
    await user.click(screen.getByRole('button', { name: 'Save new PIN' }));
    expect(await screen.findByText(/Your new PIN is saved/)).toBeTruthy();
  });
});

/**
 * WEBR5-E-1: the same refusal, driven through the REAL Supabase adapter over a labeled fake client.
 * auth-js 2.116.0 reports a failed `mfa.listFactors()` (and a failed
 * `mfa.getAuthenticatorAssuranceLevel()`) as `{ data: null, error }` and never rejects — `_getUser`
 * catches every AuthError, AuthRetryableFetchError included — so the fixtures above, which reject,
 * proved the "unavailable" branch only for an adapter shape production does not have. Offline, the
 * adapter answered `null`, which is byte-identical to "this account has no verified factor", so the
 * page read a failed lookup as "no two-step" and an owner's own PIN reset dropped their aal2 session.
 *
 * Synthetic email, password, PIN and factor id only; the Supabase client is a labeled fake (no
 * network) and no real project URL or key is used.
 */
const SUPABASE_CONFIG = {
  apiBaseUrl: '/api',
  supabaseUrl: 'https://example.supabase.co',
  supabasePublishableKey: 'sb_publishable_test',
};

/** auth-js's answer shapes for the two MFA lookups, as values — never as rejections. */
interface FakeMfa {
  getAuthenticatorAssuranceLevel: () => Promise<unknown>;
  listFactors: () => Promise<unknown>;
}

const AAL2_OK = { data: { currentLevel: 'aal2' }, error: null };
const FETCH_FAILED = { data: null, error: { message: 'Failed to fetch' } };
const VERIFIED_FACTOR = {
  data: { totp: [{ id: 'synthetic-factor', status: 'verified' }] },
  error: null,
};

function adapterOverFakeClient(mfa: FakeMfa) {
  const signInWithPassword = vi.fn(() => Promise.resolve({ error: null }));
  const adapter = createSupabaseAuth(
    SUPABASE_CONFIG,
    () =>
      ({
        auth: {
          mfa,
          signInWithPassword,
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
  return { adapter, signInWithPassword };
}

describe('WEBR5-E-1 a two-step lookup that failed is never read as “no two-step”', () => {
  it('reports a failed factor lookup as unavailable rather than as “no verified factor”', async () => {
    const { adapter } = adapterOverFakeClient({
      getAuthenticatorAssuranceLevel: () => Promise.resolve(AAL2_OK),
      listFactors: () => Promise.resolve(FETCH_FAILED),
    });
    // `null` is how the adapter says "asked, and this account has no verified factor". A lookup that
    // never reached the server must not be spendable as that answer.
    const lookup = await adapter.account!.verifiedTotpFactorId();
    expect(lookup).not.toBeNull();
    expect(isTwoStepLookupUnavailable(lookup)).toBe(true);
  });

  it('refuses the password submit when the factor lookup fails at the network', async () => {
    const send = vi.fn(() => Promise.resolve({ ok: true }));
    const { adapter, signInWithPassword } = adapterOverFakeClient({
      getAuthenticatorAssuranceLevel: () => Promise.resolve(AAL2_OK),
      listFactors: () => Promise.resolve(FETCH_FAILED),
    });
    renderWithAuth(adapter, send as unknown as ApiClient['send']);
    await confirmPassword();

    expect((await screen.findByRole('alert')).textContent).toMatch(/two-step verification/i);
    // The aal2 session is untouched, so nothing was dropped and the PIN step is unreachable.
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('New 6-digit PIN')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses the password submit when the assurance-level lookup fails beside a real factor', async () => {
    const send = vi.fn(() => Promise.resolve({ ok: true }));
    const { adapter, signInWithPassword } = adapterOverFakeClient({
      getAuthenticatorAssuranceLevel: () => Promise.resolve(FETCH_FAILED),
      listFactors: () => Promise.resolve(VERIFIED_FACTOR),
    });
    renderWithAuth(adapter, send as unknown as ApiClient['send']);
    await confirmPassword();

    expect((await screen.findByRole('alert')).textContent).toMatch(/two-step verification/i);
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('New 6-digit PIN')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('asks again on the next attempt instead of keeping the failed answer for the page', async () => {
    const send = vi.fn(() => Promise.resolve({ ok: true }));
    // The lookup started on mount and the one the first submit awaits both fail; the third succeeds.
    const listFactors = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(FETCH_FAILED)
      .mockResolvedValueOnce(FETCH_FAILED)
      .mockResolvedValue(VERIFIED_FACTOR);
    const { adapter } = adapterOverFakeClient({
      getAuthenticatorAssuranceLevel: () => Promise.resolve(AAL2_OK),
      listFactors,
    });
    renderWithAuth(adapter, send as unknown as ApiClient['send']);
    const user = await confirmPassword();
    expect((await screen.findByRole('alert')).textContent).toMatch(/two-step verification/i);

    await user.click(screen.getByRole('button', { name: 'Confirm it’s you' }));
    expect(await screen.findByLabelText('Six-digit code from your authenticator app')).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });
});
