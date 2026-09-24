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

/** Account operations (optional so simple test adapters stay small). */
export interface AccountAuth {
  signInWithPassword(email: string, password: string): Promise<AuthOutcome>;
  signUp(email: string, password: string, redirectTo: string): Promise<AuthOutcome>;
  sendMagicLink(email: string, redirectTo: string): Promise<AuthOutcome>;
  sendPasswordReset(email: string, redirectTo: string): Promise<AuthOutcome>;
  updatePassword(password: string): Promise<AuthOutcome>;
  assuranceLevel(): Promise<'aal1' | 'aal2' | null>;
  enrollTotp(): Promise<TotpEnrollment | { readonly error: string }>;
  verifyTotp(factorId: string, code: string): Promise<AuthOutcome>;
  verifiedTotpFactorId(): Promise<string | null>;
}

export interface AuthAdapter {
  readonly configured: boolean;
  currentSession(): Promise<ParentSession | null>;
  signOut(): Promise<void>;
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

/** Only same-origin relative paths may be used as a post-sign-in destination (no open redirect). */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/app';
  return next;
}
