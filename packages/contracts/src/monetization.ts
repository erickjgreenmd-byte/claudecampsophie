import { z } from 'zod';
import { calendarMonthSchema, isoDateTimeSchema, uuidSchema } from './common.ts';

// Contracts for the P16 monetization module: adult-only placement/resource routes and owner-only
// administration. Every object is strict; parent DTOs never carry campaign economics, family,
// child or session identifiers, and no child route returns any of these shapes.

export const monetizationPlatformSchema = z.enum(['ios', 'android', 'web']);
export const placementSchema = z.enum(['adult_dashboard', 'resources_browse']);
export const merchantModeSchema = z.enum(['education_only', 'plain_link', 'amazon_associates']);
export const monetizationProviderSchema = z.enum([
  'sponsor_direct',
  'amazon_associates',
  'ad_network',
]);
export const monetizationSwitchKeySchema = z.enum([
  'global',
  'provider:sponsor_direct',
  'provider:amazon_associates',
  'provider:ad_network',
]);
export const adReportCategorySchema = z.enum([
  'inappropriate',
  'misleading',
  'irrelevant',
  'other',
]);
export const resourceSubjectSchema = z.enum([
  'math',
  'reading',
  'spelling_vocabulary',
  'grammar_writing',
  'science',
  'social_studies',
]);
export const resourceKindSchema = z.enum([
  'workbook',
  'flashcards',
  'manipulative',
  'parent_exercise',
  'in_app_practice',
]);
export const merchantSchema = z.enum(['amazon', 'other', 'none']);
export const resourceAvailabilitySchema = z.enum(['available', 'unavailable', 'unknown']);
export const localeSchema = z.string().regex(/^[a-z]{2}-[A-Z]{2}$/, 'Expected a locale like en-US');
/** Opaque single-use serve token (base64url, 256-bit). */
export const serveTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const skillKeySchema = z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,63}$/);
const domainSchema = z
  .string()
  .max(253)
  .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/, 'Expected a lowercase domain');
const assetKeySchema = z.string().regex(/^[a-z0-9][a-z0-9/_.-]{2,200}$/);
const cents = z.number().int().min(0).max(2_000_000_000);

// ---------------------------------------------------------------------------------------------
// Parent (adult, recently unlocked) routes
// ---------------------------------------------------------------------------------------------

export const placementQuerySchema = z.strictObject({
  placement: placementSchema,
  platform: monetizationPlatformSchema,
  locale: localeSchema.optional(),
});

export const sponsorCardSchema = z.strictObject({
  serveToken: serveTokenSchema,
  placement: placementSchema,
  /** "Sponsored by <business>" — always shown with the card. */
  label: z.string().min(1).max(160),
  headline: z.string().max(80),
  body: z.string().max(240),
  ctaLabel: z.string().max(24),
  /** Destination host shown before the adult chooses to leave the app. */
  destinationHost: z.string().max(253),
  /** First-party asset key (our storage), never a remote advertiser URL. */
  imageAssetRef: z.string().max(201).nullable(),
  whyShown: z.string().max(200),
});

export const placementNoCardReasonSchema = z.enum([
  'disabled',
  'ad_free',
  'session_cap',
  'hidden_by_parent',
  'no_eligible',
]);

export const placementResponseSchema = z.strictObject({
  card: sponsorCardSchema.nullable(),
  reason: z.union([z.literal('served'), placementNoCardReasonSchema]),
});

export const placementViewedRequestSchema = z.strictObject({
  visibleMs: z.number().int().min(0).max(3_600_000),
  visibleRatio: z.number().min(0).max(1),
});

export const placementViewedResponseSchema = z.strictObject({
  counted: z.boolean(),
  reason: z.string().max(40).nullable(),
});

export const placementReportRequestSchema = z.strictObject({ category: adReportCategorySchema });

/** Sponsor destination opened in the system browser after a deliberate adult tap. */
export const placementClickResponseSchema = z.strictObject({
  url: z.url({ protocol: /^https$/ }),
});

export const outboundUrlResponseSchema = z.strictObject({
  url: z.url({ protocol: /^https$/ }),
  mode: merchantModeSchema,
  disclosure: z.string().max(120).nullable(),
});

export const resourcesQuerySchema = z.strictObject({
  platform: monetizationPlatformSchema,
  subject: resourceSubjectSchema.optional(),
  grade: z.coerce.number().int().min(0).max(12).optional(),
  skill: skillKeySchema.optional(),
  locale: localeSchema.optional(),
});

