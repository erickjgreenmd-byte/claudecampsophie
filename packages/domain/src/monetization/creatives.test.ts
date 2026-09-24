import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { validateCreative, type CreativeInput } from './index.ts';

const DOMAINS = ['tutoring.example'];

function creative(overrides: Partial<CreativeInput> = {}): CreativeInput {
  return {
    headline: 'Small-group reading tutoring',
    body: 'Certified tutors for grades 1-5. First session free for new families.',
    ctaLabel: 'Learn more',
    destinationUrl: 'https://www.tutoring.example/families?utm_source=pencillift',
    imageAssetRef: null,
    imageLicenseRef: null,
    ...overrides,
  };
}

const codes = (input: CreativeInput) => validateCreative(input, DOMAINS).map((p) => p.code);

describe('validateCreative (AC_MON_06)', () => {
  it('accepts plain owner-approved text to an allowlisted https destination', () => {
    expect(validateCreative(creative(), DOMAINS)).toEqual([]);
    expect(
      codes(
        creative({
          imageAssetRef: 'sponsors/tutoring/logo-v1.png',
          imageLicenseRef: 'LIC-2026-0042',
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    ['<script>alert(1)</script>', 'MARKUP_NOT_ALLOWED'],
    ['<b>Bold</b> claims', 'MARKUP_NOT_ALLOWED'],
    ['Click javascript:void(0)', 'MARKUP_NOT_ALLOWED'],
    ['img onerror=alert(1)', 'MARKUP_NOT_ALLOWED'],
    ['data:text/html;base64,PHNjcmlwdD4=', 'MARKUP_NOT_ALLOWED'],
    ['&lt;script&gt;', 'MARKUP_NOT_ALLOWED'],
    ['Visit https://other.example now', 'EMBEDDED_LINK'],
    ['Pixel https://ads.example/1x1.gif', 'TRACKING_PIXEL'],
  ])('rejects headline %j (%s)', (headline, code) => {
    expect(codes(creative({ headline }))).toContain(code);
  });

  it.each([
    ['http://www.tutoring.example/', 'DESTINATION_NOT_HTTPS'],
    ['https://tutoring.example.evil.test/', 'DESTINATION_NOT_ALLOWLISTED'],
    ['https://nottutoring.example/', 'DESTINATION_NOT_ALLOWLISTED'],
    ['https://unapproved.example/', 'DESTINATION_NOT_ALLOWLISTED'],
    ['https://127.0.0.1/', 'DESTINATION_NOT_ALLOWLISTED'],
    ['javascript:alert(1)', 'DESTINATION_NOT_HTTPS'],
    ['https://www.tutoring.example/%3Cscript%3E', 'MARKUP_NOT_ALLOWED'],
    ['https://user:pw@www.tutoring.example/', 'DESTINATION_INVALID'],
    ['not a url', 'DESTINATION_INVALID'],
  ])('rejects destination %s (%s)', (destinationUrl, code) => {
    expect(codes(creative({ destinationUrl }))).toContain(code);
  });

  it('rejects remote image URLs (pixels), invalid keys and unlicensed images', () => {
    expect(
      codes(creative({ imageAssetRef: 'https://ads.example/p.gif', imageLicenseRef: 'LIC-1234' })),
    ).toContain('TRACKING_PIXEL');
    expect(
      codes(creative({ imageAssetRef: '//cdn.example/p.gif', imageLicenseRef: 'LIC-1234' })),
    ).toContain('TRACKING_PIXEL');
    expect(
      codes(creative({ imageAssetRef: '../secrets.png', imageLicenseRef: 'LIC-1234' })),
    ).toContain('IMAGE_REF_INVALID');
    expect(codes(creative({ imageAssetRef: 'sponsors/tutoring/logo.png' }))).toContain(
      'IMAGE_LICENSE_REQUIRED',
    );
  });

  it('enforces length limits', () => {
    expect(codes(creative({ headline: 'x'.repeat(81) }))).toContain('HEADLINE_LENGTH');
    expect(codes(creative({ body: 'x'.repeat(241) }))).toContain('BODY_LENGTH');
    expect(codes(creative({ ctaLabel: 'x'.repeat(25) }))).toContain('CTA_LENGTH');
    expect(codes(creative({ headline: '   ' }))).toContain('HEADLINE_LENGTH');
  });

  it('any text containing an angle bracket is refused (property)', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 30 }),
        fc.constantFrom('<', '>'),
        fc.string({ maxLength: 30 }),
        (a, b, c) => codes(creative({ body: `${a}${b}${c}` })).includes('MARKUP_NOT_ALLOWED'),
      ),
    );
  });
});
