// End-to-end P17 flows composed only from the module's pure functions: generator -> campaign ->
// validate/quote -> reserve -> provider state machine -> effective price per provider period.
// The provider and the database are simulated in memory (labeled test doubles), serialized.
import { describe, expect, it } from 'vitest';
import type { BillingChannel } from '../shared/billing.ts';
import { effectivePriceForPeriod } from './discount.ts';
import {
  transitionRedemption,
  type RedemptionEvent,
  type RedemptionState,
} from './redemption-state.ts';
import {
  summarizeUsage,
  validateRedemption,
  type CampaignSnapshot,
  type RedemptionQuote,
  type RedemptionValidationInput,
} from './redemption.ts';
import type { PromoSubscriptionSnapshot } from './target-period.ts';
import { planMonthlyGeneration } from './templates.ts';
import { FAMILY_RILEY, TEMPLATE_A, TEMPLATE_B, iso, makeTemplate } from './test-fixtures.ts';

interface Row {
  id: number;
  campaignId: string;
  guardian: string;
  channel: BillingChannel;
  state: RedemptionState;
  targetPeriodKey: string;
  percentOff: number;
  discountCents: number;
}

/** In-memory stand-in for promo_redemptions + campaigns (mock, not database evidence). */
class Ledger {
  rows: Row[] = [];
  private nextId = 1;
  private readonly campaigns = new Map<string, CampaignSnapshot>();

  /** Generates the month's campaign from a template via the real planner. */
  campaign(month: string, percentOff: number, templateId = TEMPLATE_A): string {
    const [plan] = planMonthlyGeneration({
      templates: [makeTemplate({ id: templateId, percentOff })],
      month,
      existingGenerationKeys: new Set(this.campaigns.keys()),
    });
    if (!plan) throw new Error(`campaign ${templateId}:${month} already generated`);
    this.campaigns.set(plan.generationKey, {
      id: plan.generationKey,
      templateId,
      status: 'active',
      opensAt: plan.window.opensAt,
      closesAt: plan.window.closesAt,
      percentOff: plan.percentOff,
      eligibleTiers: [1, 2, 3, 4],
      subscriberEligibility: ['new', 'existing', 'lapsed'],
      redemptionCap: 500,
      liveRedemptionCount: 0,
      budgetCapCents: 1_000_000,
      committedDiscountCents: 0,
      schoolId: null,
    });
    return plan.generationKey;
  }

  setStatus(campaignId: string, status: CampaignSnapshot['status']): void {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) throw new Error('unknown campaign');
    this.campaigns.set(campaignId, { ...campaign, status });
  }

  validate(
    campaignId: string,
    now: Date,
    subscription: PromoSubscriptionSnapshot | null,
    extra: Partial<RedemptionValidationInput> = {},
  ) {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) throw new Error('unknown campaign');
    const usage = summarizeUsage(this.rows.filter((r) => r.campaignId === campaignId));
    return validateRedemption({
      principal: 'parent',
      recentAdultUnlock: true,
      now,
      familyId: FAMILY_RILEY,
      code: {
        codeId: `${campaignId}#shared`,
        campaignId,
        usageCount: usage.liveCount,
        usageCap: 500,
        status: 'active',
      },
      campaign: {
        ...campaign,
        liveRedemptionCount: usage.liveCount,
        committedDiscountCents: usage.committedDiscountCents,
      },
      familySchoolId: null,
      familyPaidSlots: 2,
      channel: subscription?.channel ?? 'app_store',
      channelMappings: (['app_store', 'play_store', 'stripe'] as const).map((channel) => ({
        campaignId,
        channel,
        status: 'ready' as const,
      })),
      subscription,
      familyRedemptions: this.rows.map((r) => ({
        campaignId: r.campaignId,
        state: r.state,
        targetPeriodKey: r.targetPeriodKey,
      })),
      ...extra,
    });
  }

  reserve(quote: RedemptionQuote, guardian = 'guardian-riley'): Row {
    const row: Row = {
      id: this.nextId++,
      campaignId: quote.campaignId,
      guardian,
      channel: quote.channel,
      state: 'reserved',
      targetPeriodKey: quote.targetPeriodKey,
      percentOff: quote.percentOff,
      discountCents: quote.discountCents,
    };
    this.rows.push(row);
    return row;
  }

  apply(row: Row, event: RedemptionEvent) {
    const next = transitionRedemption(row.state, event);
    if (next.ok) row.state = next.value;
    return next;
  }

  /** Redeem and have the (simulated) provider confirm. Fails the test if validation fails. */
  redeemAndConfirm(campaignId: string, now: Date, subscription: PromoSubscriptionSnapshot | null) {
    const result = this.validate(campaignId, now, subscription);
    if (!result.ok) throw new Error(`expected redemption to succeed, got ${result.error.code}`);
    const row = this.reserve(result.value);
    expect(this.apply(row, 'submit_to_provider').ok).toBe(true);
    expect(this.apply(row, 'provider_confirmed').ok).toBe(true);
    return result.value;
  }

  /** What the provider period starting at `periodStart` costs, given confirmed redemptions. */
  chargeFor(periodStart: Date, regularCents = 4998): number {
    const key = periodStart.toISOString();
    const confirmed = this.rows.filter(
      (r) => r.targetPeriodKey === key && (r.state === 'confirmed' || r.state === 'reconciled'),
    );
    const price = effectivePriceForPeriod({ regularCents, confirmedRedemptions: confirmed });
    if (!price.ok) throw new Error(price.error.code);
    return price.value.chargedCents;
  }
}

