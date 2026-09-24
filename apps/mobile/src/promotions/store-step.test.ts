import { describe, expect, it } from 'vitest';
import type { OfferStepResult } from '../billing/offer-step.ts';
import { storeOfferRequest, storeStepView } from './store-step.ts';
import type { PromoRedemption } from './types.ts';

const ID = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';

function redemption(overrides: Partial<PromoRedemption> = {}): PromoRedemption {
  return {
    id: ID,
    campaignMonth: '2026-10',
    channel: 'app_store',
    state: 'reserved',
    percentOff: 100,
    regularCents: 3999,
    discountCents: 3999,
    chargedCents: 0,
    targetPeriodStart: '2026-10-15T12:00:00.000Z',
    createdAt: '2026-09-20T15:00:00.000Z',
    nextAction: { kind: 'present_store_offer', providerOfferId: 'APPLE-OFFER-01' },
    ...overrides,
  };
}

describe('storeOfferRequest (P17 native store step)', () => {
  it('hands the store the provider offer code, not the PencilLift code', () => {
    expect(storeOfferRequest(redemption())).toEqual({
      redemptionId: ID,
      code: 'APPLE-OFFER-01',
      channel: 'app_store',
    });
  });

  it('keeps the channel the server chose', () => {
    expect(storeOfferRequest(redemption({ channel: 'play_store' }))?.channel).toBe('play_store');
  });

  it('has nothing to do when the server does not ask for the store offer', () => {
    expect(storeOfferRequest(redemption({ nextAction: { kind: 'await_provider' } }))).toBeNull();
    expect(storeOfferRequest(redemption({ nextAction: { kind: 'none' } }))).toBeNull();
    const { nextAction: _omitted, ...withoutAction } = redemption();
    expect(storeOfferRequest(withoutAction)).toBeNull();
  });

  it('refuses a blank provider code instead of opening an empty sheet', () => {
    expect(
      storeOfferRequest(
        redemption({ nextAction: { kind: 'present_store_offer', providerOfferId: '  ' } }),
      ),
    ).toBeNull();
  });
});

describe('storeStepView', () => {
  const base = redemption({ state: 'provider_pending' });
  it('offers a retry only when the store step failed after the server recorded it', () => {
    const cases: [OfferStepResult, boolean][] = [
      [{ kind: 'waiting_for_store', redemption: base, message: 'w' }, false],
      [{ kind: 'store_step_failed', redemption: base, message: 'f' }, true],
      [{ kind: 'submit_failed', message: 's' }, false],
      [{ kind: 'unsupported_channel', message: 'u' }, false],
    ];
    for (const [result, canRetry] of cases) {
      expect(storeStepView(result)).toEqual({ message: result.message, canRetry });
    }
  });
});
