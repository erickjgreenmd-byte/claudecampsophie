import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  CHILD_ACTIVATION_RULES,
  GRADE_LEVEL_MAX,
  ageBandSchema,
  childActivationResponseSchema,
  childArchiveResponseSchema,
  ATTESTATION_REQUIRED_COPY,
  CONSENT_ATTESTATION_STATEMENT,
  createChildProfileResponseSchema,
  createPairingCodeResponseSchema,
  familyOverviewResponseSchema,
  updateChildProfileResponseSchema,
  type AgeBand,
  type FamilyChild,
  type FamilyOverview,
  type UpdateChildProfileRequest,
  childEditBody,
  childPickerSuffixCopy,
  childStatusCopy,
  heldPairingCode,
  markEdited,
  NOTHING_EDITED,
  PAIRING_STALE_COPY,
  pairingRedeemable,
  pairingStaleNextStep,
  type ChildCopySubject,
  type HeldPairingCode,
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
export function childPickerSuffix(child: ChildCopySubject): string {
  // Delegates to the ONE definition in packages/contracts/src/family.ts. This used to hold its own
  // switch, whose `default:` arm returned ' (no paid slot yet)' — the "yet" BUG-406 removed from the
  // same claim on the Children card, still live here and printed by HomeworkPage and
  // LearningPlannerPage, because that repair's grep was for the other wording (L-057's third copy, in
  // the file the repair itself edited). Its archived arm also disagreed with the phone's.
  return childPickerSuffixCopy(child);
}

/**
 * Status is always spelled out in text, never shown by colour alone.
 *
 * HUNT6-G-2: the flag is tested FIRST, before the status, exactly as `childPickerSuffix` above and
 * the controls below already test it. `public.request_deletion` archives a child-scope target
 * (migrations 0600, 0890), so every deletion-pending child is `archived` and this helper used to
 * print "Archived: history only" — that the history is KEPT — for a child whose history the purge is
 * deleting, two lines above this page's own notice that it is being deleted. HUNT5-F-2 removed that
 * sentence from the dashboard row by wrapping the CALL there; the sibling call on this page kept it,
 * so the branch lives in the one helper both surfaces print from (L-037).
 *
 * THAT LAST CLAUSE WAS FALSE FOR A ROUND, and it is worth saying so here rather than only in the
 * ledger, because the vagueness is what hid it: "the one helper both surfaces print from" named
 * neither the helper nor its file, so nobody could check it — and the phone held a byte-identical
 * copy of this switch the whole time. Round 7's parity audit found six claims of this shape and
 * called this the reason the next round would repeat round 6.
 *
 * It is TRUE as of `71e49e2`, and now says which helper so a reader can verify it in one grep: the
 * decision is `childStatusCopy` in `packages/contracts/src/family.ts`, which this function and the
 * app's `childStatusText` (apps/mobile/src/family/family-view.ts) both call and neither shadows.
 * The evidence is not this sentence: mutating the shared sentence reds three cases under apps/web
 * AND three under apps/mobile, which two coincidentally-equal helpers could not do.
 */
