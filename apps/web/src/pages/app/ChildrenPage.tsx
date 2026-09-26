import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  CHILD_ACTIVATION_RULES,
  GRADE_LEVEL_MAX,
  ageBandSchema,
  childActivationResponseSchema,
  childArchiveResponseSchema,
  createChildProfileResponseSchema,
  createPairingCodeResponseSchema,
  familyOverviewResponseSchema,
  updateChildProfileResponseSchema,
  type AgeBand,
  type FamilyChild,
  type FamilyOverview,
  type UpdateChildProfileRequest,
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
 * sells capacity: new paid slots are bought in the PencilLift app from the App Store, Google Play or
 * the Amazon Appstore (WEB-R1-04).
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

/**
 * The grades and age bands the contract allows, read from the contract itself (L-036): the age
 * bands come from the enum's `.options` and the grades from GRADE_LEVEL_MAX, so widening the launch
 * scope in packages/contracts/src/family.ts reaches these menus without a second edit here.
 */
const GRADES: readonly number[] = Array.from({ length: GRADE_LEVEL_MAX + 1 }, (_, g) => g);
const AGE_BAND_OPTIONS: readonly AgeBand[] = ageBandSchema.options;

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
          new purchase. New paid slots are bought in the PencilLift app through the App Store,
          Google Play or the Amazon Appstore; this portal never charges you. See your{' '}
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
  const [lastAction, setLastAction] = useState<'code' | 'activate' | 'archive' | 'edit' | null>(
    null,
  );
  const [editing, setEditing] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const titleId = useId();
  /** A child whose data deletion is open is read-only here (API-AUTH-R2-02); see the notice below. */
  const deletionPending = child.deletionPending === true;

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

  // WEB-R2-03: archiving frees the paid slot and ends the child's sessions but keeps every scan,
  // point and reward (spec P11, AC_CAPACITY_08). The API route existed with no caller, so the only
  // way to free a slot or stop a child was deleting their whole history on the privacy page.
  const archive = async () => {
    setLastAction('archive');
    const ok = await run('archive', async () => {
      const result = await api.send(
        'POST',
        `/v1/children/${child.id}/archive`,
        undefined,
        childArchiveResponseSchema,
      );
      return `${child.nickname} is archived. Their history stays available and ${result.assignedSlots} of ${result.paidSlots} paid slots are now in use. ${result.note}`;
    });
    setConfirmArchive(false);
    if (ok) onChanged();
  };

  // WEB-R2-03: the grade drives practice generation, so without this a family stayed on last year's
  // grade after the school year rolled over.
  const saveProfile = async (body: UpdateChildProfileRequest) => {
    setLastAction('edit');
    const ok = await run('edit', async () => {
      const result = await api.send(
        'PATCH',
        `/v1/children/${child.id}`,
        body,
        updateChildProfileResponseSchema,
      );
      return `Saved. ${result.child.nickname} is in ${gradeLabel(result.child.gradeLevel).toLowerCase()}, ages ${result.child.ageBand}.`;
    });
    if (ok) {
      setEditing(false);
      onChanged();
    }
    return ok;
  };

  const activationError =
    feedback?.kind === 'error' && lastAction === 'activate' ? feedback.error : null;
  const stepUpAction =
    lastAction === 'activate'
      ? 'Assigning a paid slot'
      : lastAction === 'archive'
        ? 'Archiving a child'
        : lastAction === 'edit'
          ? 'Saving a child’s details'
          : 'Creating a pairing code';

  return (
    <li className="card" aria-labelledby={titleId}>
      <h3 id={titleId} style={{ margin: 0 }}>
        {child.nickname}
      </h3>
      <p style={{ margin: '4px 0' }}>
        {gradeLabel(child.gradeLevel)} · ages {child.ageBand}
      </p>
      <p style={{ margin: '4px 0', fontWeight: 700 }}>Status: {childStatusLabel(child.status)}</p>
      {deletionPending ? (
        // API-AUTH-R2-02: the child stays listed while a deletion is requested or processing, so a
        // parent can still see who it covers, but the server refuses activation, pairing and edits
        // for it, so no control is offered here either.
        <p className="notice" style={{ margin: '4px 0' }}>
          <strong>Data deletion under way.</strong> You asked for {child.nickname}’s data to be
          deleted, so nothing can be changed, paired or activated for them. Cancel the request on
          the <Link to="/app/privacy">privacy page</Link> if you did not mean it.
        </p>
      ) : child.status === 'active' ? (
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
      {child.status === 'archived' || deletionPending ? null : (
        <div style={buttonRow}>
          <button
            type="button"
            className="btn secondary"
            aria-expanded={editing}
            aria-label={`Edit ${child.nickname}’s details`}
            disabled={busy !== null}
            onClick={() => setEditing((open) => !open)}
          >
            {editing ? 'Cancel edit' : 'Edit profile'}
          </button>
          <button
            type="button"
            className="btn secondary"
            aria-label={`Archive ${child.nickname}`}
            disabled={busy !== null}
            onClick={() => setConfirmArchive(true)}
          >
            Archive (keeps history, frees the slot)
          </button>
        </div>
      )}
      {editing ? <EditChildForm child={child} busy={busy === 'edit'} onSave={saveProfile} /> : null}
      {confirmArchive ? (
        <div className="notice" role="group" aria-label={`Confirm archiving ${child.nickname}`}>
          <p style={{ margin: '0 0 8px' }}>
            Archive {child.nickname}? Their homework, practice, points and rewards are all kept and
            stay readable.{' '}
            {child.status === 'active'
              ? 'Their paid slot is freed for another child, and their '
              : 'Their '}
            paired devices are signed out. You can activate them again later while a paid slot is
            free. Your store subscription is unchanged — change the plan in the store to lower the
            price.
          </p>
          <div style={buttonRow}>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => void archive()}
            >
              {busy === 'archive' ? 'Archiving…' : `Yes, archive ${child.nickname}`}
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={busy !== null}
              onClick={() => setConfirmArchive(false)}
            >
              Keep {child.nickname} as they are
            </button>
          </div>
        </div>
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
          stepUpAction={stepUpAction}
        />
      )}
    </li>
  );
}

