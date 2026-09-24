// Redemption workflow (spec P9): child requests -> points reserved atomically -> parent approves or
// declines -> parent marks fulfilled outside the app. Decline/cancel returns the reserve once.
import { err, ok, type Result } from '../shared/result.ts';
import { isValidId, releaseKey, reserveKey } from './ids.ts';
import type { LedgerEntry, RewardsPrincipal } from './ledger.ts';

export const REDEMPTION_STATES = [
  'pending',
  'approved',
  'fulfilled',
  'declined',
  'cancelled',
] as const;
export type RedemptionState = (typeof REDEMPTION_STATES)[number];

export const REDEMPTION_ACTIONS = ['approve', 'decline', 'fulfill', 'cancel'] as const;
export type RedemptionAction = (typeof REDEMPTION_ACTIONS)[number];

/** The parent-defined reward being requested (see `validateRewardDefinition`). */
export interface RewardOffer {
  readonly id: string;
  readonly pointCost: number;
  readonly active: boolean;
}

/**
 * A redemption request. Fulfillment is a parent-recorded fact about something given outside the
 * app (cash, a book, an outing); no payment, purchase or transfer is modeled or triggered.
 */
export interface RedemptionRequest {
  readonly requestId: string;
  readonly childId: string;
  readonly rewardId: string;
  /** Cost captured at request time; later edits to the reward do not change it. */
  readonly pointCost: number;
  readonly state: RedemptionState;
  readonly requestedBy: RewardsPrincipal;
}

export interface RedemptionOutcome {
  readonly request: RedemptionRequest;
  /** Ledger entries to append in the same transaction as the request row change. */
  readonly entries: readonly LedgerEntry[];
}

/** Decision: a reward may cost at most 100,000 points (sane cap on parent-entered values). */
export const MAX_REWARD_POINT_COST = 100_000;

export const REQUEST_REDEMPTION_ERROR_CODES = [
  'INVALID_PRINCIPAL',
  'STEP_UP_REQUIRED',
  'INVALID_REQUEST',
  'INVALID_POINT_COST',
  'REWARD_INACTIVE',
  'INSUFFICIENT_POINTS',
] as const;
export type RequestRedemptionErrorCode = (typeof REQUEST_REDEMPTION_ERROR_CODES)[number];

export interface RequestRedemptionInput {
  /** Derived from verified claims, never from a request body. */
  readonly principal: RewardsPrincipal;
  /**
   * True only when the server verified a recent PIN/biometric step-up for this session. Required
   * (and must be exactly `true`) when the principal is a parent; ignored for a child.
   */
  readonly recentAdultUnlock?: boolean;
  readonly childId: string;
  /** Client-generated id; its reserve key is unique, so a retried request cannot reserve twice. */
  readonly requestId: string;
  readonly reward: RewardOffer;
  /** Balance read inside the same transaction, with the child's ledger locked. */
  readonly currentBalance: number;
}

export function isValidPointCost(pointCost: unknown): pointCost is number {
  return (
    typeof pointCost === 'number' &&
    Number.isInteger(pointCost) &&
    pointCost >= 1 &&
    pointCost <= MAX_REWARD_POINT_COST
  );
}

function assertBalance(currentBalance: number): void {
  if (!Number.isSafeInteger(currentBalance)) {
    throw new RangeError('currentBalance must be a safe integer read from the ledger');
  }
}

/**
 * Creates a pending request and the reserve that debits its cost.
 *
 * Two devices cannot spend the same points: the API runs this with the child's ledger locked, so a
 * second request sees the reduced balance and gets INSUFFICIENT_POINTS; `appendToLedger` (and the
 * database balance check it specifies) rejects any write that would still go negative.
 *
 * Decision: a parent may also request on the child's behalf, but only with a recent adult unlock,
 * because reserving spends the child's points and P3 requires server-side recent reauthentication
 * for rewards actions (review finding RV-rewards-4). Approval, decline, fulfillment, cancellation and
 * adjustment by a parent require the same step-up. Authorization is checked before anything else.
 */
export function requestRedemption(
  input: RequestRedemptionInput,
): Result<RedemptionOutcome, RequestRedemptionErrorCode> {
  const { principal, childId, requestId, reward, currentBalance } = input;
  if (principal !== 'child' && principal !== 'parent') {
    return err('INVALID_PRINCIPAL', 'Only a verified child or parent can request a reward');
  }
  if (principal === 'parent' && input.recentAdultUnlock !== true) {
    return err('STEP_UP_REQUIRED', 'Unlock the adult area to request a reward for your child');
  }
  if (!isValidId(childId) || !isValidId(requestId) || !isValidId(reward.id)) {
    return err('INVALID_REQUEST', 'Child, request and reward ids must be valid identifiers');
  }
  if (!isValidPointCost(reward.pointCost)) {
    return err(
      'INVALID_POINT_COST',
      `A reward must cost an integer from 1 to ${MAX_REWARD_POINT_COST} points`,
    );
  }
  if (reward.active !== true) return err('REWARD_INACTIVE', 'This reward is not available');
  assertBalance(currentBalance);
  if (currentBalance < reward.pointCost) {
    return err('INSUFFICIENT_POINTS', 'Not enough points for this reward', {
      balance: currentBalance,
      pointCost: reward.pointCost,
    });
  }
  const request: RedemptionRequest = {
    requestId,
    childId,
    rewardId: reward.id,
    pointCost: reward.pointCost,
    state: 'pending',
    requestedBy: principal,
  };
  const reserve: LedgerEntry = {
    idempotencyKey: reserveKey(requestId),
    childId,
    kind: 'redemption_reserve',
    points: -reward.pointCost,
    requestId,
    actor: principal,
  };
  return ok({ request, entries: [reserve] });
}

