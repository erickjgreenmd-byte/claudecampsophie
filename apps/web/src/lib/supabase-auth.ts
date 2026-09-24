import { createClient } from '@supabase/supabase-js';
import type { AccountAuth, AuthAdapter, AuthOutcome, ParentSession } from './auth.ts';
import type { WebConfig } from './config.ts';

/**
 * Supabase Auth adapter for the parent portal. Only the publishable key ships to browsers; every
 * authorization decision is re-made by the API from the verified access token. PKCE flow, session
 * persisted by supabase-js in this origin's storage.
 */

type Client = ReturnType<typeof createClient>;

const GENERIC_SIGN_IN_ERROR =
  'That email and password did not match. Try again or reset your password.';
const GENERIC_LINK_SENT: AuthOutcome = { ok: true, next: 'check_email' };

function failure(message: string): AuthOutcome {
  return { ok: false, message };
}

export function createSupabaseAuth(
  config: WebConfig,
  factory: (url: string, key: string) => Client = (url, key) =>
    createClient(url, key, {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        detectSessionInUrl: true,
        autoRefreshToken: true,
      },
    }),
): AuthAdapter {
  if (!config.supabaseUrl || !config.supabasePublishableKey) {
    throw new Error('Supabase URL and publishable key are required');
  }
  const client = factory(config.supabaseUrl, config.supabasePublishableKey);
  const auth = client.auth;

  const account: AccountAuth = {
    async signInWithPassword(email, password) {
      const { error } = await auth.signInWithPassword({ email, password });
      if (error) {
        return failure(
          /confirm|verified/i.test(error.message)
            ? 'Please verify your email first, using the link we sent you.'
            : GENERIC_SIGN_IN_ERROR,
        );
      }
      return { ok: true, next: 'signed_in' };
    },
    async signUp(email, password, redirectTo) {
      const { error } = await auth.signUp({
        email,
        password,
        options: { emailRedirectTo: redirectTo },
      });
      // Same answer whether or not the email already has an account (no account enumeration).
      if (error && !/registered|exists/i.test(error.message)) {
        return failure(
          'We could not create the account. Check the email and password and try again.',
        );
      }
      return GENERIC_LINK_SENT;
    },
    async sendMagicLink(email, redirectTo) {
      await auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
      });
      return GENERIC_LINK_SENT;
    },
    async sendPasswordReset(email, redirectTo) {
      await auth.resetPasswordForEmail(email, { redirectTo });
      return GENERIC_LINK_SENT;
    },
    async updatePassword(password) {
      const { error } = await auth.updateUser({ password });
      return error
        ? failure('The password could not be changed. Open the newest email link and try again.')
        : { ok: true, next: 'done' };
    },
    async assuranceLevel() {
      const { data, error } = await auth.mfa.getAuthenticatorAssuranceLevel();
      if (error) return null;
      return data.currentLevel === 'aal2' ? 'aal2' : 'aal1';
    },
    async enrollTotp() {
      const { data, error } = await auth.mfa.enroll({ factorType: 'totp' });
      if (error) return { error: 'Two-step verification could not be started. Try again.' };
      return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
    },
    async verifyTotp(factorId, code) {
      const { error } = await auth.mfa.challengeAndVerify({ factorId, code });
      return error
        ? failure('That code did not work. Check the time on your device and try again.')
        : { ok: true, next: 'done' };
    },
    async verifiedTotpFactorId() {
      const { data, error } = await auth.mfa.listFactors();
      if (error) return null;
      return data.totp.find((f) => f.status === 'verified')?.id ?? null;
    },
  };

  return {
    configured: true,
    account,
    async currentSession(): Promise<ParentSession | null> {
      const { data } = await auth.getSession();
      const session = data.session;
      if (!session?.access_token || !session.user.email) return null;
      return { accessToken: session.access_token, email: session.user.email };
    },
    async signOut() {
      await auth.signOut();
    },
    onChange(listener) {
      const { data } = auth.onAuthStateChange(() => listener());
      return () => data.subscription.unsubscribe();
    },
  };
}
