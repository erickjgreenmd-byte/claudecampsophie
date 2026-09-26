import type { ReactElement } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider, useLocation, type RouteObject } from 'react-router';
import type { ApiClient } from '@pencillift/contracts/client';
import { ApiRequestError } from '@pencillift/contracts/client';
import { appRoutes } from './App.tsx';
import { routes } from './routes.tsx';
import type { AccountAuth, AuthAdapter, AuthOutcome, SignOutScope } from './lib/auth.ts';
import { SessionProvider } from './lib/session.tsx';
import { createSupabaseAuth } from './lib/supabase-auth.ts';
import PrivacyControlsPage from './pages/app/PrivacyControlsPage.tsx';
import SignInPage from './pages/auth/SignInPage.tsx';

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

/**
 * Labeled fake session: no network, no Supabase client.
 *
 * WEB-R4-AUTH-2: `refuse` models a sign-out supabase-js did not carry out, which leaves the session
 * (and its still-valid refresh token) in this origin's storage. `reported` is the adapter returning
 * that outcome (what the Supabase adapter does — ACC-WEB-AUTH-A: it must not throw); `thrown` is an
 * adapter that fails by rejecting instead; `silent` is the same refusal with nothing reported.
 * `cleared` is a reported refusal whose stored session the adapter did remove, so this browser has no
 * session left but the server was never told.
 */
