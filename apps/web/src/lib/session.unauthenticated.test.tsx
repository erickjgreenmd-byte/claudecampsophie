import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { z } from 'zod';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import type { AuthAdapter, SignOutScope } from './auth.ts';
import {
  createDefaultSession,
  RequireParent,
  SessionProvider,
  signOutOnUnauthenticated,
  useApiQuery,
} from './session.tsx';
import { ErrorState, Loading } from '../components/states.tsx';

/**
 * WEB-R2-02: a session the server has already ended left every portal page on "Sign in again to
 * continue" + "Try again", with no sign-in link, for up to an hour (auth.getSession() keeps handing
 * out the stored access token until ~90 s before it expires). It happens whenever the parent signs
 * out of the phone app, after a password change elsewhere and after the account-closure revocation.
 *
 * A parent call answered UNAUTHENTICATED now ends this browser's session locally, so RequireParent
 * shows the sign-in prompt with the return path kept. Synthetic emails and tokens only; no network.
 */

afterEach(cleanup);

const config = { apiBaseUrl: '/api', supabaseUrl: null, supabasePublishableKey: null };

function endedSessionAuth() {
  const signOut = vi.fn((_scope?: SignOutScope) => Promise.resolve());
  const listeners = new Set<() => void>();
  let session: { accessToken: string; email: string } | null = {
    accessToken: 'synthetic-token',
    email: 'pat.parent@example.test',
  };
  const auth: AuthAdapter = {
    configured: true,
    currentSession: () => Promise.resolve(session),
    signOut: (scope) => {
      session = null;
      const result = signOut(scope);
      for (const listener of [...listeners]) listener();
      return result;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { auth, signOut };
}

const unauthenticated = () =>
  new ApiRequestError('UNAUTHENTICATED', 'Sign in again to continue', 401);

const familySchema = z.strictObject({ family: z.strictObject({ id: z.string() }) });

/** Stands in for any portal page that loads family data through useApiQuery. */
function FamilyStub() {
  const query = useApiQuery((api) => api.get('/v1/family', familySchema), []);
  if (query.status === 'loading') return <Loading />;
  if (query.status === 'error')
    return <ErrorState message={query.error.message} onRetry={query.reload} />;
  return <p>Family data for Riley</p>;
}

function renderPortal(api: ApiClient, auth: AuthAdapter) {
  const router = createMemoryRouter(
    [
      {
        path: '/app',
        element: (
          <RequireParent>
            <FamilyStub />
          </RequireParent>
        ),
      },
    ],
    { initialEntries: ['/app'] },
  );
  render(
    <SessionProvider value={{ config, auth, api }}>
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return router;
}

describe('WEB-R2-02 a session the server has ended', () => {
  it('signs this browser out locally and asks the parent to sign in, keeping the return path', async () => {
    const { auth, signOut } = endedSessionAuth();
    const api = signOutOnUnauthenticated(
      {
        get: () => Promise.reject(unauthenticated()),
        send: () => Promise.reject(unauthenticated()),
      },
      auth,
    );
    renderPortal(api, auth);
    const link = await screen.findByRole('link', { name: 'sign in' });
    expect(link.getAttribute('href')).toBe('/sign-in?next=%2Fapp');
    // Local scope only: the dead local session is cleared without touching other devices.
    expect(signOut).toHaveBeenCalledWith('local');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByText(/Riley/)).toBeNull();
  });

  it('ends the session for a refused mutation too, not only for a page load', async () => {
    const { auth, signOut } = endedSessionAuth();
    const api = signOutOnUnauthenticated(
      {
        get: (() => Promise.resolve({ family: { id: 'synthetic-family' } })) as ApiClient['get'],
        send: () => Promise.reject(unauthenticated()),
      },
      auth,
    );
    await expect(api.send('POST', '/v1/adult/lock', undefined, z.unknown())).rejects.toBeInstanceOf(
      ApiRequestError,
    );
    await waitFor(() => expect(signOut).toHaveBeenCalledWith('local'));
  });

  it('is wired into the portal session, so any 401 from the real client ends the local session', async () => {
    const { auth, signOut } = endedSessionAuth();
    const body = JSON.stringify({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Sign in again to continue',
        requestId: 'synthetic-request',
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(body, { status: 401, headers: { 'content-type': 'application/json' } }),
        ),
      ),
    );
    try {
      const session = createDefaultSession(config, auth);
      await expect(session.api.get('/v1/family', familySchema)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      await waitFor(() => expect(signOut).toHaveBeenCalledWith('local'));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('leaves every other failure alone, so a real error still offers Try again', async () => {
    const { auth, signOut } = endedSessionAuth();
    const api = signOutOnUnauthenticated(
      {
        get: () => Promise.reject(new ApiRequestError('INTERNAL', 'Something went wrong.', 500)),
        send: () => Promise.reject(new Error('unexpected send')),
      },
      auth,
    );
    renderPortal(api, auth);
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(signOut).not.toHaveBeenCalled();
  });
});
