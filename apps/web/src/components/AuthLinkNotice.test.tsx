import { cleanup, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { ApiClient } from '@pencillift/contracts/client';
import type { AccountAuth, AuthAdapter, ParentSession } from '../lib/auth.ts';
import { RequireParent, SessionProvider } from '../lib/session.tsx';
import SignInPage from '../pages/auth/SignInPage.tsx';
import UpdatePasswordPage from '../pages/auth/UpdatePasswordPage.tsx';
import { readAuthLinkProblem } from './AuthLinkNotice.tsx';

/**
 * WEB-R1-07: Supabase email links use PKCE, so a link opened in another browser or device (or an
 * expired one) cannot sign the adult in. Supabase reports `error`, `error_code` and
 * `error_description` in the query or the hash, or (no code verifier in this browser) leaves an
 * unexchanged `?code=` behind. The portal must say so in plain words and offer a new link instead of
 * a bare sign-in prompt or a "request a new link" loop with no reason.
 */

afterEach(cleanup);

const PLAIN_WORDING =
  /Open this link in the browser you used to request it, or request a new link here/;

const account: AccountAuth = {
  signInWithPassword: () => Promise.resolve({ ok: true, next: 'signed_in' }),
  sendMagicLink: () => Promise.resolve({ ok: true, next: 'check_email' }),
  signUp: () => Promise.resolve({ ok: true, next: 'check_email' }),
  sendPasswordReset: () => Promise.resolve({ ok: true, next: 'check_email' }),
  updatePassword: () => Promise.resolve({ ok: true, next: 'done' }),
  assuranceLevel: () => Promise.resolve('aal1'),
  enrollTotp: () => Promise.resolve({ error: 'not used here' }),
  verifyTotp: () => Promise.resolve({ ok: true, next: 'done' }),
  verifiedTotpFactorId: () => Promise.resolve(null),
};

function authWith(session: ParentSession | null): AuthAdapter {
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

function renderAt(url: string, auth: AuthAdapter = authWith(null)) {
  const family: ReactElement = (
    <RequireParent>
      <p>Family data for Riley</p>
    </RequireParent>
  );
  const router = createMemoryRouter(
    [
      { path: '/app', element: family },
      { path: '/sign-in', element: <SignInPage /> },
      { path: '/update-password', element: <UpdatePasswordPage /> },
    ],
    { initialEntries: [url] },
  );
  return render(
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
}

const EXPIRED =
  'error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';

describe('WEB-R1-07 readAuthLinkProblem', () => {
  it('reads Supabase error parameters from the query and from the hash', () => {
    expect(readAuthLinkProblem(`?${EXPIRED}`, '')).toBe('expired');
    expect(readAuthLinkProblem('', `#${EXPIRED}`)).toBe('expired');
    expect(readAuthLinkProblem('?error=server_error', '')).toBe('failed');
    expect(readAuthLinkProblem('', '#error_description=Something+failed')).toBe('failed');
  });

  it('treats an unexchanged code or hash token as a link that could not sign in here', () => {
    expect(readAuthLinkProblem('?code=6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c', '')).toBe('failed');
    expect(readAuthLinkProblem('', '#access_token=synthetic&type=recovery')).toBe('failed');
  });

  it('ignores ordinary addresses, including a guardian invitation hash', () => {
    expect(readAuthLinkProblem('', '')).toBeNull();
    expect(readAuthLinkProblem('?next=%2Fapp', '#accept=synthetic-token')).toBeNull();
  });
});

describe('WEB-R1-07 pages explain a failed email link', () => {
  it('/update-password with an expired link (query) explains it and links to a new reset email', async () => {
    renderAt(`/update-password?${EXPIRED}`);
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/expired or was already used/);
    expect(notice.textContent).toMatch(PLAIN_WORDING);
    expect(screen.getByRole('link', { name: 'request a new link here' }).getAttribute('href')).toBe(
      '/reset-password',
    );
  });

  it('/update-password opened in another browser (unexchanged ?code=) explains it', async () => {
    renderAt('/update-password?code=6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c');
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/didn’t sign you in/);
    expect(notice.textContent).toMatch(PLAIN_WORDING);
  });

  it('/update-password without any link problem keeps the plain “request a new link” notice', async () => {
    renderAt('/update-password');
    expect(
      await screen.findByText(/This page opens from the reset link in your email/),
    ).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('/app with a hash error explains it above the sign-in prompt', async () => {
    renderAt(`/app#${EXPIRED}`);
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(PLAIN_WORDING);
    expect(screen.getByRole('link', { name: 'request a new link here' }).getAttribute('href')).toBe(
      '/sign-in',
    );
    expect(screen.getByRole('link', { name: 'sign in' })).toBeTruthy();
    expect(screen.queryByText(/Riley/)).toBeNull();
  });

  it('/app for a signed-in parent shows the family, not a stale link notice', async () => {
    renderAt(`/app?${EXPIRED}`, authWith({ accessToken: 'synthetic', email: 'p@example.test' }));
    expect(await screen.findByText('Family data for Riley')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('/sign-in with an error explains it above the form', async () => {
    renderAt('/sign-in?error=access_denied&error_description=Email+link+is+invalid');
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(PLAIN_WORDING);
    expect(screen.getByRole('heading', { name: 'Parent sign in' })).toBeTruthy();
  });
});
