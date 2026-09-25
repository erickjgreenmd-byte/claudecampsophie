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
