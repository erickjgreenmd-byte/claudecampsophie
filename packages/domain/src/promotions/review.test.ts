// Independent adversarial review of the P17 promotions module (REVIEW-PROMOTIONS).
// Tests named [RV-promotions-<n>] reproduce confirmed defects and fail against the reviewed code.
// The remaining tests probe the riskiest behavior that held up under review (they pass).
import { describe, expect, it } from 'vitest';
import { normalizePromoCode } from './codes.ts';
import { effectivePriceForPeriod, previewDiscount } from './discount.ts';
import {
  isDuplicateDelivery,
  transitionRedemption,
  type RedemptionEvent,
  type RedemptionState,
} from './redemption-state.ts';
import {
  validateRedemption,
  type CampaignSnapshot,
  type RedemptionValidationInput,
} from './redemption.ts';
import { selectTargetPeriod, type PromoSubscriptionSnapshot } from './target-period.ts';
import { planMonthlyGeneration, redemptionWindowUtc } from './templates.ts';
import { FAMILY_RILEY, TEMPLATE_A, iso, makeTemplate } from './test-fixtures.ts';

const OCT = 'campaign-2026-10';
const SEP = 'campaign-2026-09';

function campaign(overrides: Partial<CampaignSnapshot> = {}): CampaignSnapshot {
  return {
    id: OCT,
    templateId: TEMPLATE_A,
    status: 'active',
    opensAt: iso('2026-10-01T00:00:00Z'),
    closesAt: iso('2026-11-01T00:00:00Z'),
    percentOff: 50,
    eligibleTiers: [1, 2, 3, 4],
    subscriberEligibility: ['new', 'existing', 'lapsed'],
    redemptionCap: 500,
    liveRedemptionCount: 0,
    budgetCapCents: 1_000_000,
    committedDiscountCents: 0,
    schoolId: null,
    ...overrides,
  };
}

function sub(overrides: Partial<PromoSubscriptionSnapshot> = {}): PromoSubscriptionSnapshot {
  return {
    status: 'active',
    channel: 'app_store',
    currentPeriodStart: iso('2026-09-15T00:00:00Z'),
    currentPeriodEnd: iso('2026-10-15T00:00:00Z'),
    finalizedPeriodStarts: [iso('2026-09-15T00:00:00Z')],
    ...overrides,
  };
}

function input(overrides: Partial<RedemptionValidationInput> = {}): RedemptionValidationInput {
  return {
    principal: 'parent',
    recentAdultUnlock: true,
    now: iso('2026-10-03T12:00:00Z'),
    familyId: FAMILY_RILEY,
    code: { codeId: 'code-oct', campaignId: OCT, usageCount: 0, usageCap: null, status: 'active' },
    campaign: campaign(),
    familySchoolId: null,
    familyPaidSlots: 2,
    channel: 'app_store',
    channelMappings: (['app_store', 'play_store', 'stripe'] as const).map((channel) => ({
      campaignId: OCT,
      channel,
      status: 'ready' as const,
    })),
    subscription: sub(),
    familyRedemptions: [],
    ...overrides,
  };
}

function codeOf(overrides: Partial<RedemptionValidationInput>): string | null {
  const result = validateRedemption(input(overrides));
  return result.ok ? null : result.error.code;
}

describe('REVIEW-PROMOTIONS: confirmed defects', () => {
  it('[RV-promotions-1] event names inherited from Object.prototype are INVALID_TRANSITION, never a successful transition', () => {
    // Webhook/job events are mapped from untrusted provider payloads. The state lookup is guarded
    // with Object.hasOwn, but the event lookup is not, so prototype keys "succeed".
    for (const state of ['reserved', 'provider_pending', 'confirmed'] as const) {
      for (const event of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
        const result = transitionRedemption(state, event as RedemptionEvent);
        expect(result.ok, `${state} + ${event}`).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('INVALID_TRANSITION');
      }
    }
  });

  it('[RV-promotions-2] an end_of_month window closes exactly when the next month opens, even when the month starts after a midnight DST jump', () => {
    // America/Asuncion jumped 2023-10-01 00:00 -> 01:00 (-04 -> -03). October's first instant is
    // 04:00Z; November starts at local midnight 2023-11-01T00:00-03:00 = 03:00Z. The October
    // window must close at November's start, not one hour later (overlapping windows).
    const zone = 'America/Asuncion';
    const whole = { startDay: 1, endDay: 'end_of_month' } as const;
    const october = redemptionWindowUtc('2023-10', zone, whole);
    const november = redemptionWindowUtc('2023-11', zone, whole);
    expect(october.opensAt.toISOString()).toBe('2023-10-01T04:00:00.000Z');
    expect(october.closesAt.toISOString()).toBe('2023-11-01T03:00:00.000Z');
    expect(october.closesAt.getTime()).toBe(november.opensAt.getTime());

    // The generator's plan inherits the same boundary.
    const [plan] = planMonthlyGeneration({
      templates: [makeTemplate({ calendarTimezone: zone })],
      month: '2023-10',
      existingGenerationKeys: new Set(),
    });
    expect(plan?.window.closesAt.toISOString()).toBe('2023-11-01T03:00:00.000Z');
  });

  it('[RV-promotions-3] a redelivered submit_to_provider after the provider outcome is recorded is a duplicate, not a conflict', () => {
    // isDuplicateDelivery documents "states an event would have produced (or already passed
    // through)"; confirmed/rejected/reconciled all passed through provider_pending, exactly as
    // reconciled passed through confirmed for provider_confirmed (which IS treated as duplicate).
    for (const state of ['confirmed', 'rejected', 'reconciled'] as const) {
      expect(isDuplicateDelivery(state, 'submit_to_provider'), state).toBe(true);
    }
  });
});

