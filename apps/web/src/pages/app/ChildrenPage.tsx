import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  AGE_BANDS,
  CHILD_ACTIVATION_RULES,
  childActivationResponseSchema,
  createChildProfileResponseSchema,
  createPairingCodeResponseSchema,
  familyOverviewResponseSchema,
  type AgeBand,
  type FamilyChild,
  type FamilyOverview,
} from '@pencillift/contracts';
import { EmptyState, ErrorState, Loading } from '../../components/states.tsx';
import { RequireParent, useApiQuery, useSession } from '../../lib/session.tsx';
import {
  ActionFeedback,
  buttonRow,
  formatDateTime,
  sectionStyle,
  useAction,
  useLastGood,
} from './SecurityPage.tsx';

/**
 * Child profiles and device pairing (spec P3, P11, P14 "child list", "add-child/paid-slot
 * management"; AC_ACCESS_04, AC_CAPACITY_03). Adding a child creates an uncharged draft. A draft
 * becomes active when one of the family's unused paid slots is assigned to it (no new purchase);
 * only active children can be paired with a device. Pairing codes are shown once. This page never
 * sells capacity: new paid slots are bought in the PencilLift app from the App Store/Google Play.
 */
export default function ChildrenPage() {
  return (
    <RequireParent>
      <Children />
    </RequireParent>
  );
}

export function gradeLabel(grade: number): string {
  return grade === 0 ? 'Kindergarten' : `Grade ${grade}`;
}

/** Status is always spelled out in text, never shown by colour alone. */
export function childStatusLabel(status: FamilyChild['status']): string {
  switch (status) {
    case 'draft':
      return 'Draft: not active yet, no charge';
    case 'active':
      return 'Active: uses a paid slot';
    case 'archived':
      return 'Archived: history only';
  }
}

function Children() {
  const query = useApiQuery((api) => api.get('/v1/family', familyOverviewResponseSchema), []);
  const data = useLastGood(query);
  return (
    <>
      <h1>Children</h1>
      {data === null && query.status === 'loading' ? <Loading label="Loading children…" /> : null}
      {query.status === 'error' ? (
        query.error.code === 'NOT_FOUND' ? (
          <EmptyState title="Create your family first">
            <p>
              Set up your family on the <Link to="/app">family dashboard</Link>, then add your
              children here.
            </p>
          </EmptyState>
        ) : (
          <ErrorState message={query.error.message} onRetry={query.reload} />
        )
      ) : null}
      {data ? (
        <div aria-busy={query.status === 'loading'}>
          <ChildrenContent data={data} onChanged={query.reload} />
        </div>
      ) : null}
    </>
  );
}

/** Paid slots not yet assigned to an active child. Only these can be assigned without buying. */
export function unusedPaidSlots(data: FamilyOverview): number {
  const active = data.children.filter((c) => c.status === 'active').length;
  return Math.max(0, data.paidSlots - active);
}

function ChildrenContent({ data, onChanged }: { data: FamilyOverview; onChanged: () => void }) {
  const active = data.children.filter((c) => c.status === 'active').length;
  const unused = unusedPaidSlots(data);
  return (
    <>
      <section className="card" aria-labelledby="slots-title">
        <h2 id="slots-title">Paid child slots</h2>
        <p>
          Your plan has <strong>{data.paidSlots}</strong> paid child{' '}
          {data.paidSlots === 1 ? 'slot' : 'slots'}; <strong>{active}</strong> in use,{' '}
          <strong>{unused}</strong> unused.
        </p>
        <p>
          New children start as <strong>draft</strong> profiles. A draft costs nothing and can’t be
          used on a device. Activating a draft assigns one of your unused paid slots to it, with no
          new purchase. New paid slots are bought in the PencilLift app through the App Store or
          Google Play; this portal never charges you. See your{' '}
          <Link to="/app/subscription">subscription</Link> for the plan and managing store.
        </p>
      </section>

      <section style={sectionStyle} aria-labelledby="list-title">
        <h2 id="list-title">Your children</h2>
        {data.children.length === 0 ? (
          <p>No children yet. Add your first child below.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }}>
            {data.children.map((child) => (
              <ChildCard
                key={child.id}
                child={child}
                unusedSlots={unused}
                paidSlots={data.paidSlots}
                onChanged={onChanged}
              />
            ))}
          </ul>
        )}
      </section>

      <AddChildForm onAdded={onChanged} />
    </>
  );
}

