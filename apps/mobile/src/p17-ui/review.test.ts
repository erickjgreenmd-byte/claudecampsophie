import { describe, expect, it } from 'vitest';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { chooseSchool, redeemPromo } from '../promotions/actions.ts';
import {
  buildQuoteView,
  channelForPlatform,
  savedSchoolMessage,
} from '../promotions/view-model.ts';
import type { FamilySchool, PromoQuote } from '../promotions/types.ts';

/**
 * Independent adversarial review of the p17-ui vertical (mobile parent school and promo logic).
 * Synthetic data only; the fake API passes responses through the real contract schemas.
 */

const CEDAR = {
  id: '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  name: 'Cedar Park Middle',
  city: null,
  region: null,
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Labeled test double. */
function fakeApi(handler: (call: Call) => unknown): { api: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const respond = (call: Call, schema: { parse: (v: unknown) => unknown }): Promise<never> => {
    calls.push(call);
    const value = handler(call);
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(schema.parse(value) as never);
  };
  return {
    calls,
    api: {
      get: (path, schema) => respond({ method: 'GET', path, body: undefined }, schema),
      send: (method, path, body, schema) => respond({ method, path, body }, schema),
    },
  };
}

describe('[RV-p17-ui-4] mobile: a failed school change is not explained as a bad promo code', () => {
  it('[RV-p17-ui-4] NOT_FOUND from PUT /v1/family/school does not say "That code isn’t valid"', async () => {
    const { api, calls } = fakeApi(() => new ApiRequestError('NOT_FOUND', 'School not found', 404));
    const result = await chooseSchool(api, CEDAR);
    expect(calls).toEqual([
      { method: 'PUT', path: '/v1/family/school', body: { schoolId: CEDAR.id } },
    ]);
    expect(result.ok).toBe(false);
    const message = result.ok ? '' : result.problem.message;
    expect(message).not.toMatch(/code/i);
    expect(message).toMatch(/school/i);
  });
});

describe('[RV-p17-ui-8] mobile: a first school choice is not described as "staying"', () => {
  it('[RV-p17-ui-8] savedSchoolMessage for a first designation does not say the school "stays"', () => {
    const next: FamilySchool = {
      current: CEDAR,
      pending: null,
      programTimezone: 'America/Chicago',
      contributionIsPencilLiftFunded: true,
    };
    const message = savedSchoolMessage(next, CEDAR);
    expect(message).toMatch(/Cedar Park Middle/);
    expect(message).not.toMatch(/stays your school/);
  });
});

describe('p17-ui review probes (passing): mobile never steers around store billing', () => {
  const quote: PromoQuote = {
    campaignMonth: '2026-10',
    percentOff: 100,
    channel: 'app_store',
    targetPeriod: { kind: 'first_full_period' },
    regularCents: 3999,
    discountCents: 3999,
    chargedCents: 0,
    nextRegularRenewalCents: 3999,
    isPreview: true,
  };

  it('probe: the app never offers web billing on any platform', () => {
    expect(channelForPlatform('ios')).toBe('app_store');
    expect(channelForPlatform('android')).toBe('play_store');
    expect(channelForPlatform('web')).toBeNull();
  });

  it('probe: a native code cannot be redeemed while the store offer step is unavailable', () => {
    const view = buildQuoteView(quote, { nativeStoreStepAvailable: false, timeZone: 'UTC' });
    expect(view.redeem.available).toBe(false);
    expect(view.renewalLine).toBe('Without a new code your next renewal is $39.99.');
    expect(view.donationLine).toMatch(/\$0 to your school/);
  });

  it('probe: a retried redeem reuses the caller-held idempotency key', async () => {
    const { api, calls } = fakeApi(() => new ApiRequestError('NETWORK', 'offline', 0));
    const request = { code: 'ABCDE-FGHJK-X', channel: 'app_store' as const };
    await redeemPromo(api, request, 'key-0123456789abcdef');
    await redeemPromo(api, request, 'key-0123456789abcdef');
    const keys = calls.map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toEqual(['key-0123456789abcdef', 'key-0123456789abcdef']);
  });
});
