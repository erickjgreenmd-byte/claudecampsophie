import type { z } from 'zod';
import type {
  campaignStatusSchema,
  campaignSummarySchema,
  offerMappingInputSchema,
} from '@pencillift/contracts';
import { applePricePointProblem } from './admin-money.ts';
import { CHANNEL_LABEL, type Channel } from './template-form.ts';

/**
 * Offer-mapping editor model (spec P17 "Provider integration is part of the feature"): one
 * mapping per campaign × channel × paid-slot tier. Pure: no React.
 */

export type Campaign = z.infer<typeof campaignSummarySchema>;
export type CampaignStatus = z.infer<typeof campaignStatusSchema>;
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
  // RV-p17-ui-5: a cell the store can never represent is recorded as unsupported, whatever row
  // already exists (generation creates a `pending` row for every channel × tier). Leaving it
  // pending or failed would hide that it can never be provisioned (spec P17: "expose a precise
  // unavailable status"; "Never silently round an unsupported native price").
  if (blocked && values.status !== 'unsupported') {
    errors.status =
      'This exact discount can’t be offered in this store. Record it as unsupported with a reason.';
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

/**
 * The status a new editor starts from. A blocked cell always starts as unsupported (RV-p17-ui-5),
 * so saving it unchanged can never store a pending or failed row for a price the store can't offer.
 */
export function initialMappingValues(
  channel: Channel,
  paidSlots: number,
  percentOff: number,
  current: CampaignMapping | undefined,
): MappingFormValues {
  const blocked = unsupportedReason(channel, paidSlots, percentOff);
  return {
    status: blocked ? 'unsupported' : (current?.status ?? 'pending'),
    providerOfferId: current?.providerOfferId ?? '',
    reason: current?.reason ?? '',
  };
}

/** Channel/tier cells with a ready store mapping, e.g. ["App Store: 1, 2 children"]. */
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

export const NOT_READY_NOTICE =
  'Not redeemable on any store yet — don’t advertise this code until a mapping is ready.';

/** Why a campaign in a status other than active accepts no redemptions, in owner-facing words. */
const NOT_REDEEMABLE_NOTICE: Readonly<Record<Exclude<CampaignStatus, 'active'>, string>> = {
  provisioning: NOT_READY_NOTICE,
  paused:
    'Not redeemable while paused — don’t advertise this code. Resume the campaign to accept new redemptions.',
  revoked: 'Not redeemable — this campaign was revoked. Don’t share its code; it no longer works.',
  ended: 'Not redeemable — this campaign’s redemption window has ended. Don’t share its code.',
  failed:
    'Not redeemable — provisioning failed. Don’t advertise this code; fix its store mappings or revoke it.',
};

export type Redeemability =
  | { readonly redeemable: true; readonly channels: readonly string[] }
  | { readonly redeemable: false; readonly notice: string };

/**
 * Whether the owner may advertise the campaign's code, and where (RV-p17-ui-1). Only an active
 * campaign accepts redemptions, so a ready store mapping alone never makes a paused, revoked, ended
 * or failed campaign redeemable (spec P17: "never advertise a code as usable until its channel
 * mapping is ready"; revoking keeps its mappings ready on the server).
 */
export function campaignRedeemability(campaign: Campaign): Redeemability {
  if (campaign.status !== 'active') {
    return { redeemable: false, notice: NOT_REDEEMABLE_NOTICE[campaign.status] };
  }
  const channels = readySummary(campaign);
  return channels.length > 0
    ? { redeemable: true, channels }
    : { redeemable: false, notice: NOT_READY_NOTICE };
}

/** A grid cell's mapping status; "redeemable" only while the campaign itself is active. */
export function mappingCellStatus(
  mapping: CampaignMapping | undefined,
  campaign: Campaign,
): string {
  if (!mapping) return 'Not set up';
  if (mapping.status === 'ready' && campaign.status !== 'active') {
    return 'Ready – store offer set up (campaign not redeemable)';
  }
  return MAPPING_STATUS_LABEL[mapping.status];
}
