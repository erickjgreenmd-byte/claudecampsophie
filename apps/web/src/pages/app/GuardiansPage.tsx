import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import {
  acceptInvitationResponseSchema,
  familyOkResponseSchema,
  guardianInvitationResponseSchema,
  guardiansResponseSchema,
  type GuardianMember,
  type GuardiansOverview,
  type PendingInvitation,
} from '@pencillift/contracts';
import { EmptyState, ErrorState, Loading } from '../../components/states.tsx';
import { RequireParent, useApiQuery, useSession } from '../../lib/session.tsx';
import {
  ActionFeedback,
  buttonRow,
  formatDate,
  sectionStyle,
  useAction,
  useLastGood,
} from './SecurityPage.tsx';

/**
 * Guardian management (spec P1 guardians, P3, P14 "guardian management"; AC_ACCESS_09). A family
 * has at most two adults. The owner invites by email; the invited adult must sign in with that
 * verified address and accept. The owner can cancel invitations and remove the guardian, which
 * ends their access immediately.
 *
 * The emailed link lands here as `/app/guardians#accept=<token>`. The token is read once, removed
 * from the address bar and kept only in memory until the adult accepts.
 */
export default function GuardiansPage() {
  return (
    <RequireParent>
      <Guardians />
    </RequireParent>
  );
}

const ACCEPT_PREFIX = '#accept=';

function Guardians() {
  const location = useLocation();
  const navigate = useNavigate();
  const [inviteToken, setInviteToken] = useState<string | null>(() =>
    location.hash.startsWith(ACCEPT_PREFIX) ? location.hash.slice(ACCEPT_PREFIX.length) : null,
  );
  // Strip the token from the address bar and history as soon as it is captured.
  useEffect(() => {
    if (location.hash.startsWith(ACCEPT_PREFIX)) {
      void navigate(
        { pathname: location.pathname, search: location.search, hash: '' },
        {
          replace: true,
        },
      );
    }
  }, [location.hash, location.pathname, location.search, navigate]);

  const [joined, setJoined] = useState(false);
  const query = useApiQuery((api) => api.get('/v1/guardians', guardiansResponseSchema), []);
  const data = useLastGood(query);
  const notInFamily = query.status === 'error' && query.error.code === 'NOT_FOUND';

  return (
    <>
      <h1>Guardians</h1>
      <p>
        PencilLift supports two adults per family: the owner and one guardian. After accepting an
        invitation, a guardian has the same access to your children as the owner. Only the owner can
        invite or remove a guardian.
      </p>
      {inviteToken ? (
        <AcceptInvitation
          token={inviteToken}
          onAccepted={() => {
            setInviteToken(null);
            setJoined(true);
            query.reload();
          }}
        />
      ) : null}
      {joined ? (
        <p role="status" style={{ color: 'var(--success)', fontWeight: 700 }}>
          You joined the family as a guardian.
        </p>
      ) : null}
      {data === null && query.status === 'loading' ? <Loading label="Loading guardians…" /> : null}
      {notInFamily && !data && !inviteToken ? (
        <EmptyState title="You’re not part of a family yet">
          <p>
            Open the invitation link from your email to join a family, or create your own family on
            the <Link to="/app">family dashboard</Link>.
          </p>
        </EmptyState>
      ) : null}
      {query.status === 'error' && !notInFamily ? (
        <ErrorState message={query.error.message} onRetry={query.reload} />
      ) : null}
      {data ? (
        <div aria-busy={query.status === 'loading'}>
          <GuardiansContent data={data} onChanged={query.reload} />
        </div>
      ) : null}
    </>
  );
}

function AcceptInvitation({ token, onAccepted }: { token: string; onAccepted: () => void }) {
  const { api } = useSession();
  const { busy, feedback, run } = useAction();

  const accept = async () => {
    const ok = await run('accept', async () => {
      await api.send('POST', '/v1/invitations/accept', { token }, acceptInvitationResponseSchema);
      return 'You joined the family as a guardian.';
    });
    if (ok) onAccepted();
  };

  return (
    <section className="card" aria-labelledby="accept-title" style={{ marginBottom: 16 }}>
      <h2 id="accept-title">Accept your guardian invitation</h2>
      <p>
        You were invited to join a family on PencilLift. Accept only if you know the family owner.
        You must be signed in with the email address the invitation was sent to, and that address
        must be verified.
      </p>
      <div style={buttonRow}>
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => void accept()}
        >
          {busy === 'accept' ? 'Accepting…' : 'Accept invitation'}
        </button>
      </div>
      <ActionFeedback feedback={feedback} stepUpAction="Accepting" />
    </section>
  );
}

function GuardiansContent({ data, onChanged }: { data: GuardiansOverview; onChanged: () => void }) {
  const isOwner = data.callerRole === 'owner';
  const full = data.members.length >= data.maxAdults;
  return (
    <>
      <section className="card" aria-labelledby="members-title">
        <h2 id="members-title">Adults in your family</h2>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }}>
          {data.members.map((member) => (
            <MemberRow
              key={member.userId}
              member={member}
              canRemove={isOwner}
              onChanged={onChanged}
            />
          ))}
        </ul>
      </section>

      <section className="card" style={sectionStyle} aria-labelledby="pending-title">
        <h2 id="pending-title">Pending invitations</h2>
        {data.pendingInvitations.length === 0 ? (
          <p>No invitations are waiting.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }}>
            {data.pendingInvitations.map((invitation) => (
              <InvitationRow
                key={invitation.id}
                invitation={invitation}
                canCancel={isOwner}
                onChanged={onChanged}
              />
            ))}
          </ul>
        )}
      </section>

      {isOwner ? (
        full ? (
          <section className="card" style={sectionStyle} aria-labelledby="invite-title">
            <h2 id="invite-title">Invite a guardian</h2>
            <p>
              Your family already has the maximum of {data.maxAdults} adults. Remove the current
              guardian first if you need to invite someone else.
            </p>
          </section>
        ) : (
          <InviteForm onInvited={onChanged} />
        )
      ) : (
        <p style={sectionStyle}>Only the family owner can invite or remove guardians.</p>
      )}
    </>
  );
}

