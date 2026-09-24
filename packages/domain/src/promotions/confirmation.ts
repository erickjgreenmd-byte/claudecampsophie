import { DateTime } from 'luxon';
import { formatUsd } from '../shared/money.ts';
import { assertIanaZone, type CalendarDate } from '../shared/time.ts';
import type { RedemptionQuote } from './redemption.ts';

export type DiscountedPeriodView =
  | {
      readonly kind: 'renewal_period';
      readonly startsAt: Date;
      /** Null until the provider publishes the period end; never estimated as +30 days. */
      readonly endsAt: Date | null;
      readonly startsOn: CalendarDate;
      readonly endsOn: CalendarDate | null;
    }
  | { readonly kind: 'first_full_period'; readonly startsAtPurchase: true };

/** Data for the parent confirmation screen (spec P17, AC_PROMO_14); wording/localization is UI's. */
export interface ConfirmationSummary {
  /** The code validated for this family; nothing is applied until the provider confirms. */
  readonly codeStatus: 'valid_not_yet_applied';
  readonly percentOff: number;
  readonly discountedPeriod: DiscountedPeriodView;
  /** Local date of the discounted charge (null for a new subscriber: charged at purchase). */
  readonly nextBillingOn: CalendarDate | null;
  readonly discountedCharge: string;
  readonly discountAmount: string;
  /** Regular tier price for the period after the discounted one, unless a new code is redeemed. */
  readonly regularRenewalPrice: string;
  readonly regularRenewalOn: CalendarDate | null;
  readonly autoRenewOff: boolean;
  /** The provider-reported amount governs; show it once confirmed. */
  readonly amountIsPreview: true;
}

function localDate(instant: Date, zone: string): CalendarDate {
  const date = DateTime.fromJSDate(instant, { zone }).toISODate();
  if (date === null) throw new RangeError('Invalid instant for display');
  return date;
}

/** Shapes a quote for confirmation, rendering dates in the family's display zone. */
export function confirmationSummary(
  quote: RedemptionQuote,
  displayZone: string,
): ConfirmationSummary {
  assertIanaZone(displayZone);
  const target = quote.targetPeriod;
  const discountedPeriod: DiscountedPeriodView =
    target.kind === 'renewal_period'
      ? {
          kind: 'renewal_period',
          startsAt: target.periodStart,
          endsAt: target.periodEnd,
          startsOn: localDate(target.periodStart, displayZone),
          endsOn: target.periodEnd === null ? null : localDate(target.periodEnd, displayZone),
        }
      : { kind: 'first_full_period', startsAtPurchase: true };
  return {
    codeStatus: 'valid_not_yet_applied',
    percentOff: quote.percentOff,
    discountedPeriod,
    nextBillingOn: discountedPeriod.kind === 'renewal_period' ? discountedPeriod.startsOn : null,
    discountedCharge: formatUsd(quote.chargedCents),
    discountAmount: formatUsd(quote.discountCents),
    regularRenewalPrice: formatUsd(quote.nextRegularRenewalCents),
    regularRenewalOn: discountedPeriod.kind === 'renewal_period' ? discountedPeriod.endsOn : null,
    autoRenewOff: quote.autoRenewOff,
    amountIsPreview: true,
  };
}
