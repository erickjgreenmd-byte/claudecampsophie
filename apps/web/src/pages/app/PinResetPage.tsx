import { useEffect, useState } from 'react';
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
 *
 * WEB-R2-08: the password grant necessarily issues a new session, and the API reads the
 * re-authentication from the request token's `amr` (POST /v1/adult/pin/reset), so the proof has to be
 * on this browser's own session — a proof on a second client would not reach the API. The new session
 * starts at aal1, which used to throw away an owner's two-step (aal2) session silently and leave
 * every /admin page refusing with "Owner administration requires an MFA session". The owner is now
 * told before it happens and re-verifies the authenticator code in this same flow, so aal2 is back
 * before the new PIN is even chosen.
 */
function PinReset() {
  const { auth, api } = useSession();
  const state = useParentSession();
  const [step, setStep] = useState<'verify' | 'two_step' | 'pin'>('verify');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  /** The verified TOTP factor to re-prove, set only when this session is currently at aal2. */
  const [twoStepFactorId, setTwoStepFactorId] = useState<string | null>(null);
  const account = auth.account;
  const email = state.status === 'signed_in' ? state.session.email : null;

  useEffect(() => {
    if (!account) return;
    let active = true;
    void Promise.all([account.assuranceLevel(), account.verifiedTotpFactorId()]).then(
      ([level, factorId]) => {
        if (active && level === 'aal2' && factorId) setTwoStepFactorId(factorId);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [account]);

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
          if (outcome.ok) setStep(twoStepFactorId ? 'two_step' : 'pin');
          return outcome;
        }}
      >
        <p>
          For your family’s safety, enter your account password again before choosing a new PIN.
        </p>
        {twoStepFactorId ? (
          <p>
            Your account uses two-step verification. Confirming your password starts a new session
            on this browser, so you will enter your authenticator code straight after — before you
            choose the new PIN — and your owner console stays available.
          </p>
        ) : null}
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

  if (step === 'two_step' && twoStepFactorId) {
    return (
      <AccountForm
        key="two_step"
        title="Confirm your two-step code"
        submitLabel="Confirm two-step code"
        onSubmit={async () => {
          if (!/^\d{6}$/.test(code))
            return { ok: false, message: 'Enter the 6-digit code from your authenticator app.' };
          const outcome = await account.verifyTotp(twoStepFactorId, code);
          setCode('');
          // Only a verified code moves on: a refused one leaves the session at aal1 and the PIN
          // unchanged, rather than quietly dropping the owner's admin access.
          if (outcome.ok) setStep('pin');
          return outcome;
        }}
      >
        <p>
          Confirming your password signed you in again, so this browser needs your authenticator
          code once more. That restores your owner console access before you choose the new PIN.
        </p>
        <Field
          id="totp"
          label="Six-digit code from your authenticator app"
          type="text"
          value={code}
          onChange={setCode}
          autoComplete="one-time-code"
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
