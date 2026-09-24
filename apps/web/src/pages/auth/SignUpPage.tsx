import { useState } from 'react';
import { Link } from 'react-router';
import { MIN_PASSWORD_LENGTH } from '../../lib/auth.ts';
import { useSession } from '../../lib/session.tsx';
import { Notice } from '../../components/states.tsx';
import { AccountForm, EMAIL_RE, Field } from './forms.tsx';
import { SignInNotConfigured } from './NotConfigured.tsx';

/** Adult account creation. The email must be verified before a family can be created (spec P3). */
export default function SignUpPage() {
  const { auth } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const account = auth.account;
  if (!account) return <SignInNotConfigured />;

  return (
    <>
      <AccountForm
        title="Create a parent account"
        submitLabel="Create account"
        onSubmit={() => {
          if (!EMAIL_RE.test(email.trim()))
            return Promise.resolve({ ok: false, message: 'Enter a valid email address.' });
          if (password.length < MIN_PASSWORD_LENGTH)
            return Promise.resolve({
              ok: false,
              message: `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`,
            });
          if (password !== confirm)
            return Promise.resolve({ ok: false, message: 'The two passwords do not match.' });
          return account.signUp(email.trim(), password, `${window.location.origin}/app`);
        }}
        done={() => (
          <Notice>
            Check your email for a verification link. PencilLift accounts are for parents and
            guardians; children use a device you pair from your account.
          </Notice>
        )}
      >
        <Field
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
        />
        <Field
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
        />
        <Field
          id="confirm"
          label="Confirm password"
          type="password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
        />
      </AccountForm>
      <p>
        Already have an account? <Link to="/sign-in">Sign in</Link>
      </p>
    </>
  );
}
