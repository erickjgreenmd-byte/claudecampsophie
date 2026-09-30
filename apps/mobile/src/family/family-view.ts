import {
  CHILD_ACTIVATION_RULES,
  type ChildActivationResponse,
  type ChildDevice,
  type FamilyChild,
  type FamilyOverview,
  childPickerSuffixCopy,
  childStatusCopy,
  type ChildCopySubject,
} from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';

/**
 * View models for the parent family screens (home, children, devices). Status is always spelled
 * out in text so it never relies on colour alone. Pure: no react-native imports.
 */

/**
 * The state a parent screen's load is in, as `useLoad` (src/family/ui.tsx) and the screens that own
 * their own fetch hold it.
 */
export type LoadState<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: unknown }
  | { readonly status: 'ready'; readonly data: T };

/**
 * What a screen shows while a load runs: the rows it already has, or 'loading' (HUNT6-I-2).
 *
 * Premise, in one sentence: the rows on a parent screen were produced by one particular `load`
 * closure, and `producedBy !== running` is the observable fact that the rows on screen were NOT
 * produced by the load that is running now — so the screen cannot vouch for them and shows none.
 * That is deliberately not the same claim as "the adult changed": every parent screen's load is
 * `useCallback(…, [api])` and the parent gate publishes a new client whenever the adult at the device
 * changed (src/lib/mode.ts), so an adult change always reaches here as a new load; a remount or any
 * other new client reaches here the same way and costs the same one refetch. The direction that must
 * never happen is the other one — keeping rows across a load the screen did not run — because that is
 * the handed-on tablet showing the previous family's children.
 *
 * `useLoad` preserved 'ready' unconditionally, which meant the rows stayed up for the length of the
 * new adult's request (DEFAULT_REQUEST_TIMEOUT_MS is 20 s, longer on a retry). A manual reload passes
 * the same load twice, so pull-to-refresh and the post-edit reloads keep their no-flash behaviour.
 */
export function loadStateForRun<T>(
  state: LoadState<T>,
  producedBy: (() => Promise<T>) | null,
  running: () => Promise<T>,
): LoadState<T> {
  return state.status === 'ready' && producedBy === running ? state : { status: 'loading' };
}

export function gradeText(grade: number): string {
  return grade === 0 ? 'Kindergarten' : `Grade ${grade}`;
}

/**
 * Status is always spelled out in text, never shown by colour alone. Both parent screens print this
 * one sentence — app/(parent)/children.tsx and app/(parent)/home.tsx render `row.statusText` — so
 * correcting it here corrects it everywhere.
 *
 * HUNT7-G-3 / HUNT7-J-1: the flag is tested FIRST, before the status, exactly as `childPickerSuffix`
 * above already tests it and exactly as the portal's `childStatusLabel` decides it
 * (apps/web/src/pages/app/ChildrenPage.tsx). `public.request_deletion` archives a child-scope target
 * in the same transaction (migrations 0600, 0890) and GET /v1/family returns that row with
 * `deletionPending: true` (apps/api/src/routes/family.ts), so EVERY deletion-pending child is
 * `archived` — and this helper answered 'Archived: history only', that the history is KEPT, for a
 * child whose history the purge is deleting. On the Children screen that stood two lines above this
 * app's own notice that the data is being deleted; on the parent home there is no counter-notice at
 * all, so it was the only thing the screen said about it. HUNT6-G-2 fixed the portal and claimed one
 * helper decides the sentence for every surface (L-037); the phone is the other surface.
 */
export function childStatusText(child: ChildCopySubject): string {
  // ONE definition, in packages/contracts/src/family.ts, which the portal imports too. This function
  // and the portal's `childStatusLabel` were byte-identical switch bodies in two files, cross-guarded
  // only by a test that read the other file's source — which catches a reworded sentence but not a
  // widened predicate, so it guarded the words and not the meaning (the stage-4 checker's finding).
  return childStatusCopy(child);
}

