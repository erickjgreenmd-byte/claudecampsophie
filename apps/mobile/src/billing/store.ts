/**
 * The app's view of a native store (App Store, Google Play or, on Fire tablets, the Amazon Appstore,
 * all through RevenueCat), spec P11/P17.
 * Pure: no react-native imports. `revenuecat.ts` implements these interfaces on a device; tests use
 * labeled fakes. Nothing a store reports on the device grants a paid slot by itself: every purchase
 * or restore is followed by a server-side sync, and only the server's verified state is shown.
 */

export type StoreChannel = 'app_store' | 'play_store' | 'amazon_appstore';

export const STORE_LABEL: Record<StoreChannel | 'stripe', string> = {
  app_store: 'the App Store',
  play_store: 'Google Play',
  amazon_appstore: 'the Amazon Appstore',
  stripe: 'web billing',
};

/** One purchasable product as the store itself presents it. */
export interface StoreProductInfo {
  /** Store identifier (Google Play may report `subscriptionId:basePlanId`). */
  readonly productId: string;
  /** The store's own localized price string: what the parent is actually charged. */
  readonly priceText: string;
  /** Price in US cents when the storefront currency is USD; null otherwise (not comparable). */
  readonly usdCents: number | null;
  readonly currencyCode: string;
}

export type StorePurchaseOutcome =
  | { readonly kind: 'success' }
  /** Ask to Buy, deferred or payment pending: nothing is granted until the store completes it. */
  | { readonly kind: 'pending' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string };

export interface PurchaseRequest {
  readonly productId: string;
  /** The store product this family pays for on this store now (Google replacement flows need it). */
  readonly replacing: {
    readonly productId: string;
    readonly direction: 'upgrade' | 'downgrade';
  } | null;
}

export type StoreRestoreOutcome =
  { readonly kind: 'restored' } | { readonly kind: 'failed'; readonly message: string };

export interface BillingStore {
  /** This device's store, or null where there is none (web). */
  readonly channel: StoreChannel | null;
  /** True only when the native SDK is configured with a real public key in this build. */
  readonly available: boolean;
  /** Binds the store SDK to the family's opaque billing ref so purchases belong to this family. */
  identify(billingRef: string): Promise<void>;
  loadProducts(): Promise<StoreProductInfo[]>;
  purchase(request: PurchaseRequest): Promise<StorePurchaseOutcome>;
  restore(): Promise<StoreRestoreOutcome>;
  openManageSubscriptions(): Promise<void>;
}

/** The platform step that applies a store offer code (spec P17 native offer redemption). */
export interface OfferRedemptionStore {
  /** iOS: Apple's code-redemption sheet (Purchases.presentCodeRedemptionSheet). */
  presentAppStoreCodeSheet(): Promise<void>;
  /** Android: opens a URL (the Google Play redeem page). */
  openUrl(url: string): Promise<void>;
}

/** RevenueCat public SDK key prefix per store (the only key shapes that may ship in the app). */
export const PUBLIC_SDK_KEY_PREFIX: Record<StoreChannel, string> = {
  app_store: 'appl_',
  play_store: 'goog_',
  amazon_appstore: 'amzn_',
};

/**
 * A RevenueCat public SDK key is safe to ship in the app; a secret key (`sk_…`) or any other key
 * never is. Allowlist, not denylist (RV-billing-6): only `appl_…` (App Store), `goog_…` (Google
 * Play) and `amzn_…` (Amazon Appstore) public keys qualify, and for a given store only that store's
 * prefix: a `goog_…` key on an Amazon build is refused, and the reverse. Anything else leaves
 * native purchases switched off in this build. app.config.ts applies the same rule at build time
 * so a wrong key never reaches the manifest.
 */
export function isUsablePublicSdkKey(value: unknown, channel?: StoreChannel): value is string {
  if (typeof value !== 'string') return false;
  const key = value.trim();
  const prefixes =
    channel === undefined ? Object.values(PUBLIC_SDK_KEY_PREFIX) : [PUBLIC_SDK_KEY_PREFIX[channel]];
  return prefixes.some(
    (prefix) => key.startsWith(prefix) && /^[A-Za-z0-9]{10,100}$/.test(key.slice(prefix.length)),
  );
}

/**
 * Google Play subscriptions may be identified as `subscriptionId:basePlanId` on the device while
 * the verified catalog stores the subscription id. Decision (to confirm with sandbox evidence,
 * docs/Provider_Capability_Matrix.md §4): match either the exact id or the subscription id part.
 */
export function productMatches(catalogProductId: string, storeProductId: string): boolean {
  if (catalogProductId === storeProductId) return true;
  const [subscriptionId] = storeProductId.split(':');
  return subscriptionId === catalogProductId;
}

/** The subscription id Google Play expects as the "old product" in a replacement. */
export function baseSubscriptionId(productId: string): string {
  return productId.split(':')[0] ?? productId;
}

/** Converts a store price to US cents only when it is actually a USD price. */
export function usdCentsFromStorePrice(price: number, currencyCode: string): number | null {
  if (currencyCode.toUpperCase() !== 'USD' || !Number.isFinite(price) || price <= 0) return null;
  return Math.round(price * 100);
}

/**
 * Maps a store SDK rejection to an outcome. The SDK's own error-code values are passed in so this
 * stays free of native imports. Anything unrecognized is a failure; nothing is ever treated as paid.
 */
export function classifyPurchaseError(
  error: unknown,
  codes: { readonly cancelled: string; readonly pending: string },
): StorePurchaseOutcome {
  const e = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    userCancelled?: unknown;
  };
  if (e.code === codes.cancelled || e.userCancelled === true) return { kind: 'cancelled' };
  if (e.code === codes.pending) return { kind: 'pending' };
  return {
    kind: 'failed',
    message: 'The store couldn’t complete the purchase. You haven’t been charged by PencilLift.',
  };
}

const DEFAULT_MANAGEMENT_URL: Record<StoreChannel, (packageName: string) => string> = {
  app_store: () => 'https://apps.apple.com/account/subscriptions',
  play_store: (pkg) =>
    `https://play.google.com/store/account/subscriptions?package=${encodeURIComponent(pkg)}`,
  // Amazon's "Your Memberships & Subscriptions" page lists Appstore subscriptions (to confirm on a
  // Fire device once an Amazon developer account exists; docs/Connections.md).
  amazon_appstore: () => 'https://www.amazon.com/yourmembershipsandsubscriptions',
};

/** The store's own web domain, the only place a provider-reported management link may point. */
const STORE_HOST: Record<StoreChannel, (hostname: string) => boolean> = {
  app_store: (host) => host === 'apps.apple.com',
  play_store: (host) => host === 'play.google.com',
  amazon_appstore: (host) => host === 'www.amazon.com' || host.endsWith('.amazon.com'),
};

/**
 * Where "Manage subscription" goes: the provider-reported management URL when it is an https link
 * on the store's own domain, otherwise the platform's standard subscription page.
 */
export function managementUrl(
  channel: StoreChannel,
  providerUrl: string | null,
  packageName: string,
): string {
  if (providerUrl) {
    try {
      const url = new URL(providerUrl);
      if (url.protocol === 'https:' && STORE_HOST[channel](url.hostname)) return url.toString();
    } catch {
      // Fall through to the platform default.
    }
  }
  return DEFAULT_MANAGEMENT_URL[channel](packageName);
}
