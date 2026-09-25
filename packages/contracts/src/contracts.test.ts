import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  apiErrorBodySchema,
  channelSchema,
  childPairRequestSchema,
  promoQuoteResponseSchema,
  promoRedeemRequestSchema,
} from './index.ts';

describe('contracts', () => {
  it('billing channels are the two phone stores, web billing and the Amazon Appstore', () => {
    expect(channelSchema.options).toEqual(['app_store', 'play_store', 'stripe', 'amazon_appstore']);
    // RevenueCat's store names are mapped by the API, never accepted as channels.
    expect(channelSchema.safeParse('amazon').success).toBe(false);
    expect(channelSchema.safeParse('AMAZON').success).toBe(false);
  });

  it('maps every error code to an HTTP status', () => {
    for (const code of API_ERROR_CODES) {
      expect(API_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });

  it('rejects unknown keys (no mass assignment of role, family or price)', () => {
    const result = promoRedeemRequestSchema.safeParse({
      code: 'ABCDE-FGHJK-M',
      channel: 'stripe',
      idempotencyKey: 'k'.repeat(20),
      familyId: '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c',
      percentOff: 100,
    });
    expect(result.success).toBe(false);
  });

  it('marks promo quotes as previews and requires the regular renewal price', () => {
    const base = {
      campaignMonth: '2026-10',
      percentOff: 50,
      channel: 'stripe',
      targetPeriod: { kind: 'first_full_period' },
      regularCents: 4998,
      discountCents: 2499,
      chargedCents: 2499,
      nextRegularRenewalCents: 4998,
    };
    expect(promoQuoteResponseSchema.safeParse({ ...base, isPreview: true }).success).toBe(true);
    expect(promoQuoteResponseSchema.safeParse({ ...base, isPreview: false }).success).toBe(false);
    const { nextRegularRenewalCents: _omit, ...missing } = base;
    expect(promoQuoteResponseSchema.safeParse({ ...missing, isPreview: true }).success).toBe(false);
  });

  it('error bodies are strict', () => {
    expect(
      apiErrorBodySchema.safeParse({
        error: { code: 'NOT_FOUND', message: 'x', requestId: 'r', stack: 'leak' },
      }).success,
    ).toBe(false);
  });

  it('pairing requests carry no role or family fields', () => {
    expect(
      childPairRequestSchema.safeParse({
        code: 'ABCD1234',
        deviceLabel: 'Tablet',
        platform: 'ios',
        role: 'parent',
      }).success,
    ).toBe(false);
  });
});
