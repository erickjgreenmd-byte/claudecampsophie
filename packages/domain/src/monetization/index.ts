// P16 monetization rules: provider/policy gates, merchant modes and outbound links, educational
// resource ranking, sponsor card selection and viewability, creative validation, the campaign
// workflow and owner revenue reporting. Pure functions: no I/O, clock or randomness.
export * from './types.ts';
export {
  AMAZON_MOBILE_PLATFORMS,
  FIXTURE_EVIDENCE_PREFIX,
  NON_IDENTIFYING_WORDS,
  PUBLISHER_TAG_PATTERN,
  approvalEvidenceQuality,
  evidenceQuality,
  isValidPublisherTag,
  linkingToolQuality,
  providerGate,
  requiresLinkingTool,
  resolveMerchantMode,
  type EvidenceContext,
  type EvidenceQuality,
  type GateContext,
  type GateReason,
  type MerchantModeInput,
  type MerchantModeResult,
  type MonetizationApproval,
  type MonetizationProperty,
  type ProviderGateResult,
} from './gates.ts';
export {
  AMAZON_HOSTS,
  OTHER_MERCHANT_HOSTS,
  buildOutboundUrl,
  canonicalAmazonProductUrl,
  canonicalOtherMerchantUrl,
  type LinkErrorCode,
  type OutboundItem,
} from './links.ts';
export {
  effectiveItemMode,
  rankResources,
  relevanceScore,
  type ItemModeContext,
  type RankableResource,
  type RankedResource,
  type ResourceQuery,
} from './ranking.ts';
export {
  ALLOWED_CAMPAIGN_TRANSITIONS,
  campaignServableReason,
  campaignTransition,
  type CampaignEvent,
  type CampaignTransitionCode,
  type NotServableReason,
  type ServableCampaignFacts,
} from './campaigns.ts';
export {
  MAX_NEW_CARDS_PER_SESSION,
  MAX_SERVE_AGE_FOR_VIEW_MS,
  VIEW_TIMING_TOLERANCE_MS,
  countViewable,
  selectSponsorCard,
  type NoCardReason,
  type SponsorSelection,
  type SponsorSelectionInput,
  type ViewabilityOutcome,
} from './placements.ts';
export {
  CREATIVE_LIMITS,
  FIRST_PARTY_ASSET_KEY,
  isValidDomain,
  validateCreative,
  type CreativeInput,
  type CreativeProblem,
  type CreativeProblemCode,
} from './creatives.ts';
export {
  adjustmentAllowed,
  revenueSummary,
  suppressSmallCount,
  type DoubleCountConflict,
  type RevenueAdjustmentFact,
  type RevenueCohorts,
  type RevenueEntryFact,
  type RevenueSummary,
} from './revenue.ts';
