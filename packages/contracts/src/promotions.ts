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