function fakes(
  session: { accessToken: string; email: string } | null,
  options: { readonly refuse?: 'reported' | 'thrown' | 'silent' | 'cleared' } = {},
): Fakes & {
  auth: AuthAdapter;
  api: ApiClient;
} {
  const signOut = vi.fn((_scope?: SignOutScope) => Promise.resolve());
  const send = vi.fn(() => Promise.resolve({ ok: true }));
  const listeners = new Set<() => void>();
  let current = session;
  const auth: AuthAdapter = {
    configured: true,
    // Present so /sign-in renders its real form rather than the "not configured" notice: the
    // WEBR5-E-2 test below lands there and reads what the parent is actually told. Nothing in these
    // tests signs in, so every method is a labeled refusal.
    account: {
      signInWithPassword: () =>
        Promise.resolve<AuthOutcome>({ ok: false, message: 'not used in these tests' }),
      signUp: () => Promise.resolve<AuthOutcome>({ ok: false, message: 'not used in these tests' }),
      sendMagicLink: () =>
        Promise.resolve<AuthOutcome>({ ok: false, message: 'not used in these tests' }),
      sendPasswordReset: () =>
        Promise.resolve<AuthOutcome>({ ok: false, message: 'not used in these tests' }),
      updatePassword: () =>
        Promise.resolve<AuthOutcome>({ ok: false, message: 'not used in these tests' }),
      assuranceLevel: () => Promise.resolve(null),
      enrollTotp: () => Promise.resolve({ error: 'not used in these tests' }),
      verifyTotp: () =>
        Promise.resolve<AuthOutcome>({ ok: false, message: 'not used in these tests' }),
      verifiedTotpFactorId: () => Promise.resolve(null),
    } satisfies AccountAuth,
    currentSession: () => Promise.resolve(current),
    signOut: async (scope) => {
      if (!options.refuse || options.refuse === 'cleared') current = null;
      await signOut(scope);
      // Only a sign-out supabase-js carried out raises SIGNED_OUT; a session the adapter removed
      // itself after a refusal (`cleared`) raises nothing, so the shell's session state is stale and
      // the control is still on screen to report the refusal.
      if (options.refuse !== 'cleared') for (const listener of [...listeners]) listener();
      if (options.refuse === 'thrown') throw new Error('synthetic refused sign-out');
      if (options.refuse === 'reported' || options.refuse === 'cleared') {
        return { serverNotTold: true };
      }
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

function renderShell(
  path: string,
  parts: { auth: AuthAdapter; api: ApiClient },
  /** Real pages to mount instead of a stub, by path (WEBR5-E-2 mounts the real /sign-in). */
  real: Readonly<Record<string, ReactElement>> = {},
) {
  const stubs: RouteObject[] = [...new Set([...PORTAL_PATHS, ...ADMIN_PATHS, '/sign-in', '/'])].map(
    (stub) => ({ path: stub, element: real[stub] ?? <h1>{`Page ${stub}`}</h1> }),
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

/**
 * WEB-R4-AUTH-2: the control did `try { await auth.signOut('local'); } finally { navigate('/sign-in') }`
 * and the adapter dropped the `{ error }` supabase-js returns. supabase-js 2.116.0 refuses a sign-out
 * without clearing storage when the stored access token has expired and the refresh it tries first
 * fails at the fetch level (offline, captive portal, auth outage): it returns the session error
 * *before* removeCurrentSession(). The parent then saw the sign-in page while the refresh token was
 * still in this origin's localStorage, so the next person at a shared computer got the family's data
 * back by typing /app. A refused sign-out is now reported and keeps the parent on the page.
 */
describe('WEB-R4-AUTH-2 a refused sign-out is never reported as success', () => {
  it('stays on the portal page and says the session is still open when the adapter reports a failure', async () => {
    const parts = fakes(
      { accessToken: 'synthetic-token', email: 'pat.parent@example.test' },
      {
        refuse: 'reported',
      },
    );
    const router = renderShell('/app/children', parts);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(parts.signOut).toHaveBeenCalledWith('local'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/still signed in/i);
    expect(router.state.location.pathname).toBe('/app/children');
    // The control is still there to try again, and the session line still names the account.
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
    expect(screen.getByText(/Signed in as p•••@example\.test/)).toBeTruthy();
  });

  /**
   * WEBR5-E-2: on this one path the adapter has already cleared this origin's session (it is the
   * only way the still-valid refresh token does not stay behind), and a bare storage removal raises
   * no SIGNED_OUT — so the shell's session state is stale, `RequireParent` keeps rendering and the
   * route page keeps everything it had loaded. Staying put therefore left the family's page, and a
   * "Signed in as …" line, on screen at the shared computer this control exists for, and advised a
   * retry that can no longer reach the server: auth-js finds no access token, skips the server call
   * and returns `{ error: null }`, so the second press only looks like it worked. This browser IS
   * signed out, so the portal must say so and leave.
   *
   * E-NOTICE: carrying the notice in router state is not telling the parent anything — the real
   * /sign-in page is mounted here (not the stub) and the assertions read what is on screen, because
   * the first round of this fix carried a notice no page rendered and the parent was told nothing at
   * all: not that this computer is signed out, not that the server was never told, not what to do.
   */
  it('leaves the portal for the sign-in page when the refusal cleared this browser’s session', async () => {
    const parts = fakes(
      { accessToken: 'synthetic-token', email: 'pat.parent@example.test' },
      {
        refuse: 'cleared',
      },
    );
    const router = renderShell('/app/children', parts, { '/sign-in': <SignInPage /> });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(parts.signOut).toHaveBeenCalledWith('local'));
    // What the parent can act on, on screen and announced, above the sign-in form. Awaited first:
    // the router's location changes before React has committed the new page, so asserting what is
    // rendered has to wait for the render, not for the navigation.
    const notice = await screen.findByRole('alert');
    expect(router.state.location.pathname).toBe('/sign-in');
    // The family's page and the account line are gone, and there is no second press to mislead.
    expect(screen.queryByText('Page /app/children')).toBeNull();
    expect(screen.queryByText(/Signed in as/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(notice.textContent).toMatch(/This computer is signed out/i);
    expect(notice.textContent).toMatch(/could not tell PencilLift’s servers/i);
    expect(notice.textContent).toMatch(/sign out on your phone/i);
    expect(notice.textContent).toMatch(/change your password/i);
    // Never "try signing out again": with the stored refresh token gone, auth-js skips the server
    // call altogether, so a second press cannot reach it and would only look like it worked.
    expect(notice.textContent).not.toMatch(/again/i);
    const form = document.querySelector('form');
    expect(form).not.toBeNull();
    // Above the form, so a parent reads it before they start typing.
    expect(notice.compareDocumentPosition(form!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText('Email')).toBeTruthy();
  });

  it('treats an adapter that rejects the same way, rather than moving on', async () => {
    const parts = fakes(
      { accessToken: 'synthetic-token', email: 'pat.parent@example.test' },
      {
        refuse: 'thrown',
      },
    );
    const router = renderShell('/app', parts);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(parts.signOut).toHaveBeenCalledWith('local'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/still signed in/i);
    expect(router.state.location.pathname).toBe('/app');
  });

  it('stays on the portal page when the session is still there after an apparently clean sign-out', async () => {
    const parts = fakes(
      { accessToken: 'synthetic-token', email: 'pat.parent@example.test' },
      {
        refuse: 'silent',
      },
    );
    const router = renderShell('/app', parts);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(parts.signOut).toHaveBeenCalledWith('local'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/still signed in/i);
    expect(router.state.location.pathname).toBe('/app');
  });
});

const supabaseConfig = {
  apiBaseUrl: '/api',
  supabaseUrl: 'https://example.supabase.co',
  supabasePublishableKey: 'sb_publishable_test',
};
/** The key supabase-js stores this project's session under. */
const STORED = 'sb-example-auth-token';

/** The real Supabase adapter over a labeled fake client whose signOut answers `result`. No network. */
function adapterWith(result: { error: { message: string } | null }) {
  const signOut = vi.fn(() => Promise.resolve(result));
  const adapter = createSupabaseAuth(
    supabaseConfig,
    () =>
      ({
        auth: {
          signOut,
          // Synthetic session: the portal shell reads it to show the masked signed-in email.
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
  return { adapter, signOut };
}

/**
 * WEB-R4-AUTH-2, adapter half: `await auth.signOut({ scope })` threw the result away, so no caller
 * could tell a carried-out sign-out from a refused one. Labeled fake client, no network.
 */
describe('WEB-R4-AUTH-2 the Supabase adapter surfaces a refused sign-out', () => {
  afterEach(() => localStorage.removeItem(STORED));

  it('reports the refusal, and clears this browser’s stored session, when supabase-js refuses', async () => {
    localStorage.setItem(
      STORED,
      JSON.stringify({ access_token: 'synthetic.expired.jwt', refresh_token: 'synthetic-refresh' }),
    );
    const { adapter, signOut } = adapterWith({ error: { message: 'Failed to fetch' } });
    // ACC-WEB-AUTH-A: reported by value, not by rejection. A rejection escaped the one production
    // caller that must carry on regardless (the account closure below), so the refusal is returned.
    const report = await adapter.signOut('local');
    expect(report?.serverNotTold).toBe(true);
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    // supabase-js returns this error before removeCurrentSession(), so the refresh token would
    // otherwise be left behind on a shared computer.
    expect(localStorage.getItem(STORED)).toBeNull();
  });

  it('resolves with nothing to report, and touches nothing else, when the sign-out was carried out', async () => {
    localStorage.setItem(STORED, JSON.stringify({ refresh_token: 'synthetic-refresh' }));
    const { adapter, signOut } = adapterWith({ error: null });
    expect(await adapter.signOut('local')).toBeUndefined();
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    // supabase-js clears its own storage on a successful sign-out; the adapter does not guess.
    expect(localStorage.getItem(STORED)).not.toBeNull();
  });
});

/**
 * ACC-WEB-AUTH-A: the account-closure flow is the other production caller of `auth.signOut()`
 * (apps/web/src/pages/app/PrivacyControlsPage.tsx: `await auth.signOut()` and then
 * `navigate('/account-deletion', …)`). The account is already closed on the server and the parent
 * still needs the page that explains what happens next, so a refused sign-out is reported as a value
 * and never as a rejection — a rejection there skipped the navigation and left an unhandled promise.
 * The sign-out control reads the same value (above) and refuses to look signed out.
 *
 * HUNT5-E-3: that flow now has a try/catch around the call (as does SignOutControl), so it carries on
 * either way and this page-level test holds whichever contract the adapter has. It is the guard for
 * the navigation, not for the contract; the contract is asserted on the adapter in the second test
 * below, which is the one a change to a throwing sign-out turns red.
 *
 * The adapter here is the real one; only the Supabase client and the API are labeled fakes.
 */
describe('ACC-WEB-AUTH-A a refused sign-out still explains a closed account', () => {
  const FAMILY_ID = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
  const VIEWS: Readonly<Record<string, unknown>> = {
    '/v1/family': { id: FAMILY_ID, children: [] },
    '/v1/deletion': { requests: [] },
    '/v1/exports': { exports: [] },
    '/v1/safety-reports': { reports: [] },
  };

  type Parser = { parse: (value: unknown) => unknown };

  /** Answers only the privacy page's own reads plus the account-closure call. */
  function closureApi(): ApiClient {
    const get = (path: string, schema: Parser) =>
      path in VIEWS
        ? Promise.resolve(schema.parse(VIEWS[path]))
        : Promise.reject(new Error(`unexpected GET ${path}`));
    const send = (method: string, path: string, _body: unknown, schema: Parser) =>
      method === 'POST' && path === '/v1/account/close'
        ? Promise.resolve(schema.parse({ status: 'closed', signOut: true }))
        : Promise.reject(new Error(`unexpected ${method} ${path}`));
    return { get, send } as unknown as ApiClient;
  }

  function DeletionPageStub() {
    const state = useLocation().state as { accountClosed?: string } | null;
    return <p>{`deletion page: ${state?.accountClosed ?? 'no state'}`}</p>;
  }

  afterEach(() => localStorage.removeItem(STORED));

  it('lands on the public deletion page when supabase-js refuses the sign-out', async () => {
    localStorage.setItem(STORED, JSON.stringify({ refresh_token: 'synthetic-refresh' }));
    const { adapter, signOut } = adapterWith({ error: { message: 'Failed to fetch' } });
    const router = createMemoryRouter(
      [
        { path: '/app/privacy', element: <PrivacyControlsPage /> },
        { path: '/account-deletion', element: <DeletionPageStub /> },
      ],
      { initialEntries: ['/app/privacy'] },
    );
    render(
      <SessionProvider value={{ config, auth: adapter, api: closureApi() }}>
        <RouterProvider router={router} />
      </SessionProvider>,
    );
    const user = userEvent.setup();
    const card = await screen.findByRole('region', { name: /delete my account/i });
    await user.click(within(card).getByRole('checkbox', { name: /i understand my sign-in/i }));
    await user.click(within(card).getByRole('button', { name: /delete my account/i }));
    expect(await screen.findByText('deletion page: closed')).toBeTruthy();
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  /**
   * HUNT5-E-3: the test above cannot be the guard for this requirement. PrivacyControlsPage wraps its
   * `await auth.signOut()` in a try/catch, so it reaches the deletion page whether the adapter reports
   * the refusal or throws it — and SignOutControl has a catch of its own. With no catch-free caller
   * left, the rule is asserted on the adapter, exactly as the closure flow calls it (no scope
   * argument, so the adapter's own `local` default applies).
   */
  it('reports a refusal to the closure caller as a value, never as a rejection', async () => {
    localStorage.setItem(STORED, JSON.stringify({ refresh_token: 'synthetic-refresh' }));
    const { adapter } = adapterWith({ error: { message: 'Failed to fetch' } });
    await expect(adapter.signOut()).resolves.toEqual({ serverNotTold: true });
  });
});
