/**
 * Parent authentication adapter. Production uses Supabase Auth (verified email + password or magic
 * link, optional MFA). Until the owner's Supabase project is connected (docs/Connections.md) the
 * portal shows an honest "sign-in is not configured" state instead of a fake login.
 */
export interface ParentSession {
  readonly accessToken: string;
  readonly email: string;
}

export interface AuthAdapter {
  readonly configured: boolean;
  currentSession(): Promise<ParentSession | null>;
  signOut(): Promise<void>;
}

export const unconfiguredAuth: AuthAdapter = {
  configured: false,
  currentSession: () => Promise.resolve(null),
  signOut: () => Promise.resolve(),
};
