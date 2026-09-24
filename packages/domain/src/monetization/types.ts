// Shared vocabulary for the P16 monetization module. Values mirror the check constraints in
// supabase/migrations/0640_monetization.sql; a change here needs the matching migration change.

export const MONETIZATION_PLATFORMS = ['ios', 'android', 'web'] as const;
export type MonetizationPlatform = (typeof MONETIZATION_PLATFORMS)[number];

/** Spec P16.1: the only permitted commercial surfaces (reauthenticated adult areas). */
export const PLACEMENTS = ['adult_dashboard', 'resources_browse'] as const;
export type Placement = (typeof PLACEMENTS)[number];

export const MONETIZATION_PROVIDERS = [
  'sponsor_direct',
  'amazon_associates',
  'ad_network',
] as const;
export type MonetizationProvider = (typeof MONETIZATION_PROVIDERS)[number];

export const SWITCH_KEYS = [
  'global',
  'provider:sponsor_direct',
  'provider:amazon_associates',
  'provider:ad_network',
] as const;
export type SwitchKey = (typeof SWITCH_KEYS)[number];

/** Missing keys are OFF: every switch fails closed. */
export type MonetizationSwitches = Readonly<Partial<Record<SwitchKey, boolean>>>;

export const MERCHANT_MODES = ['education_only', 'plain_link', 'amazon_associates'] as const;
export type MerchantMode = (typeof MERCHANT_MODES)[number];

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'revoked', 'expired'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const CAMPAIGN_STATES = [
  'draft',
  'in_review',
  'scheduled',
  'active',
  'paused',
  'ended',
  'rejected',
] as const;
export type CampaignState = (typeof CAMPAIGN_STATES)[number];

export const CREATIVE_REVIEW_STATUSES = ['draft', 'in_review', 'approved', 'rejected'] as const;
export type CreativeReviewStatus = (typeof CREATIVE_REVIEW_STATUSES)[number];

export const AD_EVENT_KINDS = [
  'opportunity',
  'served',
  'viewable_impression',
  'click',
  'dismiss',
  'report',
] as const;
export type AdEventKind = (typeof AD_EVENT_KINDS)[number];

export const AD_REPORT_CATEGORIES = ['inappropriate', 'misleading', 'irrelevant', 'other'] as const;
export type AdReportCategory = (typeof AD_REPORT_CATEGORIES)[number];

export const RESOURCE_KINDS = [
  'workbook',
  'flashcards',
  'manipulative',
  'parent_exercise',
  'in_app_practice',
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** Free learning options: never carry a merchant link (spec P10). */
export const FREE_RESOURCE_KINDS: readonly ResourceKind[] = ['parent_exercise', 'in_app_practice'];

export const MERCHANTS = ['amazon', 'other', 'none'] as const;
export type Merchant = (typeof MERCHANTS)[number];

export const RESOURCE_AVAILABILITY = ['available', 'unavailable', 'unknown'] as const;
export type ResourceAvailability = (typeof RESOURCE_AVAILABILITY)[number];

export const RESOURCE_STATUSES = ['draft', 'approved', 'retired'] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

/** The six supported subject areas (spec P6), same keys as child_subjects.subject_key. */
export const RESOURCE_SUBJECTS = [
  'math',
  'reading',
  'spelling_vocabulary',
  'grammar_writing',
  'science',
  'social_studies',
] as const;
export type ResourceSubject = (typeof RESOURCE_SUBJECTS)[number];

export const REVENUE_SOURCES = [
  'sponsor_invoice',
  'amazon_report',
  'ad_network',
  'manual',
] as const;
export type RevenueSource = (typeof REVENUE_SOURCES)[number];

export const REVENUE_CATEGORIES = [
  'projected',
  'contracted',
  'recognized',
  'received',
  'affiliate_reported',
] as const;
export type RevenueCategory = (typeof REVENUE_CATEGORIES)[number];

export const REVENUE_ADJUSTMENT_KINDS = ['refund', 'reversal', 'correction'] as const;
export type RevenueAdjustmentKind = (typeof REVENUE_ADJUSTMENT_KINDS)[number];

export type MonetizationEnvironment = 'development' | 'test' | 'staging' | 'production';

/** Placement display rule (placement_rules row). */
export interface PlacementRule {
  readonly enabled: boolean;
  /** Always 1 (spec P16.1: at most one commercial card per screen). */
  readonly maxCardsPerScreen: 1;
  readonly maxNewCardsPerSession: number;
  readonly minVisibleMs: number;
  /** 0..1 share of the card's area that must be on screen. */
  readonly minVisibleRatio: number;
}

export const DEFAULT_PLACEMENT_RULE: PlacementRule = {
  enabled: true,
  maxCardsPerScreen: 1,
  maxNewCardsPerSession: 3,
  minVisibleMs: 1000,
  minVisibleRatio: 0.5,
};

/** Disclosure copy (spec P16.1, P16.3). The Associates sentence is Amazon's required wording. */
export const AMAZON_ASSOCIATES_DISCLOSURE =
  'As an Amazon Associate I earn from qualifying purchases.';
export const PLAIN_LINK_DISCLOSURE = 'External link';
export const AMAZON_PRICE_NOTE = 'Check current price on Amazon.';

/** Minimum cohort shown in owner aggregate reports; smaller non-zero counts are suppressed. */
export const AGGREGATE_REPORT_MIN_COUNT = 10;

/** Short-lived anti-duplication/frequency state (private.placement_serves) retention. */
export const PLACEMENT_SERVE_RETENTION_DAYS = 7;
