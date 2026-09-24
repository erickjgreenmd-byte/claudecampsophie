import { DEFAULT_MAX_PAID_SLOTS, tryMonthlyPriceCents } from '../pricing/index.ts';
import type { BillingChannel } from '../shared/billing.ts';
import { assertCents, type Cents } from '../shared/money.ts';
import { err, ok, type Result } from '../shared/result.ts';
import { channelAvailability, type ChannelMapping } from './channels.ts';
import { previewDiscount } from './discount.ts';
import { isLiveState, type RedemptionState } from './redemption-state.ts';
import {
  assertInstant,
  isFirstPeriodKey,
  isSameTargetPeriod,
  selectTargetPeriod,
  subscriberClassOf,
  targetPeriodKey,
  type PromoSubscriptionSnapshot,
  type TargetPeriod,
} from './target-period.ts';
import type { SubscriberClass } from './templates.ts';

export type Principal = 'parent' | 'child';

export type CampaignStatus = 'provisioning' | 'active' | 'paused' | 'revoked' | 'ended' | 'failed';

/** A generated monthly campaign with its live usage, read in the same transaction as the reservation. */
export interface CampaignSnapshot {
  readonly id: string;
  readonly templateId: string;
  readonly status: CampaignStatus;
  /** Calendar redemption window [opensAt, closesAt). */
  readonly opensAt: Date;
  readonly closesAt: Date;
  readonly percentOff: number;
  readonly eligibleTiers: readonly number[];
  readonly subscriberEligibility: readonly SubscriberClass[];
  readonly redemptionCap: number;
  /** Redemptions in live states (reserved + provider_pending + confirmed + reconciled). */
  readonly liveRedemptionCount: number;
  readonly budgetCapCents: Cents;
  /** Sum of discounts of live-state redemptions (in-flight previews included). */
  readonly committedDiscountCents: Cents;
  readonly schoolId: string | null;
}

/** The code record found by its normalized form (see `normalizePromoCode`). */
export interface PromoCodeRecord {
  readonly codeId: string;
  readonly campaignId: string;
  /** Live (confirmed + in-flight) uses of this code by any family. */
  readonly usageCount: number;
  /** Per-code cap (1 for individual codes); null means only the campaign cap applies. */
  readonly usageCap: number | null;
  readonly status: 'active' | 'revoked';
}

/** One of this family's redemptions (any guardian, device or channel). */
export interface FamilyRedemptionRecord {
  /** When supplied, must equal the input family (guards against a cross-family query bug). */
  readonly familyId?: string;
  readonly campaignId: string;
  readonly state: RedemptionState;
  readonly targetPeriodKey: string;
}

export interface RedemptionValidationInput {
  readonly principal: Principal;
  /** Server-verified recent PIN/biometric step-up for this adult session. */
  readonly recentAdultUnlock: boolean;
  readonly now: Date;
  readonly familyId: string;
  readonly code: PromoCodeRecord;
  readonly campaign: CampaignSnapshot;
  /** The family's currently designated school, if any. */
  readonly familySchoolId: string | null;
  /** Verified paid slots; for a new subscriber, the tier being purchased. */
  readonly familyPaidSlots: number;
  readonly channel: BillingChannel;
  readonly channelMappings: readonly ChannelMapping[];
  /** Verified provider subscription for the family, or null if it never subscribed. */
  readonly subscription: PromoSubscriptionSnapshot | null;
  readonly familyRedemptions: readonly FamilyRedemptionRecord[];
  readonly billingCutoffLeadMs?: number;
  readonly maxPaidSlots?: number;
}

/**
 * Stable error codes, in the order checks run. The order is part of the contract:
 * 1. who is asking (child mode, step-up) before revealing anything about the code;
 * 2. campaign and code state, then campaign/code caps (no family data needed);
 * 3. audience, tier, subscriber eligibility, channel readiness and the managing store;
 * 4. family uniqueness (per campaign, pending promotions), the target billing period
 *    (standing, cutoff/finalized) and one discount per period;
 * 5. budget last, because it needs this redemption's discount amount.
 */