/**
 * Whether the parent may still change a child's practice plan (HUNT6-H-1).
 *
 * The API decides it: the learning writes — PATCH /subjects, PUT /learning-schedule — go through
 * `ownedChild(c, 'write')`, which answers 422 BUSINESS_RULE CHILD_ARCHIVED for an archived profile,
 * while the reads behind the same screen succeed (apps/api/src/routes/learning.ts). So the planner
 * mounted every editing control for a child whose every save the server refuses: a parent who
 * archived a child to free a paid slot edited the daily practice time, pressed Save and lost what they
 * typed. A DRAFT stays writable on purpose — learning.ts keeps it so — which is why this is not
 * "only an active child".
 */
export function childPlanEditable(status: FamilyChild['status']): boolean {
  return status !== 'archived';
}

/**
 * How a child is named in a picker that offers more than one (the same job as the portal's
 * `childPickerSuffix`, apps/web/src/pages/app/ChildrenPage.tsx). A state that changes what the screen
 * behind the picker can do belongs in the option itself, so the parent is not left to discover it
 * after choosing — above all a deletion under way, for which the learning reads answer NOT_FOUND
 * (HUNT7-J-2).
 *
 * The flag is tested FIRST, before the status: `request_deletion` archives a child-scope target
 * (migration 0890), so such a child reads as archived here too, and "archived" is the more comforting
 * of the two words.
 */
export function childPickerSuffix(child: ChildCopySubject): string {
  // ONE definition (packages/contracts/src/family.ts). The archived arm here used to say
  // ' (archived — plan is read-only)' where the portal said ' (archived — history only)': two
  // sentences for one state, one audience, in helpers of the same name. The shared arm is the
  // portal's, because "history only" is what the status line says and is true wherever the picker is
  // printed, while "plan is read-only" is only true of the planner.
  return childPickerSuffixCopy(child);
}

export interface ChildRow {
  readonly id: string;
  readonly nickname: string;
  readonly detail: string;
  readonly statusText: string;
  /** Only active children (holding a paid slot) can be paired with a device. */
  readonly canPair: boolean;
  /** Why pairing is unavailable, shown instead of a disabled/dead button. */
  readonly pairingNote: string | null;
  /**
   * A draft, or an archived child, can take one of the family's unused paid slots without a new
   * purchase (spec P11, AC_CAPACITY_03, WEBR4-01) via POST /v1/children/:id/activate: that route
   * clears archived_at for any profile that is not already active, and the archive confirmation on
   * the Children screen promises it. The server re-checks everything.
   */
  readonly canActivate: boolean;
  /**
   * Why that draft or archived child can't be activated here (no unused slot), shown instead of a
   * dead button.
   */
  readonly activationNote: string | null;
}

/** Paid slots not yet held by an active child: only these can be assigned without buying. */
export function unusedPaidSlots(family: FamilyOverview): number {
  const active = family.children.filter((c) => c.status === 'active').length;
  return Math.max(0, family.paidSlots - active);
}

/**
 * The note for a child who could take a slot if the family had one free: a draft or an archived
 * child (WEBR4-01 widened the offer; the name is from when only drafts could be activated).
 *
 * HUNT7-G-8: the no-slot branch does not say "yet". That word asserted the family has never held a
 * paid slot, and `releaseSlotlessProfiles` (apps/api/src/services/billing-sync.ts) makes it false:
 * it sets `status = 'draft'` on a previously ACTIVE child whenever verified provider state releases
 * its slot (release_reason 'expired' or 'downgrade'), and `family_capacity.paid_slots` is then 0 for
 * a family that has been paying. So the sentence was wrong for exactly the lapsed population, once
 * per child, on the screen where they manage the children they were paying for. It is now
 * state-neutral, in the words HUNT6-H-4 settled on for the planner
 * (apps/web/src/pages/app/LearningPlannerPage.tsx) and HUNT7-G-8 for the portal's `noFreeSlotText`
 * (apps/web/src/pages/app/ChildrenPage.tsx).
 *
 * What it still does NOT do is promise capacity: it names where a slot comes from — this app's Plan
 * and child slots screen, the only place PencilLift sells one (WEB-R1-04) — and never says a slot is
 * waiting. "Choose or renew" covers a family that has never subscribed and one whose plan lapsed
 * without asserting which of the two is reading it, which is the whole point.
 */
