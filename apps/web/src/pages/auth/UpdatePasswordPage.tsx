import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { MIN_PASSWORD_LENGTH } from '../../lib/auth.ts';
import { useParentSession, useSession } from '../../lib/session.tsx';
import {
  maskEmail,
  readRecoveryLinkTokens,
  recoveryLinkAuth,
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
  const account = auth.account;
  const capability = recoveryLinkAuth(account);
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
  return (
    <AccountForm
      title="Choose a new password"
      submitLabel="Save password"
      onSubmit={() =>
        password.length < MIN_PASSWORD_LENGTH
          ? Promise.resolve({
              ok: false,
              message: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
            })
          : account.updatePassword(password)
      }
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
