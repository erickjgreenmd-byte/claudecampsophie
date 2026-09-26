/**
 * Parent authentication adapter. Production uses Supabase Auth (verified email + password or magic
 * link, TOTP MFA for owner administration). Until the owner's Supabase project is connected
 * (docs/Connections.md) the portal shows an honest "sign-in is not configured" state instead of a
 * fake login.
 */
export interface ParentSession {
  readonly accessToken: string;
  readonly email: string;
}

/** Result of an account action. Messages are safe to show and never reveal whether an email exists. */
export type AuthOutcome =
  | { readonly ok: true; readonly next: 'signed_in' | 'check_email' | 'done' }
  | { readonly ok: false; readonly message: string };

export interface TotpEnrollment {
  readonly factorId: string;
  /** SVG data URL from the auth service; rendered as an image, never as HTML. */
  readonly qrCode: string;
  readonly secret: string;
}

/**
 * WEBR5-E-1: a two-step lookup that could not be made — offline, a captive portal, an auth outage.
 * auth-js answers a failed `mfa.listFactors()` with `{ data: null, error }` rather than by throwing,
 * so the adapter's only way to report it used to be `null`, which is also how it says "this account
 * has no verified factor". Spending the failure as that answer drops an owner's two-step (aal2)
 * session on the next password grant (WEB-R2-08), so the failure is a value of its own and never an
 * answer. A caller must refuse rather than guess.
 */
export interface TwoStepLookupUnavailable {
  readonly twoStepLookup: 'unavailable';
}

export const TWO_STEP_LOOKUP_UNAVAILABLE: TwoStepLookupUnavailable = {
  twoStepLookup: 'unavailable',
};

/** The verified TOTP factor's id, `null` for "asked, and there is none", or a lookup that failed. */
export type TotpFactorLookup = string | null | TwoStepLookupUnavailable;

export function isTwoStepLookupUnavailable(
  value: TotpFactorLookup,
): value is TwoStepLookupUnavailable {
  return typeof value === 'object' && value !== null && value.twoStepLookup === 'unavailable';
}

/** Account operations (optional so simple test adapters stay small). */
export interface AccountAuth {
  signInWithPassword(email: string, password: string): Promise<AuthOutcome>;
  signUp(email: string, password: string, redirectTo: string): Promise<AuthOutcome>;
  sendMagicLink(email: string, redirectTo: string): Promise<AuthOutcome>;
  sendPasswordReset(email: string, redirectTo: string): Promise<AuthOutcome>;
  updatePassword(password: string): Promise<AuthOutcome>;
  /**
   * This session's assurance level, or `null` when it could not be read at all (WEBR5-E-1): `null`
   * is never "aal1", so a caller deciding whether an owner has to re-prove a factor must refuse.
   */
  assuranceLevel(): Promise<'aal1' | 'aal2' | null>;
  enrollTotp(): Promise<TotpEnrollment | { readonly error: string }>;
  verifyTotp(factorId: string, code: string): Promise<AuthOutcome>;
  verifiedTotpFactorId(): Promise<TotpFactorLookup>;
}

/**
 * WEB-R2-01: how far a sign-out reaches. `local` ends this browser's session only; `global` ends
 * every session of the account. The portal's own "Sign out" is always `local`, so a parent ending
 * a session on a shared computer never signs their phone out (the mirror of MOB-R1-01).
 */
export type SignOutScope = 'local' | 'global';

/**
 * WEB-R4-AUTH-2: a sign-out the auth service did not carry out. This browser's stored session has
 * been removed, but the server was never told, so the session may still be usable elsewhere and the
 * parent has to be told rather than shown a signed-out screen.
 */
export interface SignOutRefused {
  readonly serverNotTold: true;
}

/**
 * What a sign-out did: nothing to report (it was carried out), or a refusal.
 *
 * ACC-WEB-AUTH-A: reported as a value, never as a rejection. Not every caller can be held up by a
 * refusal — the account-closure flow signs the device out after the server has already closed the
 * account and must still reach the page that explains what happens next — and a rejection there
 * skipped that step and left an unhandled promise. `void` in the union keeps the small test adapters
 * below (`() => Promise.resolve()`) valid.
 */
export type SignOutReport = void | SignOutRefused;

export interface AuthAdapter {
  readonly configured: boolean;
  currentSession(): Promise<ParentSession | null>;
  /**
   * Defaults to `local`: a sign-out here never reaches the parent's other devices.
   *
   * WEB-R4-AUTH-2: resolves with a `SignOutRefused` report when the auth service did not end the
   * session, and with nothing when it did. A caller that would otherwise present a signed-out screen
   * must read the report (and may re-check `currentSession()`): the stored refresh token may still be
   * usable server-side. See the Supabase adapter's signOut.
   */
  signOut(scope?: SignOutScope): Promise<SignOutReport>;
  /** Present when real sign-in is available. */
  readonly account?: AccountAuth;
  /** Subscribes to sign-in/sign-out changes; returns an unsubscribe function. */
  onChange?(listener: () => void): () => void;
}

export const unconfiguredAuth: AuthAdapter = {
  configured: false,
  currentSession: () => Promise.resolve(null),
  signOut: () => Promise.resolve(),
};

/** Minimum parent password length (spec P3: adult accounts protect child data). */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * `pat.parent@example.test` → `p•••@example.test`: enough for a parent to notice the portal is
 * showing someone else's session, without printing the address on a shared screen. Lives here
 * (not in the Supabase adapter) so the shell can show it without pulling in the auth SDK.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  const local = at >= 0 ? email.slice(0, at) : email;
  const domain = at >= 0 ? email.slice(at) : '';
  return `${local.slice(0, 1)}•••${domain}`;
}

/** Only same-origin relative paths may be used as a post-sign-in destination (no open redirect). */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/app';
  return next;
}
