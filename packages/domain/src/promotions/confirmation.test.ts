import { describe, expect, it } from 'vitest';
import { confirmationSummary } from './confirmation.ts';
import type { RedemptionQuote } from './redemption.ts';
import { iso } from './test-fixtures.ts';

const renewalQuote: RedemptionQuote = {
  campaignId: 'campaign-2027-02',
  codeId: 'code-1',
  channel: 'stripe',
  paidSlots: 2,
  subscriberClass: 'existing',
  targetPeriod: {
    kind: 'renewal_period',
    periodStart: iso('2027-02-28T15:00:00Z'),
    periodEnd: iso('2027-03-31T15:00:00Z'),
    isProjection: true,
  },
  targetPeriodKey: '2027-02-28T15:00:00.000Z',
  percentOff: 25,
  regularCents: 4998,
  discountCents: 1249,
  chargedCents: 3749,
  nextRegularRenewalCents: 4998,
  autoRenewOff: false,
  isPreview: true,
};

describe('P17 parent confirmation details (AC_PROMO_14)', () => {
  it('shows the exact discounted provider period, amount, regular renewal price and status', () => {
    expect(confirmationSummary(renewalQuote, 'America/Los_Angeles')).toEqual({
      codeStatus: 'valid_not_yet_applied',
      percentOff: 25,
      discountedPeriod: {
        kind: 'renewal_period',
        startsAt: iso('2027-02-28T15:00:00Z'),
        endsAt: iso('2027-03-31T15:00:00Z'),
        startsOn: '2027-02-28',
        endsOn: '2027-03-31',
      },
      nextBillingOn: '2027-02-28',
      discountedCharge: '$37.49',
      discountAmount: '$12.49',
      regularRenewalPrice: '$49.98',
      regularRenewalOn: '2027-03-31',
      autoRenewOff: false,
      amountIsPreview: true,
    });
  });

  it('renders local dates in the family zone (the UTC instant may fall on the previous local day)', () => {
    const summary = confirmationSummary(
      {
        ...renewalQuote,
        targetPeriod: {
          kind: 'renewal_period',
          periodStart: iso('2026-10-15T03:00:00Z'),
          periodEnd: null,
          isProjection: true,
        },
      },
      'America/New_York',
    );
    expect(summary.nextBillingOn).toBe('2026-10-14');
    // The provider has not published the end of the target period yet: say so, never guess +30 days.
    expect(summary.regularRenewalOn).toBeNull();
    expect(summary.discountedPeriod).toMatchObject({ endsAt: null, endsOn: null });
  });

  it('a new subscriber sees that the discount covers the first period, starting at purchase', () => {
    const summary = confirmationSummary(
      {
        ...renewalQuote,
        subscriberClass: 'new',
        targetPeriod: { kind: 'first_full_period', lapsedPeriodEnd: null },
        targetPeriodKey: 'first:stripe',
        percentOff: 100,
        discountCents: 4998,
        chargedCents: 0,
      },
      'UTC',
    );
    expect(summary).toMatchObject({
      discountedPeriod: { kind: 'first_full_period', startsAtPurchase: true },
      nextBillingOn: null,
      discountedCharge: '$0.00',
      regularRenewalPrice: '$49.98',
    });
  });

  it('rejects an invalid display zone as a programmer error', () => {
    expect(() => confirmationSummary(renewalQuote, 'Not/AZone')).toThrow(RangeError);
  });
});
