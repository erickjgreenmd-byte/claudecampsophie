import { describe, expect, it } from 'vitest';
import { LEGAL_LINK_LABELS, legalLinks } from './legal-links.ts';

/**
 * Store compliance (APL-06 / PLAY-20): the app links to the privacy policy and terms of use on the
 * public parent portal. The links are absolute, https, and never a child-area route.
 */
const CHILD_ROUTE = /\/(child|kid|scan|practice|rewards|results|review|help)(\/|$)/i;

describe('legal links', () => {
  it('builds absolute portal links for the privacy policy and terms of use', () => {
    const links = legalLinks('https://portal.example.test');
    expect(links.map((l) => l.key)).toEqual(['privacy', 'terms']);
    expect(links.map((l) => l.label)).toEqual(['Privacy policy', 'Terms of use']);
    expect(links.map((l) => l.url)).toEqual([
      'https://portal.example.test/privacy',
      'https://portal.example.test/terms',
    ]);
    expect(LEGAL_LINK_LABELS).toEqual({ privacy: 'Privacy policy', terms: 'Terms of use' });
  });

  it('tolerates a trailing slash on the configured portal origin', () => {
    expect(legalLinks('https://portal.example.test/').map((l) => l.url)).toEqual([
      'https://portal.example.test/privacy',
      'https://portal.example.test/terms',
    ]);
  });

  it('is never a relative URL, never plain http, never a child route', () => {
    for (const origin of ['https://portal.example.test', 'https://portal.example.test/']) {
      for (const link of legalLinks(origin)) {
        expect(link.url.startsWith('https://')).toBe(true);
        const parsed = new URL(link.url);
        expect(parsed.protocol).toBe('https:');
        expect(parsed.pathname).not.toMatch(CHILD_ROUTE);
        expect(parsed.pathname).toBe(`/${link.key}`);
      }
    }
    // A misconfigured origin never produces a link the app would open.
    expect(legalLinks('portal.example.test')).toEqual([]);
    expect(legalLinks('http://portal.example.test')).toEqual([]);
    expect(legalLinks('/portal')).toEqual([]);
  });

  it('returns no links when the portal is not configured (never a made-up address)', () => {
    expect(legalLinks(null)).toEqual([]);
    expect(legalLinks('')).toEqual([]);
  });
});
