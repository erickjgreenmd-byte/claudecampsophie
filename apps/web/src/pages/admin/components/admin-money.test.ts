import { describe, expect, it } from 'vitest';
import {
  applePricePointProblem,
  centsToDollarsInput,
  discountedCents,
  isApplePricePoint,
  parseDollarsToCents,
} from './admin-money.ts';

describe('parseDollarsToCents (integer cents, never floats)', () => {
  it('parses whole and decimal dollar amounts', () => {
    expect(parseDollarsToCents('1500')).toBe(150_000);
    expect(parseDollarsToCents('1,234.5')).toBe(123_450);
    expect(parseDollarsToCents(' $0.07 ')).toBe(7);
    expect(parseDollarsToCents('19.99')).toBe(1999);
  });

  it('rejects negatives, extra decimals and junk', () => {
    for (const bad of ['', '-5', '1.234', 'abc', '1e3', '12.', '.5', '$']) {
      expect(parseDollarsToCents(bad)).toBeNull();
    }
  });

  it('round-trips through the input format', () => {
    expect(centsToDollarsInput(150_000)).toBe('1500.00');
    expect(centsToDollarsInput(7)).toBe('0.07');
    expect(parseDollarsToCents(centsToDollarsInput(123_456))).toBe(123_456);
  });
});

describe('discountedCents matches the finance model rounding (round half up)', () => {
  it('computes the approved examples', () => {
    expect(discountedCents(4998, 50)).toBe(2499); // 2499.0
    expect(discountedCents(4998, 5)).toBe(4748); // 4748.1
    expect(discountedCents(3999, 50)).toBe(2000); // 1999.5 rounds up
    expect(discountedCents(4998, 100)).toBe(0);
  });
});

describe('App Store price points (docs/Provider_Capability_Matrix.md)', () => {
  it('accepts the documented grid and the Free offer type', () => {
    expect(isApplePricePoint(0)).toBe(true);
    expect(isApplePricePoint(999)).toBe(true); // $9.99 ($0.10 steps below $10)
    expect(isApplePricePoint(3799)).toBe(true); // $37.99 ($0.50 steps from $10 to $50)
    expect(isApplePricePoint(2449)).toBe(true); // $24.49
    expect(isApplePricePoint(2499)).toBe(true); // $24.99 = 50% off $49.98
    expect(isApplePricePoint(5999)).toBe(true); // $59.99 ($1 steps from $50)
  });

  it('rejects amounts that are not price points instead of rounding them', () => {
    expect(isApplePricePoint(4748)).toBe(false); // 5% off $49.98
    expect(isApplePricePoint(2000)).toBe(false);
    expect(isApplePricePoint(5997)).toBe(false);
    expect(isApplePricePoint(10)).toBe(false);
  });

  it('explains the problem for a tier and percentage, or returns null when representable', () => {
    expect(applePricePointProblem(2, 5)).toMatch(/\$47\.48 .*not an App Store price point/);
    expect(applePricePointProblem(1, 5)).toBeNull(); // $37.99
    expect(applePricePointProblem(3, 100)).toBeNull(); // Free
  });
});
