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
   * A draft can take one of the family's unused paid slots without a new purchase (spec P11,
   * AC_CAPACITY_03) via POST /v1/children/:id/activate. The server re-checks everything.
   */
  readonly canActivate: boolean;
  /** Why a draft can't be activated here (no unused slot), shown instead of a dead button. */
  readonly activationNote: string | null;
}

/** Paid slots not yet held by an active child: only these can be assigned without buying. */
export function unusedPaidSlots(family: FamilyOverview): number {
  const active = family.children.filter((c) => c.status === 'active').length;
  return Math.max(0, family.paidSlots - active);
}

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
      canActivate: draft && unused > 0,
      activationNote: draft && unused === 0 ? draftActivationNote(family, child.nickname) : null,
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
