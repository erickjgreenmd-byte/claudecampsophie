import { DEFAULT_MAX_PAID_SLOTS, monthlyPriceCents } from '../pricing/index.ts';
import type { BillingChannel } from '../shared/billing.ts';
import type { Cents } from '../shared/money.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { FamilyCapacity } from './ledger.ts';

/**
 * Who is acting, as derived by the server from verified claims (never from a request body).
 * Owner admins and jobs never plan purchases on a family's behalf.
 */
export type Principal = 'parent' | 'child';

/**
 * Child profile lifecycle for slot purposes. `draft`/`active`/`archived` match `child_profiles`;
 * `inactive_history_retained` is a profile deactivated by a downgrade (history, exports and rewards
 * kept); `tombstoned` is a profile marked for deletion (spec E4) and can never be activated.
 */
export type ChildProfileStatus =
  'draft' | 'active' | 'archived' | 'inactive_history_retained' | 'tombstoned';

export interface ChildProfileState {
  readonly id: string;
  readonly status: ChildProfileStatus;
}

export const CHILD_ACTIVATION_ERROR_CODES = [
  'CHILD_MODE_FORBIDDEN',
  'STEP_UP_REQUIRED',
  'ALREADY_ACTIVE',
  'CHILD_NOT_DRAFT',
  'MAX_TIER_REACHED',
] as const;
export type ChildActivationErrorCode = (typeof CHILD_ACTIVATION_ERROR_CODES)[number];

export interface ChildActivationInput {
  /** Verified paid capacity from the entitlement ledger (`FamilyCapacity.paidSlots`). */
  readonly paidSlots: number;
  /** Children currently holding a paid slot. */
  readonly activeChildIds: readonly string[];
  readonly child: ChildProfileState;
  readonly principal: Principal;
  /** Server-verified recent PIN/biometric step-up bound to this session (never client-asserted). */
  readonly recentAdultUnlock: boolean;
  readonly maxSlots?: number;
}

export type ChildActivationPlan =
  | { readonly action: 'assign_existing_slot'; readonly childId: string }
  | {
      readonly action: 'purchase_required';
      readonly childId: string;
      readonly targetSlots: number;
      /** Approved regular recurring price today (0 with no subscription). */
      readonly currentRecurringCents: Cents;
      /** Approved regular recurring price after the upgrade. */
      readonly newRecurringCents: Cents;
      /** Due-now and proration are shown only as supplied by the store/provider, never computed. */
      readonly dueNow: 'provider_supplied';
      /** The child becomes active only after the server verifies the purchase with the provider. */
      readonly activation: 'after_server_verified_purchase';
    };

/**
 * Decision: `archived` and `inactive_history_retained` profiles are reactivated under exactly the
 * same rule as drafts (slot or purchase, parent step-up); `tombstoned` and unknown statuses fail.
 */
const ACTIVATABLE: ReadonlySet<string> = new Set([
  'draft',
  'archived',
  'inactive_history_retained',
]);

/**
 * Plans giving a child a paid slot (spec P11). Creating a draft never charges; an unused paid slot
 * is assigned without a purchase; otherwise the parent is sent to the store for the next tier.
 */
export function planChildActivation(
  input: ChildActivationInput,
): Result<ChildActivationPlan, ChildActivationErrorCode> {
  const maxSlots = input.maxSlots ?? DEFAULT_MAX_PAID_SLOTS;
  assertPositiveInteger(maxSlots, 'maxSlots');
  assertNonNegativeInteger(input.paidSlots, 'paidSlots');

  // Any principal other than a verified parent is treated as child mode (fail closed).
  if (input.principal !== 'parent') {
    return err('CHILD_MODE_FORBIDDEN', 'Profiles and purchases cannot be changed from child mode');
  }
  if (input.recentAdultUnlock !== true) {
    return err('STEP_UP_REQUIRED', 'Adding a child requires a recent adult unlock');
  }
  const active = new Set(input.activeChildIds);
  const childId = input.child.id;
  if (input.child.status === 'active' || active.has(childId)) {
    return err('ALREADY_ACTIVE', 'Child already holds a paid slot', { childId });
  }
  if (!ACTIVATABLE.has(input.child.status)) {
    return err('CHILD_NOT_DRAFT', 'Only draft or archived profiles can be activated', {
      childId,
      status: input.child.status,
    });
  }
  if (active.size < input.paidSlots) {
    return ok({ action: 'assign_existing_slot', childId });
  }
  // Decision: the purchase must cover every child already holding a slot plus this one. With no
  // subscription (paidSlots 0) that is activeChildIds + 1; if that exceeds the max tier we refuse
  // rather than clamp, because a clamped tier would not actually activate the child.
  const targetSlots = Math.max(input.paidSlots, active.size) + 1;
  if (targetSlots > maxSlots) {
    return err('MAX_TIER_REACHED', `The largest plan covers ${maxSlots} children`, {
      maxSlots,
      paidSlots: input.paidSlots,
      activeChildren: active.size,
    });
  }
  return ok({
    action: 'purchase_required',
    childId,
    targetSlots,
    currentRecurringCents: input.paidSlots === 0 ? 0 : monthlyPriceCents(input.paidSlots, maxSlots),
    newRecurringCents: monthlyPriceCents(targetSlots, maxSlots),
    dueNow: 'provider_supplied',
    activation: 'after_server_verified_purchase',
  });
}

