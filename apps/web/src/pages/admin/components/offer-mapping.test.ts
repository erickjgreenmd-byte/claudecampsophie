import { describe, expect, it } from 'vitest';
import {
  campaignRedeemability,
  initialMappingValues,
  mappingCellStatus,
  NOT_READY_NOTICE,
  validateMapping,
  type Campaign,
  type CampaignStatus,
} from './offer-mapping.ts';

// Synthetic data only.
function campaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    templateId: '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c',
    campaignMonth: '2026-10',
    status: 'active',
    percentOff: 5,
    schoolId: null,
    opensAt: '2026-10-01T00:00:00.000Z',
    closesAt: '2026-11-01T00:00:00.000Z',
    redemptionCap: 500,
    liveRedemptions: 0,
    confirmedRedemptions: 0,
    budgetCapCents: 1_000_000,
    committedDiscountCents: 0,
    offerMappings: [
      {
        channel: 'play_store',
        paidSlots: 2,
        status: 'ready',
        providerOfferId: 'play_offer_oct_t2',
        reason: null,
      },
    ],
    ...overrides,
  };
}

describe('campaignRedeemability (RV-p17-ui-1)', () => {
  it('lists the ready stores only for an active campaign', () => {
    expect(campaignRedeemability(campaign())).toEqual({
      redeemable: true,
      channels: ['Google Play: 2 children'],
    });
    expect(campaignRedeemability(campaign({ offerMappings: [] }))).toEqual({
      redeemable: false,
      notice: NOT_READY_NOTICE,
    });
  });

  it.each<[CampaignStatus, RegExp]>([
    ['paused', /while paused/],
    ['revoked', /was revoked/],
    ['ended', /has ended/],
    ['failed', /provisioning failed/],
    ['provisioning', /until a mapping is ready/],
  ])('a %s campaign with a ready mapping is not redeemable', (status, notice) => {
    const result = campaignRedeemability(campaign({ status }));
    expect(result.redeemable).toBe(false);
    expect(result.redeemable ? '' : result.notice).toMatch(notice);
    const mapping = campaign().offerMappings[0];
    expect(mappingCellStatus(mapping, campaign({ status }))).not.toMatch(/redeemable$/);
  });
});

describe('blocked App Store cells (RV-p17-ui-5)', () => {
  const pending = {
    channel: 'app_store' as const,
    paidSlots: 2,
    status: 'pending' as const,
    providerOfferId: null,
    reason: null,
  };

  it('start as unsupported even when a pending row exists', () => {
    // 5% off $49.98 = $47.48, not an App Store price point.
    expect(initialMappingValues('app_store', 2, 5, pending).status).toBe('unsupported');
    // A representable cell keeps its stored status.
    expect(initialMappingValues('play_store', 2, 5, { ...pending, channel: 'play_store' })).toEqual(
      { status: 'pending', providerOfferId: '', reason: '' },
    );
  });

  it.each(['pending', 'failed', 'ready'] as const)('refuses status %s', (status) => {
    const result = validateMapping('app_store', 2, 5, {
      status,
      providerOfferId: 'offer',
      reason: 'x',
    });
    expect(result.ok ? null : result.errors.status).toMatch(/Record it as unsupported/);
  });

  it('accepts unsupported with a reason', () => {
    const result = validateMapping('app_store', 2, 5, {
      status: 'unsupported',
      providerOfferId: '',
      reason: 'Not a price point',
    });
    expect(result.ok && result.input.status).toBe('unsupported');
  });
});