function draftActivationNote(family: FamilyOverview, nickname: string): string {
  if (family.paidSlots === 0) {
    return `Your family has no paid child slots right now. To activate ${nickname}, choose or renew a plan under Plan and child slots.`;
  }
  const slots = family.paidSlots === 1 ? 'slot is' : 'slots are';
  return `All ${family.paidSlots} paid ${slots} in use. To activate ${nickname}, add a child slot under Plan and child slots.`;
}

export function childRows(family: FamilyOverview): ChildRow[] {
  const unused = unusedPaidSlots(family);
  return family.children.map((child) => {
    const draft = child.status === 'draft';
    return {
      id: child.id,
      nickname: child.nickname,
      detail: `${gradeText(child.gradeLevel)} · ages ${child.ageBand}`,
      statusText: childStatusText(child),
      canPair: child.status === 'active',
      pairingNote: draft
        ? `Pairing a device becomes available once ${child.nickname} has a paid slot.`
        : child.status === 'archived'
          ? 'Archived profiles can’t be paired.'
          : null,
      // WEBR4-01: an archived child can take a free slot too, the way the portal offers it. The
      // activate route clears archived_at for any profile that is not already active, and the archive
      // confirmation on this screen promises it. The screen still withholds the control while a
      // deletion request covers the child.
      canActivate: (draft || child.status === 'archived') && unused > 0,
      activationNote:
        (draft || child.status === 'archived') && unused === 0
          ? draftActivationNote(family, child.nickname)
          : null,
    };
  });
}

/**
 * What the archive button promises, for the child it is offered for (HUNT7-G-4; WEBR4-12's mobile
 * half). The label was unconditionally "…, frees the slot", and the row that carries it is rendered
 * for a DRAFT child too — a draft holds no slot, so archiving one frees nothing (`slotSummary` above
 * returns unchanged counts after it). The portal's card branched on the status from round 4
 * (apps/web/src/pages/app/ChildrenPage.tsx, ChildCard's archive button); the phone never got it,
 * although the confirmation body on the same screen already branched the same way.
 *
 * "Keeps history" holds for every status, which is why it is the part that never moves: POST
 * /v1/children/:childId/archive keeps every scan, point and reward (spec P11, AC_CAPACITY_08).
 */
export function childArchiveLabel(status: FamilyChild['status']): string {
  return status === 'active'
    ? 'Archive (keeps history, frees the slot)'
    : 'Archive (keeps history)';
}

/** The three fields the child edit form holds, as the form holds them. */
// HUNT7-G-4's rule now lives in packages/contracts/src/family.ts so the PORTAL form and the PHONE
// form share one branded definition instead of two that agree. Re-exported here so this module stays
// the phone's family-view surface; it is one definition, not a second one.
export {
  childEditBody,
  markEdited,
  NOTHING_EDITED,
  type ChildEditFields,
  type ChildEditTouched,
} from '@pencillift/contracts';

/**
 * What changed under the open child form since it was seeded, or null while nothing has (HUNT7-G-4,
 * the other half of the rule above). Once an untouched field is never sent, the form keeps showing
 * what the parent opened while the card above it shows the new value, and without this nothing on
 * screen says the two are about the same child (BUG-330). The portal renders the same sentence as a
 * `role="note"` notice (apps/web/src/pages/app/ChildrenPage.tsx, `drifted`).
 *
 * HUNT7-G-2: it says WHAT changed, never WHO changed it. `familyChildSchema` carries no actor field
 * and GET /v1/family selects no actor column (packages/contracts/src/family.ts,
 * apps/api/src/routes/family.ts), and the reader can be the cause themselves — the same parent
 * editing this child in the portal, or a save whose reload failed and then landed.
 */
