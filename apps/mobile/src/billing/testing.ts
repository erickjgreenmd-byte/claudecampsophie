import type { BillingStatus } from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import type {
  BillingStore,
  OfferRedemptionStore,
  PurchaseRequest,
  StoreChannel,
  StorePurchaseOutcome,
  StoreProductInfo,
  StoreRestoreOutcome,
} from './store.ts';

/**
 * Labeled test doubles for the billing modules (never used by the app). Responses pass through the
 * real contract schemas, like the real API client. Synthetic data only (Riley, Sam).
 */

export const BILLING_REF = 'fam_0123456789abcdef01234567';
export const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
export const SAM = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

const TIERS = [
  { paidSlots: 1, approvedMonthlyCents: 3999 },
  { paidSlots: 2, approvedMonthlyCents: 4998 },
  { paidSlots: 3, approvedMonthlyCents: 5997 },
  { paidSlots: 4, approvedMonthlyCents: 6996 },
];

export function billingStatus(overrides: Partial<BillingStatus> = {}): BillingStatus {
  return {
    billingRef: BILLING_REF,
    paidSlots: 0,
    assignedSlots: 0,
    managingChannel: null,
    conflict: null,
    pendingChange: null,
    requestedChange: null,
    entitlements: [],
    products: (['app_store', 'play_store'] as const).flatMap((channel) =>
      TIERS.map((t) => ({
        channel,
        productId: `pl_family_${t.paidSlots}`,
        paidSlots: t.paidSlots,
        storePriceCents: null,
        priceCheck: 'not_verified' as const,
      })),
    ),
    tiers: TIERS,
    ...overrides,
  };
}

/** Store prices as a US App Store would present them (Apple price points; see the capability matrix). */
export const APP_STORE_PRODUCTS: StoreProductInfo[] = [
  { productId: 'pl_family_1', priceText: '$39.99', usdCents: 3999, currencyCode: 'USD' },
  { productId: 'pl_family_2', priceText: '$49.99', usdCents: 4999, currencyCode: 'USD' },
  { productId: 'pl_family_3', priceText: '$59.99', usdCents: 5999, currencyCode: 'USD' },
  { productId: 'pl_family_4', priceText: '$69.99', usdCents: 6999, currencyCode: 'USD' },
];

/**
 * A synthetic US catalog priced exactly at the approved totals ($39.99 / $49.98 / $59.97 / $69.96),
 * as Google Play can be configured. The App Store can't represent tiers 2–4 today (Owner Action #1),
 * so flow tests use this only where the price itself is not what is under test.
 */
export const APPROVED_PRICE_PRODUCTS: StoreProductInfo[] = [
  { productId: 'pl_family_1', priceText: '$39.99', usdCents: 3999, currencyCode: 'USD' },
  { productId: 'pl_family_2', priceText: '$49.98', usdCents: 4998, currencyCode: 'USD' },
  { productId: 'pl_family_3', priceText: '$59.97', usdCents: 5997, currencyCode: 'USD' },
  { productId: 'pl_family_4', priceText: '$69.96', usdCents: 6996, currencyCode: 'USD' },
];

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export function fakeApi(
  handler: (call: Call) => unknown,
  log: string[] = [],
): { api: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const respond = (call: Call, schema: { parse: (v: unknown) => unknown }): Promise<never> => {
    calls.push(call);
    log.push(`api ${call.method} ${call.path}`);
    const value = handler(call);
    if (value instanceof Error) return Promise.reject(value);
    try {
      return Promise.resolve(schema.parse(value) as never);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  return {
    calls,
    api: {
      get: (path, schema) => respond({ method: 'GET', path, body: undefined }, schema),
      send: (method, path, body, schema) => respond({ method, path, body }, schema),
    },
  };
}

export interface FakeStore extends BillingStore {
  readonly purchases: PurchaseRequest[];
  readonly identified: string[];
  restores: number;
}

export function fakeStore(
  options: {
    channel?: StoreChannel | null;
    available?: boolean;
    outcome?: StorePurchaseOutcome;
    restore?: StoreRestoreOutcome;
    products?: StoreProductInfo[];
  } = {},
  log: string[] = [],
): FakeStore {
  const store: FakeStore = {
    channel: options.channel === undefined ? 'app_store' : options.channel,
    available: options.available ?? true,
    purchases: [],
    identified: [],
    restores: 0,
    identify(ref) {
      log.push(`store identify ${ref}`);
      store.identified.push(ref);
      return Promise.resolve();
    },
    loadProducts() {
      return Promise.resolve(options.products ?? APP_STORE_PRODUCTS);
    },
    purchase(request) {
      log.push(`store purchase ${request.productId}`);
      store.purchases.push(request);
      return Promise.resolve(options.outcome ?? { kind: 'success' });
    },
    restore() {
      log.push('store restore');
      store.restores += 1;
      return Promise.resolve(options.restore ?? { kind: 'restored' });
    },
    openManageSubscriptions() {
      return Promise.resolve();
    },
  };
  return store;
}

export function fakeOfferStore(
  log: string[],
  options: { fail?: boolean } = {},
): OfferRedemptionStore & { urls: string[]; sheets: number } {
  const store = {
    urls: [] as string[],
    sheets: 0,
    presentAppStoreCodeSheet() {
      log.push('store sheet');
      store.sheets += 1;
      return options.fail ? Promise.reject(new Error('sheet failed')) : Promise.resolve();
    },
    openUrl(url: string) {
      log.push(`store url ${url}`);
      store.urls.push(url);
      return options.fail ? Promise.reject(new Error('open failed')) : Promise.resolve();
    },
  };
  return store;
}
