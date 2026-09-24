import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  adultUnlockResponseSchema,
  familyOkResponseSchema,
  weakParentPinReason,
} from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import { ErrorState } from '../../components/states.tsx';
import { RequireParent, useSession, type QueryState } from '../../lib/session.tsx';

/**
 * Parent security (spec P3, P14 "security/devices"; AC_ACCESS_08). Set or change the private
 * six-digit parent PIN, unlock sensitive actions for a short time, and lock again. The PIN is a
 * step-up convenience, not proof of adulthood or consent; the API verifies it and enforces lockout.
 *
 * The small helpers exported below (step-up notice, action feedback) are shared by the other
 * family pages so every sensitive action explains step-up the same way.
 */
export default function SecurityPage() {
  return (
    <RequireParent>
      <Security />
    </RequireParent>
  );
}

// ---------------------------------------------------------------------------------------------
// Shared helpers for family pages
// ---------------------------------------------------------------------------------------------

export type ActionFeedbackValue =
  { kind: 'success'; message: string } | { kind: 'error'; error: ApiRequestError };

export function toApiError(error: unknown): ApiRequestError {
  return error instanceof ApiRequestError
    ? error
    : new ApiRequestError('INTERNAL', 'Something went wrong. Please try again.', 0);
}

/** Runs one mutation at a time and records its outcome for display. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<ActionFeedbackValue | null>(null);
  const run = useCallback(async (key: string, action: () => Promise<string>) => {
    setBusy(key);
    setFeedback(null);
    try {
      const message = await action();
      setFeedback({ kind: 'success', message });
      return true;
    } catch (error) {
      setFeedback({ kind: 'error', error: toApiError(error) });
      return false;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, feedback, run, setFeedback };
}

/** Explains the server-enforced step-up instead of failing silently. */
export function StepUpNotice({ action }: { action: string }) {
  return (
    <div className="notice" role="alert">
      <p style={{ margin: 0 }}>
        <strong>Enter your parent PIN to continue.</strong> {action} needs a recent PIN unlock.{' '}
        <Link to="/app/security">Unlock on the Security page</Link>, then try again.
      </p>
    </div>
  );
}

export function ActionFeedback({
  feedback,
  stepUpAction,
}: {
  feedback: ActionFeedbackValue | null;
  stepUpAction: string;
}) {
  if (!feedback) return null;
  if (feedback.kind === 'success') {
    return (
      <p role="status" style={{ color: 'var(--success)', fontWeight: 700 }}>
        {feedback.message}
      </p>
    );
  }
  if (feedback.error.code === 'STEP_UP_REQUIRED') return <StepUpNotice action={stepUpAction} />;
  return <ErrorState message={feedback.error.message} />;
}

/**
 * Keeps the last successfully loaded data on screen while a reload is in flight, so forms and
 * success messages are not unmounted by a refresh.
 */
export function useLastGood<T>(query: QueryState<T>): T | null {
  const [last, setLast] = useState<T | null>(null);
  const ready = query.status === 'ready' ? query.data : null;
  useEffect(() => {
    if (ready !== null) setLast(ready);
  }, [ready]);
  return ready ?? last;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export const buttonRow = { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 } as const;
export const sectionStyle = { marginTop: 16 } as const;

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------

const PIN_PATTERN = /^\d{6}$/;

function PinInput({
  id,
  label,
  value,
  onChange,
  describedBy,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  describedBy?: string | undefined;
}) {
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        value={value}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      />
    </>
  );
}

function Security() {
  return (
    <>
      <h1>Security</h1>
      <section className="card" aria-labelledby="stepup-title">
        <h2 id="stepup-title">What the parent PIN protects</h2>
        <p>
          Some actions need a fresh PIN unlock, checked by PencilLift’s servers: adding a child,
          creating a device pairing code, disconnecting a device, inviting or removing a guardian,
          withdrawing consent, approving rewards and viewing full solutions.
        </p>
        <p>
          An unlock lasts a few minutes, applies only to this signed-in session, and ends early when
          you lock. Your PIN is never stored in the browser. It is not a password for your account
          and it is not proof of parental consent.
        </p>
      </section>
      <UnlockSection />
      <PinSection />
      <section className="card" style={sectionStyle} aria-labelledby="reset-title">
        <h2 id="reset-title">Forgot your PIN?</h2>
        <p>
          You can choose a new PIN after confirming it’s you with your account password. Your PIN,
          this device or an old session can’t reset it on their own. Resetting ends any current
          unlock, on every device.
        </p>
        <p>
          <Link to="/app/security/reset-pin">Reset your parent PIN</Link>
        </p>
        <p>
          After five incorrect tries the PIN locks for 15 minutes. If you can’t sign in to your
          account either, <Link to="/support">contact support</Link>.
        </p>
      </section>
    </>
  );
}

