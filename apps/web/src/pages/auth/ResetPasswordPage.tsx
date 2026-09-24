import { useState } from 'react';
import { useSession } from '../../lib/session.tsx';
import { Notice } from '../../components/states.tsx';
import { AccountForm, EMAIL_RE, Field } from './forms.tsx';
import { SignInNotConfigured } from './NotConfigured.tsx';

export default function ResetPasswordPage() {
  const { auth } = useSession();
  const [email, setEmail] = useState('');
  const account = auth.account;
  if (!account) return <SignInNotConfigured />;
  return (
    <AccountForm
      title="Reset your password"
      submitLabel="Email me a reset link"
      onSubmit={() =>
        EMAIL_RE.test(email.trim())
          ? account.sendPasswordReset(email.trim(), `${window.location.origin}/update-password`)
          : Promise.resolve({ ok: false, message: 'Enter a valid email address.' })
      }
      done={() => (
        <Notice>If that email has a PencilLift account, a reset link is on its way.</Notice>
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
    </AccountForm>
  );
}
