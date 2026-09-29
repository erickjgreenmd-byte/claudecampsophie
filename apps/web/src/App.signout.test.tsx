import type { ReactElement } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider, useLocation, type RouteObject } from 'react-router';
import type { ApiClient } from '@pencillift/contracts/client';
import { ApiRequestError } from '@pencillift/contracts/client';
import { SIGN_OUT_NOT_TOLD_COPY } from '@pencillift/contracts';
import { appRoutes } from './App.tsx';
import { routes } from './routes.tsx';
import type { AccountAuth, AuthAdapter, AuthOutcome, SignOutScope } from './lib/auth.ts';
import { SessionProvider } from './lib/session.tsx';
import { createSupabaseAuth } from './lib/supabase-auth.ts';
import { createClient } from '@supabase/supabase-js';
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
 * and the adapter dropped the `{ error }` supabase-js returns. auth-js 2.116.0 refuses a sign-out
 * without clearing storage on one path: the stored access token has already EXPIRED, so the refresh
 * `__loadSession` tries first is the only credential left; that refresh fails at the fetch level
 * (offline, captive portal, auth outage); and `_signOut` returns that session error before it reaches
 * removeCurrentSession(). The parent then saw the sign-in page while the refresh token was still in
 * this origin's localStorage, so the next person at a shared computer got the family's data back by
 * typing /app once the network returned. A refused sign-out is now reported and keeps the parent on
 * the page.
 *
 * HUNT6-F-MARGIN: this used to say "the stored access token is inside EXPIRY_MARGIN_MS", which is not
 * the precondition — a token inside the margin but not yet expired is preserved by auth-js when the
 * refresh fails, so `_signOut` goes on to /logout and that path clears storage itself. The
 * [HUNT6-F-PREMISE] block below runs both refusal paths, and the margin case that is neither, against
 * the real library.
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
    // The shared string itself, not a paraphrase of it (L-054). HUNT6-F-SHARED: the two surfaces that
    // share it are the portal and the public deletion page, both reading SIGN_OUT_NOT_TOLD_COPY; this
    // comment used to name the app as a third, which does not import the constant and says its own
    // thing (apps/mobile/src/privacy/parent-privacy.ts — see SignOutControl's docstring).
    expect(notice.textContent).toContain(SIGN_OUT_NOT_TOLD_COPY.signInOpen);
    // And the control hands on the constant, never a copy of its words: an inlined paraphrase here
    // would not reach the page as this exact string.
    expect((router.state.location.state as { signedOutNotice?: string }).signedOutNotice).toBe(
      SIGN_OUT_NOT_TOLD_COPY.signInOpen,
    );
    expect(notice.textContent).toMatch(/change your password/i);
    // HUNT6-F-1: never "sign out on your phone". Every sign-out in this product is scope 'local'
    // (spec P3, L-039) — the portal's, and the app's — so a phone sign-out revokes the phone's
    // refresh token and leaves this session's row untouched. There is no "sign out everywhere"
    // action anywhere in the product to point at, so the first thing the parent was told to do did
    // nothing, and it was named before the one thing that helps.
    expect(notice.textContent).not.toMatch(/on your phone/i);
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

/**
 * The real Supabase adapter over a labeled fake client whose signOut answers `result`. No network.
 *
 * HUNT6-F-PREMISE: by default a refused sign-out leaves NO readable session, which is what the pinned
 * @supabase/auth-js 2.116.0 does on both of its refusal paths — proved by running it in the block
 * above, not modelled from a comment. On the server-call path it removes the stored session before it
 * returns the error; on the pre-flight-refresh path it leaves the stored token but `getSession()` hits
 * the same refresh failure and answers `session: null`. The earlier default was the opposite of both,
 * on the strength of an in-memory session this version does not have.
 *
 * Pass `keepsSessionOnSignOut` for a client whose refusal leaves the session readable. That is NOT
 * 2.116.0; it is the case the callers' re-read exists for — a future auth-js, a storage adapter other
 * than the two auth-js picks for itself, another tab writing a session back — and the cases that use
 * it are pinning the decision rule (a refusal over a readable session must not be presented as a
 * finished sign-out), not production's library behaviour.
 */
