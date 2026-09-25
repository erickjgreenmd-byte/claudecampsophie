import { Link, useLocation } from 'react-router';

/**
 * WEB-R1-07: what went wrong with an emailed sign-in, verification or password-reset link.
 *
 * The web portal uses Supabase's PKCE flow (kept on purpose). A PKCE link can be exchanged only in
 * the browser that asked for it, so a link opened on another device or browser signs nobody in.
 * Supabase then either reports `error` / `error_code` / `error_description` (query or hash), or,
 * when this browser holds no code verifier, silently leaves the unexchanged `?code=` in the address.
 * A hash `access_token` that this PKCE client refuses (for example a reset link made by an
 * implicit-flow client) also means the link could not sign the adult in here. The one exception is
 * `/update-password` (R2C-WEB-3): a mobile-started reset link (`type=recovery` with both tokens) is
 * adopted there by UpdatePasswordPage, which passes `problem` itself if the auth server refuses it.
 *
 * - `expired`: Supabase says the link expired or was already used (`error_code=otp_expired`).
 * - `failed`: any other error, or a link that was not exchanged in this browser.
 * - `null`: an ordinary address (a guardian `#accept=` hash is not an auth link).
 *
 * Callers show the notice only when the adult is signed out; a signed-in adult who reopens an old
 * link simply continues.
 */
export type AuthLinkProblem = 'expired' | 'failed';

export function readAuthLinkProblem(search: string, hash: string): AuthLinkProblem | null {
  const query = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const fragment = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const read = (name: string) => query.get(name) ?? fragment.get(name);
  const error = read('error');
  const code = read('error_code');
  const description = read('error_description');
  if (error !== null || code !== null || description !== null) {
    return code === 'otp_expired' ? 'expired' : 'failed';
  }
  if (query.has('code') || fragment.has('access_token')) return 'failed';
  return null;
}

const HEADLINE: Record<AuthLinkProblem, string> = {
  expired: 'This email link has expired or was already used.',
  failed: 'This email link didn’t sign you in.',
};

/**
 * The plain-words notice for a failed email link. `requestHref` is where a new link is requested:
 * `/reset-password` on the password page, `/sign-in` elsewhere (the sign-in page can email a new
 * sign-in link; a verification link usually confirmed the email already).
 */
export function AuthLinkNotice({
  requestHref,
  purpose,
  problem: known,
}: {
  requestHref: string;
  purpose: 'reset' | 'sign_in';
  /**
   * R2C-WEB-3: a problem the caller already established (a mobile recovery link whose tokens the
   * auth server refused, after the page cleared them from the address). Without it the notice
   * reads the address, as before.
   */
  problem?: AuthLinkProblem;
}) {
  const location = useLocation();
  const problem = known ?? readAuthLinkProblem(location.search, location.hash);
  if (!problem) return null;
  return (
    <div className="error" role="alert" style={{ marginBottom: 16 }}>
      <p style={{ margin: 0 }}>
        <strong>{HEADLINE[problem]}</strong> Open this link in the browser you used to request it,
        or <Link to={requestHref}>request a new link here</Link>.
        {purpose === 'sign_in'
          ? ' If you were confirming your email address, it may already be confirmed: try signing in with your password.'
          : null}
      </p>
    </div>
  );
}