export const resourceItemSchema = z.strictObject({
  id: uuidSchema,
  title: z.string(),
  description: z.string(),
  kind: resourceKindSchema,
  subjects: z.array(resourceSubjectSchema),
  skills: z.array(z.string()),
  gradeMin: z.number().int(),
  gradeMax: z.number().int(),
  relevance: z.number().int(),
  mode: merchantModeSchema,
  merchant: merchantSchema,
  /** Adjacent disclosure; the Associates sentence only in amazon_associates mode. */
  disclosure: z.string().nullable(),
  /** Prices are never shown: no authorized refreshed price source exists. */
  price: z.null(),
  priceNote: z.string().nullable(),
  availability: resourceAvailabilitySchema,
  imageAssetRef: z.string().nullable(),
});

export const resourcesResponseSchema = z.strictObject({
  mode: merchantModeSchema,
  commercialHidden: z.boolean(),
  items: z.array(resourceItemSchema),
});

export const monetizationPreferencesSchema = z.strictObject({
  hideAffiliate: z.boolean(),
  hideSponsorCards: z.boolean(),
});

// ---------------------------------------------------------------------------------------------
// Owner admin routes (MFA session + owner admin)
// ---------------------------------------------------------------------------------------------

export const sponsorInputSchema = z.strictObject({
  businessName: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .regex(/^[^<>]*$/),
  contactRef: z.string().trim().max(200).nullable(),
  allowedDomains: z.array(domainSchema).min(1).max(20),
});

export const sponsorPatchSchema = sponsorInputSchema
  .partial()
  .extend({ status: z.enum(['active', 'suspended']).optional() });

export const sponsorSchema = z.strictObject({
  id: uuidSchema,
  businessName: z.string(),
  contactRef: z.string().nullable(),
  allowedDomains: z.array(z.string()),
  status: z.enum(['active', 'suspended']),
  createdAt: isoDateTimeSchema,
});

export const creativeInputSchema = z.strictObject({
  headline: z.string().max(200),
  body: z.string().max(600),
  ctaLabel: z.string().max(100),
  destinationUrl: z.string().max(600),
  imageAssetRef: z.string().max(300).nullable(),
  imageLicenseRef: z.string().max(200).nullable(),
});

export const creativeReviewSchema = z.strictObject({ note: z.string().trim().max(500).optional() });

export const creativeSchema = z.strictObject({
  id: uuidSchema,
  sponsorId: uuidSchema,
  version: z.number().int().min(1),
  /** The reviewed "Sponsored by" name, frozen with this version (a sponsor rename needs a new one). */
  sponsorName: z.string(),
  headline: z.string(),
  body: z.string(),
  ctaLabel: z.string(),
  destinationUrl: z.string(),
  imageAssetRef: z.string().nullable(),
  imageLicenseRef: z.string().nullable(),
  reviewStatus: z.enum(['draft', 'in_review', 'approved', 'rejected']),
  selfReviewed: z.boolean(),
  reviewedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});

export const campaignStateSchema = z.enum([
  'draft',
  'in_review',
  'scheduled',
  'active',
  'paused',
  'ended',
  'rejected',
]);

export const campaignInputSchema = z.strictObject({
  sponsorId: uuidSchema,
  creativeId: uuidSchema,
  name: z.string().trim().min(1).max(120),
  placement: placementSchema,
  platforms: z.array(monetizationPlatformSchema).min(1).max(3),
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  impressionCap: z.number().int().min(1).max(100_000_000),
  feeModel: z.enum(['fixed_fee', 'none']),
  contractedFeeCents: cents,
});

export const campaignPatchSchema = z.strictObject({
  creativeId: uuidSchema.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  placement: placementSchema.optional(),
  platforms: z.array(monetizationPlatformSchema).min(1).max(3).optional(),
  startsAt: isoDateTimeSchema.optional(),
  endsAt: isoDateTimeSchema.optional(),
  impressionCap: z.number().int().min(1).max(100_000_000).optional(),
  invoiceStatus: z.enum(['not_invoiced', 'invoiced', 'paid', 'void']).optional(),
});

export const campaignTransitionRequestSchema = z.strictObject({
  action: z.enum(['submit', 'approve', 'reject', 'activate', 'pause', 'resume', 'end', 'revise']),
  reason: z.string().trim().min(3).max(200).optional(),
});

export const campaignSchema = z.strictObject({
  id: uuidSchema,
  sponsorId: uuidSchema,
  creativeId: uuidSchema,
  name: z.string(),
  placement: placementSchema,
  platforms: z.array(monetizationPlatformSchema),
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  impressionCap: z.number().int(),
  feeModel: z.enum(['fixed_fee', 'none']),
  contractedFeeCents: z.number().int(),
  invoiceStatus: z.enum(['not_invoiced', 'invoiced', 'paid', 'void']),
  status: campaignStateSchema,
  pausedReason: z.string().nullable(),
  /** Whether a parent could be shown this campaign right now (gates excluded). */
  servableNow: z.boolean(),
  notServableReason: z.string().nullable(),
  viewableImpressions: z.number().int(),
});