function ChildCard({
  child,
  unusedSlots,
  paidSlots,
  onChanged,
}: {
  child: FamilyChild;
  unusedSlots: number;
  paidSlots: number;
  onChanged: () => void;
}) {
  const { api } = useSession();
  const { busy, feedback, run, setFeedback } = useAction();
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [lastAction, setLastAction] = useState<'code' | 'activate' | null>(null);
  const titleId = useId();

  // Spec P11 / AC_CAPACITY_03: an unused paid slot is assigned without buying again. The server
  // re-checks the slot count, consent and a recent PIN unlock; this never purchases anything.
  const activate = async () => {
    setLastAction('activate');
    const ok = await run('activate', async () => {
      const result = await api.send(
        'POST',
        `/v1/children/${child.id}/activate`,
        undefined,
        childActivationResponseSchema,
      );
      return `${child.nickname} is active and uses one of your paid slots (${result.assignedSlots} of ${result.paidSlots} in use). You can now create a pairing code.`;
    });
    if (ok) onChanged();
  };

  const createCode = () => {
    setLastAction('code');
    return run('code', async () => {
      const result = await api.send(
        'POST',
        `/v1/children/${child.id}/pairing-code`,
        undefined,
        createPairingCodeResponseSchema,
      );
      setCode(result);
      return `Pairing code created for ${child.nickname}.`;
    });
  };

  const activationError =
    feedback?.kind === 'error' && lastAction === 'activate' ? feedback.error : null;

  return (
    <li className="card" aria-labelledby={titleId}>
      <h3 id={titleId} style={{ margin: 0 }}>
        {child.nickname}
      </h3>
      <p style={{ margin: '4px 0' }}>
        {gradeLabel(child.gradeLevel)} · ages {child.ageBand}
      </p>
      <p style={{ margin: '4px 0', fontWeight: 700 }}>Status: {childStatusLabel(child.status)}</p>
      {child.status === 'active' ? (
        <div style={buttonRow}>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void createCode()}
          >
            {busy === 'code' ? 'Creating…' : 'Create pairing code'}
          </button>
        </div>
      ) : child.status === 'draft' ? (
        <>
          <p style={{ margin: '4px 0' }}>
            Pairing a device becomes available once {child.nickname} has a paid slot.
          </p>
          {unusedSlots > 0 ? (
            <div style={buttonRow}>
              <button
                type="button"
                className="btn"
                disabled={busy !== null}
                aria-label={`Assign an unused paid slot to ${child.nickname}`}
                onClick={() => void activate()}
              >
                {busy === 'activate' ? 'Assigning…' : 'Assign an unused paid slot'}
              </button>
            </div>
          ) : (
            <p style={{ margin: '4px 0' }}>
              {paidSlots === 0
                ? `Your family has no paid child slots yet. To activate ${child.nickname}, subscribe in the PencilLift app.`
                : `All ${paidSlots} paid ${paidSlots === 1 ? 'slot is' : 'slots are'} in use. To activate ${child.nickname}, add a child slot to your plan in the PencilLift app.`}
            </p>
          )}
        </>
      ) : null}
      {activationError?.rule === CHILD_ACTIVATION_RULES.consentRequired ? (
        <div className="notice" role="alert">
          <p style={{ margin: 0 }}>
            <strong>Parental consent comes first.</strong> A child can start only after a consent
            provider verifies an adult. <Link to="/app">Give consent on the family dashboard</Link>,
            then try again.
          </p>
        </div>
      ) : null}
      {code ? (
        <PairingCodePanel
          nickname={child.nickname}
          code={code}
          onDone={() => {
            setCode(null);
            setFeedback(null);
          }}
        />
      ) : (
        <ActionFeedback
          feedback={
            activationError?.rule === CHILD_ACTIVATION_RULES.consentRequired ? null : feedback
          }
          stepUpAction={
            lastAction === 'activate' ? 'Assigning a paid slot' : 'Creating a pairing code'
          }
        />
      )}
    </li>
  );
}