/** Provider-reported monthly periods anchored on the 15th (Riley's app_store subscription). */
const P = {
  aug15: iso('2026-08-15T00:00:00Z'),
  sep15: iso('2026-09-15T00:00:00Z'),
  oct15: iso('2026-10-15T00:00:00Z'),
  nov15: iso('2026-11-15T00:00:00Z'),
  dec15: iso('2026-12-15T00:00:00Z'),
  jan15: iso('2027-01-15T00:00:00Z'),
};

function activeSub(
  start: Date,
  end: Date,
  channel: BillingChannel = 'app_store',
): PromoSubscriptionSnapshot {
  return {
    status: 'active',
    channel,
    currentPeriodStart: start,
    currentPeriodEnd: end,
    finalizedPeriodStarts: [start],
  };
}

describe('P17 monthly codes across consecutive billing periods (AC_PROMO_03, AC_PROMO_04)', () => {
  it('a September code then a fresh October code discount consecutive periods; with no new code the next renewal is regular', () => {
    const ledger = new Ledger();
    const sept = ledger.campaign('2026-09', 50);
    const oct = ledger.campaign('2026-10', 50);

    const first = ledger.redeemAndConfirm(
      sept,
      iso('2026-09-05T10:00:00Z'),
      activeSub(P.aug15, P.sep15),
    );
    expect(first.targetPeriodKey).toBe(P.sep15.toISOString());
    expect(first.nextRegularRenewalCents).toBe(4998);

    const second = ledger.redeemAndConfirm(
      oct,
      iso('2026-10-03T10:00:00Z'),
      activeSub(P.sep15, P.oct15),
    );
    expect(second.targetPeriodKey).toBe(P.oct15.toISOString());

    // Finance model "Repeated monthly redemptions": $24.99, $24.99, then $49.98 without a new code.
    expect(ledger.chargeFor(P.sep15)).toBe(2499);
    expect(ledger.chargeFor(P.oct15)).toBe(2499);
    expect(ledger.chargeFor(P.nov15)).toBe(4998);
  });

  it('three consecutive months of 100% codes are each free only through a fresh code; then regular price', () => {
    const ledger = new Ledger();
    const months = [
      {
        month: '2026-09',
        now: iso('2026-09-02T00:00:00Z'),
        sub: activeSub(P.aug15, P.sep15),
        target: P.sep15,
      },
      {
        month: '2026-10',
        now: iso('2026-10-02T00:00:00Z'),
        sub: activeSub(P.sep15, P.oct15),
        target: P.oct15,
      },
      {
        month: '2026-11',
        now: iso('2026-11-02T00:00:00Z'),
        sub: activeSub(P.oct15, P.nov15),
        target: P.nov15,
      },
    ];
    for (const { month, now, sub, target } of months) {
      const quote = ledger.redeemAndConfirm(ledger.campaign(month, 100), now, sub);
      expect(quote).toMatchObject({
        chargedCents: 0,
        discountCents: 4998,
        nextRegularRenewalCents: 4998,
      });
      expect(quote.targetPeriodKey).toBe(target.toISOString());
    }
    expect([P.sep15, P.oct15, P.nov15].map((p) => ledger.chargeFor(p))).toEqual([0, 0, 0]);
    // December has a campaign too, but it is never auto-applied without a fresh entry (AC_PROMO_14).
    ledger.campaign('2026-12', 100);
    expect(ledger.chargeFor(P.dec15)).toBe(4998);
  });

  it('the September code cannot be reused in October, whether or not the family used it in September', () => {
    const ledger = new Ledger();
    const sept = ledger.campaign('2026-09', 50);
    ledger.redeemAndConfirm(sept, iso('2026-09-05T00:00:00Z'), activeSub(P.aug15, P.sep15));

    const inWindow = ledger.validate(
      sept,
      iso('2026-09-20T00:00:00Z'),
      activeSub(P.sep15, P.oct15),
    );
    expect(!inWindow.ok && inWindow.error.code).toBe('FAMILY_ALREADY_REDEEMED_CAMPAIGN');

    const october = ledger.validate(sept, iso('2026-10-03T00:00:00Z'), activeSub(P.sep15, P.oct15));
    expect(!october.ok && october.error.code).toBe('OUTSIDE_REDEMPTION_WINDOW');
    ledger.setStatus(sept, 'ended');
    const ended = ledger.validate(sept, iso('2026-10-03T00:00:00Z'), activeSub(P.sep15, P.oct15));
    expect(!ended.ok && ended.error.code).toBe('CAMPAIGN_NOT_ACTIVE');

    const unused = new Ledger();
    const unusedSept = unused.campaign('2026-09', 50);
    const late = unused.validate(
      unusedSept,
      iso('2026-10-03T00:00:00Z'),
      activeSub(P.sep15, P.oct15),
    );
    expect(!late.ok && late.error.code).toBe('OUTSIDE_REDEMPTION_WINDOW');
  });

  it('missing the billing cutoff means a regular renewal; the still-open code targets the following period', () => {
    const ledger = new Ledger();
    const oct = ledger.campaign('2026-10', 50);
    const late = ledger.validate(oct, iso('2026-10-14T12:00:00Z'), activeSub(P.sep15, P.oct15));
    expect(!late.ok && late.error.code).toBe('NEXT_PERIOD_ALREADY_FINALIZED');
    expect(ledger.chargeFor(P.oct15)).toBe(4998);

    const after = ledger.redeemAndConfirm(
      oct,
      iso('2026-10-20T00:00:00Z'),
      activeSub(P.oct15, P.nov15),
    );
    expect(after.targetPeriodKey).toBe(P.nov15.toISOString());
    expect(ledger.chargeFor(P.nov15)).toBe(2499);
  });
});

