import { z } from 'zod';
import { centsSchema, channelSchema, isoDateTimeSchema, uuidSchema } from './common.ts';

/**
 * Parent billing contracts (spec P11, P14 "subscription" and "paid-slot management"). Paid capacity
 * comes only from verified provider state; nothing a client sends here can unlock a slot. Every
 * response schema is strict so a server change that adds a private field fails loudly.
 */

/** Initial approved tiers are 1–4 paid child slots (mirrors DEFAULT_MAX_PAID_SLOTS). */
export const BILLING_MAX_TIER = 4;

/** Normalized provider states (mirrors @pencillift/domain/entitlements ENTITLEMENT_STATUSES). */
export const billingEntitlementStatusSchema = z.enum([
  'pending',
  'active',
  'grace_period',
  'billing_retry',
  'cancelled_active',
  'expired',
  'revoked',
  'refunded',
]);
export type BillingEntitlementStatus = z.infer<typeof billingEntitlementStatusSchema>;

export type BillingChannel = z.infer<typeof channelSchema>;

const tierSlotsSchema = z.number().int().min(1).max(BILLING_MAX_TIER);

export const billingEntitlementSchema = z.strictObject({
  channel: channelSchema,
  productId: z.string(),
  /** Slots this product maps to (0 when the product is not a verified capacity product). */
  paidSlots: z.number().int().min(0).max(12),
  status: billingEntitlementStatusSchema,
  periodEnd: isoDateTimeSchema.nullable(),
  autoRenew: z.boolean(),
});
export type BillingEntitlement = z.infer<typeof billingEntitlementSchema>;

/**
 * The server's comparison of a product's verified US store price with the approved tier price
 * (AC_CAPACITY_02, docs/Owner_Actions.md #1). A product whose verified price differs is never
 * sold; prices are never rounded silently.
 */
export const billingPriceCheckSchema = z.enum([
  'matches_approved',
  'differs_from_approved',
  'not_verified',
]);
export type BillingPriceCheck = z.infer<typeof billingPriceCheckSchema>;

export const billingProductSchema = z.strictObject({
  channel: channelSchema,
  productId: z.string(),
  paidSlots: z.number().int().min(1).max(12),
  /**
   * Price verified in the store catalog (USD cents), or null when not yet verified. The native app
   * always shows the store's own localized price; this is for reconciliation displays only.
   */
  storePriceCents: z.number().int().positive().nullable(),
  priceCheck: billingPriceCheckSchema,
});
export type BillingProduct = z.infer<typeof billingProductSchema>;

export const billingTierSchema = z.strictObject({
  paidSlots: tierSlotsSchema,
  /** Owner-approved regular monthly price: 3999 + 999 × (slots − 1). */
  approvedMonthlyCents: centsSchema,
});
export type BillingTier = z.infer<typeof billingTierSchema>;

export const capacityChangeKindSchema = z.enum(['upgrade', 'downgrade']);
export type CapacityChangeKind = z.infer<typeof capacityChangeKindSchema>;

export const capacityChangeStatusSchema = z.enum([
  'pending_purchase',
  'scheduled',
  'applied',
  'cancelled',
  'failed',
]);
export type CapacityChangeStatus = z.infer<typeof capacityChangeStatusSchema>;

/** GET /v1/billing/status and POST /v1/billing/sync (parent only). */
export const billingStatusResponseSchema = z.strictObject({
  /**
   * The family's opaque store-billing identity (RevenueCat app user id). The parent's device logs
   * in to the store SDK with it so purchases bind to this family. Never a family or user id.
   */
  billingRef: z.string().min(8).max(200),
  /** Verified paid capacity (MAX across subscriptions, never a sum). */
  paidSlots: z.number().int().min(0).max(12),
  /** Child profiles currently holding a paid slot. */
  assignedSlots: z.number().int().min(0).max(12),
  managingChannel: channelSchema.nullable(),
  /** Two or more active subscriptions (e.g. App Store + Google Play): the parent may be paying twice. */
  conflict: z.enum(['duplicate_active_subscriptions']).nullable(),
  /** Provider-confirmed tier change on the managing subscription (e.g. a downgrade at renewal). */
  pendingChange: z
    .strictObject({ targetSlots: z.number().int().min(0).max(12), effectiveAt: isoDateTimeSchema })
    .nullable(),
  /** The parent's latest open request. It never changes paid capacity by itself. */
  requestedChange: z
    .strictObject({
      kind: capacityChangeKindSchema,
      toSlots: tierSlotsSchema,
      status: capacityChangeStatusSchema,
      keepCount: z.number().int().min(0).max(12),
      createdAt: isoDateTimeSchema,
    })
    .nullable(),
  entitlements: z.array(billingEntitlementSchema),
  /** Active verified capacity products for this server's billing environment. */
  products: z.array(billingProductSchema),
  tiers: z.array(billingTierSchema),
});
export type BillingStatus = z.infer<typeof billingStatusResponseSchema>;

/** POST /v1/billing/capacity-changes (parent + recent PIN step-up). Records intent only. */
export const capacityChangeRequestSchema = z
  .strictObject({
    kind: capacityChangeKindSchema,
    toSlots: tierSlotsSchema,
    /**
     * Downgrades only: the child profiles that stay active after the store applies the change.
     * When the smaller plan can't keep every child holding a slot, exactly `toSlots` are chosen.
     */
    keepChildIds: z.array(uuidSchema).max(12).optional(),
    /**
     * The store the parent is about to confirm in. The server refuses a tier whose verified store
     * price differs from the approved price, before the store opens, in this store and in the
     * family's managing store. Without either, every store that would be offered is checked, so
     * omitting it never skips the check (AC_CAPACITY_02).
     */
    channel: channelSchema.optional(),
  })
  .refine((v) => v.kind === 'downgrade' || v.keepChildIds === undefined, {
    message: 'keepChildIds applies to downgrades only',
    path: ['keepChildIds'],
  });
export type CapacityChangeRequest = z.infer<typeof capacityChangeRequestSchema>;

export const capacityChangeResponseSchema = z.strictObject({
  id: uuidSchema,
  kind: capacityChangeKindSchema,
  fromSlots: z.number().int().min(0).max(12),
  toSlots: tierSlotsSchema,
  keepChildIds: z.array(uuidSchema),
  status: capacityChangeStatusSchema,
  /** Approved regular prices; the store's localized price, due-now and proration prevail. */
  currentRecurringCents: centsSchema,
  newRecurringCents: centsSchema,
  /** What the parent must still do: nothing changes until the store confirms it. */
  nextStep: z.enum(['purchase_in_store', 'change_in_store']),
  createdAt: isoDateTimeSchema,
});
export type CapacityChangeResponse = z.infer<typeof capacityChangeResponseSchema>;
