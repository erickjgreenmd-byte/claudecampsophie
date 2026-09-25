import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '@pencillift/contracts/client';
import { playRedeemUrl, runStoreOfferStep } from './offer-step.ts';
import { fakeApi, fakeOfferStore } from './testing.ts';

const REDEMPTION = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const CODE = 'ABCDE-FGHJK-X';
const SUBMITTED = `/v1/family/promotions/${REDEMPTION}/submitted`;

function redemption(overrides: Record<string, unknown> = {}) {
  return {
    id: REDEMPTION,
    campaignMonth: '2026-10',
    channel: 'app_store',
    state: 'provider_pending',
    percentOff: 100,
    regularCents: 3999,
    discountCents: 3999,
    chargedCents: 0,
    targetPeriodStart: '2026-10-15T12:00:00.000Z',
    createdAt: '2026-09-20T15:00:00.000Z',
    nextAction: { kind: 'await_provider' },
    ...overrides,
  };
}

/** A result may say "waiting", never that the discount is applied or confirmed. */
const CLAIMS_SUCCESS =
  /(discount|code|offer) (is|was|has been) (applied|confirmed|redeemed)|success/i;

describe('runStoreOfferStep (spec P17 native offer redemption)', () => {
  it('iOS: /submitted first, then Apple’s code sheet, then waiting for the store', async () => {
    const log: string[] = [];
    const { api, calls } = fakeApi(() => redemption(), log);
    const store = fakeOfferStore(log);
    const result = await runStoreOfferStep({
      redemptionId: REDEMPTION,
      code: CODE,
      channel: 'app_store',
      api,
      store,
    });
    expect(log).toEqual([`api POST ${SUBMITTED}`, 'store sheet']);
    expect(calls[0]!.body).toBeUndefined();
    expect(result.kind).toBe('waiting_for_store');
    if (result.kind === 'waiting_for_store') {
      expect(result.redemption.state).toBe('provider_pending');
      expect(result.message).toContain(`enter ${CODE}`);
      expect(result.message).toMatch(/confirmed in your promo history only after the store/);
      expect(result.message).not.toMatch(CLAIMS_SUCCESS);
    }
    expect(store.urls).toEqual([]);
  });

  it('Android: /submitted first, then the Google Play redeem page with the encoded code', async () => {
    const log: string[] = [];
    const { api } = fakeApi(() => redemption({ channel: 'play_store' }), log);
    const store = fakeOfferStore(log);
    const result = await runStoreOfferStep({
      redemptionId: REDEMPTION,
      code: ' AB&CD=1 ',
      channel: 'play_store',
      api,
      store,
    });
    expect(store.urls).toEqual(['https://play.google.com/redeem?code=AB%26CD%3D1']);
    expect(log[0]).toBe(`api POST ${SUBMITTED}`);
    expect(store.sheets).toBe(0);
    expect(result.kind).toBe('waiting_for_store');
    if (result.kind === 'waiting_for_store') expect(result.message).not.toMatch(CLAIMS_SUCCESS);
    expect(playRedeemUrl(CODE)).toBe(`https://play.google.com/redeem?code=${CODE}`);
  });

  it.each([
    [
      'business rule (already submitted/closed)',
      new ApiRequestError('BUSINESS_RULE', 'x', 422, 'INVALID_TRANSITION'),
    ],
    ['not found', new ApiRequestError('NOT_FOUND', 'Not found', 404)],
    ['offline', new ApiRequestError('NETWORK', 'You appear to be offline.', 0)],
    ['server error', new ApiRequestError('INTERNAL', 'boom', 500)],
    ['unexpected throw', new Error('boom')],
  ])('never opens the store step when /submitted fails: %s', async (_label, error) => {
    for (const channel of ['app_store', 'play_store'] as const) {
      const log: string[] = [];
      const { api } = fakeApi(() => error, log);
      const store = fakeOfferStore(log);
      const result = await runStoreOfferStep({
        redemptionId: REDEMPTION,
        code: CODE,
        channel,
        api,
        store,
      });
      expect(result.kind).toBe('submit_failed');
      expect(store.sheets).toBe(0);
      expect(store.urls).toEqual([]);
      expect(log).toEqual([`api POST ${SUBMITTED}`]);
    }
  });

  it('never opens the store step when the server did not hand the redemption to this store', async () => {
    for (const body of [
      redemption({ state: 'confirmed' }),
      redemption({ state: 'rejected' }),
      redemption({ channel: 'play_store' }),
    ]) {
      const log: string[] = [];
      const store = fakeOfferStore(log);
      const result = await runStoreOfferStep({
        redemptionId: REDEMPTION,
        code: CODE,
        channel: 'app_store',
        api: fakeApi(() => body, log).api,
        store,
      });
      expect(result.kind).toBe('submit_failed');
      expect(store.sheets).toBe(0);
    }
  });

  it('a store step that fails to open is reported without claiming anything', async () => {
    const log: string[] = [];
    const store = fakeOfferStore(log, { fail: true });
    const result = await runStoreOfferStep({
      redemptionId: REDEMPTION,
      code: CODE,
      channel: 'app_store',
      api: fakeApi(() => redemption(), log).api,
      store,
    });
    expect(result.kind).toBe('store_step_failed');
    if (result.kind === 'store_step_failed') {
      expect(result.message).toMatch(/didn’t open.*still reserved/);
      expect(result.message).not.toMatch(CLAIMS_SUCCESS);
    }
  });

  it('web billing is not a store step: nothing is called', async () => {
    const log: string[] = [];
    const { api, calls } = fakeApi(() => redemption(), log);
    const store = fakeOfferStore(log);
    const result = await runStoreOfferStep({
      redemptionId: REDEMPTION,
      code: CODE,
      channel: 'stripe',
      api,
      store,
    });
    expect(result.kind).toBe('unsupported_channel');
    expect(calls).toEqual([]);
    expect(log).toEqual([]);
  });

  it('the Amazon Appstore (Fire tablets) has no redemption step: nothing is submitted or opened', async () => {
    const log: string[] = [];
    const { api, calls } = fakeApi(() => redemption(), log);
    const store = fakeOfferStore(log);
    const result = await runStoreOfferStep({
      redemptionId: REDEMPTION,
      code: CODE,
      channel: 'amazon_appstore',
      api,
      store,
    });
    expect(result.kind).toBe('unsupported_channel');
    expect(result).toMatchObject({ message: expect.stringMatching(/Amazon Appstore/) });
    expect(calls).toEqual([]);
    expect(log).toEqual([]);
  });
});
