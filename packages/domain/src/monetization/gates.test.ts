import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  evidenceQuality,
  isValidPublisherTag,
  providerGate,
  resolveMerchantMode,
  type MerchantModeInput,
} from './index.ts';
import { ALL_ON, IOS_PROPERTY, NOW, approval } from './test-fixtures.ts';

function input(overrides: Partial<MerchantModeInput> = {}): MerchantModeInput {
  return {
    environment: 'production',
    property: IOS_PROPERTY,
    approvals: [approval()],
    switches: ALL_ON,
    now: NOW,
    linksPermitted: true,
    ...overrides,
  };
}

describe('evidenceQuality (AC_MON_09)', () => {
  it.each([
    'true',
    'TRUE',
    'yes',
    'approved',
    'enabled',
    'ok',
    'test',
    'todo',
    'tbd',
    'pending',
    'n/a',
    '',
    '     ',
    'abc',
    '123456',
    'sk_live_51Habcdefghijklmnop',
    'AKIAABCDEFGHIJKLMNOP',
    'AIzaSyA1234567890abcdefghijklmnopq',
    'a3f9c1d2e4b5a6f7c8d9e0a1b2c3d4e5f6a7b8c9',
    'fixture:',
  ])('rejects %j as evidence', (ref) => {
    expect(evidenceQuality(ref)).toBe('invalid');
  });

  it('accepts a document/ticket style reference and labels fixtures', () => {
    expect(evidenceQuality('OWNER-DOC/amazon-eligibility-2026-09-01#case-4412')).toBe('real');
    expect(evidenceQuality('Apple review 2026-09-10 case 12345')).toBe('real');
    expect(evidenceQuality('fixture:amazon-ios-approved')).toBe('fixture');
  });

  it('never accepts any boolean-like or credential-shaped string (property)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom('true', 'false', 'yes', 'no', 'on', 'off', 'enabled', 'approved'),
          fc.stringMatching(/^sk_(live|test)_[A-Za-z0-9]{16,40}$/),
          fc.stringMatching(/^[0-9a-f]{40,64}$/),
          fc.string({ maxLength: 5 }),
        ),
        (ref) => evidenceQuality(ref) === 'invalid',
      ),
    );
  });
});

describe('publisher tag shape', () => {
  it('accepts store tags and rejects arbitrary values', () => {
    expect(isValidPublisherTag('pencillift-20')).toBe(true);
    expect(isValidPublisherTag('pencillift')).toBe(false);
    expect(isValidPublisherTag('x-20&ascsubtag=child')).toBe(false);
    expect(isValidPublisherTag(null)).toBe(false);
  });
});