describe('P17 no stacking, no replay, no banking (AC_PROMO_05, AC_PROMO_09)', () => {
  it('two different codes can never discount the same billing period', () => {
    const ledger = new Ledger();
    const general = ledger.campaign('2026-10', 50, TEMPLATE_A);
    const school = ledger.campaign('2026-10', 25, TEMPLATE_B);
    ledger.redeemAndConfirm(general, iso('2026-10-03T00:00:00Z'), activeSub(P.sep15, P.oct15));
    const stacked = ledger.validate(
      school,
      iso('2026-10-04T00:00:00Z'),
      activeSub(P.sep15, P.oct15),
    );
    expect(!stacked.ok && stacked.error.code).toBe('TARGET_PERIOD_ALREADY_DISCOUNTED');
    expect(ledger.chargeFor(P.oct15)).toBe(2499);
  });

  it('another guardian of the same family, on another device and store, cannot replay the campaign', () => {
    const ledger = new Ledger();
    const oct = ledger.campaign('2026-10', 50);
    ledger.redeemAndConfirm(oct, iso('2026-10-03T00:00:00Z'), activeSub(P.sep15, P.oct15));
    // Sam (second guardian) tries later from a Play Store install after Riley's renewal.
    const replay = ledger.validate(
      oct,
      iso('2026-10-20T00:00:00Z'),
      activeSub(P.oct15, P.nov15, 'play_store'),
      { channel: 'play_store' },
    );
    expect(!replay.ok && replay.error.code).toBe('FAMILY_ALREADY_REDEEMED_CAMPAIGN');
  });

  it('a family cannot hold a second pending promotion while one is still awaiting the provider', () => {
    const ledger = new Ledger();
    const general = ledger.campaign('2026-10', 50, TEMPLATE_A);
    const school = ledger.campaign('2026-10', 25, TEMPLATE_B);
    const quote = ledger.validate(
      general,
      iso('2026-10-03T00:00:00Z'),
      activeSub(P.sep15, P.oct15),
    );
    if (!quote.ok) throw new Error(quote.error.code);
    const row = ledger.reserve(quote.value);
    ledger.apply(row, 'submit_to_provider');
    // The provider call is ambiguous and the subscription renews meanwhile.
    const next = ledger.validate(school, iso('2026-10-20T00:00:00Z'), activeSub(P.oct15, P.nov15));
    expect(!next.ok && next.error.code).toBe('PENDING_PROMOTION_EXISTS');
  });

  it('a failed new redemption never destroys the still-valid current offer', () => {
    const ledger = new Ledger();
    const oct = ledger.campaign('2026-10', 50);
    const nov = ledger.campaign('2026-11', 75);
    ledger.redeemAndConfirm(oct, iso('2026-10-03T00:00:00Z'), activeSub(P.sep15, P.oct15));

    const attempt = ledger.validate(nov, iso('2026-11-03T00:00:00Z'), activeSub(P.oct15, P.nov15));
    if (!attempt.ok) throw new Error(attempt.error.code);
    const failed = ledger.reserve(attempt.value);
    ledger.apply(failed, 'submit_to_provider');
    ledger.apply(failed, 'provider_rejected');

    expect(ledger.rows.find((r) => r.campaignId === oct)?.state).toBe('confirmed');
    expect(ledger.chargeFor(P.oct15)).toBe(2499);
    expect(ledger.chargeFor(P.nov15)).toBe(4998);
    // The rejected attempt does not use up the family's November redemption: a retry succeeds.
    ledger.redeemAndConfirm(nov, iso('2026-11-04T00:00:00Z'), activeSub(P.oct15, P.nov15));
    expect(ledger.chargeFor(P.nov15)).toBe(1250);
  });

  it('an in-flight provider_pending redemption never expires; it holds the cap until reconciliation decides', () => {
    const ledger = new Ledger();
    const oct = ledger.campaign('2026-10', 50);
    const quote = ledger.validate(oct, iso('2026-10-03T00:00:00Z'), activeSub(P.sep15, P.oct15));
    if (!quote.ok) throw new Error(quote.error.code);
    const row = ledger.reserve(quote.value);
    ledger.apply(row, 'submit_to_provider');

    const timeout = ledger.apply(row, 'reservation_timeout');
    expect(!timeout.ok && timeout.error.code).toBe('INVALID_TRANSITION');
    expect(row.state).toBe('provider_pending');
    expect(summarizeUsage(ledger.rows)).toEqual({ liveCount: 1, committedDiscountCents: 2499 });
    const retry = ledger.validate(oct, iso('2026-10-04T00:00:00Z'), activeSub(P.sep15, P.oct15));
    expect(!retry.ok && retry.error.code).toBe('FAMILY_ALREADY_REDEEMED_CAMPAIGN');

    // Reconciliation finds the provider did apply it: the benefit is confirmed, exactly once.
    expect(ledger.apply(row, 'reconcile_applied').ok).toBe(true);
    expect(ledger.chargeFor(P.oct15)).toBe(2499);
  });

  it('an unsubmitted reservation that times out frees the cap and the family can try again', () => {
    const ledger = new Ledger();
    const oct = ledger.campaign('2026-10', 50);
    const quote = ledger.validate(oct, iso('2026-10-03T00:00:00Z'), activeSub(P.sep15, P.oct15));
    if (!quote.ok) throw new Error(quote.error.code);
    const row = ledger.reserve(quote.value);
    expect(ledger.apply(row, 'reservation_timeout').ok).toBe(true);
    expect(summarizeUsage(ledger.rows)).toEqual({ liveCount: 0, committedDiscountCents: 0 });
    expect(ledger.validate(oct, iso('2026-10-04T00:00:00Z'), activeSub(P.sep15, P.oct15)).ok).toBe(
      true,
    );
  });
});

