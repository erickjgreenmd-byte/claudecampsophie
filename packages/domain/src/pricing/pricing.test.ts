import { describe, expect, it } from 'vitest';
import { isRegularTierPrice, monthlyPriceCents, priceTable, tryMonthlyPriceCents } from './index.ts';

describe('approved pricing (AC_CAPACITY_01)', () => {
  it('returns $39.99/$49.98/$59.97/$69.96 for 1/2/3/4 paid slots', () => {
    expect([1, 2, 3, 4].map((n) => monthlyPriceCents(n))).toEqual([3999, 4998, 5997, 6996]);
  });

  it('has no $9.99 first-child fallback and no family fee for zero slots', () => {
    expect(tryMonthlyPriceCents(0).ok).toBe(false);
    expect(monthlyPriceCents(1)).toBe(3999);
  });

  it('rejects fractional, negative and over-tier slot counts', () => {
    for (const n of [-1, 1.5, 5, Number.NaN]) {
      const result = tryMonthlyPriceCents(n);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_SLOT_COUNT');
    }
  });

  it('supports configured expansion without changing the formula', () => {
    expect(monthlyPriceCents(5, 6)).toBe(3999 + 999 * 4);
    expect(priceTable()).toHaveLength(4);
  });

  it('recognises only exact regular tier prices', () => {
    expect(isRegularTierPrice(2, 4998)).toBe(true);
    expect(isRegularTierPrice(2, 4999)).toBe(false);
    expect(isRegularTierPrice(9, 3999)).toBe(false);
  });
});
