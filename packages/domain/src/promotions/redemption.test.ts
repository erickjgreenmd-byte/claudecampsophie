import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { monthlyPriceCents } from '../pricing/index.ts';
import type { RedemptionState } from './redemption-state.ts';
import {
  REDEMPTION_ERROR_CODES,
  summarizeUsage,
  validateRedemption,
  type CampaignSnapshot,
  type FamilyRedemptionRecord,
  type RedemptionValidationInput,
} from './redemption.ts';
import type { PromoSubscriptionSnapshot } from './target-period.ts';
import { FAMILY_RILEY, SCHOOL_BIRCH, SCHOOL_MAPLE, TEMPLATE_A, iso } from './test-fixtures.ts';

const OCT = 'campaign-2026-10';
const SEP = 'campaign-2026-09';
const OCT_CODE = 'code-oct-shared';
const NEXT_PERIOD_KEY = '2026-10-15T00:00:00.000Z';

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
    liveRedemptionCount: 10,
    budgetCapCents: 1_000_000,
    committedDiscountCents: 24_990,
    schoolId: null,
    ...overrides,
  };
}

function subscription(
  overrides: Partial<PromoSubscriptionSnapshot> = {},
): PromoSubscriptionSnapshot {
  return {
    status: 'active',
    channel: 'app_store',
    currentPeriodStart: iso('2026-09-15T00:00:00Z'),
    currentPeriodEnd: iso('2026-10-15T00:00:00Z'),
    finalizedPeriodStarts: [iso('2026-09-15T00:00:00Z')],
    ...overrides,
  };
}

/** A redemption that must succeed: Riley's two-child app_store family, Oct 3, fresh October code. */
function input(overrides: Partial<RedemptionValidationInput> = {}): RedemptionValidationInput {
  return {
    principal: 'parent',
    recentAdultUnlock: true,
    now: iso('2026-10-03T12:00:00Z'),
    familyId: FAMILY_RILEY,
    code: { codeId: OCT_CODE, campaignId: OCT, usageCount: 10, usageCap: 500, status: 'active' },
    campaign: campaign(),
    familySchoolId: null,
    familyPaidSlots: 2,
    channel: 'app_store',
    channelMappings: [
      { campaignId: OCT, channel: 'app_store', status: 'ready' },
      { campaignId: OCT, channel: 'play_store', status: 'ready' },
      { campaignId: OCT, channel: 'stripe', status: 'ready' },
    ],
    subscription: subscription(),
    familyRedemptions: [],
    ...overrides,
  };
}

function codeOf(overrides: Partial<RedemptionValidationInput>): string | null {
  const result = validateRedemption(input(overrides));
  return result.ok ? null : result.error.code;
}

