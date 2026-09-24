import { assertCents, divideRoundHalfUp, type Cents } from '../shared/money.ts';
import { err, ok, type Result } from '../shared/result.ts';

/** Owner-approved discount range (spec P17): whole percentages 5 through 100. */
export const MIN_PERCENT_OFF = 5;
export const MAX_PERCENT_OFF = 100;

export function isValidPercentOff(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_PERCENT_OFF &&
    value <= MAX_PERCENT_OFF
  );
}

export interface DiscountPreview {
  readonly regularCents: Cents;
  readonly percentOff: number;
  readonly chargedCents: Cents;
  readonly discountCents: Cents;
  /** The provider-reported amount always overrides a preview (docs/Architecture.md §6). */
  readonly isPreview: true;
}

/**
 * charged = round-half-up(regular × (100 − pct) / 100), matching finance/promo_school_model.py;
 * 100% charges 0. Invalid inputs are programmer errors (campaigns are validated at activation).
 */
export function previewDiscount(regularCents: Cents, percentOff: number): DiscountPreview {
  assertCents(regularCents, 'regularCents');
  if (regularCents <= 0) throw new RangeError('regularCents must be positive');
  if (!isValidPercentOff(percentOff)) {
    throw new RangeError(`percentOff must be a whole number from 5 to 100, received ${percentOff}`);
  }
  const chargedCents = divideRoundHalfUp(regularCents * (100 - percentOff), 100);
  return {
    regularCents,
    percentOff,
    chargedCents,
    discountCents: regularCents - chargedCents,
    isPreview: true,
  };
}

export interface ConfirmedPeriodRedemption {
  readonly percentOff: number;
  /** Amount the provider reports it charged for the period; overrides the preview when known. */
  readonly providerChargedCents?: Cents;
}

export const EFFECTIVE_PRICE_ERROR_CODES = ['MULTIPLE_DISCOUNTS_FOR_PERIOD'] as const;
export type EffectivePriceErrorCode = (typeof EFFECTIVE_PRICE_ERROR_CODES)[number];

export interface EffectivePeriodPrice {
  readonly chargedCents: Cents;
  readonly discountCents: Cents;
  /**
   * True whenever a confirmed promotion covers the period. Decision: this stays true even if the
   * provider happened to report the full amount, so any confirmed promo period is never treated as
   * full-price (donation eligibility is conservative).
   */
  readonly discounted: boolean;
}

/**
 * Price of one provider billing period given the confirmed/reconciled redemptions targeting it.
 * None -> regular tier price (codes never carry forward). More than one is an invariant violation.
 */
export function effectivePriceForPeriod(input: {
  readonly regularCents: Cents;
  readonly confirmedRedemptions: readonly ConfirmedPeriodRedemption[];
}): Result<EffectivePeriodPrice, EffectivePriceErrorCode> {
  const { regularCents, confirmedRedemptions } = input;
  assertCents(regularCents, 'regularCents');
  if (regularCents <= 0) throw new RangeError('regularCents must be positive');
  if (confirmedRedemptions.length > 1) {
    return err(
      'MULTIPLE_DISCOUNTS_FOR_PERIOD',
      'More than one promotion is confirmed for one billing period; reconcile before billing.',
      { count: confirmedRedemptions.length },
    );
  }
  const [redemption] = confirmedRedemptions;
  if (redemption === undefined) {
    return ok({ chargedCents: regularCents, discountCents: 0, discounted: false });
  }
  let chargedCents = previewDiscount(regularCents, redemption.percentOff).chargedCents;
  if (redemption.providerChargedCents !== undefined) {
    chargedCents = assertCents(redemption.providerChargedCents, 'providerChargedCents');
    if (chargedCents < 0 || chargedCents > regularCents) {
      throw new RangeError('providerChargedCents must be between 0 and the regular price');
    }
  }
  return ok({ chargedCents, discountCents: regularCents - chargedCents, discounted: true });
}
