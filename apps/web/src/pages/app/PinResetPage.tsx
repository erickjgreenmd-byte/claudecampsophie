import { useState } from 'react';
import { Link } from 'react-router';
import { okResponseSchema } from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import { RequireParent, useParentSession, useSession } from '../../lib/session.tsx';
import { Notice } from '../../components/states.tsx';
import { AccountForm, Field } from '../auth/forms.tsx';

/**
 * Forgotten parent PIN (spec P3: reset only through verified parent recovery). The adult first
 * re-proves account ownership with their password; the API then accepts a new PIN only within ten
 * minutes of that re-authentication. A PIN, the device or an old session cannot reset it.
 */
function PinReset() {
  const { auth, api } = useSession();
  const state = useParentSession();
  const [step, setStep] = useState<'verify' | 'pin'>('verify');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const account = auth.account;
  const email = state.status === 'signed_in' ? state.session.email : null;
  if (!account || !email)
    return <Notice>PIN reset needs parent sign-in, which isn’t available here.</Notice>;

  if (step === 'verify') {
    return (
      <AccountForm
        key="verify"
        title="Reset your parent PIN"
        submitLabel="Confirm it’s you"
        onSubmit={async () => {
          const outcome = await account.signInWithPassword(email, password);
          if (outcome.ok) setStep('pin');
          return outcome;
        }}
      >
        <p>
          For your family’s safety, enter your account password again before choosing a new PIN.
        </p>
        <Field
          id="password"
          label="Account password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
      </AccountForm>
    );
  }
  return (
    <AccountForm
      key="pin"
      title="Choose a new parent PIN"
      submitLabel="Save new PIN"
      onSubmit={async () => {
        if (!/^\d{6}$/.test(pin))
          return { ok: false, message: 'Your PIN must be exactly 6 digits.' };
        if (pin !== confirm) return { ok: false, message: 'The two PINs do not match.' };
        try {
          await api.send('POST', '/v1/adult/pin/reset', { pin }, okResponseSchema);
          return { ok: true, next: 'done' };
        } catch (error) {
          if (error instanceof ApiRequestError && error.code === 'BUSINESS_RULE') {
            setStep('verify');
            return {
              ok: false,
              message: 'Please confirm your password again, then choose the PIN within 10 minutes.',
            };
          }
          if (error instanceof ApiRequestError && error.code === 'VALIDATION_FAILED') {
            return {
              ok: false,
              message: 'Choose a less predictable PIN (avoid repeats and sequences).',
            };
          }
          return { ok: false, message: 'The PIN could not be changed. Try again.' };
        }
      }}
      done={() => (
        <Notice>
          Your new PIN is saved. Any unlocked devices were locked.{' '}
          <Link to="/app/security">Back to security</Link>.
        </Notice>
      )}
    >
      <Field
        id="pin"
        label="New 6-digit PIN"
        type="password"
        value={pin}
        onChange={setPin}
        autoComplete="new-password"
      />
      <Field
        id="pin-confirm"
        label="Repeat the new PIN"
        type="password"
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
      />
    </AccountForm>
  );
}

export default function PinResetPage() {
  return (
    <RequireParent>
      <PinReset />
    </RequireParent>
  );
}
