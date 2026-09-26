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

/**
 * How a child's state is spelled beside their name in another screen's picker (WEBR4-10). Both the
 * Homework and the learning-planner picker used to spell every non-active child " (no paid slot
 * yet)", which was written when 'draft' was the only non-active state a portal user could reach.
 * WEB-R2-03 makes 'archived' reachable in one click, and a requested deletion archives a child too:
 * for those two there is no slot waiting to be bought, so the sentence was false and unactionable.
 */
export function childPickerSuffix(child: {
  status: string;
  // `| undefined` explicitly: with exactOptionalPropertyTypes a caller's parsed
  // `deletionPending?: boolean | undefined` is not assignable to a bare optional (HUNT5-F-2).
  deletionPending?: boolean | undefined;
}): string {
  if (child.deletionPending === true) return ' (data deletion under way)';
  switch (child.status) {
    case 'active':
      return '';
    case 'archived':
      return ' (archived — history only)';
    default:
      return ' (no paid slot yet)';
  }
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

/**
 * Why activation is not on offer, for a draft and for an archived child alike: this portal never
 * sells capacity, so the only honest answer is where a slot comes from (WEB-R1-04).
 */
function noFreeSlotText(nickname: string, paidSlots: number): string {
  return paidSlots === 0
    ? `Your family has no paid child slots yet. To activate ${nickname}, subscribe in the PencilLift app.`
    : `All ${paidSlots} paid ${paidSlots === 1 ? 'slot is' : 'slots are'} in use. To activate ${nickname}, add a child slot to your plan in the PencilLift app.`;
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
  //
  // WEBR4-01: this also brings an ARCHIVED child back. POST /children/:childId/activate assigns a
  // free slot and clears archived_at for any profile that is not already active, but no client
  // offered it outside the draft branch, so the archive confirmation's promise ("You can activate
  // them again later while a paid slot is free") could not be kept and an archived child's devices
  // stayed signed out for good.
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
    // WEBR4-12: only a successful archive closes the confirmation. Closing it unconditionally left a
    // STEP_UP_REQUIRED refusal showing the inline PIN prompt's "Press the same button again to
    // continue" beside no such button, so the parent had to rediscover Archive → confirm.
    // `saveProfile` below already worked this way.
    if (ok) {
      setConfirmArchive(false);
      // HUNT5-F-3: close the edit form too. The row that holds "Cancel edit" is hidden for an
      // archived child (below), so an open form survived the archive with no way to dismiss it and a
      // live-looking "Save …" button whose PATCH the API refuses with BUSINESS_RULE CHILD_ARCHIVED.
      setEditing(false);
      onChanged();
    }
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
        // WEBR4-02: this used to say "Cancel the request on the privacy page if you did not mean
        // it". There is no cancel: /v1/privacy exposes only POST and GET /deletion, nothing sets
        // deletion_requests.status = 'cancelled', and the privacy page itself says the deletion
        // can't be undone. The notice now says what is true and where a mistake is actually handled.
        <p className="notice" style={{ margin: '4px 0' }}>
          <strong>Data deletion under way.</strong> You asked for {child.nickname}’s data to be
          deleted. Processing has already stopped, so nothing can be changed, paired or activated
          for them, and they stay listed here until the deletion finishes. You can follow it on the{' '}
          <Link to="/app/privacy">privacy page</Link>. Deletion can’t be undone from the app: if you
          did not mean it, <Link to="/app/support">contact support</Link> straight away.
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
            <p style={{ margin: '4px 0' }}>{noFreeSlotText(child.nickname, paidSlots)}</p>
          )}
        </>
      ) : child.status === 'archived' ? (
        // WEBR4-01: an archived child is not a dead end. The archive confirmation promises "You can
        // activate them again later while a paid slot is free", and POST /children/:id/activate does
        // exactly that for an archived profile, but no surface called it, so a family that archived a
        // child lost their access (the archive signs their devices out) with no way back in product.
        <>
          <p style={{ margin: '4px 0' }}>
            {child.nickname}’s homework, practice, points and rewards are all kept and stay
            readable. Activating {child.nickname} again assigns one of your unused paid slots, with
            no new purchase, and lets you pair a device.
          </p>
          {unusedSlots > 0 ? (
            <div style={buttonRow}>
              <button
                type="button"
                className="btn"
                disabled={busy !== null}
                aria-label={`Activate ${child.nickname} again with an unused paid slot`}
                onClick={() => void activate()}
              >
                {busy === 'activate' ? 'Activating…' : `Activate ${child.nickname} again`}
              </button>
            </div>
          ) : (
            <p style={{ margin: '4px 0' }}>{noFreeSlotText(child.nickname, paidSlots)}</p>
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
            {/*
              WEBR4-12: the label was unconditionally "…, frees the slot", but this row is rendered
              for a draft child too, and a draft holds no slot (slotSummary returns unchanged counts
              after archiving one). The confirmation body below already branched on the status.
            */}
            {child.status === 'active'
              ? 'Archive (keeps history, frees the slot)'
              : 'Archive (keeps history)'}
          </button>
        </div>
      )}
      {/*
        HUNT5-F-3: the status is part of the condition, so a change from ANY source — this card's own
        archive, another card's action, a reload started elsewhere — closes a form the server would
        refuse to save. `setEditing(false)` in archive() covers this card; this covers the rest.
      */}
      {editing && child.status !== 'archived' && !deletionPending ? (
        <EditChildForm child={child} busy={busy === 'edit'} onSave={saveProfile} />
      ) : null}
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
 *
 * WEBR4-03: the body used to carry all three fields every time, which made that promise false —
 * guardian A opening this form while the child was in grade 3, guardian B saving grade 4, then A
 * correcting only the nickname put the grade back to 3 with no warning, and the grade is what
 * practice generation is pitched at. The diff below is against the props the form was seeded with,
 * and the submit button stays disabled while the diff is empty (the contract's refine rejects an
 * empty body anyway).
 *
 * HUNT5-F-1: "seeded with" is now true. The diff used to compare the field state (seeded once, at
 * mount) against the LIVE `child` prop, which the page query replaces on every reload — and this
 * card is keyed on `child.id`, so a reload never remounts it. Any sibling action (a child added, a
 * card activated or archived) landed guardian B's grade 4 under the open form, and from that moment
 * the untouched grade select differed from the prop, so a nickname-only save carried grade 3 and
 * reverted the change WEBR4-03 was filed to protect.
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
  /**
   * The profile this form was opened on, captured once (HUNT5-F-1). Everything below diffs against
   * this, never against `child`, which the page query refreshes under the open form.
   */
  const [seed] = useState(child);
  const [nickname, setNickname] = useState(seed.nickname);
  const [grade, setGrade] = useState(String(seed.gradeLevel));
  const [ageBand, setAgeBand] = useState<AgeBand>(seed.ageBand);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const nicknameId = useId();
  const gradeId = useId();
  const bandId = useId();
  const errorId = useId();

  /** Only what differs from the profile this form was opened on (WEBR4-03, HUNT5-F-1). */
  const changes = (name: string): UpdateChildProfileRequest => ({
    ...(name === seed.nickname ? {} : { nickname: name }),
    ...(Number(grade) === seed.gradeLevel ? {} : { gradeLevel: Number(grade) }),
    ...(ageBand === seed.ageBand ? {} : { ageBand }),
  });
  const nothingChanged = Object.keys(changes(nickname.trim())).length === 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = nickname.trim();
    if (name.length < 1 || name.length > 40) {
      setFieldError('Enter a nickname of 1 to 40 characters.');
      return;
    }
    setFieldError(null);
    const body = changes(name);
    if (Object.keys(body).length === 0) return;
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
        <button type="submit" className="btn" disabled={busy || nothingChanged}>
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
