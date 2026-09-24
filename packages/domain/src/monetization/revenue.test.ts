import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  REVENUE_CATEGORIES,
  adjustmentAllowed,
  revenueSummary,
  suppressSmallCount,
  type RevenueEntryFact,
} from './index.ts';

const cohorts = { activeFamilies: 200, adEligibleAdults: 150 };

function entry(overrides: Partial<RevenueEntryFact> = {}): RevenueEntryFact {
  return {
    id: 'e1',
    category: 'recognized',
    provider: 'sponsor_direct',
    placement: 'resources_browse',
    periodMonth: '2026-09',
    amountCents: 50_000,
    ...overrides,
  };
}

describe('revenueSummary (AC_MON_17, AC_MON_18)', () => {
  it('keeps projected, contracted, recognized, received and affiliate reports separate', () => {
    const summary = revenueSummary(
      [
        entry({ id: 'p', category: 'projected', amountCents: 90_000 }),
        entry({ id: 'c', category: 'contracted', amountCents: 60_000 }),
        entry({ id: 'r', category: 'recognized', amountCents: 50_000 }),
        entry({ id: 'x', category: 'received', amountCents: 25_000 }),
        entry({
          id: 'a',
          category: 'affiliate_reported',
          provider: 'amazon_associates',
          placement: null,
          amountCents: 1_234,
        }),
      ],
      [],
      cohorts,
    );
    expect(summary).toMatchObject({
      projectedCents: 90_000,
      contractedCents: 60_000,
      recognizedCents: 50_000,
      receivedCents: 25_000,
      affiliateReportedCents: 1_234,
    });
  });

  it('applies refunds and reversals as separate adjustments', () => {
    const summary = revenueSummary(
      [entry({ id: 'r', amountCents: 50_000 })],
      [
        { entryId: 'r', kind: 'reversal', amountCents: -20_000 },
        { entryId: 'r', kind: 'refund', amountCents: -5_000 },
      ],
      cohorts,
    );
    expect(summary.recognizedCents).toBe(25_000);
    expect(summary.adjustments).toEqual({ refund: -5_000, reversal: -20_000, correction: 0 });
  });

  it('never counts network revenue on inventory already sold as a fixed-fee sponsorship', () => {
    const summary = revenueSummary(
      [
        entry({ id: 's', provider: 'sponsor_direct', amountCents: 50_000 }),
        entry({ id: 'n', provider: 'ad_network', amountCents: 7_000 }),
        entry({
          id: 'n2',
          provider: 'ad_network',
          placement: 'adult_dashboard',
          amountCents: 3_000,
        }),
      ],
      [{ entryId: 'n', kind: 'correction', amountCents: 100 }],
      cohorts,
    );
    expect(summary.recognizedCents).toBe(53_000);
    expect(summary.excludedDoubleCountCents).toBe(7_100);
    expect(summary.conflicts).toEqual([
      {
        category: 'recognized',
        placement: 'resources_browse',
        periodMonth: '2026-09',
        excludedNetworkCents: 7_000,
      },
    ]);
  });

  it('reports revenue per ALL active families separately from per ad-eligible adult', () => {
    const summary = revenueSummary([entry({ amountCents: 30_001 })], [], cohorts);
    expect(summary.recognizedPerActiveFamilyCents).toBe(150); // 30001/200 = 150.005 -> 150
    expect(summary.recognizedPerAdEligibleAdultCents).toBe(200); // 30001/150 = 200.007 -> 200
    const none = revenueSummary([], [], { activeFamilies: 0, adEligibleAdults: 0 });
    expect(none.recognizedPerActiveFamilyCents).toBeNull();
    expect(none.recognizedPerAdEligibleAdultCents).toBeNull();
  });

  it('projected amounts never change recognized or received totals (property)', () => {
    const entryArb = fc.record({
      id: fc.uuid(),
      category: fc.constantFrom(...REVENUE_CATEGORIES),
      provider: fc.constantFrom('sponsor_direct', 'amazon_associates', 'ad_network'),
      placement: fc.constantFrom('adult_dashboard', 'resources_browse', null),
      periodMonth: fc.constantFrom('2026-08', '2026-09'),
      amountCents: fc.integer({ min: 0, max: 1_000_000 }),
    }) as fc.Arbitrary<RevenueEntryFact>;
    fc.assert(
      fc.property(
        fc.array(entryArb, { maxLength: 15 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (entries, extra) => {
          const base = revenueSummary(entries, [], cohorts);
          const withProjection = revenueSummary(
            [
              ...entries,
              {
                id: 'proj',
                category: 'projected',
                provider: 'ad_network',
                placement: null,
                periodMonth: '2026-09',
                amountCents: extra,
              },
            ],
            [],
            cohorts,
          );
          return (
            base.recognizedCents === withProjection.recognizedCents &&
            base.receivedCents === withProjection.receivedCents &&
            base.affiliateReportedCents === withProjection.affiliateReportedCents
          );
        },
      ),
    );
  });
});

describe('adjustments and suppression', () => {
  it('a reversal cannot take an entry below zero', () => {
    expect(adjustmentAllowed(10_000, [-4_000], -6_000)).toBe(true);
    expect(adjustmentAllowed(10_000, [-4_000], -6_001)).toBe(false);
    expect(adjustmentAllowed(10_000, [], 0)).toBe(false);
  });

  it('suppresses non-zero counts below the documented threshold of 10', () => {
    expect(suppressSmallCount(0)).toBe(0);
    expect(suppressSmallCount(1)).toBeNull();
    expect(suppressSmallCount(9)).toBeNull();
    expect(suppressSmallCount(10)).toBe(10);
  });
});
