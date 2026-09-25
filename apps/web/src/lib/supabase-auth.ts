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

/**
 * R2C-WEB-3: a password reset requested in the mobile app. The app's Supabase client uses the
 * implicit flow, so its reset link lands on `/update-password#access_token=…&refresh_token=…&
 * type=recovery`. This PKCE client ignores that hash (`detectSessionInUrl` only exchanges a PKCE
 * `?code=` here), so the update-password page adopts it explicitly and only there. Every other flow
 * stays PKCE.
 */
export interface RecoveryLinkTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export type RecoveryLinkOutcome =
  { readonly ok: true; readonly email: string } | { readonly ok: false };

/** Optional account capability (the Supabase adapter has it; simple test adapters need not). */
export interface RecoveryLinkAuth {
  /** Signs in with the link's tokens after the auth server verifies them; never throws. */
  acceptRecoveryLink(tokens: RecoveryLinkTokens): Promise<RecoveryLinkOutcome>;
}

export function recoveryLinkAuth(account: AccountAuth | undefined): RecoveryLinkAuth | null {
  const candidate = account as (AccountAuth & Partial<RecoveryLinkAuth>) | undefined;
  return typeof candidate?.acceptRecoveryLink === 'function'
    ? (candidate as AccountAuth & RecoveryLinkAuth)
    : null;
}

/**
 * The tokens of an implicit-flow recovery link, or null. Only `type=recovery` with both an access
 * and a refresh token qualifies; any other hash keeps today's handling (AuthLinkNotice).
 */
export function readRecoveryLinkTokens(hash: string): RecoveryLinkTokens | null {
  const fragment = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const accessToken = fragment.get('access_token');
  const refreshToken = fragment.get('refresh_token');
  if (fragment.get('type') !== 'recovery' || !accessToken || !refreshToken) return null;
  return { accessToken, refreshToken };
}

/** `pat.parent@example.test` → `p•••@example.test`: enough to notice someone else's link. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  const local = at >= 0 ? email.slice(0, at) : email;
  const domain = at >= 0 ? email.slice(at) : '';
  return `${local.slice(0, 1)}•••${domain}`;
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

  const account: AccountAuth & RecoveryLinkAuth = {
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
    async acceptRecoveryLink({ accessToken, refreshToken }) {
      try {
        // setSession verifies the access token with the auth server (or refreshes an expired one)
        // before it stores the session, so a forged or revoked token signs nobody in.
        const { data, error } = await auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        const email = data.user?.email ?? data.session?.user.email;
        if (error || !data.session || !email) return { ok: false };
        return { ok: true, email };
      } catch {
        return { ok: false };
      }
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
