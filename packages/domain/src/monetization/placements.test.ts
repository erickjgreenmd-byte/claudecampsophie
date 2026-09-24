import fc from 'fast-check';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DEFAULT_PLACEMENT_RULE,
  countViewable,
  selectSponsorCard,
  type SponsorSelectionInput,
} from './index.ts';
import { ALL_ON, NOW, approval, campaign } from './test-fixtures.ts';

const sponsorApproval = approval({ provider: 'sponsor_direct', publisherTag: null });

function input(overrides: Partial<SponsorSelectionInput> = {}): SponsorSelectionInput {
  return {
    campaigns: [campaign({ id: 'camp-a' }), campaign({ id: 'camp-b', viewableImpressions: 500 })],
    placement: 'resources_browse',
    platform: 'ios',
    propertyIdentifier: 'com.pencillift.app',
    locale: 'en-US',
    environment: 'production',
    now: NOW,
    servedThisSession: 0,
    servedCampaignIdsThisSession: [],
    dismissedCampaignIdsThisSession: [],
    rule: DEFAULT_PLACEMENT_RULE,
    prefs: { hideSponsorCards: false },
    adFree: false,
    switches: ALL_ON,
    approvals: [sponsorApproval],
    ...overrides,
  };
}

describe('selectSponsorCard (AC_MON_03/05/07/14)', () => {
  it('returns at most one card: the least-delivered unseen campaign', () => {
    const result = selectSponsorCard(input());
    expect(result).toMatchObject({ kind: 'card', campaign: { id: 'camp-a' } });
    const rotated = selectSponsorCard(input({ servedCampaignIdsThisSession: ['camp-a'] }));
    expect(rotated).toMatchObject({ kind: 'card', campaign: { id: 'camp-b' } });
  });

  it.each([
    ['global kill switch', { switches: { ...ALL_ON, global: false } }, 'disabled'],
    [
      'sponsor switch off',
      { switches: { ...ALL_ON, 'provider:sponsor_direct': false } },
      'disabled',
    ],
    [
      'approval revoked',
      { approvals: [{ ...sponsorApproval, status: 'revoked' as const }] },
      'disabled',
    ],
    ['approval expired', { approvals: [{ ...sponsorApproval, expiresAt: NOW }] }, 'disabled'],
    [
      'placement rule disabled',
      { rule: { ...DEFAULT_PLACEMENT_RULE, enabled: false } },
      'disabled',
    ],
    ['ad-free entitlement', { adFree: true }, 'ad_free'],
    ['parent hid cards', { prefs: { hideSponsorCards: true } }, 'hidden_by_parent'],
    ['three new cards this session', { servedThisSession: 3 }, 'session_cap'],
    ['all dismissed', { dismissedCampaignIdsThisSession: ['camp-a', 'camp-b'] }, 'no_eligible'],
    ['paused campaigns', { campaigns: [campaign({ status: 'paused' })] }, 'no_eligible'],
    [
      'over cap',
      { campaigns: [campaign({ impressionCap: 5, viewableImpressions: 5 })] },
      'no_eligible',
    ],
  ] as const)('%s -> no card (%s)', (_label, overrides, reason) => {
    expect(selectSponsorCard(input(overrides))).toMatchObject({ kind: 'no_card', reason });
  });

  it('a placement rule can lower but never raise the three-card session cap', () => {
    const lowered = { ...DEFAULT_PLACEMENT_RULE, maxNewCardsPerSession: 1 };
    expect(selectSponsorCard(input({ rule: lowered, servedThisSession: 1 }))).toMatchObject({
      reason: 'session_cap',
    });
    const raised = { ...DEFAULT_PLACEMENT_RULE, maxNewCardsPerSession: 10 };
    expect(selectSponsorCard(input({ rule: raised, servedThisSession: 3 }))).toMatchObject({
      reason: 'session_cap',
    });
  });

  it('selection input has no child or learning field (AC_MON_07, type-level)', () => {
    type Keys = keyof SponsorSelectionInput;
    expectTypeOf<
      Extract<
        Keys,
        | 'childId'
        | 'familyId'
        | 'grade'
        | 'gradeLevel'
        | 'ageBand'
        | 'mistakes'
        | 'skills'
        | 'scores'
        | 'nickname'
      >
    >().toEqualTypeOf<never>();
  });

  it('never exceeds the session cap regardless of state (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 10 }),
        (served, ruleMax) => {
          const result = selectSponsorCard(
            input({
              servedThisSession: served,
              rule: { ...DEFAULT_PLACEMENT_RULE, maxNewCardsPerSession: ruleMax },
            }),
          );
          return result.kind === 'no_card' || served < Math.min(3, ruleMax);
        },
      ),
    );
  });
});

