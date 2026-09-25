import { describe, expect, it } from 'vitest';
import type { ConsentStatus } from '@pencillift/contracts';
import { consentBanner } from './consent.ts';

function status(overrides: Partial<ConsentStatus> = {}): ConsentStatus {
  return {
    state: 'none',
    consentId: null,
    isTestProvider: false,
    configuredProviderIsTest: false,
    verifiedAt: null,
    withdrawnAt: null,
    policyVersion: null,
    currentPolicyVersion: '2026-09-v1',
    ...overrides,
  };
}

describe('consent banner', () => {
  it('blocks and offers to start when there is no consent', () => {
    const banner = consentBanner(status());
    expect(banner).toMatchObject({ tone: 'blocked', action: 'start', testNote: null });
    expect(banner.body).toMatch(/checkbox or your parent PIN can’t replace it/);
  });

  it('labels a test environment before any consent exists', () => {
    const banner = consentBanner(status({ configuredProviderIsTest: true }));
    expect(banner.testNote).toMatch(/not real verification/);
  });

  it('offers a status check while pending, and a real way to start again (RV-family-5)', () => {
    expect(consentBanner(status({ state: 'pending', consentId: 'x' }))).toMatchObject({
      tone: 'blocked',
      action: 'refresh',
      actionLabel: 'Check status',
      secondaryAction: 'start',
      secondaryLabel: 'Start consent again',
    });
  });

  it('offers a second action only while pending', () => {
    for (const state of ['none', 'verified', 'failed', 'withdrawn'] as const) {
      expect(consentBanner(status({ state })), state).toMatchObject({
        secondaryAction: 'none',
        secondaryLabel: null,
      });
    }
    expect(consentBanner(null).secondaryAction).toBe('none');
  });

  it('is ok only when verified, and still flags a test-provider record', () => {
    const real = consentBanner(status({ state: 'verified' }));
    expect(real).toMatchObject({ tone: 'ok', action: 'none', testNote: null });
    const test = consentBanner(status({ state: 'verified', isTestProvider: true }));
    expect(test.tone).toBe('ok');
    expect(test.testNote).toMatch(/can’t enable processing of real children’s data in production/);
  });

  it('allows starting again after failure or withdrawal', () => {
    expect(consentBanner(status({ state: 'failed' })).action).toBe('start');
    expect(consentBanner(status({ state: 'withdrawn' })).action).toBe('start');
    expect(consentBanner(status({ state: 'withdrawn' })).tone).toBe('blocked');
  });

  it('says what withdrawal stops: homework, practice and paired devices (CS-R1-01)', () => {
    const body = consentBanner(status({ state: 'withdrawn' })).body;
    expect(body).toMatch(/won’t process new homework or build practice/);
    expect(body).toMatch(/devices are signed out and can’t be paired/);
    expect(body).toMatch(/records already collected stay until you delete them/);
  });

  it('fails closed when the status could not be loaded', () => {
    expect(consentBanner(null)).toMatchObject({ tone: 'blocked', action: 'none' });
  });
});
