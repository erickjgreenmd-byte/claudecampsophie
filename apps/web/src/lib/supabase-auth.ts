import { createClient } from '@supabase/supabase-js';
import {
  maskEmail,
  TWO_STEP_LOOKUP_UNAVAILABLE,
  type AccountAuth,
  type AuthAdapter,
  type AuthOutcome,
  type ParentSession,
  type SessionRead,
  type SignOutReport,
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

/**
 * HUNT7-F-1: the store the portal's session lives in, owned by this adapter instead of guessed at.
 *
 * Without a `storage` option auth-js picks its own: `globalThis.localStorage` when
 * `supportsLocalStorage()` is true, and otherwise its internal `memoryLocalStorageAdapter`
 * (GoTrueClient.js:249-269). That second case is a browser with site data blocked — a locked-down
 * school, library or family computer — and there a `localStorage.removeItem` cannot reach the session
 * auth-js is actually using: the removal either throws or succeeds as a no-op on a key nobody wrote.
 * The session stays in that memory store with its refresh token, the auto-refresh ticker brings it back
 * as soon as the network returns, and the parent has already been told this computer is signed out.
 *
 * Passing a store settles it: the adapter clears whatever auth-js used, and can say whether it did
 * (`forgetStoredSession`). The shape is exactly auth-js's `SupportedStorage` minus the parts it does not
 * need — three methods, no key enumeration (`removeAllPKCEVerifiers` asks only for named keys,
 * lib/helpers.js:395-402).
 */
export interface SessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Options handed to `createClient`, so a test factory can assert what a second client persists. */
export interface ClientAuthOptions {
  readonly auth: {
    readonly flowType?: 'pkce' | 'implicit';
    readonly persistSession: boolean;
    readonly detectSessionInUrl: boolean;
    readonly autoRefreshToken: boolean;
    readonly storageKey?: string;
    readonly storage?: SessionStore;
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

function portalClient(storageKey: string | null, storage: SessionStore): ClientAuthOptions {
  return {
    auth: {
      flowType: 'pkce',
      persistSession: true,
      detectSessionInUrl: true,
      autoRefreshToken: true,
      storage,
      ...(storageKey ? { storageKey } : {}),
    },
  };
}

/**
 * This origin's localStorage when it is both readable and writable, or null. The write probe is not
 * belt and braces: "block site data" in Chrome and Safari leaves a `localStorage` object in place whose
 * every write throws, and delegating to it would break sign-in itself. auth-js applies the same two
 * tests before choosing its own store (lib/helpers.js:61-90), so the store chosen here is the store
 * auth-js would have chosen — the difference is only that this adapter holds it.
 */
function usableLocalStorage(): Storage | null {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const probe = `pl-storage-probe-${Math.random()}`;
    storage.setItem(probe, probe);
    storage.removeItem(probe);
    return storage;
  } catch {
    // Site data blocked, or a locked-down browser: reading the property or writing to it throws.
    return null;
  }
}

/**
 * HUNT7-F-1: the session store this adapter hands the portal's client. localStorage when it works, so a
 * signed-in parent still survives a reload and other tabs still share the slot; this page's own map
 * otherwise, which is what auth-js would have used anyway — except that this one can be cleared.
 *
 * Reads and writes are deliberately NOT swallowed for the localStorage case. A read that throws must
 * reach `getSession()` and come back as "unreadable" (see `readSession`); swallowing it would turn a
 * session that could not be read into a session that is gone, which is the defect this exists to close.
 */
export function createSessionStore(): SessionStore {
  const local = usableLocalStorage();
  if (local) {
    return {
      getItem: (key) => local.getItem(key),
      setItem: (key, value) => local.setItem(key, value),
      removeItem: (key) => local.removeItem(key),
    };
  }
  const held = new Map<string, string>();
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  };
}

/**
 * What the removal below achieved. HUNT7-F-1: it is an answer now, not a silence — the store belongs to
 * this adapter, so "the session is gone from where auth-js reads it" is a fact it can check rather than
 * hope for, and `signOut` uses it to decide whether auth-js still has a teardown to do (HUNT7-F-3).
 */
type SessionRemoval = 'removed' | 'absent' | 'kept';

/**
 * WEB-R4-AUTH-2: removes the session from the store this adapter handed the client. Used only when
 * supabase-js has refused a sign-out *without* clearing it, so a still-usable refresh token is left
 * behind — and on a shared family, school or library computer the next person is signed straight back
 * in with it as soon as the network returns.
 *
 * HUNT7-F-5: a refusal leaves a stored session whenever `__loadSession` returns a `sessionError`
 * (GoTrueClient.js:3427-3429), and in the pinned @supabase/auth-js 2.116.0 there are TWO ways to get
 * one, not one:
 *  (i) the stored access token has ALREADY EXPIRED, so the refresh token is the only credential left,
 *      `__loadSession` must refresh before `_signOut` can have a token at all, and that refresh fails
 *      at the fetch level (offline, captive portal, auth outage) — the one refresh failure
 *      `_callRefreshToken` does not clear storage for (:4290-4313);
 *  (ii) the access token is still valid and the refresh failed, but another writer REPLACED the stored
 *      slot while it was failing — another tab's refresh rotating the session (`_saveSession`,
 *      :4265-4272). The proactive-preserve branch hands the stored session back only while the slot
 *      still holds the SAME refresh token (:2578-2588), so a replacement makes it return
 *      `{ session: null, error }` although storage holds a newer, perfectly valid session.
 * On (ii) the session removed here is that valid replacement. Removing it is the intended outcome — the
 * parent pressed Sign out — but it is also a removal the OTHER tab is affected by, which is the reason
 * the teardown in `signOut` matters. The earlier wording said (ii) could not happen because "the stored
 * session is already gone and this has nothing to remove"; that is true only of the cleared half of
 * that guard, and the library's own debug line distinguishes the two (`nowHolds: 'replaced'` vs
 * `'cleared'`, :4250). App.signout.test.tsx's [HUNT7-F-5] case runs (ii) against the real library.
 *
 * HUNT6-F-MARGIN: being inside EXPIRY_MARGIN_MS is NOT what leaves a session behind. Inside the 90s
 * margin is only what makes `__loadSession` refresh at all; when that refresh fails auth-js compares the
 * access token against its REAL expiry and, while it is still valid, keeps the stored session and returns
 * it with `error: null`. `_signOut` therefore still has an access token, calls /logout, and lands on the
 * refusal path described next. Expiry — or a replaced slot — is what leaves a refresh token behind.
 *
 * HUNT6-F-PREMISE: on auth-js's OTHER refusal path — the /logout request itself failing with anything
 * but 404/401/403/session-missing — the order is the reverse. `removeCurrentSession()` runs inside that
 * error branch and only then is the error returned, so there is nothing left for this to remove and it
 * answers `absent`. The mechanism this comment used to cite, "it returns the error before
 * removeCurrentSession(), so its in-memory session survives the removal", is in neither path: 2.116.0
 * holds no in-memory session at all. `getSession()` goes through `__loadSession`, which re-reads its
 * storage on every call — and that storage is the store passed here, so removing this key removes what
 * `getSession()` reads. Both paths are run against the real library in App.signout.test.tsx's
 * [HUNT6-F-PREMISE] cases.
 */
function forgetStoredSession(store: SessionStore, storageKey: string | null): SessionRemoval {
  // Only reachable with a project URL `new URL()` cannot parse, which `createClient` itself rejects
  // first (supabase-js validateSupabaseUrl) — so this cannot happen while the adapter lives. If it ever
  // does, the key auth-js chose for itself is not known here, and a removal that cannot name its key
  // must not claim to have made one.
  if (!storageKey) return 'kept';
  try {
    if (store.getItem(storageKey) === null) return 'absent';
    store.removeItem(storageKey);
    return store.getItem(storageKey) === null ? 'removed' : 'kept';
  } catch {
    // A store that throws on a read or a write says nothing about what it holds, so neither does this.
    // The session may still be there, and `readSession` answers `unreadable` over it rather than
    // letting a surface print "This computer is signed out" (HUNT7-F-1).
    return 'kept';
  }
}

/**
 * HUNT7-F-2: GoTrue error codes that say this session is not (or is no longer) on the auth service.
 * `session_not_found` is auth-js's own reading of it — "the `session_id` inside the JWT does not
 * correspond to a row in the `sessions` table … the user has signed out, has been deleted, or their
 * session has somehow been terminated" (lib/fetch.js:82-86, which raises AuthSessionMissingError for it);
 * `session_expired` and `refresh_token_not_found` are the same fact about this session's two credentials.
 *
 * `refresh_token_already_used` is deliberately NOT here. It can mean the same thing, but it is also what
 * a token another tab has just rotated answers, and whether the service revoked the rest of the session
 * with it is not something this file can establish — so the parent keeps the warning, which is the
 * cautious direction.
 */
const SESSION_ALREADY_ENDED_CODES: readonly string[] = [
  'session_not_found',
  'session_expired',
  'refresh_token_not_found',
];

/**
 * HUNT7-F-2: whether the error auth-js resolved a sign-out with proves the auth service had ALREADY
 * ended this session — the opposite of "the server was never told", and the one case where warning the
 * parent to change their password would be a false statement about their account.
 *
 * Both halves are read off the error, and both are facts auth-js constructs: `name` is how auth-js tells
 * its own error classes apart (lib/errors.js `isAuthApiError`, `isAuthSessionMissingError`), and an
 * `AuthApiError` is only ever built from an answer the service gave (lib/fetch.js `handleError`) — a
 * request that got no answer at all, a rejected fetch or a 5xx/gateway failure, is an
 * `AuthRetryableFetchError` instead. So: the service answered, and what it answered names this session's
 * own credential as gone. Anything else — offline, a 5xx, a rate limit, a refusal that does not say the
 * session ended — leaves the session possibly alive and keeps the report.
 */
function serviceEndedTheSession(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  // `_signOut` swallows this one itself today (GoTrueClient.js:3428), so it is not reachable through
  // this adapter — but it is the plainest statement of the fact, and it must never be read as a refusal.
  if (candidate.name === 'AuthSessionMissingError') return true;
  return (
    candidate.name === 'AuthApiError' &&
    typeof candidate.code === 'string' &&
    SESSION_ALREADY_ENDED_CODES.includes(candidate.code)
  );
}

/**
 * The password-proof client: nothing persisted, nothing refreshed and no URL handling, so it can
 * never take over the portal's stored session or race its token refresh. It is handed no `storage`
 * either: with `persistSession: false` auth-js ignores the option and uses a memory store of its own
 * (GoTrueClient.js:249-269), and a second writer on the portal's session slot is exactly what
 * WEB-R2-04 exists to prevent.
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
  const store = createSessionStore();
  const client = factory(url, key, portalClient(storageKey, store));
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

  /**
   * HUNT7-F-1: the read that keeps auth-js's `error`, because dropping it spent "the session could not
   * be read" as "there is no session".
   *
   * `getSession()` resolves `{ data: { session: null }, error }` — it does not reject — whenever the
   * session it holds needs a refresh and that refresh fails, and `_callRefreshToken` caches that failure
   * for REFRESH_FAILURE_COOLDOWN_MS (60s, constants.js:21), so the read right after a refused sign-out
   * hits the very same failure that caused the refusal. On the one path that leaves a session behind,
   * the session is still there with a usable refresh token while this read comes back empty. That is
   * `unreadable`, not `signed_out`, and `stillSignedIn` in lib/auth.ts keeps the parent signed in over it.
   *
   * A session object that is present but carries no access token or no email is `unreadable` too: it
   * exists, so this browser is not signed out, and it cannot be used, so it is not a session either.
   */
  const readSession = async (): Promise<SessionRead> => {
    const { data, error } = await auth.getSession();
    const session = data.session;
    if (!session?.access_token || !session.user?.email) {
      return error || session ? { state: 'unreadable' } : { state: 'signed_out' };
    }
    return {
      state: 'signed_in',
      session: { accessToken: session.access_token, email: session.user.email },
    };
  };

  return {
    configured: true,
    account,
    async currentSession(): Promise<ParentSession | null> {
      const read = await readSession();
      return read.state === 'signed_in' ? read.session : null;
    },
    readSession,
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
      // HUNT6-F-3: the report says the SERVER was not told, and only that. The clearing below reports
      // what it achieved to this function, not to the caller, so both callers read the session
      // (`stillSignedIn`) before showing a signed-out screen; this return value is never a statement
      // that this origin's session is gone.
      //
      // HUNT6-F-PREMISE: with this pinned auth-js that read is expected to find nothing. Every path on
      // which auth-js resolves with an error leaves `getSession()` answering `session: null` — it
      // removes the session itself before returning a /logout failure, and a pre-flight refresh that
      // failed is the same failure `getSession()` goes on to hit. The read is kept all the same,
      // because that is a fact about one pinned version's internals while "This computer is signed
      // out" is a sentence said to a parent, and the read is the only thing that establishes it.
      //
      // HUNT7-F-1: and "answering `session: null`" is not the same fact as "the session is gone", which
      // is why that read now keeps the error (readSession above). The session store is this adapter's
      // own (createSessionStore), so the removal below reaches whatever auth-js is using — including
      // the memory store it falls back to when site data is blocked, where a localStorage removal
      // reached nothing and the session came back with the network.
      const { error } = await auth.signOut({ scope });
      if (!error) return;
      // HUNT7-F-2: decided before the removal and the teardown, and from the error alone: an answer
      // proving the service had already ended this session is the opposite of a service that was never
      // told, and must not put "change your password if you are worried" in front of a parent.
      const report: SignOutReport = serviceEndedTheSession(error)
        ? undefined
        : { serverNotTold: true };
      // HUNT7-F-3: a removal made here raises no SIGNED_OUT and posts nothing on the per-storageKey
      // BroadcastChannel, because `_removeSession()` is the only place auth-js does either
      // (GoTrueClient.js:4416-4433, :4345-4354) and it registers no 'storage' listener. So a second
      // portal tab kept the family's children, scans, verdicts and guardian emails on screen, and its
      // "Signed in as …" line, after this tab told the parent the computer was signed out — while a
      // sign-out auth-js CARRIED OUT dropped that tab to the sign-in prompt. With the session now out
      // of the store, a second signOut takes the token-less path (:3423-3448: no sessionError, no
      // access token, so no request) straight to `removeCurrentSession()`, which raises the event and
      // broadcasts it. Teardown only: the report above is already decided and is not recomputed, and
      // this runs only where auth-js has not torn down already ('absent') and where the session really
      // did leave the store ('kept' means it may still be there).
      if (forgetStoredSession(store, storageKey) === 'removed') {
        try {
          await auth.signOut({ scope });
        } catch {
          // Teardown, not the outcome: the parent is told what the first call established either way.
        }
      }
      return report;
    },
    onChange(listener) {
      const { data } = auth.onAuthStateChange(() => listener());
      return () => data.subscription.unsubscribe();
    },
  };
}