export const TRANSITION_ERROR_CODES = [
  'PARENT_ONLY',
  'STEP_UP_REQUIRED',
  'NOT_OWN_REQUEST',
  'INVALID_TRANSITION',
] as const;
export type TransitionErrorCode = (typeof TRANSITION_ERROR_CODES)[number];

export interface TransitionContext {
  /** Derived from verified claims. Anything other than 'parent'/'child' is refused. */
  readonly principal: RewardsPrincipal;
  /** True only when the server verified a recent PIN/biometric step-up for this session. */
  readonly recentAdultUnlock: boolean;
  /** The child id from the child session's verified claims; required for a child cancel. */
  readonly actorChildId?: string;
}

function assertRequest(request: RedemptionRequest): void {
  if (
    !isValidId(request.requestId) ||
    !isValidId(request.childId) ||
    !isValidPointCost(request.pointCost) ||
    !(REDEMPTION_STATES as readonly string[]).includes(request.state)
  ) {
    throw new RangeError('Redemption request is malformed');
  }
}

function moveTo(
  request: RedemptionRequest,
  state: RedemptionState,
  releaseBy?: RewardsPrincipal,
): Result<RedemptionOutcome, TransitionErrorCode> {
  const next: RedemptionRequest = { ...request, state };
  if (releaseBy === undefined) return ok({ request: next, entries: [] });
  const release: LedgerEntry = {
    idempotencyKey: releaseKey(request.requestId),
    childId: request.childId,
    kind: 'redemption_release',
    points: request.pointCost,
    requestId: request.requestId,
    actor: releaseBy,
  };
  return ok({ request: next, entries: [release] });
}

function unchanged(request: RedemptionRequest): Result<RedemptionOutcome, TransitionErrorCode> {
  return ok({ request, entries: [] });
}

function invalid(
  request: RedemptionRequest,
  action: string,
): Result<RedemptionOutcome, TransitionErrorCode> {
  return err('INVALID_TRANSITION', `Cannot ${action} a ${request.state} request`, {
    state: request.state,
  });
}

/**
 * Applies a parent or child action to a request (run with the request row locked).
 *
 * - approve / decline / fulfill: parent with a recent adult unlock only.
 * - cancel: the requesting child while pending; a parent (with unlock) while pending or approved.
 * - decline or cancel releases the reserved points exactly once; fulfilled never releases.
 * - Repeating an already-applied action (duplicate callback, double tap) is a no-op with no
 *   entries. Authorization is checked first, so a replay never bypasses it.
 *
 * Decision: fulfill requires an approved request (no pending -> fulfilled shortcut), a parent
 * cancel also needs the step-up, a child cancelling an approved request gets PARENT_ONLY, and a
 * stale `approve` arriving after fulfillment is a no-op because approval was already applied.
 */
export function transitionRedemption(
  request: RedemptionRequest,
  action: RedemptionAction,
  context: TransitionContext,
): Result<RedemptionOutcome, TransitionErrorCode> {
  assertRequest(request);
  if (!(REDEMPTION_ACTIONS as readonly string[]).includes(action)) {
    return err('INVALID_TRANSITION', 'Unknown redemption action');
  }
  const { principal } = context;

  if (principal === 'child' && action === 'cancel') {
    if (context.actorChildId === undefined || context.actorChildId !== request.childId) {
      return err('NOT_OWN_REQUEST', 'A child can cancel only their own request');
    }
    switch (request.state) {
      case 'pending':
        return moveTo(request, 'cancelled', 'child');
      case 'cancelled':
        return unchanged(request);
      case 'approved':
        return err('PARENT_ONLY', 'Only a parent can cancel an approved request');
      case 'fulfilled':
      case 'declined':
        return invalid(request, action);
    }
  }

  if (principal !== 'parent') {
    return err('PARENT_ONLY', 'Only a parent can approve, decline or fulfill a reward');
  }
  if (context.recentAdultUnlock !== true) {
    return err('STEP_UP_REQUIRED', 'Unlock the adult area to manage rewards');
  }

  switch (action) {
    case 'approve':
      if (request.state === 'pending') return moveTo(request, 'approved');
      if (request.state === 'approved' || request.state === 'fulfilled') {
        return unchanged(request);
      }
      return invalid(request, action);
    case 'fulfill':
      if (request.state === 'approved') return moveTo(request, 'fulfilled');
      if (request.state === 'fulfilled') return unchanged(request);
      return invalid(request, action);
    case 'decline':
    case 'cancel': {
      const target: RedemptionState = action === 'decline' ? 'declined' : 'cancelled';
      if (request.state === 'pending' || request.state === 'approved') {
        return moveTo(request, target, 'parent');
      }
      if (request.state === target) return unchanged(request);
      return invalid(request, action);
    }
  }
}
