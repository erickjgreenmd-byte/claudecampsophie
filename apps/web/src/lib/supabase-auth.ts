import { createClient } from '@supabase/supabase-js';
import {
  maskEmail,
  type AccountAuth,
  type AuthAdapter,
  type AuthOutcome,
  type ParentSession,
} from './auth.ts';
import type { WebConfig } from './config.ts';

/** Re-exported from lib/auth.ts, where it no longer needs the auth SDK (WEB-R2-01). */
export { maskEmail };

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

/**
 * WEB-R2-04: proving the account password without replacing this browser's session. A plain
 * `signInWithPassword` on the portal's client issues a new session at aal1 and stores it, which
 * throws away an owner's MFA (aal2) session (WEB-R2-08). The proof runs on a second client that
 * persists nothing and is signed out again immediately.
 */
export interface PasswordProofAuth {
  verifyPassword(email: string, password: string): Promise<AuthOutcome>;
}

export function passwordProofAuth(account: AccountAuth | undefined): PasswordProofAuth | null {
  const candidate = account as (AccountAuth & Partial<PasswordProofAuth>) | undefined;
  return typeof candidate?.verifyPassword === 'function'
    ? (candidate as AccountAuth & PasswordProofAuth)
    : null;
}

/**
 * WEB-R2-04: whether this tab's session came from a password-recovery link (a PKCE `?code=`
 * exchange raising PASSWORD_RECOVERY, or the implicit-flow hash adopted by `acceptRecoveryLink`).
 * Only such a session may set a new password without proving the old one.
 */
export interface RecoverySessionAuth {
  recoveryActive(): boolean;
}

export function recoverySessionAuth(account: AccountAuth | undefined): RecoverySessionAuth | null {
  const candidate = account as (AccountAuth & Partial<RecoverySessionAuth>) | undefined;
  return typeof candidate?.recoveryActive === 'function'
    ? (candidate as AccountAuth & RecoverySessionAuth)
    : null;
}

/** Options handed to `createClient`, so a test factory can assert what a second client persists. */
export interface ClientAuthOptions {
  readonly auth: {
    readonly flowType?: 'pkce' | 'implicit';
    readonly persistSession: boolean;
    readonly detectSessionInUrl: boolean;
    readonly autoRefreshToken: boolean;
    readonly storageKey?: string;
  };
}

export type ClientFactory = (url: string, key: string, options: ClientAuthOptions) => Client;

/**
 * The key supabase-js stores this project's session under. It is exactly the default supabase-js
 * derives from the project URL (`sb-<ref>-auth-token`), spelled out and handed back so a refused
 * sign-out can clear that session itself (WEB-R4-AUTH-2). A URL this cannot parse keeps the SDK's
 * own default and gives up the clearing rather than removing the wrong key.
 */
