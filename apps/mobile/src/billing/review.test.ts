// Adversarial review of the mobile billing vertical (spec P3, P11; AC_CAPACITY_02/05, AC_BILLING_05).
// Each `it` is a regression test for a defect found by the review and is expected to FAIL until the
// defect is fixed. Synthetic data only (Riley, Sam). Native modules are replaced by labeled vitest
// mocks: nothing here talks to a store, RevenueCat or a device.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BillingStatus } from '@pencillift/contracts';
import { buildPlanView } from './plan-view.ts';
import { transition, type PurchaseContext } from './purchase-flow.ts';
import type { StoreProductInfo } from './store.ts';
import { APP_STORE_PRODUCTS, billingStatus } from './testing.ts';

// --- Labeled mocks for the native layer (react-native, expo-constants, RevenueCat SDK) -----------

const native = vi.hoisted(() => ({
  purchases: {
    configure: vi.fn(),
    logIn: vi.fn(() => Promise.resolve({ customerInfo: {}, created: false })),
    logOut: vi.fn(() => Promise.resolve({})),
    getOfferings: vi.fn(() => Promise.resolve({ current: null, all: {} })),
    restorePurchases: vi.fn(() => Promise.resolve({})),
    getCustomerInfo: vi.fn(() => Promise.resolve({ managementURL: null })),
    presentCodeRedemptionSheet: vi.fn(() => Promise.resolve()),
    PURCHASES_ERROR_CODE: { PURCHASE_CANCELLED_ERROR: '1', PAYMENT_PENDING_ERROR: '20' },
    STORE_REPLACEMENT_MODE: { CHARGE_PRORATED_PRICE: 'P', DEFERRED: 'D' },
  },
  auth: { onChange: null as null | ((signedIn: boolean) => void) },
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Linking: { openURL: vi.fn(() => Promise.resolve()) },
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { revenueCatIosKey: 'appl_ReviewPublicKey0001' } } },
}));
vi.mock('react-native-purchases', () => ({ default: native.purchases }));
vi.mock('../lib/parent-auth.ts', () => ({
  parentAuth: {
    watch(cb: (signedIn: boolean) => void) {
      native.auth.onChange = cb;
      return () => undefined;
    },
    tokenSource: { accessToken: () => Promise.resolve('parent-token-mock') },
  },
}));
vi.mock('../family/runtime.ts', () => ({
  childSession: { accessToken: { accessToken: () => Promise.resolve(null) } },
  modeEffects: { relockOnServer: () => Promise.resolve() },
}));
vi.mock('../lib/secure-storage.ts', () => ({
  secureStorage: {
    getItem: () => Promise.resolve(null),
    setItem: () => Promise.resolve(),
    deleteItem: () => Promise.resolve(),
  },
}));

const PARENT: PurchaseContext = { mode: 'parent', parentSignedIn: true };
const PERIOD_END = '2026-10-10T17:00:00.000Z';

/** Google Play products priced exactly at the approved totals (so only the scenario under test differs). */
const PLAY_PRODUCTS: StoreProductInfo[] = [
  { productId: 'pl_family_1:monthly', priceText: '$39.99', usdCents: 3999, currencyCode: 'USD' },
  { productId: 'pl_family_2:monthly', priceText: '$49.98', usdCents: 4998, currencyCode: 'USD' },
  { productId: 'pl_family_3:monthly', priceText: '$59.97', usdCents: 5997, currencyCode: 'USD' },
  { productId: 'pl_family_4:monthly', priceText: '$69.96', usdCents: 6996, currencyCode: 'USD' },
];

describe('RV-billing-4: a US store price that is not the approved price is not sold (AC_CAPACITY_02, Owner_Actions #1)', () => {
  it('the $49.99 App Store product for 2 children is blocked with a concrete report, not offered with a notice', () => {
    const status = billingStatus();
    const plan = buildPlanView({
      status,
      deviceChannel: 'app_store',
      storeAvailable: true,
      storeProducts: APP_STORE_PRODUCTS, // $39.99 / $49.99 / $59.99 / $69.99 (Apple price points)
      timeZone: 'UTC',
    });
    // Control: 1 child is exactly representable and stays purchasable.
    expect(plan.tiers[0]!.purchasable).toBe(true);

    const two = plan.tiers.find((t) => t.paidSlots === 2)!;
    // Owner_Actions #1 is undecided and its "Prepared by the builder" column says the code blocks any tier whose
    // store price ≠ approved price. Today the tier is purchasable and the flow opens the store
    // to charge $49.99 (a notice is shown, but activation is not blocked).
    expect(two.purchasable).toBe(false);
    const state = transition(
      { kind: 'idle' },
      { type: 'select', tier: two, plan, status, channel: 'app_store', context: PARENT },
    );
    expect(state.kind).toBe('blocked');
  });
});

