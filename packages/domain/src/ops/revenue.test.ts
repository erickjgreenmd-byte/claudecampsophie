import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BASIS_POINTS_PER_UNIT,
  basisPointsToRate,
  channelRevenue,
  defaultStoreFeeRate,
  rateToBasisPoints,
  storeFeeCents,
  sumRevenue,
} from './index.ts';

describe('fee rates as basis points', () => {
  it('converts fractions to whole basis points and back, absorbing float noise', () => {
    expect(rateToBasisPoints(0.3)).toBe(3000);
    expect(rateToBasisPoints(0.29)).toBe(2900);
    expect(rateToBasisPoints(0.15)).toBe(1500);
    expect(rateToBasisPoints(0)).toBe(0);
    expect(rateToBasisPoints(1)).toBe(BASIS_POINTS_PER_UNIT);
    expect(basisPointsToRate(3000)).toBe(0.3);
  });

  it('refuses rates outside 0..1 and non-integer basis points', () => {
    for (const bad of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => rateToBasisPoints(bad)).toThrow(RangeError);
    }
    expect(() => basisPointsToRate(12.5)).toThrow(RangeError);
    expect(() => basisPointsToRate(10_001)).toThrow(RangeError);
    expect(() => storeFeeCents(100, -1)).toThrow(RangeError);
  });

  it('defaults the app stores to 30% and Stripe to 0 (per-transaction fee not modelled)', () => {
    expect(defaultStoreFeeRate('app_store')).toBe(0.3);
    expect(defaultStoreFeeRate('play_store')).toBe(0.3);
    expect(defaultStoreFeeRate('amazon_appstore')).toBe(0.3);
    expect(defaultStoreFeeRate('stripe')).toBe(0);
  });
});

describe('store fee (round half up)', () => {
  it('computes the documented examples exactly', () => {
    expect(storeFeeCents(3999, 3000)).toBe(1200); // 1199.7 -> 1200
    expect(storeFeeCents(4998, 3000)).toBe(1499); // 1499.4 -> 1499
    expect(storeFeeCents(5, 3000)).toBe(2); // 1.5 -> 2 (half up)
    expect(storeFeeCents(3, 1500)).toBe(0); // 0.45 -> 0
    expect(storeFeeCents(0, 3000)).toBe(0);
    expect(storeFeeCents(3999, 0)).toBe(0);
  });

  it('is integer, bounded by the amount and monotonic in both inputs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50_000_000 }),
        fc.integer({ min: 0, max: BASIS_POINTS_PER_UNIT }),
        (cents, bp) => {
          const fee = storeFeeCents(cents, bp);
          expect(Number.isInteger(fee)).toBe(true);
          expect(fee).toBeGreaterThanOrEqual(0);
          expect(fee).toBeLessThanOrEqual(cents);
          if (bp < BASIS_POINTS_PER_UNIT) {
            expect(storeFeeCents(cents, bp + 1)).toBeGreaterThanOrEqual(fee);
          }
          expect(storeFeeCents(cents + 1, bp)).toBeGreaterThanOrEqual(fee);
        },
      ),
    );
  });
});

describe('channel revenue net of fees', () => {
  it('takes the fee on gross minus refunds and nets everything off', () => {
    expect(
      channelRevenue({ grossChargedCents: 7998, refundedCents: 3999, feeBasisPoints: 3000 }),
    ).toEqual({
      grossChargedCents: 7998,
      refundedCents: 3999,
      feeBasisPoints: 3000,
      storeFeeCents: 1200,
      netCents: 7998 - 3999 - 1200,
    });
  });

  it('a Stripe month with rate 0 nets gross minus refunds', () => {
    expect(
      channelRevenue({ grossChargedCents: 4998, refundedCents: 0, feeBasisPoints: 0 }),
    ).toMatchObject({ storeFeeCents: 0, netCents: 4998 });
  });

  it('refunds larger than the charge (a chargeback with fees) never produce a negative fee', () => {
    const line = channelRevenue({
      grossChargedCents: 1000,
      refundedCents: 1500,
      feeBasisPoints: 3000,
    });
    expect(line.storeFeeCents).toBe(0);
    expect(line.netCents).toBe(-500);
  });

  it('refuses non-integer or negative cents', () => {
    expect(() =>
      channelRevenue({ grossChargedCents: 10.5, refundedCents: 0, feeBasisPoints: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      channelRevenue({ grossChargedCents: 10, refundedCents: -1, feeBasisPoints: 0 }),
    ).toThrow(RangeError);
  });

  it('sums lines column by column without re-estimating fees', () => {
    const a = channelRevenue({ grossChargedCents: 3999, refundedCents: 0, feeBasisPoints: 3000 });
    const b = channelRevenue({ grossChargedCents: 4998, refundedCents: 0, feeBasisPoints: 3000 });
    const c = channelRevenue({ grossChargedCents: 4998, refundedCents: 4998, feeBasisPoints: 0 });
    expect(sumRevenue([a, b, c])).toEqual({
      grossChargedCents: 3999 + 4998 + 4998,
      refundedCents: 4998,
      // 1200 + 1499: summing the per-line fees (a single estimate on 8997 would give 2699).
      storeFeeCents: 2699,
      netCents: 3999 - 1200 + (4998 - 1499) + 0,
    });
    expect(sumRevenue([])).toEqual({
      grossChargedCents: 0,
      refundedCents: 0,
      storeFeeCents: 0,
      netCents: 0,
    });
  });
});
