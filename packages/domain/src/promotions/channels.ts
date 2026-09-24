import type { BillingChannel } from '../shared/billing.ts';

/** Provider offer provisioning status for one campaign on one channel (and optionally one tier). */
export const MAPPING_STATUSES = ['pending', 'ready', 'failed', 'unsupported'] as const;
export type MappingStatus = (typeof MAPPING_STATUSES)[number];

export interface ChannelMapping {
  readonly campaignId: string;
  readonly channel: BillingChannel;
  /** Present when mappings are provisioned per paid-slot tier (provider_offer_mappings.paid_slots). */
  readonly paidSlots?: number;
  readonly status: MappingStatus;
  /** Provider/administrator explanation for failed or unsupported mappings. */
  readonly reason?: string;
}

export const CHANNEL_UNAVAILABLE_REASONS = [
  'MAPPING_PENDING',
  'MAPPING_FAILED',
  'UNSUPPORTED_BY_PROVIDER',
] as const;
export type ChannelUnavailableReason = (typeof CHANNEL_UNAVAILABLE_REASONS)[number];

export type ChannelAvailability =
  | { readonly ready: true }
  | {
      readonly ready: false;
      readonly unavailable: ChannelUnavailableReason;
      readonly providerReason?: string;
    };

/**
 * Whether a campaign's code may be advertised/redeemed on `channel` (spec P17: never advertise a
 * code as usable until its channel mapping is ready). Fails closed:
 * - Decision: no matching mapping is reported as MAPPING_PENDING (not yet provisioned).
 * - With `paidSlots`, tier-specific mappings for other tiers are ignored; channel-wide mappings
 *   (no `paidSlots`) always apply. Without it, every matching mapping must be ready.
 * - Mixed statuses report the most definitive problem: unsupported > failed > pending/unknown.
 */
export function channelAvailability(
  mappings: readonly ChannelMapping[],
  campaignId: string,
  channel: BillingChannel,
  paidSlots?: number,
): ChannelAvailability {
  const relevant = mappings.filter(
    (m) =>
      m.campaignId === campaignId &&
      m.channel === channel &&
      (paidSlots === undefined || m.paidSlots === undefined || m.paidSlots === paidSlots),
  );
  if (relevant.length === 0) return { ready: false, unavailable: 'MAPPING_PENDING' };

  const withReason = (unavailable: ChannelUnavailableReason, m: ChannelMapping | undefined) =>
    m?.reason === undefined
      ? ({ ready: false, unavailable } as const)
      : ({ ready: false, unavailable, providerReason: m.reason } as const);

  const unsupported = relevant.find((m) => m.status === 'unsupported');
  if (unsupported) return withReason('UNSUPPORTED_BY_PROVIDER', unsupported);
  const failed = relevant.find((m) => m.status === 'failed');
  if (failed) return withReason('MAPPING_FAILED', failed);
  if (relevant.every((m) => m.status === 'ready')) return { ready: true };
  return { ready: false, unavailable: 'MAPPING_PENDING' };
}