function MemberRow({
  member,
  canRemove,
  onChanged,
}: {
  member: GuardianMember;
  canRemove: boolean;
  onChanged: () => void;
}) {
  const { api } = useSession();
  const { busy, feedback, run } = useAction();
  const [confirming, setConfirming] = useState(false);
  const role = member.role === 'owner' ? 'Owner' : 'Guardian';
  const who = member.email ?? 'Email not available';

  const remove = async () => {
    const ok = await run('remove', async () => {
      await api.send('DELETE', `/v1/guardians/${member.userId}`, undefined, familyOkResponseSchema);
      return 'The guardian was removed. Their access ended immediately.';
    });
    setConfirming(false);
    if (ok) onChanged();
  };

  return (
    <li>
      <p style={{ margin: 0, fontWeight: 700 }}>
        {role}
        {member.isYou ? ' (you)' : ''}: {who}
      </p>
      <p style={{ margin: '2px 0' }}>Joined {formatDate(member.acceptedAt)}</p>
      {canRemove && member.role === 'guardian' && !confirming ? (
        <button
          type="button"
          className="btn secondary"
          disabled={busy !== null}
          onClick={() => setConfirming(true)}
        >
          Remove guardian
        </button>
      ) : null}
      {confirming ? (
        <div className="notice" role="group" aria-label="Confirm removal" style={{ marginTop: 8 }}>
          <p style={{ margin: 0 }}>
            Remove this guardian? They lose access to your family and children immediately, on every
            device, including anything they had unlocked.
          </p>
          <div style={buttonRow}>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => void remove()}
            >
              {busy === 'remove' ? 'Removing…' : 'Yes, remove'}
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={busy !== null}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <ActionFeedback feedback={feedback} stepUpAction="Removing a guardian" />
    </li>
  );
}

function InvitationRow({
  invitation,
  canCancel,
  onChanged,
}: {
  invitation: PendingInvitation;
  canCancel: boolean;
  onChanged: () => void;
}) {
  const { api } = useSession();
  const { busy, feedback, run } = useAction();

  const cancel = async () => {
    const ok = await run('cancel', async () => {
      await api.send(
        'POST',
        `/v1/guardians/invitations/${invitation.id}/revoke`,
        undefined,
        familyOkResponseSchema,
      );
      return 'Invitation cancelled.';
    });
    if (ok) onChanged();
  };

  return (
    <li>
      <p style={{ margin: 0, fontWeight: 700 }}>{invitation.email}</p>
      <p style={{ margin: '2px 0' }}>Expires {formatDate(invitation.expiresAt)}</p>
      {canCancel ? (
        <button
          type="button"
          className="btn secondary"
          disabled={busy !== null}
          aria-label={`Cancel invitation to ${invitation.email}`}
          onClick={() => void cancel()}
        >
          {busy === 'cancel' ? 'Cancelling…' : 'Cancel invitation'}
        </button>
      ) : null}
      <ActionFeedback feedback={feedback} stepUpAction="Cancelling an invitation" />
    </li>
  );
}

function InviteForm({ onInvited }: { onInvited: () => void }) {
  const { api } = useSession();
  const { busy, feedback, run } = useAction();
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const errorId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      setFieldError('Enter a valid email address.');
      return;
    }
    setFieldError(null);
    const ok = await run('invite', async () => {
      const result = await api.send(
        'POST',
        '/v1/guardians/invitations',
        { email: address },
        guardianInvitationResponseSchema,
      );
      return `Invitation sent to ${result.email}. It expires ${formatDate(result.expiresAt)}.`;
    });
    if (ok) {
      setEmail('');
      onInvited();
    }
  };

  return (
    <section className="card" style={sectionStyle} aria-labelledby="invite-title">
      <h2 id="invite-title">Invite a guardian</h2>
      <p>
        We’ll email a link that works for 7 days. The other adult must sign in to PencilLift with
        this exact, verified email address to accept.
      </p>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <label htmlFor="guardian-email">Guardian’s email address</label>
        <input
          id="guardian-email"
          type="email"
          autoComplete="off"
          value={email}
          aria-describedby={fieldError ? errorId : undefined}
          onChange={(e) => {
            setEmail(e.target.value);
            setFieldError(null);
          }}
        />
        {fieldError ? (
          <p id={errorId} role="alert" style={{ color: 'var(--danger)', margin: '4px 0 0' }}>
            {fieldError}
          </p>
        ) : null}
        <div style={buttonRow}>
          <button type="submit" className="btn" disabled={busy !== null}>
            {busy === 'invite' ? 'Sending…' : 'Send invitation'}
          </button>
        </div>
      </form>
      <ActionFeedback feedback={feedback} stepUpAction="Inviting a guardian" />
    </section>
  );
}
