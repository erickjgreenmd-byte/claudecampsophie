import { describe, expect, it } from 'vitest';
import {
  baseSubscriptionId,
  classifyPurchaseError,
  isUsablePublicSdkKey,
  managementUrl,
  productMatches,
  usdCentsFromStorePrice,
} from './store.ts';

const CODES = { cancelled: '1', pending: '20' };

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
