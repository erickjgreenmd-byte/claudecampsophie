// Synthetic fixtures for entitlement tests. Not exported from the module's public API.
import type { BillingChannel } from '../shared/billing.ts';
import type { ProviderSubscriptionSnapshot, StoreProductMapping } from './products.ts';

export const CHANNELS: readonly BillingChannel[] = [
  'app_store',
  'play_store',
  'stripe',
  'amazon_appstore',
];

const PRODUCT_PREFIX: Readonly<Record<BillingChannel, string>> = {
  app_store: 'com.pencillift.capacity.',
  play_store: 'pencillift_capacity_',
  stripe: 'price_pl_capacity_',
  amazon_appstore: 'com.pencillift.amazon.capacity.',
};

/** Synthetic store product id for a capacity tier on a channel. */
export function productFor(channel: BillingChannel, paidSlots: number): string {
  return `${PRODUCT_PREFIX[channel]}${paidSlots}`;
}

/** Tiers 1–4 on every channel, in both environments (Apple reuses product ids in sandbox). */
export const MAPPINGS: readonly StoreProductMapping[] = CHANNELS.flatMap((channel) =>
  (['production', 'sandbox'] as const).flatMap((environment) =>
    [1, 2, 3, 4].map((paidSlots) => ({
      channel,
      productId: productFor(channel, paidSlots),
      paidSlots,
      environment,
      active: true,
    })),
  ),
);

export const PERIOD_START = new Date('2026-09-10T15:00:00.000Z');
export const PERIOD_END = new Date('2026-10-10T15:00:00.000Z');
/** Inside the paid period. */
export const NOW = new Date('2026-09-20T12:00:00.000Z');
export const UPDATED_AT = new Date('2026-09-10T15:00:05.000Z');

export function minutesAfter(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

/**
 * A verified, auto-renewing 2-slot Apple subscription for the synthetic Riley/Sam family. Unless
 * overridden, it was fetched one minute after its (possibly overridden) provider update: a
 * last-modified instant can never be later than the fetch that observed it (RV-entitlements-1).
 */
export function snapshot(
  overrides: Partial<ProviderSubscriptionSnapshot> = {},
): ProviderSubscriptionSnapshot {
  const providerUpdatedAt = overrides.providerUpdatedAt ?? UPDATED_AT;
  return {
    channel: 'app_store',
    providerSubscriptionId: 'sub_apple_family_riley',
    productId: productFor('app_store', 2),
    status: 'active',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    autoRenew: true,
    environment: 'production',
    providerUpdatedAt,
    fetchedAt: minutesAfter(providerUpdatedAt, 1),
    ...overrides,
  };
}
