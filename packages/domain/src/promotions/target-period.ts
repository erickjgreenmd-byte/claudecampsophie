import type { BillingChannel } from '../shared/billing.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { SubscriberClass } from './templates.ts';

/**
 * Subscription states relevant to promotion targeting, normalized from provider state (RevenueCat
 * for Apple/Google, Stripe). Any other value is treated as not in good standing (fail closed).
 */
export type PromoSubscriptionStatus =
  'active' | 'cancelled_active' | 'grace_period' | 'billing_retry' | 'expired';

export interface PromoSubscriptionSnapshot {
  readonly status: PromoSubscriptionStatus;
  /** Store/provider that manages the subscription. */
  readonly channel: BillingChannel;
  /** Current provider period boundaries (UTC instants). */
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  /** Starts of provider periods whose invoice/charge is already final (cannot be discounted). */
  readonly finalizedPeriodStarts: readonly Date[];
  /** End of the next period when the provider already publishes it (e.g. Stripe upcoming invoice). */
  readonly nextPeriodEnd?: Date;
}

/** 24 hours: redemption for the next period closes this long before the provider renewal. */
export const DEFAULT_BILLING_CUTOFF_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * The beneficiary billing period a redemption discounts (distinct from the campaign's calendar
 * redemption window).
 * - `first_full_period`: a new or lapsed subscriber's first full period of the subscription they
 *   are purchasing; its dates exist only once the provider creates it.
 * - `renewal_period`: an existing subscriber's next provider period, starting exactly at the
 *   provider-reported current period end. `periodEnd` is known only if the provider published it.
 */
export type TargetPeriod =
  | { readonly kind: 'first_full_period'; readonly lapsedPeriodEnd: Date | null }
  | {
      readonly kind: 'renewal_period';
      readonly periodStart: Date;
      readonly periodEnd: Date | null;
      readonly isProjection: true;
    };

export const TARGET_PERIOD_ERROR_CODES = [
  'SUBSCRIPTION_NOT_IN_GOOD_STANDING',
  'NEXT_PERIOD_ALREADY_FINALIZED',
] as const;
export type TargetPeriodErrorCode = (typeof TARGET_PERIOD_ERROR_CODES)[number];

export function assertInstant(value: Date, label: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError(`${label} must be a valid Date`);
  }
  return value;
}

function assertSnapshot(s: PromoSubscriptionSnapshot): void {
  assertInstant(s.currentPeriodStart, 'currentPeriodStart');
  assertInstant(s.currentPeriodEnd, 'currentPeriodEnd');
  if (s.currentPeriodEnd.getTime() <= s.currentPeriodStart.getTime()) {
    throw new RangeError('currentPeriodEnd must be after currentPeriodStart');
  }
  for (const start of s.finalizedPeriodStarts) assertInstant(start, 'finalizedPeriodStarts[]');
  if (s.nextPeriodEnd !== undefined) {
    assertInstant(s.nextPeriodEnd, 'nextPeriodEnd');
    if (s.nextPeriodEnd.getTime() <= s.currentPeriodEnd.getTime()) {
      throw new RangeError('nextPeriodEnd must be after currentPeriodEnd');
    }
  }
}

/** Eligibility class: none -> new, expired -> lapsed, otherwise existing. */
export function subscriberClassOf(subscription: PromoSubscriptionSnapshot | null): SubscriberClass {
  if (subscription === null) return 'new';
  return subscription.status === 'expired' ? 'lapsed' : 'existing';
}

/**
 * Chooses the single billing period a code redeemed at `now` would discount.
 *
 * Existing subscribers may target only the NEXT provider period (start = current period end, never
 * `+30 days`), and only while `now < periodStart − billingCutoffLeadMs` and that period is not
 * finalized: no retroactive discounts and no saving codes for later periods.
 *
 * Decision: `cancelled_active` (auto-renew off, still paid) is an existing subscriber and may target
 * its next period; the quote flags `autoRenewOff` so confirmation can say the discount applies only
 * if the subscription renews. `grace_period`, `billing_retry` and unknown states are refused.
 */
