import { cryptoRandom, type RandomSource } from '../shared/random.ts';
import { err, ok, type Result } from '../shared/result.ts';
import {
  freshId,
  isNonEmptyString,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
} from './ids.ts';
import { isAiStage, type AiStage } from './stages.ts';

/** Proposed alert thresholds (spec F4) as percentages of an explicitly chosen budget. */
export const DEFAULT_ALERT_THRESHOLDS_PERCENT: readonly number[] = Object.freeze([50, 80, 100]);

export const SPEND_ERROR_CODES = [
  'BUDGET_NOT_CONFIGURED',
  'INVALID_SPEND_INPUT',
  'IDEMPOTENCY_KEY_CONFLICT',
  'RESERVATION_NOT_FOUND',
  'INVALID_TRANSITION',
] as const;
export type SpendErrorCode = (typeof SPEND_ERROR_CODES)[number];

export interface SpendCheckInput {
  /**
   * The owner's explicitly chosen budget for this scope/period in micro-USD. `null` (not
   * configured) is refused: no default budget is ever invented (spec F4).
   */
  readonly budgetMicros: number | null;
  /** Settled billed spend, including failed attempts that were billed. */
  readonly committedMicros: number;
  /** Upper-bound holds for requests already in flight (AC_SECURITY_06). */
  readonly inFlightReservedMicros: number;
  /** Upper-bound estimate for the request being decided (0 for a pure status check). */
  readonly requestEstimateMicros: number;
  readonly alertThresholdsPercent?: readonly number[];
  /** Thresholds already alerted for this budget period. */
  readonly alreadyAlerted: readonly number[];
}

export interface SpendEvaluation {
  readonly allowed: boolean;
  /** committed + in-flight + this request. */
  readonly projectedMicros: number;
  readonly budgetMicros: number;
  /**
   * Thresholds not already alerted, ascending, that the spend this evaluation leaves counted has
   * reached: `projectedMicros` when allowed, committed + in-flight only when denied (plus the
   * 100% ceiling alert on any denial).
   */
  readonly newlyCrossedThresholds: readonly number[];
}

/** The threshold that means "the cap is reached and blocking work". */
const CEILING_THRESHOLD_PERCENT = 100;

/**
 * Application-enforced spend ceiling (spec F4: enforce caps in the application because provider
 * alerts may lag). Denies when committed + in-flight + request > budget; reaching it exactly is
 * allowed.
 *
 * Alerts are evaluated against the spend that is actually counted after this decision:
 * - allowed: committed + in-flight + this request (the request becomes an in-flight hold);
 * - denied: committed + in-flight only, because a denied request is neither spent nor held.
 *
 * Decision: a denial additionally raises the 100% ceiling alert (if configured and not already
 * sent) although counted spend stays below the budget, so the owner hears about the cap as soon as
 * it starts blocking work. No other threshold is raised by a denied estimate (RV-quotas-2): a
 * one-off oversized request at 10% spend must not use up the one-time 50%/80% alerts, which would
 * then stay silent when real spend reaches them.
 */
export function evaluateSpend(input: SpendCheckInput): Result<SpendEvaluation, SpendErrorCode> {
  const { budgetMicros, committedMicros, inFlightReservedMicros, requestEstimateMicros } = input;
  if (budgetMicros === null || !isPositiveSafeInteger(budgetMicros)) {
    return err(
      'BUDGET_NOT_CONFIGURED',
      'An explicit positive spend budget must be configured by the owner',
    );
  }
  const thresholds = input.alertThresholdsPercent ?? DEFAULT_ALERT_THRESHOLDS_PERCENT;
  if (
    !isNonNegativeSafeInteger(committedMicros) ||
    !isNonNegativeSafeInteger(inFlightReservedMicros) ||
    !isNonNegativeSafeInteger(requestEstimateMicros) ||
    !Array.isArray(thresholds) ||
    !thresholds.every(isPositiveSafeInteger) ||
    !Array.isArray(input.alreadyAlerted) ||
    !input.alreadyAlerted.every(isNonNegativeSafeInteger)
  ) {
    return err(
      'INVALID_SPEND_INPUT',
      'Spend amounts must be non-negative integer micro-USD and thresholds positive integers',
    );
  }
  const current = BigInt(committedMicros) + BigInt(inFlightReservedMicros);
  const projected = current + BigInt(requestEstimateMicros);
  if (projected > BigInt(Number.MAX_SAFE_INTEGER)) {
    return err('INVALID_SPEND_INPUT', 'Projected spend exceeds the representable range');
  }
  const budget = BigInt(budgetMicros);
  const allowed = projected <= budget;
  const counted = allowed ? projected : current;
  const newlyCrossedThresholds = [...new Set(thresholds)]
    .sort((a, b) => a - b)
    .filter(
      (t) =>
        !input.alreadyAlerted.includes(t) &&
        (counted * 100n >= BigInt(t) * budget || (!allowed && t === CEILING_THRESHOLD_PERCENT)),
    );
  return ok({
    allowed,
    projectedMicros: Number(projected),
    budgetMicros,
    newlyCrossedThresholds,
  });
}

