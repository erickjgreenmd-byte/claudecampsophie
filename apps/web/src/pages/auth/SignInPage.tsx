import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { safeNextPath } from '../../lib/auth.ts';
import { useParentSession, useSession } from '../../lib/session.tsx';
import { AuthLinkNotice } from '../../components/AuthLinkNotice.tsx';
import { Notice } from '../../components/states.tsx';
import { AccountForm, EMAIL_RE, Field } from './forms.tsx';
import { SignInNotConfigured } from './NotConfigured.tsx';

/** Parent sign-in (spec P3). Children never sign in here; they use a paired device. */
export default function SignInPage() {
  const { auth } = useSession();
  const parent = useParentSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNextPath(params.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'password' | 'link'>('password');
  const account = auth.account;
  if (!account) return <SignInNotConfigured />;

  return (
    <>
      {/* WEB-R1-07: a failed email link (other browser, expired) is explained, not ignored. */}
      {parent.status === 'signed_out' ? (
        <AuthLinkNotice requestHref="/sign-in" purpose="sign_in" />
      ) : null}
      <AccountForm
        title="Parent sign in"
        submitLabel={mode === 'password' ? 'Sign in' : 'Email me a sign-in link'}
        onSubmit={async () => {
          if (!EMAIL_RE.test(email.trim()))
            return { ok: false, message: 'Enter a valid email address.' };
          if (mode === 'link') {
            return account.sendMagicLink(email.trim(), `${window.location.origin}${next}`);
          }
          if (password.length === 0) return { ok: false, message: 'Enter your password.' };
          const outcome = await account.signInWithPassword(email.trim(), password);
          if (outcome.ok) void navigate(next, { replace: true });
          return outcome;
        }}
        done={(outcome) =>
          outcome.next === 'check_email' ? (
            <Notice>If that email has a PencilLift account, a sign-in link is on its way.</Notice>
          ) : (
            <Notice>Signed in.</Notice>
          )
        }
      >
        <Field
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
        />
        {mode === 'password' ? (
          <Field
            id="password"
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />
        ) : null}
      </AccountForm>
      <p>
        <button
          type="button"
          className="btn secondary"
          onClick={() => setMode(mode === 'password' ? 'link' : 'password')}
        >
          {mode === 'password' ? 'Use an email link instead' : 'Use my password instead'}
        </button>
      </p>
      <p>
        <Link to="/reset-password">Forgot your password?</Link> ·{' '}
        <Link to={`/sign-up?next=${encodeURIComponent(next)}`}>Create a parent account</Link>
      </p>
    </>
  );
}