describe('RV-billing-5: a live subscription that is not currently granting access still prevents a duplicate (spec P11)', () => {
  it.each(['billing_retry', 'pending'] as const)(
    'an App Store subscription in %s blocks buying a second subscription on Google Play',
    (storeStatus) => {
      const status: BillingStatus = billingStatus({
        // Not granting, so the server reports 0 slots and no managing store …
        paidSlots: 0,
        managingChannel: null,
        entitlements: [
          {
            channel: 'app_store',
            productId: 'pl_family_2',
            paidSlots: 2,
            status: storeStatus,
            periodEnd: PERIOD_END,
            autoRenew: true,
          },
        ],
      });
      const plan = buildPlanView({
        status,
        deviceChannel: 'play_store',
        storeAvailable: true,
        storeProducts: PLAY_PRODUCTS,
        timeZone: 'UTC',
      });
      // … but Apple keeps retrying the charge (or completes the pending purchase), so a Google Play
      // purchase now makes the family pay both stores. Today every tier is purchasable here.
      expect(plan.tiers.filter((t) => t.purchasable).map((t) => t.paidSlots)).toEqual([]);
    },
  );

  it('a Google Play subscription in billing retry is replaced, never duplicated, by a new Play purchase', () => {
    const status: BillingStatus = billingStatus({
      paidSlots: 0,
      managingChannel: null,
      entitlements: [
        {
          channel: 'play_store',
          productId: 'pl_family_2',
          paidSlots: 2,
          status: 'billing_retry',
          periodEnd: PERIOD_END,
          autoRenew: true,
        },
      ],
    });
    const plan = buildPlanView({
      status,
      deviceChannel: 'play_store',
      storeAvailable: true,
      storeProducts: PLAY_PRODUCTS,
      timeZone: 'UTC',
    });
    const outcomes = plan.tiers
      .filter((t) => t.purchasable)
      .map((tier) =>
        transition(
          { kind: 'idle' },
          { type: 'select', tier, plan, status, channel: 'play_store', context: PARENT },
        ),
      );
    for (const state of outcomes) {
      // Today: confirming with `replacing: null`, i.e. a second parallel Play subscription.
      expect(state.kind === 'confirming' ? state.confirmation.replacing : 'blocked').not.toBeNull();
    }
  });
});

describe('RV-billing-6: a RevenueCat secret key never reaches the app bundle (spec P3/P11, CLAUDE.md no secrets)', () => {
  const SECRET = 'sk_live_Review_Synthetic_Secret_0001';
  const saved = process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY;
    else process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY = saved;
    vi.resetModules();
  });

  it('app.config.ts refuses or drops a secret-shaped key instead of embedding it in `extra`', async () => {
    process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY = SECRET;
    vi.resetModules();
    let extra: unknown;
    try {
      const mod = (await import('../../app.config.ts')) as { default: { extra?: unknown } };
      extra = mod.default.extra ?? null;
    } catch {
      extra = null; // Failing the build is an acceptable fix.
    }
    // Today the value is copied verbatim into the manifest `extra` (shipped with every build); only
    // the runtime check in revenuecat.ts declines to use it.
    expect(JSON.stringify(extra)).not.toContain(SECRET);
  });
});

describe('RV-billing-7: signing out unbinds the store SDK from the family (spec P11 "bind purchases to the correct authenticated adult")', () => {
  it('after the parent signs out, RevenueCat is no longer identified as the family’s billing ref', async () => {
    const { initAppSession } = await import('../lib/app-session.ts');
    const { createNativeBillingStore } = await import('./revenuecat.ts');
    const stop = initAppSession();
    try {
      native.auth.onChange?.(true);
      const store = createNativeBillingStore();
      expect(store.available).toBe(true);
      await store.identify('fam_0123456789abcdef01234567');
      expect(native.purchases.configure).toHaveBeenCalledWith(
        expect.objectContaining({ appUserID: 'fam_0123456789abcdef01234567' }),
      );

      // Sign-out. revenuecat.ts documents forgetStoreIdentity() as "wired by the app's session layer
      // (src/lib/app-session.ts)"; it is not called anywhere, so the SDK keeps acting for this family
      // (renewals, Ask to Buy approvals and store-side redemptions sync to its billing ref).
      native.auth.onChange?.(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(native.purchases.logOut).toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});
