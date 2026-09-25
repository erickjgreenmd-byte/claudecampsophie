import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  consentStartResponseSchema,
  consentStatusResponseSchema,
  consentWithdrawResponseSchema,
  createFamilyResponseSchema,
  familyOverviewResponseSchema,
  type ConsentStatus,
  type FamilyOverview,
} from '@pencillift/contracts';
import { ErrorState, Loading } from '../../components/states.tsx';
import { RequireParent, useApiQuery, useSession } from '../../lib/session.tsx';
import { childStatusLabel, gradeLabel } from './ChildrenPage.tsx';
import {
  ActionFeedback,
  buttonRow,
  formatDate,
  sectionStyle,
  useAction,
  useLastGood,
} from './SecurityPage.tsx';

/**
 * Family dashboard (spec P3, P14 "signup/verification/consent, onboarding, child list";
 * AC_ACCESS_01/02, AC_UX_02). Shows the family, children and paid slots, and the verifiable
 * parental consent state. Consent comes only from the consent provider: nothing on this page can
 * mark it verified. A development test provider is always labelled as such.
 */
export default function FamilyDashboardPage() {
  return (
    <RequireParent>
      <Dashboard />
    </RequireParent>
  );
}

function Dashboard() {
  const family = useApiQuery((api) => api.get('/v1/family', familyOverviewResponseSchema), []);
  const data = useLastGood(family);
  const noFamily = family.status === 'error' && family.error.code === 'NOT_FOUND' && !data;

  return (
    <>
      <h1>Your family</h1>
      {data === null && family.status === 'loading' ? (
        <Loading label="Loading your family…" />
      ) : null}
      {noFamily ? <CreateFamily onCreated={family.reload} /> : null}
      {family.status === 'error' && !noFamily ? (
        <ErrorState message={family.error.message} onRetry={family.reload} />
      ) : null}
      {data ? (
        <div aria-busy={family.status === 'loading'}>
          <FamilySummary data={data} />
          <ConsentSection />
          <nav aria-label="Family settings" className="card" style={sectionStyle}>
            <h2>Manage</h2>
            <ul>
              <li>
                <Link to="/app/children">Children and pairing codes</Link>
              </li>
              <li>
                <Link to="/app/devices">Connected devices</Link>
              </li>
              <li>
                <Link to="/app/security">Parent PIN and unlock</Link>
              </li>
              <li>
                <Link to="/app/guardians">Guardians</Link>
              </li>
              <li>
                <Link to="/app/privacy">Privacy, export and deletion</Link>
              </li>
              <li>
                <Link to="/app/support">Support</Link> — questions, billing and refund requests
              </li>
            </ul>
          </nav>
        </div>
      ) : null}
    </>
  );
}

