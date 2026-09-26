import { useState } from 'react';
import { useNavigate } from 'react-router';
import { familyOkResponseSchema } from '@pencillift/contracts';
import { maskEmail } from '../lib/auth.ts';
import { useParentSession, useSession } from '../lib/session.tsx';

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
 */
export function SignOutControl() {
  const { api, auth } = useSession();
  const state = useParentSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (state.status !== 'signed_in') return null;

  const signOut = async () => {
    setBusy(true);
    try {
      await api.send('POST', '/v1/adult/lock', undefined, familyOkResponseSchema);
    } catch {
      // Offline, or the server has already ended this session: sign out locally regardless.
    }
    try {
      await auth.signOut('local');
    } finally {
      setBusy(false);
      void navigate('/sign-in', { replace: true });
    }
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
    </p>
  );
}
