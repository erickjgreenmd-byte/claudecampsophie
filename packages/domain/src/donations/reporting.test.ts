import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  summarizeSchoolMonth,
  toSchoolFacingReport,
  type SchoolFamilyFact,
  type SchoolMonthSummary,
} from './reporting.ts';
import { MAPLE, OAK } from './test-fixtures.ts';

function fact(familyId: string, overrides: Partial<SchoolFamilyFact> = {}): SchoolFamilyFact {
  return {
    familyId,
    attributedSchoolId: MAPLE,
    designatedSchoolId: MAPLE,
    active: true,
    chargedCents: 4998,
    discounted: false,
    fullyDiscounted: false,
    donationEligible: true,
    ...overrides,
  };
}

function summarize(familyFacts: readonly SchoolFamilyFact[], schoolId = MAPLE): SchoolMonthSummary {
  return summarizeSchoolMonth({
    schoolId,
    month: '2026-09',
    familyFacts,
    accruedCents: 700,
    paidCents: 500,
  });
}

const FULL_PRICE = fact('fam_riley');
const HALF_OFF = fact('fam_sam', { chargedCents: 2499, discounted: true, donationEligible: false });
const FREE_MONTH = fact('fam_avery', {
  chargedCents: 0,
  discounted: true,
  fullyDiscounted: true,
  donationEligible: false,
});
const LAPSED = fact('fam_jordan', { active: false, chargedCents: 0, donationEligible: false });

describe('summarizeSchoolMonth — distinct family counts (AC_PROMO_10)', () => {
  it('reports signups, active, positive-paying, fully discounted and donation-eligible families separately', () => {
    expect(summarize([FULL_PRICE, HALF_OFF, FREE_MONTH, LAPSED])).toEqual({
      schoolId: MAPLE,
      month: '2026-09',
      attributedSignups: 4,
      activeFamilies: 3,
      positivePayingFamilies: 2,
      fullyDiscountedFamilies: 1,
      donationEligibleFamilies: 1,
      accruedCents: 700,
      paidCents: 500,
      owedCents: 200,
    });
  });

  it('child, guardian and redemption rows for the same family never inflate counts', () => {
    // e.g. one row per child, per guardian and per promo redemption from an upstream join
    const rows = [FULL_PRICE, FULL_PRICE, { ...FULL_PRICE }, FREE_MONTH, { ...FREE_MONTH }];
    const summary = summarize(rows);
    expect(summary.attributedSignups).toBe(2);
    expect(summary.activeFamilies).toBe(2);
    expect(summary.donationEligibleFamilies).toBe(1);
  });

  it('a discounted family remains an attributed signup while generating no donation', () => {
    const summary = summarize([FREE_MONTH]);
    expect(summary.attributedSignups).toBe(1);
    expect(summary.donationEligibleFamilies).toBe(0);
  });

  it('donation-eligible counts only families designating this school; attribution is separate', () => {
    const attributedHereDonatingElsewhere = fact('fam_riley', { designatedSchoolId: OAK });
    expect(summarize([attributedHereDonatingElsewhere], MAPLE)).toMatchObject({
      attributedSignups: 1,
      donationEligibleFamilies: 0,
    });
    expect(summarize([attributedHereDonatingElsewhere], OAK)).toMatchObject({
      attributedSignups: 0,
      activeFamilies: 1,
      donationEligibleFamilies: 1,
    });
  });

  it('ignores families unrelated to the school', () => {
    const elsewhere = fact('fam_sam', { attributedSchoolId: OAK, designatedSchoolId: OAK });
    expect(summarize([elsewhere])).toMatchObject({ attributedSignups: 0, activeFamilies: 0 });
  });

  it('shows owed versus paid, including an overpayment after a post-payout refund', () => {
    const summary = summarizeSchoolMonth({
      schoolId: MAPLE,
      month: '2026-09',
      familyFacts: [],
      accruedCents: 300,
      paidCents: 400,
    });
    expect(summary.owedCents).toBe(-100);
  });

  it('contains no family identifiers', () => {
    const ids = ['fam_riley', 'fam_sam', 'fam_avery', 'fam_jordan'];
    const text = JSON.stringify(summarize([FULL_PRICE, HALF_OFF, FREE_MONTH, LAPSED]));
    for (const id of ids) expect(text).not.toContain(id);
  });

  it('refuses conflicting facts for one family (an upstream join bug)', () => {
    expect(() => summarize([FULL_PRICE, { ...FULL_PRICE, active: false }])).toThrow(RangeError);
  });

  it('property: duplicating any family rows never changes the summary', () => {
    const factArb = fc
      .record({
        n: fc.integer({ min: 0, max: 9 }),
        attributed: fc.constantFrom(MAPLE, OAK, null),
        designated: fc.constantFrom(MAPLE, OAK, null),
        active: fc.boolean(),
        pct: fc.constantFrom(0, 5, 50, 100),
      })
      .map(({ n, attributed, designated, active, pct }) =>
        fact(`fam_${n}`, {
          attributedSchoolId: attributed,
          designatedSchoolId: designated,
          active,
          chargedCents: active ? Math.round((4998 * (100 - pct)) / 100) : 0,
          discounted: pct > 0,
          fullyDiscounted: pct === 100,
          donationEligible: active && pct === 0 && designated !== null,
        }),
      );
    const uniqueFamilies = (list: SchoolFamilyFact[]) => [
      ...new Map(list.map((f) => [f.familyId, f])).values(),
    ];
    fc.assert(
      fc.property(
        fc.array(factArb, { maxLength: 12 }).map(uniqueFamilies),
        fc.array(fc.nat(), { maxLength: 10 }),
        (facts, dupIndexes) => {
          const duplicates =
            facts.length === 0 ? [] : dupIndexes.map((i) => facts[i % facts.length]!);
          expect(summarize([...facts, ...duplicates])).toEqual(summarize(facts));
          const summary = summarize(facts);
          expect(summary.attributedSignups).toBeLessThanOrEqual(facts.length);
          expect(
            summary.positivePayingFamilies + summary.fullyDiscountedFamilies,
          ).toBeLessThanOrEqual(facts.length);
        },
      ),
    );
  });
});

