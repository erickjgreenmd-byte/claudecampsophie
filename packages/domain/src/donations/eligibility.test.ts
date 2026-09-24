import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { monthlyPriceCents } from '../pricing/index.ts';
import type { BillingPeriodFact, DiscountSource } from '../shared/billing.ts';
import type { Designation } from './designation.ts';
import {
  DONATION_CENTS,
  DONATION_INELIGIBLE_REASONS,
  evaluateDonationEligibility,
  type DonationEligibility,
  type SchoolStatus,
} from './eligibility.ts';
import {
  MAPLE,
  MAPLE_SINCE_JANUARY,
  OAK,
  ZONE,
  allActive,
  discountFields,
  period,
} from './test-fixtures.ts';

function evaluate(
  fact: BillingPeriodFact,
  options: {
    designations?: readonly Designation[];
    zone?: string;
    schoolStatus?: (schoolId: string) => SchoolStatus;
  } = {},
): DonationEligibility {
  return evaluateDonationEligibility({
    period: fact,
    designations: options.designations ?? MAPLE_SINCE_JANUARY,
    programZone: options.zone ?? ZONE,
    schoolStatus: options.schoolStatus ?? allActive,
  });
}

function reasonOf(result: DonationEligibility): string | null {
  return result.eligible ? null : result.reason;
}