export function childEditDriftNote(
  seed: Pick<FamilyChild, 'nickname' | 'gradeLevel' | 'ageBand'>,
  live: Pick<FamilyChild, 'nickname' | 'gradeLevel' | 'ageBand'>,
): string | null {
  const changed = [
    ...(live.nickname === seed.nickname ? [] : [`the nickname is now “${live.nickname}”`]),
    ...(live.gradeLevel === seed.gradeLevel
      ? []
      : [`the grade is now ${gradeText(live.gradeLevel)}`]),
    ...(live.ageBand === seed.ageBand ? [] : [`the age band is now ages ${live.ageBand}`]),
  ];
  if (changed.length === 0) return null;
  return `This profile changed somewhere else while this form was open: ${changed.join(
    ' and ',
  )}. The fields above still show what you opened. Saving sends only the fields you edit here, so that change stays unless you edit that field too.`;
}

/** Honest paid-slot explanation. Assigning an unused slot never buys anything. */
export function slotSummary(family: FamilyOverview): string {
  const active = family.children.filter((c) => c.status === 'active').length;
  const slots = `${family.paidSlots} paid child ${family.paidSlots === 1 ? 'slot' : 'slots'}`;
  return `${slots}, ${active} in use. New children start as free drafts; activating one assigns one of your unused paid slots, with no new purchase.`;
}

/** Confirmation after POST /v1/children/:id/activate succeeds. */
export function activationMessage(nickname: string, result: ChildActivationResponse): string {
  return `${nickname} is active and uses one of your paid slots (${result.assignedSlots} of ${result.paidSlots} in use). You can now pair a device.`;
}

/**
 * Activation failures in adult-readable copy. Branches on stable rule codes, never on message text.
 */
export function activationError(error: unknown): ParentActionError {
  if (error instanceof ApiRequestError && error.rule === CHILD_ACTIVATION_RULES.consentRequired) {
    return {
      message:
        'Parental consent comes first. Start consent on the parent home screen, then try again.',
      needsPin: false,
      noFamily: false,
    };
  }
  return parentActionError(error);
}

export interface DeviceRow {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly statusText: string;
  readonly canRevoke: boolean;
}

const PLATFORM_TEXT: Record<ChildDevice['platform'], string> = {
  ios: 'iPhone or iPad',
  android: 'Android',
  web: 'Web browser',
};

export function deviceRows(devices: readonly ChildDevice[], family: FamilyOverview): DeviceRow[] {
  const names = new Map(family.children.map((c) => [c.id, c.nickname]));
  return devices.map((d) => ({
    id: d.id,
    title: d.label,
    detail: `${names.get(d.childId) ?? 'A child'}’s device · ${PLATFORM_TEXT[d.platform]}`,
    statusText: d.revokedAt ? 'Disconnected' : 'Connected',
    canRevoke: d.revokedAt === null,
  }));
}

export interface ParentActionError {
  readonly message: string;
  /** True when the server wants a fresh parent PIN unlock first. */
  readonly needsPin: boolean;
  /** True when no family exists yet for this adult. */
  readonly noFamily: boolean;
}

/**
 * Maps any parent-screen failure to adult-readable copy. Branches on error codes, never on message
 * text: when loading the family (`context: 'load'`), NOT_FOUND can only mean "no family yet".
 */
export function parentActionError(
  error: unknown,
  context: 'load' | 'action' = 'action',
): ParentActionError {
  if (error instanceof ApiRequestError) {
    if (error.code === 'STEP_UP_REQUIRED') {
      return {
        message: 'Enter your parent PIN to continue. Unlock, then try again.',
        needsPin: true,
        noFamily: false,
      };
    }
    if (error.code === 'NOT_FOUND' && context === 'load') {
      return {
        message: 'Create your family in the parent portal first.',
        needsPin: false,
        noFamily: true,
      };
    }
    return { message: error.message, needsPin: false, noFamily: false };
  }
  return { message: 'Something went wrong. Please try again.', needsPin: false, noFamily: false };
}