describe('REVIEW-PROMOTIONS: risky behavior that held up', () => {
  it('rejects Unicode look-alikes that case-fold into valid symbols (Turkish I, Kelvin K)', () => {
    for (const raw of ['İ000000000', 'K000000000K', '0000000000İ']) {
      const result = normalizePromoCode(raw);
      expect(result.ok ? null : result.error.code).toBe('CODE_INVALID_FORMAT');
    }
  });

  it('matches the finance model half-up rounding for every tier and whole percentage', () => {
    for (let slots = 1; slots <= 4; slots += 1) {
      const regular = 3999 + 999 * (slots - 1);
      for (let pct = 5; pct <= 100; pct += 1) {
        const exact = regular * (100 - pct);
        const oracle = Math.floor(exact / 100) + (exact % 100 >= 50 ? 1 : 0);
        const preview = previewDiscount(regular, pct);
        expect(preview.chargedCents).toBe(oracle);
        expect(preview.chargedCents + preview.discountCents).toBe(regular);
      }
    }
  });

  it('a provider-confirmed period stays "discounted" even if the provider reports the full amount', () => {
    const price = effectivePriceForPeriod({
      regularCents: 4998,
      confirmedRedemptions: [{ percentOff: 5, providerChargedCents: 4998 }],
    });
    expect(price).toEqual({
      ok: true,
      value: { chargedCents: 4998, discountCents: 0, discounted: true },
    });
  });

  it('closes the next period exactly at the cutoff instant (no off-by-one retroactive discount)', () => {
    const subscription = sub();
    const cutoff = iso('2026-10-14T00:00:00Z');
    expect(selectTargetPeriod({ subscription, now: new Date(cutoff.getTime() - 1) }).ok).toBe(true);
    const atCutoff = selectTargetPeriod({ subscription, now: cutoff });
    expect(!atCutoff.ok && atCutoff.error.code).toBe('NEXT_PERIOD_ALREADY_FINALIZED');
  });

  it('opens a mid-month window at the first real instant of a day whose midnight is skipped by DST', () => {
    // America/Santiago 2026-09-06: 00:00 -> 01:00 (-04 -> -03); the day starts at 04:00Z.
    const window = redemptionWindowUtc('2026-09', 'America/Santiago', { startDay: 6, endDay: 6 });
    expect(window.opensAt.toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(window.closesAt.toISOString()).toBe('2026-09-07T03:00:00.000Z');
  });

  it('a lapsed family cannot discount its return period twice by switching channels', () => {
    const lapsed = sub({
      status: 'expired',
      currentPeriodStart: iso('2026-06-15T00:00:00Z'),
      currentPeriodEnd: iso('2026-07-15T00:00:00Z'),
    });
    expect(
      codeOf({
        subscription: lapsed,
        channel: 'stripe',
        familyRedemptions: [
          {
            campaignId: SEP,
            state: 'provider_pending',
            targetPeriodKey: 'first:app_store:2026-07-15T00:00:00.000Z',
          },
        ],
      }),
    ).toBe('TARGET_PERIOD_ALREADY_DISCOUNTED');
  });

  it('an in-flight first-period reservation still blocks once the new subscription appears', () => {
    expect(
      codeOf({
        subscription: sub({
          channel: 'stripe',
          currentPeriodStart: iso('2026-10-02T00:00:00Z'),
          currentPeriodEnd: iso('2026-11-02T00:00:00Z'),
          finalizedPeriodStarts: [iso('2026-10-02T00:00:00Z')],
        }),
        channel: 'stripe',
        familyRedemptions: [
          { campaignId: SEP, state: 'provider_pending', targetPeriodKey: 'first:stripe' },
        ],
      }),
    ).toBe('PENDING_PROMOTION_EXISTS');
  });

  it('a corrupt target period key on a confirmed row fails closed as a pending promotion', () => {
    expect(
      codeOf({
        familyRedemptions: [{ campaignId: SEP, state: 'confirmed', targetPeriodKey: 'garbage' }],
      }),
    ).toBe('PENDING_PROMOTION_EXISTS');
    expect(
      codeOf({
        familyRedemptions: [
          { campaignId: SEP, state: 'mystery' as RedemptionState, targetPeriodKey: 'garbage' },
        ],
      }),
    ).toBe('PENDING_PROMOTION_EXISTS');
  });

  it('the budget admits a redemption that lands exactly on the cap and refuses one cent over', () => {
    // 2 slots at 50%: discount 2499.
    expect(
      codeOf({ campaign: campaign({ budgetCapCents: 10_000, committedDiscountCents: 7_501 }) }),
    ).toBeNull();
    expect(
      codeOf({ campaign: campaign({ budgetCapCents: 10_000, committedDiscountCents: 7_502 }) }),
    ).toBe('CAMPAIGN_BUDGET_EXHAUSTED');
  });

  it('child mode and missing step-up are refused before any campaign data is validated', () => {
    const corrupt = campaign({ budgetCapCents: Number.NaN, opensAt: new Date(Number.NaN) });
    expect(codeOf({ principal: 'child', campaign: corrupt })).toBe('CHILD_MODE_FORBIDDEN');
    expect(codeOf({ recentAdultUnlock: false, campaign: corrupt })).toBe('STEP_UP_REQUIRED');
  });
});
