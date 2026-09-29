import { createClient } from '@supabase/supabase-js';
import {
  maskEmail,
  TWO_STEP_LOOKUP_UNAVAILABLE,
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
 * sign-out *without* clearing it, which in the pinned @supabase/auth-js 2.116.0 is exactly one path:
 * the stored access token has ALREADY EXPIRED (`expires_at` is in the past), so the refresh token is
 * the only credential left and `__loadSession` must refresh before `_signOut` can have a token at all;
 * that refresh fails at the fetch level (offline, captive portal, auth outage), which is the one
 * refresh failure `_callRefreshToken` does NOT clear storage for; and `_useSession` hands `_signOut`
 * the refresh error as a `sessionError`, which it returns before it reaches `removeCurrentSession()`.
 * A still-usable refresh token is left in localStorage, and on a shared family, school or library
 * computer the next person signs straight back in with it as soon as the network returns.
 *
 * HUNT6-F-MARGIN: "the stored access token is inside EXPIRY_MARGIN_MS" was the precondition this
 * comment stated, and a token merely inside that margin takes the OTHER path. Being inside the 90s
 * margin is only what makes `__loadSession` refresh at all; when that refresh fails, auth-js compares
 * the access token against its REAL expiry, and while the token is still valid it keeps the stored
 * session and returns it with `error: null` (its proactive-preserve branch, mirrored in
 * `_callRefreshToken`). `_signOut` therefore still has an access token, calls /logout, and lands on the
 * other refusal path described next — the one that removes the session before returning. Expiry, not
 * the margin, is what leaves a refresh token behind. (auth-js also drops the fallback when storage
 * changed under the refresh, but then the stored session is already gone and this has nothing to
 * remove.) Run against the real library in App.signout.test.tsx's [HUNT6-F-MARGIN] case, beside the
 * expired-token case it is contrasted with.
 *
 * HUNT6-F-PREMISE: on auth-js's OTHER refusal path — the /logout request itself failing with anything
 * but 404/401/403/session-missing — the order is the reverse. `removeCurrentSession()` runs inside
 * that error branch and only then is the error returned, so there is nothing left for this to remove
 * and it is a no-op. The mechanism this comment used to cite, "it returns the error before
 * removeCurrentSession(), so its in-memory session survives the removal", is in neither path: 2.116.0
 * holds no in-memory session at all. `getSession()` goes through `__loadSession`, which re-reads
 * `this.storage` on every call, and `this.storage` is `globalThis.localStorage` whenever
 * `supportsLocalStorage()` is true — so removing that key removes what `getSession()` reads. Both
 * paths are run against the real library in App.signout.test.tsx's [HUNT6-F-PREMISE] cases.
 *
 * Still best-effort, and callers are promised no more than that (the SignOutRefused doc in
 * lib/auth.ts): this cannot report a failure, and with site data blocked it removes nothing.
 */
function forgetStoredSession(storageKey: string | null): void {
  if (!storageKey) return;
  try {
    globalThis.localStorage?.removeItem(storageKey);
  } catch {
    // Storage blocked (site data blocked, a locked-down browser): merely touching localStorage
    // throws, so auth-js's supportsLocalStorage() is false and this origin's session is held in its
    // memoryLocalStorageAdapter instead — where a localStorage removal cannot reach it. Nothing is
    // removed here, and nothing was persisted either, so that session cannot outlive the tab; what
    // this function can establish is unchanged, which is why the report stays about the server alone
    // and the callers read the session for themselves (HUNT6-F-3, HUNT6-F-PREMISE).
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
    /**
     * `null` only when the level could not be read at all — never as a stand-in for aal1.
     *
     * HUNT6-F-2: guarded on the field that carries the level, not on the wrapper around it. auth-js
     * does not report an unreadable level through `data`: its no-jwt branch resolves `{ data: {
     * currentLevel: null, nextLevel: null, currentAuthenticationMethods: [] }, error: null }`, both
     * when there is no session and when the access token carries no `aal` claim. Checking `error`
     * and `data` alone left that case to the mapping below, which spent it as 'aal1' — the one
     * answer this comment says `null` must never stand in for, and enough for PinResetPage to run
     * the session-replacing password grant with no two-step step. `!data.currentLevel` is the whole
     * fact: a level was read, or it was not.
     */
    async assuranceLevel() {
      const { data, error } = await auth.mfa.getAuthenticatorAssuranceLevel();
      if (error || !data || !data.currentLevel) return null;
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
    /**
     * WEBR5-E-1: a lookup that failed is reported as such, not as `null`. auth-js resolves
     * `mfa.listFactors()` with `{ data: null, error }` for every failure it knows — an offline
     * fetch, a captive portal, an auth outage — and never rejects, so returning `null` here made a
     * failure indistinguishable from "this account has no verified factor". PinResetPage then
     * skipped the two-step re-verification and the owner's own PIN reset left them at aal1.
     */
    async verifiedTotpFactorId() {
      const { data, error } = await auth.mfa.listFactors();
      if (error || !data) return TWO_STEP_LOOKUP_UNAVAILABLE;
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
      // ACC-WEB-AUTH-A: reported by returning, not by throwing. The account-closure flow must still
      // reach the page that explains the closure, so a rejection here lost that page and left an
      // unhandled promise. Callers that would show a signed-out screen read the report instead
      // (SignOutControl).
      //
      // HUNT5-E-3: that flow has since grown a try/catch of its own (PrivacyControlsPage), and
      // SignOutControl has one too, so no production caller is catch-free any more. The rule stands
      // — those catches are belt and braces, and a page that swallows a refusal cannot tell the
      // parent about it — but it is no longer observable through either page, so it is asserted on
      // this adapter directly (App.signout.test.tsx, ACC-WEB-AUTH-A).
      //
      // HUNT6-F-3: the report says the SERVER was not told, and only that. The clearing below is
      // best-effort (forgetStoredSession) and cannot report what it achieved, so both callers re-read
      // currentSession() before showing a signed-out screen; this return value is never a statement
      // that this origin's session is gone.
      //
      // HUNT6-F-PREMISE: with this pinned auth-js that read is expected to find nothing. Every path on
      // which auth-js resolves with an error leaves `getSession()` answering `session: null` — it
      // removes the session itself before returning a /logout failure, and a pre-flight refresh that
      // failed is the same failure `getSession()` goes on to hit. The read is kept all the same,
      // because that is a fact about one pinned version's internals while "This computer is signed
      // out" is a sentence said to a parent, and the read is the only thing that establishes it. It is
      // not dead either: it fires for an adapter that throws, a currentSession() that throws, a
      // storage adapter other than the two auth-js picks for itself, and the next auth-js.
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
