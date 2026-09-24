// Refunds, chargebacks and chargeback reversals become append-only adjustment rows against an
// accrual (spec P17: "never delete a paid historical ledger row"). Accruals are never mutated.
import type { SettlementStatus } from '../shared/billing.ts';
import type { Cents } from '../shared/money.ts';
import { assertNever } from '../shared/result.ts';
import { DONATION_CENTS } from './eligibility.ts';
import { assertId, assertNonNegativeCents } from './validation.ts';

export const ADJUSTMENT_EVENTS = [
  'refund',
  'partial_refund',
  'chargeback',
  'chargeback_reversed',
] as const;
export type AdjustmentEvent = (typeof ADJUSTMENT_EVENTS)[number];

/**
 * reversal: first refund/partial refund/chargeback (-100).
 * reinstatement: a won dispute after a reversal (+100), at most once.
 * final_reversal: a refund or new chargeback after a reinstatement (-100); terminal.
 */
export type AdjustmentKind = 'reversal' | 'reinstatement' | 'final_reversal';

export interface AccrualForAdjustment {
  readonly id: string;
  readonly amountCents: number;
  readonly payoutStatus: 'unpaid' | 'paid';
}

/** The provider's current state for the accrual's billing period, re-fetched by the caller. */
export interface ProviderPeriodState {
  readonly settlement: SettlementStatus;
  readonly refundedCents: Cents;
}

export interface PlanAdjustmentInput {
  readonly accrual: AccrualForAdjustment;
  readonly event: AdjustmentEvent;
  /** Idempotency keys of adjustments already recorded (any accrual; only this one's matter). */
  readonly existingAdjustmentKeys: ReadonlySet<string>;
  /**
   * Recommended. When present, a chargeback reversal reinstates only if the provider shows the
   * period settled with nothing refunded, so a won dispute cannot resurrect a refunded period.
   */
  readonly providerState?: ProviderPeriodState;
}

export interface DonationAdjustment {
  /** `${accrualId}:${kind}` — unique in the ledger, so replays cannot apply twice. */
  readonly idempotencyKey: string;
  readonly accrualId: string;
  readonly kind: AdjustmentKind;
  readonly amountCents: -100 | 100;
  readonly event: AdjustmentEvent;
  /**
   * True when the accrual was already paid: the adjustment is netted in the NEXT payout batch
   * (history stays as paid). False: it nets against the still-unpaid accrual in its batch.
   */
  readonly carriedForward: boolean;
}

export function adjustmentKey(accrualId: string, kind: AdjustmentKind): string {
  return `${accrualId}:${kind}`;
}

/**
 * Plans the adjustment (if any) an event requires. Returns null when nothing changes.
 *
 * - refund / partial_refund / chargeback: -100 once (`reversal`). Any partial refund removes the
 *   whole $1 because a refunded period is not a full-price period.
 * - chargeback_reversed after a reversal: +100 once (`reinstatement`).
 * Decision: a refund or chargeback AFTER a reinstatement reverses once more (`final_reversal`,
 * terminal) rather than being ignored, so PencilLift never keeps paying $1 for a refunded period.
 * A second won dispute after that does not reinstate again (under-paying $1 in that rare case is
 * the safe direction). The accrual net is therefore always 0 or 100.
 * Decision: without `providerState`, a chargeback reversal after a reversal reinstates (contract
 * default); callers should pass the re-fetched provider state to guard refund-then-dispute cases.
 */
export function planAdjustment(input: PlanAdjustmentInput): DonationAdjustment | null {
  const { accrual, event, existingAdjustmentKeys: keys } = input;
  assertId(accrual.id, 'accrual.id');
  if (accrual.amountCents !== DONATION_CENTS) {
    throw new RangeError(`A donation accrual is exactly ${DONATION_CENTS} cents`);
  }
  if (input.providerState !== undefined) {
    assertNonNegativeCents(input.providerState.refundedCents, 'providerState.refundedCents');
  }
  const has = (kind: AdjustmentKind) => keys.has(adjustmentKey(accrual.id, kind));
  const reversed = has('reversal');
  const reinstated = has('reinstatement');
  const finalReversed = has('final_reversal');
  if ((reinstated && !reversed) || (finalReversed && !reinstated)) {
    throw new RangeError(`Inconsistent adjustment history for accrual ${accrual.id}`);
  }

  const make = (kind: AdjustmentKind, amountCents: -100 | 100): DonationAdjustment => ({
    idempotencyKey: adjustmentKey(accrual.id, kind),
    accrualId: accrual.id,
    kind,
    amountCents,
    event,
    carriedForward: accrual.payoutStatus === 'paid',
  });

  if (finalReversed) return null;
  switch (event) {
    case 'refund':
    case 'partial_refund':
    case 'chargeback':
      if (!reversed) return make('reversal', -100);
      if (reinstated) return make('final_reversal', -100);
      return null;
    case 'chargeback_reversed': {
      if (!reversed || reinstated) return null;
      const state = input.providerState;
      if (state !== undefined && !(state.settlement === 'settled' && state.refundedCents === 0)) {
        return null;
      }
      return make('reinstatement', 100);
    }
    default:
      return assertNever(event, 'adjustment event');
  }
}