// ---------------------------------------------------------------------------------------------
// Spend ledger: atomic reserve → settle of AI spend for one budget scope and period (AC_FIN_09).
// The database layer serializes calls per scope (e.g. row lock); these functions decide.
// ---------------------------------------------------------------------------------------------

/**
 * How an in-flight operation ended.
 * - `succeeded`: billed and produced a result.
 * - `failed_billed`: failed/timed out/invalid output but the provider billed it; counts in full.
 * - `cancelled_unbilled`: cancelled before any billable usage; must settle at 0.
 */
export type SpendOutcome = 'succeeded' | 'failed_billed' | 'cancelled_unbilled';

const SPEND_OUTCOMES: readonly SpendOutcome[] = [
  'succeeded',
  'failed_billed',
  'cancelled_unbilled',
];

export interface SpendReservation {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly stage: AiStage;
  readonly estimateMicros: number;
  readonly status: 'in_flight' | 'settled';
  readonly actualMicros: number | null;
  readonly outcome: SpendOutcome | null;
}

export interface SpendLedger {
  readonly reservations: readonly SpendReservation[];
}

export const EMPTY_SPEND_LEDGER: SpendLedger = Object.freeze({
  reservations: Object.freeze([]),
});

export interface SpendTotals {
  readonly committedMicros: number;
  readonly inFlightReservedMicros: number;
}

/**
 * Checks the invariants reserveSpend/settleSpend guarantee for every row. The ledger is loaded from
 * persistence, so a row that breaks them (a settled row with no cost, a negative or fractional
 * amount, an unknown status/outcome) is corrupt data, never a $0 row.
 */
function countedMicros(
  r: SpendReservation,
  index: number,
): { readonly settled: boolean; readonly micros: number } {
  const fail = (why: string): never => {
    throw new RangeError(`Spend ledger row ${index} is corrupt: ${why}`);
  };
  if (!isPositiveSafeInteger(r.estimateMicros)) fail('estimate must be a positive integer');
  if (r.status === 'in_flight') {
    if (r.actualMicros !== null || r.outcome !== null) fail('in-flight row has a settlement');
    return { settled: false, micros: r.estimateMicros };
  }
  if (r.status !== 'settled') return fail('unknown status');
  const actual = r.actualMicros;
  if (!isNonNegativeSafeInteger(actual)) return fail('settled row needs a recorded cost');
  if (r.outcome === null || !SPEND_OUTCOMES.includes(r.outcome)) fail('unknown outcome');
  if (r.outcome === 'cancelled_unbilled' && actual !== 0) fail('unbilled row carries a cost');
  return { settled: true, micros: actual };
}

/**
 * Settled actual spend and outstanding in-flight holds.
 *
 * Decision (RV-quotas-5): every row is validated before it is summed and a corrupt row throws
 * (a data-integrity error, like an out-of-range total). Summing with `actualMicros ?? 0` or
 * checking only the totals let a settled billed row with no cost, or a negative row offset by a
 * real one, lower counted spend and open the ceiling (spec F4, AC_FIN_01, AC_FIN_09).
 */
export function spendTotals(ledger: SpendLedger): SpendTotals {
  let committedMicros = 0;
  let inFlightReservedMicros = 0;
  ledger.reservations.forEach((r, index) => {
    const row = countedMicros(r, index);
    if (row.settled) committedMicros += row.micros;
    else inFlightReservedMicros += row.micros;
  });
  if (!Number.isSafeInteger(committedMicros) || !Number.isSafeInteger(inFlightReservedMicros)) {
    throw new RangeError('Spend ledger totals exceed the representable range');
  }
  return { committedMicros, inFlightReservedMicros };
}

export interface SpendReserveRequest {
  readonly idempotencyKey: string;
  readonly stage: AiStage;
  /** Upper-bound estimate (see estimateUpperBoundCostMicros); must be positive. */
  readonly estimateMicros: number;
  readonly budgetMicros: number | null;
  readonly alertThresholdsPercent?: readonly number[];
  readonly alreadyAlerted: readonly number[];
}

export type SpendReserveOutcome =
  | {
      readonly kind: 'reserved';
      readonly ledger: SpendLedger;
      readonly reservation: SpendReservation;
      readonly evaluation: SpendEvaluation;
    }
  | { readonly kind: 'denied'; readonly ledger: SpendLedger; readonly evaluation: SpendEvaluation }
  | {
      readonly kind: 'replayed';
      readonly ledger: SpendLedger;
      readonly reservation: SpendReservation;
    };