describe('countViewable (AC_MON_16)', () => {
  const servedAt = new Date('2026-09-24T15:00:00Z');
  const base = {
    servedAt,
    viewedAt: null,
    dismissedAt: null,
    now: new Date('2026-09-24T15:00:05Z'),
    visibleMs: 1500,
    visibleRatio: 0.8,
    rule: DEFAULT_PLACEMENT_RULE,
  };

  it('counts a card visible >= 1s at >= 50% once', () => {
    expect(countViewable(base)).toEqual({ counted: true });
    expect(countViewable({ ...base, viewedAt: base.now })).toEqual({
      counted: false,
      reason: 'already_counted',
    });
  });

  it.each([
    [{ visibleMs: 999 }, 'below_min_duration'],
    [{ visibleRatio: 0.49 }, 'below_min_ratio'],
    [{ visibleMs: 0, visibleRatio: 0 }, 'below_min_duration'],
    [{ visibleMs: 60_000 }, 'implausible_duration'],
    [{ now: new Date('2026-09-24T16:00:00Z') }, 'stale_serve'],
    [{ visibleMs: Number.NaN }, 'invalid_measurement'],
    [{ visibleRatio: 1.5 }, 'invalid_measurement'],
  ])('%j -> %s', (overrides, reason) => {
    expect(countViewable({ ...base, ...overrides })).toEqual({ counted: false, reason });
  });

  it('a beacon sent the instant a card is served (prefetch) never counts (RV-MON-02)', () => {
    for (const age of [0, 1, 500, 999]) {
      expect(
        countViewable({
          ...base,
          now: new Date(servedAt.getTime() + age),
          visibleMs: DEFAULT_PLACEMENT_RULE.minVisibleMs,
          visibleRatio: 1,
        }),
      ).toEqual({ counted: false, reason: 'implausible_duration' });
    }
    expect(
      countViewable({
        ...base,
        now: new Date(servedAt.getTime() + DEFAULT_PLACEMENT_RULE.minVisibleMs),
        visibleMs: DEFAULT_PLACEMENT_RULE.minVisibleMs,
        visibleRatio: 1,
      }),
    ).toEqual({ counted: true });
  });

  it('a dismissed/reported card is bounded by the time it was actually shown (RV-MON-03)', () => {
    const dismissedEarly = { ...base, dismissedAt: new Date(servedAt.getTime() + 300) };
    expect(countViewable(dismissedEarly)).toEqual({
      counted: false,
      reason: 'implausible_duration',
    });
    expect(countViewable({ ...dismissedEarly, visibleMs: 1000 })).toEqual({
      counted: false,
      reason: 'implausible_duration',
    });
    // Viewed for real before the parent closed it: a late beacon still counts once.
    expect(countViewable({ ...base, dismissedAt: new Date(servedAt.getTime() + 3000) })).toEqual({
      counted: true,
    });
  });

  it('counted impressions always fit a server-side window of at least the minimum (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 120_000 }),
        fc.option(fc.integer({ min: 0, max: 120_000 }), { nil: null }),
        fc.integer({ min: 0, max: 120_000 }),
        (age, dismissedAfter, visible) => {
          const outcome = countViewable({
            ...base,
            now: new Date(servedAt.getTime() + age),
            dismissedAt:
              dismissedAfter === null ? null : new Date(servedAt.getTime() + dismissedAfter),
            visibleMs: visible,
            visibleRatio: 1,
          });
          const shown = Math.min(age, dismissedAfter ?? age);
          return (
            !outcome.counted ||
            (shown >= DEFAULT_PLACEMENT_RULE.minVisibleMs && visible <= shown + 1000)
          );
        },
      ),
    );
  });

  it('a card can never claim more visibility than time since it was served (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 120_000 }),
        fc.integer({ min: 0, max: 120_000 }),
        (age, visible) => {
          const outcome = countViewable({
            ...base,
            now: new Date(servedAt.getTime() + age),
            visibleMs: visible,
            visibleRatio: 1,
          });
          return !outcome.counted || visible <= age + 1000;
        },
      ),
    );
  });
});
