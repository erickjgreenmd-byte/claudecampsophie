import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { MIN_PASSWORD_LENGTH } from '../../lib/auth.ts';
import { useParentSession, useSession } from '../../lib/session.tsx';
import { AuthLinkNotice, readAuthLinkProblem } from '../../components/AuthLinkNotice.tsx';
import { Loading, Notice } from '../../components/states.tsx';
import { AccountForm, Field } from './forms.tsx';
import { SignInNotConfigured } from './NotConfigured.tsx';

/** Landing page of the emailed recovery link: the link signs the adult in, then a new password is set. */
export default function UpdatePasswordPage() {
  const { auth } = useSession();
  const state = useParentSession();
  const location = useLocation();
  const [password, setPassword] = useState('');
  const account = auth.account;
  if (!account) return <SignInNotConfigured />;
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