/**
 * Hold an operation's upper-bound cost against the budget before calling the provider.
 * A denial is a normal outcome (`kind: 'denied'`, ledger unchanged), not an error. It reports the
 * 100% ceiling alert and any threshold already reached by committed + in-flight spend, never one
 * reached only by the denied estimate (see evaluateSpend). A corrupt persisted ledger throws
 * (see spendTotals) instead of being counted low.
 */
export function reserveSpend(
  ledger: SpendLedger,
  request: SpendReserveRequest,
  random: RandomSource = cryptoRandom,
): Result<SpendReserveOutcome, SpendErrorCode> {
  const { idempotencyKey, stage, estimateMicros } = request;
  if (
    !isNonEmptyString(idempotencyKey) ||
    !isAiStage(stage) ||
    !isPositiveSafeInteger(estimateMicros)
  ) {
    return err(
      'INVALID_SPEND_INPUT',
      'Spend reservation needs an idempotency key, a known stage and a positive estimate',
    );
  }
  const existing = ledger.reservations.find((r) => r.idempotencyKey === idempotencyKey);
  if (existing !== undefined) {
    if (existing.stage !== stage || existing.estimateMicros !== estimateMicros) {
      return err(
        'IDEMPOTENCY_KEY_CONFLICT',
        'Idempotency key was already used for another operation',
      );
    }
    return ok({ kind: 'replayed', ledger, reservation: existing });
  }

  const totals = spendTotals(ledger);
  const evaluated = evaluateSpend({
    budgetMicros: request.budgetMicros,
    committedMicros: totals.committedMicros,
    inFlightReservedMicros: totals.inFlightReservedMicros,
    requestEstimateMicros: estimateMicros,
    ...(request.alertThresholdsPercent === undefined
      ? {}
      : { alertThresholdsPercent: request.alertThresholdsPercent }),
    alreadyAlerted: request.alreadyAlerted,
  });
  if (!evaluated.ok) return evaluated;
  const evaluation = evaluated.value;
  if (!evaluation.allowed) return ok({ kind: 'denied', ledger, evaluation });

  const reservation: SpendReservation = Object.freeze({
    id: freshId(random, (id) => ledger.reservations.some((r) => r.id === id)),
    idempotencyKey,
    stage,
    estimateMicros,
    status: 'in_flight',
    actualMicros: null,
    outcome: null,
  });
  return ok({
    kind: 'reserved',
    ledger: Object.freeze({ reservations: Object.freeze([...ledger.reservations, reservation]) }),
    reservation,
    evaluation,
  });
}

export interface SpendSettlement {
  /** Actual billed cost from provider usage (computeOperationCostMicros), may exceed the estimate. */
  readonly actualMicros: number;
  readonly outcome: SpendOutcome;
}

export interface SpendSettleChange {
  readonly ledger: SpendLedger;
  readonly reservation: SpendReservation;
  readonly changed: boolean;
}

/**
 * Replace an in-flight hold with the actual billed cost. Failed billed attempts count in full
 * (spec F3: retries that cost money count even when the child receives no result).
 * Idempotent for an identical settlement; a different settlement is INVALID_TRANSITION.
 */
export function settleSpend(
  ledger: SpendLedger,
  reservationId: string,
  settlement: SpendSettlement,
): Result<SpendSettleChange, SpendErrorCode> {
  const { actualMicros, outcome } = settlement;
  if (!isNonNegativeSafeInteger(actualMicros) || !SPEND_OUTCOMES.includes(outcome)) {
    return err(
      'INVALID_SPEND_INPUT',
      'Settlement needs a non-negative integer cost and an outcome',
    );
  }
  if (outcome === 'cancelled_unbilled' && actualMicros !== 0) {
    return err(
      'INVALID_SPEND_INPUT',
      'An operation with billed usage must settle as succeeded or failed_billed',
    );
  }
  const index = ledger.reservations.findIndex((r) => r.id === reservationId);
  const reservation = ledger.reservations[index];
  if (reservation === undefined) return err('RESERVATION_NOT_FOUND', 'No such spend reservation');
  if (reservation.status === 'settled') {
    if (reservation.actualMicros === actualMicros && reservation.outcome === outcome) {
      return ok({ ledger, reservation, changed: false });
    }
    return err('INVALID_TRANSITION', 'Spend reservation was already settled differently');
  }
  const next: SpendReservation = Object.freeze({
    ...reservation,
    status: 'settled',
    actualMicros,
    outcome,
  });
  const reservations = ledger.reservations.slice();
  reservations[index] = next;
  return ok({
    ledger: Object.freeze({ reservations: Object.freeze(reservations) }),
    reservation: next,
    changed: true,
  });
}
