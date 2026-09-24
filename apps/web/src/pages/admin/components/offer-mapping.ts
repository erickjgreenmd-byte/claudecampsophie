import type { z } from 'zod';
import type { campaignSummarySchema, offerMappingInputSchema } from '@pencillift/contracts';
import { applePricePointProblem } from './admin-money.ts';
import { CHANNEL_LABEL, type Channel } from './template-form.ts';

/**
 * Offer-mapping editor model (spec P17 "Provider integration is part of the feature"): one
 * mapping per campaign × channel × paid-slot tier. Pure: no React.
 */

export type Campaign = z.infer<typeof campaignSummarySchema>;
export type CampaignMapping = Campaign['offerMappings'][number];
export type MappingStatus = CampaignMapping['status'];
export type OfferMappingInput = z.infer<typeof offerMappingInputSchema>;

export const MAPPING_STATUS_LABEL: Record<MappingStatus, string> = {
  pending: 'Pending – not provisioned yet',
  ready: 'Ready – redeemable',
  failed: 'Failed provisioning',
  unsupported: 'Unsupported by the store',
};

export function tierLabel(paidSlots: number): string {
  return `${paidSlots} ${paidSlots === 1 ? 'child' : 'children'}`;
}

export function cellLabel(channel: Channel, paidSlots: number): string {
  return `${CHANNEL_LABEL[channel]}, ${tierLabel(paidSlots)}`;
}

/** Why this cell can never be "ready" (the store cannot represent the exact discount), or null. */
export function unsupportedReason(
  channel: Channel,
  paidSlots: number,
  percentOff: number,
): string | null {
  return channel === 'app_store' ? applePricePointProblem(paidSlots, percentOff) : null;
}

export interface MappingFormValues {
  status: MappingStatus;
  providerOfferId: string;
  reason: string;
}

export type MappingErrors = Partial<Record<keyof MappingFormValues, string | undefined>>;

export function validateMapping(
  channel: Channel,
  paidSlots: number,
  percentOff: number,
  values: MappingFormValues,
): { ok: true; input: OfferMappingInput } | { ok: false; errors: MappingErrors } {
  const errors: MappingErrors = {};
  const offerId = values.providerOfferId.trim();
  const reason = values.reason.trim();
  const blocked = unsupportedReason(channel, paidSlots, percentOff);
  if (values.status === 'ready' && blocked) {
    errors.status = 'This exact discount can’t be offered in this store. Mark it unsupported.';
  }
  if (values.status === 'ready' && offerId === '') {
    errors.providerOfferId = 'Enter the provider offer id from the store console.';
  }
  if (offerId.length > 200) errors.providerOfferId = 'The offer id is too long (200 characters).';
  if ((values.status === 'failed' || values.status === 'unsupported') && reason === '') {
    errors.reason =
      values.status === 'failed'
        ? 'Explain why provisioning failed.'
        : 'Explain why this mapping is unsupported.';
  }
  if (reason.length > 300) errors.reason = 'Keep the reason under 300 characters.';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    input: {
      channel,
      paidSlots,
      status: values.status,
      providerOfferId: offerId === '' ? null : offerId,
      reason: reason === '' ? null : reason,
    },
  };
}

/** Channel/tier cells that are redeemable, e.g. ["App Store: 1, 2 children"]. */
export function readySummary(campaign: Campaign): string[] {
  const byChannel = new Map<Channel, number[]>();
  for (const m of campaign.offerMappings) {
    if (m.status !== 'ready') continue;
    byChannel.set(m.channel, [...(byChannel.get(m.channel) ?? []), m.paidSlots]);
  }
  return [...byChannel.entries()].map(
    ([channel, tiers]) =>
      `${CHANNEL_LABEL[channel]}: ${[...tiers].sort((a, b) => a - b).join(', ')} ${tiers.length === 1 && tiers[0] === 1 ? 'child' : 'children'}`,
  );
}
