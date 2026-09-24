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
const native = vi.hoisted(() => ({
  appState: { currentState: 'active' },
  extra: { revenueCatIosKey: 'appl_StoreTestPublicKey01' },
  purchases: {
    configure: vi.fn(),
    logIn: vi.fn(() => Promise.resolve({ customerInfo: {}, created: false })),
    logOut: vi.fn(() => Promise.resolve({})),
  },
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Linking: { openURL: vi.fn(() => Promise.resolve()) },
  AppState: native.appState,
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: native.extra } } }));
vi.mock('react-native-purchases', () => ({ default: native.purchases }));

describe('native purchases are feature-gated on a real public SDK key', () => {
  it.each([
    ['appl_AbCdEf1234567890', true],
    ['goog_AbCdEf1234567890', true],
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
    ['amzn_AbCdEf1234567890', undefined],
    ['appl_', undefined],
    ['goog_AbCdEf1234567890', 'app_store'],
    ['appl_AbCdEf1234567890', 'play_store'],
  ] as const)('allowlist: %s for %s → false (RV-billing-6)', (key, channel) => {
    expect(isUsablePublicSdkKey(key, channel)).toBe(false);
  });

  it('accepts each store’s own public key shape', () => {
    expect(isUsablePublicSdkKey('appl_AbCdEf1234567890', 'app_store')).toBe(true);
    expect(isUsablePublicSdkKey('goog_AbCdEf1234567890', 'play_store')).toBe(true);
  });
});

describe('app.config.ts never embeds a non-public RevenueCat key (RV-billing-6)', () => {
  const NAMES = ['EXPO_PUBLIC_REVENUECAT_IOS_KEY', 'EXPO_PUBLIC_REVENUECAT_ANDROID_KEY'] as const;
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

  it.each([
    ['EXPO_PUBLIC_REVENUECAT_IOS_KEY', 'sk_live_Synthetic_Secret_0001'],
    ['EXPO_PUBLIC_REVENUECAT_IOS_KEY', 'goog_AbCdEf1234567890'],
    ['EXPO_PUBLIC_REVENUECAT_ANDROID_KEY', 'appl_AbCdEf1234567890'],
    ['EXPO_PUBLIC_REVENUECAT_ANDROID_KEY', 'rk_SyntheticRestricted0001'],
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
});