export const CLIENT_PURCHASE_RESULTS = [
  'success',
  'pending',
  'ask_to_buy_pending',
  'cancelled',
  'failed',
] as const;
export type ClientPurchaseResult = (typeof CLIENT_PURCHASE_RESULTS)[number];

export interface ClientPurchaseEvaluation {
  /** Always false: only a server-verified provider snapshot changes paid capacity. */
  readonly grantsCapacity: false;
  readonly next: 'await_server_verification' | 'show_pending' | 'no_change';
}

/**
 * What the app does with a purchase result reported by the device SDK. The client result is a hint
 * for UX only; capacity changes solely through {@link reconcileEntitlements}.
 */
export function evaluateClientPurchaseResult(
  result: ClientPurchaseResult,
): ClientPurchaseEvaluation {
  switch (result) {
    case 'success':
      return { grantsCapacity: false, next: 'await_server_verification' };
    case 'pending':
    case 'ask_to_buy_pending':
      return { grantsCapacity: false, next: 'show_pending' };
    case 'cancelled':
    case 'failed':
      return { grantsCapacity: false, next: 'no_change' };
    default:
      // Unknown/forged values from the client change nothing.
      return { grantsCapacity: false, next: 'no_change' };
  }
}

export interface ProfileRemovalDescription {
  readonly changesSubscription: false;
  readonly renewalChange: 'none';
  /** Present when the caller supplies current capacity: removal leaves it unchanged. */
  readonly paidSlotsAfterRemoval?: number;
  readonly recurringCentsAfterRemoval?: Cents;
  /** Where the parent must go to actually change the subscription. */
  readonly manageSubscriptionIn?: BillingChannel | null;
}

/**
 * The truthful billing effect of removing or archiving a profile: none. The store subscription,
 * paid slot count and renewal charge are unchanged (the slot becomes unused); lowering them requires
 * a store downgrade (AC_CAPACITY_09).
 */
export function describeProfileRemoval(
  current?: Pick<FamilyCapacity, 'paidSlots' | 'managingChannel'>,
): ProfileRemovalDescription {
  if (current === undefined) return { changesSubscription: false, renewalChange: 'none' };
  assertNonNegativeInteger(current.paidSlots, 'paidSlots');
  return {
    changesSubscription: false,
    renewalChange: 'none',
    paidSlotsAfterRemoval: current.paidSlots,
    recurringCentsAfterRemoval:
      current.paidSlots === 0
        ? 0
        : monthlyPriceCents(current.paidSlots, Math.max(DEFAULT_MAX_PAID_SLOTS, current.paidSlots)),
    manageSubscriptionIn: current.managingChannel,
  };
}

export interface PaidAiCheck {
  readonly childStatus: ChildProfileStatus;
  readonly capacity: Pick<FamilyCapacity, 'paidSlots'>;
  /** Children holding paid slots, in slot-assignment order (oldest assignment first). */
  readonly assignedChildIds: readonly string[];
  readonly childId: string;
}

/**
 * Whether a child may use paid AI: active, assigned to a paid slot, and the family has verified paid
 * capacity. Decision: if more children are assigned than there are paid slots (e.g. capacity was
 * lost before profiles were reselected), only the first `paidSlots` assignments qualify, so the
 * number of children with paid AI can never exceed paid capacity.
 */
export function childHasPaidAi(check: PaidAiCheck): boolean {
  if (check.childStatus !== 'active') return false;
  const paidSlots = check.capacity.paidSlots;
  if (!Number.isInteger(paidSlots) || paidSlots <= 0) return false;
  const position = [...new Set(check.assignedChildIds)].indexOf(check.childId);
  return position !== -1 && position < paidSlots;
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer, received ${value}`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer, received ${value}`);
  }
}
