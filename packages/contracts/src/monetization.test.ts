import { describe, expect, it } from 'vitest';
import {
  approvalInputSchema,
  outboundUrlResponseSchema,
  placementQuerySchema,
  placementResponseSchema,
  resourceItemSchema,
  resourcesQuerySchema,
} from './monetization.ts';

const card = {
  serveToken: 'A'.repeat(43),
  placement: 'resources_browse',
  label: 'Sponsored by Maple Tutoring',
  headline: 'Small-group reading tutoring',
  body: 'Certified tutors.',
  ctaLabel: 'Learn more',
  destinationHost: 'www.tutoring.example',
  imageAssetRef: null,
  whyShown: 'Shown in the parent resource directory.',
};

describe('P16 monetization contracts', () => {
  it('placement query accepts only the two adult placements and refuses smuggled identifiers', () => {
    expect(
      placementQuerySchema.safeParse({ placement: 'resources_browse', platform: 'ios' }).success,
    ).toBe(true);
    expect(
      placementQuerySchema.safeParse({ placement: 'child_home', platform: 'ios' }).success,
    ).toBe(false);
    expect(
      placementQuerySchema.safeParse({
        placement: 'adult_dashboard',
        platform: 'web',
        childId: 'x',
      }).success,
    ).toBe(false);
    expect(resourcesQuerySchema.safeParse({ platform: 'ios', grade: '3' })).toMatchObject({
      success: true,
      data: { grade: 3 },
    });
  });

  it('a sponsor card carries no economics, campaign or family identifiers (strict)', () => {
    expect(placementResponseSchema.safeParse({ card, reason: 'served' }).success).toBe(true);
    for (const extra of [
      { campaignId: 'c' },
      { feeCents: 1 },
      { familyId: 'f' },
      { destinationUrl: 'https://x.example' },
    ]) {
      expect(
        placementResponseSchema.safeParse({ card: { ...card, ...extra }, reason: 'served' })
          .success,
      ).toBe(false);
    }
  });

  it('resource items never carry a price and outbound URLs are https only', () => {
    const item = {
      id: '5b0a3c1e-2f4d-4e8a-9c7b-1d2e3f4a5b6c',
      title: 'Fraction strips',
      description: 'Colored strips.',
      kind: 'manipulative',
      subjects: ['math'],
      skills: ['fractions.compare'],
      gradeMin: 3,
      gradeMax: 5,
      relevance: 12,
      mode: 'plain_link',
      merchant: 'amazon',
      disclosure: 'External link',
      price: null,
      priceNote: 'Check current price on Amazon.',
      availability: 'available',
      imageAssetRef: null,
    };
    expect(resourceItemSchema.safeParse(item).success).toBe(true);
    expect(resourceItemSchema.safeParse({ ...item, price: 1299 }).success).toBe(false);
    expect(
      outboundUrlResponseSchema.safeParse({
        url: 'http://www.amazon.com/dp/B000TEST01',
        mode: 'plain_link',
        disclosure: null,
      }).success,
    ).toBe(false);
    expect(
      outboundUrlResponseSchema.safeParse({
        url: 'javascript:alert(1)',
        mode: 'plain_link',
        disclosure: null,
      }).success,
    ).toBe(false);
  });

  it('an approval record requires evidence text, never a boolean', () => {
    const base = {
      provider: 'amazon_associates',
      platform: 'ios',
      propertyIdentifier: 'com.pencillift.app',
      locale: 'en-US',
      intendedAudience: 'Adults',
      vendorSdkVersion: null,
      policyReviewedAt: '2026-09-01T00:00:00Z',
      evidenceRef: 'OWNER-DOC/eligibility#1',
      approvalScope: 'Parent resource browser',
      publisherTag: 'pencillift-20',
      status: 'approved',
      expiresAt: '2027-03-01T00:00:00Z',
    };
    expect(approvalInputSchema.safeParse(base).success).toBe(true);
    expect(approvalInputSchema.safeParse({ ...base, evidenceRef: true }).success).toBe(false);
    expect(approvalInputSchema.safeParse({ ...base, evidenceRef: 'yes' }).success).toBe(false);
    expect(approvalInputSchema.safeParse({ ...base, status: 'revoked' }).success).toBe(false);
  });
});