export const approvalInputSchema = z.strictObject({
  provider: monetizationProviderSchema,
  platform: monetizationPlatformSchema,
  propertyIdentifier: z.string().trim().min(3).max(200),
  locale: localeSchema,
  intendedAudience: z.string().trim().min(3).max(200),
  vendorSdkVersion: z.string().trim().min(1).max(60).nullable(),
  policyReviewedAt: isoDateTimeSchema,
  evidenceRef: z.string().trim().min(6).max(300),
  approvalScope: z.string().trim().min(3).max(500),
  publisherTag: z.string().trim().max(64).nullable(),
  /**
   * Amazon only: reference to the recorded determination of which Amazon-permitted linking
   * tool/API the property may use. Required before mobile (iOS/Android) affiliate mode can run.
   */
  linkingToolRef: z.string().trim().min(6).max(300).nullable().optional(),
  status: z.enum(['pending', 'approved', 'rejected']),
  expiresAt: isoDateTimeSchema,
});

export const approvalStatusChangeSchema = z.strictObject({
  reason: z.string().trim().min(3).max(300),
});

export const approvalSchema = z.strictObject({
  id: uuidSchema,
  provider: monetizationProviderSchema,
  platform: monetizationPlatformSchema,
  propertyIdentifier: z.string(),
  locale: z.string(),
  intendedAudience: z.string(),
  vendorSdkVersion: z.string().nullable(),
  policyReviewedAt: isoDateTimeSchema,
  evidenceRef: z.string(),
  /** 'fixture' evidence is a labeled development/test mock and never counts in production. */
  evidenceQuality: z.enum(['real', 'fixture', 'invalid']),
  approvalScope: z.string(),
  publisherTag: z.string().nullable(),
  linkingToolRef: z.string().nullable(),
  status: z.enum(['pending', 'approved', 'rejected', 'revoked', 'expired']),
  statusReason: z.string().nullable(),
  expiresAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
});

export const switchSchema = z.strictObject({
  key: monetizationSwitchKeySchema,
  enabled: z.boolean(),
  changedAt: isoDateTimeSchema,
  reason: z.string().nullable(),
});

export const switchUpdateSchema = z.strictObject({
  enabled: z.boolean(),
  reason: z.string().trim().min(3).max(300),
});

/** Live status per provider/platform: blocked unless every gate passes (never claims "live"). */
export const monetizationStatusSchema = z.strictObject({
  environment: z.string(),
  switches: z.array(switchSchema),
  providers: z.array(
    z.strictObject({
      provider: monetizationProviderSchema,
      platform: monetizationPlatformSchema,
      propertyIdentifier: z.string(),
      enabled: z.boolean(),
      fixture: z.boolean(),
      reasons: z.array(z.string()),
    }),
  ),
});

export const placementRuleSchema = z.strictObject({
  placement: placementSchema,
  maxCardsPerScreen: z.literal(1),
  maxNewCardsPerSession: z.number().int().min(0).max(3),
  minVisibleMs: z.number().int().min(1000).max(60_000),
  minVisibleRatio: z.number().min(0.5).max(1),
  enabled: z.boolean(),
});

export const placementRuleUpdateSchema = placementRuleSchema.omit({ placement: true });

export const catalogInputSchema = z.strictObject({
  stableKey: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  title: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .regex(/^[^<>]*$/),
  description: z
    .string()
    .trim()
    .min(10)
    .max(600)
    .regex(/^[^<>]*$/),
  skills: z.array(skillKeySchema).max(20),
  subjects: z.array(resourceSubjectSchema).min(1).max(6),
  gradeMin: z.number().int().min(0).max(12),
  gradeMax: z.number().int().min(0).max(12),
  kind: resourceKindSchema,
  merchant: merchantSchema,
  merchantUrl: z.string().max(2000).nullable(),
  imageAssetRef: assetKeySchema.nullable(),
  imageLicenseRef: z.string().trim().min(6).max(200).nullable(),
});

export const catalogPatchSchema = catalogInputSchema.omit({ stableKey: true }).partial();

export const catalogItemSchema = z.strictObject({
  id: uuidSchema,
  stableKey: z.string(),
  title: z.string(),
  description: z.string(),
  skills: z.array(z.string()),
  subjects: z.array(resourceSubjectSchema),
  gradeMin: z.number().int(),
  gradeMax: z.number().int(),
  kind: resourceKindSchema,
  merchant: merchantSchema,
  merchantUrl: z.string().nullable(),
  imageAssetRef: z.string().nullable(),
  imageLicenseRef: z.string().nullable(),
  availability: resourceAvailabilitySchema,
  lastLinkCheckAt: isoDateTimeSchema.nullable(),
  lastLinkCheckStatus: z.enum(['ok', 'broken', 'error', 'skipped']).nullable(),
  status: z.enum(['draft', 'approved', 'retired']),
  reviewedAt: isoDateTimeSchema.nullable(),
});

