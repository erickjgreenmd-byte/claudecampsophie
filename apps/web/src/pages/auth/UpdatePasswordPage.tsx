import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { MIN_PASSWORD_LENGTH } from '../../lib/auth.ts';
import { useParentSession, useSession } from '../../lib/session.tsx';
import {
  maskEmail,
  passwordProofAuth,
  readRecoveryLinkTokens,
  recoveryLinkAuth,
  recoverySessionAuth,
  type RecoveryLinkOutcome,
} from '../../lib/supabase-auth.ts';
import { AuthLinkNotice, readAuthLinkProblem } from '../../components/AuthLinkNotice.tsx';
import { Loading, Notice } from '../../components/states.tsx';
import { AccountForm, Field } from './forms.tsx';
import { SignInNotConfigured } from './NotConfigured.tsx';

/**
 * R2C-WEB-3: state of a mobile-started (implicit-flow) recovery link on this page. `none` means the
 * address carried no such link and the page behaves as before (PKCE link or signed-in adult).
 */
type Recovery =
  | { status: 'none' }
  | { status: 'pending' }
  | { status: 'ready'; email: string }
  | { status: 'failed' };

/** Landing page of the emailed recovery link: the link signs the adult in, then a new password is set. */
export default function UpdatePasswordPage() {
  const { auth } = useSession();
  const state = useParentSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [current, setCurrent] = useState('');
  const account = auth.account;
  const capability = recoveryLinkAuth(account);
  const proof = passwordProofAuth(account);
  const recoverySession = recoverySessionAuth(account);
  // Read once, on the first render: the hash is cleared right after.
  const [tokens] = useState(() => (capability ? readRecoveryLinkTokens(location.hash) : null));
  const [recovery, setRecovery] = useState<Recovery>(
    tokens ? { status: 'pending' } : { status: 'none' },
  );
  const started = useRef<Promise<RecoveryLinkOutcome> | null>(null);
  const { pathname, search } = location;

  useEffect(() => {
    if (!tokens || !capability) return;
    let active = true;
    if (!started.current) {
      // Take the tokens out of the address bar and this history entry at once (a router `replace`
      // is `history.replaceState` in the browser), before the auth server is even asked.
      void navigate({ pathname, search, hash: '' }, { replace: true });
      started.current = capability.acceptRecoveryLink(tokens);
    }
    void started.current.then((outcome) => {
      if (active) {
        setRecovery(outcome.ok ? { status: 'ready', email: outcome.email } : { status: 'failed' });
      }
    });
    return () => {
      active = false;
    };
  }, [tokens, capability, navigate, pathname, search]);

  if (!account) return <SignInNotConfigured />;
  if (recovery.status === 'pending') return <Loading />;
  if (recovery.status === 'failed') {
    return <AuthLinkNotice requestHref="/reset-password" purpose="reset" problem="failed" />;
  }
  if (recovery.status === 'none') {
    if (state.status === 'loading') return <Loading />;
    if (state.status !== 'signed_in') {
      // WEB-R1-07: a reset link opened in another browser, or an expired one, says why and offers a
      // new link, instead of the bare "request a new link" loop.
      if (readAuthLinkProblem(location.search, location.hash)) {
        return <AuthLinkNotice requestHref="/reset-password" purpose="reset" />;
      }
      return (
        <Notice>
          This page opens from the reset link in your email.{' '}
          <Link to="/reset-password">Request a new link</Link>.
        </Notice>
      );
    }
  }
  // WEB-R2-04: only a session that came from the emailed recovery link may set a new password with
  // nothing else. In any other signed-in session the current password is proved first, so an
  // unattended signed-in browser is no longer enough to take over the account (and the weaker
  // secret, the 6-digit PIN, is no longer the better-protected one).
  const fromRecoveryLink =
    recovery.status === 'ready' || recoverySession?.recoveryActive() === true;
  const currentEmail = state.status === 'signed_in' ? state.session.email : null;
  const mustProve = !fromRecoveryLink;
  if (mustProve && (!proof || !currentEmail)) {
    // No way to prove the old password here (an adapter without the capability): refuse rather than
    // offer a change that would need no proof.
    return (
      <Notice>
        To change your password, open the reset link in your email.{' '}
        <Link to="/reset-password">Send me a reset link</Link>.
      </Notice>
    );
  }
  return (
    <AccountForm
      title="Choose a new password"
      submitLabel="Save password"
      onSubmit={async () => {
        if (password.length < MIN_PASSWORD_LENGTH) {
          return { ok: false, message: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
        }
        if (mustProve) {
          if (current.length === 0) {
            return { ok: false, message: 'Enter your current password.' };
          }
          // Proved on a second, non-persisting client: this browser's session (and an owner's
          // two-step aal2 session) is left exactly as it was.
          const proved = await proof!.verifyPassword(currentEmail!, current);
          if (!proved.ok) return proved;
        }
        return account.updatePassword(password);
      }}
      done={() => (
        <Notice>
          Your password is changed. <Link to="/app">Go to your family</Link>.
        </Notice>
      )}
    >
      {recovery.status === 'ready' ? (
        // R2C-WEB-3: say whose password this is, so an adult who opened someone else's link notices.
        <>
          <p>
            <strong>Set a new password for {maskEmail(recovery.email)}</strong>
          </p>
          <p>
            Not your account? Don’t save anything here;{' '}
            <Link to="/reset-password">request a reset link for your own email</Link>.
          </p>
        </>
      ) : null}
      {mustProve ? (
        <>
          <p>
            {`You are signed in as ${maskEmail(currentEmail!)}. Enter your current password to change it.`}{' '}
            Forgotten it? <Link to="/reset-password">Send a reset link to your email</Link>.
          </p>
          <Field
            id="current-password"
            label="Current password"
            type="password"
            value={current}
            onChange={setCurrent}
            autoComplete="current-password"
          />
        </>
      ) : null}
      <Field
        id="password"
        label="New password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
      />
    </AccountForm>
  );
}
