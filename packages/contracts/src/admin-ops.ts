import { z } from 'zod';
import {
  ATTENTION_KINDS,
  CASE_AGE_BUCKETS,
  CASE_AGE_FILTER_KEYS,
  MAX_REPORT_MONTHS,
  SUPPORT_MESSAGE_MAX_LENGTH,
  SUPPORT_REFERENCE_MAX_LENGTH,
  SUPPORT_SUBJECT_MAX_LENGTH,
  type CaseAgeFilter,
} from '@pencillift/domain/ops';
import { calendarMonthSchema, channelSchema, isoDateTimeSchema, uuidSchema } from './common.ts';
import {
  billingSettlementSchema,
  supportAuthorKindSchema,
  supportBillingPeriodRefSchema,
  supportCaseKindSchema,
  supportCasePrioritySchema,
  supportCaseResolutionSchema,
  supportCaseStatusSchema,
} from './support.ts';

// Owner-admin operations (/v1/admin/overview, /revenue, /subscriptions, /support/*, /settings/*).
// Every route needs an owner admin with an MFA session. Every number names the table it was read
// from and how it was counted (`source`, `definition`) so the screen can say so; nothing is rounded
// up. No response here carries a child's name, homework text or a child identifier.

const count = z.number().int().min(0);
const cents = z.number().int();
const nonNegativeCents = z.number().int().min(0);
const sourceSchema = z.string().min(1).max(200);
const definitionSchema = z.string().min(1).max(600);

/** A whole-number metric with its provenance. */
export const metricSchema = z.strictObject({
  value: count,
  source: sourceSchema,
  definition: definitionSchema,
});
export type Metric = z.infer<typeof metricSchema>;

/** A money metric (integer cents; may be negative for a net) with its provenance. */
export const centsMetricSchema = z.strictObject({
  cents,
  source: sourceSchema,
  definition: definitionSchema,
});
export type CentsMetric = z.infer<typeof centsMetricSchema>;

// ---------------------------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------------------------

export const entitlementLedgerStatusSchema = z.enum([
  'pending',
  'active',
  'grace_period',
  'billing_retry',
  'cancelled_active',
  'expired',
  'revoked',
  'refunded',
]);

export const subscriptionsByChannelSchema = z.strictObject({ channel: channelSchema, count });
export const subscriptionsByPaidSlotsSchema = z.strictObject({
  paidSlots: z.number().int().min(0).max(12),
  count,
});
export const subscriptionsByStatusSchema = z.strictObject({
  status: entitlementLedgerStatusSchema,
  count,
});

/** GET /v1/admin/subscriptions, and `subscriptions` on the overview. */
export const subscriptionsSummarySchema = z.strictObject({
  asOf: isoDateTimeSchema,
  month: calendarMonthSchema,
  /** Provider subscriptions that grant paid access at `asOf`. */
  active: metricSchema,
  /** Distinct families with at least one active subscription. */
  subscribedFamilies: metricSchema,
  /** Active subscriptions by channel: every channel in the contract's channel list, zero included. */
  byChannel: z.array(subscriptionsByChannelSchema),
  /** Active subscriptions by paid slots (only sizes that occur). */
  byPaidSlots: z.array(subscriptionsByPaidSlotsSchema),
  /** Every ledger row by its current status (only statuses that occur). */
  byStatus: z.array(subscriptionsByStatusSchema),
  newThisMonth: metricSchema,
  lapsedThisMonth: metricSchema,
  activeAtMonthStart: metricSchema,
  churn: z.strictObject({
    /** lapsedThisMonth ÷ activeAtMonthStart in basis points, rounded down; null without a base. */
    basisPoints: z.number().int().min(0).nullable(),
    source: sourceSchema,
    definition: definitionSchema,
  }),
});
export type SubscriptionsSummary = z.infer<typeof subscriptionsSummarySchema>;

// ---------------------------------------------------------------------------------------------
// Revenue
// ---------------------------------------------------------------------------------------------

/** Fee fraction with at most four decimals (0.3 = 30%). */
export const feeRateSchema = z
  .number()
  .min(0)
  .max(1)
  .refine((rate) => Math.abs(rate * 10_000 - Math.round(rate * 10_000)) < 1e-6, {
    message: 'A fee rate has at most four decimal places',
  });

/** One rate per channel, every channel in the contract's channel list. */
export const storeFeeRatesSchema = z.record(channelSchema, feeRateSchema);
export type StoreFeeRates = z.infer<typeof storeFeeRatesSchema>;