function PairingCodePanel({
  nickname,
  code,
  onDone,
}: {
  nickname: string;
  code: { code: string; expiresAt: string };
  onDone: () => void;
}) {
  const headingId = useId();
  return (
    <div className="notice" role="region" aria-labelledby={headingId} style={{ marginTop: 12 }}>
      <h4 id={headingId} style={{ margin: '0 0 8px' }}>
        Pairing code for {nickname}
      </h4>
      <p
        aria-label={`Pairing code ${code.code.split('').join(' ')}`}
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '2rem',
          fontWeight: 800,
          letterSpacing: '0.15em',
          margin: '4px 0',
        }}
      >
        {code.code}
      </p>
      <p style={{ margin: '4px 0' }}>Expires at {formatDateTime(code.expiresAt)}.</p>
      <ol style={{ margin: '8px 0' }}>
        <li>On {nickname}’s device, open PencilLift and choose “Connect a child’s device”.</li>
        <li>Enter this code. It works once and connects only {nickname}’s profile.</li>
        <li>If it expires, create a new code. Creating a new code cancels this one.</li>
      </ol>
      <p style={{ margin: '4px 0' }}>
        This code is shown only once. Don’t share it outside your family.
      </p>
      <button type="button" className="btn secondary" onClick={onDone}>
        Done
      </button>
    </div>
  );
}

const GRADES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;

function AddChildForm({ onAdded }: { onAdded: () => void }) {
  const { api } = useSession();
  const { busy, feedback, run } = useAction();
  const [nickname, setNickname] = useState('');
  const [grade, setGrade] = useState('3');
  const [ageBand, setAgeBand] = useState<AgeBand>('8-10');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const errorId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = nickname.trim();
    if (name.length < 1 || name.length > 40) {
      setFieldError('Enter a nickname of 1 to 40 characters.');
      return;
    }
    setFieldError(null);
    const ok = await run('add', async () => {
      await api.send(
        'POST',
        '/v1/children',
        { nickname: name, gradeLevel: Number(grade), ageBand },
        createChildProfileResponseSchema,
      );
      return `${name} was added as a draft profile.`;
    });
    if (ok) {
      setNickname('');
      onAdded();
    }
  };

  return (
    <section className="card" style={sectionStyle} aria-labelledby="add-title">
      <h2 id="add-title">Add a child</h2>
      <p>
        Use a nickname rather than a full name. PencilLift doesn’t need your child’s birth date,
        school or email.
      </p>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <label htmlFor="child-nickname">Nickname</label>
        <input
          id="child-nickname"
          value={nickname}
          maxLength={40}
          autoComplete="off"
          aria-describedby={fieldError ? errorId : undefined}
          onChange={(e) => {
            setNickname(e.target.value);
            setFieldError(null);
          }}
        />
        {fieldError ? (
          <p id={errorId} role="alert" style={{ color: 'var(--danger)', margin: '4px 0 0' }}>
            {fieldError}
          </p>
        ) : null}
        <label htmlFor="child-grade">Grade</label>
        <select id="child-grade" value={grade} onChange={(e) => setGrade(e.target.value)}>
          {GRADES.map((g) => (
            <option key={g} value={String(g)}>
              {gradeLabel(g)}
            </option>
          ))}
        </select>
        <label htmlFor="child-age">Age band</label>
        <select
          id="child-age"
          value={ageBand}
          onChange={(e) => setAgeBand(e.target.value as AgeBand)}
        >
          {AGE_BANDS.map((band) => (
            <option key={band} value={band}>
              Ages {band}
            </option>
          ))}
        </select>
        <div style={buttonRow}>
          <button type="submit" className="btn" disabled={busy !== null}>
            {busy === 'add' ? 'Adding…' : 'Add draft child'}
          </button>
        </div>
      </form>
      <ActionFeedback feedback={feedback} stepUpAction="Adding a child" />
    </section>
  );
}
