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
import {
  stillSignedIn,
  type AccountAuth,
  type AuthAdapter,
  type AuthOutcome,
  type SessionRead,
  type SignOutScope,
} from './lib/auth.ts';
import { SessionProvider } from './lib/session.tsx';
import { createSupabaseAuth, type SessionStore } from './lib/supabase-auth.ts';
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
 *
 * HUNT7-F-1: `unreadable` is the third answer the session question has — the read did not come back
 * with "there is no session", it came back unable to say. The Supabase adapter answers that whenever
 * `getSession()` resolves with an error (a refresh that keeps failing) over a session it could not
 * remove, and a caller that spends it as "signed out" prints "This computer is signed out" over a
 * session that comes back with the network. `currentSession()` still answers `null` there, exactly as
 * the real adapter does, so only `readSession()` tells the two apart.
 */
function fakes(
  session: { accessToken: string; email: string } | null,
  options: {
    readonly refuse?: 'reported' | 'thrown' | 'silent' | 'cleared';
    readonly unreadable?: boolean;
  } = {},
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
    readSession: () =>
      Promise.resolve<SessionRead>(
        current
          ? { state: 'signed_in', session: current }
          : options.unreadable
            ? { state: 'unreadable' }
            : { state: 'signed_out' },
      ),
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

  /**
   * HUNT7-F-1: a session that could not be READ is not a session that is gone, and this is the one
   * shape where the difference is user-visible. A refusal whose storage removal did not get through
   * leaves the session where auth-js keeps it, and `getSession()` — hitting the same refresh failure
   * that caused the refusal — answers `session: null` WITH an error. Spending that as "signed out"
   * prints "This computer is signed out" on the sign-in page over a session that is refreshed back
   * into life as soon as the network returns, on the shared computer this control exists for. The
   * control must stay where the parent can try again instead.
   */
  it('[HUNT7-F-1] stays on the portal page when the session could not be read, not just when it answered', async () => {
    const parts = fakes(
      { accessToken: 'synthetic-token', email: 'pat.parent@example.test' },
      { refuse: 'cleared', unreadable: true },
    );
    const router = renderShell('/app/children', parts, { '/sign-in': <SignInPage /> });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(parts.signOut).toHaveBeenCalledWith('local'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/still signed in/i);
    expect(router.state.location.pathname).toBe('/app/children');
    // And nothing anywhere claims this computer is signed out.
    expect(document.body.textContent).not.toContain(SIGN_OUT_NOT_TOLD_COPY.signInOpen);
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
/**
 * An error in the shape auth-js resolves one in. `__isAuthError` plus the class `name` is how auth-js
 * itself tells its errors apart (lib/errors.js: `isAuthError`, `isAuthApiError`,
 * `isAuthRetryableFetchError`), so an error built here is classified exactly as a real one is.
 * `AuthApiError` is only ever constructed from an answer the auth service gave (lib/fetch.js
 * `handleError`); `AuthRetryableFetchError` is a request that got no answer at all — a rejected fetch
 * (status 0) or a 5xx/gateway failure.
 */
function authError(
  name: 'AuthApiError' | 'AuthRetryableFetchError' | 'AuthSessionMissingError',
  message: string,
  status: number,
  code?: string,
): { message: string } {
  return { __isAuthError: true, name, message, status, ...(code ? { code } : {}) } as unknown as {
    message: string;
  };
}

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

/** Narrowed to the methods the cases below call on the real client (see realAdapter). */
interface PinnedClient {
  readonly auth: {
    signOut(options: { scope: 'local' }): Promise<{ error: unknown }>;
    getSession(): Promise<{ data: { session: unknown } }>;
    onAuthStateChange(listener: (event: string) => void): unknown;
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

  /**
   * HUNT7-F-3: a removal the adapter makes by hand is invisible to every other tab. `_removeSession()`
   * is the only place a removal raises SIGNED_OUT (GoTrueClient.js:4416-4433), and the single
   * `_notifyAllSubscribers('SIGNED_OUT', null)` it ends with is both the in-tab notification and the
   * post on the per-storageKey BroadcastChannel every `persistSession` client in every tab listens on
   * (:4345-4354, :270-291). auth-js registers no `window` 'storage' listener, so there is no other
   * way a second tab learns. That made the two refusal paths asymmetric: a sign-out auth-js CARRIED
   * OUT dropped the other tab to the sign-in prompt, a sign-out it REFUSED left that tab showing the
   * family's children, scans, verdicts and guardian emails, and "Signed in as …", after this tab had
   * told the parent the computer was signed out.
   *
   * Asserted on the event, because the event is the thing that was missing: the subscriber here
   * stands in for the other tab's `useParentSession`, which re-reads the session only from
   * `auth.onChange` (lib/session.tsx:81-92).
   */
  it('[HUNT7-F-3] raises SIGNED_OUT after a refusal, so another tab stops showing the family', async () => {
    const { adapter, client } = realAdapter(nowS() - 60);
    const events: string[] = [];
    client().auth.onAuthStateChange((event) => {
      events.push(event);
    });
    expect(await whileOffline(() => adapter.signOut('local'))).toEqual({ serverNotTold: true });
    expect(localStorage.getItem(STORED)).toBeNull();
    expect(events).toContain('SIGNED_OUT');
  });

  /**
   * HUNT7-F-5: the second path on which a refusal leaves a stored session — and the one the
   * `forgetStoredSession` docstring said could not exist. `__loadSession`'s proactive-preserve branch
   * hands the stored session back only while the access token is still valid AND the stored slot still
   * holds the SAME refresh token (GoTrueClient.js:2578-2588). That guard fails in two ways, not one:
   * storage was cleared, and storage was REPLACED — another tab's refresh rotated the slot
   * (`_saveSession` after a successful `_callRefreshToken`, :4265-4272; the library's own debug line
   * distinguishes `nowHolds: 'replaced'` from `'cleared'`, :4250). On the replaced half the refusal
   * comes back over a session that is newer and perfectly valid, and `forgetStoredSession` removes it.
   *
   * INVERTED: the assertion below was first written as the docstring's own prediction — "the stored
   * session is already gone and this has nothing to remove", i.e. `expect(...).not.toBeNull()` — and
   * it was red, because there was a live session and the adapter took it out. The removal is the
   * intended outcome (the parent pressed Sign out); what was wrong was the enumeration, which is what
   * a next author reads to decide which paths need a removal at all.
   */
  it('[HUNT7-F-5] removes the session another writer stored while the pre-flight refresh was failing', async () => {
    const { adapter, fetchCalls } = realAdapter(nowS() + 85);
    const report = await whileOffline(async () => {
      // The other tab rotates the slot while this tab's pre-flight refresh is still failing.
      const rotated = setTimeout(
        () =>
          localStorage.setItem(
            STORED,
            JSON.stringify({
              access_token: 'synthetic.rotated.jwt',
              refresh_token: 'synthetic-refresh-rotated',
              expires_at: nowS() + 3600,
              token_type: 'bearer',
              user: {
                id: '4c1d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
                email: 'pat.parent@example.test',
              },
            }),
          ),
        1_000,
      );
      try {
        return await adapter.signOut('local');
      } finally {
        clearTimeout(rotated);
      }
    });
    expect(report).toEqual({ serverNotTold: true });
    // The refusal came from the refresh, so nothing was ever said to the server — which is what
    // separates this from [HUNT6-F-MARGIN], where the very same token DID reach /logout: the
    // replacement is what makes the preserve-guard fail.
    expect(fetchCalls.some((url) => url.includes('grant_type=refresh_token'))).toBe(true);
    expect(fetchCalls.some((url) => url.includes('/logout'))).toBe(false);
    expect(localStorage.getItem(STORED)).toBeNull();
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
   * on merely touching `globalThis.localStorage` — and the adapter still REPORTS rather than throwing,
   * which is the fact this case pins.
   *
   * HUNT7-F-1: what the removal does there has changed, and this docstring said the old thing. It used
   * to be `globalThis.localStorage?.removeItem(...)`, which in this browser threw and removed nothing
   * at all; the adapter now owns the store it gave the client, so with localStorage unusable the
   * removal runs against that store instead and reaches the session auth-js is really holding (the
   * [HUNT7-F-1] block below). What this case pins is unchanged: a refusal is reported, never thrown,
   * whatever storage does.
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

  /**
   * HUNT7-F-2: `serverNotTold` said "every error auth-js resolved with", and one class of those
   * errors proves the opposite of what the sentence tells the parent. `_signOut` returns a
   * `sessionError` from `__loadSession` (GoTrueClient.js:3427-3429), which is produced whenever a
   * refresh of an expired session fails — including a refresh the auth server ANSWERED by rejecting
   * this session's own refresh token (a password changed elsewhere, an admin revocation, the
   * `pending` closure's purge). auth-js removes the session itself on that path
   * (`_callRefreshToken`'s non-retryable branch, :4306-4312), so the session provably no longer
   * exists anywhere — and the parent was being told, in a role="alert" above the sign-in form, to
   * change their password over it.
   *
   * The report is derived from whether the auth service was reached, not from "an error came back".
   */
  it('[HUNT7-F-2] reports nothing to the parent when the auth service had already ended the session', async () => {
    localStorage.setItem(STORED, JSON.stringify({ refresh_token: 'synthetic-refresh' }));
    const { adapter, signOut } = adapterWith({
      error: authError(
        'AuthApiError',
        'Invalid Refresh Token: Refresh Token Not Found',
        400,
        'refresh_token_not_found',
      ),
    });
    // The sign-out was carried out by the service before we asked, which is the opposite of a
    // sign-out the service was never told about.
    expect(await adapter.signOut('local')).toBeUndefined();
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    // The local session still goes, whatever is reported.
    expect(localStorage.getItem(STORED)).toBeNull();
  });

  it('[HUNT7-F-2] still warns when the auth service could not be reached at all', async () => {
    localStorage.setItem(STORED, JSON.stringify({ refresh_token: 'synthetic-refresh' }));
    const { adapter } = adapterWith({
      error: authError('AuthRetryableFetchError', 'Failed to fetch', 0),
    });
    expect(await adapter.signOut('local')).toEqual({ serverNotTold: true });
  });

  /**
   * HUNT7-F-2, the other edge: the service answered, and what it answered does NOT say this session
   * is over. A rate-limited or rejected /logout leaves the session alive server-side, so the warning
   * is exactly right there — only an answer naming this session's own credential as gone may silence
   * it.
   */
  it('[HUNT7-F-2] warns when the service answered but did not end the session', async () => {
    localStorage.setItem(STORED, JSON.stringify({ refresh_token: 'synthetic-refresh' }));
    const { adapter } = adapterWith({
      error: authError('AuthApiError', 'Too many requests', 429, 'over_request_rate_limit'),
    });
    expect(await adapter.signOut('local')).toEqual({ serverNotTold: true });
  });

  /**
   * HUNT7-F-1, the mapping itself. auth-js does not reject a read it could not make: `getSession()`
   * resolves `{ data: { session: null }, error }` whenever the session it holds needs a refresh and the
   * refresh fails, which is the same failure that caused the refusal a moment earlier, cached for 60s
   * (constants.js:21). Dropping that `error` — which the adapter did — makes an unreadable session
   * indistinguishable from an absent one, and only the absent one may be told to a parent as "This
   * computer is signed out".
   */
  function adapterReading(read: { session: unknown; error?: { message: string } }) {
    return createSupabaseAuth(
      supabaseConfig,
      () =>
        ({
          auth: {
            getSession: () =>
              Promise.resolve({
                data: { session: read.session },
                ...(read.error ? { error: read.error } : {}),
              }),
            onAuthStateChange: () => ({
              data: { subscription: { unsubscribe: () => undefined } },
            }),
          },
        }) as never,
    );
  }

  it('[HUNT7-F-1] answers “unreadable”, not “signed out”, when the session could not be read', async () => {
    const adapter = adapterReading({
      session: null,
      error: authError('AuthRetryableFetchError', 'Failed to fetch', 0),
    });
    expect(await adapter.readSession?.()).toEqual({ state: 'unreadable' });
    // `currentSession()` cannot carry the difference, which is why it is not what the surfaces ask.
    expect(await adapter.currentSession()).toBeNull();
    expect(await stillSignedIn(adapter)).toBe(true);
  });

  it('[HUNT7-F-1] answers “signed out” for a read that came back empty and clean', async () => {
    const adapter = adapterReading({ session: null });
    expect(await adapter.readSession?.()).toEqual({ state: 'signed_out' });
    expect(await adapter.currentSession()).toBeNull();
    expect(await stillSignedIn(adapter)).toBe(false);
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
 * HUNT7-F-1: the browser BUG-322's own recorded impact names — a shared family, school or library
 * computer with site data blocked — is the one where a refused sign-out could not reach the session at
 * all, and the surfaces said "This computer is signed out" over it anyway.
 *
 * Merely touching `globalThis.localStorage` throws there, so auth-js's `supportsLocalStorage()` is
 * false (lib/helpers.js:61-72, which returns false on the throw BEFORE consulting its
 * `localStorageWriteTests` cache) and, with no `storage` option passed, it holds this origin's session
 * in its own `memoryLocalStorageAdapter` (GoTrueClient.js:249-269) — where a `localStorage.removeItem`
 * cannot reach it. The session is not persisted, which is why round 6 concluded it "cannot outlive the
 * tab"; but it does not have to. The refusal path that leaves it is the pre-flight refresh
 * (retryable failure → `_callRefreshToken` removes nothing, :4290-4313), the auto-refresh ticker
 * refreshes it straight out of that same memory store as soon as the fetch succeeds, and the parent is
 * on the sign-in page one "Parent portal" link away from the family, having been told the computer was
 * signed out.
 *
 * So the adapter owns the store: it hands `createClient` a session store of its own — this origin's
 * localStorage when that is readable AND writable, its own map otherwise — and a refused sign-out
 * clears whatever auth-js actually used, and can say whether it did.
 *
 * Labeled fake auth server below; no network, and every token is synthetic.
 */
describe('[HUNT7-F-1] a refused sign-out in a browser that cannot use localStorage', () => {
  const PARENT = {
    id: '4c1d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
    email: 'pat.parent@example.test',
  };

  /** A browser with site data blocked: reading the property throws, as Chrome and Safari do. */
  function blockSiteData(): () => void {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      get() {
        throw new DOMException('site data blocked', 'SecurityError');
      },
      configurable: true,
    });
    return () => {
      if (real) Object.defineProperty(globalThis, 'localStorage', real);
    };
  }

  /**
   * A labeled fake auth service. It answers a password sign-in with a session that expires in two
   * minutes — outside auth-js's 90s EXPIRY_MARGIN_MS, so reading the session does not set off a
   * proactive refresh — and a refresh with an hour-long one. `offline` makes every request reject,
   * which is what a captive portal, an auth outage and a dropped connection all reach auth-js as.
   */
  function authService() {
    const state = { offline: false };
    const calls: string[] = [];
    const answer = (accessToken: string, refreshToken: string, expiresIn: number) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: accessToken,
            refresh_token: refreshToken,
            token_type: 'bearer',
            expires_in: expiresIn,
            user: PARENT,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    const fetch = ((input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (state.offline) return Promise.reject(new TypeError('Failed to fetch'));
      if (url.includes('grant_type=password'))
        return answer('synthetic.access.1', 'synthetic-r1', 120);
      if (url.includes('grant_type=refresh_token')) {
        return answer('synthetic.access.2', 'synthetic-r2', 3600);
      }
      return Promise.reject(new Error(`unexpected request ${url}`));
    }) as typeof globalThis.fetch;
    return { state, calls, fetch };
  }

  function lockedDownAdapter(service: ReturnType<typeof authService>) {
    return createSupabaseAuth(
      supabaseConfig,
      (url, key, options) =>
        createClient(url, key, {
          auth: { ...options.auth, autoRefreshToken: false, detectSessionInUrl: false },
          global: { fetch: service.fetch },
        }) as never,
    );
  }

  it('leaves no session for the network to bring back', async () => {
    const restore = blockSiteData();
    vi.useFakeTimers();
    try {
      const service = authService();
      const adapter = lockedDownAdapter(service);
      const account = adapter.account;
      expect(account).toBeDefined();
      // The parent signs in on this locked-down browser, so auth-js is holding a session.
      expect(
        await account!.signInWithPassword('pat.parent@example.test', 'synthetic-current-pass'),
      ).toEqual({ ok: true, next: 'signed_in' });
      expect(await adapter.currentSession()).not.toBeNull();

      // They go offline; the access token expires while they are; then they press Sign out. An
      // access token that has REALLY expired is the precondition for the refusal that leaves the
      // session behind: inside the 90s margin auth-js preserves it and reaches /logout instead,
      // which clears it ([HUNT6-F-MARGIN]).
      service.state.offline = true;
      await vi.advanceTimersByTimeAsync(121_000);
      const pending = adapter.signOut('local');
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await pending).toEqual({ serverNotTold: true });
      // The pre-flight refresh failed, so the sign-out never got as far as the server.
      expect(service.calls.some((url) => url.includes('/logout'))).toBe(false);
      // This is the read both surfaces make before they print "This computer is signed out".
      expect(await adapter.currentSession()).toBeNull();

      // The network returns, and the refresh-failure cooldown (60s) lapses.
      service.state.offline = false;
      await vi.advanceTimersByTimeAsync(61_000);
      // The sentence the parent was given has to still be true a minute later.
      expect(await adapter.currentSession()).toBeNull();
    } finally {
      vi.useRealTimers();
      restore();
    }
  });

  it('hands auth-js a store this adapter can clear when localStorage cannot be touched', () => {
    const restore = blockSiteData();
    try {
      let store: SessionStore | undefined;
      createSupabaseAuth(supabaseConfig, (_url, _key, options) => {
        store = options.auth.storage;
        return {
          auth: {
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
          },
        } as never;
      });
      expect(store).toBeDefined();
      // A store the adapter holds: it reads, writes and — the whole point — removes.
      store!.setItem('sb-example-auth-token', 'synthetic');
      expect(store!.getItem('sb-example-auth-token')).toBe('synthetic');
      store!.removeItem('sb-example-auth-token');
      expect(store!.getItem('sb-example-auth-token')).toBeNull();
    } finally {
      restore();
    }
  });

  /**
   * And the ordinary browser is unchanged: the store IS this origin's localStorage, so a signed-in
   * parent survives a reload. Moving every session into memory would sign every parent out on every
   * page load, which is the regression this case exists to catch.
   */
  it('keeps using this origin’s localStorage when it works', () => {
    let store: SessionStore | undefined;
    createSupabaseAuth(supabaseConfig, (_url, _key, options) => {
      store = options.auth.storage;
      return {
        auth: {
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
        },
      } as never;
    });
    expect(store).toBeDefined();
    try {
      store!.setItem(STORED, 'synthetic');
      expect(localStorage.getItem(STORED)).toBe('synthetic');
      expect(store!.getItem(STORED)).toBe('synthetic');
    } finally {
      localStorage.removeItem(STORED);
    }
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
   * HUNT6-F-3, page half: site data is blocked from under the adapter, so `globalThis.localStorage`
   * throws while the sign-out is running — yet the adapter still reports `serverNotTold`, because that
   * report is about the SERVER. The closure flow used to spend that report as "the adapter's own
   * guarantee" that this computer is signed out and hand the parent the public page's sentence saying
   * so. It reads the session instead.
   *
   * HUNT7-F-1: the blocking here lands AFTER the adapter was built, so the store it owns still holds the
   * `Storage` object it captured while that was allowed — which is deliberate, not incidental: a session
   * store read through a captured object survives a property that starts throwing mid-session. What the
   * case pins is the page's decision, which does not depend on either: a report plus a session that can
   * still be read is never presented as a finished sign-out.
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
