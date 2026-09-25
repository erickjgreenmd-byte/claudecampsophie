import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  baseSubscriptionId,
  classifyPurchaseError,
  isUsablePublicSdkKey,
  managementUrl,
  productMatches,
  usdCentsFromStorePrice,
} from './store.ts';

const CODES = { cancelled: '1', pending: '20' };

// --- Labeled mocks of the native layer, used only by the revenuecat.ts tests below. store.ts itself
// is pure and imports none of these. Nothing here talks to a store, RevenueCat or a device.
const native = vi.hoisted(() => {
  const extra: Record<string, unknown> = { revenueCatIosKey: 'appl_StoreTestPublicKey01' };
  return {
    appState: { currentState: 'active' },
    platform: { OS: 'ios' },
    extra,
    purchases: {
      configure: vi.fn(),
      logIn: vi.fn(() => Promise.resolve({ customerInfo: {}, created: false })),
      logOut: vi.fn(() => Promise.resolve({})),
      getOfferings: vi.fn((): Promise<unknown> => Promise.resolve({ current: null, all: {} })),
      purchasePackage: vi.fn(() => Promise.resolve({})),
      presentCodeRedemptionSheet: vi.fn(() => Promise.resolve()),
      PURCHASES_ERROR_CODE: { PURCHASE_CANCELLED_ERROR: '1', PAYMENT_PENDING_ERROR: '20' },
    },
  };
});
vi.mock('react-native', () => ({
  Platform: native.platform,
  Linking: { openURL: vi.fn(() => Promise.resolve()) },
  AppState: native.appState,
}));

/** Points the mocked build at one platform and one set of `extra` values (mutated in place). */
function setBuild(os: string, extra: Record<string, unknown>): void {
  native.platform.OS = os;
  for (const key of Object.keys(native.extra)) delete native.extra[key];
  Object.assign(native.extra, extra);
}
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: native.extra } } }));
vi.mock('react-native-purchases', () => ({ default: native.purchases }));

describe('native purchases are feature-gated on a real public SDK key', () => {
  it.each([
    ['appl_AbCdEf1234567890', true],
    ['goog_AbCdEf1234567890', true],
    ['amzn_AbCdEf1234567890', true],
    ['', false],
    ['   ', false],
    ['short', false],
    ['sk_live_secret_key_value_123', false],
    ['SK_something_secret_12345', false],
    ['appl_has space_12345', false],
    [null, false],
    [undefined, false],
    [42, false],
  ])('%s → %s', (key, usable) => {
    expect(isUsablePublicSdkKey(key)).toBe(usable);
  });

  it.each([
    ['rk_live_restricted_key_value_123', undefined],
    ['strp_AbCdEf1234567890', undefined],
    ['amzn_', undefined],
    ['appl_', undefined],
    ['goog_AbCdEf1234567890', 'app_store'],
    ['appl_AbCdEf1234567890', 'play_store'],
    // Fire tablet builds: a Google Play key never drives an Amazon build, nor the reverse.
    ['goog_AbCdEf1234567890', 'amazon_appstore'],
    ['appl_AbCdEf1234567890', 'amazon_appstore'],
    ['amzn_AbCdEf1234567890', 'play_store'],
    ['amzn_AbCdEf1234567890', 'app_store'],
  ] as const)('allowlist: %s for %s → false (RV-billing-6)', (key, channel) => {
    expect(isUsablePublicSdkKey(key, channel)).toBe(false);
  });

  it('accepts each store’s own public key shape', () => {
    expect(isUsablePublicSdkKey('appl_AbCdEf1234567890', 'app_store')).toBe(true);
    expect(isUsablePublicSdkKey('goog_AbCdEf1234567890', 'play_store')).toBe(true);
    expect(isUsablePublicSdkKey('amzn_AbCdEf1234567890', 'amazon_appstore')).toBe(true);
  });
});

