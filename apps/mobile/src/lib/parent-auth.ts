import Constants from 'expo-constants';
import { createClient } from '@supabase/supabase-js';
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

export const parentAuth = {
  configured: client !== null,

  async signIn(email: string, password: string): Promise<SignInResult> {
    if (!client)
      return { ok: false, message: 'Parent sign-in isn’t connected on this device yet.' };
    const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (!error) return { ok: true };
    return {
      ok: false,
      message: /confirm|verified/i.test(error.message)
        ? 'Please verify your email first, using the link we sent you.'
        : 'That email and password did not match.',
    };
  },

  async sendPasswordReset(email: string): Promise<void> {
    if (!client) return;
    const redirectTo = portalUrl ? `${portalUrl}/update-password` : undefined;
    await client.auth.resetPasswordForEmail(email.trim(), redirectTo ? { redirectTo } : {});
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
