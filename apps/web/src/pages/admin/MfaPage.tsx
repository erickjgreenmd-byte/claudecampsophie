import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { isTwoStepLookupUnavailable, type TotpEnrollment } from '../../lib/auth.ts';
import { RequireParent, useSession } from '../../lib/session.tsx';
import { ErrorState, Loading, Notice } from '../../components/states.tsx';
import { AccountForm, Field } from '../auth/forms.tsx';

/**
 * Owner administration requires an MFA (aal2) session (spec P14, AC_MON_15). Enrolls a TOTP factor
 * once, then verifies a code to raise this session to aal2. The API enforces aal2 independently.
 *
 * WEBR5-E-1: a two-step lookup that failed is not an answer here either. Reading it as "no factor"
 * offered a fresh enrollment to an owner who already has one — a second factor their authenticator
 * app does not hold — so an unreadable level (`null`) or an unreachable factor list says so and
 * offers nothing.
 */
function Mfa() {
  const { auth } = useSession();
  const account = auth.account;
  const [level, setLevel] = useState<'aal1' | 'aal2' | 'unavailable' | 'loading'>('loading');
  const [factorId, setFactorId] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');

  useEffect(() => {
    if (!account) return;
    let active = true;
    const unreadable = () => {
      if (active) setLevel('unavailable');
    };
    void Promise.all([account.assuranceLevel(), account.verifiedTotpFactorId()]).then(
      ([aal, id]) => {
        if (!active) return;
        // An aal2 session has already verified a factor, so the notice below is right whatever the
        // factor list says — only the enrollment offer needs a readable one.
        if (aal === 'aal2') {
          setLevel('aal2');
          return;
        }
        if (aal === null || isTwoStepLookupUnavailable(id)) {
          unreadable();
          return;
        }
        setLevel(aal);
        setFactorId(id);
      },
      // auth-js reports these failures as values, so this is for an adapter that fails another way.
      unreadable,
    );
    return () => {
      active = false;
    };
  }, [account]);

  if (!account)
    return <Notice>Two-step verification needs parent sign-in, which isn’t available here.</Notice>;
  if (level === 'loading') return <Loading />;
  if (level === 'unavailable') {
    return (
      <ErrorState message="We could not check your two-step verification just now, so nothing has been changed. Check your connection and open this page again." />
    );
  }
  if (level === 'aal2') {
    return (
      <Notice>
        Two-step verification is active for this session.{' '}
        <Link to="/admin">Open owner administration</Link>.
      </Notice>
    );
  }
  const target = factorId ?? enrollment?.factorId ?? null;
  if (!target) {
    return (
      <section className="card">
        <h1>Set up two-step verification</h1>
        <p>Owner administration needs an authenticator app code in addition to your password.</p>
        {error ? <ErrorState message={error} /> : null}
        <button
          type="button"
          className="btn"
          onClick={() =>
            void account.enrollTotp().then((result) => {
              if ('error' in result) setError(result.error);
              else setEnrollment(result);
            })
          }
        >
          Start setup
        </button>
      </section>
    );
  }
  return (
    <AccountForm
      title="Enter your authenticator code"
      submitLabel="Verify"
      onSubmit={() =>
        /^\d{6}$/.test(code)
          ? account.verifyTotp(target, code)
          : Promise.resolve({
              ok: false,
              message: 'Enter the 6-digit code from your authenticator app.',
            })
      }
      done={() => (
        <Notice>
          Verified. <Link to="/admin">Open owner administration</Link>.
        </Notice>
      )}
    >
      {enrollment ? (
        <>
          <p>Scan this code with your authenticator app, or enter the key by hand.</p>
          <img src={enrollment.qrCode} alt="Authenticator setup code" width={180} height={180} />
          <p>
            Key: <code>{enrollment.secret}</code>
          </p>
        </>
      ) : null}
      <Field
        id="totp"
        label="6-digit code"
        type="text"
        value={code}
        onChange={setCode}
        autoComplete="one-time-code"
      />
    </AccountForm>
  );
}

export default function MfaPage() {
  return (
    <RequireParent>
      <Mfa />
    </RequireParent>
  );
}
