// Synthetic fixtures for monetization unit tests. Approvals here are labeled fixtures (evidence
// prefixed `fixture:`) or obviously synthetic references; none represents a real provider approval.
import type { ServableCampaignFacts } from './campaigns.ts';
import type { MonetizationApproval, MonetizationProperty } from './gates.ts';
import type { MonetizationSwitches } from './types.ts';

export const NOW = new Date('2026-09-24T15:00:00Z');
export const IOS_PROPERTY: MonetizationProperty = {
  platform: 'ios',
  identifier: 'com.pencillift.app',
  locale: 'en-US',
};

export const ALL_ON: MonetizationSwitches = {
  global: true,
  'provider:sponsor_direct': true,
  'provider:amazon_associates': true,
  'provider:ad_network': true,
};

/**
 * Synthetic reference to a recorded Amazon linking-tool determination. `approval()` deliberately
 * records none: tests that need live mobile affiliate mode add it explicitly (AC_MON_10).
 */
export const LINKING_TOOL_REF = 'OWNER-DOC/amazon-mobile-linking-2026-09-01#case-4413';

export type MonetizationApprovalFixture = Partial<MonetizationApproval>;

export function approval(overrides: MonetizationApprovalFixture = {}): MonetizationApproval {
  return {
    id: 'appr-1',
    provider: 'amazon_associates',
    platform: 'ios',
    propertyIdentifier: 'com.pencillift.app',
    locale: 'en-US',
    status: 'approved',
    policyReviewedAt: new Date('2026-09-01T00:00:00Z'),
    expiresAt: new Date('2027-03-01T00:00:00Z'),
    evidenceRef: 'OWNER-DOC/amazon-eligibility-2026-09-01#case-4412',
    publisherTag: 'pencillift-20',
    linkingToolRef: null,
    ...overrides,
  };
}

export function campaign(overrides: Partial<ServableCampaignFacts> = {}): ServableCampaignFacts {
  return {
    id: 'camp-a',
    status: 'active',
    sponsorActive: true,
    creativeApproved: true,
    placement: 'resources_browse',
    platforms: ['ios', 'android', 'web'],
    startsAt: new Date('2026-09-01T00:00:00Z'),
    endsAt: new Date('2026-10-01T00:00:00Z'),
    impressionCap: 1000,
    viewableImpressions: 0,
    ...overrides,
  };
}

/** Synthetic identifiers that must never appear in commercial outputs. */
export const SYNTHETIC_IDS = {
  familyId: '5b0a3c1e-2f4d-4e8a-9c7b-1d2e3f4a5b6c',
  childId: '9e8d7c6b-5a49-4382-a716-f5e4d3c2b1a0',
  sessionId: '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0',
  nickname: 'Riley',
};
