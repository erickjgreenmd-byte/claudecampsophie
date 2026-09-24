// Independent adversarial review of the donations module (spec P17 "School attribution and donation
// ledger", F7, AC_PROMO_10..13/15). Each [RV-donations-<n>] test is a regression for a confirmed
// defect and fails against the implementation it was written for; [RV-donations-P<n>] tests are
// passing probes of the riskiest edge cases. Synthetic data only.
import { describe, expect, it } from 'vitest';
import type { SettlementStatus } from '../shared/billing.ts';
import type { CalendarMonth } from '../shared/time.ts';
import { planAccruals } from './accruals.ts';
import { planAdjustment, type AdjustmentEvent, type ProviderPeriodState } from './adjustments.ts';
import { designationForMonth, planSchoolDesignation } from './designation.ts';
import { evaluateDonationEligibility } from './eligibility.ts';
import { transitionPayout } from './payouts.ts';
import { summarizeSchoolMonth, toSchoolFacingReport, type SchoolFamilyFact } from './reporting.ts';
import {
  MAPLE,
  MAPLE_SINCE_JANUARY,
  OAK,
  ZONE,
  allActive,
  discountFields,
  period,
} from './test-fixtures.ts';

/** `true`/`false` for the eligibility verdict, or 'threw' when the fact was refused outright. */
function verdict(settlement: string): boolean | 'threw' {
  try {
    return evaluateDonationEligibility({
      period: period({ settlement: settlement as SettlementStatus }),
      designations: MAPLE_SINCE_JANUARY,
      programZone: ZONE,
      schoolStatus: allActive,
    }).eligible;
  } catch {
    return 'threw';
  }
}

describe('donations adversarial review — confirmed defects', () => {
  it('[RV-donations-1] an unrecognized settlement status never produces a $1 donation (fail closed)', () => {
    // P17: "Require a settled, undiscounted full monthly subscription payment". The `kind` rule is
    // an allow-list, but `settled` is a deny-list (anything except pending/failed passes), so a
    // status the normalizer did not map (a new provider state, a casing slip) accrues $1.
    for (const settlement of ['disputed', 'void', 'in_grace_period', 'SETTLED']) {
      expect(verdict(settlement), `settlement=${settlement}`).not.toBe(true);
    }
  });

  it('[RV-donations-2] a won dispute cannot reinstate a donation that a partial refund reversed', () => {
    // P17/F7: only a period "paid at the regular approved tier price without a discount" donates,
    // and refunds are reconciled with adjustments. After a partial refund the period is never
    // full-price again, so a later chargeback win must not bring the $1 back. With providerState
    // omitted (the documented "contract default") the reversal cause is unknown and it reinstates.
    const accrual = {
      id: 'acc_rv2_riley_2026_09',
      amountCents: 100,
      payoutStatus: 'paid' as const,
    };
    const partiallyRefunded: ProviderPeriodState = {
      settlement: 'partially_refunded',
      refundedCents: 1000,
    };
    const keys = new Set<string>();
    let net = 100;
    const steps: readonly [AdjustmentEvent, ProviderPeriodState | undefined][] = [
      ['partial_refund', partiallyRefunded],
      ['chargeback', { settlement: 'chargeback', refundedCents: 4998 }],
      ['chargeback_reversed', undefined],
    ];
    for (const [event, providerState] of steps) {
      let adjustment;
      try {
        adjustment = planAdjustment({
          accrual,
          event,
          existingAdjustmentKeys: keys,
          ...(providerState === undefined ? {} : { providerState }),
        });
      } catch {
        adjustment = null; // refusing to decide without provider state is an acceptable fix
      }
      if (adjustment) {
        keys.add(adjustment.idempotencyKey);
        net += adjustment.amountCents;
      }
    }
    expect(net).toBe(0);
  });

  it('[RV-donations-3] an invisible-only transfer reference cannot mark a payout paid', () => {
    // P17: "record external transfer references"; module requirement: an external transfer
    // reference is required to mark paid. trim() and the C0/C1 control check miss Unicode format
    // characters, so a reference that renders as empty is accepted and stored as the audit record.
    const invisible: readonly [string, string][] = [
      ['U+200B zero width space', '​'],
      ['U+2060 word joiner', '⁠'],
      ['U+00AD soft hyphen + U+200D ZWJ', '­‍'],
      ['U+200B U+200C U+200D', '​‌‍'],
    ];
    for (const [label, transferReference] of invisible) {
      const result = transitionPayout('approved', { type: 'mark_paid', transferReference });
      expect(result.ok, label).toBe(false);
    }
  });

  it('[RV-donations-4] a school cannot recover a suppressed (<5) group by subtracting two published counts', () => {
    // AC_PROMO_13 / P17: schools see only authorized aggregates and never private family data;
    // counts of 1..4 are suppressed. The module omits positive-paying/fully-discounted counts so a
    // school cannot "subtract its way to a suppressed small group", but activeFamilies and
    // donationEligibleFamilies are both published: 6 − 5 reveals exactly one active family of this
    // school that did not pay full price this month (discounted, refunded or unsettled).
    const family = (n: number, overrides: Partial<SchoolFamilyFact> = {}): SchoolFamilyFact => ({
      familyId: `fam_rv4_${n}`,
      attributedSchoolId: MAPLE,
      designatedSchoolId: MAPLE,
      active: true,
      chargedCents: 4998,
      discounted: false,
      fullyDiscounted: false,
      donationEligible: true,
      ...overrides,
    });
    const facts = [
      ...[1, 2, 3, 4, 5].map((n) => family(n)),
      family(6, { chargedCents: 2499, discounted: true, donationEligible: false }),
    ];
    const summary = summarizeSchoolMonth({
      schoolId: MAPLE,
      month: '2026-09',
      familyFacts: facts,
      accruedCents: 500,
      paidCents: 0,
    });
    const report = toSchoolFacingReport(summary);
    const published = [
      report.attributedSignups,
      report.activeFamilies,
      report.donationEligibleFamilies,
    ].filter((v): v is number => typeof v === 'number');
    for (const a of published) {
      for (const b of published) {
        const difference = a - b;
        expect(
          difference <= 0 || difference >= 5,
          `published counts ${a} and ${b} differ by ${difference}`,
        ).toBe(true);
      }
    }
  });
});

