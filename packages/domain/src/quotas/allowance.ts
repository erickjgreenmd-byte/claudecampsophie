import { DEFAULT_MAX_PAID_SLOTS } from '../pricing/index.ts';
import { cryptoRandom, type RandomSource } from '../shared/random.ts';
import { err, ok, type Result } from '../shared/result.ts';
import {
  freshId,
  isNonEmptyString,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
} from './ids.ts';

/**
 * Per-child generation allowance (spec P11).
 * `pagesPerPaidChildPerPeriod` defaults to the PROPOSED pilot value of 40 homework pages per paid
 * child per billing period. It is configurable and is NOT an owner-approved advertised limit or a
 * measured cost; do not show it to customers as a plan feature.
 */
export interface AllowanceConfig {
  readonly pagesPerPaidChildPerPeriod: number;
  /** Highest paid-slot tier the product sells (pricing DEFAULT_MAX_PAID_SLOTS unless expanded). */
  readonly maxPaidSlots: number;
}

export const DEFAULT_ALLOWANCE_CONFIG: AllowanceConfig = Object.freeze({
  pagesPerPaidChildPerPeriod: 40,
  maxPaidSlots: DEFAULT_MAX_PAID_SLOTS,
});

export type ReservationStatus = 'reserved' | 'committed' | 'released';
export type ReleaseReason = 'unreadable' | 'cancelled' | 'failed_final';

export interface AllowanceReservation {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly childId: string;
  /** Provider billing period identifier (e.g. provider period start); usage resets per period. */
  readonly periodKey: string;
  /** Pages, counted consistently by the capture pipeline. */
  readonly units: number;
  readonly status: ReservationStatus;
  readonly releaseReason?: ReleaseReason;
}

/**
 * Append-only per-family reservation ledger. Rows are never deleted when a profile is archived,
 * removed or reassigned, so usage history cannot be reset (AC_CAPACITY_09).
 */
export interface AllowanceState {
  readonly reservations: readonly AllowanceReservation[];
}

export const EMPTY_ALLOWANCE_STATE: AllowanceState = Object.freeze({
  reservations: Object.freeze([]),
});

export interface ReserveRequest {
  readonly childId: string;
  readonly periodKey: string;
  readonly units: number;
  /** Derived from the upload/finalize event so duplicate deliveries charge once (AC_CAPTURE_06). */
  readonly idempotencyKey: string;
  /** Server-verified paid capacity for the period (never client input). */
  readonly paidSlots: number;
  /**
   * Children currently holding the family's paid slots (server-verified). At most `paidSlots`
   * distinct children. When more profiles are assigned than there are paid slots (e.g. a refund,
   * revocation or lower-tier resubscribe before the parent chose which profiles stay active, spec
   * P11), pass only the children that still hold a slot (see entitlements `childHasPaidAi`): an
   * over-assigned list is refused for EVERY child (CHILD_NOT_ENTITLED, reason
   * PAID_SLOTS_OVERASSIGNED) because it cannot say which child is paid for (AC_CAPACITY_07).
   */
  readonly activeChildIds: readonly string[];
}

export interface AllowanceChange {
  readonly state: AllowanceState;
  readonly reservation: AllowanceReservation;
  /** False when the call was an idempotent replay and `state` is the input state unchanged. */
  readonly changed: boolean;
}

export const ALLOWANCE_ERROR_CODES = [
  'INVALID_REQUEST',
  'INVALID_PAID_SLOTS',
  'CHILD_NOT_ENTITLED',
  'QUOTA_EXCEEDED',
  'IDEMPOTENCY_KEY_CONFLICT',
  'RESERVATION_NOT_FOUND',
  'INVALID_TRANSITION',
] as const;
export type AllowanceErrorCode = (typeof ALLOWANCE_ERROR_CODES)[number];

/** Which ceiling a QUOTA_EXCEEDED hit; reported in `error.details.scope`. */
export type QuotaScope = 'child' | 'family';

/** Why a reservation was CHILD_NOT_ENTITLED; reported in `error.details.reason`. */
export type NotEntitledReason = 'NO_PAID_SLOTS' | 'NOT_ASSIGNED' | 'PAID_SLOTS_OVERASSIGNED';

function assertConfig(config: AllowanceConfig): void {
  if (!isPositiveSafeInteger(config.pagesPerPaidChildPerPeriod)) {
    throw new RangeError('pagesPerPaidChildPerPeriod must be a positive integer');
  }
  if (!isPositiveSafeInteger(config.maxPaidSlots)) {
    throw new RangeError('maxPaidSlots must be a positive integer');
  }
}

/** Reserved and committed reservations consume allowance; released ones do not. */
function consumes(r: AllowanceReservation): boolean {
  return r.status !== 'released';
}

function sumUnits(state: AllowanceState, predicate: (r: AllowanceReservation) => boolean): number {
  let total = 0;
  for (const r of state.reservations) if (consumes(r) && predicate(r)) total += r.units;
  return total;
}

