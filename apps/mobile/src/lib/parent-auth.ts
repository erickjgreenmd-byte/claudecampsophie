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

  async signOut(): Promise<void> {
    await client?.auth.signOut();
  },

  async email(): Promise<string | null> {
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session?.user.email ?? null;
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
