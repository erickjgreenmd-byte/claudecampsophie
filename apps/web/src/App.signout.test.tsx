import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import type { ApiClient } from '@pencillift/contracts/client';
import { ApiRequestError } from '@pencillift/contracts/client';
import { appRoutes } from './App.tsx';
import { routes } from './routes.tsx';
import type { AuthAdapter, SignOutScope } from './lib/auth.ts';
import { SessionProvider } from './lib/session.tsx';

/**
 * WEB-R2-01: the parent portal had no way to end the session. A parent on a shared family, school
 * or library computer stayed signed in indefinitely (persistSession + autoRefreshToken), so whoever
 * used the browser next could read the family's children, scans, verdicts and guardian emails —
 * read screens need no PIN. The mobile twin was BUG-121 / MOB-R1-01.
 *
 * Every portal path is taken from the real route table, so a new /app or /admin page is covered the
 * moment it is registered. All emails and tokens below are synthetic.
 */

afterEach(cleanup);

const PORTAL_PATHS: readonly string[] = routes
  .map((route) => route.path)
  .filter((path): path is string => typeof path === 'string' && path.startsWith('/app'));

const ADMIN_PATHS: readonly string[] = routes
  .map((route) => route.path)
  .filter((path): path is string => typeof path === 'string' && path.startsWith('/admin'));

const config = { apiBaseUrl: '/api', supabaseUrl: null, supabasePublishableKey: null };

interface Fakes {
  readonly signOut: ReturnType<typeof vi.fn>;
  readonly send: ReturnType<typeof vi.fn>;
}

/** Labeled fake session: no network, no Supabase client. */
function fakes(session: { accessToken: string; email: string } | null): Fakes & {
  auth: AuthAdapter;
  api: ApiClient;
} {
  const signOut = vi.fn((_scope?: SignOutScope) => Promise.resolve());
  const send = vi.fn(() => Promise.resolve({ ok: true }));
  const listeners = new Set<() => void>();
  let current = session;
  const auth: AuthAdapter = {
    configured: true,
    currentSession: () => Promise.resolve(current),
    signOut: (scope) => {
      current = null;
      const result = signOut(scope);
      for (const listener of [...listeners]) listener();
      return result;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const api: ApiClient = {
    get: () => Promise.reject(new Error('unexpected GET')),
    send: send as unknown as ApiClient['send'],
  };
  return { auth, api, signOut, send };
}

function renderShell(path: string, parts: { auth: AuthAdapter; api: ApiClient }) {
  const stubs: RouteObject[] = [...new Set([...PORTAL_PATHS, ...ADMIN_PATHS, '/sign-in', '/'])].map(
    (stub) => ({ path: stub, element: <h1>{`Page ${stub}`}</h1> }),
  );
  const router = createMemoryRouter(appRoutes(stubs), { initialEntries: [path] });
  render(
    <SessionProvider value={{ config, auth: parts.auth, api: parts.api }}>
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return router;
}

describe('WEB-R2-01 sign out of the parent portal', () => {
  it.each([...PORTAL_PATHS, ...ADMIN_PATHS])(
    'offers a sign-out control and the masked signed-in email on %s',
    async (path) => {
      const parts = fakes({ accessToken: 'synthetic-token', email: 'pat.parent@example.test' });
      renderShell(path, parts);
      expect(await screen.findByRole('button', { name: 'Sign out' })).toBeTruthy();
      expect(screen.getByText(/Signed in as p•••@example\.test/)).toBeTruthy();
    },
  );

  it('locks the step-up while the token is valid, ends this browser’s session only, then goes to sign-in', async () => {
    const parts = fakes({ accessToken: 'synthetic-token', email: 'pat.parent@example.test' });
    const router = renderShell('/app/children', parts);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(parts.signOut).toHaveBeenCalledTimes(1));
    // The lock must be sent before the session is discarded, or the unlock outlives the sign-out.
    expect(parts.send.mock.calls[0]?.[0]).toBe('POST');
    expect(parts.send.mock.calls[0]?.[1]).toBe('/v1/adult/lock');
    // Local scope only: signing out of this browser never ends the parent's phone session.
    expect(parts.signOut).toHaveBeenCalledWith('local');
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('still signs out when the lock call fails', async () => {
    const parts = fakes({ accessToken: 'synthetic-token', email: 'pat.parent@example.test' });
    parts.send.mockRejectedValue(new ApiRequestError('NETWORK', 'You appear to be offline.', 0));
    const router = renderShell('/app', parts);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(parts.signOut).toHaveBeenCalledWith('local'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
  });

  it('shows no sign-out control when nobody is signed in', async () => {
    const parts = fakes(null);
    renderShell('/app', parts);
    expect(await screen.findByText('Page /app')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('keeps the public pages free of portal session controls', async () => {
    const parts = fakes({ accessToken: 'synthetic-token', email: 'pat.parent@example.test' });
    renderShell('/', parts);
    expect(await screen.findByText('Page /')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });
});
