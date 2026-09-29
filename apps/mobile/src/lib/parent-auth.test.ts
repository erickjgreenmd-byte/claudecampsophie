// Parent sign-in error copy (MOB-R1-02). Supabase Auth is exercised through the real supabase-js
// client against a labeled fake fetch; the keychain and Expo config are vitest mocks. No real
// credentials: the email and password are synthetic.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-constants', () => ({
  default: {
    expoConfig: {
      extra: {
        supabaseUrl: 'https://auth.example.invalid',
        supabasePublishableKey: 'sb_publishable_mock0000000000000',
        portalUrl: 'https://portal.example.invalid',
      },
    },
  },
}));
vi.mock('./secure-storage.ts', () => {
  const data = new Map<string, string>();
  return {
    secureStorage: {
      getItem: (k: string) => Promise.resolve(data.get(k) ?? null),
      setItem: (k: string, v: string) => {
        data.set(k, v);
        return Promise.resolve();
      },
      deleteItem: (k: string) => {
        data.delete(k);
        return Promise.resolve();
      },
    },
  };
});

const { parentAuth } = await import('./parent-auth.ts');

function authResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parent sign-in error copy (MOB-R1-02)', () => {
  it('an offline device is told it is offline, not that the password was wrong', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Network request failed')));
    const result = await parentAuth.signIn('riley.parent@example.test', 'not-a-real-password');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/offline|connection/i);
    expect(result.message).not.toMatch(/did not match/);
  });

  it('a rate limit says to wait, not that the password was wrong', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        authResponse(429, {
          code: 429,
          error_code: 'over_request_rate_limit',
          msg: 'Request rate limit reached',
        }),
      ),
    );
    const result = await parentAuth.signIn('riley.parent@example.test', 'not-a-real-password');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/too many|wait/i);
    expect(result.message).not.toMatch(/did not match/);
  });

  it('wrong credentials still read as a mismatch, and an unverified email says so', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        authResponse(400, {
          code: 400,
          error_code: 'invalid_credentials',
          msg: 'Invalid login credentials',
        }),
      ),
    );
    expect(await parentAuth.signIn('riley.parent@example.test', 'not-a-real-password')).toEqual({
      ok: false,
      message: 'That email and password did not match.',
    });
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        authResponse(400, {
          code: 400,
          error_code: 'email_not_confirmed',
          msg: 'Email not confirmed',
        }),
      ),
    );
    const unverified = await parentAuth.signIn('riley.parent@example.test', 'not-a-real-password');
    expect(unverified.ok).toBe(false);
    if (!unverified.ok) expect(unverified.message).toMatch(/verify your email/i);
  });

  it('a failed password-reset request is reported as failed, never as a sent link', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Network request failed')));
    const offline = await parentAuth.sendPasswordReset('riley.parent@example.test');
    expect(offline.ok).toBe(false);
    if (!offline.ok) expect(offline.message).toMatch(/offline|connection/i);

    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        authResponse(429, {
          code: 429,
          error_code: 'over_email_send_rate_limit',
          msg: 'Email rate limit exceeded',
        }),
      ),
    );
    const limited = await parentAuth.sendPasswordReset('riley.parent@example.test');
    expect(limited.ok).toBe(false);

    vi.stubGlobal('fetch', () => Promise.resolve(authResponse(200, {})));
    expect(await parentAuth.sendPasswordReset('riley.parent@example.test')).toEqual({ ok: true });
  });
});

/**
 * HUNT6-J-1. supabase-js does not THROW for a refused or failed sign-out: it returns the failure in
 * `{ error }`, and when the logout call failed it does not remove the local session either. This
 * wrapper dropped that `error` and answered `Promise<void>`, so the one layer that could see "this
 * device is still signed in" threw the fact away — and the account-closure screen, which tells the
 * parent "and this device is signed out" about the device they are about to put down, had nothing
 * left to read but "nothing threw".
 */
describe('signing out reports whether the session ended (HUNT6-J-1)', () => {
  /** A synthetic password grant, as GoTrue answers one. No real credentials. */
  const grant = {
    access_token: 'mock-access-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'mock-refresh-token',
    user: {
      id: '11111111-1111-4111-8111-111111111111',
      aud: 'authenticated',
      role: 'authenticated',
      email: 'riley.parent@example.test',
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-09-24T15:00:00.000Z',
    },
  };

  async function signedIn(): Promise<void> {
    vi.stubGlobal('fetch', () => Promise.resolve(authResponse(200, grant)));
    expect(await parentAuth.signIn('riley.parent@example.test', 'not-a-real-password')).toEqual({
      ok: true,
    });
    expect(await parentAuth.userId()).toBe(grant.user.id);
  }

  it('[repro] a logout the service refuses is reported, not reported as a sign-out', async () => {
    await signedIn();
    vi.stubGlobal('fetch', (input: string | URL) =>
      input.toString().includes('/logout')
        ? Promise.resolve(authResponse(500, { code: 500, msg: 'Internal Server Error' }))
        : Promise.resolve(authResponse(200, grant)),
    );
    const result = await parentAuth.signOut();
    expect(result.ok).toBe(false);
    // What `ok: false` stands for, checked against the library rather than assumed: auth-js 2.116
    // removes the LOCAL session even when the logout call failed, so this is "the service was not
    // told", not "the device is still signed in". That is why the closure copy claims neither state
    // and says the app could not confirm (src/privacy/parent-privacy.ts).
    expect(await parentAuth.userId()).toBeNull();
  });

  it('a logout that goes through is reported as a sign-out, and the session is gone', async () => {
    await signedIn();
    vi.stubGlobal('fetch', (input: string | URL) =>
      input.toString().includes('/logout')
        ? Promise.resolve(new Response(null, { status: 204 }))
        : Promise.resolve(authResponse(200, grant)),
    );
    expect(await parentAuth.signOut()).toEqual({ ok: true });
    expect(await parentAuth.userId()).toBeNull();
  });

  it('a logout that cannot even be attempted is reported too, in the app’s own words', async () => {
    await signedIn();
    vi.stubGlobal('fetch', (input: string | URL) =>
      input.toString().includes('/logout')
        ? Promise.reject(new TypeError('Network request failed'))
        : Promise.resolve(authResponse(200, grant)),
    );
    const result = await parentAuth.signOut();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/offline|connection/i);
  });
});