export const revenueChannelLineSchema = z.strictObject({
  channel: channelSchema,
  /** Charged billing periods counted in this line. */
  periods: count,
  grossChargedCents: nonNegativeCents,
  refundedCents: nonNegativeCents,
  feeRateBasisPoints: z.number().int().min(0).max(10_000),
  storeFeeCents: nonNegativeCents,
  netCents: cents,
});
export type RevenueChannelLine = z.infer<typeof revenueChannelLineSchema>;

export const revenueTotalsSchema = z.strictObject({
  grossChargedCents: nonNegativeCents,
  refundedCents: nonNegativeCents,
  storeFeeCents: nonNegativeCents,
  netCents: cents,
});

export const revenueMonthSchema = z.strictObject({
  month: calendarMonthSchema,
  /** Every channel in the contract's channel list, zero lines included. */
  channels: z.array(revenueChannelLineSchema),
  totals: revenueTotalsSchema,
});
export type RevenueMonth = z.infer<typeof revenueMonthSchema>;

/** GET /v1/admin/revenue?months=N (1..MAX_REPORT_MONTHS, default 6), and `revenue` on the overview. */
export const revenueQuerySchema = z.strictObject({
  months: z.coerce.number().int().min(1).max(MAX_REPORT_MONTHS).default(6),
});

export const revenueResponseSchema = z.strictObject({
  asOf: isoDateTimeSchema,
  /** Oldest first, ending with the current UTC month. */
  months: z.array(revenueMonthSchema),
  feeRates: storeFeeRatesSchema,
  /** Caveats to show with the table (fee estimate, Stripe fee not modelled, refund attribution). */
  notes: z.array(z.string().min(1).max(400)),
  source: sourceSchema,
  definition: definitionSchema,
});
export type RevenueResponse = z.infer<typeof revenueResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------

export const promoRedemptionStateSchema = z.enum([
  'reserved',
  'provider_pending',
  'confirmed',
  'rejected',
  'expired',
  'reconciled',
]);

export const attentionKindSchema = z.enum(ATTENTION_KINDS);
export type AttentionKind = z.infer<typeof attentionKindSchema>;

export const attentionItemSchema = z.strictObject({
  kind: attentionKindSchema,
  /** A sub-key within the kind (a support case kind, a readiness check name); null otherwise. */
  key: z.string().max(80).nullable(),
  count,
  oldestAt: isoDateTimeSchema.nullable(),
  oldestAgeHours: z.number().int().min(0).nullable(),
  source: sourceSchema,
  definition: definitionSchema,
});
export type AttentionItem = z.infer<typeof attentionItemSchema>;

export const readinessBlockedSchema = z.strictObject({
  check: z.string().min(1).max(80),
  detail: z.string().min(1).max(600),
});
export type ReadinessBlocked = z.infer<typeof readinessBlockedSchema>;

export const overviewResponseSchema = z.strictObject({
  asOf: isoDateTimeSchema,
  /** The UTC calendar month every "this month" figure refers to. */
  month: calendarMonthSchema,
  families: z.strictObject({
    total: metricSchema,
    newThisMonth: metricSchema,
    activeChildrenWithPaidSlots: metricSchema,
  }),
  subscriptions: subscriptionsSummarySchema,
  revenue: revenueResponseSchema,
  promoRedemptions: z.strictObject({
    byState: z.array(z.strictObject({ state: promoRedemptionStateSchema, count })),
    thisMonth: metricSchema,
    source: sourceSchema,
    definition: definitionSchema,
  }),
  schoolContributions: z.strictObject({
    accruedCents: centsMetricSchema,
    paidOutCents: centsMetricSchema,
  }),
  monetization: z.strictObject({
    /** P16 revenue recognized this month (revenue_entries + adjustments); 0 when none. */
    recognizedThisMonthCents: centsMetricSchema,
  }),
  aiSpend: z.strictObject({
    month: calendarMonthSchema,
    /** Exact sums in micro-dollars as decimal strings (bigint-safe). */
    spentMicros: z.string().regex(/^\d+$/),
    budgetMicros: z.string().regex(/^\d+$/).nullable(),
    /** The same, in whole cents rounded down (for display). */
    spentCents: nonNegativeCents,
    budgetCents: nonNegativeCents.nullable(),
    /** Whole percent of the cap used, rounded down; null when no cap is set for the month. */
    percentOfCap: z.number().int().min(0).nullable(),
    source: sourceSchema,
    definition: definitionSchema,
  }),
  /** Every attention rule, zero counts included (the screen shows an honest "none"). */
  attention: z.array(attentionItemSchema),
  readiness: z.strictObject({
    blocked: z.array(readinessBlockedSchema),
    source: sourceSchema,
    definition: definitionSchema,
  }),
});
export type OverviewResponse = z.infer<typeof overviewResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Support queue (staff view)
// ---------------------------------------------------------------------------------------------

