import type { OfferChannel, OfferStepResult } from '../billing/offer-step.ts';
import type { PromoRedemption } from './types.ts';

/**
 * Bridges a P17 redemption to the native store step (spec P17 "Provider integration"). Pure: the
 * school screen supplies the API client and the native store. The code handed to the store is the
 * provider's offer code from the server's nextAction, never the PencilLift code the parent typed:
 * Apple's sheet and Google Play only know their own codes.
 */
export interface StoreOfferRequest {
  readonly redemptionId: string;
  readonly code: string;
  readonly channel: OfferChannel;
}

export function storeOfferRequest(redemption: PromoRedemption): StoreOfferRequest | null {
  const action = redemption.nextAction;
  if (action?.kind !== 'present_store_offer') return null;
  const code = action.providerOfferId.trim();
  if (code.length === 0) return null;
  return { redemptionId: redemption.id, code, channel: redemption.channel };
}

export interface StoreStepView {
  readonly message: string;
  /** Offer "Open the store again": the server kept the redemption waiting for the store. */
  readonly canRetry: boolean;
}

export function storeStepView(result: OfferStepResult): StoreStepView {
  switch (result.kind) {
    case 'waiting_for_store':
      return { message: result.message, canRetry: false };
    case 'store_step_failed':
      return { message: result.message, canRetry: true };
    case 'submit_failed':
    case 'unsupported_channel':
      return { message: result.message, canRetry: false };
  }
}
