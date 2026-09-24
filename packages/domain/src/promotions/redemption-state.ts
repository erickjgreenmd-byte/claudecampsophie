import { err, ok, type Result } from '../shared/result.ts';

/**
 * Durable provider-operation state machine for one redemption (spec P17, docs/Architecture.md §6,
 * mirrored by the `promo_redemptions_transition` trigger in 0300_promotions_schools.sql):
 *
 *   reserved --submit_to_provider--> provider_pending --provider_confirmed/reconcile_applied--> confirmed
 *   reserved --reservation_timeout--> expired            provider_pending --provider_rejected/reconcile_not_applied--> rejected
 *   confirmed --period_completed--> reconciled
 *
 * `provider_pending` can never time out: an ambiguous in-flight provider call keeps its reservation
 * until reconciliation decides whether the benefit was applied. Callers must record
 * `submit_to_provider` BEFORE calling the provider, so an unsubmitted reservation is the only kind
 * that may expire.
 */
export const REDEMPTION_STATES = [
  'reserved',
  'provider_pending',
  'confirmed',
  'rejected',
  'expired',
  'reconciled',
] as const;
export type RedemptionState = (typeof REDEMPTION_STATES)[number];

export const REDEMPTION_EVENTS = [
  'submit_to_provider',
  'provider_confirmed',
  'provider_rejected',
  'reservation_timeout',
  'reconcile_applied',
  'reconcile_not_applied',
  'period_completed',
] as const;
export type RedemptionEvent = (typeof REDEMPTION_EVENTS)[number];

export const REDEMPTION_TRANSITION_ERROR_CODES = ['INVALID_TRANSITION'] as const;
export type RedemptionTransitionErrorCode = (typeof REDEMPTION_TRANSITION_ERROR_CODES)[number];

/** States that hold a cap slot, budget and the family/period uniqueness. */
export const LIVE_REDEMPTION_STATES = [
  'reserved',
  'provider_pending',
  'confirmed',
  'reconciled',
] as const satisfies readonly RedemptionState[];

const TRANSITIONS: Readonly<
  Record<RedemptionState, Partial<Readonly<Record<RedemptionEvent, RedemptionState>>>>
> = {
  reserved: { submit_to_provider: 'provider_pending', reservation_timeout: 'expired' },
  provider_pending: {
    provider_confirmed: 'confirmed',
    provider_rejected: 'rejected',
    reconcile_applied: 'confirmed',
    reconcile_not_applied: 'rejected',
  },
  confirmed: { period_completed: 'reconciled' },
  rejected: {},
  expired: {},
  reconciled: {},
};

function targetOf(state: RedemptionState, event: RedemptionEvent): RedemptionState | undefined {
  return Object.hasOwn(TRANSITIONS, state) ? TRANSITIONS[state][event] : undefined;
}

export function transitionRedemption(
  state: RedemptionState,
  event: RedemptionEvent,
): Result<RedemptionState, RedemptionTransitionErrorCode> {
  const next = targetOf(state, event);
  if (next === undefined) {
    return err('INVALID_TRANSITION', `Cannot apply ${event} to a ${state} redemption`, {
      from: state,
      event,
    });
  }
  return ok(next);
}

/**
 * Whether the state counts against caps, budget and uniqueness. Decision: an unknown state (data
 * outside this vocabulary) counts as live, so corrupt rows can only make limits stricter.
 */
export function isLiveState(state: RedemptionState): boolean {
  return state !== 'rejected' && state !== 'expired';
}

/** States an event would have produced (or already passed through) had it been applied before. */
const ALREADY_APPLIED: Readonly<Record<RedemptionEvent, readonly RedemptionState[]>> = {
  submit_to_provider: ['provider_pending'],
  provider_confirmed: ['confirmed', 'reconciled'],
  reconcile_applied: ['confirmed', 'reconciled'],
  provider_rejected: ['rejected'],
  reconcile_not_applied: ['rejected'],
  reservation_timeout: ['expired'],
  period_completed: ['reconciled'],
};

/**
 * A redelivered webhook/job event whose outcome is already recorded (acknowledge, change nothing).
 * Conflicting outcomes (e.g. a rejection for a confirmed redemption, or a confirmation for a
 * reservation that expired unsubmitted) are NOT duplicates and need reconciliation.
 */
export function isDuplicateDelivery(state: RedemptionState, event: RedemptionEvent): boolean {
  return Object.hasOwn(ALREADY_APPLIED, event) && ALREADY_APPLIED[event].includes(state);
}