/**
 * Reserve allowance for an upload before any AI work starts (spec P11 "in-flight reservations").
 *
 * Order of checks:
 * 1. Idempotent replay: an existing reservation with the same key is returned unchanged, whatever
 *    its status, so a duplicate upload/finalize event is never charged twice.
 * 2. Entitlement: the family must have paid capacity, the child must be assigned to a paid slot and
 *    no more distinct children may be assigned than there are paid slots (fail closed otherwise).
 * 3. Ceilings: child usage (reserved + committed) + units <= per-child allowance, AND family usage
 *    for the period across ALL children (including archived/reassigned) + units <=
 *    paidSlots × allowance, so reassigning a slot cannot farm a fresh allowance.
 */
export function reserve(
  state: AllowanceState,
  request: ReserveRequest,
  config: AllowanceConfig = DEFAULT_ALLOWANCE_CONFIG,
  random: RandomSource = cryptoRandom,
): Result<AllowanceChange, AllowanceErrorCode> {
  assertConfig(config);
  const { childId, periodKey, units, idempotencyKey, paidSlots, activeChildIds } = request;
  if (
    !isNonEmptyString(childId) ||
    !isNonEmptyString(periodKey) ||
    !isNonEmptyString(idempotencyKey) ||
    !isPositiveSafeInteger(units) ||
    !Array.isArray(activeChildIds) ||
    !activeChildIds.every(isNonEmptyString)
  ) {
    return err(
      'INVALID_REQUEST',
      'Reservation needs a child, billing period, idempotency key and a positive whole page count',
    );
  }

  const existing = state.reservations.find((r) => r.idempotencyKey === idempotencyKey);
  if (existing !== undefined) {
    // Decision: a key replayed with different parameters is refused instead of returning a
    // reservation for another child/period/size; that would hide a caller bug or a forged event.
    if (
      existing.childId !== childId ||
      existing.periodKey !== periodKey ||
      existing.units !== units
    ) {
      return err(
        'IDEMPOTENCY_KEY_CONFLICT',
        'Idempotency key was already used for another request',
      );
    }
    return ok({ state, reservation: existing, changed: false });
  }

  if (!isNonNegativeSafeInteger(paidSlots) || paidSlots > config.maxPaidSlots) {
    return err(
      'INVALID_PAID_SLOTS',
      `Paid slots must be an integer from 0 to ${config.maxPaidSlots}`,
    );
  }
  if (paidSlots === 0) {
    return err('CHILD_NOT_ENTITLED', 'Family has no verified paid capacity', {
      reason: 'NO_PAID_SLOTS' satisfies NotEntitledReason,
    });
  }
  const assigned = new Set(activeChildIds);
  if (!assigned.has(childId)) {
    return err('CHILD_NOT_ENTITLED', 'Child is not assigned to a verified paid slot', {
      reason: 'NOT_ASSIGNED' satisfies NotEntitledReason,
    });
  }
  // Decision (RV-quotas-1): more distinct assigned children than paid slots is an inconsistent
  // entitlement snapshot (capacity dropped before the parent reselected profiles). Membership alone
  // would give paid AI to every listed child (AC_CAPACITY_07), so every child is refused until the
  // caller passes only the children that hold a slot; the family ceiling alone is not enough
  // because it still lets more children than paid slots consume paid AI.
  if (assigned.size > paidSlots) {
    return err(
      'CHILD_NOT_ENTITLED',
      'More profiles are assigned than the family has paid slots; the parent must choose which stay active',
      {
        reason: 'PAID_SLOTS_OVERASSIGNED' satisfies NotEntitledReason,
        assignedChildren: assigned.size,
        paidSlots,
      },
    );
  }

  const allowance = config.pagesPerPaidChildPerPeriod;
  const childUsed = sumUnits(state, (r) => r.periodKey === periodKey && r.childId === childId);
  if (childUsed + units > allowance) {
    return err('QUOTA_EXCEEDED', 'Child allowance for this billing period is used up', {
      scope: 'child' satisfies QuotaScope,
      usedUnits: childUsed,
      requestedUnits: units,
      limitUnits: allowance,
    });
  }
  // Decision: the family ceiling is computed from the paid capacity verified NOW, while usage keeps
  // every row for the period. A mid-period downgrade therefore blocks new work until the next
  // period instead of refunding or erasing recorded usage.
  const familyCeiling = paidSlots * allowance;
  const familyUsed = sumUnits(state, (r) => r.periodKey === periodKey);
  if (familyUsed + units > familyCeiling) {
    return err('QUOTA_EXCEEDED', 'Family allowance for this billing period is used up', {
      scope: 'family' satisfies QuotaScope,
      usedUnits: familyUsed,
      requestedUnits: units,
      limitUnits: familyCeiling,
    });
  }

  const reservation: AllowanceReservation = Object.freeze({
    id: freshId(random, (id) => state.reservations.some((r) => r.id === id)),
    idempotencyKey,
    childId,
    periodKey,
    units,
    status: 'reserved',
  });
  return ok({
    state: Object.freeze({ reservations: Object.freeze([...state.reservations, reservation]) }),
    reservation,
    changed: true,
  });
}

