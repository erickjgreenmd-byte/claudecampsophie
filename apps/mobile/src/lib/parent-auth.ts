import Constants from 'expo-constants';
import {
  createClient,
  isAuthApiError,
  isAuthRetryableFetchError,
  type AuthError,
} from '@supabase/supabase-js';
import type { TokenSource } from '@pencillift/contracts/client';
import { createChunkedStorage } from './chunked-storage.ts';
import { secureStorage } from './secure-storage.ts';

/**
 * Parent sign-in on mobile (Supabase Auth, spec P3). The session lives in the device keychain
 * (chunked), never in plain storage; only the publishable key ships in the bundle. When the owner's
 * project is not configured the app shows an honest "not connected" state (docs/Connections.md).
 */
interface Extra {
  supabaseUrl?: unknown;
  supabasePublishableKey?: unknown;
  portalUrl?: unknown;
}

const extra = (Constants.expoConfig?.extra ?? {}) as Extra;
const url = typeof extra.supabaseUrl === 'string' ? extra.supabaseUrl : null;
const key = typeof extra.supabasePublishableKey === 'string' ? extra.supabasePublishableKey : null;

/** Public web portal origin (sign-up and password reset pages), when configured. */
export const portalUrl: string | null =
  typeof extra.portalUrl === 'string' ? extra.portalUrl : null;

const client =
  url && key
    ? createClient(url, key, {
        auth: {
          storage: createChunkedStorage(secureStorage),
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
      })
    : null;

export type SignInResult = { ok: true } | { ok: false; message: string };

/**
 * What ending this device's session did. The same shape as SignInResult, and deliberately not the
 * same type: a sign-out failure is reported to decide what the screen may CLAIM about the device
 * (HUNT6-J-1), not to offer the parent a retry.
 */
export type SignOutResult = { ok: true } | { ok: false; message: string };

const OFFLINE_MESSAGE =
  'We couldn’t reach PencilLift. You may be offline — check your connection and try again.';
const RATE_LIMIT_MESSAGE = 'Too many tries. Please wait a minute, then try again.';
const NOT_CONNECTED_MESSAGE = 'Parent sign-in isn’t connected on this device yet.';

/**
 * Words for a Supabase Auth failure by its kind (MOB-R1-02): a fetch failure is "offline", a 429
 * is "wait", and only a refused credential reads as a mismatch. Anything else is generic; the raw
 * server text is never shown.
 */
export function signInErrorMessage(error: Pick<AuthError, 'message' | 'status' | 'code'>): string {
  if (isAuthRetryableFetchError(error) || error.status === 0 || error.status === undefined) {
    return OFFLINE_MESSAGE;
  }
  if (error.status === 429 || /rate_limit/.test(error.code ?? '')) return RATE_LIMIT_MESSAGE;
  if (error.code === 'email_not_confirmed' || /confirm|verified/i.test(error.message)) {
    return 'Please verify your email first, using the link we sent you.';
  }
  if (error.code === 'invalid_credentials' || error.status === 400 || error.status === 401) {
    return 'That email and password did not match.';
  }
  if (error.status >= 500) return 'PencilLift isn’t available right now. Please try again soon.';
  return 'Something went wrong. Check your connection and try again.';
}

/** A thrown (not returned) auth failure: supabase-js throws only for non-auth errors. */
function thrownAuthMessage(error: unknown): string {
  if (isAuthApiError(error) || isAuthRetryableFetchError(error)) return signInErrorMessage(error);
  return OFFLINE_MESSAGE;
}

export const parentAuth = {
  configured: client !== null,

  async signIn(email: string, password: string): Promise<SignInResult> {
    if (!client) return { ok: false, message: NOT_CONNECTED_MESSAGE };
    try {
      const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (!error) return { ok: true };
      return { ok: false, message: signInErrorMessage(error) };
    } catch (error) {
      return { ok: false, message: thrownAuthMessage(error) };
    }
  },

  /** Asks for a reset email; a failed request is reported, never mistaken for a sent link. */
  async sendPasswordReset(email: string): Promise<SignInResult> {
    if (!client) return { ok: false, message: NOT_CONNECTED_MESSAGE };
    const redirectTo = portalUrl ? `${portalUrl}/update-password` : undefined;
    try {
      const { error } = await client.auth.resetPasswordForEmail(
        email.trim(),
        redirectTo ? { redirectTo } : {},
      );
      if (!error) return { ok: true };
      return { ok: false, message: signInErrorMessage(error) };
    } catch (error) {
      return { ok: false, message: thrownAuthMessage(error) };
    }
  },

  /**
   * Ends the session on THIS device only (WEB-R2-02). Signing out of the phone must not silently
   * end the parent's web portal session, so the scope is 'local' rather than Supabase's default
   * 'global'. Ending every session is the portal's own "sign out everywhere".
   *
   * It REPORTS what happened (HUNT6-J-1). supabase-js does not throw for a refused or failed
   * sign-out; it returns the failure in `{ error }` — so dropping that `error` left the only wrapper
   * that decides what this app may claim about a signed-out device unable to say anything at all.
   *
   * What it does with the stored session, since this is the file a maintainer reads for it
   * (HUNT7-K-3): with scope 'local', auth-js 2.116 still removes the local session when the logout
   * call failed. `_signOut` calls removeCurrentSession() and only THEN returns the `{ error }`, for an
   * HTTP failure and for a fetch failure alike (AuthRetryableFetchError is not an AuthApiError, so it
   * is not one of the 404/401/403 cases it passes over). The one path that returns an error WITHOUT
   * removing is the early `sessionError` return — the stored session could not be read or refreshed —
   * which is a different fact from "the logout call failed".
   *
   * So `ok: false` means this device cannot say the session ended: either the service was never told,
   * or the session could not be read at all. It is deliberately NOT "this device is still signed in" —
   * that is the adjacent claim, and the copy may claim neither state (src/lib/mode.ts's
   * DeviceSignOutOutcome, src/privacy/parent-privacy.ts). Callers must still not let a failure stop
   * the rest of their sign-out.
   */
  async signOut(): Promise<SignOutResult> {
    // Not configured: there is no session on this device to end, so nothing failed.
    if (!client) return { ok: true };
    try {
      const { error } = await client.auth.signOut({ scope: 'local' });
      return error ? { ok: false, message: signInErrorMessage(error) } : { ok: true };
    } catch (error) {
      return { ok: false, message: thrownAuthMessage(error) };
    }
  },

  async email(): Promise<string | null> {
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session?.user.email ?? null;
  },

  /** The signed-in parent's user id, so device-local secrets can be bound to them (MOB-R2-06). */
  async userId(): Promise<string | null> {
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session?.user.id ?? null;
  },

  /** Bearer token for parent API calls (auto-refreshed by supabase-js). */
  tokenSource: (async () => {
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session?.access_token ?? null;
  }) satisfies TokenSource,

  /** Calls `listener(signedIn)` now and on every sign-in/sign-out; returns an unsubscribe. */
  watch(listener: (signedIn: boolean) => void): () => void {
    if (!client) {
      listener(false);
      return () => undefined;
    }
    void client.auth.getSession().then(({ data }) => listener(data.session !== null));
    const { data } = client.auth.onAuthStateChange((_event, session) => listener(session !== null));
    return () => data.subscription.unsubscribe();
  },
};
