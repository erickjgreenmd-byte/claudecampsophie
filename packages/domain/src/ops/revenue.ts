import { assertCents, divideRoundHalfUp } from '../shared/money.ts';

/**
 * Subscription revenue net of store fees, for the owner's revenue view (integer cents only).
 *
 * The stores keep a share of every charge; the exact amount is on the store's own statement.
 * This view ESTIMATES it from a configurable rate per channel (public.ops_settings
 * store_fee_rates) so the owner sees an honest order of magnitude, never a promise:
 *
 *   storeFeeCents = round-half-up((gross − refunds) × rate)
 *   netCents      = gross − refunds − storeFeeCents
 *
 * The fee is taken on the amount the family actually kept paying (gross minus refunds): a refunded
 * charge returns the store's share too. Rounding: a rate is held as whole basis points (1/100 of a
 * percent) and the fee is the exact product divided by 10 000, rounded half up to the cent (the
 * same rule as the P17 finance model). Rounding the fee half up never rounds net revenue up.
 */

export const BASIS_POINTS_PER_UNIT = 10_000;

/** Fee rate as a fraction (0.30 = 30%) to whole basis points (3000). */
export function rateToBasisPoints(rate: number): number {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new RangeError(`fee rate must be a fraction from 0 to 1, received ${rate}`);
  }
  // A rate is stored with at most four decimals; the multiplication may carry float noise
  // (0.29 × 10000 = 2900.0000000000005), so it is snapped to the nearest basis point.
  return Math.round(rate * BASIS_POINTS_PER_UNIT);
}

/** Whole basis points back to a fraction, for display and for settings echo. */
export function basisPointsToRate(basisPoints: number): number {
  assertBasisPoints(basisPoints);
  return basisPoints / BASIS_POINTS_PER_UNIT;
}

function assertBasisPoints(basisPoints: number): void {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > BASIS_POINTS_PER_UNIT) {
    throw new RangeError(
      `fee rate must be whole basis points from 0 to 10000, received ${basisPoints}`,
    );
  }
}

/** round-half-up(amountCents × feeBasisPoints / 10 000). */
export function storeFeeCents(amountCents: number, feeBasisPoints: number): number {
  assertCents(amountCents, 'amountCents');
  assertBasisPoints(feeBasisPoints);
  if (amountCents <= 0) return 0;
  return divideRoundHalfUp(amountCents * feeBasisPoints, BASIS_POINTS_PER_UNIT);
}

export interface ChannelRevenueInput {
  /** Sum of charged_amount_cents over charged billing periods. */
  readonly grossChargedCents: number;
  /** Sum of refunded_cents over the same periods. */
  readonly refundedCents: number;
  readonly feeBasisPoints: number;
}

export interface ChannelRevenue extends ChannelRevenueInput {
  readonly storeFeeCents: number;
  readonly netCents: number;
}

/** One channel's month: gross, refunds, the estimated store fee and net. */
export function channelRevenue(input: ChannelRevenueInput): ChannelRevenue {
  assertCents(input.grossChargedCents, 'grossChargedCents');
  assertCents(input.refundedCents, 'refundedCents');
  if (input.grossChargedCents < 0 || input.refundedCents < 0) {
    throw new RangeError('revenue inputs are non-negative cents');
  }
  const kept = Math.max(0, input.grossChargedCents - input.refundedCents);
  const fee = storeFeeCents(kept, input.feeBasisPoints);
  return {
    grossChargedCents: input.grossChargedCents,
    refundedCents: input.refundedCents,
    feeBasisPoints: input.feeBasisPoints,
    storeFeeCents: fee,
    netCents: input.grossChargedCents - input.refundedCents - fee,
  };
}

export interface RevenueTotals {
  readonly grossChargedCents: number;
  readonly refundedCents: number;
  readonly storeFeeCents: number;
  readonly netCents: number;
}

/** Column sums across channels (or months). Fees are summed per line, never re-estimated. */
export function sumRevenue(lines: readonly RevenueTotals[]): RevenueTotals {
  return lines.reduce<RevenueTotals>(
    (acc, line) => ({
      grossChargedCents: acc.grossChargedCents + line.grossChargedCents,
      refundedCents: acc.refundedCents + line.refundedCents,
      storeFeeCents: acc.storeFeeCents + line.storeFeeCents,
      netCents: acc.netCents + line.netCents,
    }),
    { grossChargedCents: 0, refundedCents: 0, storeFeeCents: 0, netCents: 0 },
  );
}

/** Default fee fraction for a channel: the app stores' 30%; Stripe 0 (per-transaction fee not modelled). */
export const DEFAULT_STORE_FEE_RATE = 0.3;
export const DEFAULT_STRIPE_FEE_RATE = 0;

export function defaultStoreFeeRate(channel: string): number {
  return channel === 'stripe' ? DEFAULT_STRIPE_FEE_RATE : DEFAULT_STORE_FEE_RATE;
}

/** Why the Stripe line carries no fee: shown next to the revenue table. */
export const STRIPE_FEE_NOTE =
  'Stripe’s per-transaction fee (a percentage plus a fixed amount per charge) is not modelled; the Stripe line is gross minus refunds.';