function replace(state: AllowanceState, index: number, next: AllowanceReservation): AllowanceState {
  const reservations = state.reservations.slice();
  reservations[index] = next;
  return Object.freeze({ reservations: Object.freeze(reservations) });
}

function find(
  state: AllowanceState,
  reservationId: string,
): { index: number; reservation: AllowanceReservation } | undefined {
  const index = state.reservations.findIndex((r) => r.id === reservationId);
  const reservation = state.reservations[index];
  return reservation === undefined ? undefined : { index, reservation };
}

/**
 * Mark a reservation's pages as consumed (processing produced a usable result).
 * Idempotent when already committed; INVALID_TRANSITION after a release.
 */
export function commit(
  state: AllowanceState,
  reservationId: string,
): Result<AllowanceChange, AllowanceErrorCode> {
  const found = find(state, reservationId);
  if (found === undefined) return err('RESERVATION_NOT_FOUND', 'No such reservation');
  const { index, reservation } = found;
  switch (reservation.status) {
    case 'committed':
      return ok({ state, reservation, changed: false });
    case 'released':
      return err('INVALID_TRANSITION', 'A released reservation cannot be committed', {
        status: reservation.status,
      });
    case 'reserved': {
      const next: AllowanceReservation = Object.freeze({ ...reservation, status: 'committed' });
      return ok({ state: replace(state, index, next), reservation: next, changed: true });
    }
  }
}

/**
 * Return a reservation's pages to the child's allowance: a permanently unreadable scan
 * (P11: must not permanently consume allowance), a cancelled upload or a final processing failure.
 * The AI cost ledger is separate: money already spent on the attempt stays counted there.
 *
 * Decision: committed and released are both terminal. Releasing a committed reservation (or
 * re-releasing with a different reason) is INVALID_TRANSITION; a later correction is an explicit
 * adjustment elsewhere, never a silent rewrite of this ledger.
 */
export function release(
  state: AllowanceState,
  reservationId: string,
  reason: ReleaseReason,
): Result<AllowanceChange, AllowanceErrorCode> {
  const found = find(state, reservationId);
  if (found === undefined) return err('RESERVATION_NOT_FOUND', 'No such reservation');
  const { index, reservation } = found;
  switch (reservation.status) {
    case 'released':
      if (reservation.releaseReason === reason) return ok({ state, reservation, changed: false });
      return err('INVALID_TRANSITION', 'Reservation was already released for another reason', {
        releaseReason: reservation.releaseReason,
      });
    case 'committed':
      return err('INVALID_TRANSITION', 'A committed reservation cannot be released', {
        status: reservation.status,
      });
    case 'reserved': {
      const next: AllowanceReservation = Object.freeze({
        ...reservation,
        status: 'released',
        releaseReason: reason,
      });
      return ok({ state: replace(state, index, next), reservation: next, changed: true });
    }
  }
}

export interface AllowanceUsageQuery {
  readonly childId: string;
  readonly periodKey: string;
  readonly paidSlots: number;
}

export interface AllowanceUsageReport {
  readonly childUsedUnits: number;
  readonly childAllowanceUnits: number;
  readonly childRemainingUnits: number;
  readonly familyUsedUnits: number;
  readonly familyCeilingUnits: number;
  readonly familyRemainingUnits: number;
  /** Pages this child can still reserve now: the smaller of the child and family remainders. */
  readonly availableUnits: number;
}

/**
 * Usage for parent display and server checks. Counts reserved (in-flight) and committed pages;
 * remaining values are clamped at zero (usage can exceed a ceiling after a mid-period downgrade).
 */
export function allowanceUsage(
  state: AllowanceState,
  query: AllowanceUsageQuery,
  config: AllowanceConfig = DEFAULT_ALLOWANCE_CONFIG,
): AllowanceUsageReport {
  assertConfig(config);
  if (!isNonNegativeSafeInteger(query.paidSlots) || query.paidSlots > config.maxPaidSlots) {
    throw new RangeError(`paidSlots must be an integer from 0 to ${config.maxPaidSlots}`);
  }
  const allowance = config.pagesPerPaidChildPerPeriod;
  const childUsedUnits = sumUnits(
    state,
    (r) => r.periodKey === query.periodKey && r.childId === query.childId,
  );
  const familyUsedUnits = sumUnits(state, (r) => r.periodKey === query.periodKey);
  const familyCeilingUnits = query.paidSlots * allowance;
  const childRemainingUnits = Math.max(0, allowance - childUsedUnits);
  const familyRemainingUnits = Math.max(0, familyCeilingUnits - familyUsedUnits);
  return {
    childUsedUnits,
    childAllowanceUnits: allowance,
    childRemainingUnits,
    familyUsedUnits,
    familyCeilingUnits,
    familyRemainingUnits,
    availableUnits: Math.min(childRemainingUnits, familyRemainingUnits),
  };
}
