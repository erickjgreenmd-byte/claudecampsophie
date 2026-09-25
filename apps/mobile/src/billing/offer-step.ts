import { promoRedemptionSchema } from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import type { PromoRedemption } from '../promotions/types.ts';
import type { OfferRedemptionStore } from './store.ts';

/**
 * Native store step of a monthly promo redemption (spec P17 "Provider integration"; AC_PROMO_06/07).
 * Order is fixed and never reversed:
 *   1. POST /v1/family/promotions/:id/submitted  (the server moves the redemption to provider_pending)
 *   2. only if that succeeded, open the platform's redemption step
 *      (iOS: Apple's code-redemption sheet; Android: the Google Play redeem page)
 *   3. report `waiting_for_store`.
 * This module never claims success: a discount is confirmed only by the server after the provider's
 * webhook (GET /v1/family/promotions shows `confirmed`). Pure: no react-native imports.
 */

export type OfferChannel = 'app_store' | 'play_store' | 'stripe' | 'amazon_appstore';

export interface OfferStepInput {
  readonly redemptionId: string;
  /** The code the store should redeem (shown to the parent on iOS, where the sheet can't be prefilled). */
  readonly code: string;
  readonly channel: OfferChannel;
  readonly api: ApiClient;
  readonly store: OfferRedemptionStore;
}

export type OfferStepResult =
  | {
      readonly kind: 'waiting_for_store';
      readonly redemption: PromoRedemption;
      readonly message: string;
    }
  /** The server recorded the submission but the store step didn't open; retrying reopens it. */
  | {
      readonly kind: 'store_step_failed';
      readonly redemption: PromoRedemption;
      readonly message: string;
    }
  /** The server refused or was unreachable: the store step was NOT opened. */
  | { readonly kind: 'submit_failed'; readonly message: string }
  | { readonly kind: 'unsupported_channel'; readonly message: string };

/** Google Play's redeem page for a code. */
export function playRedeemUrl(code: string): string {
  return `https://play.google.com/redeem?code=${encodeURIComponent(code.trim())}`;
}

const CONFIRMATION_NOTE =
  'Your discount shows as confirmed in your promo history only after the store confirms it. Until then, your regular price applies.';

function submitProblem(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'NOT_FOUND') {
      return 'We couldn’t find this promotion. Check its status in your promo history.';
    }
    if (error.code === 'BUSINESS_RULE') {
      return 'This promotion can’t be sent to the store again. Check its status in your promo history.';
    }
    if (error.code === 'NETWORK' || error.code === 'RATE_LIMITED') return error.message;
  }
  return 'Something went wrong, so the store wasn’t opened. Please try again.';
}

export async function runStoreOfferStep(input: OfferStepInput): Promise<OfferStepResult> {
  const { channel, store } = input;
  if (channel === 'amazon_appstore') {
    // The Amazon Appstore has no offer-code sheet or redeem page (spec P17 native offer redemption
    // covers Apple and Google); nothing is submitted to the server and nothing is pretended.
    return {
      kind: 'unsupported_channel',
      message:
        'Promo codes can’t be redeemed through the Amazon Appstore on Fire tablets yet, so this promotion can’t be applied there.',
    };
  }
  if (channel !== 'app_store' && channel !== 'play_store') {
    return {
      kind: 'unsupported_channel',
      message: 'This promotion is applied by web billing, not by an app store.',
    };
  }
  let redemption: PromoRedemption;
  try {
    redemption = await input.api.send(
      'POST',
      `/v1/family/promotions/${encodeURIComponent(input.redemptionId)}/submitted`,
      undefined,
      promoRedemptionSchema,
    );
  } catch (error) {
    return { kind: 'submit_failed', message: submitProblem(error) };
  }
  if (redemption.state !== 'provider_pending' || redemption.channel !== channel) {
    // Defensive: anything but "handed to this store" means there is nothing for the store to do.
    return {
      kind: 'submit_failed',
      message:
        'This promotion isn’t waiting for the store. Check its status in your promo history.',
    };
  }
  try {
    if (channel === 'app_store') await store.presentAppStoreCodeSheet();
    else await store.openUrl(playRedeemUrl(input.code));
  } catch {
    return {
      kind: 'store_step_failed',
      redemption,
      message: `The ${channel === 'app_store' ? 'App Store' : 'Google Play'} redemption step didn’t open. Try again; your code is still reserved for you.`,
    };
  }
  return {
    kind: 'waiting_for_store',
    redemption,
    message:
      channel === 'app_store'
        ? `In the App Store sheet, enter ${input.code.trim()}. ${CONFIRMATION_NOTE}`
        : `Finish redeeming in Google Play. ${CONFIRMATION_NOTE}`,
  };
}
