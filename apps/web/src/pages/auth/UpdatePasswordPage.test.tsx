import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { ApiClient } from '@pencillift/contracts/client';
import type { AccountAuth, AuthAdapter, AuthOutcome, ParentSession } from '../../lib/auth.ts';
import { RequireParent, SessionProvider } from '../../lib/session.tsx';
import {
  createSupabaseAuth,
  maskEmail,
  type RecoveryLinkAuth,
  type RecoveryLinkOutcome,
} from '../../lib/supabase-auth.ts';
import UpdatePasswordPage from './UpdatePasswordPage.tsx';

/**
 * R2C-WEB-3: the mobile app's Supabase client uses the implicit flow, so a reset link requested on
 * the phone lands on `/update-password#access_token=…&refresh_token=…&type=recovery`. The web client
 * is PKCE and ignores that hash; this page must adopt it (the auth server verifies the token), clear
 * it from the address bar, and say which account the new password is for. Every other flow and
 * every other page keeps today's behaviour.
 *
 * All tokens and emails below are synthetic. The auth clients are labeled fakes (no network).
 */

afterEach(cleanup);

const RECOVERY_HASH =
  '#access_token=synthetic-access&expires_at=1790000000&expires_in=3600&refresh_token=synthetic-refresh&token_type=bearer&type=recovery';

/**
 * Labeled fake account: the recovery-link capability is a vi.fn the tests control.
 *
 * WEB-R4-AUTH-1: it also carries `recoveryActive`, as the real adapter does, and an accepted link
 * opens that grant exactly where `acceptRecoveryLink` opens it in production (supabase-auth.ts). The
 * page reads the grant from the adapter alone now, so a fake without it would not be this flow.
 */
function fakeAccount(
  accept: RecoveryLinkAuth['acceptRecoveryLink'],
  updatePassword = vi.fn(() => Promise.resolve<AuthOutcome>({ ok: true, next: 'done' })),
): AccountAuth & RecoveryLinkAuth & { recoveryActive(): boolean } {
  let grantOpen = false;
  return {
    recoveryActive: () => grantOpen,
    signInWithPassword: () => Promise.resolve({ ok: true, next: 'signed_in' }),
    signUp: () => Promise.resolve({ ok: true, next: 'check_email' }),
    sendMagicLink: () => Promise.resolve({ ok: true, next: 'check_email' }),
    sendPasswordReset: () => Promise.resolve({ ok: true, next: 'check_email' }),
    updatePassword,
    assuranceLevel: () => Promise.resolve('aal1'),
    enrollTotp: () => Promise.resolve({ error: 'not used here' }),
    verifyTotp: () => Promise.resolve({ ok: true, next: 'done' }),
    verifiedTotpFactorId: () => Promise.resolve(null),
    acceptRecoveryLink: async (tokens) => {
      const outcome = await accept(tokens);
      if (outcome.ok) grantOpen = true;
      return outcome;
    },
  };
}

function authWith(account: AccountAuth, session: ParentSession | null = null): AuthAdapter {
  return {
    configured: true,
    account,
    currentSession: () => Promise.resolve(session),
    signOut: () => Promise.resolve(),
  };
}

const api: ApiClient = {
  get: () => Promise.reject(new Error('unexpected GET')),
  send: () => Promise.reject(new Error('unexpected send')),
};

