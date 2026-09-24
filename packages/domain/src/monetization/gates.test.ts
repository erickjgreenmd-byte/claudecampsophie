import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  evidenceQuality,
  isValidPublisherTag,
  providerGate,
  resolveMerchantMode,
  type MerchantModeInput,
} from './index.ts';
import {
  ALL_ON,
  IOS_PROPERTY,
  LINKING_TOOL_REF,
  NOW,
  approval,
  type MonetizationApprovalFixture,
} from './test-fixtures.ts';

/** An otherwise complete mobile Amazon approval that also records its permitted linking tool. */
const linked = (overrides: MonetizationApprovalFixture = {}) =>
  approval({ linkingToolRef: LINKING_TOOL_REF, ...overrides });

function input(overrides: Partial<MerchantModeInput> = {}): MerchantModeInput {
  return {
    environment: 'production',
    property: IOS_PROPERTY,
    approvals: [linked()],
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
    ['sk', 'live', '51Habcdefghijklmnop'].join('_'),
    'AKIA' + 'ABCDEFGHIJKLMNOP',
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

describe('evidenceQuality: statuses, flags, tags and credentials are not evidence (RV-MON-08)', () => {
  it.each([
    '{"approved":true}',
    '["amazon_associates"]',
    'amazon_associates=true',
    'approved: yes',
    'Eligibility: approved',
    'Approved.',
    'N/A !!',
    'Amazon Associates approved',
    'pencillift-20',
    'my-store-21',
    'amzn1.application-oa2-client.0123456789abcdef0123456789abcdef',
    'client_id=abcdef123456',
    ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0In0', 'c2lnbmF0dXJl'].join('.'),
  ])('rejects %j', (ref) => {
    expect(evidenceQuality(ref)).toBe('invalid');
  });

  it('the approval’s own tag is never evidence, even inside status words', () => {
    expect(evidenceQuality('tag pencillift-20 approved', { publisherTag: 'pencillift-20' })).toBe(
      'invalid',
    );
    // A real document reference may mention the tag and stays a reference.
    expect(
      evidenceQuality('OWNER-DOC/amazon-2026-09#pencillift-20', { publisherTag: 'pencillift-20' }),
    ).toBe('real');
  });

  it('no word-only status phrase is ever accepted (property)', () => {
    const vocabulary = ['approved', 'true', 'amazon', 'associates', 'ios', 'eligible', 'yes'];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...vocabulary), { minLength: 1, maxLength: 5 }),
        fc.constantFrom(' ', '=', ':', '_', '-', '.', '/'),
        (words, separator) => evidenceQuality(words.join(separator)) === 'invalid',
      ),
    );
  });
});

describe('mobile affiliate mode needs a recorded permitted linking tool (RV-MON-09, AC_MON_10)', () => {
  it.each(['ios', 'android'] as const)(
    '%s: missing or placeholder linking tool -> plain_link',
    (platform) => {
      const property = { ...IOS_PROPERTY, platform };
      const missing = resolveMerchantMode(input({ property, approvals: [approval({ platform })] }));
      expect(missing).toMatchObject({ mode: 'plain_link', tag: null });
      expect(missing.reasons).toContain('LINKING_TOOL_MISSING');
      const placeholder = resolveMerchantMode(
        input({ property, approvals: [linked({ platform, linkingToolRef: 'Approved.' })] }),
      );
      expect(placeholder.mode).toBe('plain_link');
      expect(placeholder.reasons).toContain('LINKING_TOOL_INVALID');
      expect(resolveMerchantMode(input({ property, approvals: [linked({ platform })] })).mode).toBe(
        'amazon_associates',
      );
    },
  );

  it('a fixture linking tool is a labeled mock: test only, reported as a fixture', () => {
    const approvals = [linked({ linkingToolRef: 'fixture:amazon-linking-tool' })];
    expect(resolveMerchantMode(input({ approvals })).reasons).toContain(
      'FIXTURE_EVIDENCE_OUTSIDE_TEST',
    );
    expect(resolveMerchantMode(input({ environment: 'test', approvals }))).toMatchObject({
      mode: 'amazon_associates',
      fixture: true,
    });
  });

  it('the web property uses standard text links and needs no mobile linking-tool record', () => {
    const web = {
      platform: 'web' as const,
      identifier: 'https://app.pencillift.example',
      locale: 'en-US',
    };
    const result = resolveMerchantMode(
      input({
        property: web,
        approvals: [approval({ platform: 'web', propertyIdentifier: web.identifier })],
      }),
    );
    expect(result.mode).toBe('amazon_associates');
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
    ['revoked', { approvals: [linked({ status: 'revoked' })] }, 'APPROVAL_NOT_APPROVED'],
    ['pending', { approvals: [linked({ status: 'pending' })] }, 'APPROVAL_NOT_APPROVED'],
    [
      'expired by date',
      { approvals: [linked({ expiresAt: new Date('2026-09-24T14:59:59Z') })] },
      'APPROVAL_EXPIRED',
    ],
    ['expired status', { approvals: [linked({ status: 'expired' })] }, 'APPROVAL_EXPIRED'],
    ['boolean evidence', { approvals: [linked({ evidenceRef: 'true' })] }, 'EVIDENCE_INVALID'],
    [
      'api key as evidence',
      {
        approvals: [
          linked({
            evidenceRef: ['sk', 'live', 'abcdefghijklmnop1234'].join(
              '_',
            ) /* built at runtime: fake, keeps the secret scan meaningful */,
          }),
        ],
      },
      'EVIDENCE_INVALID',
    ],
    [
      'fixture evidence in production',
      { approvals: [linked({ evidenceRef: 'fixture:amazon-ios' })] },
      'FIXTURE_EVIDENCE_OUTSIDE_TEST',
    ],
    [
      'review dated in the future',
      { approvals: [linked({ policyReviewedAt: new Date('2026-10-01T00:00:00Z') })] },
      'APPROVAL_REVIEW_IN_FUTURE',
    ],
    [
      'different property',
      { approvals: [linked({ propertyIdentifier: 'com.other.app' })] },
      'NO_APPROVAL',
    ],
    ['different platform', { approvals: [linked({ platform: 'android' })] }, 'NO_APPROVAL'],
    ['different locale', { approvals: [linked({ locale: 'en-GB' })] }, 'NO_APPROVAL'],
    [
      'generic account (other provider)',
      { approvals: [linked({ provider: 'sponsor_direct' })] },
      'NO_APPROVAL',
    ],
    ['missing tag', { approvals: [linked({ publisherTag: null })] }, 'TAG_MISSING'],
    ['arbitrary tag', { approvals: [linked({ publisherTag: 'anything' })] }, 'TAG_INVALID'],
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
    const fixture = [linked({ evidenceRef: 'fixture:amazon-ios' })];
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
        const approvals = statuses.map((status, i) => linked({ id: `a${i}`, status }));
        if (includeValid) approvals.push(linked({ id: 'valid' }));
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