describe('resolveMerchantMode (AC_MON_09, AC_MON_10)', () => {
  it('enables amazon_associates only with every gate satisfied', () => {
    expect(resolveMerchantMode(input())).toEqual({
      mode: 'amazon_associates',
      reasons: [],
      tag: 'pencillift-20',
      fixture: false,
    });
  });

  it('switches alone (no approval record) never activate affiliate mode', () => {
    const result = resolveMerchantMode(input({ approvals: [] }));
    expect(result.mode).toBe('plain_link');
    expect(result.tag).toBeNull();
    expect(result.reasons).toContain('NO_APPROVAL');
  });

  it.each([
    ['global switch off', { switches: { ...ALL_ON, global: false } }, 'GLOBAL_SWITCH_OFF'],
    [
      'amazon switch off',
      { switches: { ...ALL_ON, 'provider:amazon_associates': false } },
      'PROVIDER_SWITCH_OFF',
    ],
    ['missing switches fail closed', { switches: {} }, 'GLOBAL_SWITCH_OFF'],
    ['revoked', { approvals: [approval({ status: 'revoked' })] }, 'APPROVAL_NOT_APPROVED'],
    ['pending', { approvals: [approval({ status: 'pending' })] }, 'APPROVAL_NOT_APPROVED'],
    [
      'expired by date',
      { approvals: [approval({ expiresAt: new Date('2026-09-24T14:59:59Z') })] },
      'APPROVAL_EXPIRED',
    ],
    ['expired status', { approvals: [approval({ status: 'expired' })] }, 'APPROVAL_EXPIRED'],
    ['boolean evidence', { approvals: [approval({ evidenceRef: 'true' })] }, 'EVIDENCE_INVALID'],
    [
      'api key as evidence',
      { approvals: [approval({ evidenceRef: 'sk_live_abcdefghijklmnop1234' })] },
      'EVIDENCE_INVALID',
    ],
    [
      'fixture evidence in production',
      { approvals: [approval({ evidenceRef: 'fixture:amazon-ios' })] },
      'FIXTURE_EVIDENCE_OUTSIDE_TEST',
    ],
    [
      'review dated in the future',
      { approvals: [approval({ policyReviewedAt: new Date('2026-10-01T00:00:00Z') })] },
      'APPROVAL_REVIEW_IN_FUTURE',
    ],
    [
      'different property',
      { approvals: [approval({ propertyIdentifier: 'com.other.app' })] },
      'NO_APPROVAL',
    ],
    ['different platform', { approvals: [approval({ platform: 'android' })] }, 'NO_APPROVAL'],
    ['different locale', { approvals: [approval({ locale: 'en-GB' })] }, 'NO_APPROVAL'],
    [
      'generic account (other provider)',
      { approvals: [approval({ provider: 'sponsor_direct' })] },
      'NO_APPROVAL',
    ],
    ['missing tag', { approvals: [approval({ publisherTag: null })] }, 'TAG_MISSING'],
    ['arbitrary tag', { approvals: [approval({ publisherTag: 'anything' })] }, 'TAG_INVALID'],
  ] as const)('%s -> plain_link with a reason', (_label, overrides, reason) => {
    const result = resolveMerchantMode(input(overrides));
    expect(result.mode).toBe('plain_link');
    expect(result.tag).toBeNull();
    expect(result.reasons).toContain(reason);
  });

  it('falls back to education_only where links are not permitted', () => {
    expect(resolveMerchantMode(input({ linksPermitted: false })).mode).toBe('education_only');
  });

  it('labeled fixtures work only in development/test and are reported as fixtures', () => {
    const fixture = [approval({ evidenceRef: 'fixture:amazon-ios' })];
    const dev = resolveMerchantMode(input({ environment: 'test', approvals: fixture }));
    expect(dev).toMatchObject({ mode: 'amazon_associates', fixture: true });
    expect(resolveMerchantMode(input({ environment: 'staging', approvals: fixture })).mode).toBe(
      'plain_link',
    );
  });

  it('a valid approval among invalid ones still passes; an invalid one never does (property)', () => {
    const statusArb = fc.constantFrom<'pending' | 'rejected' | 'revoked' | 'expired'>(
      'pending',
      'rejected',
      'revoked',
      'expired',
    );
    fc.assert(
      fc.property(fc.array(statusArb, { maxLength: 4 }), fc.boolean(), (statuses, includeValid) => {
        const approvals = statuses.map((status, i) => approval({ id: `a${i}`, status }));
        if (includeValid) approvals.push(approval({ id: 'valid' }));
        const mode = resolveMerchantMode(input({ approvals })).mode;
        return mode === (includeValid ? 'amazon_associates' : 'plain_link');
      }),
    );
  });
});

describe('providerGate', () => {
  it('never enables the ad network: no third-party ad adapter ships in this build', () => {
    const gate = providerGate('ad_network', {
      environment: 'production',
      property: IOS_PROPERTY,
      approvals: [approval({ provider: 'ad_network', publisherTag: null })],
      switches: ALL_ON,
      now: NOW,
    });
    expect(gate.enabled).toBe(false);
    expect(gate.reasons).toContain('NO_NETWORK_ADAPTER');
  });

  it('sponsor_direct needs its own approval for the platform', () => {
    const ctx = {
      environment: 'production' as const,
      property: IOS_PROPERTY,
      switches: ALL_ON,
      now: NOW,
    };
    expect(providerGate('sponsor_direct', { ...ctx, approvals: [approval()] }).enabled).toBe(false);
    expect(
      providerGate('sponsor_direct', {
        ...ctx,
        approvals: [approval({ provider: 'sponsor_direct', publisherTag: null })],
      }).enabled,
    ).toBe(true);
  });
});