function FamilySummary({ data }: { data: FamilyOverview }) {
  const active = data.children.filter((c) => c.status === 'active').length;
  return (
    <section className="card" aria-labelledby="family-title">
      <h2 id="family-title">{data.displayName}</h2>
      <p style={{ margin: '4px 0' }}>Time zone: {data.timezone}</p>
      <p style={{ margin: '4px 0' }}>
        Paid child slots: <strong>{data.paidSlots}</strong> ({active} in use)
      </p>
      {data.billingConflict ? (
        <div className="notice" role="note" style={{ marginTop: 8 }}>
          Your subscription needs attention: more than one store reports a plan for this family.
          Please review your subscription in the app.
        </div>
      ) : null}
      <h3>Children</h3>
      {data.children.length === 0 ? (
        <p>
          No children yet. <Link to="/app/children">Add your first child</Link>.
        </p>
      ) : (
        <ul>
          {data.children.map((child) => (
            <li key={child.id}>
              <strong>{child.nickname}</strong> · {gradeLabel(child.gradeLevel)} ·{' '}
              {childStatusLabel(child.status)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------------------------

/** What the banner says for each consent state. Exported for tests. */
export function consentHeadline(status: ConsentStatus): string {
  switch (status.state) {
    case 'none':
      return 'Parental consent is needed before PencilLift can check homework.';
    case 'pending':
      return 'Consent is waiting for verification.';
    case 'verified':
      return status.verifiedAt
        ? `Consent verified on ${formatDate(status.verifiedAt)}.`
        : 'Consent verified.';
    case 'failed':
      return 'Consent could not be verified.';
    case 'withdrawn':
      return 'Consent was withdrawn.';
  }
}

function ConsentSection() {
  const query = useApiQuery((api) => api.get('/v1/consent', consentStatusResponseSchema), []);
  const status = useLastGood(query);
  return (
    <section className="card" style={sectionStyle} aria-labelledby="consent-title">
      <h2 id="consent-title">Parental consent</h2>
      {status === null && query.status === 'loading' ? <Loading label="Checking consent…" /> : null}
      {query.status === 'error' ? (
        <ErrorState message={query.error.message} onRetry={query.reload} />
      ) : null}
      {status ? <ConsentBanner status={status} onChanged={query.reload} /> : null}
    </section>
  );
}

function ConsentBanner({ status, onChanged }: { status: ConsentStatus; onChanged: () => void }) {
  const { api } = useSession();
  const { busy, feedback, run } = useAction();
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);

  const start = async () => {
    const ok = await run('start', async () => {
      const result = await api.send('POST', '/v1/consent/start', {}, consentStartResponseSchema);
      setRedirectUrl(result.redirectUrl);
      return result.redirectUrl
        ? 'Consent started. Continue with the consent provider, then check the status here.'
        : 'Consent started. Check the status to see the provider’s result.';
    });
    if (ok) onChanged();
  };

  const refresh = async (consentId: string) => {
    const ok = await run('refresh', async () => {
      const result = await api.send(
        'POST',
        `/v1/consent/${consentId}/refresh`,
        undefined,
        consentStatusResponseSchema,
      );
      return result.state === 'pending'
        ? 'The provider hasn’t finished verifying yet.'
        : 'Consent status updated.';
    });
    if (ok) onChanged();
  };

  const withdraw = async () => {
    const ok = await run('withdraw', async () => {
      const result = await api.send(
        'POST',
        '/v1/consent/withdraw',
        {},
        consentWithdrawResponseSchema,
      );
      return `Consent withdrawn. ${result.cancelledJobs} waiting homework ${
        result.cancelledJobs === 1 ? 'task was' : 'tasks were'
      } cancelled and your children’s devices were signed out.`;
    });
    setConfirmWithdraw(false);
    if (ok) onChanged();
  };

  // Starting is allowed in every state but verified, including pending (the API accepts it): a
  // parent who closed the provider's page, or whom the API tells to "Start consent again with the
  // current provider", needs a real way to restart, not only "Check status" (RV-family-5).
  const canStart = status.state !== 'verified';
  const restarting = status.state === 'pending';
  const pendingId = status.state === 'pending' ? status.consentId : null;
  const blocked = status.state !== 'verified';

  return (
    <div className={blocked ? 'notice' : undefined} role={blocked ? 'note' : undefined}>
      <p style={{ margin: '0 0 8px', fontWeight: 800 }}>{consentHeadline(status)}</p>
      {status.state === 'verified' ? (
        <p style={{ margin: '4px 0' }}>
          PencilLift may process your children’s homework for learning feedback (consent version{' '}
          {status.policyVersion ?? 'unknown'}). You can withdraw consent at any time.
        </p>
      ) : status.state === 'pending' ? (
        <>
          <p style={{ margin: '4px 0' }}>
            Finish the steps with the consent provider, then check the status. Homework checking
            stays off until consent is verified.
          </p>
          <p style={{ margin: '4px 0' }}>
            Closed the provider’s page, or asked to start again? Start consent again: it replaces
            this waiting request.
          </p>
        </>
      ) : status.state === 'withdrawn' ? (
        <p style={{ margin: '4px 0' }}>
          {status.withdrawnAt ? `Withdrawn on ${formatDate(status.withdrawnAt)}. ` : ''}PencilLift
          won’t process new homework or build practice until consent is given again, and your
          children’s devices stay signed out until you pair them again. Records already collected
          stay until you delete them on the privacy page. A safety notice that was already on its
          way is still sent.
        </p>
      ) : (
        <p style={{ margin: '4px 0' }}>
          A verified adult consent, from an independent consent provider, is required before your
          child can scan homework. A checkbox or your parent PIN can’t replace it.
        </p>
      )}

      {status.isTestProvider ? (
        <p style={{ margin: '8px 0' }}>
          <strong>Test provider:</strong> this consent came from a development test service, not a
          real verification. It can’t enable processing of real children’s data in production.
        </p>
      ) : status.state === 'none' && status.configuredProviderIsTest ? (
        <p style={{ margin: '8px 0' }}>
          <strong>Test environment:</strong> this environment uses a development test consent
          service. Its results are not real verification.
        </p>
      ) : null}

      {redirectUrl ? (
        <p style={{ margin: '8px 0' }}>
          <a href={redirectUrl} target="_blank" rel="noopener noreferrer">
            Continue with the consent provider (opens in a new tab)
          </a>
        </p>
      ) : null}

      <div style={buttonRow}>
        {pendingId ? (
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void refresh(pendingId)}
          >
            {busy === 'refresh' ? 'Checking…' : 'Check status'}
          </button>
        ) : null}
        {canStart ? (
          <button
            type="button"
            className={restarting ? 'btn secondary' : 'btn'}
            disabled={busy !== null}
            onClick={() => void start()}
          >
            {busy === 'start' ? 'Starting…' : restarting ? 'Start consent again' : 'Start consent'}
          </button>
        ) : null}
        {/* Only a verified consent can be withdrawn here; a pending request is simply restarted. */}
        {status.state === 'verified' && !confirmWithdraw ? (
          <button
            type="button"
            className="btn secondary"
            disabled={busy !== null}
            onClick={() => setConfirmWithdraw(true)}
          >
            Withdraw consent
          </button>
        ) : null}
      </div>
      {confirmWithdraw ? (
        <div role="group" aria-label="Confirm withdrawal" style={sectionStyle}>
          <p style={{ margin: 0 }}>
            Withdraw consent? PencilLift stops collecting and using your children’s information: new
            homework won’t be processed, waiting homework tasks are cancelled, no new practice is
            built, and every paired child device is signed out (no device can be paired until
            consent is given again). Existing records stay until you delete them on the privacy
            page, and a safety notice that was already on its way is still sent.
          </p>
          <div style={buttonRow}>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => void withdraw()}
            >
              {busy === 'withdraw' ? 'Withdrawing…' : 'Yes, withdraw consent'}
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={busy !== null}
              onClick={() => setConfirmWithdraw(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <ActionFeedback feedback={feedback} stepUpAction="Withdrawing consent" />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// First run: create the family
// ---------------------------------------------------------------------------------------------

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  } catch {
    return 'America/New_York';
  }
}

function CreateFamily({ onCreated }: { onCreated: () => void }) {
  const { api } = useSession();
  const { busy, feedback, run } = useAction();
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(browserTimeZone);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const errorId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const displayName = name.trim();
    if (displayName.length < 1 || displayName.length > 80) {
      setFieldError('Enter a family name of 1 to 80 characters.');
      return;
    }
    setFieldError(null);
    const ok = await run('create', async () => {
      await api.send(
        'POST',
        '/v1/families',
        { displayName, timezone: timezone.trim() },
        createFamilyResponseSchema,
      );
      return 'Your family was created.';
    });
    if (ok) onCreated();
  };

  return (
    <section className="card" aria-labelledby="create-title">
      <h2 id="create-title">Create your family</h2>
      <p>
        You’ll be the family owner. Next you’ll give parental consent, add your children as draft
        profiles and choose a parent PIN.
      </p>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <label htmlFor="family-name">Family name</label>
        <input
          id="family-name"
          value={name}
          maxLength={80}
          autoComplete="off"
          aria-describedby={fieldError ? errorId : undefined}
          onChange={(e) => {
            setName(e.target.value);
            setFieldError(null);
          }}
        />
        {fieldError ? (
          <p id={errorId} role="alert" style={{ color: 'var(--danger)', margin: '4px 0 0' }}>
            {fieldError}
          </p>
        ) : null}
        <label htmlFor="family-timezone">Time zone</label>
        <input
          id="family-timezone"
          value={timezone}
          maxLength={64}
          autoComplete="off"
          onChange={(e) => setTimezone(e.target.value)}
        />
        <div style={buttonRow}>
          <button type="submit" className="btn" disabled={busy !== null}>
            {busy === 'create' ? 'Creating…' : 'Create family'}
          </button>
        </div>
      </form>
      <ActionFeedback feedback={feedback} stepUpAction="Creating a family" />
    </section>
  );
}
