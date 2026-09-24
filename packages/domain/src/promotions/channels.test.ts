import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAPPING_STATUSES, channelAvailability, type ChannelMapping } from './channels.ts';

const CAMPAIGN = 'campaign-oct';
const OTHER = 'campaign-sep';

describe('P17 provider offer mapping gate (AC_PROMO_01, AC_PROMO_06)', () => {
  it('is usable only when the channel mapping is ready', () => {
    const mappings: ChannelMapping[] = [
      { campaignId: CAMPAIGN, channel: 'stripe', status: 'ready' },
      { campaignId: CAMPAIGN, channel: 'app_store', status: 'pending' },
      { campaignId: CAMPAIGN, channel: 'play_store', status: 'failed', reason: 'offer quota' },
    ];
    expect(channelAvailability(mappings, CAMPAIGN, 'stripe')).toEqual({ ready: true });
    expect(channelAvailability(mappings, CAMPAIGN, 'app_store')).toEqual({
      ready: false,
      unavailable: 'MAPPING_PENDING',
    });
    expect(channelAvailability(mappings, CAMPAIGN, 'play_store')).toEqual({
      ready: false,
      unavailable: 'MAPPING_FAILED',
      providerReason: 'offer quota',
    });
  });

  it('reports a precise unsupported status instead of silently changing the offer', () => {
    const mappings: ChannelMapping[] = [
      {
        campaignId: CAMPAIGN,
        channel: 'app_store',
        status: 'unsupported',
        reason: '47.48 is not an App Store price point',
      },
    ];
    expect(channelAvailability(mappings, CAMPAIGN, 'app_store')).toEqual({
      ready: false,
      unavailable: 'UNSUPPORTED_BY_PROVIDER',
      providerReason: '47.48 is not an App Store price point',
    });
  });

  it('a missing mapping, or a ready mapping of another campaign, is never advertised as usable', () => {
    const mappings: ChannelMapping[] = [{ campaignId: OTHER, channel: 'stripe', status: 'ready' }];
    expect(channelAvailability(mappings, CAMPAIGN, 'stripe')).toEqual({
      ready: false,
      unavailable: 'MAPPING_PENDING',
    });
  });

  it('checks the tier-specific mapping when mappings are per paid-slot tier', () => {
    const mappings: ChannelMapping[] = [
      { campaignId: CAMPAIGN, channel: 'app_store', paidSlots: 1, status: 'ready' },
      {
        campaignId: CAMPAIGN,
        channel: 'app_store',
        paidSlots: 2,
        status: 'unsupported',
        reason: 'no price point',
      },
    ];
    expect(channelAvailability(mappings, CAMPAIGN, 'app_store', 1)).toEqual({ ready: true });
    expect(channelAvailability(mappings, CAMPAIGN, 'app_store', 2)).toMatchObject({
      ready: false,
      unavailable: 'UNSUPPORTED_BY_PROVIDER',
    });
    // Without a tier, the channel is only ready if every tier mapping is ready.
    expect(channelAvailability(mappings, CAMPAIGN, 'app_store')).toMatchObject({ ready: false });
  });

  it('fails closed: any non-ready or unknown status among matching mappings blocks the channel', () => {
    const status = fc.constantFrom<string>(...MAPPING_STATUSES, 'mystery');
    fc.assert(
      fc.property(fc.array(status, { minLength: 1, maxLength: 5 }), (statuses) => {
        const mappings = statuses.map(
          (s) => ({ campaignId: CAMPAIGN, channel: 'stripe', status: s }) as ChannelMapping,
        );
        const result = channelAvailability(mappings, CAMPAIGN, 'stripe');
        expect(result.ready).toBe(statuses.every((s) => s === 'ready'));
      }),
    );
  });
});