export const REDEMPTION_ERROR_CODES = [
  'CHILD_MODE_FORBIDDEN',
  'STEP_UP_REQUIRED',
  'CAMPAIGN_NOT_ACTIVE',
  'OUTSIDE_REDEMPTION_WINDOW',
  'CODE_REVOKED',
  'CODE_USAGE_CAP_REACHED',
  'CAMPAIGN_REDEMPTION_CAP_REACHED',
  'SCHOOL_AUDIENCE_MISMATCH',
  'TIER_NOT_ELIGIBLE',
  'SUBSCRIBER_NOT_ELIGIBLE',
  'CHANNEL_UNAVAILABLE',
  'CHANNEL_MISMATCH',
  'FAMILY_ALREADY_REDEEMED_CAMPAIGN',
  'PENDING_PROMOTION_EXISTS',
  'SUBSCRIPTION_NOT_IN_GOOD_STANDING',
  'NEXT_PERIOD_ALREADY_FINALIZED',
  'TARGET_PERIOD_ALREADY_DISCOUNTED',
  'CAMPAIGN_BUDGET_EXHAUSTED',
] as const;
export type RedemptionErrorCode = (typeof REDEMPTION_ERROR_CODES)[number];

/** What the parent confirms before the reservation; amounts are previews until the provider reports. */
export interface RedemptionQuote {
  readonly campaignId: string;
  readonly codeId: string;
  readonly channel: BillingChannel;
  readonly paidSlots: number;
  readonly subscriberClass: SubscriberClass;
  readonly targetPeriod: TargetPeriod;
  readonly targetPeriodKey: string;
  readonly percentOff: number;
  /** Approved list price for `paidSlots` (monthlyPriceCents). */
  readonly regularCents: Cents;
  readonly discountCents: Cents;
  readonly chargedCents: Cents;
  /** Without a newly redeemed code, the period after the target is billed at the regular price. */
  readonly nextRegularRenewalCents: Cents;
  /** Auto-renew is off: the discount applies only if the subscription renews. */
  readonly autoRenewOff: boolean;
  readonly isPreview: true;
}

function assertCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
}

function assertPositive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
}

/**
 * Programmer-error guards. Caps and budgets are asserted so a corrupt value (e.g. NaN) can never
 * make a limit comparison silently pass.
 */
function assertConsistent(input: RedemptionValidationInput): void {
  const { campaign, code } = input;
  assertInstant(input.now, 'now');
  assertInstant(campaign.opensAt, 'campaign.opensAt');
  assertInstant(campaign.closesAt, 'campaign.closesAt');
  if (campaign.closesAt.getTime() <= campaign.opensAt.getTime()) {
    throw new RangeError('campaign.closesAt must be after campaign.opensAt');
  }
  if (code.campaignId !== campaign.id) {
    throw new RangeError('code.campaignId does not match campaign.id');
  }
  assertPositive(campaign.redemptionCap, 'campaign.redemptionCap');
  assertPositive(campaign.budgetCapCents, 'campaign.budgetCapCents');
  if (code.usageCap !== null) assertPositive(code.usageCap, 'code.usageCap');
  assertCount(code.usageCount, 'code.usageCount');
  assertCount(campaign.liveRedemptionCount, 'campaign.liveRedemptionCount');
  assertCount(assertCents(campaign.committedDiscountCents), 'campaign.committedDiscountCents');
  for (const r of input.familyRedemptions) {
    if (r.familyId !== undefined && r.familyId !== input.familyId) {
      throw new RangeError('familyRedemptions contains a redemption of another family');
    }
  }
}