export function selectTargetPeriod(input: {
  readonly subscription: PromoSubscriptionSnapshot | null;
  readonly now: Date;
  readonly billingCutoffLeadMs?: number;
}): Result<TargetPeriod, TargetPeriodErrorCode> {
  const { subscription, now } = input;
  const lead = input.billingCutoffLeadMs ?? DEFAULT_BILLING_CUTOFF_LEAD_MS;
  assertInstant(now, 'now');
  if (!Number.isSafeInteger(lead) || lead < 0) {
    throw new RangeError('billingCutoffLeadMs must be a non-negative integer');
  }
  if (subscription === null) return ok({ kind: 'first_full_period', lapsedPeriodEnd: null });
  assertSnapshot(subscription);

  switch (subscription.status) {
    case 'expired':
      return ok({ kind: 'first_full_period', lapsedPeriodEnd: subscription.currentPeriodEnd });
    case 'active':
    case 'cancelled_active':
      break;
    case 'grace_period':
    case 'billing_retry':
    default:
      return err(
        'SUBSCRIPTION_NOT_IN_GOOD_STANDING',
        'Resolve the payment issue with your store before redeeming a code.',
        { status: subscription.status },
      );
  }

  const periodStart = subscription.currentPeriodEnd;
  const finalized = subscription.finalizedPeriodStarts.some(
    (start) => start.getTime() === periodStart.getTime(),
  );
  if (finalized || now.getTime() >= periodStart.getTime() - lead) {
    return err(
      'NEXT_PERIOD_ALREADY_FINALIZED',
      'The next bill is already being prepared; this code cannot discount it.',
      { periodStart: periodStart.toISOString() },
    );
  }
  return ok({
    kind: 'renewal_period',
    periodStart,
    periodEnd: subscription.nextPeriodEnd ?? null,
    isProjection: true,
  });
}

const FIRST_PREFIX = 'first:';

/**
 * Stable key of the target period, stored as `promo_redemptions.target_period_key`:
 * - renewal: ISO-8601 of the provider period start;
 * - first period of a new subscriber: `first:<channel>`;
 * - first period after a lapse: `first:<channel>:<ISO of the lapsed period end>`.
 *
 * Decision: the lapse suffix makes a returning (lapsed) family's first period a different period
 * from the first period it may have discounted years earlier; with a bare `first:<channel>` key the
 * live-state unique index would permanently block `lapsed` eligibility on that channel.
 */
export function targetPeriodKey(target: TargetPeriod, channel: BillingChannel): string {
  switch (target.kind) {
    case 'renewal_period':
      return assertInstant(target.periodStart, 'periodStart').toISOString();
    case 'first_full_period':
      return target.lapsedPeriodEnd === null
        ? `${FIRST_PREFIX}${channel}`
        : `${FIRST_PREFIX}${channel}:${assertInstant(target.lapsedPeriodEnd, 'lapsedPeriodEnd').toISOString()}`;
  }
}

/** Channel-independent identity of a target period key. */
function periodIdentity(key: string): string {
  if (!key.startsWith(FIRST_PREFIX)) {
    const ms = Date.parse(key);
    return Number.isNaN(ms) ? key : new Date(ms).toISOString();
  }
  const rest = key.slice(FIRST_PREFIX.length);
  const colon = rest.indexOf(':');
  return colon < 0 ? 'first' : `first:${rest.slice(colon + 1)}`;
}

/**
 * Whether two target period keys denote the same family billing period. First-period keys on
 * different channels denote the same period (one family has one first period per subscription
 * start), which closes a cross-channel double discount while a snapshot lags.
 */
export function isSameTargetPeriod(a: string, b: string): boolean {
  return periodIdentity(a) === periodIdentity(b);
}

export function isFirstPeriodKey(key: string): boolean {
  return key.startsWith(FIRST_PREFIX);
}