describe('toSchoolFacingReport — schools see only suppressed aggregates (AC_PROMO_13)', () => {
  const base: SchoolMonthSummary = {
    schoolId: MAPLE,
    month: '2026-09',
    attributedSignups: 12,
    activeFamilies: 4,
    positivePayingFamilies: 3,
    fullyDiscountedFamilies: 1,
    donationEligibleFamilies: 0,
    accruedCents: 0,
    paidCents: 0,
    owedCents: 0,
  };

  it('suppresses counts 1..4 as "<5" and keeps 0 and counts of 5 or more exact', () => {
    const report = toSchoolFacingReport(base);
    expect(report.attributedSignups).toBe(12);
    expect(report.activeFamilies).toBe('<5');
    expect(report.donationEligibleFamilies).toBe(0);
    const five = toSchoolFacingReport({ ...base, activeFamilies: 5, donationEligibleFamilies: 1 });
    expect(five.activeFamilies).toBe(5);
    expect(five.donationEligibleFamilies).toBe('<5');
  });

  it('omits internal fields: amount owed and the payment-status breakdown', () => {
    const report = toSchoolFacingReport(base);
    expect(Object.keys(report).sort()).toEqual(
      [
        'activeFamilies',
        'attributedSignups',
        'contributionAccruedCents',
        'contributionPaidCents',
        'donationEligibleFamilies',
        'month',
        'schoolId',
      ].sort(),
    );
  });

  it('suppresses contribution amounts that would reveal a suppressed family count', () => {
    const small = toSchoolFacingReport({
      ...base,
      donationEligibleFamilies: 3,
      accruedCents: 300,
      paidCents: 300,
    });
    expect(small.contributionAccruedCents).toBe('<$5.00');
    expect(small.contributionPaidCents).toBe('<$5.00');
    const large = toSchoolFacingReport({
      ...base,
      donationEligibleFamilies: 9,
      accruedCents: 900,
      paidCents: 0,
    });
    expect(large.contributionAccruedCents).toBe(900);
    expect(large.contributionPaidCents).toBe(0);
  });

  it('a stricter cohort threshold suppresses more; a weaker one is refused', () => {
    const report = toSchoolFacingReport({ ...base, activeFamilies: 7 }, 10);
    expect(report.activeFamilies).toBe('<10');
    expect(() => toSchoolFacingReport(base, 3)).toThrow(RangeError);
  });

  it('the admin summary keeps exact counts', () => {
    expect(summarize([FULL_PRICE]).activeFamilies).toBe(1);
  });

  it('withholds a figure that would reveal a small group by subtraction (RV-donations-4)', () => {
    // 6 active families, 5 of them donating: publishing both reveals the one that did not pay
    // full price. The donation figures keep priority; the others are withheld as "5+".
    const report = toSchoolFacingReport({
      ...base,
      attributedSignups: 6,
      activeFamilies: 6,
      donationEligibleFamilies: 5,
      accruedCents: 500,
      paidCents: 0,
    });
    expect(report).toMatchObject({
      attributedSignups: '5+',
      activeFamilies: '5+',
      donationEligibleFamilies: 5,
      contributionAccruedCents: 500,
      contributionPaidCents: 0,
    });
  });

  it('treats amounts as $1-per-family counts, so an amount cannot be subtracted either', () => {
    // Accrued $6.00 but paid $5.00: the $1 gap is one family's reversed donation.
    const report = toSchoolFacingReport({
      ...base,
      attributedSignups: 6,
      activeFamilies: 6,
      donationEligibleFamilies: 6,
      accruedCents: 600,
      paidCents: 500,
    });
    expect(report).toMatchObject({
      attributedSignups: 6,
      activeFamilies: 6,
      donationEligibleFamilies: 6,
      contributionAccruedCents: 600,
      contributionPaidCents: '$5.00+',
    });
    // A published family count next to a published amount is checked too.
    const fromAmount = toSchoolFacingReport({
      ...base,
      attributedSignups: 0,
      activeFamilies: 7,
      donationEligibleFamilies: 0,
      accruedCents: 500,
      paidCents: 500,
    });
    expect(fromAmount.contributionAccruedCents).toBe(500);
    expect(fromAmount.activeFamilies).toBe('5+');
  });

  it('refuses a negative amount instead of publishing an exact reversal (programmer error)', () => {
    // summarizeSchoolMonth never produces one; a hand-built summary with −$1 would expose one reversal.
    expect(() => toSchoolFacingReport({ ...base, paidCents: -100 })).toThrow(RangeError);
    expect(() => toSchoolFacingReport({ ...base, activeFamilies: 2.5 })).toThrow(RangeError);
  });

  it('publishes every figure when they are equal or far apart', () => {
    const report = toSchoolFacingReport({
      ...base,
      attributedSignups: 20,
      activeFamilies: 12,
      donationEligibleFamilies: 12,
      accruedCents: 1200,
      paidCents: 0,
    });
    expect(report).toMatchObject({
      attributedSignups: 20,
      activeFamilies: 12,
      donationEligibleFamilies: 12,
      contributionAccruedCents: 1200,
      contributionPaidCents: 0,
    });
  });

  it('end to end: a discounted family among six cannot be recovered from the school view', () => {
    const facts = [
      ...['fam_riley', 'fam_sam', 'fam_avery', 'fam_jordan', 'fam_casey'].map((id) => fact(id)),
      fact('fam_morgan', { chargedCents: 2499, discounted: true, donationEligible: false }),
    ];
    const summary = summarizeSchoolMonth({
      schoolId: MAPLE,
      month: '2026-09',
      familyFacts: facts,
      accruedCents: 500,
      paidCents: 500,
    });
    expect(summary).toMatchObject({ activeFamilies: 6, donationEligibleFamilies: 5 });
    const report = toSchoolFacingReport(summary);
    expect(report.activeFamilies).toBe('5+');
    expect(report.donationEligibleFamilies).toBe(5);
  });

  it('property: published figures never differ by 1..minCohort−1 families; every label is truthful', () => {
    const count = fc.integer({ min: 0, max: 30 });
    const cents = fc.oneof(
      fc.integer({ min: 0, max: 30 }).map((n) => n * 100),
      fc.integer({ min: 0, max: 3000 }),
    );
    fc.assert(
      fc.property(
        count,
        count,
        count,
        cents,
        cents,
        fc.constantFrom(5, 6, 10),
        (signups, active, eligible, accrued, paid, minCohort) => {
          const summary: SchoolMonthSummary = {
            ...base,
            attributedSignups: signups,
            activeFamilies: active,
            donationEligibleFamilies: eligible,
            accruedCents: accrued,
            paidCents: paid,
          };
          const report = toSchoolFacingReport(summary, minCohort);
          const threshold = minCohort * 100;
          const figures = [
            [report.attributedSignups, signups * 100, 'count'],
            [report.activeFamilies, active * 100, 'count'],
            [report.donationEligibleFamilies, eligible * 100, 'count'],
            [report.contributionAccruedCents, accrued, 'amount'],
            [report.contributionPaidCents, paid, 'amount'],
          ] as const;
          const published: number[] = [];
          for (const [shown, exactCents, kind] of figures) {
            const small = exactCents > 0 && exactCents < threshold;
            if (typeof shown === 'number') {
              // Published figures are exact and never small.
              expect(kind === 'count' ? shown * 100 : shown).toBe(exactCents);
              expect(small).toBe(false);
              published.push(exactCents);
            } else if (shown.startsWith('<')) {
              expect(small).toBe(true);
            } else {
              // Withheld as "N+" / "$N.00+": true only for figures of at least minCohort.
              expect(shown.endsWith('+')).toBe(true);
              expect(exactCents).toBeGreaterThanOrEqual(threshold);
            }
          }
          for (const a of published) {
            for (const b of published) {
              const gap = Math.abs(a - b);
              expect(gap === 0 || gap >= threshold).toBe(true);
            }
          }
        },
      ),
    );
  });

  it('property: no school-facing count is ever an exact value between 1 and 4', () => {
    const count = fc.integer({ min: 0, max: 30 });
    fc.assert(
      fc.property(count, count, count, (signups, active, eligible) => {
        const report = toSchoolFacingReport({
          ...base,
          attributedSignups: signups,
          activeFamilies: active,
          donationEligibleFamilies: eligible,
          accruedCents: eligible * 100,
          paidCents: eligible * 100,
        });
        for (const value of [
          report.attributedSignups,
          report.activeFamilies,
          report.donationEligibleFamilies,
        ]) {
          if (typeof value === 'number') expect(value === 0 || value >= 5).toBe(true);
        }
        for (const value of [report.contributionAccruedCents, report.contributionPaidCents]) {
          if (typeof value === 'number') expect(value === 0 || value >= 500).toBe(true);
        }
      }),
    );
  });
});