function renderAt(url: string, auth: AuthAdapter) {
  const family: ReactElement = (
    <RequireParent>
      <p>Family data for Riley</p>
    </RequireParent>
  );
  const router = createMemoryRouter(
    [
      { path: '/app', element: family },
      { path: '/update-password', element: <UpdatePasswordPage /> },
    ],
    { initialEntries: [url] },
  );
  render(
    <SessionProvider
      value={{
        config: { apiBaseUrl: '/api', supabaseUrl: null, supabasePublishableKey: null },
        auth,
        api,
      }}
    >
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return router;
}

describe('R2C-WEB-3 maskEmail', () => {
  it('keeps the first letter and the domain only', () => {
    expect(maskEmail('pat.parent@example.test')).toBe('p•••@example.test');
    expect(maskEmail('p@example.test')).toBe('p•••@example.test');
    expect(maskEmail('not-an-email')).toBe('n•••');
  });
});

describe('R2C-WEB-3 /update-password adopts a mobile (implicit-flow) recovery link', () => {
  it('signs in with the hash tokens, clears the hash at once and names the masked account', async () => {
    const accept = vi.fn(() =>
      Promise.resolve<RecoveryLinkOutcome>({ ok: true, email: 'pat.parent@example.test' }),
    );
    const updatePassword = vi.fn(() => Promise.resolve<AuthOutcome>({ ok: true, next: 'done' }));
    const router = renderAt(
      `/update-password${RECOVERY_HASH}`,
      authWith(fakeAccount(accept, updatePassword)),
    );
    expect(await screen.findByText('Set a new password for p•••@example.test')).toBeTruthy();
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith({
      accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh',
    });
    expect(router.state.location.pathname).toBe('/update-password');
    expect(router.state.location.hash).toBe('');
    expect(screen.queryByText(/synthetic-/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('New password'), 'a-long-synthetic-pass');
    await user.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await screen.findByText(/Your password is changed/)).toBeTruthy();
    expect(updatePassword).toHaveBeenCalledWith('a-long-synthetic-pass');
  });

  it('clears the hash before the auth server answers', async () => {
    let resolve: (value: RecoveryLinkOutcome) => void = () => undefined;
    const accept = vi.fn(
      () =>
        new Promise<RecoveryLinkOutcome>((r) => {
          resolve = r;
        }),
    );
    const router = renderAt(`/update-password${RECOVERY_HASH}`, authWith(fakeAccount(accept)));
    await waitFor(() => expect(accept).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(router.state.location.hash).toBe(''));
    expect(screen.queryByLabelText('New password')).toBeNull();
    resolve({ ok: true, email: 'pat.parent@example.test' });
    expect(await screen.findByText('Set a new password for p•••@example.test')).toBeTruthy();
  });

  it('adopts the link even when another account is already signed in here', async () => {
    const accept = vi.fn(() =>
      Promise.resolve<RecoveryLinkOutcome>({ ok: true, email: 'sam.guardian@example.test' }),
    );
    renderAt(
      `/update-password${RECOVERY_HASH}`,
      authWith(fakeAccount(accept), { accessToken: 'synthetic', email: 'pat@example.test' }),
    );
    expect(await screen.findByText('Set a new password for s•••@example.test')).toBeTruthy();
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it('a refused recovery token shows the failed-link notice with a new-link request', async () => {
    const accept = vi.fn(() => Promise.resolve<RecoveryLinkOutcome>({ ok: false }));
    const router = renderAt(`/update-password${RECOVERY_HASH}`, authWith(fakeAccount(accept)));
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/didn’t sign you in/);
    expect(screen.getByRole('link', { name: 'request a new link here' }).getAttribute('href')).toBe(
      '/reset-password',
    );
    expect(router.state.location.hash).toBe('');
    expect(screen.queryByLabelText('New password')).toBeNull();
  });

  it('a hash token without type=recovery keeps today’s failed-link notice and is not adopted', async () => {
    const accept = vi.fn(() =>
      Promise.resolve<RecoveryLinkOutcome>({ ok: true, email: 'pat.parent@example.test' }),
    );
    renderAt(
      '/update-password#access_token=synthetic-access&refresh_token=synthetic-refresh&type=magiclink',
      authWith(fakeAccount(accept)),
    );
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/didn’t sign you in/);
    expect(accept).not.toHaveBeenCalled();
  });

  it('a recovery hash without a refresh token is not adopted', async () => {
    const accept = vi.fn(() =>
      Promise.resolve<RecoveryLinkOutcome>({ ok: true, email: 'pat.parent@example.test' }),
    );
    renderAt(
      '/update-password#access_token=synthetic-access&type=recovery',
      authWith(fakeAccount(accept)),
    );
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/didn’t sign you in/);
    expect(accept).not.toHaveBeenCalled();
  });

  it('a recovery hash on any other page keeps today’s notice and is not adopted', async () => {
    const accept = vi.fn(() =>
      Promise.resolve<RecoveryLinkOutcome>({ ok: true, email: 'pat.parent@example.test' }),
    );
    const router = renderAt(`/app${RECOVERY_HASH}`, authWith(fakeAccount(accept)));
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/didn’t sign you in/);
    expect(screen.getByRole('link', { name: 'request a new link here' }).getAttribute('href')).toBe(
      '/sign-in',
    );
    expect(accept).not.toHaveBeenCalled();
    expect(router.state.location.hash).toBe(RECOVERY_HASH);
  });
});

