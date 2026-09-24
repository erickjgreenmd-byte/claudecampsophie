import { DEFAULT_MAX_PAID_SLOTS, monthlyPriceCents } from '../pricing/index.ts';
import type { Cents } from '../shared/money.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { ChildProfileState, Principal } from './slots.ts';
import { assertValidInstant } from './status.ts';

export const DOWNGRADE_ERROR_CODES = [
  'CHILD_MODE_FORBIDDEN',
  'STEP_UP_REQUIRED',
  'INVALID_TARGET_SLOTS',
  'NOT_A_DOWNGRADE',
  'KEEP_NOT_ACTIVE',
  'TOO_MANY_KEPT',
] as const;
export type DowngradeErrorCode = (typeof DOWNGRADE_ERROR_CODES)[number];

export interface DowngradeInput {
  /** Verified paid capacity from the entitlement ledger. */
  readonly currentSlots: number;
  readonly targetSlots: number;
  readonly activeChildIds: readonly string[];
  /** Profiles the parent chose to keep active after the change. */
  readonly keepChildIds: readonly string[];
  /** Effective date confirmed by the store/provider (e.g. next renewal), never computed locally. */
  readonly providerEffectiveAt: Date;
  readonly principal: Principal;
  readonly recentAdultUnlock: boolean;
  readonly maxSlots?: number;
}

export interface ScheduledDowngrade {
  readonly fromSlots: number;
  readonly targetSlots: number;
  readonly effectiveAt: Date;
  readonly keepChildIds: readonly string[];
  readonly deactivateChildIds: readonly string[];
  /** Approved regular recurring price after the change (the store's renewal amount prevails). */
  readonly newRecurringCents: Cents;
}

/**
 * Validates a parent's downgrade selection and schedules it for the provider-confirmed date. Paid
 * access for every current profile continues until then (spec P11, AC_CAPACITY_08).
 */
export function planDowngrade(
  input: DowngradeInput,
): Result<ScheduledDowngrade, DowngradeErrorCode> {
  const maxSlots = input.maxSlots ?? DEFAULT_MAX_PAID_SLOTS;
  if (!Number.isSafeInteger(maxSlots) || maxSlots < 1) {
    throw new RangeError(`maxSlots must be a positive integer, received ${maxSlots}`);
  }
  if (!Number.isSafeInteger(input.currentSlots) || input.currentSlots < 0) {
    throw new RangeError(
      `currentSlots must be a non-negative integer, received ${input.currentSlots}`,
    );
  }
  assertValidInstant(input.providerEffectiveAt, 'providerEffectiveAt');

  if (input.principal !== 'parent') {
    return err('CHILD_MODE_FORBIDDEN', 'Subscriptions cannot be changed from child mode');
  }
  if (input.recentAdultUnlock !== true) {
    return err('STEP_UP_REQUIRED', 'Changing paid capacity requires a recent adult unlock');
  }
  const { targetSlots } = input;
  // Decision: 0 is not a downgrade tier; ending the subscription is a store cancellation.
  if (!Number.isInteger(targetSlots) || targetSlots < 1 || targetSlots > maxSlots) {
    return err(
      'INVALID_TARGET_SLOTS',
      `Target paid slots must be an integer from 1 to ${maxSlots}`,
      {
        targetSlots,
      },
    );
  }
  if (targetSlots >= input.currentSlots) {
    return err('NOT_A_DOWNGRADE', 'Target paid slots must be lower than current paid slots', {
      currentSlots: input.currentSlots,
      targetSlots,
    });
  }
  const active = unique(input.activeChildIds);
  const activeSet = new Set(active);
  const keep = unique(input.keepChildIds);
  const notActive = keep.filter((id) => !activeSet.has(id));
  if (notActive.length > 0) {
    return err('KEEP_NOT_ACTIVE', 'Only currently active profiles can be kept active', {
      childIds: notActive,
    });
  }
  if (keep.length > targetSlots) {
    return err('TOO_MANY_KEPT', `The new plan keeps at most ${targetSlots} profiles active`, {
      targetSlots,
      kept: keep.length,
    });
  }
  const keepSet = new Set(keep);
  return ok({
    fromSlots: input.currentSlots,
    targetSlots,
    effectiveAt: new Date(input.providerEffectiveAt.getTime()),
    keepChildIds: keep,
    deactivateChildIds: active.filter((id) => !keepSet.has(id)),
    newRecurringCents: monthlyPriceCents(targetSlots, maxSlots),
  });
}

export interface DowngradeState {
  readonly scheduled: ScheduledDowngrade;
  readonly children: readonly ChildProfileState[];
}

/** What happens to a profile deactivated by a downgrade: nothing is deleted. */
export interface DowngradeRetention {
  readonly history: 'retained';
  readonly exports: 'retained';
  readonly rewardRecords: 'retained';
  readonly paidAi: 'stopped';
}

export interface DowngradeApplication {
  readonly applied: boolean;
  /** Capacity the profile selection is sized for (the ledger stays the source of truth). */
  readonly paidSlots: number;
  readonly children: readonly ChildProfileState[];
  readonly deactivatedChildIds: readonly string[];
  /** Retention guarantees for deactivated profiles; null until the downgrade applies. */
  readonly retention: DowngradeRetention | null;
}

const RETENTION: DowngradeRetention = {
  history: 'retained',
  exports: 'retained',
  rewardRecords: 'retained',
  paidAi: 'stopped',
};

/**
 * Applies a scheduled downgrade once `now` reaches the provider-confirmed effective date. Before it,
 * nothing changes. At or after it, every active profile not selected to keep becomes
 * `inactive_history_retained`; no profile is removed and other statuses are untouched. Idempotent.
 */
export function applyDowngradeIfDue(state: DowngradeState, now: Date): DowngradeApplication {
  assertValidInstant(now, 'now');
  const { scheduled } = state;
  assertValidInstant(scheduled.effectiveAt, 'effectiveAt');
  if (now.getTime() < scheduled.effectiveAt.getTime()) {
    return {
      applied: false,
      paidSlots: scheduled.fromSlots,
      children: state.children,
      deactivatedChildIds: [],
      retention: null,
    };
  }
  const keep = new Set(scheduled.keepChildIds);
  const deactivated: string[] = [];
  const children = state.children.map((child): ChildProfileState => {
    if (child.status !== 'active' || keep.has(child.id)) return child;
    deactivated.push(child.id);
    return { id: child.id, status: 'inactive_history_retained' };
  });
  return {
    applied: true,
    paidSlots: scheduled.targetSlots,
    children,
    deactivatedChildIds: deactivated,
    retention: RETENTION,
  };
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}
