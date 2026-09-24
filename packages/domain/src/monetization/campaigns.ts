import { err, ok, type Result } from '../shared/result.ts';
import type { CampaignState, MonetizationPlatform, Placement } from './types.ts';

/**
 * Sponsor campaign workflow (spec P16.5): draft -> human review -> scheduled -> active ->
 * paused/ended/rejected. Changing the creative always sends a reviewed campaign back to review.
 * The database trigger app.guard_sponsor_campaign() mirrors ALLOWED_CAMPAIGN_TRANSITIONS.
 */

export type CampaignEvent =
  | { readonly type: 'submit' }
  | { readonly type: 'approve'; readonly creativeApproved: boolean }
  | { readonly type: 'reject' }
  | {
      readonly type: 'activate';
      readonly creativeApproved: boolean;
      readonly now: Date;
      readonly endsAt: Date;
    }
  | { readonly type: 'pause' }
  | { readonly type: 'resume'; readonly now: Date; readonly endsAt: Date }
  | { readonly type: 'end' }
  | { readonly type: 'creative_changed' }
  | { readonly type: 'revise' };

export type CampaignTransitionCode =
  'INVALID_TRANSITION' | 'CREATIVE_NOT_APPROVED' | 'CAMPAIGN_ENDED';

/** Every state change the workflow (and the DB guard) permits. */
export const ALLOWED_CAMPAIGN_TRANSITIONS: Readonly<
  Record<CampaignState, readonly CampaignState[]>
> = {
  draft: ['in_review'],
  in_review: ['scheduled', 'rejected'],
  scheduled: ['active', 'paused', 'ended', 'in_review'],
  active: ['paused', 'ended', 'in_review'],
  paused: ['active', 'ended', 'in_review'],
  rejected: ['draft'],
  ended: [],
};

function invalid(state: CampaignState, event: CampaignEvent['type']) {
  return err<CampaignTransitionCode>(
    'INVALID_TRANSITION',
    `A ${state.replace('_', ' ')} campaign cannot ${event.replace('_', ' ')}`,
  );
}

export function campaignTransition(
  state: CampaignState,
  event: CampaignEvent,
): Result<CampaignState, CampaignTransitionCode> {
  switch (event.type) {
    case 'submit':
      return state === 'draft' ? ok('in_review') : invalid(state, event.type);
    case 'approve':
      if (state !== 'in_review') return invalid(state, event.type);
      if (!event.creativeApproved) {
        return err('CREATIVE_NOT_APPROVED', 'Approve the creative version before the campaign');
      }
      return ok('scheduled');
    case 'reject':
      return state === 'in_review' ? ok('rejected') : invalid(state, event.type);
    case 'activate':
      if (state !== 'scheduled') return invalid(state, event.type);
      if (!event.creativeApproved) {
        return err('CREATIVE_NOT_APPROVED', 'Only an approved creative version can go live');
      }
      if (event.now.getTime() >= event.endsAt.getTime()) {
        return err('CAMPAIGN_ENDED', 'This campaign’s end date has passed');
      }
      return ok('active');
    case 'pause':
      return state === 'active' || state === 'scheduled'
        ? ok('paused')
        : invalid(state, event.type);
    case 'resume':
      if (state !== 'paused') return invalid(state, event.type);
      if (event.now.getTime() >= event.endsAt.getTime()) {
        return err('CAMPAIGN_ENDED', 'This campaign’s end date has passed');
      }
      return ok('active');
    case 'end':
      return state === 'active' || state === 'scheduled' || state === 'paused'
        ? ok('ended')
        : invalid(state, event.type);
    case 'creative_changed':
      switch (state) {
        case 'draft':
        case 'in_review':
          return ok(state);
        case 'scheduled':
        case 'active':
        case 'paused':
          return ok('in_review');
        case 'rejected':
        case 'ended':
          return invalid(state, event.type);
        default:
          return invalid(state, event.type);
      }
    case 'revise':
      return state === 'rejected' ? ok('draft') : invalid(state, event.type);
    default:
      return invalid(state, 'submit');
  }
}

/** What placement selection needs to know about one campaign (no audience or child data). */
export interface ServableCampaignFacts {
  readonly id: string;
  readonly status: CampaignState;
  readonly sponsorActive: boolean;
  readonly creativeApproved: boolean;
  readonly placement: Placement;
  readonly platforms: readonly MonetizationPlatform[];
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly impressionCap: number;
  readonly viewableImpressions: number;
}

export type NotServableReason =
  | 'STATUS'
  | 'SPONSOR_SUSPENDED'
  | 'CREATIVE_NOT_APPROVED'
  | 'WRONG_PLACEMENT'
  | 'WRONG_PLATFORM'
  | 'NOT_STARTED'
  | 'EXPIRED'
  | 'CAP_REACHED';

/**
 * Whether a campaign may be shown now. A scheduled campaign serves once its window opens; paused,
 * ended, expired and over-cap campaigns never serve (AC_MON_06, AC_MON_14).
 */
export function campaignServableReason(
  campaign: ServableCampaignFacts,
  where: { placement: Placement; platform: MonetizationPlatform; now: Date },
): NotServableReason | null {
  if (campaign.status !== 'active' && campaign.status !== 'scheduled') return 'STATUS';
  if (!campaign.sponsorActive) return 'SPONSOR_SUSPENDED';
  if (!campaign.creativeApproved) return 'CREATIVE_NOT_APPROVED';
  if (campaign.placement !== where.placement) return 'WRONG_PLACEMENT';
  if (!campaign.platforms.includes(where.platform)) return 'WRONG_PLATFORM';
  if (where.now.getTime() < campaign.startsAt.getTime()) return 'NOT_STARTED';
  if (where.now.getTime() >= campaign.endsAt.getTime()) return 'EXPIRED';
  if (campaign.viewableImpressions >= campaign.impressionCap) return 'CAP_REACHED';
  return null;
}
