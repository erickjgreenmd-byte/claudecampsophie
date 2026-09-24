import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildOutboundUrl,
  canonicalAmazonProductUrl,
  canonicalOtherMerchantUrl,
  type MerchantMode,
} from './index.ts';
import { SYNTHETIC_IDS } from './test-fixtures.ts';

const amazon = (merchantUrl: string) => ({ merchant: 'amazon' as const, merchantUrl });

describe('canonicalAmazonProductUrl', () => {
  it.each([
    'https://www.amazon.com/dp/B000TEST01',
    'https://amazon.com/dp/B000TEST01/',
    'https://www.amazon.com/Fraction-Strips-Set/dp/B000TEST01?th=1&psc=1',
    'https://www.amazon.com/gp/product/B000TEST01/ref=ppx_yo_dt_b_asin',
    'https://www.amazon.com/dp/b000test01#reviews',
  ])('canonicalizes %s', (raw) => {
    expect(canonicalAmazonProductUrl(raw)).toEqual({
      ok: true,
      value: 'https://www.amazon.com/dp/B000TEST01',
    });
  });

  it.each([
    ['http://www.amazon.com/dp/B000TEST01', 'URL_NOT_HTTPS'],
    ['https://www.amazon.co.uk/dp/B000TEST01', 'HOST_NOT_ALLOWLISTED'],
    ['https://amazon.com.evil.example/dp/B000TEST01', 'HOST_NOT_ALLOWLISTED'],
    ['https://www.amazon.com/s?k=fractions', 'NOT_A_PRODUCT_URL'],
    ['https://www.amazon.com/dp/B000TEST01?tag=someoneelse-20', 'AFFILIATE_PARAMS_PRESENT'],
    ['https://www.amazon.com/dp/B000TEST01?ascsubtag=child-7', 'AFFILIATE_PARAMS_PRESENT'],
    ['https://user:pw@www.amazon.com/dp/B000TEST01', 'URL_HAS_CREDENTIALS'],
    ['https://www.amazon.com:8443/dp/B000TEST01', 'URL_HAS_PORT'],
    ['javascript:alert(1)', 'URL_NOT_HTTPS'],
    ['not a url', 'URL_INVALID'],
  ])('refuses %s', (raw, code) => {
    const result = canonicalAmazonProductUrl(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });
});

describe('buildOutboundUrl (AC_MON_10, AC_MON_12)', () => {
  it('adds only the publisher tag in amazon_associates mode', () => {
    expect(
      buildOutboundUrl(
        amazon('https://www.amazon.com/dp/B000TEST01'),
        'amazon_associates',
        'pencillift-20',
      ),
    ).toEqual({ ok: true, value: 'https://www.amazon.com/dp/B000TEST01?tag=pencillift-20' });
  });

  it('plain_link mode never carries a tag, even if one is passed', () => {
    expect(
      buildOutboundUrl(
        amazon('https://www.amazon.com/dp/B000TEST01'),
        'plain_link',
        'pencillift-20',
      ),
    ).toEqual({ ok: true, value: 'https://www.amazon.com/dp/B000TEST01' });
  });

  it('refuses education_only, missing URLs and malformed tags', () => {
    expect(
      buildOutboundUrl(amazon('https://www.amazon.com/dp/B000TEST01'), 'education_only', null).ok,
    ).toBe(false);
    expect(buildOutboundUrl({ merchant: 'none', merchantUrl: null }, 'plain_link', null).ok).toBe(
      false,
    );
    const bad = buildOutboundUrl(
      amazon('https://www.amazon.com/dp/B000TEST01'),
      'amazon_associates',
      'x-20&child=Riley',
    );
    expect(bad.ok).toBe(false);
  });

  it('other merchants need an allowlisted host and lose query/fragment', () => {
    const item = {
      merchant: 'other' as const,
      merchantUrl: 'https://books.example/fractions?ref=abc#top',
    };
    expect(buildOutboundUrl(item, 'plain_link', null).ok).toBe(false);
    expect(buildOutboundUrl(item, 'amazon_associates', 'pencillift-20', ['books.example'])).toEqual(
      {
        ok: true,
        value: 'https://books.example/fractions',
      },
    );
    expect(
      canonicalOtherMerchantUrl('https://www.amazon.com/dp/B000TEST01', ['www.amazon.com']).ok,
    ).toBe(false);
  });

  it('output never contains family/child/session identifiers smuggled into the stored URL (property)', () => {
    const idArb = fc.oneof(fc.uuid(), fc.constantFrom(...Object.values(SYNTHETIC_IDS)));
    const modeArb = fc.constantFrom<MerchantMode>('plain_link', 'amazon_associates');
    fc.assert(
      fc.property(
        idArb,
        idArb,
        idArb,
        modeArb,
        fc.constantFrom('query', 'fragment', 'slug', 'ref', 'all'),
        (familyId, childId, sessionId, mode, where) => {
          const ids = [familyId, childId, sessionId];
          const slug = where === 'slug' || where === 'all' ? `/${familyId}-${childId}` : '';
          const ref = where === 'ref' || where === 'all' ? `/ref=${sessionId}` : '';
          const query =
            where === 'query' || where === 'all' ? `?session=${sessionId}&fam=${familyId}` : '';
          const fragment = where === 'fragment' || where === 'all' ? `#${childId}` : '';
          const raw = `https://www.amazon.com${slug}/dp/B000TEST01${ref}${query}${fragment}`;
          const result = buildOutboundUrl(amazon(raw), mode, 'pencillift-20');
          if (!result.ok) return false;
          return ids.every((id) => !result.value.toLowerCase().includes(id.toLowerCase()));
        },
      ),
    );
  });

  it('the only query parameter ever present is tag (property)', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.stringMatching(/^[a-z]{1,8}$/), fc.stringMatching(/^[a-z0-9]{0,12}$/), {
          maxKeys: 5,
        }),
        (params) => {
          delete params.tag;
          delete params.linkcode;
          delete params.linkid;
          delete params.ascsubtag;
          delete params.creative;
          delete params.camp;
          const qs = new URLSearchParams(params).toString();
          const raw = `https://www.amazon.com/dp/B000TEST01${qs ? `?${qs}` : ''}`;
          const result = buildOutboundUrl(amazon(raw), 'amazon_associates', 'pencillift-20');
          if (!result.ok) return false;
          const keys = [...new URL(result.value).searchParams.keys()];
          return keys.length === 1 && keys[0] === 'tag';
        },
      ),
    );
  });
});