describe('evaluateDonationEligibility — F7 approved donation rule (AC_PROMO_11)', () => {
  it('a settled full-price monthly period generates exactly 100 cents for the designated school', () => {
    const result = evaluate(period());
    expect(result).toMatchObject({
      eligible: true,
      donationMonth: '2026-09',
      schoolId: MAPLE,
      amountCents: 100,
    });
    expect(DONATION_CENTS).toBe(100);
  });

  it.each([1, 2, 3, 4])('the regular price for %i paid slot(s) qualifies', (paidSlots) => {
    const regular = monthlyPriceCents(paidSlots);
    const result = evaluate(
      period({ paidSlots, regularAmountCents: regular, chargedAmountCents: regular }),
    );
    expect(result.eligible).toBe(true);
  });

  it.each([5, 50, 99, 100])(
    'a %i%% discount generates $0 (DISCOUNTED), even with a positive payment',
    (percent) => {
      const result = evaluate(period(discountFields(percent)));
      expect(result.eligible).toBe(false);
      expect(reasonOf(result)).toBe('DISCOUNTED');
      expect(result).not.toHaveProperty('amountCents');
    },
  );

  it('a promotional credit that reduces the subscription price disqualifies the period', () => {
    const result = evaluate(
      period({
        chargedAmountCents: 3998,
        discountCents: 1000,
        discountSources: ['promotional_credit'],
      }),
    );
    expect(reasonOf(result)).toBe('DISCOUNTED');
  });

  it('a recorded discount source disqualifies even when no discount cents were reported', () => {
    expect(reasonOf(evaluate(period({ discountSources: ['introductory_offer'] })))).toBe(
      'DISCOUNTED',
    );
  });

  it('a reported discount amount disqualifies even when the charged amount equals the regular price', () => {
    expect(reasonOf(evaluate(period({ discountCents: 500 })))).toBe('DISCOUNTED');
  });

  it('a charge below the regular price disqualifies even when no discount was recorded', () => {
    expect(reasonOf(evaluate(period({ chargedAmountCents: 4997 })))).toBe('DISCOUNTED');
  });

  it.each(['proration', 'addon', 'tax_only'] as const)('%s invoices never qualify', (kind) => {
    expect(reasonOf(evaluate(period({ kind })))).toBe('NOT_SUBSCRIPTION_PERIOD');
  });

  it.each(['pending', 'failed'] as const)('%s payments are not settled', (settlement) => {
    expect(reasonOf(evaluate(period({ settlement, settledAt: null })))).toBe('NOT_SETTLED');
  });

  it('an unrecognized settlement status fails closed as not settled (RV-donations-1)', () => {
    // Values the SettlementStatus union excludes but a normalizer slip could produce, including
    // inherited object keys that a plain-object lookup would wrongly find.
    for (const settlement of [
      'disputed',
      'void',
      'in_grace_period',
      'SETTLED',
      ' settled',
      '',
      'constructor',
      '__proto__',
      'toString',
    ]) {
      const result = evaluate(
        period({ settlement: settlement as BillingPeriodFact['settlement'] }),
      );
      expect(reasonOf(result), settlement).toBe('NOT_SETTLED');
      const rules = Object.fromEntries(
        result.snapshot.evaluatedRules.map((r) => [r.rule, r.passed]),
      );
      expect(rules, settlement).toMatchObject({ settled: false, not_refunded: false });
    }
  });

  it('a "settled" status without a settlement time fails closed as not settled', () => {
    expect(reasonOf(evaluate(period({ settledAt: null })))).toBe('NOT_SETTLED');
  });

  it.each(['refunded', 'partially_refunded', 'chargeback'] as const)(
    'a %s period does not qualify',
    (settlement) => {
      expect(reasonOf(evaluate(period({ settlement, refundedCents: 4998 })))).toBe(
        'REFUNDED_OR_CHARGED_BACK',
      );
    },
  );

  it('any refunded cents disqualify even when the status still says settled', () => {
    expect(reasonOf(evaluate(period({ refundedCents: 1 })))).toBe('REFUNDED_OR_CHARGED_BACK');
  });

  it('a regular amount that is not the approved tier price does not qualify', () => {
    expect(reasonOf(evaluate(period({ regularAmountCents: 4500, chargedAmountCents: 4500 })))).toBe(
      'NOT_REGULAR_TIER_PRICE',
    );
  });

  it('a charge above the regular price (e.g. tax folded in) does not qualify', () => {
    expect(reasonOf(evaluate(period({ chargedAmountCents: 5398 })))).toBe('NOT_REGULAR_TIER_PRICE');
  });

  it('a slot count outside the configured tiers does not qualify', () => {
    expect(
      reasonOf(
        evaluate(period({ paidSlots: 5, regularAmountCents: 7995, chargedAmountCents: 7995 })),
      ),
    ).toBe('NOT_REGULAR_TIER_PRICE');
    const withFiveTiers = evaluateDonationEligibility({
      period: period({ paidSlots: 5, regularAmountCents: 7995, chargedAmountCents: 7995 }),
      designations: MAPLE_SINCE_JANUARY,
      programZone: ZONE,
      schoolStatus: allActive,
      maxSlots: 5,
    });
    expect(withFiveTiers.eligible).toBe(true);
  });

  it('a family without a designated school accrues nothing', () => {
    expect(reasonOf(evaluate(period(), { designations: [] }))).toBe('NO_SCHOOL_DESIGNATION');
  });

  it('a designation that starts next month does not cover this period', () => {
    const fromOctober: readonly Designation[] = [
      { schoolId: MAPLE, effectiveFromMonth: '2026-10', effectiveToMonth: null },
    ];
    expect(reasonOf(evaluate(period(), { designations: fromOctober }))).toBe(
      'NO_SCHOOL_DESIGNATION',
    );
  });

  it('the school designated for the period month receives it, not a later pending school', () => {
    const changing: readonly Designation[] = [
      { schoolId: MAPLE, effectiveFromMonth: '2026-01', effectiveToMonth: '2026-10' },
      { schoolId: OAK, effectiveFromMonth: '2026-10', effectiveToMonth: null },
    ];
    const result = evaluate(period(), { designations: changing });
    expect(result.eligible && result.schoolId).toBe(MAPLE);
  });

  it.each(['inactive', 'unknown'] as const)('a %s school accrues nothing', (status) => {
    expect(reasonOf(evaluate(period(), { schoolStatus: () => status }))).toBe('SCHOOL_INACTIVE');
  });

  it('checks reasons in the documented order', () => {
    expect(DONATION_INELIGIBLE_REASONS).toEqual([
      'NOT_SUBSCRIPTION_PERIOD',
      'NOT_SETTLED',
      'REFUNDED_OR_CHARGED_BACK',
      'DISCOUNTED',
      'NOT_REGULAR_TIER_PRICE',
      'NO_SCHOOL_DESIGNATION',
      'SCHOOL_INACTIVE',
    ]);
    const inactive = { schoolStatus: (): SchoolStatus => 'inactive', designations: [] };
    const everythingWrong = period({
      kind: 'proration',
      settlement: 'refunded',
      settledAt: null,
      refundedCents: 10,
      ...discountFields(50),
      paidSlots: 9,
    });
    expect(reasonOf(evaluate(everythingWrong, inactive))).toBe('NOT_SUBSCRIPTION_PERIOD');
    const pendingDiscounted = period({
      settlement: 'pending',
      settledAt: null,
      ...discountFields(50),
    });
    expect(reasonOf(evaluate(pendingDiscounted, inactive))).toBe('NOT_SETTLED');
    const refundedDiscounted = period({
      settlement: 'refunded',
      refundedCents: 1,
      ...discountFields(5),
    });
    expect(reasonOf(evaluate(refundedDiscounted, inactive))).toBe('REFUNDED_OR_CHARGED_BACK');
    const discountedWrongTier = period({ ...discountFields(5), paidSlots: 9 });
    expect(reasonOf(evaluate(discountedWrongTier, inactive))).toBe('DISCOUNTED');
    const wrongTierNoSchool = period({ paidSlots: 9 });
    expect(reasonOf(evaluate(wrongTierNoSchool, inactive))).toBe('NOT_REGULAR_TIER_PRICE');
    expect(reasonOf(evaluate(period(), inactive))).toBe('NO_SCHOOL_DESIGNATION');
  });

  it('late settlement is recorded against the original period month, not the settlement month', () => {
    const result = evaluate(
      period({
        periodStart: new Date('2026-09-28T17:00:00.000Z'),
        periodEnd: new Date('2026-10-28T17:00:00.000Z'),
        settledAt: new Date('2026-10-03T12:00:00.000Z'),
      }),
    );
    expect(result.eligible && result.donationMonth).toBe('2026-09');
  });

  it.each([
    ['2026-10-01T06:59:59.000Z', 'America/Los_Angeles', '2026-09'],
    ['2026-10-01T07:00:00.000Z', 'America/Los_Angeles', '2026-10'],
    ['2026-09-30T10:59:59.000Z', 'Pacific/Auckland', '2026-09'],
    ['2026-09-30T11:00:00.000Z', 'Pacific/Auckland', '2026-10'],
    ['2026-03-01T07:59:59.000Z', 'America/Los_Angeles', '2026-02'],
    ['2026-03-01T08:00:00.000Z', 'America/Los_Angeles', '2026-03'],
    ['2026-09-30T23:59:59.000Z', 'UTC', '2026-09'],
  ])('a period starting %s is assigned in %s to %s', (start, zone, expectedMonth) => {
    const periodStart = new Date(start);
    const result = evaluate(
      period({
        periodStart,
        periodEnd: new Date(periodStart.getTime() + 30 * 86_400_000),
        settledAt: periodStart,
      }),
      { zone },
    );
    expect(result.eligible && result.donationMonth).toBe(expectedMonth);
  });

  it('the auditable snapshot records the exact period, amounts and every rule outcome', () => {
    const result = evaluate(period(discountFields(50)));
    expect(result.snapshot).toMatchObject({
      policy: 'full_price_only',
      familyId: 'fam_riley',
      providerPeriodId: 'txn_2026_09',
      periodStart: '2026-09-10T17:00:00.000Z',
      paidSlots: 2,
      regularAmountCents: 4998,
      chargedAmountCents: 2499,
      discountCents: 2499,
      donationMonth: '2026-09',
      programZone: ZONE,
      schoolId: MAPLE,
    });
    expect(result.snapshot.evaluatedRules).toEqual([
      { rule: 'subscription_period', passed: true },
      { rule: 'settled', passed: true },
      { rule: 'not_refunded', passed: true },
      { rule: 'undiscounted', passed: false },
      { rule: 'regular_tier_price', passed: false },
      { rule: 'school_designated', passed: true },
      { rule: 'school_active', passed: true },
    ]);
    // The snapshot is plain JSON (it is stored as an immutable audit record).
    expect(JSON.parse(JSON.stringify(result.snapshot))).toEqual(result.snapshot);
  });

  it('there is no option that permits donations for discounted periods', () => {
    const smuggled = {
      period: period(discountFields(5)),
      designations: MAPLE_SINCE_JANUARY,
      programZone: ZONE,
      schoolStatus: allActive,
      allowDiscountedDonations: true,
      policy: 'any_payment',
    };
    const result = evaluateDonationEligibility(smuggled);
    expect(reasonOf(result)).toBe('DISCOUNTED');
  });

  it('rejects malformed facts as programmer errors', () => {
    expect(() => evaluate(period({ discountCents: -1 }))).toThrow(RangeError);
    expect(() => evaluate(period({ chargedAmountCents: 49.98 }))).toThrow(RangeError);
    expect(() => evaluate(period({ periodStart: new Date(Number.NaN) }))).toThrow(RangeError);
    expect(() => evaluate(period(), { zone: 'Not/AZone' })).toThrow(RangeError);
  });

  it('property: any discount of any size or source makes a period ineligible', () => {
    const sources: readonly DiscountSource[] = [
      'promo_code',
      'promotional_credit',
      'introductory_offer',
      'other_discount',
    ];
    const discountArb = fc.oneof(
      // a percentage promo of 1..100%
      fc.integer({ min: 1, max: 100 }).map((pct) => discountFields(pct)),
      // any positive discount cents, whatever the charged amount says
      fc
        .record({
          discountCents: fc.integer({ min: 1, max: 4998 }),
          chargedAmountCents: fc.integer({ min: 0, max: 6000 }),
        })
        .map((d) => ({ ...d, regularAmountCents: 4998, discountSources: [] })),
      // a reported discount amount while the charge still equals the regular price
      fc.integer({ min: 1, max: 4998 }).map((discountCents) => ({
        discountCents,
        regularAmountCents: 4998,
        chargedAmountCents: 4998,
        discountSources: [],
      })),
      // a discount source with no reported cents
      fc.subarray([...sources], { minLength: 1 }).map((discountSources) => ({
        discountSources,
        regularAmountCents: 4998,
        chargedAmountCents: 4998,
        discountCents: 0,
      })),
      // any charged amount below regular
      fc.integer({ min: 0, max: 4997 }).map((chargedAmountCents) => ({
        chargedAmountCents,
        regularAmountCents: 4998,
        discountCents: 0,
        discountSources: [],
      })),
    );
    fc.assert(
      fc.property(
        discountArb,
        fc.constantFrom('settled', 'pending', 'failed', 'refunded', 'chargeback') as fc.Arbitrary<
          BillingPeriodFact['settlement']
        >,
        (discount, settlement) => {
          const settledAt =
            settlement === 'pending' || settlement === 'failed' ? null : new Date(0);
          const result = evaluate(period({ ...discount, settlement, settledAt }));
          expect(result.eligible).toBe(false);
          // When every earlier rule passes, the reported reason is the discount itself.
          if (settlement === 'settled') expect(reasonOf(result)).toBe('DISCOUNTED');
        },
      ),
    );
  });
});
