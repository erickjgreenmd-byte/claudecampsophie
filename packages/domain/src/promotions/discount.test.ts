import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { monthlyPriceCents } from '../pricing/index.ts';
import { effectivePriceForPeriod, previewDiscount } from './discount.ts';

const tierPrice = fc.integer({ min: 1, max: 4 }).map((slots) => monthlyPriceCents(slots));
const percent = fc.integer({ min: 5, max: 100 });

describe('P17/F7 discount preview matches the finance model', () => {
  it.each([
    [5, 4748],
    [25, 3749],
    [50, 2499],
    [75, 1250],
    [100, 0],
  ])('two-child family ($49.98) at %i%% off is charged %i cents', (percentOff, charged) => {
    expect(previewDiscount(4998, percentOff)).toEqual({
      regularCents: 4998,
      percentOff,
      chargedCents: charged,
      discountCents: 4998 - charged,
      isPreview: true,
    });
  });

  it('a 100% offer makes the period free for every tier', () => {
    for (const slots of [1, 2, 3, 4]) {
      const regular = monthlyPriceCents(slots);
      expect(previewDiscount(regular, 100)).toMatchObject({
        chargedCents: 0,
        discountCents: regular,
      });
    }
  });

  it('rounds half up to whole cents (independent oracle) and never loses or invents a cent', () => {
    fc.assert(
      fc.property(tierPrice, percent, (regular, pct) => {
        const preview = previewDiscount(regular, pct);
        // Math.round on an exact k/100 value is a correct half-up oracle for positive amounts.
        expect(preview.chargedCents).toBe(Math.round((regular * (100 - pct)) / 100));
        expect(preview.chargedCents + preview.discountCents).toBe(regular);
        expect(preview.chargedCents).toBeGreaterThanOrEqual(0);
        expect(preview.discountCents).toBeGreaterThan(0);
      }),
    );
  });

  it('a bigger percentage never charges more', () => {
    fc.assert(
      fc.property(tierPrice, percent, percent, (regular, a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        expect(previewDiscount(regular, high).chargedCents).toBeLessThanOrEqual(
          previewDiscount(regular, low).chargedCents,
        );
      }),
    );
  });

  it('rejects percentages outside the approved 5..100 range as a programmer error', () => {
    for (const bad of [0, 4, 101, 12.5, Number.NaN]) {
      expect(() => previewDiscount(4998, bad)).toThrow(RangeError);
    }
    expect(() => previewDiscount(0, 50)).toThrow(RangeError);
    expect(() => previewDiscount(49.98, 50)).toThrow(RangeError);
  });
});

describe('P17 effective price for one billing period (AC_PROMO_04, AC_PROMO_05)', () => {
  it('without a confirmed redemption for the period, the regular tier price applies', () => {
    expect(effectivePriceForPeriod({ regularCents: 4998, confirmedRedemptions: [] })).toEqual({
      ok: true,
      value: { chargedCents: 4998, discountCents: 0, discounted: false },
    });
  });

  it('one confirmed redemption discounts that period, preferring the provider-reported amount', () => {
    expect(
      effectivePriceForPeriod({ regularCents: 4998, confirmedRedemptions: [{ percentOff: 50 }] }),
    ).toEqual({ ok: true, value: { chargedCents: 2499, discountCents: 2499, discounted: true } });
    // The provider amount always overrides the preview (docs/Architecture.md §6).
    expect(
      effectivePriceForPeriod({
        regularCents: 4998,
        confirmedRedemptions: [{ percentOff: 50, providerChargedCents: 2500 }],
      }),
    ).toEqual({ ok: true, value: { chargedCents: 2500, discountCents: 2498, discounted: true } });
  });

  it('a confirmed 100% period is discounted with a zero charge', () => {
    expect(
      effectivePriceForPeriod({ regularCents: 6996, confirmedRedemptions: [{ percentOff: 100 }] }),
    ).toEqual({ ok: true, value: { chargedCents: 0, discountCents: 6996, discounted: true } });
  });

  it('two discounts on one period is an invariant violation, never a stacked price', () => {
    const result = effectivePriceForPeriod({
      regularCents: 4998,
      confirmedRedemptions: [{ percentOff: 50 }, { percentOff: 50 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MULTIPLE_DISCOUNTS_FOR_PERIOD');
  });

  it('rejects provider amounts that are negative, fractional or above the regular price', () => {
    for (const providerChargedCents of [-1, 10.5, 5000]) {
      expect(() =>
        effectivePriceForPeriod({
          regularCents: 4998,
          confirmedRedemptions: [{ percentOff: 50, providerChargedCents }],
        }),
      ).toThrow(RangeError);
    }
  });
});