describe('P17 redemption quote (AC_PROMO_02, AC_PROMO_14)', () => {
  it('an existing subscriber gets a preview for exactly the next provider period at the tier price', () => {
    expect(validateRedemption(input())).toEqual({
      ok: true,
      value: {
        campaignId: OCT,
        codeId: OCT_CODE,
        channel: 'app_store',
        paidSlots: 2,
        subscriberClass: 'existing',
        targetPeriod: {
          kind: 'renewal_period',
          periodStart: iso('2026-10-15T00:00:00Z'),
          periodEnd: null,
          isProjection: true,
        },
        targetPeriodKey: NEXT_PERIOD_KEY,
        percentOff: 50,
        regularCents: 4998,
        discountCents: 2499,
        chargedCents: 2499,
        nextRegularRenewalCents: 4998,
        autoRenewOff: false,
        isPreview: true,
      },
    });
  });

  it('a new subscriber previews the first full period of the tier being purchased', () => {
    const result = validateRedemption(
      input({
        subscription: null,
        familyPaidSlots: 3,
        channel: 'stripe',
        campaign: campaign({ percentOff: 25 }),
      }),
    );
    expect(result.ok && result.value).toMatchObject({
      subscriberClass: 'new',
      targetPeriod: { kind: 'first_full_period', lapsedPeriodEnd: null },
      targetPeriodKey: 'first:stripe',
      regularCents: 5997,
      chargedCents: 4498,
      discountCents: 1499,
      nextRegularRenewalCents: 5997,
    });
  });

  it('a lapsed subscriber who used a first-period promo long ago can use one again on return', () => {
    const lapsed = subscription({
      status: 'expired',
      currentPeriodStart: iso('2026-06-15T00:00:00Z'),
      currentPeriodEnd: iso('2026-07-15T00:00:00Z'),
    });
    const result = validateRedemption(
      input({
        subscription: lapsed,
        familyRedemptions: [
          {
            campaignId: 'campaign-2026-01',
            state: 'reconciled',
            targetPeriodKey: 'first:app_store',
          },
        ],
      }),
    );
    expect(result.ok && result.value).toMatchObject({
      subscriberClass: 'lapsed',
      targetPeriodKey: 'first:app_store:2026-07-15T00:00:00.000Z',
    });
  });

  it('flags a cancelled-but-active subscription so confirmation can say renewal must resume', () => {
    const result = validateRedemption(
      input({ subscription: subscription({ status: 'cancelled_active' }) }),
    );
    expect(result.ok && result.value.autoRenewOff).toBe(true);
  });

  it('prices every tier with the approved list price and the campaign percentage (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 5, max: 100 }),
        (slots, pct) => {
          const result = validateRedemption(
            input({ familyPaidSlots: slots, campaign: campaign({ percentOff: pct }) }),
          );
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.value.regularCents).toBe(monthlyPriceCents(slots));
            expect(result.value.nextRegularRenewalCents).toBe(monthlyPriceCents(slots));
            expect(result.value.chargedCents + result.value.discountCents).toBe(
              monthlyPriceCents(slots),
            );
          }
        },
      ),
    );
  });
});