describe('R2C-WEB-3 Supabase adapter acceptRecoveryLink (labeled fake client, no network)', () => {
  const config = {
    apiBaseUrl: '/api',
    supabaseUrl: 'https://example.supabase.co',
    supabasePublishableKey: 'sb_publishable_test',
  };
  function stubClient(auth: Record<string, unknown>) {
    return () => ({ auth }) as never;
  }
  function recovery(adapter: AuthAdapter): RecoveryLinkAuth {
    return adapter.account as AccountAuth & RecoveryLinkAuth;
  }

  it('hands both tokens to setSession and returns the verified account email', async () => {
    const setSession = vi.fn(() =>
      Promise.resolve({
        data: {
          user: { email: 'pat.parent@example.test' },
          session: { access_token: 'synthetic-access', user: { email: 'pat.parent@example.test' } },
        },
        error: null,
      }),
    );
    const adapter = createSupabaseAuth(config, stubClient({ setSession }));
    expect(
      await recovery(adapter).acceptRecoveryLink({
        accessToken: 'synthetic-access',
        refreshToken: 'synthetic-refresh',
      }),
    ).toEqual({ ok: true, email: 'pat.parent@example.test' });
    expect(setSession).toHaveBeenCalledWith({
      access_token: 'synthetic-access',
      refresh_token: 'synthetic-refresh',
    });
  });

  it('reports a refused, missing or throwing verification as a failed link', async () => {
    const tokens = { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' };
    const refused = createSupabaseAuth(
      config,
      stubClient({
        setSession: () =>
          Promise.resolve({
            data: { user: null, session: null },
            error: { message: 'invalid JWT' },
          }),
      }),
    );
    expect(await recovery(refused).acceptRecoveryLink(tokens)).toEqual({ ok: false });
    const empty = createSupabaseAuth(
      config,
      stubClient({
        setSession: () => Promise.resolve({ data: { user: null, session: null }, error: null }),
      }),
    );
    expect(await recovery(empty).acceptRecoveryLink(tokens)).toEqual({ ok: false });
    const throwing = createSupabaseAuth(
      config,
      stubClient({ setSession: () => Promise.reject(new Error('malformed token')) }),
    );
    expect(await recovery(throwing).acceptRecoveryLink(tokens)).toEqual({ ok: false });
    // An error or a missing session refuses the link even when an email is present: the email
    // alone never proves the auth server accepted the token.
    const user = { email: 'pat.parent@example.test' };
    const erroredWithUser = createSupabaseAuth(
      config,
      stubClient({
        setSession: () =>
          Promise.resolve({
            data: { user, session: { access_token: 'synthetic-access', user } },
            error: { message: 'session not found' },
          }),
      }),
    );
    expect(await recovery(erroredWithUser).acceptRecoveryLink(tokens)).toEqual({ ok: false });
    const noSessionWithUser = createSupabaseAuth(
      config,
      stubClient({
        setSession: () => Promise.resolve({ data: { user, session: null }, error: null }),
      }),
    );
    expect(await recovery(noSessionWithUser).acceptRecoveryLink(tokens)).toEqual({ ok: false });
  });
});