describe('app.config.ts never embeds a non-public RevenueCat key (RV-billing-6)', () => {
  const NAMES = [
    'EXPO_PUBLIC_REVENUECAT_IOS_KEY',
    'EXPO_PUBLIC_REVENUECAT_ANDROID_KEY',
    'EXPO_PUBLIC_REVENUECAT_AMAZON_KEY',
    'EXPO_PUBLIC_ANDROID_STORE',
  ] as const;
  const saved = NAMES.map((name) => process.env[name]);
  afterEach(() => {
    NAMES.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
    vi.resetModules();
  });

  async function loadExtra(): Promise<Record<string, unknown>> {
    vi.resetModules();
    const mod = (await import('../../app.config.ts')) as {
      default: { extra?: Record<string, unknown> };
    };
    return mod.default.extra ?? {};
  }

  it('embeds the platforms’ public keys and leaves blank ones out', async () => {
    process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY = ' appl_AbCdEf1234567890 ';
    process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY = '   ';
    const extra = await loadExtra();
    expect(extra.revenueCatIosKey).toBe('appl_AbCdEf1234567890');
    expect(extra.revenueCatAndroidKey).toBeNull();
  });

  it('an Amazon build embeds the amzn_ key and says which Android store it is for', async () => {
    process.env.EXPO_PUBLIC_REVENUECAT_AMAZON_KEY = ' amzn_AbCdEf1234567890 ';
    process.env.EXPO_PUBLIC_ANDROID_STORE = 'amazon';
    const extra = await loadExtra();
    expect(extra.revenueCatAmazonKey).toBe('amzn_AbCdEf1234567890');
    expect(extra.androidStore).toBe('amazon');
  });

  it('defaults to a Google Play build and refuses an unknown Android store', async () => {
    delete process.env.EXPO_PUBLIC_ANDROID_STORE;
    expect((await loadExtra()).androidStore).toBe('play');
    process.env.EXPO_PUBLIC_ANDROID_STORE = 'fire';
    await expect(loadExtra()).rejects.toThrow(
      /EXPO_PUBLIC_ANDROID_STORE must be "play" or "amazon"/,
    );
  });

  it.each([
    ['EXPO_PUBLIC_REVENUECAT_IOS_KEY', 'sk_live_Synthetic_Secret_0001'],
    ['EXPO_PUBLIC_REVENUECAT_IOS_KEY', 'goog_AbCdEf1234567890'],
    ['EXPO_PUBLIC_REVENUECAT_ANDROID_KEY', 'appl_AbCdEf1234567890'],
    ['EXPO_PUBLIC_REVENUECAT_ANDROID_KEY', 'rk_SyntheticRestricted0001'],
    ['EXPO_PUBLIC_REVENUECAT_ANDROID_KEY', 'amzn_AbCdEf1234567890'],
    ['EXPO_PUBLIC_REVENUECAT_AMAZON_KEY', 'goog_AbCdEf1234567890'],
    ['EXPO_PUBLIC_REVENUECAT_AMAZON_KEY', 'sk_live_Synthetic_Secret_0002'],
  ] as const)('%s=%s fails the build without printing the value', async (name, value) => {
    process.env[name] = value;
    const failure = await loadExtra().then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failure).toMatch(new RegExp(`^${name} is not a RevenueCat public`));
    expect(failure).not.toContain(value);
  });
});

