import { z } from 'zod';
import {
  calendarMonthSchema,
  centsSchema,
  channelSchema,
  idempotencyKeySchema,
  isoDateTimeSchema,
  uuidSchema,
} from './common.ts';

// ---------------------------------------------------------------------------------------------
// Parent: schools and designation (spec P17)
// ---------------------------------------------------------------------------------------------

export const schoolSummarySchema = z.strictObject({
  id: uuidSchema,
  name: z.string(),
  city: z.string().nullable(),
  region: z.string().nullable(),
});

export const listSchoolsResponseSchema = z.strictObject({ schools: z.array(schoolSummarySchema) });

export const setSchoolRequestSchema = z.strictObject({ schoolId: uuidSchema });

export const familySchoolResponseSchema = z.strictObject({
  current: schoolSummarySchema.nullable(),
  /** A pending change takes effect for donations on the first day of `effectiveFromMonth`. */
  pending: z
    .strictObject({ school: schoolSummarySchema, effectiveFromMonth: calendarMonthSchema })
    .nullable(),
  programTimezone: z.string(),
  /** Always true: the $1/month contribution is PencilLift-funded and not a tax-deductible customer donation. */
  contributionIsPencilLiftFunded: z.literal(true),
});

// ---------------------------------------------------------------------------------------------
// Parent: monthly promo codes (spec P17)
// ---------------------------------------------------------------------------------------------

export const promoQuoteRequestSchema = z.strictObject({
  code: z.string().min(8).max(24),
  channel: channelSchema,
  /**
   * Only for a family without a paid subscription yet: the tier they are about to purchase. Ignored
   * for existing subscribers (the verified paid capacity is used). Defaults to the number of child
   * profiles (1..4).
   */
  paidSlots: z.number().int().min(1).max(12).optional(),
});

export const promoQuoteResponseSchema = z.strictObject({
  campaignMonth: calendarMonthSchema,
  percentOff: z.number().int().min(5).max(100),
  channel: channelSchema,
  targetPeriod: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('first_full_period') }),
    z.strictObject({
      kind: z.literal('renewal_period'),
      periodStart: isoDateTimeSchema,
      isProjection: z.literal(true),
    }),
  ]),
  regularCents: centsSchema,
  discountCents: centsSchema,
  chargedCents: centsSchema,
  /** Without a new code the following period returns to this regular price (AC_PROMO_04). */
  nextRegularRenewalCents: centsSchema,
  /** Amounts are previews; the store/provider-reported amount is authoritative. */
  isPreview: z.literal(true),
});

export const promoRedeemRequestSchema = promoQuoteRequestSchema.extend({
  idempotencyKey: idempotencyKeySchema,
});

export const redemptionStateSchema = z.enum([
  'reserved',
  'provider_pending',
  'confirmed',
  'rejected',
  'expired',
  'reconciled',
]);

export const promoRedemptionSchema = z.strictObject({
  id: uuidSchema,
  campaignMonth: calendarMonthSchema,
  channel: channelSchema,
  state: redemptionStateSchema,
  percentOff: z.number().int(),
  regularCents: centsSchema,
  discountCents: centsSchema,
  chargedCents: centsSchema,
  targetPeriodStart: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  /** What the client must do next with its store, if anything (e.g. present an App Store offer). */
  nextAction: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('none') }),
      z.strictObject({ kind: z.literal('present_store_offer'), providerOfferId: z.string() }),
      z.strictObject({ kind: z.literal('await_provider') }),
    ])
    .optional(),
});

export const familyPromotionsResponseSchema = z.strictObject({
  redemptions: z.array(promoRedemptionSchema),
});

// ---------------------------------------------------------------------------------------------
// Owner admin (spec P17 administration)
// ---------------------------------------------------------------------------------------------

export const promoTemplateInputSchema = z.strictObject({
  name: z.string().min(1).max(120),
  schoolId: uuidSchema.nullable(),
  percentOff: z.number().int().min(5).max(100),
  eligibleTiers: z.array(z.number().int().min(1).max(12)).min(1),
  subscriberEligibility: z.array(z.enum(['new', 'existing', 'lapsed'])).min(1),
  redemptionCap: z.number().int().positive(),
  budgetCapCents: z.number().int().positive(),
  calendarTimezone: z.string().min(1).max(64),
  timezoneConfirmed: z.boolean(),
  windowStartDay: z.number().int().min(1).max(28),
  windowEndDay: z.union([z.number().int().min(1).max(31), z.literal('end_of_month')]),
  codeMode: z.enum(['shared', 'individual']),
  individualCodeCount: z.number().int().positive().optional(),
  sharedCodeUsageCap: z.number().int().positive().optional(),
  channels: z.array(channelSchema).min(1),
});

export const offerMappingInputSchema = z.strictObject({
  channel: channelSchema,
  paidSlots: z.number().int().min(1).max(12),
  status: z.enum(['pending', 'ready', 'failed', 'unsupported']),
  providerOfferId: z.string().min(1).max(200).nullable(),
  reason: z.string().max(300).nullable(),
});

export const generationRequestSchema = z.strictObject({ month: calendarMonthSchema });

export const promoTemplateSchema = promoTemplateInputSchema.extend({
  id: uuidSchema,
  enabled: z.boolean(),
  paused: z.boolean(),
  createdAt: isoDateTimeSchema,
});

