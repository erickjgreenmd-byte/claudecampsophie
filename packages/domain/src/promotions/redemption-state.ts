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

/**
 * Both keys are checked as OWN properties: states and events are mapped from untrusted
 * provider/webhook/job payloads, and a plain-object lookup would otherwise resolve names such as
 * `constructor` or `__proto__` through Object.prototype and report a "successful" transition.
 */
function targetOf(state: RedemptionState, event: RedemptionEvent): RedemptionState | undefined {
  if (!Object.hasOwn(TRANSITIONS, state)) return undefined;
  const row = TRANSITIONS[state];
  return Object.hasOwn(row, event) ? row[event] : undefined;
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

/** `state` and every state reachable from it through TRANSITIONS. */
function selfAndDescendants(state: RedemptionState): Set<RedemptionState> {
  const seen = new Set<RedemptionState>([state]);
  const queue: RedemptionState[] = [state];
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    for (const next of Object.values(TRANSITIONS[current])) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * States an event would have produced (or already passed through) had it been applied before:
 * the event's target state plus everything downstream of it. Derived from TRANSITIONS rather than
 * hand-listed, so a redelivered event is recognized in every later state (e.g. a retried
 * `submit_to_provider` after the provider already confirmed or rejected) and the two tables cannot
 * drift apart. A Map keeps untrusted event names away from Object.prototype.
 */
const ALREADY_APPLIED: ReadonlyMap<RedemptionEvent, ReadonlySet<RedemptionState>> = new Map(
  REDEMPTION_EVENTS.map((event) => {
    const states = new Set<RedemptionState>();
    for (const from of REDEMPTION_STATES) {
      const target = TRANSITIONS[from][event];
      if (target !== undefined) for (const s of selfAndDescendants(target)) states.add(s);
    }
    return [event, states] as const;
  }),
);

/**
 * A redelivered webhook/job event whose outcome is already recorded (acknowledge, change nothing).
 * Conflicting outcomes (e.g. a rejection for a confirmed redemption, or a confirmation for a
 * reservation that expired unsubmitted) are NOT duplicates and need reconciliation.
 */
export function isDuplicateDelivery(state: RedemptionState, event: RedemptionEvent): boolean {
  return ALREADY_APPLIED.get(event)?.has(state) ?? false;
}
