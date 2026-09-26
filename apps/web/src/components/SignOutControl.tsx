import { useState } from 'react';
import { useNavigate } from 'react-router';
import { familyOkResponseSchema } from '@pencillift/contracts';
import { maskEmail } from '../lib/auth.ts';
import { useParentSession, useSession } from '../lib/session.tsx';

const STILL_OPEN =
  'We could not end your session — you are still signed in on this computer. Try Sign out again when you are back online.';

const SERVER_NOT_TOLD =
  'Your sign-in was removed from this browser, but we could not tell the server to end the session. Sign out again when you are back online.';

/**
 * WEB-R2-01: ends the parent's session on this browser. Until this existed the only call to
 * `signOut` was inside the account-closure flow, and the Supabase session in this origin's storage
 * kept refreshing itself for ever (persistSession + autoRefreshToken). On a shared family, school or
 * library computer the next person could read the family's children, homework scans, verdicts,
 * points, safety reports, devices and guardian emails, because read screens need no PIN.
 *
 * Order matters: POST /v1/adult/lock goes first, while the access token is still valid, so a fresh
 * PIN unlock cannot outlive the session it belongs to. A failed lock never blocks the sign-out — the
 * session must end either way. The sign-out itself is local (spec P3 keeps other devices alone;
 * supabase-js would otherwise default to scope 'global' and sign the parent's phone out too).
 *
 * The masked email is shown beside it so a parent can see whose session is open before they read
 * anything, without printing the address on a shared screen.
 *
 * WEB-R4-AUTH-2: the navigation is no longer in a `finally`. A sign-out supabase-js refuses (an
 * expired access token whose refresh fails at the fetch level) used to land the parent on /sign-in
 * with the session still in this origin's storage — /sign-in shows nothing about a live session, so
 * the portal looked signed out while the next person at the keyboard could type /app and read the
 * family's data. The control now waits for the session to be gone and otherwise says so and stays.
 */
export function SignOutControl() {
  const { api, auth } = useSession();
  const state = useParentSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (state.status !== 'signed_in') return null;

  /** Whether this browser is still holding a session, however the sign-out ended. */
  const stillSignedIn = async () => {
    try {
      return (await auth.currentSession()) !== null;
    } catch {
      // The session cannot be read, so it cannot be shown as ended either.
      return true;
    }
  };

  const signOut = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await api.send('POST', '/v1/adult/lock', undefined, familyOkResponseSchema);
    } catch {
      // Offline, or the server has already ended this session: sign out locally regardless.
    }
    // ACC-WEB-AUTH-A: the adapter reports a refusal by returning it (a rejection escaped the
    // account-closure caller, which has no catch and must carry on). The catch stays for an adapter
    // that fails some other way: a sign-out that threw did not end the session either.
    let refused: boolean;
    try {
      refused = (await auth.signOut('local'))?.serverNotTold === true;
    } catch {
      refused = true;
    }
    const open = await stillSignedIn();
    setBusy(false);
    if (open) {
      setProblem(STILL_OPEN);
      return;
    }
    if (refused) {
      // The adapter cleared this browser, but the server was never told: say so rather than move on.
      setProblem(SERVER_NOT_TOLD);
      return;
    }
    void navigate('/sign-in', { replace: true });
  };

  return (
    <p
      className="container"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'baseline',
        gap: 8,
        margin: '4px 0 0',
        fontSize: '0.9rem',
        color: 'var(--muted)',
      }}
    >
      <span>{`Signed in as ${maskEmail(state.session.email)}`}</span>
      <button
        type="button"
        className="btn secondary"
        disabled={busy}
        onClick={() => void signOut()}
      >
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
      {problem ? (
        <span role="alert" className="error">
          {problem}
        </span>
      ) : null}
    </p>
  );
}