export const caseAgeFilterSchema = z.enum(
  CASE_AGE_FILTER_KEYS as [CaseAgeFilter, ...CaseAgeFilter[]],
);
export const caseAgeBucketSchema = z.enum(CASE_AGE_BUCKETS);

/** `<created_at in epoch microseconds>_<id>` of the last case on the previous page. */
export const adminCaseCursorSchema = z
  .string()
  .regex(/^[0-9]{1,19}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** GET /v1/admin/support/cases query. `scope` defaults to the open queue (not resolved/closed). */
export const caseQueueQuerySchema = z.strictObject({
  scope: z.enum(['open', 'all']).default('open'),
  status: supportCaseStatusSchema.optional(),
  kind: supportCaseKindSchema.optional(),
  age: caseAgeFilterSchema.optional(),
  after: adminCaseCursorSchema.optional(),
});
export type CaseQueueQuery = z.infer<typeof caseQueueQuerySchema>;

export const ADMIN_CASE_PAGE_SIZE = 50;

export const adminSupportCaseSchema = z.strictObject({
  id: uuidSchema,
  familyId: uuidSchema,
  openedByKind: supportAuthorKindSchema,
  openedByUserId: uuidSchema.nullable(),
  kind: supportCaseKindSchema,
  status: supportCaseStatusSchema,
  priority: supportCasePrioritySchema,
  subject: z.string().min(1).max(SUPPORT_SUBJECT_MAX_LENGTH),
  body: z.string().min(1).max(SUPPORT_MESSAGE_MAX_LENGTH),
  billingPeriod: supportBillingPeriodRefSchema.nullable(),
  assigneeUserId: uuidSchema.nullable(),
  resolution: supportCaseResolutionSchema.nullable(),
  resolutionReference: z.string().min(1).max(SUPPORT_REFERENCE_MAX_LENGTH).nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  resolvedAt: isoDateTimeSchema.nullable(),
  ageHours: z.number().int().min(0),
  ageBucket: caseAgeBucketSchema,
  /** All messages including internal notes. */
  messageCount: count,
  lastMessageAt: isoDateTimeSchema.nullable(),
});
export type AdminSupportCase = z.infer<typeof adminSupportCaseSchema>;

export const adminCaseQueueResponseSchema = z.strictObject({
  cases: z.array(adminSupportCaseSchema),
  nextCursor: adminCaseCursorSchema.nullable(),
});
export type AdminCaseQueueResponse = z.infer<typeof adminCaseQueueResponseSchema>;

export const adminSupportCaseMessageSchema = z.strictObject({
  id: uuidSchema,
  authorKind: supportAuthorKindSchema,
  authorUserId: uuidSchema.nullable(),
  body: z.string().min(1).max(SUPPORT_MESSAGE_MAX_LENGTH),
  /** Staff-only note: never shown to the family. */
  internal: z.boolean(),
  createdAt: isoDateTimeSchema,
});
export type AdminSupportCaseMessage = z.infer<typeof adminSupportCaseMessageSchema>;

export const adminBillingPeriodSchema = z.strictObject({
  id: uuidSchema,
  channel: channelSchema,
  providerPeriodId: z.string().min(1).max(200),
  kind: z.enum(['subscription_period', 'proration', 'addon', 'tax_only']),
  periodStart: isoDateTimeSchema,
  periodEnd: isoDateTimeSchema,
  paidSlots: z.number().int().min(1).max(12),
  regularAmountCents: nonNegativeCents,
  chargedAmountCents: nonNegativeCents,
  discountCents: nonNegativeCents,
  settlement: billingSettlementSchema,
  settledAt: isoDateTimeSchema.nullable(),
  /** What the provider has reported refunded (webhooks/reconciliation), never typed by staff. */
  refundedCents: nonNegativeCents,
  currency: z.string().regex(/^[A-Z]{3}$/),
  /** This is the period the case names. */
  linkedToCase: z.boolean(),
});
export type AdminBillingPeriod = z.infer<typeof adminBillingPeriodSchema>;

/** A refund the provider reported before the charge it reverses (public.pending_refunds). */
export const adminPendingRefundSchema = z.strictObject({
  channel: channelSchema,
  providerPeriodId: z.string().min(1).max(200),
  kind: z.enum(['refund', 'partial_refund', 'chargeback']),
  refundedCents: nonNegativeCents.nullable(),
  createdAt: isoDateTimeSchema,
});

/** Where a store refund is requested. PencilLift issues none of these. */
export const REFUND_PATH_BY_CHANNEL: Readonly<Record<z.infer<typeof channelSchema>, string>> = {
  app_store:
    'Apple issues App Store refunds. The family requests one at reportaproblem.apple.com (or Settings › Apple Account › Media & Purchases › Purchase History); Apple decides and reports the refund through RevenueCat, which updates the billing period here.',
  play_store:
    'Google issues Google Play refunds. Within 48 hours the family requests one from Google Play; after that the owner can refund the order in the Play Console (Order management). Google reports the refund through RevenueCat, which updates the billing period here.',
  amazon_appstore:
    'Amazon issues Amazon Appstore refunds. The family requests one through Amazon customer service (Your Orders › Digital Orders); Amazon reports the refund through RevenueCat, which updates the billing period here.',
  stripe:
    'Web billing: the owner refunds the charge in the Stripe dashboard (Payments › Refund), then records the refund reference on this case. Stripe reports the refund by webhook, which updates the billing period here.',
};

export const adminSupportCaseDetailResponseSchema = z.strictObject({
  case: adminSupportCaseSchema,
  messages: z.array(adminSupportCaseMessageSchema),
  family: z.strictObject({
    id: uuidSchema,
    /** The family's own display name (an account label, never a child's name). */
    displayName: z.string().min(1).max(80),
    timezone: z.string().min(1).max(64),
    createdAt: isoDateTimeSchema,
    deletedAt: isoDateTimeSchema.nullable(),
  }),
  /** The family's billing periods, newest first (every case, so billing issues can be checked). */
  billingPeriods: z.array(adminBillingPeriodSchema),
  pendingRefunds: z.array(adminPendingRefundSchema),
  /** The store's refund path for the case's channel (refund requests), else null. */
  refundPath: z.string().max(600).nullable(),
  /** Always false in this build: the Stripe client exposes no refund call. */
  stripeRefundFromCase: z.boolean(),
});
export type AdminSupportCaseDetailResponse = z.infer<typeof adminSupportCaseDetailResponseSchema>;

/** POST /v1/admin/support/cases/:id/messages. An internal note never reaches the family. */
export const adminCaseMessageRequestSchema = z.strictObject({
  message: z.string().trim().min(1).max(SUPPORT_MESSAGE_MAX_LENGTH),
  internal: z.boolean(),
});
export type AdminCaseMessageRequest = z.infer<typeof adminCaseMessageRequestSchema>;

/**
 * PATCH /v1/admin/support/cases/:id. Keys left out keep their value; null clears the assignee,
 * resolution or reference. `resolved` needs a resolution; `stripe_refund_issued` needs the Stripe
 * refund reference; a resolution needs a resolved or closed status.
 */
export const adminCaseUpdateRequestSchema = z
  .strictObject({
    status: supportCaseStatusSchema.optional(),
    assigneeUserId: uuidSchema.nullable().optional(),
    priority: supportCasePrioritySchema.optional(),
    resolution: supportCaseResolutionSchema.nullable().optional(),
    resolutionReference: z
      .string()
      .trim()
      .min(1)
      .max(SUPPORT_REFERENCE_MAX_LENGTH)
      .nullable()
      .optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Nothing to change',
  });
export type AdminCaseUpdateRequest = z.infer<typeof adminCaseUpdateRequestSchema>;

export const adminCaseResponseSchema = z.strictObject({ case: adminSupportCaseSchema });

/** Stable rule codes on 422 BUSINESS_RULE answers from the support routes. */
export const SUPPORT_RULES = {
  resolutionRequired: 'RESOLUTION_REQUIRED',
  resolutionNeedsClosedOutStatus: 'RESOLUTION_NEEDS_CLOSED_OUT_STATUS',
  referenceRequired: 'REFERENCE_REQUIRED',
  referenceWithoutResolution: 'REFERENCE_WITHOUT_RESOLUTION',
  caseClosed: 'CASE_CLOSED',
  assigneeNotStaff: 'ASSIGNEE_NOT_STAFF',
  billingPeriodNotFound: 'BILLING_PERIOD_NOT_FOUND',
} as const;

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

/** GET and PUT /v1/admin/settings/store-fee-rates. */
export const storeFeeRatesResponseSchema = z.strictObject({
  rates: storeFeeRatesSchema,
  updatedAt: isoDateTimeSchema.nullable(),
  updatedBy: uuidSchema.nullable(),
  notes: z.array(z.string().min(1).max(400)),
});
export type StoreFeeRatesResponse = z.infer<typeof storeFeeRatesResponseSchema>;

export const storeFeeRatesUpdateRequestSchema = z.strictObject({ rates: storeFeeRatesSchema });
export type StoreFeeRatesUpdateRequest = z.infer<typeof storeFeeRatesUpdateRequestSchema>;