export function childStatusLabel(child: ChildCopySubject): string {
  // Delegates to the ONE definition in packages/contracts/src/family.ts, which the app imports too.
  // The docblock above this used to claim "the branch lives in the one helper both surfaces print
  // from (L-037)" while the phone held a byte-identical copy of the same switch — the exact false
  // claim round 7's largest finding is named after, in the file that defined the helper.
  return childStatusCopy(child);
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
 *
 * HUNT7-G-8: the no-slot branch does not say "yet". That word asserted the family has never held a
 * paid slot, and `releaseSlotlessProfiles` (apps/api/src/services/billing-sync.ts) makes it false: it
 * sets `status = 'draft'` on a previously ACTIVE child whenever verified provider state releases its
 * slot (release_reason 'expired' or 'downgrade'), and `family_capacity.paid_slots` is then 0 for a
 * family that has been paying. So this sentence — printed once per child, on both branches below —
 * told exactly the lapsed population they had never paid for the children they had been paying for.
 * It is the same word and the same premise HUNT6-H-4 removed from the planner's draft branch
 * (LearningPlannerPage.tsx), whose own fix named THIS file as the model for naming the remedy without
 * anyone grepping it for the word being removed (L-057).
 *
 * What it still does not do is promise capacity: it names where a slot comes from and never says one
 * is waiting. "Choose or renew" covers a family that has never subscribed and one whose plan lapsed
 * without asserting which is reading it. The phone twin `draftActivationNote`
 * (apps/mobile/src/family/family-view.ts) carries the same decision, pointing at the app's own Plan
 * and child slots screen.
 */
function noFreeSlotText(nickname: string, paidSlots: number): string {
  return paidSlots === 0
    ? `Your family has no paid child slots right now. To activate ${nickname}, choose or renew a plan in the PencilLift app.`
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
  const { busy, feedback, run } = useAction();
  /**
   * The pairing code this card minted, as `HeldPairingCode` defines the state (G-PROSE). What is
   * RENDERED is `shownCode` below: the decision is `heldPairingCode` in
   * `packages/contracts/src/family.ts`, which the phone's pair-device screen imports too.
   */
  const [code, setCode] = useState<HeldPairingCode>(null);
  const [lastAction, setLastAction] = useState<'code' | 'activate' | 'archive' | 'edit' | null>(
    null,
  );
  const [editing, setEditing] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const titleId = useId();
  /** A child whose data deletion is open is read-only here (API-AUTH-R2-02); see the notice below. */
  const deletionPending = child.deletionPending === true;
  /** Nothing about this profile can be changed: the edit form and the archive confirmation both go. */
  const readOnly = child.status === 'archived' || deletionPending;
  /**
   * BUG-395/BUG-410: the necessary condition for a code this card is holding to be redeemable, and
   * the only one this page can observe. The rule, and every reason `true` is not a guarantee, are
   * stated once in `pairingRedeemable` (`packages/contracts/src/family.ts`) — which the phone's
   * pair-device screen imports too, so correcting it corrects both surfaces. This page held its own
   * copy of the predicate until BUG-411 (g); it holds none now.
   */
  const redeemable = pairingRedeemable(child);
  /**
   * BUG-397: what is RENDERED where a code would go, decided from the child of THIS render rather
   * than by an effect racing the code's arrival. A code minted before the status moved resolves into
   * this call like any other and comes back 'stale'.
   */
  const shownCode = heldPairingCode(code, child);
  /**
   * The live answer to `pairingRedeemable`, for the SENTENCE `createCode` reads out when its POST
   * resolves: its closure holds the child from the render the parent pressed in — the one render
   * where the profile is still redeemable — and this ref holds the latest.
   */
  const redeemableNow = useRef(redeemable);
  redeemableNow.current = redeemable;

  /**
   * G-PROSE: the one rule every open panel on this card answers to, and it CLEARS the state rather
   * than leaving it standing behind the notice. HUNT5-F-3 and HUNT6-G-5 each added a render condition,
   * which is only half of it: this card is keyed on `child.id`, so a reload never remounts it, and a
   * `confirmArchive` that was merely hidden reopened itself the moment the parent activated the child
   * again — a confirmation to archive a child they had just brought back, which nobody asked for
   * twice. The pairing-code panel had no condition at all, so a code minted before the reload stayed
   * on screen for a child who can no longer redeem it; the parent would have typed it into the device
   * and been refused.
   *
   * BUG-397: this effect no longer DECIDES anything about the code — `shownCode` above does, at every
   * render, so a code that arrives after the status has moved is covered by the same call as one
   * already in hand. What is left here is the LATCH: writing the rendered answer back means a code
   * once turned stale is never turned back, so activating the child again does not resurrect a code
   * the server has already refused. `shownCode` is `code` itself while the profile is redeemable, so
   * this runs only when the answer actually changes.
   */
  useEffect(() => {
    if (readOnly) {
      setEditing(false);
      setConfirmArchive(false);
    }
  }, [readOnly]);
  useEffect(() => {
    setCode(shownCode);
  }, [shownCode]);

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
      // BUG-397: what came back is stored as it came back, and `shownCode` decides whether it may be
      // printed — at the render, from that render's child. The server minted a real code (its own
      // `child.status !== 'active'` check passed when the request was made) and archiving does not
      // consume it, so a profile that moved while this POST was in flight leaves a code the device
      // would refuse; the card says so instead of printing it. The SENTENCE below is the one thing
      // that needs the answer at resolution time, which is what `redeemableNow` holds.
      setCode(result);
      return redeemableNow.current
        ? `Pairing code created for ${child.nickname}.`
        : `The pairing code for ${child.nickname} was created, but their profile changed before it arrived.`;
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
      <p style={{ margin: '4px 0', fontWeight: 700 }}>Status: {childStatusLabel(child)}</p>
      {deletionPending ? (
        // API-AUTH-R2-02: the child stays listed while a deletion is requested or processing, so a
        // parent can still see who it covers, but the server refuses activation, pairing and edits
        // for it, so no control is offered here either.
        // WEBR4-02: this used to say "Cancel the request on the privacy page if you did not mean
        // it". There is no cancel: /v1/privacy exposes only POST and GET /deletion, nothing sets
        // deletion_requests.status = 'cancelled', and the privacy page itself says the deletion
        // can't be undone. The notice now says what is true and where a mistake is actually handled.
        // G-I3-WEB / L-037: and it names the OPEN REQUEST, not the reader. `deletionPending` carries
        // no requester — GET /v1/family computes it from the request's scope and target and never
        // exposes deletion_requests.requested_by (apps/api/src/routes/family.ts) — any guardian may
        // delete a child's data, and a child-scope request leaves every other adult's membership
        // active, so the family's OTHER adult is served the same flag and was told they had asked for
        // it. Same sentence as the app (apps/mobile/app/(parent)/children.tsx).
        <p className="notice" style={{ margin: '4px 0' }}>
          <strong>Data deletion under way.</strong> A deletion request covering {child.nickname}’s
          data is open. Processing has already stopped, so nothing can be changed, paired or
          activated for them, and they stay listed here until the deletion finishes. You can follow
          it on the <Link to="/app/privacy">privacy page</Link>. Deletion can’t be undone from the
          app: if you did not mean it, <Link to="/app/support">contact support</Link> straight away.
        </p>
      ) : redeemable ? (
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
      {readOnly ? null : (
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
      {editing && !readOnly ? (
        <EditChildForm child={child} busy={busy === 'edit'} onSave={saveProfile} />
      ) : null}
      {/*
        HUNT6-G-5: the same condition, for the same reason. This confirmation is one of the card's three
        open panels and the button row above hides Edit AND Archive for an archived or deletion-pending
        child, so without the status it was the one live control left under the notice that says
        nothing can be changed for them — promising "You can activate them again later" while
        POST /children/:id/archive answers NOT_FOUND, because `visibleChild` excludes a child under an
        open deletion (apps/api/src/routes/family.ts). `readOnly` is the same value the edit form and
        the button row use, and the effect above clears the state behind both panels, so one status
        change closes every panel on this card — and none of them reopens when the status changes back.
      */}
      {confirmArchive && !readOnly ? (
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
      {/*
        HUNT7-G-1: an UNCONDITIONAL sibling, the way every other card in the portal renders it
        (Devices, Guardians, Family, Support, Security and the five learning sections) — it returns
        null for a null feedback itself (ActionFeedback, apps/web/src/pages/app/SecurityPage.tsx).
        While it was the `code === null` arm of one three-way ternary, a card holding a code or the
        stale notice swallowed EVERY outcome of activate(), archive(), saveProfile() and createCode():
        the success line, an ErrorState for a business rule or a network failure, and the inline PIN
        field a STEP_UP_REQUIRED needs. That is not a rare window — POST /children/:childId/activate
        calls assertRecentUnlock (apps/api/src/routes/family.ts) and an unlock lasts a few minutes, so
        a refusal is the routine outcome of "Activate {nickname} again", and the stale notice is
        standing on exactly the cards that offer that button. StepUpPrompt exists so the PIN is
        entered on the page the parent was already on (WEB-R2-05), which a swallowed notice undoes.
        The consentRequired substitution stays: that rule has its own notice above.
      */}
      <ActionFeedback
        feedback={
          activationError?.rule === CHILD_ACTIVATION_RULES.consentRequired ? null : feedback
        }
        stepUpAction={stepUpAction}
      />
      {shownCode === null ? null : shownCode === 'stale' ? (
        // G-PROSE: what the parent is told instead of a code the device would refuse. Vanishing in
        // silence would be its own puzzle — the panel says a code is shown only once — so the reason
        // and the way back are both named here.
        //
        // BUG-395: what it does NOT say is that being active is sufficient, and BUG-393: its moving
        // sentence is decided by the same predicate as the rest of the card, so the two cannot
        // contradict each other. Every word of it, and why each is the word it is, now lives in
        // `PAIRING_STALE_COPY` and `pairingStaleNextStep` (`packages/contracts/src/family.ts`) —
        // imported by the phone's pair-device screen too, which had none of this work (BUG-411 (g)).
        // The <Link> is this surface's own control for the shared `consentTarget` words.
        <div className="notice" role="status" style={{ marginTop: 12 }}>
          <p style={{ margin: '0 0 8px' }}>
            <strong>{PAIRING_STALE_COPY.headline}</strong> {PAIRING_STALE_COPY.reason}{' '}
            {pairingStaleNextStep(child, child.nickname)} {PAIRING_STALE_COPY.consentLead}{' '}
            <Link to="/app">{PAIRING_STALE_COPY.consentTarget}</Link>.
          </p>
          {/*
            HUNT7-G-1 (repair): this clears the CODE and nothing else. It used to clear `feedback`
            too, which was invisible while a code or this notice stood in front of ActionFeedback and
            is not any more: `feedback` is the sole input to ActionFeedback -> StepUpNotice ->
            StepUpPrompt (apps/web/src/pages/app/SecurityPage.tsx), so dismissing a notice about a
            dead code threw away the inline PIN field — and the PIN the parent had typed into it —
            that this card's own "Activate {nickname} again" refusal had just put there (WEB-R2-05).
            Nothing needs it: `run` in useAction clears the previous feedback before every action.
          */}
          <button type="button" className="btn secondary" onClick={() => setCode(null)}>
            Done
          </button>
        </div>
      ) : (
        // The same rule for the live code's own Done, for the same reason: this card offers Edit and
        // Archive beside a printed code, and either one's STEP_UP_REQUIRED puts the PIN field here.
        <PairingCodePanel nickname={child.nickname} code={shownCode} onDone={() => setCode(null)} />
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
 * practice generation is pitched at. What the body carries now is the fields the parent EDITED here,
 * and the submit button stays disabled until one of them is (the contract's refine rejects an empty
 * body anyway).
 *
 * That is a diff no longer, and the two fixes behind it are why. HUNT5-F-1: the body used to be a diff
 * of the field state (seeded once, at mount) against the LIVE `child` prop, which the page query
 * replaces on every reload — and this card is keyed on `child.id`, so a reload never remounts it. Any
 * sibling action (a child added, a card activated or archived) landed guardian B's grade 4 under the
 * open form, and from that moment the untouched grade select differed from the prop, so a nickname-only
 * save carried grade 3 and reverted the change WEBR4-03 was filed to protect. HUNT6-G-8: diffing
 * against the SEED instead fixed that and made the value the parent can see unsavable, so `touched`
 * below replaced the diff altogether. The seed is still read, by `drifted`, for the one job of naming
 * what changed under the form since it opened — what changed, not who changed it (HUNT7-G-2).
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
   * The profile this form was opened on, captured once (HUNT5-F-1). The fields below are seeded from
   * this and never reseeded, so a reload cannot move them under the parent's hands. What this form
   * SENDS is decided by `touched` alone (HUNT6-G-8), not by comparing anything. `child` — the live
   * prop the page query refreshes under the open form — is read in exactly one place, `drifted`, and
   * only to name what changed under the form since it opened; it never decides what travels.
   */
  const [seed] = useState(child);
  const [nickname, setNickname] = useState(seed.nickname);
  const [grade, setGrade] = useState(String(seed.gradeLevel));
  const [ageBand, setAgeBand] = useState<AgeBand>(seed.ageBand);
  const [fieldError, setFieldError] = useState<string | null>(null);
  /**
   * Which fields the parent has edited in THIS form (HUNT6-G-8). "Edited" is what the request body
   * and the submit button hang on, instead of "differs from the seed".
   *
   * The seed diff was right about what to SEND and wrong about what to OFFER: once the other
   * guardian's grade landed under the open form, the select kept showing the seeded grade 3, the diff
   * against that seed was empty for it by construction, and no keystroke could enable Save for the
   * grade the parent could see. Cancel and reopen reseeds to grade 4 — the opposite of what a parent
   * correcting the grade is trying to do, and the grade is what practice generation is pitched at.
   *
   * An untouched field is still never sent, which is the WEBR4-03/HUNT5-F-1 property, and Save stays
   * off until something is edited, so reopening the form and pressing it cannot revert anything. No
   * diff decides any of that any more: `seed` only seeds the fields, and `drifted` below is the one
   * comparison left in this form — of the live prop against the seed, to say what changed under it.
   */
  // The SAME branded value the phone form uses (packages/contracts/src/family.ts): NOTHING_EDITED
  // and markEdited are its only builders, so neither form can pass an all-true literal and send a
  // field the parent never edited. That literal is the defect, and on the phone it typechecked.
  const [touched, setTouched] = useState(NOTHING_EDITED);
  const nicknameId = useId();
  const gradeId = useId();
  const bandId = useId();
  const errorId = useId();

  /**
   * Only the fields the parent edited in this form (WEBR4-03, HUNT5-F-1, HUNT6-G-8) — now by the ONE
   * shared rule rather than a second copy of it. The phone held a byte-identical re-derivation for
   * three rounds while this one was pinned, which is why it silently reverted the other guardian's
   * grade; a checker proved mutating one could not red a single test on the other.
   */
  const changes = (name: string): UpdateChildProfileRequest =>
    childEditBody({ nickname: name, gradeLevel: Number(grade), ageBand }, touched);
  const nothingEdited = Object.keys(changes(nickname.trim())).length === 0;

  /**
   * What changed under this form since it was seeded: the live prop against the seed (HUNT6-G-8). The
   * card above the form shows the new values and the fields show the old ones; without this, nothing
   * on screen said the two were about the same child.
   *
   * HUNT7-G-2: it says WHAT changed and not WHO changed it, because the response cannot carry a who.
   * `familyChildSchema` and `familyOverviewResponseSchema` are strict objects with no actor field
   * (packages/contracts/src/family.ts) and GET /v1/family selects no actor column
   * (apps/api/src/routes/family.ts) — the same fact that made the deletion notice above name the open
   * request instead of the reader (G-I3-WEB). "Another guardian changed …" was asserted for any
   * difference, including two the reader causes themselves: the same parent editing this child in the
   * phone app or a second tab (this card is keyed on `child.id`, so the open form is never remounted),
   * and a save whose RELOAD failed, where `useLastGood` keeps the pre-save values, the reopened form is
   * seeded from them, and the next good GET lands the parent's own new name under it. In a
   * one-guardian family the sentence also asserted that a second adult has write access to the child's
   * profile, which neither this page nor /v1/family can establish. Reseeding the form instead is NOT
   * the fix — that is BUG-330, the value on screen becoming unsavable — so only the actor claim goes.
   */
  const drifted = [
    ...(child.nickname === seed.nickname ? [] : [`the nickname is now “${child.nickname}”`]),
    ...(child.gradeLevel === seed.gradeLevel
      ? []
      : [`the grade is now ${gradeLabel(child.gradeLevel)}`]),
    ...(child.ageBand === seed.ageBand ? [] : [`the age band is now ages ${child.ageBand}`]),
  ];

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
          setTouched((t) => markEdited(t, 'nickname'));
          setFieldError(null);
        }}
      />
      {fieldError ? (
        <p id={errorId} role="alert" style={{ color: 'var(--danger)', margin: '4px 0 0' }}>
          {fieldError}
        </p>
      ) : null}
      <label htmlFor={gradeId}>Grade</label>
      <select
        id={gradeId}
        value={grade}
        onChange={(e) => {
          setGrade(e.target.value);
          setTouched((t) => markEdited(t, 'gradeLevel'));
        }}
      >
        {GRADES.map((g) => (
          <option key={g} value={String(g)}>
            {gradeLabel(g)}
          </option>
        ))}
      </select>
      <label htmlFor={bandId}>Age band</label>
      <select
        id={bandId}
        value={ageBand}
        onChange={(e) => {
          setAgeBand(e.target.value as AgeBand);
          setTouched((t) => markEdited(t, 'ageBand'));
        }}
      >
        {AGE_BAND_OPTIONS.map((band) => (
          <option key={band} value={band}>
            Ages {band}
          </option>
        ))}
      </select>
      <p style={{ margin: '8px 0 0', fontSize: '0.9rem' }}>
        New practice is built for the grade saved here, so update it when the school year changes.
      </p>
      {drifted.length > 0 ? (
        <p className="notice" role="note" style={{ margin: '8px 0 0' }}>
          <strong>
            This profile changed somewhere else while this form was open: {drifted.join(' and ')}.
          </strong>{' '}
          The fields above still show what you opened. Saving sends only the fields you edit here,
          so that change stays unless you edit that field too.
        </p>
      ) : null}
      <div style={buttonRow}>
        <button type="submit" className="btn" disabled={busy || nothingEdited}>
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
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  // The parental/guardian attestation for THIS child (migration 0970). It travels with the child's
  // details in one submission, so a child never exists without an attestation covering it.
  const [attested, setAttested] = useState(false);
  const [attestError, setAttestError] = useState<string | null>(null);
  const nicknameErrorId = useId();
  const attestErrorId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = nickname.trim();
    const badNickname = name.length < 1 || name.length > 40;
    setNicknameError(badNickname ? 'Enter a nickname of 1 to 40 characters.' : null);
    setAttestError(attested ? null : ATTESTATION_REQUIRED_COPY);
    // Both are reported in one pass: a parent who left the nickname blank AND skipped the box sees
    // both reasons, rather than fixing one and being refused again for the other.
    if (badNickname || !attested) return;
    const ok = await run('add', async () => {
      await api.send(
        'POST',
        '/v1/children',
        { nickname: name, gradeLevel: Number(grade), ageBand, parentalAttestation: true },
        createChildProfileResponseSchema,
      );
      return `${name} was added as a draft profile.`;
    });
    if (ok) {
      setNickname('');
      // The next child needs its own attestation: the statement is about one child, so a ticked box
      // must never carry over to a sibling.
      setAttested(false);
      setAttestError(null);
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
          aria-describedby={nicknameError ? nicknameErrorId : undefined}
          onChange={(e) => {
            setNickname(e.target.value);
            setNicknameError(null);
          }}
        />
        {nicknameError ? (
          <p
            id={nicknameErrorId}
            role="alert"
            style={{ color: 'var(--danger)', margin: '4px 0 0' }}
          >
            {nicknameError}
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
        <div style={{ margin: '16px 0 0' }}>
          <label
            htmlFor="child-attestation"
            style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontWeight: 400 }}
          >
            <input
              id="child-attestation"
              type="checkbox"
              checked={attested}
              aria-describedby={attestError ? attestErrorId : undefined}
              onChange={(e) => {
                setAttested(e.target.checked);
                setAttestError(null);
              }}
              style={{ marginTop: 4, width: 20, height: 20 }}
            />
            <span>{CONSENT_ATTESTATION_STATEMENT}</span>
          </label>
          {attestError ? (
            <p
              id={attestErrorId}
              role="alert"
              style={{ color: 'var(--danger)', margin: '4px 0 0' }}
            >
              {attestError}
            </p>
          ) : null}
        </div>
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
