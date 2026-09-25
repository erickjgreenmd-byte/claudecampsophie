import { channelSchema, type BillingChannel } from '@pencillift/contracts';

/**
 * WEB-R1-04: one source for the billing stores the parent portal names. Store columns, radio options
 * and store names are driven from `channelSchema.options` (as the admin console's CHANNELS is), so
 * the Amazon Appstore (Fire tablets) appears wherever the App Store and Google Play do.
 */

export const STORE_NAME: Readonly<Record<BillingChannel, string>> = {
  app_store: 'App Store',
  play_store: 'Google Play',
  amazon_appstore: 'Amazon Appstore',
  stripe: 'Web billing',
};

/** How a parent recognises each store when asked where they are billed. */
export const STORE_OPTION_LABEL: Readonly<Record<BillingChannel, string>> = {
  app_store: 'App Store (iPhone or iPad)',
  play_store: 'Google Play (Android)',
  amazon_appstore: 'Amazon Appstore (Fire tablet)',
  stripe: 'PencilLift web billing',
};

/**
 * Optional web billing (Stripe) is disabled until the owner decides (the API refuses it with
 * CHANNEL_UNAVAILABLE and the billing status contract does not report channel availability), so the
 * portal never offers it. Flip only together with the API's OPTIONAL_STRIPE_WEB_BILLING_ENABLED.
 */
export const WEB_BILLING_ENABLED = false;

/** The channels a family can be billed through, in contract order; web billing only when enabled. */
export function billingChannels(
  webBillingEnabled: boolean = WEB_BILLING_ENABLED,
): BillingChannel[] {
  return channelSchema.options.filter((channel) => channel !== 'stripe' || webBillingEnabled);
}

/** Cancel and purchase notices name the store generically, then every store (WEB-R1-04). */
export const STORE_THAT_BILLS_YOU =
  'the store that bills you (App Store, Google Play or Amazon Appstore)';