describe('P17 February and month-end provider periods (AC_PROMO_02)', () => {
  it('each confirmed code discounts exactly the provider period Jan 31 -> Feb 28 -> Mar 31', () => {
    const ledger = new Ledger();
    const dec31 = iso('2026-12-31T18:00:00Z');
    const jan31 = iso('2027-01-31T18:00:00Z');
    const feb28 = iso('2027-02-28T18:00:00Z');
    const mar31 = iso('2027-03-31T18:00:00Z');

    const jan = ledger.redeemAndConfirm(
      ledger.campaign('2027-01', 50),
      iso('2027-01-10T00:00:00Z'),
      activeSub(dec31, jan31),
    );
    const feb = ledger.redeemAndConfirm(
      ledger.campaign('2027-02', 100),
      iso('2027-02-05T00:00:00Z'),
      activeSub(jan31, feb28),
    );
    const mar = ledger.redeemAndConfirm(
      ledger.campaign('2027-03', 25),
      iso('2027-03-03T00:00:00Z'),
      activeSub(feb28, mar31),
    );

    expect([jan, feb, mar].map((q) => q.targetPeriodKey)).toEqual([
      jan31.toISOString(),
      feb28.toISOString(),
      mar31.toISOString(),
    ]);
    expect([jan31, feb28, mar31].map((p) => ledger.chargeFor(p))).toEqual([2499, 0, 3749]);
    // The period after the last code is regular: no carry-forward.
    expect(ledger.chargeFor(iso('2027-04-30T18:00:00Z'))).toBe(4998);
  });

  it('a new subscriber on the Stripe route discounts only its first full period', () => {
    const ledger = new Ledger();
    const oct = ledger.campaign('2026-10', 50);
    const quote = ledger.validate(oct, iso('2026-10-03T00:00:00Z'), null, { channel: 'stripe' });
    expect(quote.ok && quote.value.targetPeriodKey).toBe('first:stripe');
    expect(quote.ok && quote.value.targetPeriod).toEqual({
      kind: 'first_full_period',
      lapsedPeriodEnd: null,
    });
  });
});

