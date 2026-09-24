import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { resolvePaidSlots, type StoreProductMapping } from './products.ts';
import { CHANNELS, MAPPINGS, productFor, snapshot } from './test-fixtures.ts';

function errorCode(result: ReturnType<typeof resolvePaidSlots>): string | null {
  return result.ok ? null : result.error.code;
}

describe('paid capacity comes only from verified store product mappings (AC_CAPACITY_10, AC_BILLING_05)', () => {
  it('maps each verified product on its own channel to exactly its tier', () => {
    for (const channel of CHANNELS) {
      for (const tier of [1, 2, 3, 4]) {
        const result = resolvePaidSlots(
          snapshot({ channel, productId: productFor(channel, tier) }),
          MAPPINGS,
          'production',
        );
        expect(result).toEqual({ ok: true, value: tier });
      }
    }
  });

  it('a product id is not recognised on a channel it is not mapped for', () => {
    const result = resolvePaidSlots(
      snapshot({ channel: 'play_store', productId: productFor('app_store', 4) }),
      MAPPINGS,
      'production',
    );
    expect(errorCode(result)).toBe('UNKNOWN_PRODUCT');
  });

  it('an unmapped product grants nothing', () => {
    const result = resolvePaidSlots(
      snapshot({ productId: 'com.pencillift.capacity.unlimited' }),
      MAPPINGS,
      'production',
    );
    expect(errorCode(result)).toBe('UNKNOWN_PRODUCT');
  });

  it('an inactive (not yet activated) catalog mapping grants nothing', () => {
    const mappings: StoreProductMapping[] = [
      {
        channel: 'app_store',
        productId: productFor('app_store', 3),
        paidSlots: 3,
        environment: 'production',
        active: false,
      },
    ];
    const result = resolvePaidSlots(
      snapshot({ productId: productFor('app_store', 3) }),
      mappings,
      'production',
    );
    expect(errorCode(result)).toBe('INACTIVE_MAPPING');
  });

  it('sandbox purchases never grant production capacity and vice versa', () => {
    expect(
      errorCode(resolvePaidSlots(snapshot({ environment: 'sandbox' }), MAPPINGS, 'production')),
    ).toBe('ENVIRONMENT_MISMATCH');
    expect(
      errorCode(resolvePaidSlots(snapshot({ environment: 'production' }), MAPPINGS, 'sandbox')),
    ).toBe('ENVIRONMENT_MISMATCH');
  });

  it('a product mapped only in sandbox is not granted in production', () => {
    const sandboxOnly: StoreProductMapping[] = [
      {
        channel: 'app_store',
        productId: 'com.pencillift.capacity.beta',
        paidSlots: 4,
        environment: 'sandbox',
        active: true,
      },
    ];
    const result = resolvePaidSlots(
      snapshot({ productId: 'com.pencillift.capacity.beta' }),
      sandboxOnly,
      'production',
    );
    expect(errorCode(result)).toBe('ENVIRONMENT_MISMATCH');
  });

  it('fails closed on conflicting active mappings for the same product', () => {
    const conflicting: StoreProductMapping[] = [
      {
        channel: 'app_store',
        productId: productFor('app_store', 2),
        paidSlots: 2,
        environment: 'production',
        active: true,
      },
      {
        channel: 'app_store',
        productId: productFor('app_store', 2),
        paidSlots: 4,
        environment: 'production',
        active: true,
      },
    ];
    expect(errorCode(resolvePaidSlots(snapshot(), conflicting, 'production'))).toBe(
      'AMBIGUOUS_MAPPING',
    );
  });

  it('a mapping outside the configured 1..max tiers never grants capacity', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -3, max: 0 }),
          fc.integer({ min: 5, max: 50 }),
          fc.double({ min: 1.01, max: 3.99, noNaN: true }),
        ),
        (paidSlots) => {
          const mappings: StoreProductMapping[] = [
            {
              channel: 'app_store',
              productId: 'com.pencillift.capacity.x',
              paidSlots,
              environment: 'production',
              active: true,
            },
          ];
          const result = resolvePaidSlots(
            snapshot({ productId: 'com.pencillift.capacity.x' }),
            mappings,
            'production',
          );
          expect(errorCode(result)).toBe('INVALID_MAPPING_SLOTS');
        },
      ),
    );
  });

  it('honours a configured larger max tier without changing the mapping rule', () => {
    const mappings: StoreProductMapping[] = [
      {
        channel: 'stripe',
        productId: 'price_pl_capacity_6',
        paidSlots: 6,
        environment: 'production',
        active: true,
      },
    ];
    const snap = snapshot({ channel: 'stripe', productId: 'price_pl_capacity_6' });
    expect(errorCode(resolvePaidSlots(snap, mappings, 'production'))).toBe('INVALID_MAPPING_SLOTS');
    expect(resolvePaidSlots(snap, mappings, 'production', 6)).toEqual({ ok: true, value: 6 });
  });
});
