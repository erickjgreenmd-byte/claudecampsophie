import { describe, expect, it } from 'vitest';
import { resolveMerchantMode, type MerchantModeInput } from './index.ts';
import { ALL_ON, IOS_PROPERTY, NOW, approval } from './test-fixtures.ts';

// Adversarial review of the P16 provider gates (AC_MON_09, AC_MON_10). Each test reproduces one
// defect and is expected to FAIL until the gate is fixed. Synthetic references only; nothing here is
// a real provider approval, account, key or tag.

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

describe('RV-MON-08: booleans, keys and tags are not eligibility evidence (AC_MON_09, AC_MON_10)', () => {
  it.each([
    ['a serialized boolean', '{"approved":true}'],
    ['a flag assignment', 'amazon_associates=true'],
    ['a placeholder with punctuation', 'Approved.'],
    ['the approval’s own publisher tag', 'pencillift-20'],
    // Login-with-Amazon client identifier shape (synthetic): an API credential, not policy evidence.
    ['an API client credential', 'amzn1.application-oa2-client.0123456789abcdef0123456789abcdef'],
  ])('%s never activates amazon_associates in production', (_label, evidenceRef) => {
    const result = resolveMerchantMode(
      input({ approvals: [approval({ evidenceRef, publisherTag: 'pencillift-20' })] }),
    );
    expect(result.mode).not.toBe('amazon_associates');
    expect(result.tag).toBeNull();
  });
});

describe('RV-MON-09: mobile affiliate mode needs a recorded permitted linking mechanism (AC_MON_10)', () => {
  it.each(['ios', 'android'] as const)(
    'a %s approval that records no approved linking tool/API does not enable tagged links',
    (platform) => {
      // approval() records property, evidence, scope and tag, but nothing about which Amazon
      // linking mechanism is permitted for the mobile app; appending ?tag= is then an assumption.
      const result = resolveMerchantMode(
        input({
          property: { ...IOS_PROPERTY, platform },
          approvals: [approval({ platform })],
        }),
      );
      expect(result.mode).not.toBe('amazon_associates');
    },
  );
});
