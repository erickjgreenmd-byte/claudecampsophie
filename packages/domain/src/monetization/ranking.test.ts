import fc from 'fast-check';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  RESOURCE_KINDS,
  effectiveItemMode,
  rankResources,
  type RankableResource,
  type ResourceSubject,
} from './index.ts';

function resource(overrides: Partial<RankableResource> = {}): RankableResource {
  return {
    id: 'r-1',
    stableKey: 'fraction-strips',
    subjects: ['math'],
    skills: ['fractions.compare'],
    gradeMin: 3,
    gradeMax: 4,
    kind: 'manipulative',
    availability: 'available',
    status: 'approved',
    ...overrides,
  };
}

const CATALOG: RankableResource[] = [
  resource(),
  resource({
    id: 'r-2',
    stableKey: 'fraction-practice-set',
    kind: 'in_app_practice',
    skills: ['fractions.compare', 'fractions.equivalent'],
    gradeMin: 3,
    gradeMax: 5,
  }),
  resource({
    id: 'r-3',
    stableKey: 'multiplication-cards',
    skills: ['multiplication.facts'],
    kind: 'flashcards',
  }),
  resource({
    id: 'r-4',
    stableKey: 'phonics-workbook',
    subjects: ['reading'],
    skills: ['phonics'],
    kind: 'workbook',
  }),
  resource({ id: 'r-5', stableKey: 'retired-kit', status: 'retired' }),
  resource({ id: 'r-6', stableKey: 'draft-kit', status: 'draft' }),
  resource({ id: 'r-7', stableKey: 'gone-kit', availability: 'unavailable' }),
];

describe('rankResources (spec P10, AC_MON_08)', () => {
  it('ranks by educational relevance and filters subject/grade', () => {
    const ranked = rankResources(CATALOG, {
      subject: 'math',
      grade: 3,
      skills: ['fractions.compare', 'fractions.equivalent'],
    });
    expect(ranked.map((r) => r.item.stableKey)).toEqual([
      'fraction-practice-set',
      'fraction-strips',
      'multiplication-cards',
    ]);
  });

  it('never returns draft, retired or unavailable resources', () => {
    const keys = rankResources(CATALOG, {}).map((r) => r.item.stableKey);
    expect(keys).not.toContain('retired-kit');
    expect(keys).not.toContain('draft-kit');
    expect(keys).not.toContain('gone-kit');
  });

  it('input type has no commercial field (commission, fee, sponsor, bid)', () => {
    type Keys = keyof RankableResource;
    expectTypeOf<
      Extract<Keys, 'commissionRate' | 'feeCents' | 'sponsorId' | 'bidCents' | 'merchant'>
    >().toEqualTypeOf<never>();
  });

  it('commercial data attached to an item cannot change order or scores (property)', () => {
    const subjects: ResourceSubject[] = ['math', 'reading', 'science'];
    const itemArb = fc.record({
      id: fc.uuid(),
      stableKey: fc.stringMatching(/^[a-z]{3,10}$/),
      subjects: fc.subarray(subjects, { minLength: 1 }),
      skills: fc.subarray(['a', 'b', 'c', 'd']),
      gradeMin: fc.integer({ min: 0, max: 6 }),
      gradeSpan: fc.integer({ min: 0, max: 6 }),
      kind: fc.constantFrom(...RESOURCE_KINDS),
      availability: fc.constantFrom('available', 'unknown', 'unavailable'),
      status: fc.constantFrom('approved', 'draft', 'retired'),
      commissionRate: fc.integer({ min: 0, max: 100 }),
      sponsorFeeCents: fc.integer({ min: 0, max: 1_000_000 }),
    });
    fc.assert(
      fc.property(
        fc.array(itemArb, { maxLength: 12 }),
        fc.record({
          subject: fc.option(fc.constantFrom(...subjects), { nil: undefined }),
          grade: fc.option(fc.integer({ min: 0, max: 12 }), { nil: undefined }),
          skills: fc.subarray(['a', 'b', 'c', 'd']),
        }),
        (raw, query) => {
          const withCommerce = raw.map(({ gradeSpan, ...r }) => ({
            ...r,
            gradeMax: r.gradeMin + gradeSpan,
          }));
          const neutral = withCommerce.map((r) => ({
            ...r,
            commissionRate: 0,
            sponsorFeeCents: 0,
          }));
          const a = rankResources(withCommerce, query).map((x) => [x.item.id, x.relevance]);
          const b = rankResources(neutral, query).map((x) => [x.item.id, x.relevance]);
          expect(a).toEqual(b);
        },
      ),
    );
  });
});

describe('effectiveItemMode (spec P16.3)', () => {
  const amazonItem = {
    merchant: 'amazon' as const,
    merchantUrl: 'https://www.amazon.com/dp/B000TEST01',
  };

  it('personalized recommendations are never affiliate-linked', () => {
    expect(effectiveItemMode('amazon_associates', amazonItem, { personalized: true })).toBe(
      'plain_link',
    );
    expect(effectiveItemMode('amazon_associates', amazonItem, { personalized: false })).toBe(
      'amazon_associates',
    );
  });

  it('free resources and items without a URL are education_only', () => {
    expect(
      effectiveItemMode(
        'amazon_associates',
        { merchant: 'none', merchantUrl: null },
        { personalized: false },
      ),
    ).toBe('education_only');
    expect(effectiveItemMode('education_only', amazonItem, { personalized: false })).toBe(
      'education_only',
    );
  });

  it('other merchants are plain links only on an allowlisted host', () => {
    const other = { merchant: 'other' as const, merchantUrl: 'https://books.example/fractions' };
    expect(effectiveItemMode('amazon_associates', other, { personalized: false })).toBe(
      'education_only',
    );
    expect(
      effectiveItemMode('amazon_associates', other, {
        personalized: false,
        otherHosts: ['books.example'],
      }),
    ).toBe('plain_link');
  });
});