describe('donations adversarial review — passing probes of risky edges', () => {
  it('[RV-donations-P1] a school change across the November DST fall-back uses the program-zone month', () => {
    // 2026-11-01 00:00 PDT = 07:00Z. One millisecond earlier is still October in Los Angeles.
    const change = (iso: string) => {
      const result = planSchoolDesignation({
        designations: MAPLE_SINCE_JANUARY,
        newSchoolId: OAK,
        now: new Date(iso),
        programZone: ZONE,
      });
      if (!result.ok) throw new Error(result.error.code);
      return result.value;
    };
    expect(change('2026-11-01T06:59:59.999Z').effectiveFromMonth).toBe('2026-11');
    expect(change('2026-11-01T07:00:00.000Z').effectiveFromMonth).toBe('2026-12');
    // 01:30 PST (the repeated hour after fall-back) is still November 1.
    const repeatedHour = change('2026-11-01T09:30:00.000Z');
    expect(repeatedHour.effectiveFromMonth).toBe('2026-12');
    expect(designationForMonth(repeatedHour.designations, '2026-11')).toBe(MAPLE);
  });

  it('[RV-donations-P2] a store charge collected before the period starts counts in the period-start month', () => {
    // App stores bill up to 24 h before renewal: settledAt (Sep 30 PDT) precedes periodStart (Oct 1 PDT).
    const result = evaluateDonationEligibility({
      period: period({
        periodStart: new Date('2026-10-01T08:00:00.000Z'),
        periodEnd: new Date('2026-11-01T08:00:00.000Z'),
        settledAt: new Date('2026-09-30T09:00:00.000Z'),
      }),
      designations: MAPLE_SINCE_JANUARY,
      programZone: ZONE,
      schoolStatus: allActive,
    });
    expect(result.eligible && result.donationMonth).toBe('2026-10');
  });

  it('[RV-donations-P3] month-end anchors through February accrue exactly once per month; 1% off still donates $0', () => {
    const starts = [
      '2027-01-31T17:00:00.000Z',
      '2027-02-28T17:00:00.000Z',
      '2027-03-31T17:00:00.000Z',
    ];
    const periods = starts.map((iso, i) =>
      period({
        providerPeriodId: `txn_rv_p3_${i}`,
        periodStart: new Date(iso),
        periodEnd: new Date(starts[i + 1] ?? '2027-04-30T17:00:00.000Z'),
        settledAt: new Date(iso),
        ...(i === 1 ? discountFields(1) : {}),
      }),
    );
    const plan = planAccruals({
      periods,
      designations: MAPLE_SINCE_JANUARY,
      programZone: ZONE,
      schoolStatus: allActive,
      existingAccrualMonths: new Set<CalendarMonth>(),
    });
    expect(plan.accruals.map((a) => a.donationMonth)).toEqual(['2027-01', '2027-03']);
    expect(plan.skipped).toEqual([
      { providerPeriodId: 'txn_rv_p3_1', donationMonth: '2027-02', reason: 'DISCOUNTED' },
    ]);
  });
});