describe('revenuecat.ts store identity (RV-billing-7; labeled native mocks)', () => {
  beforeEach(() => {
    vi.resetModules();
    native.appState.currentState = 'active';
    setBuild('ios', { revenueCatIosKey: 'appl_StoreTestPublicKey01' });
    native.purchases.configure.mockClear();
    native.purchases.logIn.mockClear();
    native.purchases.logOut.mockClear();
  });

  async function load() {
    const session = await import('../family/parent-session.ts');
    const revenuecat = await import('./revenuecat.ts');
    session.registerParentTokenSource(() => Promise.resolve('parent-token-mock'));
    return { session, revenuecat };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('configures once, then switches families with logIn, never a second configure', async () => {
    const { revenuecat } = await load();
    await revenuecat.identifyStoreAccount('fam_aaaaaaaaaaaaaaaaaaaaaaaa');
    await revenuecat.forgetStoreIdentity();
    await revenuecat.identifyStoreAccount('fam_bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(native.purchases.configure).toHaveBeenCalledTimes(1);
    expect(native.purchases.logOut).toHaveBeenCalledTimes(1);
    expect(native.purchases.logIn).toHaveBeenCalledWith('fam_bbbbbbbbbbbbbbbbbbbbbbbb');
  });

  it('entering child mode unbinds the store SDK from the family', async () => {
    const { session, revenuecat } = await load();
    await revenuecat.identifyStoreAccount('fam_aaaaaaaaaaaaaaaaaaaaaaaa');
    session.clearAdultCaches(); // enterChildMode (src/lib/mode.ts), app in the foreground
    await settle();
    expect(native.purchases.logOut).toHaveBeenCalledTimes(1);
  });

  it('leaving the app in parent mode (e.g. for the store’s own sheet) keeps the identity', async () => {
    const { session, revenuecat } = await load();
    await revenuecat.identifyStoreAccount('fam_aaaaaaaaaaaaaaaaaaaaaaaa');
    native.appState.currentState = 'background';
    session.clearAdultCaches(); // app-session.ts relock on background
    await settle();
    expect(native.purchases.logOut).not.toHaveBeenCalled();
    // …but a sign-out while in the background still unbinds.
    session.registerParentTokenSource(null);
    session.clearAdultCaches();
    await settle();
    expect(native.purchases.logOut).toHaveBeenCalledTimes(1);
  });

  it('uses only this platform’s public key: an Android key on iOS leaves purchases off', async () => {
    native.extra.revenueCatIosKey = 'goog_AbCdEf1234567890';
    try {
      const { revenuecat } = await load();
      expect(revenuecat.revenueCatPublicKey()).toBeNull();
      expect(revenuecat.createNativeBillingStore().available).toBe(false);
    } finally {
      native.extra.revenueCatIosKey = 'appl_StoreTestPublicKey01';
    }
  });
});

describe('Amazon Appstore builds for Fire tablets (labeled native mocks)', () => {
  const AMAZON_KEY = 'amzn_FireTestPublicKey001';
  const PLAY_KEY = 'goog_PlayTestPublicKey001';
  const REF = 'fam_cccccccccccccccccccccccc';

  beforeEach(() => {
    native.appState.currentState = 'active';
    native.purchases.configure.mockClear();
    native.purchases.getOfferings.mockClear();
    native.purchases.purchasePackage.mockClear();
    native.purchases.presentCodeRedemptionSheet.mockClear();
  });

  afterEach(() => {
    setBuild('ios', { revenueCatIosKey: 'appl_StoreTestPublicKey01' });
    vi.resetModules();
  });

  async function loadOn(os: string, extra: Record<string, unknown>) {
    setBuild(os, extra);
    vi.resetModules();
    const session = await import('../family/parent-session.ts');
    session.registerParentTokenSource(() => Promise.resolve('parent-token-mock'));
    return import('./revenuecat.ts');
  }

  it('an Amazon build reports the Amazon Appstore, uses only the amzn_ key and configures useAmazon', async () => {
    const rc = await loadOn('android', {
      revenueCatAndroidKey: PLAY_KEY,
      revenueCatAmazonKey: AMAZON_KEY,
      androidStore: 'amazon',
    });
    expect(rc.storeChannelForBuild()).toBe('amazon_appstore');
    expect(rc.revenueCatPublicKey()).toBe(AMAZON_KEY);
    expect(rc.createNativeBillingStore()).toMatchObject({
      channel: 'amazon_appstore',
      available: true,
    });
    await rc.identifyStoreAccount(REF);
    expect(native.purchases.configure).toHaveBeenCalledTimes(1);
    expect(native.purchases.configure).toHaveBeenCalledWith({
      apiKey: AMAZON_KEY,
      appUserID: REF,
      useAmazon: true,
    });
  });

  it('a Google Play build (the default) never uses the Amazon key and never sets useAmazon', async () => {
    const rc = await loadOn('android', {
      revenueCatAndroidKey: PLAY_KEY,
      revenueCatAmazonKey: AMAZON_KEY,
    });
    expect(rc.storeChannelForBuild()).toBe('play_store');
    expect(rc.revenueCatPublicKey()).toBe(PLAY_KEY);
    await rc.identifyStoreAccount(REF);
    expect(native.purchases.configure).toHaveBeenCalledWith({ apiKey: PLAY_KEY, appUserID: REF });
  });

  it('a goog_ key in the Amazon slot (or an amzn_ key in the Play slot) leaves purchases off', async () => {
    const amazon = await loadOn('android', {
      revenueCatAmazonKey: PLAY_KEY,
      androidStore: 'amazon',
    });
    expect(amazon.revenueCatPublicKey()).toBeNull();
    expect(amazon.createNativeBillingStore().available).toBe(false);
    const play = await loadOn('android', {
      revenueCatAndroidKey: AMAZON_KEY,
      androidStore: 'play',
    });
    expect(play.revenueCatPublicKey()).toBeNull();
    expect(play.createNativeBillingStore().available).toBe(false);
    expect(native.purchases.configure).not.toHaveBeenCalled();
  });

  it('the App Store offer-code sheet stays iOS-only on a Fire tablet', async () => {
    const rc = await loadOn('android', { revenueCatAmazonKey: AMAZON_KEY, androidStore: 'amazon' });
    await expect(
      rc.createNativeOfferRedemptionStore(REF).presentAppStoreCodeSheet(),
    ).rejects.toThrow(/iOS only/);
    expect(native.purchases.presentCodeRedemptionSheet).not.toHaveBeenCalled();
  });

  it('an Amazon purchase is a plain package purchase and never starts a second subscription', async () => {
    const rc = await loadOn('android', { revenueCatAmazonKey: AMAZON_KEY, androidStore: 'amazon' });
    const pkg = {
      product: {
        identifier: 'pl_family_2',
        priceString: '$49.98',
        price: 49.98,
        currencyCode: 'USD',
      },
    };
    native.purchases.getOfferings.mockResolvedValueOnce({
      current: { availablePackages: [pkg] },
      all: {},
    });
    const store = rc.createNativeBillingStore();
    await store.identify(REF);
    expect(await store.loadProducts()).toEqual([
      { productId: 'pl_family_2', priceText: '$49.98', usdCents: 4998, currencyCode: 'USD' },
    ]);
    const change = await store.purchase({
      productId: 'pl_family_2',
      replacing: { productId: 'pl_family_1', direction: 'upgrade' },
    });
    expect(change).toMatchObject({
      kind: 'failed',
      message: expect.stringMatching(/Cancel your current plan in the Amazon Appstore first/),
    });
    expect(native.purchases.purchasePackage).not.toHaveBeenCalled();
    expect(await store.purchase({ productId: 'pl_family_2', replacing: null })).toEqual({
      kind: 'success',
    });
    expect(native.purchases.purchasePackage).toHaveBeenCalledWith(pkg);
  });
});

describe('store product matching', () => {
  it('matches exact ids and Google `subscription:basePlan` ids, nothing looser', () => {
    expect(productMatches('pl_family_2', 'pl_family_2')).toBe(true);
    expect(productMatches('pl_family_2', 'pl_family_2:monthly')).toBe(true);
    expect(productMatches('pl_family_2', 'pl_family_20')).toBe(false);
    expect(productMatches('pl_family_2', 'pl_family_20:monthly')).toBe(false);
    expect(baseSubscriptionId('pl_family_2:monthly')).toBe('pl_family_2');
    expect(baseSubscriptionId('pl_family_2')).toBe('pl_family_2');
  });

  it('converts only real USD prices to cents', () => {
    expect(usdCentsFromStorePrice(49.99, 'USD')).toBe(4999);
    expect(usdCentsFromStorePrice(49.98, 'usd')).toBe(4998);
    expect(usdCentsFromStorePrice(45.99, 'EUR')).toBeNull();
    expect(usdCentsFromStorePrice(0, 'USD')).toBeNull();
    expect(usdCentsFromStorePrice(Number.NaN, 'USD')).toBeNull();
  });
});

describe('store purchase errors never count as paid', () => {
  it('maps cancellation and Ask to Buy / payment pending, and fails closed otherwise', () => {
    expect(classifyPurchaseError({ code: '1' }, CODES)).toEqual({ kind: 'cancelled' });
    expect(classifyPurchaseError({ code: '9', userCancelled: true }, CODES)).toEqual({
      kind: 'cancelled',
    });
    expect(classifyPurchaseError({ code: '20' }, CODES)).toEqual({ kind: 'pending' });
    for (const error of [{ code: '6' }, new Error('boom'), 'text', null, undefined]) {
      expect(classifyPurchaseError(error, CODES).kind).toBe('failed');
    }
  });
});

describe('manage subscription goes to the platform’s own page', () => {
  it('uses a provider URL only on the store’s https domain', () => {
    expect(
      managementUrl('app_store', 'https://apps.apple.com/account/subscriptions', 'com.x'),
    ).toBe('https://apps.apple.com/account/subscriptions');
    expect(managementUrl('app_store', 'http://apps.apple.com/account', 'com.x')).toBe(
      'https://apps.apple.com/account/subscriptions',
    );
    expect(managementUrl('app_store', 'https://evil.example/apps.apple.com', 'com.x')).toBe(
      'https://apps.apple.com/account/subscriptions',
    );
    expect(managementUrl('play_store', null, 'com.pencillift.app')).toBe(
      'https://play.google.com/store/account/subscriptions?package=com.pencillift.app',
    );
    expect(managementUrl('play_store', 'not a url', 'com.pencillift.app')).toContain(
      'play.google.com/store/account/subscriptions',
    );
  });

  it('sends a Fire tablet to Amazon’s own subscriptions page, never elsewhere', () => {
    expect(managementUrl('amazon_appstore', null, 'com.pencillift.app')).toBe(
      'https://www.amazon.com/yourmembershipsandsubscriptions',
    );
    expect(
      managementUrl(
        'amazon_appstore',
        'https://www.amazon.com/gp/mas/your-account/myapps/yoursubscriptions',
        'com.x',
      ),
    ).toBe('https://www.amazon.com/gp/mas/your-account/myapps/yoursubscriptions');
    expect(managementUrl('amazon_appstore', 'https://evil.example/www.amazon.com', 'com.x')).toBe(
      'https://www.amazon.com/yourmembershipsandsubscriptions',
    );
    expect(managementUrl('amazon_appstore', 'https://play.google.com/store', 'com.x')).toBe(
      'https://www.amazon.com/yourmembershipsandsubscriptions',
    );
  });
});
