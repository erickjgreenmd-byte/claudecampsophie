import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { adultUnlockResponseSchema } from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import { useSession } from '../lib/session.tsx';

/**
 * WEB-R2-05: the inline step-up (spec P3). The API refused an action because this session has no
 * recent PIN unlock. The parent enters the PIN here, on the page they were already filling in —
 * following a link to /app/security would unmount the form and lose the typed child nickname,
 * guardian email or support message, and the Security page had no way back.
 *
 * Nothing sensitive is retried automatically: the parent presses the action button again, which is a
 * second, deliberate confirmation. The PIN is held only in this component's state and is cleared as
 * soon as it is sent; the server checks it and enforces the lockout.
 */

const PIN_PATTERN = /^\d{6}$/;

const fieldError = { color: 'var(--danger)', margin: '4px 0 0' } as const;
const buttonRow = { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 } as const;

/**
 * Router state carried to the Security page so its unlock form can offer the way back. It travels as
 * history state, not as a query string, because the link's address stays exactly `/app/security`
 * (the answer-key and rewards screens in other areas pin that href in their own tests, and a
 * step-up link is not a place to grow a second URL shape). `safeNextPath` still checks it there.
 */
export interface StepUpReturn {
  readonly stepUpNext: string;
}

function unlockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function StepUpPrompt({
  explanation,
  retryHint,
}: {
  /** What needs the unlock, in the wording of the page that asked, as one sentence. */
  explanation: string;
  /** What to do once the unlock succeeded (the action is never retried for the parent). */
  retryHint: (unlockedUntil: string) => string;
}) {
  const { api } = useSession();
  const location = useLocation();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [unlockedUntil, setUnlockedUntil] = useState<string | null>(null);
  const pinId = useId();
  const pinRef = useRef<HTMLInputElement | null>(null);
  // WEBR4-06: the prompt can appear far from the control that was refused, so it takes the focus
  // once, when it mounts. It is never re-focused afterwards, so typing elsewhere is not interrupted.
  useEffect(() => {
    pinRef.current?.focus();
  }, []);

  const submit = async () => {
    if (!PIN_PATTERN.test(pin)) {
      setMessage('Enter your 6-digit parent PIN.');
      return;
    }
    const entered = pin;
    setPin('');
    setMessage(null);
    setBusy(true);
    try {
      const result = await api.send(
        'POST',
        '/v1/adult/unlock',
        { method: 'pin', pin: entered },
        adultUnlockResponseSchema,
      );
      setUnlockedUntil(result.unlockedUntil);
    } catch (error) {
      const e =
        error instanceof ApiRequestError
          ? error
          : new ApiRequestError('INTERNAL', 'Something went wrong. Please try again.', 0);
      setMessage(
        e.code === 'FORBIDDEN'
          ? 'That PIN is not correct.'
          : e.code === 'NOT_FOUND'
            ? 'Set a parent PIN on the Security page first.'
            : e.code === 'LOCKED_OUT'
              ? 'Too many tries. Your PIN is locked for 15 minutes.'
              : e.message,
      );
    } finally {
      setBusy(false);
    }
  };

  if (unlockedUntil) {
    return (
      <p role="status" style={{ color: 'var(--success)', fontWeight: 700 }}>
        {`Unlocked until ${unlockTime(unlockedUntil)}. ${retryHint(unlockedUntil)}`}
      </p>
    );
  }
  return (
    <fieldset
      className="notice"
      style={{ borderColor: 'var(--gold)', border: '1px solid var(--gold)', borderRadius: 8 }}
    >
      <legend style={{ fontWeight: 700 }}>Enter your parent PIN to continue</legend>
      {/*
        WEBR4-06: the explanation is a live region, and the PIN field takes the focus on mount. Every
        notice this component replaced was `<div className="notice" role="alert">`, and every other
        refusal on the same screens still speaks through ErrorState (also role="alert"). Without
        them a refusal was announced nowhere: on the learning planner this prompt sits ~150 lines of
        fields above the submit button, so a parent who pressed "Save schedule" with a lapsed unlock
        saw no change near the control they used and heard nothing. The role goes here rather than on
        the fieldset so the fieldset keeps its group role, which the privacy screen's tests use to
        scope their queries to this prompt.
      */}
      <p role="alert" style={{ marginTop: 0 }}>
        {`${explanation} PencilLift’s servers check it, not this browser. `}
        <Link
          to="/app/security"
          state={
            {
              stepUpNext: `${location.pathname}${location.search}${location.hash}`,
            } satisfies StepUpReturn
          }
        >
          Unlock on the Security page
        </Link>
        {' instead, and it offers a link back to this page.'}
      </p>
      {/*
        Deliberately not a <form>. Every page that renders this notice does so inside its own form —
        the learning-planner sections, the rewards forms, the add-child and guardian forms — and a
        nested form is invalid HTML whose submit event bubbles into the outer form, re-firing the
        very action that was refused. The PIN is sent from the button's click handler instead, with
        Enter on the field doing the same thing.
      */}
      <div>
        <label htmlFor={pinId}>Parent PIN</label>
        <input
          id={pinId}
          ref={pinRef}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          value={pin}
          onChange={(e) => {
            setPin(e.target.value.replace(/\D/g, '').slice(0, 6));
            setMessage(null);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            // Stop Enter from submitting the page form that surrounds this notice.
            e.preventDefault();
            e.stopPropagation();
            if (!busy) void submit();
          }}
        />
        {message ? (
          <p role="alert" style={fieldError}>
            {message}
          </p>
        ) : null}
        <div style={buttonRow}>
          <button type="button" className="btn" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Checking…' : 'Unlock'}
          </button>
        </div>
      </div>
    </fieldset>
  );
}