export const linkCheckResponseSchema = z.strictObject({
  status: z.enum(['ok', 'broken', 'error', 'skipped']),
  httpStatus: z.number().int().nullable(),
  availability: resourceAvailabilitySchema,
  /** A skipped check never touched the network (e.g. in tests or without a URL). */
  note: z.string().nullable(),
});

export const revenueImportRowSchema = z.strictObject({
  externalRef: z.string().trim().min(1).max(200),
  category: z.enum(['projected', 'contracted', 'recognized', 'received', 'affiliate_reported']),
  provider: monetizationProviderSchema,
  campaignId: uuidSchema.nullable(),
  placement: placementSchema.nullable(),
  amountCents: cents,
  periodMonth: calendarMonthSchema.optional(),
});

export const revenueImportRequestSchema = z.strictObject({
  source: z.enum(['sponsor_invoice', 'amazon_report', 'ad_network', 'manual']),
  periodMonth: calendarMonthSchema,
  note: z.string().trim().max(300).nullable(),
  rows: z.array(revenueImportRowSchema).min(1).max(2000),
});

export const revenueImportResponseSchema = z.strictObject({
  importId: uuidSchema,
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
  rowCount: z.number().int(),
});

export const revenueAdjustmentRequestSchema = z.strictObject({
  entryId: uuidSchema,
  kind: z.enum(['refund', 'reversal', 'correction']),
  amountCents: z
    .number()
    .int()
    .min(-2_000_000_000)
    .max(2_000_000_000)
    .refine((v) => v !== 0, 'An adjustment cannot be zero'),
  reason: z.string().trim().min(3).max(300),
  idempotencyKey: z
    .string()
    .min(8)
    .max(200)
    .regex(/^[A-Za-z0-9_:-]+$/),
});

export const revenueSummarySchema = z.strictObject({
  projectedCents: z.number().int(),
  contractedCents: z.number().int(),
  recognizedCents: z.number().int(),
  receivedCents: z.number().int(),
  affiliateReportedCents: z.number().int(),
  adjustments: z.strictObject({
    refund: z.number().int(),
    reversal: z.number().int(),
    correction: z.number().int(),
  }),
  excludedDoubleCountCents: z.number().int(),
  conflicts: z.array(
    z.strictObject({
      category: z.string(),
      placement: placementSchema,
      periodMonth: calendarMonthSchema,
      excludedNetworkCents: z.number().int(),
    }),
  ),
  activeFamilies: z.number().int(),
  adEligibleAdults: z.number().int(),
  recognizedPerActiveFamilyCents: z.number().int().nullable(),
  recognizedPerAdEligibleAdultCents: z.number().int().nullable(),
});

export const aggregateEventRowSchema = z.strictObject({
  campaignId: uuidSchema.nullable(),
  catalogId: uuidSchema.nullable(),
  platform: monetizationPlatformSchema,
  placement: placementSchema,
  kind: z.enum(['opportunity', 'served', 'viewable_impression', 'click', 'dismiss', 'report']),
  /** Null when suppressed (non-zero count below the minimum cohort). */
  count: z.number().int().nullable(),
  suppressed: z.boolean(),
});

export const monetizationReportSchema = z.strictObject({
  month: calendarMonthSchema,
  minCohort: z.number().int(),
  events: z.array(aggregateEventRowSchema),
  revenue: revenueSummarySchema,
  /** Always true: amounts come from imports, never inferred from clicks or impressions. */
  revenueFromImportsOnly: z.literal(true),
});

export const adReportSchema = z.strictObject({
  id: uuidSchema,
  campaignId: uuidSchema.nullable(),
  catalogId: uuidSchema.nullable(),
  category: adReportCategorySchema,
  platform: monetizationPlatformSchema,
  placement: placementSchema,
  createdDate: z.iso.date(),
  status: z.enum(['open', 'reviewed']),
});

export type SponsorCard = z.infer<typeof sponsorCardSchema>;
export type PlacementResponse = z.infer<typeof placementResponseSchema>;
export type ResourceItem = z.infer<typeof resourceItemSchema>;
export type ResourcesResponse = z.infer<typeof resourcesResponseSchema>;
export type MonetizationPreferences = z.infer<typeof monetizationPreferencesSchema>;
export type OutboundUrlResponse = z.infer<typeof outboundUrlResponseSchema>;
export type MonetizationReport = z.infer<typeof monetizationReportSchema>;
