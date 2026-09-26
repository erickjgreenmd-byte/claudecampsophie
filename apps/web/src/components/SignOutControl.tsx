import { useState } from 'react';
import { useNavigate } from 'react-router';
import { familyOkResponseSchema } from '@pencillift/contracts';
import { maskEmail } from '../lib/auth.ts';
import { useParentSession, useSession } from '../lib/session.tsx';

const STILL_OPEN =
  'We could not end your session — you are still signed in on this computer. Try Sign out again when you are back online.';

/**
 * WEBR5-E-2: this browser's session is already gone on this path, so the copy no longer asks for a
 * retry it cannot carry out — with the stored refresh token removed, auth-js skips the server call
 * altogether and a second press only looks like it worked.
 */
const SERVER_NOT_TOLD =
  'This computer is signed out. We could not tell PencilLift’s servers to end the session, so sign out on your phone, or change your password if you are worried.';

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
 * family's data. The control now waits for the session to be gone before it moves on.
 *
 * WEBR5-E-2: "otherwise say so and stay" is right only while the session really is still here. On the
 * refusal path the adapter clears this origin's storage itself, and staying then kept the family's
 * page and a "Signed in as …" line up over no session at all. Those two cases are now told apart: a
 * session still open keeps the parent here to try again, a cleared one leaves for /sign-in with a
 * notice that says what helps instead of asking for a retry that cannot reach the server.
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
      // WEBR5-E-2: the adapter cleared this browser, but the server was never told. Staying put kept
      // the family's page — children, scans, verdicts, guardian emails — and a "Signed in as …" line
      // on screen although this browser holds no session at all: the bare storage removal raises no
      // SIGNED_OUT, so the shell's session state is stale and nothing else moves. This browser IS
      // signed out, so the portal leaves, and the notice travels with it.
      void navigate('/sign-in', { replace: true, state: { signedOutNotice: SERVER_NOT_TOLD } });
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