/**
 * Decision: a live redemption is a pending (not-yet-applied) promotion when it is still in flight,
 * or confirmed for a renewal period that has not started at `now`. Confirmed first-period
 * redemptions were applied at purchase. Unknown states count as pending (fail closed).
 */
function isPendingPromotion(r: FamilyRedemptionRecord, now: Date): boolean {
  if (!isLiveState(r.state)) return false;
  if (r.state === 'reconciled') return false;
  if (r.state !== 'confirmed') return true;
  if (isFirstPeriodKey(r.targetPeriodKey)) return false;
  const start = Date.parse(r.targetPeriodKey);
  return Number.isNaN(start) || start > now.getTime();
}

/**
 * Validates a parent's code entry and quotes exactly one target billing period. Pure: the caller
 * runs it inside the transaction that inserts the `reserved` row, with counts read under lock, so
 * database constraints remain the final guard against concurrent requests.
 */
export function validateRedemption(
  input: RedemptionValidationInput,
): Result<RedemptionQuote, RedemptionErrorCode> {
  // 1. Who is asking. Never let child mode or an un-stepped-up session learn about the code.
  if (input.principal !== 'parent') {
    return err('CHILD_MODE_FORBIDDEN', 'Promotions can only be redeemed by a parent.');
  }
  if (input.recentAdultUnlock !== true) {
    return err('STEP_UP_REQUIRED', 'Confirm it is you (PIN or biometrics) to redeem a code.');
  }
  assertConsistent(input);
  const { campaign, code, now } = input;
  const nowMs = now.getTime();

  // 2. Campaign and code state, then caps (in-flight reservations count).
  if (campaign.status !== 'active') {
    return err('CAMPAIGN_NOT_ACTIVE', 'This promotion is not currently available.', {
      status: campaign.status,
    });
  }
  if (nowMs < campaign.opensAt.getTime() || nowMs >= campaign.closesAt.getTime()) {
    return err('OUTSIDE_REDEMPTION_WINDOW', 'This code is outside its redemption dates.', {
      opensAt: campaign.opensAt.toISOString(),
      closesAt: campaign.closesAt.toISOString(),
    });
  }
  if (code.status !== 'active') return err('CODE_REVOKED', 'This code is no longer valid.');
  if (code.usageCap !== null && code.usageCount >= code.usageCap) {
    return err(
      'CODE_USAGE_CAP_REACHED',
      'This code has already been used the maximum number of times.',
    );
  }
  if (campaign.liveRedemptionCount >= campaign.redemptionCap) {
    return err(
      'CAMPAIGN_REDEMPTION_CAP_REACHED',
      'This promotion has reached its redemption limit.',
    );
  }

  // 3. Audience, tier, subscriber class and channel readiness.
  // Decision: a school-scoped campaign rejects only families designated to a different school; a
  // family with no designation may redeem (the promo never silently overwrites a designation).
  if (
    campaign.schoolId !== null &&
    input.familySchoolId !== null &&
    input.familySchoolId !== campaign.schoolId
  ) {
    return err('SCHOOL_AUDIENCE_MISMATCH', 'This code is for families of another school.');
  }
  const price = tryMonthlyPriceCents(
    input.familyPaidSlots,
    input.maxPaidSlots ?? DEFAULT_MAX_PAID_SLOTS,
  );
  if (!price.ok || !campaign.eligibleTiers.includes(input.familyPaidSlots)) {
    return err('TIER_NOT_ELIGIBLE', 'This code does not apply to your number of children.', {
      paidSlots: input.familyPaidSlots,
    });
  }
  const subscriberClass = subscriberClassOf(input.subscription);
  if (!campaign.subscriberEligibility.includes(subscriberClass)) {
    return err(
      'SUBSCRIBER_NOT_ELIGIBLE',
      'This code is not available for your subscription status.',
      {
        subscriberClass,
      },
    );
  }
  const availability = channelAvailability(
    input.channelMappings,
    campaign.id,
    input.channel,
    input.familyPaidSlots,
  );
  if (!availability.ready) {
    return err('CHANNEL_UNAVAILABLE', 'This code cannot be used with this payment method yet.', {
      unavailable: availability.unavailable,
    });
  }

  // Decision: an existing subscriber must redeem through the store managing its subscription; a
  // code applied on another channel could not discount that subscription's next invoice.
  if (
    input.subscription !== null &&
    subscriberClass === 'existing' &&
    input.subscription.channel !== input.channel
  ) {
    return err(
      'CHANNEL_MISMATCH',
      'Redeem this code with the store that manages your subscription.',
      {
        managedBy: input.subscription.channel,
      },
    );
  }

  // 4. Family uniqueness, target period and one discount per period.
  const live = input.familyRedemptions.filter((r) => isLiveState(r.state));
  if (live.some((r) => r.campaignId === campaign.id)) {
    return err(
      'FAMILY_ALREADY_REDEEMED_CAMPAIGN',
      'Your family has already redeemed this promotion.',
    );
  }
  const target = selectTargetPeriod({
    subscription: input.subscription,
    now,
    ...(input.billingCutoffLeadMs === undefined
      ? {}
      : { billingCutoffLeadMs: input.billingCutoffLeadMs }),
  });
  // A pending promotion for a different period is reported before target-period problems, so a
  // family is told about its in-flight promotion first. Decision: when no target can be chosen,
  // any pending promotion blocks (there is no period it could legitimately share).
  const candidateKey = target.ok ? targetPeriodKey(target.value, input.channel) : null;
  if (
    live.some(
      (r) =>
        isPendingPromotion(r, now) &&
        (candidateKey === null || !isSameTargetPeriod(r.targetPeriodKey, candidateKey)),
    )
  ) {
    return err(
      'PENDING_PROMOTION_EXISTS',
      'A promotion for an upcoming period is already pending.',
    );
  }
  if (!target.ok) return target;
  const key = targetPeriodKey(target.value, input.channel);
  if (live.some((r) => isSameTargetPeriod(r.targetPeriodKey, key))) {
    return err('TARGET_PERIOD_ALREADY_DISCOUNTED', 'That billing period already has a promotion.', {
      targetPeriodKey: key,
    });
  }

  // 5. Budget: committed live discounts plus this one must stay within the cap.
  const preview = previewDiscount(price.value, campaign.percentOff);
  if (campaign.committedDiscountCents + preview.discountCents > campaign.budgetCapCents) {
    return err('CAMPAIGN_BUDGET_EXHAUSTED', 'This promotion has reached its budget.');
  }

  return ok({
    campaignId: campaign.id,
    codeId: code.codeId,
    channel: input.channel,
    paidSlots: input.familyPaidSlots,
    subscriberClass,
    targetPeriod: target.value,
    targetPeriodKey: key,
    percentOff: campaign.percentOff,
    regularCents: price.value,
    discountCents: preview.discountCents,
    chargedCents: preview.chargedCents,
    nextRegularRenewalCents: price.value,
    autoRenewOff: input.subscription?.status === 'cancelled_active',
    isPreview: true,
  });
}

/**
 * Live usage of a campaign or code from its redemption rows: count and committed discount of
 * reserved, provider_pending, confirmed and reconciled rows. Rejected/expired rows release both.
 */
export function summarizeUsage(
  rows: readonly { readonly state: RedemptionState; readonly discountCents: Cents }[],
): { liveCount: number; committedDiscountCents: Cents } {
  let liveCount = 0;
  let committedDiscountCents = 0;
  for (const row of rows) {
    if (!isLiveState(row.state)) continue;
    assertCents(row.discountCents, 'discountCents');
    if (row.discountCents < 0) throw new RangeError('discountCents must not be negative');
    liveCount += 1;
    committedDiscountCents += row.discountCents;
  }
  return { liveCount, committedDiscountCents };
}
