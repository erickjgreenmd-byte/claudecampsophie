import { describe, expect, it } from 'vitest';
import { resolveAttribution, type AttributionSource } from './attribution.ts';
import { MAPLE, OAK } from './test-fixtures.ts';

describe('resolveAttribution — attribution independent of discounts (P17, AC_PROMO_10)', () => {
  it.each(['school_code', 'promo', 'manual'] as const)(
    'with no established school, a %s sets the attribution',
    (source) => {
      expect(
        resolveAttribution({ existing: null, incoming: { schoolId: MAPLE, source } }),
      ).toMatchObject({ action: 'set' });
    },
  );

  it.each(['school_code', 'promo', 'manual'] as const)(
    'the same school via %s keeps the existing attribution (no duplicate signup)',
    (source) => {
      const result = resolveAttribution({
        existing: { schoolId: MAPLE, source: 'school_code' },
        incoming: { schoolId: MAPLE, source },
      });
      expect(result.action).toBe('keep_existing');
    },
  );

  it('a promo for another school never silently overwrites an established school', () => {
    for (const existingSource of [
      'school_code',
      'promo',
      'manual',
    ] as const satisfies readonly AttributionSource[]) {
      const result = resolveAttribution({
        existing: { schoolId: MAPLE, source: existingSource },
        incoming: { schoolId: OAK, source: 'promo' },
      });
      expect(result.action).toBe('keep_existing');
    }
  });

  it('a different school code asks the parent to confirm instead of switching', () => {
    const result = resolveAttribution({
      existing: { schoolId: MAPLE, source: 'manual' },
      incoming: { schoolId: OAK, source: 'school_code' },
    });
    expect(result.action).toBe('requires_parent_confirmation');
  });

  it('an explicit parent selection sets the new school', () => {
    const result = resolveAttribution({
      existing: { schoolId: MAPLE, source: 'school_code' },
      incoming: { schoolId: OAK, source: 'manual' },
    });
    expect(result.action).toBe('set');
  });

  it('rejects a malformed school id (programmer error)', () => {
    expect(() =>
      resolveAttribution({ existing: null, incoming: { schoolId: ' ', source: 'school_code' } }),
    ).toThrow(RangeError);
  });
});
