import { campaignServableReason, type ServableCampaignFacts } from './campaigns.ts';
import { providerGate, type GateReason, type MonetizationApproval } from './gates.ts';
import type {
  MonetizationEnvironment,
  MonetizationPlatform,
  MonetizationSwitches,
  Placement,
  PlacementRule,
} from './types.ts';

/**
 * Sponsor card selection (spec P16.1, AC_MON_03/05/07/14). The input carries placement context,
 * owner gates and first-party frequency state only: there is no field through which a child's
 * grades, mistakes, profile, age or learning history could influence paid-ad selection.
 */
export interface SponsorSelectionInput<C extends ServableCampaignFacts = ServableCampaignFacts> {
  readonly campaigns: readonly C[];
  readonly placement: Placement;
  readonly platform: MonetizationPlatform;
  readonly propertyIdentifier: string;
  readonly locale: string;
  readonly environment: MonetizationEnvironment;
  readonly now: Date;
  /** New cards already served in this parent auth session (any placement). */
  readonly servedThisSession: number;
  readonly servedCampaignIdsThisSession: readonly string[];
  readonly dismissedCampaignIdsThisSession: readonly string[];
  readonly rule: PlacementRule;
  readonly prefs: { readonly hideSponsorCards: boolean };
  /** The family holds a verified ad-free entitlement (server-side, restored across devices). */
  readonly adFree: boolean;
  readonly switches: MonetizationSwitches;
  readonly approvals: readonly MonetizationApproval[];
}

export type NoCardReason =
  'disabled' | 'ad_free' | 'session_cap' | 'hidden_by_parent' | 'no_eligible';

export type SponsorSelection<C extends ServableCampaignFacts = ServableCampaignFacts> =
  | { readonly kind: 'card'; readonly campaign: C }
  | {
      readonly kind: 'no_card';
      readonly reason: NoCardReason;
      readonly gateReasons: readonly GateReason[];
    };

/** Hard ceiling from the spec default; a placement rule can lower but never raise it. */
export const MAX_NEW_CARDS_PER_SESSION = 3;

export function selectSponsorCard<C extends ServableCampaignFacts>(
  input: SponsorSelectionInput<C>,
): SponsorSelection<C> {
  const gate = providerGate('sponsor_direct', {
    environment: input.environment,
    property: {
      platform: input.platform,
      identifier: input.propertyIdentifier,
      locale: input.locale,
    },
    approvals: input.approvals,
    switches: input.switches,
    now: input.now,
  });
  if (!gate.enabled || !input.rule.enabled) {
    return { kind: 'no_card', reason: 'disabled', gateReasons: gate.reasons };
  }
  if (input.adFree) return { kind: 'no_card', reason: 'ad_free', gateReasons: [] };
  if (input.prefs.hideSponsorCards) {
    return { kind: 'no_card', reason: 'hidden_by_parent', gateReasons: [] };
  }
  const cap = Math.min(Math.max(0, input.rule.maxNewCardsPerSession), MAX_NEW_CARDS_PER_SESSION);
  if (input.servedThisSession >= cap) {
    return { kind: 'no_card', reason: 'session_cap', gateReasons: [] };
  }
  const dismissed = new Set(input.dismissedCampaignIdsThisSession);
  const served = new Set(input.servedCampaignIdsThisSession);
  const eligible = input.campaigns.filter(
    (c) =>
      !dismissed.has(c.id) &&
      campaignServableReason(c, {
        placement: input.placement,
        platform: input.platform,
        now: input.now,
      }) === null,
  );
  if (eligible.length === 0) return { kind: 'no_card', reason: 'no_eligible', gateReasons: [] };
  // Deterministic rotation: unseen this session first, then the least-delivered share of its cap.
  const sorted = [...eligible].sort((a, b) => {
    const seen = Number(served.has(a.id)) - Number(served.has(b.id));
    if (seen !== 0) return seen;
    const fill = a.viewableImpressions * b.impressionCap - b.viewableImpressions * a.impressionCap;
    if (fill !== 0) return fill;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return { kind: 'card', campaign: sorted[0]! };
}

export type ViewabilityOutcome =
  | { readonly counted: true }
  | {
      readonly counted: false;
      readonly reason:
        | 'invalid_measurement'
        | 'already_counted'
        | 'stale_serve'
        | 'implausible_duration'
        | 'below_min_duration'
        | 'below_min_ratio';
    };

/** A serve older than this cannot be counted (replayed or long-hidden cards are not billable). */
export const MAX_SERVE_AGE_FOR_VIEW_MS = 30 * 60 * 1000;
/** Clock skew allowance between the client's visibility timer and the server's serve time. */
export const VIEW_TIMING_TOLERANCE_MS = 1000;

/**
 * Documented visible-duration rule (spec P16.5, AC_MON_16): a served card counts as one viewable
 * impression only once, only when at least `minVisibleRatio` of it was on screen for at least
 * `minVisibleMs`, and only if that duration fits between the serve and now (a prefetched or
 * replayed card cannot claim visibility it never had).
 */
export function countViewable(input: {
  readonly servedAt: Date;
  readonly viewedAt: Date | null;
  readonly now: Date;
  readonly visibleMs: number;
  readonly visibleRatio: number;
  readonly rule: Pick<PlacementRule, 'minVisibleMs' | 'minVisibleRatio'>;
}): ViewabilityOutcome {
  const { visibleMs, visibleRatio } = input;
  if (
    !Number.isFinite(visibleMs) ||
    !Number.isFinite(visibleRatio) ||
    visibleMs < 0 ||
    visibleRatio < 0 ||
    visibleRatio > 1
  ) {
    return { counted: false, reason: 'invalid_measurement' };
  }
  if (input.viewedAt !== null) return { counted: false, reason: 'already_counted' };
  const age = input.now.getTime() - input.servedAt.getTime();
  if (age > MAX_SERVE_AGE_FOR_VIEW_MS) return { counted: false, reason: 'stale_serve' };
  if (visibleMs > Math.max(0, age) + VIEW_TIMING_TOLERANCE_MS) {
    return { counted: false, reason: 'implausible_duration' };
  }
  if (visibleMs < input.rule.minVisibleMs) return { counted: false, reason: 'below_min_duration' };
  if (visibleRatio < input.rule.minVisibleRatio)
    return { counted: false, reason: 'below_min_ratio' };
  return { counted: true };
}