describe('P17 cap races across families (AC_PROMO_05)', () => {
  it('with cap 2, in-flight reservations count: a third family is refused until one expires', () => {
    const ledger = new Ledger();
    const oct = ledger.campaign('2026-10', 50);
    const withCap = (family: string) =>
      ledger.validate(oct, iso('2026-10-03T00:00:00Z'), null, {
        familyId: family,
        channel: 'stripe',
        campaign: {
          id: oct,
          templateId: TEMPLATE_A,
          status: 'active',
          opensAt: iso('2026-10-01T00:00:00Z'),
          closesAt: iso('2026-11-01T00:00:00Z'),
          percentOff: 50,
          eligibleTiers: [1, 2, 3, 4],
          subscriberEligibility: ['new'],
          redemptionCap: 2,
          liveRedemptionCount: summarizeUsage(ledger.rows).liveCount,
          budgetCapCents: 1_000_000,
          committedDiscountCents: summarizeUsage(ledger.rows).committedDiscountCents,
          schoolId: null,
        },
        familyRedemptions: ledger.rows
          .filter((r) => r.guardian === family)
          .map((r) => ({
            campaignId: r.campaignId,
            state: r.state,
            targetPeriodKey: r.targetPeriodKey,
          })),
      });
    const reserveFor = (family: string) => {
      const q = withCap(family);
      if (!q.ok) return q.error.code;
      return ledger.reserve(q.value, family);
    };
    const a = reserveFor('family-riley');
    const b = reserveFor('family-sam');
    expect(typeof a).toBe('object');
    expect(typeof b).toBe('object');
    if (typeof b === 'object') ledger.apply(b, 'submit_to_provider');
    expect(reserveFor('family-jordan')).toBe('CAMPAIGN_REDEMPTION_CAP_REACHED');
    if (typeof a === 'object') ledger.apply(a, 'reservation_timeout');
    expect(typeof reserveFor('family-jordan')).toBe('object');
  });
});
