import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { churnBasisPoints, percentOfCap } from './index.ts';

describe('churn', () => {
  it('is lapsed over active-at-month-start in basis points, rounded down', () => {
    expect(churnBasisPoints(1, 40)).toBe(250); // 2.5%
    expect(churnBasisPoints(2, 7)).toBe(2857); // 28.571...% never 2858
    expect(churnBasisPoints(0, 40)).toBe(0);
    expect(churnBasisPoints(40, 40)).toBe(10_000);
  });

  it('states no rate when nothing was active at the start of the month', () => {
    expect(churnBasisPoints(0, 0)).toBeNull();
    expect(churnBasisPoints(3, 0)).toBeNull();
  });

  it('refuses fractional or negative counts', () => {
    expect(() => churnBasisPoints(-1, 10)).toThrow(RangeError);
    expect(() => churnBasisPoints(1.5, 10)).toThrow(RangeError);
    expect(() => churnBasisPoints(1, -10)).toThrow(RangeError);
  });

  it('never exceeds the exact ratio', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 10_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        (lapsed, active) => {
          const bp = churnBasisPoints(lapsed, active)!;
          expect(bp).toBeLessThanOrEqual((lapsed * 10_000) / active);
          expect((lapsed * 10_000) / active - bp).toBeLessThan(1);
        },
      ),
    );
  });
});

describe('percent of cap', () => {
  it('rounds down to a whole percent and reports over-spend past 100', () => {
    expect(percentOfCap(2_500_000n, 50_000_000n)).toBe(5);
    expect(percentOfCap(49_999_999n, 50_000_000n)).toBe(99);
    expect(percentOfCap(75_000_000n, 50_000_000n)).toBe(150);
    expect(percentOfCap(0n, 50_000_000n)).toBe(0);
  });

  it('is null without a cap (readiness already blocks a month without one)', () => {
    expect(percentOfCap(10n, null)).toBeNull();
    expect(percentOfCap(10n, 0n)).toBeNull();
    expect(() => percentOfCap(-1n, 10n)).toThrow(RangeError);
  });
});
