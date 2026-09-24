import { describe, expect, it } from 'vitest';
import {
  CONSENT_POLICY_VERSION,
  CONSENT_STATES,
  type ConsentStatus,
  type GuardiansOverview,
} from '@pencillift/contracts';
import { consentBanner } from './consent.ts';
import { guardianSummary } from './guardians.ts';
import { normalizePairingInput, validatePairingCode } from './pairing-code.ts';

/**
 * Independent review of the family vertical (mobile pure logic). These are probes of the riskiest
 * behaviour, verified sound in review; they are expected to pass. Synthetic data only.
 */

const OWNER = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const GUARDIAN = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const INVITE = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const AT = '2026-09-24T15:00:00.000Z';

function status(overrides: Partial<ConsentStatus>): ConsentStatus {
  return {
    state: 'none',
    consentId: null,
    isTestProvider: false,
    configuredProviderIsTest: false,
    verifiedAt: null,
    withdrawnAt: null,
    policyVersion: null,
    currentPolicyVersion: CONSENT_POLICY_VERSION,
    ...overrides,
  };
}

describe('family review probes (mobile)', () => {
  it('probe: only a verified consent turns the banner to ok; a test-provider record is always labelled', () => {
    for (const state of CONSENT_STATES) {
      const banner = consentBanner(status({ state, isTestProvider: true }));
      expect(banner.tone, state).toBe(state === 'verified' ? 'ok' : 'blocked');
      expect(banner.testNote, state).toMatch(/not a real verification/);
    }
    expect(consentBanner(null).tone).toBe('blocked');
  });

  it('probe: the summary shows the caller as "You" and never echoes their own address', () => {
    const overview: GuardiansOverview = {
      callerRole: 'guardian',
      maxAdults: 2,
      members: [
        { userId: OWNER, role: 'owner', email: 'r***t@example.test', isYou: false, acceptedAt: AT },
        {
          userId: GUARDIAN,
          role: 'guardian',
          email: 'sam.guardian@example.test',
          isYou: true,
          acceptedAt: AT,
        },
      ],
      pendingInvitations: [
        { id: INVITE, email: 'a***y@example.test', expiresAt: AT, createdAt: AT },
      ],
    };
    const text = guardianSummary(overview)
      .lines.map((l) => l.text)
      .join('\n');
    // The caller's own address is shown as "You", never echoed.
    expect(text).not.toContain('sam.guardian@example.test');
    expect(text).toContain('Guardian: You');
  });

  it('probe: pairing input never lets symbols outside the server alphabet through', () => {
    expect(validatePairingCode('abcd-efgu').ok).toBe(false); // U is not in Crockford base32
    expect(validatePairingCode('ABCD EFG!').ok).toBe(false);
    expect(normalizePairingInput('o0il-OOIL')).toBe('00110011');
    expect(validatePairingCode('o0il-OOIL')).toEqual({ ok: true, code: '00110011' });
  });
});