function adapterWith(
  result: { error: { message: string } | null },
  options: { readonly keepsSessionOnSignOut?: boolean } = {},
) {
  let live = true;
  const signOut = vi.fn(() => {
    // Carried out or refused, 2.116.0 leaves nothing readable; only `keepsSessionOnSignOut` does.
    if (!options.keepsSessionOnSignOut) live = false;
    return Promise.resolve(result);
  });
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
                session: live
                  ? {
                      access_token: 'synthetic-token',
                      user: { email: 'pat.parent@example.test' },
                    }
                  : null,
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

/** Narrowed to the two methods the cases below call on the real client (see realAdapter). */
interface PinnedClient {
  readonly auth: {
    signOut(options: { scope: 'local' }): Promise<{ error: unknown }>;
    getSession(): Promise<{ data: { session: unknown } }>;
  };
}

/**
 * HUNT6-F-PREMISE: the pinned library itself, not a hand-written model of it. Three rounds of
 * comments in this area asserted a mechanism nobody had read — "supabase-js returns its error before
 * removeCurrentSession(), so its in-memory session survives the localStorage removal and
 * currentSession() still answers" — and the guard above rested on it. @supabase/auth-js 2.116.0
 * (reached through the pinned @supabase/supabase-js 2.116.0) does something else, and these cases
 * establish it by running it.
 *
 * What it really does (GoTrueClient._signOut, and the only two ways it can resolve with an error):
 * - the SERVER-CALL path. The stored access token is usable, `admin.signOut(token, scope)` fails with
 *   anything that is not 404/401/403/session-missing (a rejected fetch becomes
 *   AuthRetryableFetchError), and the branch runs `if (scope !== 'others') await
 *   removeCurrentSession()` and only THEN `return this._returnResult({ error })`. The removal comes
 *   FIRST — the opposite of what the comments said.
 * - the PRE-FLIGHT REFRESH path. The stored access token has ALREADY EXPIRED, so `__loadSession` must
 *   refresh before `_signOut` can have a token at all, the refresh fails at the fetch level, and
 *   `_useSession` hands `_signOut` a `sessionError`, which it returns with no removal at all. A
 *   retryable fetch failure is the one case `_callRefreshToken` does not clear storage for, so the
 *   still-valid refresh token stays in localStorage. THAT is what `forgetStoredSession` exists to take
 *   out.
 *
 * HUNT6-F-MARGIN: "inside EXPIRY_MARGIN_MS" was this bullet's stated precondition and it is wrong.
 * Inside the 90s margin is only what makes `__loadSession` refresh; when that refresh fails auth-js
 * checks the access token's REAL expiry and, while it is still valid, hands the stored session back
 * with `error: null`, so `_signOut` reaches /logout and takes the server-call path above. The
 * [HUNT6-F-MARGIN] case runs that, and it is why the pre-flight case below uses `nowS() - 60`.
 *
 * And there is no in-memory session in 2.116.0 to survive anything: `getSession()` goes through
 * `_useSession` -> `__loadSession`, which re-reads `this.storage` on every call. `this.storage` is
 * `globalThis.localStorage` when `supportsLocalStorage()` is true and auth-js's
 * memoryLocalStorageAdapter when it is not (no storage adapter is passed here) — so removing the key
 * removes what `getSession()` reads, and when it cannot be removed nothing was persisted either.
 *
 * Offline is modelled by a fetch that rejects, which is what a captive portal, an auth outage and a
 * dropped connection all reach auth-js as. No network, and every token below is synthetic.
 */
describe('[HUNT6-F-PREMISE] what @supabase/auth-js 2.116.0 does on a refused sign-out', () => {
  afterEach(() => localStorage.removeItem(STORED));

  const nowS = () => Math.floor(Date.now() / 1000);

  /**
   * The real client, created by the adapter's own factory hook so the adapter under test and the
   * library under test are the same object. `autoRefreshToken` is off (production's portalClient has
   * it on): it only decides whether `_recoverAndRefresh` fires a refresh at construction, and with a
   * rejecting fetch that refresh is retryable, so auth-js preserves the session either way — off
   * keeps the ticker and its timers out of the test.
   */
  function realAdapter(expiresAtS: number) {
    localStorage.setItem(
      STORED,
      JSON.stringify({
        access_token: 'synthetic.access.jwt',
        refresh_token: 'synthetic-refresh',
        expires_at: expiresAtS,
        token_type: 'bearer',
        user: { id: '4c1d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f', email: 'pat.parent@example.test' },
      }),
    );
    const fetchCalls: string[] = [];
    const offline = ((input: unknown) => {
      fetchCalls.push(String(input));
      return Promise.reject(new TypeError('Failed to fetch'));
    }) as typeof fetch;
    // Narrowed to the two methods these cases call: `createClient`'s own return type carries default
    // schema generics that do not match the adapter's `ClientFactory` alias under
    // exactOptionalPropertyTypes, and the real client satisfies this structurally.
    let client: PinnedClient | undefined;
    const adapter = createSupabaseAuth(supabaseConfig, (url, key, options) => {
      const created = createClient(url, key, {
        auth: { ...options.auth, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: offline },
      });
      client ??= created;
      return created as never;
    });
    return { adapter, client: () => client!, fetchCalls };
  }

  it('removes the stored session BEFORE returning the error, on the server-call path', async () => {
    const { client, fetchCalls } = realAdapter(nowS() + 3600);
    const { error } = await client().auth.signOut({ scope: 'local' });
    expect(error).not.toBeNull();
    // It got as far as /logout, so this is the server-call path and not a refresh failure.
    expect(fetchCalls.some((url) => url.includes('/logout'))).toBe(true);
    // The removal ran inside the error branch, ahead of the return.
    expect(localStorage.getItem(STORED)).toBeNull();
    expect((await client().auth.getSession()).data.session).toBeNull();
  });

  /**
   * A retryable refresh is retried with exponential backoff for one auto-refresh tick
   * (AUTO_REFRESH_TICK_DURATION_MS, 30s) before auth-js gives up, so the pre-flight path is driven by
   * advancing the clock rather than by waiting on it. Real timers would make each of these cases a
   * 30-second test.
   */
  async function whileOffline<T>(start: () => Promise<T>): Promise<T> {
    vi.useFakeTimers();
    try {
      const pending = start();
      await vi.advanceTimersByTimeAsync(31_000);
      return await pending;
    } finally {
      vi.useRealTimers();
    }
  }

  it('returns the error with the refresh token still stored, on the pre-flight refresh path', async () => {
    const { client, fetchCalls } = realAdapter(nowS() - 60);
    const { error } = await whileOffline(() => client().auth.signOut({ scope: 'local' }));
    expect(error).not.toBeNull();
    // The refusal came from the refresh, before any sign-out request was made.
    expect(fetchCalls.some((url) => url.includes('grant_type=refresh_token'))).toBe(true);
    expect(fetchCalls.some((url) => url.includes('/logout'))).toBe(false);
    // No removal on this path: the still-usable refresh token is left behind, which is the whole
    // reason the adapter's forgetStoredSession exists.
    expect(localStorage.getItem(STORED)).not.toBeNull();
    // And nothing in memory answers over it: getSession() re-reads storage, hits the same refresh
    // failure and resolves `session: null` while the token is still sitting there.
    expect((await client().auth.getSession()).data.session).toBeNull();
  });

  /**
   * HUNT6-F-MARGIN: being inside EXPIRY_MARGIN_MS is NOT the precondition for the no-removal refusal,
   * and this is the case that separates the two. 85 seconds to expiry is inside auth-js's 90s margin
   * (AUTO_REFRESH_TICK_THRESHOLD * AUTO_REFRESH_TICK_DURATION_MS), so `__loadSession` does refresh
   * first and the refresh does fail — but when it fails it compares the access token against its REAL
   * expiry, and a token that is still valid keeps the stored session and is handed back with
   * `error: null` (auth-js's proactive-preserve branch, mirrored in `_callRefreshToken`). `_signOut`
   * therefore HAS an access token, calls /logout, and lands in the server-call branch that removes the
   * session BEFORE returning the error. An access token that has actually expired has no such fallback,
   * which is why the case above uses `nowS() - 60`. (The fallback also drops out when storage changed
   * under the refresh — a concurrent sign-out, another tab rotating the slot — but then the stored
   * session is already gone, so that is not a case `forgetStoredSession` has anything to remove on
   * either.)
   *
   * INVERTED: the assertions here were first written as the comments' stated precondition predicts —
   * no /logout, token still stored — and both were red against the pinned library. They are the fact
   * the comments in supabase-auth.ts and above now state.
   */
  it('[HUNT6-F-MARGIN] takes the server-call path for a token inside the margin that has not expired', async () => {
    const { client, fetchCalls } = realAdapter(nowS() + 85);
    const { error } = await whileOffline(() => client().auth.signOut({ scope: 'local' }));
    expect(error).not.toBeNull();
    // Inside the margin, so the pre-flight refresh fires and fails, exactly as on the case above.
    expect(fetchCalls.some((url) => url.includes('grant_type=refresh_token'))).toBe(true);
    // And then it carries on to the server anyway, which the pre-flight path never does.
    expect(fetchCalls.some((url) => url.includes('/logout'))).toBe(true);
    // The server-call branch removed the session itself, so forgetStoredSession has nothing to take
    // out here: the refresh token cannot be left behind by a within-margin, unexpired token.
    expect(localStorage.getItem(STORED)).toBeNull();
    expect((await client().auth.getSession()).data.session).toBeNull();
  });

  /**
   * HUNT6-F-REFUTED: the sentence three rounds of comments used as their explanation — "supabase-js
   * returns its error before removeCurrentSession(), so its in-memory session survives the
   * localStorage removal and currentSession() still answers" — asserted a cache 2.116.0 does not
   * have. This case reads the session through the real client FIRST, so any in-memory copy is warm,
   * then removes the stored key out from under it.
   *
   * INVERTED: both post-removal assertions were first written as `not.toBeNull()`, which is what that
   * sentence predicts, and both were red. `getSession()` goes through `_useSession` -> `__loadSession`,
   * which re-reads `this.storage` on every call, so the removal takes out what it reads — there is no
   * direction in which the refuted sentence holds, and no reader should be taught it.
   */
  it('[HUNT6-F-REFUTED] keeps no in-memory session: a warm getSession() re-reads storage', async () => {
    const { adapter, client } = realAdapter(nowS() + 3600);
    // Warm first: this read succeeds, so anything cached in memory is now populated.
    expect((await client().auth.getSession()).data.session).not.toBeNull();
    expect(await adapter.currentSession()).not.toBeNull();
    localStorage.removeItem(STORED);
    expect((await client().auth.getSession()).data.session).toBeNull();
    expect(await adapter.currentSession()).toBeNull();
  });

  it('leaves the adapter no readable session and no stored token after a reported refusal', async () => {
    const { adapter } = realAdapter(nowS() - 60);
    expect(await whileOffline(() => adapter.signOut('local'))).toEqual({ serverNotTold: true });
    // forgetStoredSession took out what auth-js left, so the token cannot come back to life when the
    // network does, and the same key is what getSession() reads.
    expect(localStorage.getItem(STORED)).toBeNull();
    expect(await adapter.currentSession()).toBeNull();
  });

  it('reports the refusal on the server-call path too, where auth-js had already cleared it', async () => {
    const { adapter } = realAdapter(nowS() + 3600);
    expect(await adapter.signOut('local')).toEqual({ serverNotTold: true });
    expect(localStorage.getItem(STORED)).toBeNull();
    expect(await adapter.currentSession()).toBeNull();
  });
});

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
    // Modelled on auth-js's pre-flight-refresh refusal (`synthetic.expired.jwt`), the one path it
    // returns the error on before reaching removeCurrentSession(), so the refresh token would
    // otherwise be left behind on a shared computer ([HUNT6-F-PREMISE] runs it for real).
    expect(localStorage.getItem(STORED)).toBeNull();
  });

  /**
   * HUNT6-F-3: what the refusal report does NOT establish. `{ serverNotTold: true }` is returned right
   * after a best-effort `forgetStoredSession`, which removes one localStorage key and swallows any
   * throw, so the report carries nothing about this origin's session and a caller that would say "this
   * computer is signed out" has to read it (which is what PrivacyControlsPage now does, below).
   *
   * Driven with storage made hostile, the sharpest form of it: a browser with site data blocked throws
   * on merely touching `globalThis.localStorage`, so the removal cannot run at all — and the adapter
   * still REPORTS rather than throwing, which is the fact this case pins.
   *
   * HUNT6-F-PREMISE: it used to pin a second "fact" as well — that the session stays readable through
   * a refusal, on the strength of an in-memory session auth-js 2.116.0 does not have. That assertion
   * is inverted below, and the fake it ran on now models the pinned library.
   */
  it('[HUNT6-F-3] reports the refusal without claiming this origin’s session is gone', async () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      get() {
        throw new DOMException('site data blocked', 'SecurityError');
      },
      configurable: true,
    });
    try {
      const { adapter } = adapterWith({ error: { message: 'Failed to fetch' } });
      expect(await adapter.signOut('local')).toEqual({ serverNotTold: true });
      // INVERTED (HUNT6-F-PREMISE): the old assertion here was `not.toBeNull()`, justified by an
      // in-memory session that survives the removal. auth-js 2.116.0 has no such copy, and on both
      // refusal paths this origin has no readable session afterwards (the block above).
      expect(await adapter.currentSession()).toBeNull();
    } finally {
      if (real) Object.defineProperty(globalThis, 'localStorage', real);
    }
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

  function renderClosure(auth: AuthAdapter) {
    const router = createMemoryRouter(
      [
        { path: '/app/privacy', element: <PrivacyControlsPage /> },
        { path: '/account-deletion', element: <DeletionPageStub /> },
      ],
      { initialEntries: ['/app/privacy'] },
    );
    render(
      <SessionProvider value={{ config, auth, api: closureApi() }}>
        <RouterProvider router={router} />
      </SessionProvider>,
    );
    return router;
  }

  async function closeTheAccount() {
    const user = userEvent.setup();
    const card = await screen.findByRole('region', { name: /delete my account/i });
    await user.click(within(card).getByRole('checkbox', { name: /i understand my sign-in/i }));
    await user.click(within(card).getByRole('button', { name: /delete my account/i }));
    return card;
  }

  /**
   * HUNT6-G-1 / HUNT6-F-3 inverted this case. It ran the REAL adapter through the closure flow over a
   * client whose `getSession` always answers and asserted that the flow reaches /account-deletion,
   * whose refusal notice opens "This computer is signed out" — the one fact nothing had read. The flow
   * now re-reads the session on both refusal paths, exactly as SignOutControl does, so this is the half
   * where the session survived: the parent stays where the portal's own Sign out is.
   *
   * HUNT6-F-PREMISE: that client is `keepsSessionOnSignOut`, and it is NOT what auth-js 2.116.0 does —
   * the old docstring called it "production's behaviour after a refusal" and it is not that. It is the
   * case the read exists for, so this case pins the decision rule (a refusal over a readable session is
   * never presented as a finished sign-out), and the [HUNT6-F-PREMISE] block pins what the library does.
   */
  it('[HUNT6-G-1] keeps the parent on the portal page when the refused sign-out left the session readable', async () => {
    localStorage.setItem(STORED, JSON.stringify({ refresh_token: 'synthetic-refresh' }));
    const { adapter, signOut } = adapterWith(
      { error: { message: 'Failed to fetch' } },
      { keepsSessionOnSignOut: true },
    );
    const router = renderClosure(adapter);
    const card = await closeTheAccount();
    expect((await within(card).findByRole('alert')).textContent).toMatch(
      /you are still signed in on this computer/i,
    );
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(router.state.location.pathname).toBe('/app/privacy');
    expect(screen.queryByText(/deletion page:/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/this computer is signed out/i);
  });

  /**
   * HUNT6-F-3, page half, and the sharpest case there is: a browser with site data blocked. Touching
   * `globalThis.localStorage` throws, so `forgetStoredSession` removes nothing at all — yet the adapter
   * still reports `serverNotTold`, because that report is about the SERVER. The closure flow used to
   * spend that report as "the adapter's own guarantee" that this computer is signed out and hand the
   * parent the public page's sentence saying so. It reads the session instead.
   *
   * HUNT6-F-PREMISE: the client here is `keepsSessionOnSignOut` for the same reason as the case above —
   * a refusal that leaves the session readable is what the read is for, not what 2.116.0 produces.
   */
  it('[HUNT6-F-3] claims nothing about this computer when storage is blocked and the session survived', async () => {
    const { adapter } = adapterWith(
      { error: { message: 'Failed to fetch' } },
      { keepsSessionOnSignOut: true },
    );
    const router = renderClosure(adapter);
    const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      get() {
        throw new DOMException('site data blocked', 'SecurityError');
      },
      configurable: true,
    });
    try {
      const card = await closeTheAccount();
      expect((await within(card).findByRole('alert')).textContent).toMatch(
        /you are still signed in on this computer/i,
      );
      expect(router.state.location.pathname).toBe('/app/privacy');
      expect(document.body.textContent).not.toMatch(/this computer is signed out/i);
    } finally {
      if (real) Object.defineProperty(globalThis, 'localStorage', real);
    }
  });

  it('[HUNT6-G-1] lands on the public deletion page when the refused sign-out did end this browser’s session', async () => {
    localStorage.setItem(STORED, JSON.stringify({ refresh_token: 'synthetic-refresh' }));
    const { adapter, signOut } = adapterWith({ error: { message: 'Failed to fetch' } });
    renderClosure(adapter);
    await closeTheAccount();
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
