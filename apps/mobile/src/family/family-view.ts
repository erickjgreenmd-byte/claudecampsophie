import {
  CHILD_ACTIVATION_RULES,
  type ChildActivationResponse,
  type ChildDevice,
  type FamilyChild,
  type FamilyOverview,
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

export function childStatusText(status: FamilyChild['status']): string {
  switch (status) {
    case 'draft':
      return 'Draft: not active yet, no charge';
    case 'active':
      return 'Active: uses a paid slot';
    case 'archived':
      return 'Archived: history only';
  }
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
export function childPickerSuffix(
  child: Pick<FamilyChild, 'status'> & { readonly deletionPending?: boolean | undefined },
): string {
  if (child.deletionPending === true) return ' (data deletion under way)';
  if (child.status === 'archived') return ' (archived — plan is read-only)';
  if (child.status === 'draft') return ' (no paid slot)';
  return '';
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
 */
function draftActivationNote(family: FamilyOverview, nickname: string): string {
  if (family.paidSlots === 0) {
    return `Your family has no paid child slots yet. To activate ${nickname}, choose a plan under Plan and child slots.`;
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
      statusText: childStatusText(child.status),
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