/**
 * Correcting one child's nickname, grade and age band (WEB-R2-03). Only the fields the parent
 * changed are sent, so a concurrent edit by the other guardian is not overwritten wholesale. The
 * server re-checks the recent PIN unlock, the contract bounds and the archived rule.
 */
function EditChildForm({
  child,
  busy,
  onSave,
}: {
  child: FamilyChild;
  busy: boolean;
  onSave: (body: UpdateChildProfileRequest) => Promise<boolean>;
}) {
  const [nickname, setNickname] = useState(child.nickname);
  const [grade, setGrade] = useState(String(child.gradeLevel));
  const [ageBand, setAgeBand] = useState<AgeBand>(child.ageBand);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const nicknameId = useId();
  const gradeId = useId();
  const bandId = useId();
  const errorId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = nickname.trim();
    if (name.length < 1 || name.length > 40) {
      setFieldError('Enter a nickname of 1 to 40 characters.');
      return;
    }
    setFieldError(null);
    const body: UpdateChildProfileRequest = {
      nickname: name,
      gradeLevel: Number(grade),
      ageBand,
    };
    await onSave(body);
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate style={{ marginTop: 8 }}>
      <label htmlFor={nicknameId}>Nickname</label>
      <input
        id={nicknameId}
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
      <label htmlFor={gradeId}>Grade</label>
      <select id={gradeId} value={grade} onChange={(e) => setGrade(e.target.value)}>
        {GRADES.map((g) => (
          <option key={g} value={String(g)}>
            {gradeLabel(g)}
          </option>
        ))}
      </select>
      <label htmlFor={bandId}>Age band</label>
      <select id={bandId} value={ageBand} onChange={(e) => setAgeBand(e.target.value as AgeBand)}>
        {AGE_BAND_OPTIONS.map((band) => (
          <option key={band} value={band}>
            Ages {band}
          </option>
        ))}
      </select>
      <p style={{ margin: '8px 0 0', fontSize: '0.9rem' }}>
        New practice is built for the grade saved here, so update it when the school year changes.
      </p>
      <div style={buttonRow}>
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Saving…' : `Save ${child.nickname}’s details`}
        </button>
      </div>
    </form>
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
          {AGE_BAND_OPTIONS.map((band) => (
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
