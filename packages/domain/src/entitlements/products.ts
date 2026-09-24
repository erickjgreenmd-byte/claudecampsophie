import { DEFAULT_MAX_PAID_SLOTS } from '../pricing/index.ts';
import type { BillingChannel } from '../shared/billing.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { EntitlementStatus } from './status.ts';

/** Store/provider environment. Sandbox purchases never grant production capacity and vice versa. */
export type BillingEnvironment = 'sandbox' | 'production';

/**
 * Current provider state for one subscription, fetched server-side from RevenueCat or Stripe after
 * an authenticated, deduplicated webhook (docs/Architecture.md §5). Never built from client input.
 */
export interface ProviderSubscriptionSnapshot {
  readonly channel: BillingChannel;
  readonly providerSubscriptionId: string;
  readonly productId: string;
  readonly status: EntitlementStatus;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly autoRenew: boolean;
  readonly environment: BillingEnvironment;
  /** Provider's own last-modified instant; orders observations of the same subscription. */
  readonly providerUpdatedAt: Date;
  /** When our server fetched this state. */
  readonly fetchedAt: Date;
  /** Provider-scheduled product change (e.g. Apple downgrade at renewal, Google deferred replacement). */
  readonly pendingProductId?: string;
  readonly pendingEffectiveAt?: Date;
}

/** Verified store product → paid child slot tier (`store_product_mappings`). */
export interface StoreProductMapping {
  readonly channel: BillingChannel;
  readonly productId: string;
  readonly paidSlots: number;
  readonly environment: BillingEnvironment;
  /** Inactive mappings (catalog not yet activated, retired products) grant nothing. */
  readonly active: boolean;
}

export const RESOLVE_PAID_SLOTS_ERROR_CODES = [
  'UNKNOWN_PRODUCT',
  'INACTIVE_MAPPING',
  'ENVIRONMENT_MISMATCH',
  'AMBIGUOUS_MAPPING',
  'INVALID_MAPPING_SLOTS',
] as const;

export type ResolvePaidSlotsErrorCode = (typeof RESOLVE_PAID_SLOTS_ERROR_CODES)[number];

/**
 * Paid slots granted by the snapshot's product, looked up in the verified mapping table for the
 * runtime environment. Fails closed on anything unexpected.
 */
export function resolvePaidSlots(
  snapshot: Pick<ProviderSubscriptionSnapshot, 'channel' | 'productId' | 'environment'>,
  mappings: readonly StoreProductMapping[],
  runtimeEnvironment: BillingEnvironment,
  maxSlots: number = DEFAULT_MAX_PAID_SLOTS,
): Result<number, ResolvePaidSlotsErrorCode> {
  return resolveProductSlots(
    snapshot.channel,
    snapshot.productId,
    snapshot.environment,
    mappings,
    runtimeEnvironment,
    maxSlots,
  );
}

/** Same rule as {@link resolvePaidSlots}, for a product id that is not the snapshot's current one. */
export function resolveProductSlots(
  channel: BillingChannel,
  productId: string,
  snapshotEnvironment: BillingEnvironment,
  mappings: readonly StoreProductMapping[],
  runtimeEnvironment: BillingEnvironment,
  maxSlots: number = DEFAULT_MAX_PAID_SLOTS,
): Result<number, ResolvePaidSlotsErrorCode> {
  if (!Number.isInteger(maxSlots) || maxSlots < 1) {
    throw new RangeError(`maxSlots must be a positive integer, received ${maxSlots}`);
  }
  if (snapshotEnvironment !== runtimeEnvironment) {
    return err(
      'ENVIRONMENT_MISMATCH',
      `A ${snapshotEnvironment} subscription cannot grant ${runtimeEnvironment} capacity`,
      { snapshotEnvironment, runtimeEnvironment },
    );
  }
  // Exact, case-sensitive match on channel + product id: provider ids are opaque data.
  const forProduct = mappings.filter((m) => m.channel === channel && m.productId === productId);
  if (forProduct.length === 0) {
    return err('UNKNOWN_PRODUCT', 'Product is not a verified capacity product for this channel', {
      channel,
      productId,
    });
  }
  const inEnvironment = forProduct.filter((m) => m.environment === runtimeEnvironment);
  if (inEnvironment.length === 0) {
    // Decision: a product known only in the other environment is an environment mismatch (the
    // product exists but must not grant here), not an unknown product.
    return err('ENVIRONMENT_MISMATCH', `Product is mapped only outside ${runtimeEnvironment}`, {
      channel,
      productId,
      runtimeEnvironment,
    });
  }
  const activeMappings = inEnvironment.filter((m) => m.active);
  if (activeMappings.length === 0) {
    return err('INACTIVE_MAPPING', 'Product mapping is not active', { channel, productId });
  }
  const tiers = new Set(activeMappings.map((m) => m.paidSlots));
  if (tiers.size > 1) {
    // Decision: conflicting configuration grants nothing rather than picking a tier.
    return err('AMBIGUOUS_MAPPING', 'Product maps to more than one paid slot tier', {
      channel,
      productId,
      tiers: [...tiers],
    });
  }
  const [paidSlots] = [...tiers];
  if (
    paidSlots === undefined ||
    !Number.isInteger(paidSlots) ||
    paidSlots < 1 ||
    paidSlots > maxSlots
  ) {
    return err(
      'INVALID_MAPPING_SLOTS',
      `Mapped paid slots must be an integer from 1 to ${maxSlots}`,
      {
        channel,
        productId,
        paidSlots,
        maxSlots,
      },
    );
  }
  return ok(paidSlots);
}