describe('P17 redemption checks, in documented order', () => {
  it('child mode can never redeem, whatever else is true', () => {
    expect(codeOf({ principal: 'child' })).toBe('CHILD_MODE_FORBIDDEN');
    expect(
      codeOf({
        principal: 'child',
        recentAdultUnlock: false,
        campaign: campaign({ status: 'revoked' }),
      }),
    ).toBe('CHILD_MODE_FORBIDDEN');
  });

  it('requires a recently re-authenticated adult before revealing anything about the code', () => {
    expect(codeOf({ recentAdultUnlock: false, campaign: campaign({ status: 'revoked' }) })).toBe(
      'STEP_UP_REQUIRED',
    );
  });

  it.each(['paused', 'revoked', 'ended', 'provisioning', 'failed'] as const)(
    'a %s campaign is not redeemable',
    (status) => {
      expect(codeOf({ campaign: campaign({ status }) })).toBe('CAMPAIGN_NOT_ACTIVE');
    },
  );

  it('redemption is open only inside the calendar window [opensAt, closesAt)', () => {
    expect(codeOf({ now: iso('2026-09-30T23:59:59Z') })).toBe('OUTSIDE_REDEMPTION_WINDOW');
    expect(codeOf({ now: iso('2026-10-01T00:00:00Z') })).toBeNull();
    expect(
      codeOf({
        now: iso('2026-10-31T00:00:00Z'),
        subscription: subscription({
          currentPeriodStart: iso('2026-10-15T00:00:00Z'),
          currentPeriodEnd: iso('2026-11-15T00:00:00Z'),
          finalizedPeriodStarts: [iso('2026-10-15T00:00:00Z')],
        }),
      }),
    ).toBeNull();
    expect(codeOf({ now: iso('2026-11-01T00:00:00Z') })).toBe('OUTSIDE_REDEMPTION_WINDOW');
  });

  it('a revoked code is rejected even in an active campaign', () => {
    expect(
      codeOf({
        code: { codeId: OCT_CODE, campaignId: OCT, usageCount: 0, usageCap: 1, status: 'revoked' },
      }),
    ).toBe('CODE_REVOKED');
  });

  it('code usage limits are distinct from family limits', () => {
    // An individual code already used (or in flight) by someone else.
    expect(
      codeOf({
        code: { codeId: OCT_CODE, campaignId: OCT, usageCount: 1, usageCap: 1, status: 'active' },
      }),
    ).toBe('CODE_USAGE_CAP_REACHED');
    // A shared code used by other families is still fine for this family.
    expect(
      codeOf({
        code: {
          codeId: OCT_CODE,
          campaignId: OCT,
          usageCount: 499,
          usageCap: 500,
          status: 'active',
        },
      }),
    ).toBeNull();
    // A code without its own cap is bounded by the campaign cap only.
    expect(
      codeOf({
        code: {
          codeId: OCT_CODE,
          campaignId: OCT,
          usageCount: 10_000,
          usageCap: null,
          status: 'active',
        },
      }),
    ).toBeNull();
  });

  it('the campaign cap counts in-flight reservations, not just confirmed ones', () => {
    expect(codeOf({ campaign: campaign({ redemptionCap: 500, liveRedemptionCount: 500 }) })).toBe(
      'CAMPAIGN_REDEMPTION_CAP_REACHED',
    );
    expect(
      codeOf({ campaign: campaign({ redemptionCap: 500, liveRedemptionCount: 499 }) }),
    ).toBeNull();
  });

  it('school-scoped campaigns reject families designated to another school', () => {
    const scoped = campaign({ schoolId: SCHOOL_MAPLE });
    expect(codeOf({ campaign: scoped, familySchoolId: SCHOOL_BIRCH })).toBe(
      'SCHOOL_AUDIENCE_MISMATCH',
    );
    expect(codeOf({ campaign: scoped, familySchoolId: SCHOOL_MAPLE })).toBeNull();
    expect(codeOf({ campaign: scoped, familySchoolId: null })).toBeNull();
    expect(codeOf({ familySchoolId: SCHOOL_BIRCH })).toBeNull();
  });

  it('only eligible, configured tiers can redeem', () => {
    expect(codeOf({ campaign: campaign({ eligibleTiers: [1] }) })).toBe('TIER_NOT_ELIGIBLE');
    expect(codeOf({ familyPaidSlots: 5 })).toBe('TIER_NOT_ELIGIBLE');
    expect(codeOf({ familyPaidSlots: 0 })).toBe('TIER_NOT_ELIGIBLE');
  });

  it('subscriber eligibility uses new / existing / lapsed from verified subscription state', () => {
    expect(codeOf({ campaign: campaign({ subscriberEligibility: ['new', 'lapsed'] }) })).toBe(
      'SUBSCRIBER_NOT_ELIGIBLE',
    );
    expect(
      codeOf({ subscription: null, campaign: campaign({ subscriberEligibility: ['existing'] }) }),
    ).toBe('SUBSCRIBER_NOT_ELIGIBLE');
  });

  it('a code is not usable on a channel whose provider mapping is not ready', () => {
    const result = validateRedemption(
      input({
        channelMappings: [
          {
            campaignId: OCT,
            channel: 'app_store',
            status: 'unsupported',
            reason: 'no price point',
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CHANNEL_UNAVAILABLE');
      expect(result.error.details).toMatchObject({ unavailable: 'UNSUPPORTED_BY_PROVIDER' });
    }
  });

  it('an existing subscriber must redeem on the store that manages the subscription', () => {
    expect(codeOf({ channel: 'stripe' })).toBe('CHANNEL_MISMATCH');
  });

  it('billing retry / grace and a passed billing cutoff are reported from target selection', () => {
    expect(codeOf({ subscription: subscription({ status: 'billing_retry' }) })).toBe(
      'SUBSCRIPTION_NOT_IN_GOOD_STANDING',
    );
    expect(codeOf({ now: iso('2026-10-14T12:00:00Z') })).toBe('NEXT_PERIOD_ALREADY_FINALIZED');
  });

  it('each family redeems a campaign once, across guardians, devices and channels', () => {
    for (const state of ['reserved', 'provider_pending', 'confirmed', 'reconciled'] as const) {
      expect(
        codeOf({
          familyRedemptions: [
            { campaignId: OCT, state, targetPeriodKey: '2026-09-15T00:00:00.000Z' },
          ],
        }),
      ).toBe('FAMILY_ALREADY_REDEEMED_CAMPAIGN');
    }
  });

  it('a rejected or expired attempt does not use up the family redemption', () => {
    for (const state of ['rejected', 'expired'] as const) {
      expect(
        codeOf({
          familyRedemptions: [{ campaignId: OCT, state, targetPeriodKey: NEXT_PERIOD_KEY }],
        }),
      ).toBeNull();
    }
  });

  it('at most one pending, not-yet-applied promotion per family', () => {
    // An older attempt still awaiting provider reconciliation blocks a new reservation.
    expect(
      codeOf({
        familyRedemptions: [
          {
            campaignId: SEP,
            state: 'provider_pending',
            targetPeriodKey: '2026-09-15T00:00:00.000Z',
          },
        ],
      }),
    ).toBe('PENDING_PROMOTION_EXISTS');
    // A confirmed promotion for some other future period also blocks (no banking future periods).
    expect(
      codeOf({
        familyRedemptions: [
          { campaignId: SEP, state: 'confirmed', targetPeriodKey: '2026-11-15T00:00:00.000Z' },
        ],
      }),
    ).toBe('PENDING_PROMOTION_EXISTS');
    // A confirmed promotion whose period already started is applied, not pending.
    expect(
      codeOf({
        familyRedemptions: [
          { campaignId: SEP, state: 'confirmed', targetPeriodKey: '2026-09-15T00:00:00.000Z' },
        ],
      }),
    ).toBeNull();
  });

  it('never stacks two discounts on one billing period', () => {
    for (const state of ['reserved', 'provider_pending', 'confirmed', 'reconciled'] as const) {
      expect(
        codeOf({
          familyRedemptions: [{ campaignId: SEP, state, targetPeriodKey: NEXT_PERIOD_KEY }],
        }),
      ).toBe('TARGET_PERIOD_ALREADY_DISCOUNTED');
    }
  });

  it('blocks a second first-period discount through another channel while the first is live', () => {
    expect(
      codeOf({
        subscription: null,
        channel: 'stripe',
        familyRedemptions: [
          { campaignId: SEP, state: 'confirmed', targetPeriodKey: 'first:app_store' },
        ],
      }),
    ).toBe('TARGET_PERIOD_ALREADY_DISCOUNTED');
  });

  it('stops redemption when this discount would exceed the budget cap (in-flight discounts count)', () => {
    expect(
      codeOf({
        campaign: campaign({ budgetCapCents: 1_000_000, committedDiscountCents: 997_502 }),
      }),
    ).toBe('CAMPAIGN_BUDGET_EXHAUSTED');
    expect(
      codeOf({
        campaign: campaign({ budgetCapCents: 1_000_000, committedDiscountCents: 997_501 }),
      }),
    ).toBeNull();
  });

  it('exports every error code it can return', () => {
    const produced = [
      codeOf({ principal: 'child' }),
      codeOf({ recentAdultUnlock: false }),
      codeOf({ campaign: campaign({ status: 'ended' }) }),
      codeOf({ now: iso('2026-11-02T00:00:00Z') }),
      codeOf({ channel: 'stripe' }),
    ];
    for (const code of produced) expect(REDEMPTION_ERROR_CODES).toContain(code);
  });

  it('treats inconsistent inputs as programmer errors', () => {
    expect(() =>
      validateRedemption(
        input({
          code: {
            codeId: OCT_CODE,
            campaignId: SEP,
            usageCount: 0,
            usageCap: null,
            status: 'active',
          },
        }),
      ),
    ).toThrow(RangeError);
    expect(() =>
      validateRedemption(
        input({
          familyRedemptions: [
            {
              familyId: 'another-family',
              campaignId: SEP,
              state: 'confirmed',
              targetPeriodKey: NEXT_PERIOD_KEY,
            },
          ],
        }),
      ),
    ).toThrow(/family/i);
    expect(() => validateRedemption(input({ now: new Date(Number.NaN) }))).toThrow(RangeError);
  });

  it('fails closed on corrupt limits instead of letting a NaN comparison pass', () => {
    for (const corrupt of [
      campaign({ budgetCapCents: Number.NaN }),
      campaign({ redemptionCap: Number.NaN }),
      campaign({ committedDiscountCents: Number.NaN }),
      campaign({ liveRedemptionCount: -1 }),
      campaign({ closesAt: iso('2026-10-01T00:00:00Z') }),
    ]) {
      expect(() => validateRedemption(input({ campaign: corrupt }))).toThrow(RangeError);
    }
    expect(() =>
      validateRedemption(
        input({
          code: {
            codeId: OCT_CODE,
            campaignId: OCT,
            usageCount: 0,
            usageCap: Number.NaN,
            status: 'active',
          },
        }),
      ),
    ).toThrow(RangeError);
  });
});

describe('P17 caps and budget under concurrent requests (AC_PROMO_05)', () => {
  it('summarizes usage from live rows only, counting in-flight work', () => {
    const rows = [
      { state: 'reserved', discountCents: 2499 },
      { state: 'provider_pending', discountCents: 6996 },
      { state: 'confirmed', discountCents: 1999 },
      { state: 'reconciled', discountCents: 1000 },
      { state: 'rejected', discountCents: 5000 },
      { state: 'expired', discountCents: 5000 },
    ] as const;
    expect(summarizeUsage(rows)).toEqual({ liveCount: 4, committedDiscountCents: 12_494 });
  });

  type Action =
    | { kind: 'request'; family: number; slots: number }
    | { kind: 'timeout' | 'submit' | 'confirm' | 'reject'; pick: number };

  const action: fc.Arbitrary<Action> = fc.oneof(
    fc.record({
      kind: fc.constant('request' as const),
      family: fc.integer({ min: 0, max: 7 }),
      slots: fc.integer({ min: 1, max: 4 }),
    }),
    fc.record({
      kind: fc.constantFrom(
        'timeout' as const,
        'submit' as const,
        'confirm' as const,
        'reject' as const,
      ),
      pick: fc.nat(),
    }),
  );

  it('serialized concurrent requests never exceed the redemption cap, the budget or once-per-family (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 20_000 }),
        fc.integer({ min: 5, max: 100 }),
        fc.array(action, { maxLength: 40 }),
        (cap, budget, pct, actions) => {
          const rows: { family: string; state: RedemptionState; discountCents: number }[] = [];
          const step = (from: RedemptionState, to: RedemptionState, pick: number) => {
            const candidates = rows.filter((r) => r.state === from);
            const row = candidates[pick % Math.max(1, candidates.length)];
            if (row) row.state = to;
          };
          for (const a of actions) {
            if (a.kind === 'request') {
              const family = `family-${a.family}`;
              const usage = summarizeUsage(rows);
              const familyRedemptions: FamilyRedemptionRecord[] = rows
                .filter((r) => r.family === family)
                .map((r) => ({ campaignId: OCT, state: r.state, targetPeriodKey: 'first:stripe' }));
              const result = validateRedemption(
                input({
                  familyId: family,
                  subscription: null,
                  channel: 'stripe',
                  familyPaidSlots: a.slots,
                  code: {
                    codeId: OCT_CODE,
                    campaignId: OCT,
                    usageCount: usage.liveCount,
                    usageCap: null,
                    status: 'active',
                  },
                  campaign: campaign({
                    percentOff: pct,
                    redemptionCap: cap,
                    liveRedemptionCount: usage.liveCount,
                    budgetCapCents: budget,
                    committedDiscountCents: usage.committedDiscountCents,
                  }),
                  familyRedemptions,
                }),
              );
              if (result.ok) {
                rows.push({ family, state: 'reserved', discountCents: result.value.discountCents });
              }
            } else if (a.kind === 'timeout') step('reserved', 'expired', a.pick);
            else if (a.kind === 'submit') step('reserved', 'provider_pending', a.pick);
            else if (a.kind === 'confirm') step('provider_pending', 'confirmed', a.pick);
            else step('provider_pending', 'rejected', a.pick);

            const live = rows.filter((r) => !['rejected', 'expired'].includes(r.state));
            expect(live.length).toBeLessThanOrEqual(cap);
            expect(live.reduce((sum, r) => sum + r.discountCents, 0)).toBeLessThanOrEqual(budget);
            const families = live.map((r) => r.family);
            expect(new Set(families).size).toBe(families.length);
          }
        },
      ),
    );
  });
});