export const listPromoTemplatesResponseSchema = z.strictObject({
  templates: z.array(promoTemplateSchema),
});

export const activationResultSchema = z.strictObject({
  ok: z.boolean(),
  /** Domain rule codes that block activation (e.g. TIMEZONE_NOT_CONFIRMED). */
  problems: z.array(z.string()),
});

export const generationPreviewItemSchema = z.strictObject({
  templateId: uuidSchema,
  templateName: z.string(),
  generationKey: z.string(),
  percentOff: z.number().int(),
  opensAt: isoDateTimeSchema,
  closesAt: isoDateTimeSchema,
  codeCount: z.number().int().nonnegative(),
  alreadyGenerated: z.boolean(),
});

export const generationPreviewResponseSchema = z.strictObject({
  month: calendarMonthSchema,
  items: z.array(generationPreviewItemSchema),
});

export const generationRunResponseSchema = z.strictObject({
  month: calendarMonthSchema,
  created: z.array(
    z.strictObject({
      campaignId: uuidSchema,
      generationKey: z.string(),
      codeCount: z.number().int(),
    }),
  ),
  skippedExisting: z.array(z.string()),
});

export const campaignStatusSchema = z.enum([
  'provisioning',
  'active',
  'paused',
  'revoked',
  'ended',
  'failed',
]);

export const campaignSummarySchema = z.strictObject({
  id: uuidSchema,
  templateId: uuidSchema,
  campaignMonth: calendarMonthSchema,
  status: campaignStatusSchema,
  percentOff: z.number().int(),
  schoolId: uuidSchema.nullable(),
  opensAt: isoDateTimeSchema,
  closesAt: isoDateTimeSchema,
  redemptionCap: z.number().int(),
  liveRedemptions: z.number().int(),
  confirmedRedemptions: z.number().int(),
  budgetCapCents: centsSchema,
  committedDiscountCents: centsSchema,
  offerMappings: z.array(
    z.strictObject({
      channel: channelSchema,
      paidSlots: z.number().int(),
      status: z.enum(['pending', 'ready', 'failed', 'unsupported']),
      providerOfferId: z.string().nullable(),
      reason: z.string().nullable(),
    }),
  ),
});

export const listCampaignsResponseSchema = z.strictObject({
  campaigns: z.array(campaignSummarySchema),
});

export const campaignCodesResponseSchema = z.strictObject({
  campaignId: uuidSchema,
  /** Shared codes are shown formatted (e.g. ABCDE-FGHJK-X); individual codes are exported, not listed. */
  codes: z.array(
    z.strictObject({
      id: uuidSchema,
      code: z.string(),
      usageCap: z.number().int().nullable(),
      status: z.enum(['active', 'revoked']),
    }),
  ),
});

export const campaignActionSchema = z.strictObject({
  action: z.enum(['pause', 'resume', 'revoke']),
});

export const schoolAdminSchema = z.strictObject({
  id: uuidSchema,
  name: z.string(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  status: z.enum(['pending_verification', 'active', 'inactive']),
  recipientVerified: z.boolean(),
});

export const listAdminSchoolsResponseSchema = z.strictObject({
  schools: z.array(schoolAdminSchema),
});

export const createSchoolRequestSchema = z.strictObject({
  name: z.string().trim().min(2).max(160),
  city: z.string().trim().max(80).nullable(),
  region: z.string().trim().max(40).nullable(),
});

/** Owner verification of a school listing and, separately, of its payout recipient (out of band). */
export const updateSchoolRequestSchema = z
  .strictObject({
    status: z.enum(['active', 'inactive']).optional(),
    recipientVerified: z.boolean().optional(),
    /** Where the verification evidence is kept (never banking details). */
    verificationNote: z.string().trim().min(3).max(300),
  })
  .refine((v) => v.status !== undefined || v.recipientVerified !== undefined, {
    message: 'Nothing to change',
  });

export const schoolMonthReportSchema = z.strictObject({
  schoolId: uuidSchema,
  month: calendarMonthSchema,
  /** Counts are strings because school-facing views may show "<5" (privacy suppression). */
  attributedSignups: z.string(),
  donationEligibleFamilies: z.string(),
  /** Designated families with a subscription period starting this month (AC_PROMO_10). */
  activeFamilies: z.string(),
  positivePayingFamilies: z.string(),
  fullyDiscountedFamilies: z.string(),
  accruedCents: z.number().int().nullable(),
  paidCents: z.number().int().nullable(),
});

export const payoutBatchSchema = z.strictObject({
  id: uuidSchema,
  schoolId: uuidSchema,
  batchKey: z.string(),
  totalCents: centsSchema,
  status: z.enum(['accrued', 'approved', 'paid', 'failed', 'adjusted']),
  externalTransferRef: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});

export const listPayoutsResponseSchema = z.strictObject({ payouts: z.array(payoutBatchSchema) });

export const preparePayoutRequestSchema = z.strictObject({
  schoolId: uuidSchema,
  throughMonth: calendarMonthSchema,
});

export const preparePayoutResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('created'), payout: payoutBatchSchema }),
  z.strictObject({ status: z.literal('carried_forward'), netCents: z.number().int() }),
]);

export const markPayoutPaidRequestSchema = z.strictObject({
  externalTransferRef: z.string().min(3).max(200),
});
