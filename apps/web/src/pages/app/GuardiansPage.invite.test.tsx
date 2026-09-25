import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import type { AccountAuth, AuthAdapter, ParentSession } from '../../lib/auth.ts';
import { SessionProvider } from '../../lib/session.tsx';
import SignInPage from '../auth/SignInPage.tsx';
import SignUpPage from '../auth/SignUpPage.tsx';
import GuardiansPage from './GuardiansPage.tsx';

/**
 * WEB-R1-01: the invitation email links to `/app/guardians#accept=<token>`. An invited adult who is
 * not signed in yet (the usual case) must keep that token through sign-in (password, email link or
 * a new account) and land on the accept card, not on the "not part of a family yet" empty state.
 */

// Synthetic values only.
const TOKEN = 'k3Jx9QpL2mN8vB4cR7tY1wZ5aS6dF0gH-_eU3iO9pQ';
const FAMILY = '0b7c6d5e-4f3a-4b2c-9d1e-0f9a8b7c6d5e';
const INVITE_URL = `/app/guardians#accept=${TOKEN}`;

afterEach(cleanup);

/** An auth adapter that starts signed out and signs in on a password sign-in. */
function signedOutAuth() {
  let session: ParentSession | null = null;
  const listeners = new Set<() => void>();
  const redirects: { kind: 'magic_link' | 'sign_up'; to: string }[] = [];
  const account: AccountAuth = {
    signInWithPassword: (email) => {
      session = { accessToken: 'synthetic-token', email };
      listeners.forEach((listener) => listener());
      return Promise.resolve({ ok: true, next: 'signed_in' });
    },
    sendMagicLink: (_email, redirectTo) => {
      redirects.push({ kind: 'magic_link', to: redirectTo });
      return Promise.resolve({ ok: true, next: 'check_email' });
    },
    signUp: (_email, _password, redirectTo) => {
      redirects.push({ kind: 'sign_up', to: redirectTo });
      return Promise.resolve({ ok: true, next: 'check_email' });
    },
    sendPasswordReset: () => Promise.resolve({ ok: true, next: 'check_email' }),
    updatePassword: () => Promise.resolve({ ok: true, next: 'done' }),
    assuranceLevel: () => Promise.resolve('aal1'),
    enrollTotp: () => Promise.resolve({ error: 'not used here' }),
    verifyTotp: () => Promise.resolve({ ok: true, next: 'done' }),
    verifiedTotpFactorId: () => Promise.resolve(null),
  };
  const auth: AuthAdapter = {
    configured: true,
    account,
    currentSession: () => Promise.resolve(session),
    signOut: () => Promise.resolve(),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { auth, redirects };
}

function setup() {
  const { auth, redirects } = signedOutAuth();
  const sends: { method: string; path: string; body: unknown }[] = [];
  const api: ApiClient = {
    // The invitee has no family yet.
    get: () => Promise.reject(new ApiRequestError('NOT_FOUND', 'Create your family first', 404)),
    send: <S extends z.ZodType>(
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      body: unknown,
      schema: S,
    ) => {
      sends.push({ method, path, body });
      return Promise.resolve(schema.parse({ familyId: FAMILY, role: 'guardian' }));
    },
  };
  const router = createMemoryRouter(
    [
      { path: '/app/guardians', element: <GuardiansPage /> },
      { path: '/sign-in', element: <SignInPage /> },
      { path: '/sign-up', element: <SignUpPage /> },
    ],
    { initialEntries: [INVITE_URL] },
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
  return { router, sends, redirects };
}

describe('WEB-R1-01 guardian invitation link opened while signed out', () => {
  it('keeps the #accept token in the sign-in return path', async () => {
    setup();
    const link = await screen.findByRole('link', { name: 'sign in' });
    const next = new URL(
      link.getAttribute('href')!,
      'https://portal.example.test',
    ).searchParams.get('next');
    expect(next).toBe(INVITE_URL);
  });

  it('password sign-in lands on the accept card and accepting sends the token', async () => {
    const user = userEvent.setup();
    const { router, sends } = setup();
    await user.click(await screen.findByRole('link', { name: 'sign in' }));
    expect(router.state.location.pathname).toBe('/sign-in');
    await user.type(await screen.findByLabelText('Email'), 'sam.guardian@example.test');
    await user.type(screen.getByLabelText('Password'), 'synthetic-password-123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const accept = await screen.findByRole('button', { name: 'Accept invitation' });
    expect(screen.queryByText('You’re not part of a family yet')).toBeNull();
    await user.click(accept);
    await waitFor(() =>
      expect(sends).toEqual([
        { method: 'POST', path: '/v1/invitations/accept', body: { token: TOKEN } },
      ]),
    );
    expect(await screen.findAllByText('You joined the family as a guardian.')).not.toHaveLength(0);
    // The token is still removed from the address once the page has captured it.
    expect(router.state.location.pathname).toBe('/app/guardians');
    expect(router.state.location.hash).toBe('');
  });

  it('an email sign-in link returns to the invitation with its token', async () => {
    const user = userEvent.setup();
    const { redirects } = setup();
    await user.click(await screen.findByRole('link', { name: 'sign in' }));
    await user.click(await screen.findByRole('button', { name: 'Use an email link instead' }));
    await user.type(screen.getByLabelText('Email'), 'sam.guardian@example.test');
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    await screen.findByText(/a sign-in link is on its way/);
    expect(redirects).toEqual([
      { kind: 'magic_link', to: `${window.location.origin}${INVITE_URL}` },
    ]);
  });

  it('creating an account first returns to the invitation after email verification', async () => {
    const user = userEvent.setup();
    const { redirects } = setup();
    await user.click(await screen.findByRole('link', { name: 'sign in' }));
    await user.click(await screen.findByRole('link', { name: 'Create a parent account' }));
    await user.type(await screen.findByLabelText('Email'), 'sam.guardian@example.test');
    await user.type(screen.getByLabelText('Password'), 'synthetic-password-123');
    await user.type(screen.getByLabelText('Confirm password'), 'synthetic-password-123');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByText(/Check your email for a verification link/);
    expect(redirects).toEqual([{ kind: 'sign_up', to: `${window.location.origin}${INVITE_URL}` }]);
  });
});