function sessionStorageKey(supabaseUrl: string): string | null {
  try {
    return `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
  } catch {
    return null;
  }
}

function portalClient(storageKey: string | null): ClientAuthOptions {
  return {
    auth: {
      flowType: 'pkce',
      persistSession: true,
      detectSessionInUrl: true,
      autoRefreshToken: true,
      ...(storageKey ? { storageKey } : {}),
    },
  };
}

/**
 * WEB-R4-AUTH-2: removes this origin's stored session. Used only when supabase-js has refused a
 * sign-out *without* clearing it — with an expired access token it tries a refresh first, and when
 * that fails at the fetch level (offline, captive portal, auth outage) it returns the error before
 * removeCurrentSession(), leaving a still-valid refresh token in localStorage. On a shared family,
 * school or library computer the next person would sign straight back in with it.
 */
function forgetStoredSession(storageKey: string | null): void {
  if (!storageKey) return;
  try {
    globalThis.localStorage?.removeItem(storageKey);
  } catch {
    // Storage blocked (private mode, a locked-down browser): nothing was stored to remove.
  }
}

/**
 * The password-proof client: nothing persisted, nothing refreshed and no URL handling, so it can
 * never take over the portal's stored session or race its token refresh.
 */
const PROOF_CLIENT: ClientAuthOptions = {
  auth: {
    persistSession: false,
    detectSessionInUrl: false,
    autoRefreshToken: false,
  },
};

/**
 * How long one emailed recovery link may set a password without the current one. The grant is also
 * single-use (a successful change closes it) and a sign-out closes it, so an abandoned tab is not a
 * standing permission to take the account over.
 */
const RECOVERY_GRANT_MS = 15 * 60_000;

export function createSupabaseAuth(
  config: WebConfig,
  factory: ClientFactory = (url, key, options) => createClient(url, key, options),
  now: () => number = () => Date.now(),
): AuthAdapter {
  if (!config.supabaseUrl || !config.supabasePublishableKey) {
    throw new Error('Supabase URL and publishable key are required');
  }
  const url = config.supabaseUrl;
  const key = config.supabasePublishableKey;
  const storageKey = sessionStorageKey(url);
  const client = factory(url, key, portalClient(storageKey));
  const auth = client.auth;
  // Opened by the auth server's own PASSWORD_RECOVERY event (a PKCE reset link exchanged by
  // detectSessionInUrl) and by acceptRecoveryLink (a link started in the mobile app). Never opened
  // by an ordinary sign-in, so it cannot be used to skip the current-password proof. The deadline
  // and the closing below are WEB-R2-04's second round: this adapter is created at module scope, so
  // a flag set once and never cleared left one followed link standing for the life of the page.
  let recoveryUntilMs: number | null = null;
  const openRecovery = () => {
    recoveryUntilMs = now() + RECOVERY_GRANT_MS;
  };
  const closeRecovery = () => {
    recoveryUntilMs = null;
  };
  // Guarded: the adapter's unit tests hand in auth stubs with only the methods under test.
  const watch = (auth as Partial<Client['auth']>).onAuthStateChange;
  if (typeof watch === 'function') {
    watch.call(auth, (event) => {
      // SIGNED_IN can arrive beside a recovery link, so only an explicit sign-out closes the grant.
      if (event === 'PASSWORD_RECOVERY') openRecovery();
      if (event === 'SIGNED_OUT') closeRecovery();
      return Promise.resolve();
    });
  }

  const account: AccountAuth & RecoveryLinkAuth & PasswordProofAuth & RecoverySessionAuth = {
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
      if (error) {
        // The grant stays open: the parent should be able to try the same link again.
        return failure(
          'The password could not be changed. Open the newest email link and try again.',
        );
      }
      // One link, one password change (WEB-R2-04). A second change on this page proves the current
      // password like any other signed-in session.
      closeRecovery();
      return { ok: true, next: 'done' };
    },
    /**
     * WEB-R2-04: proves the password on a throwaway client. The portal's stored session is left
     * exactly as it was, so an owner's aal2 session survives a password change or a PIN reset. The
     * proof session is signed out locally at once (its own storage only; never scope 'global',
     * which would end the portal's and the phone's sessions too).
     */
    async verifyPassword(email, password) {
      const proof = factory(url, key, PROOF_CLIENT);
      try {
        const { error } = await proof.auth.signInWithPassword({ email, password });
        if (error) return failure(GENERIC_SIGN_IN_ERROR);
        return { ok: true, next: 'signed_in' };
      } catch {
        return failure(GENERIC_SIGN_IN_ERROR);
      } finally {
        try {
          await proof.auth.signOut({ scope: 'local' });
        } catch {
          // The proof client persists nothing; a failed sign-out leaves nothing behind.
        }
      }
    },
    recoveryActive() {
      return recoveryUntilMs !== null && now() < recoveryUntilMs;
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
        // This session came from a verified recovery link, so /update-password may set a new
        // password here without the current one (WEB-R2-04), once and within the grant window.
        openRecovery();
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
    /**
     * WEB-R2-01: scoped. supabase-js defaults to scope 'global', which would end the parent's
     * phone session as well; the portal's sign-out is local unless a caller asks otherwise.
     */
    async signOut(scope = 'local') {
      // Closed before the call: whatever the server answers, this page is no longer holding a
      // recovery grant (WEB-R2-04).
      closeRecovery();
      // WEB-R4-AUTH-2: the outcome is no longer thrown away. supabase-js resolves with `{ error }`
      // instead of rejecting, and on one path it returns that error before it clears storage (see
      // forgetStoredSession), so a caller that ignored this showed the sign-in page over a session
      // whose refresh token was still in this browser. The session is cleared here and the failure
      // is reported, so no caller can present a refused sign-out as a finished one.
      //
      // ACC-WEB-AUTH-A: reported by returning, not by throwing. The account-closure flow awaits this
      // with no catch and must still reach the page that explains the closure, so a rejection here
      // lost that page and left an unhandled promise. Callers that would show a signed-out screen
      // read the report instead (SignOutControl).
      const { error } = await auth.signOut({ scope });
      if (!error) return;
      forgetStoredSession(storageKey);
      return { serverNotTold: true };
    },
    onChange(listener) {
      const { data } = auth.onAuthStateChange(() => listener());
      return () => data.subscription.unsubscribe();
    },
  };
}