function UnlockSection() {
  const { api } = useSession();
  const { busy, feedback, run, setFeedback } = useAction();
  const [pin, setPin] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const errorId = useId();

  const unlock = async (event: FormEvent) => {
    event.preventDefault();
    if (!PIN_PATTERN.test(pin)) {
      setFieldError('Enter your 6-digit parent PIN.');
      return;
    }
    setFieldError(null);
    const entered = pin;
    setPin('');
    await run('unlock', async () => {
      const result = await api.send(
        'POST',
        '/v1/adult/unlock',
        { method: 'pin', pin: entered },
        adultUnlockResponseSchema,
      );
      return `Unlocked until ${formatDateTime(result.unlockedUntil)}. Sensitive actions are available in this session until then.`;
    });
  };

  const lock = () =>
    run('lock', async () => {
      await api.send('POST', '/v1/adult/lock', undefined, familyOkResponseSchema);
      return 'Locked. Sensitive actions need your PIN again.';
    });

  const error = feedback?.kind === 'error' ? feedback.error : null;
  const message =
    error?.code === 'FORBIDDEN'
      ? 'That PIN is not correct.'
      : error?.code === 'NOT_FOUND'
        ? 'Set a parent PIN first (below).'
        : (error?.message ?? null);

  return (
    <section className="card" style={sectionStyle} aria-labelledby="unlock-title">
      <h2 id="unlock-title">Unlock sensitive actions</h2>
      <form onSubmit={(e) => void unlock(e)} noValidate>
        <PinInput
          id="unlock-pin"
          label="Parent PIN"
          value={pin}
          onChange={(v) => {
            setPin(v);
            setFieldError(null);
            setFeedback(null);
          }}
          describedBy={fieldError ? errorId : undefined}
        />
        {fieldError ? (
          <p id={errorId} role="alert" style={{ color: 'var(--danger)', margin: '4px 0 0' }}>
            {fieldError}
          </p>
        ) : null}
        <div style={buttonRow}>
          <button type="submit" className="btn" disabled={busy !== null}>
            {busy === 'unlock' ? 'Checking…' : 'Unlock'}
          </button>
          <button
            type="button"
            className="btn secondary"
            disabled={busy !== null}
            onClick={() => void lock()}
          >
            {busy === 'lock' ? 'Locking…' : 'Lock now'}
          </button>
        </div>
      </form>
      {feedback?.kind === 'success' ? (
        <ActionFeedback feedback={feedback} stepUpAction="This" />
      ) : null}
      {message ? <ErrorState message={message} /> : null}
      {error?.code === 'LOCKED_OUT' ? (
        <p style={{ margin: '4px 0' }}>
          Forgot your PIN? <Link to="/app/security/reset-pin">Reset it</Link> after confirming your
          account password.
        </p>
      ) : null}
    </section>
  );
}

function PinSection() {
  const { api } = useSession();
  const { busy, feedback, run, setFeedback } = useAction();
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const hintId = useId();

  const weakness = pin.length === 6 ? weakParentPinReason(pin) : null;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const reason = weakParentPinReason(pin);
    if (reason) {
      setFieldError(reason);
      return;
    }
    if (pin !== confirm) {
      setFieldError('The two PINs don’t match.');
      return;
    }
    setFieldError(null);
    const chosen = pin;
    setPin('');
    setConfirm('');
    await run('pin', async () => {
      await api.send('PUT', '/v1/adult/pin', { pin: chosen }, familyOkResponseSchema);
      return 'Your parent PIN is saved.';
    });
  };

  const hint = fieldError ?? weakness;
  return (
    <section className="card" style={sectionStyle} aria-labelledby="pin-title">
      <h2 id="pin-title">Set or change your parent PIN</h2>
      <p>
        Choose 6 digits your child doesn’t know. Avoid repeated digits, counting sequences and
        simple patterns. To change an existing PIN, unlock with your current PIN first.
      </p>
      <form onSubmit={(e) => void save(e)} noValidate>
        <PinInput
          id="new-pin"
          label="New PIN"
          value={pin}
          onChange={(v) => {
            setPin(v);
            setFieldError(null);
            setFeedback(null);
          }}
          describedBy={hint ? hintId : undefined}
        />
        <PinInput
          id="confirm-pin"
          label="Confirm new PIN"
          value={confirm}
          onChange={(v) => {
            setConfirm(v);
            setFieldError(null);
          }}
        />
        {hint ? (
          <p id={hintId} role="alert" style={{ color: 'var(--danger)', margin: '4px 0 0' }}>
            {hint}
          </p>
        ) : null}
        <div style={buttonRow}>
          <button type="submit" className="btn" disabled={busy !== null}>
            {busy === 'pin' ? 'Saving…' : 'Save PIN'}
          </button>
        </div>
      </form>
      <ActionFeedback feedback={feedback} stepUpAction="Changing an existing PIN" />
    </section>
  );
}
