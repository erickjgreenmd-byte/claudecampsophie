import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { BillingPeriodFact } from '../shared/billing.ts';
import type { CalendarMonth } from '../shared/time.ts';
import { planAccruals, type AccrualPlan } from './accruals.ts';
import { planSchoolDesignation, type Designation } from './designation.ts';
import {
  FAMILY,
  MAPLE,
  MAPLE_SINCE_JANUARY,
  OAK,
  OTHER_FAMILY,
  ZONE,
  allActive,
  discountFields,
  monthlyPeriod,
  period,
} from './test-fixtures.ts';

function accrue(
  periods: readonly BillingPeriodFact[],
  options: {
    designations?: readonly Designation[];
    existing?: ReadonlySet<CalendarMonth>;
  } = {},
): AccrualPlan {
  return planAccruals({
    periods,
    designations: options.designations ?? MAPLE_SINCE_JANUARY,
    programZone: ZONE,
    schoolStatus: allActive,
    existingAccrualMonths: options.existing ?? new Set<CalendarMonth>(),
  });
}

const months = (plan: AccrualPlan): string[] => plan.accruals.map((a) => a.donationMonth);

describe('planAccruals — one $1 per family per calendar month (AC_PROMO_11, AC_PROMO_15)', () => {
  it('each qualifying month accrues exactly 100 cents with a family/month idempotency key', () => {
    const plan = accrue([monthlyPeriod('2026-09')]);
    expect(plan.accruals).toEqual([
      expect.objectContaining({
        idempotencyKey: `${FAMILY}:2026-09`,
        familyId: FAMILY,
        schoolId: MAPLE,
        donationMonth: '2026-09',
        amountCents: 100,
        providerPeriodId: 'txn_2026-09',
      }),
    ]);
    expect(plan.accruals[0]?.snapshot.providerPeriodId).toBe('txn_2026-09');
    expect(plan.skipped).toEqual([]);
  });

  it('a later full-price renewal restores eligibility after a discounted month', () => {
    const plan = accrue([
      monthlyPeriod('2026-07'),
      monthlyPeriod('2026-08', discountFields(50)),
      monthlyPeriod('2026-09'),
    ]);
    expect(months(plan)).toEqual(['2026-07', '2026-09']);
    expect(plan.skipped).toEqual([
      { providerPeriodId: 'txn_2026-08', donationMonth: '2026-08', reason: 'DISCOUNTED' },
    ]);
  });

  it('consecutive 100% months accrue nothing while the family stays designated', () => {
    const plan = accrue([
      monthlyPeriod('2026-07', discountFields(100)),
      monthlyPeriod('2026-08', discountFields(100)),
      monthlyPeriod('2026-09', discountFields(100)),
    ]);
    expect(plan.accruals).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['DISCOUNTED', 'DISCOUNTED', 'DISCOUNTED']);
  });

  it('a billing anchor change with two eligible periods starting in one month yields one accrual (the earliest)', () => {
    // Ids sort opposite to time, so the earliest-start rule is what picks the accrual.
    const early = period({
      providerPeriodId: 'txn_anchor_b',
      periodStart: new Date('2026-09-02T17:00:00.000Z'),
      periodEnd: new Date('2026-09-20T17:00:00.000Z'),
    });
    const late = period({
      providerPeriodId: 'txn_anchor_a',
      periodStart: new Date('2026-09-20T17:00:00.000Z'),
      periodEnd: new Date('2026-10-20T17:00:00.000Z'),
    });
    for (const order of [
      [early, late],
      [late, early],
    ]) {
      const plan = accrue(order);
      expect(plan.accruals).toHaveLength(1);
      expect(plan.accruals[0]?.providerPeriodId).toBe('txn_anchor_b');
      expect(plan.skipped).toEqual([
        {
          providerPeriodId: 'txn_anchor_a',
          donationMonth: '2026-09',
          reason: 'MONTH_ALREADY_ACCRUED',
        },
      ]);
    }
  });

  it('a mid-month tier upgrade (second child) cannot add a second dollar to the month', () => {
    const oneChild = monthlyPeriod('2026-09', {
      paidSlots: 1,
      regularAmountCents: 3999,
      chargedAmountCents: 3999,
    });
    const upgraded = period({
      providerPeriodId: 'txn_upgrade',
      periodStart: new Date('2026-09-25T17:00:00.000Z'),
      periodEnd: new Date('2026-10-25T17:00:00.000Z'),
    });
    expect(months(accrue([oneChild, upgraded]))).toEqual(['2026-09']);
  });

  it('replaying periods or re-running the job after accrual produces nothing new', () => {
    const periods = [monthlyPeriod('2026-08'), monthlyPeriod('2026-09')];
    const first = accrue(periods);
    const existing = new Set(first.accruals.map((a) => a.donationMonth));
    const rerun = accrue(periods, { existing });
    expect(rerun.accruals).toEqual([]);
    expect(rerun.skipped.map((s) => s.reason)).toEqual([
      'MONTH_ALREADY_ACCRUED',
      'MONTH_ALREADY_ACCRUED',
    ]);
  });

  it('a duplicated webhook delivery of the same period is skipped as a duplicate', () => {
    const september = monthlyPeriod('2026-09');
    const plan = accrue([september, { ...september }, september]);
    expect(months(plan)).toEqual(['2026-09']);
    expect(plan.skipped).toEqual([
      { providerPeriodId: 'txn_2026-09', donationMonth: '2026-09', reason: 'DUPLICATE_PERIOD' },
      { providerPeriodId: 'txn_2026-09', donationMonth: '2026-09', reason: 'DUPLICATE_PERIOD' },
    ]);
  });

  it('conflicting facts for one provider period are refused (caller must pass the latest fact)', () => {
    const settled = monthlyPeriod('2026-09');
    const pending = { ...settled, settlement: 'pending' as const, settledAt: null };
    expect(() => accrue([pending, settled])).toThrow(RangeError);
  });

  it('late settlement accrues for the original month; the next month still accrues on its own', () => {
    const lateSeptember = monthlyPeriod('2026-09', {
      periodStart: new Date('2026-09-28T17:00:00.000Z'),
      periodEnd: new Date('2026-10-28T17:00:00.000Z'),
      settledAt: new Date('2026-10-06T09:00:00.000Z'),
    });
    const plan = accrue([lateSeptember, monthlyPeriod('2026-11')]);
    expect(months(plan)).toEqual(['2026-09', '2026-11']);
  });

  it('a pending period accrues nothing now and accrues for its original month once settled', () => {
    const pending = monthlyPeriod('2026-09', { settlement: 'pending', settledAt: null });
    expect(accrue([pending]).skipped[0]?.reason).toBe('NOT_SETTLED');
    const settledLate = {
      ...pending,
      settlement: 'settled' as const,
      settledAt: new Date('2026-11-02T00:00:00.000Z'),
    };
    expect(months(accrue([settledLate]))).toEqual(['2026-09']);
  });

  it('overlapping service from an earlier paid period does not donate for a later discounted period', () => {
    const augustFull = period({
      providerPeriodId: 'txn_aug',
      periodStart: new Date('2026-08-20T17:00:00.000Z'),
      periodEnd: new Date('2026-09-20T17:00:00.000Z'),
    });
    const septemberDiscounted = period({
      providerPeriodId: 'txn_sep',
      periodStart: new Date('2026-09-20T17:00:00.000Z'),
      periodEnd: new Date('2026-10-20T17:00:00.000Z'),
      ...discountFields(5),
    });
    const plan = accrue([augustFull, septemberDiscounted]);
    expect(months(plan)).toEqual(['2026-08']);
    expect(plan.skipped[0]).toMatchObject({ donationMonth: '2026-09', reason: 'DISCOUNTED' });
  });

  it('proration, add-on and tax invoices never accrue, even in a month without a subscription period', () => {
    const plan = accrue([
      monthlyPeriod('2026-09', { providerPeriodId: 'inv_proration', kind: 'proration' }),
      monthlyPeriod('2026-09', { providerPeriodId: 'inv_addon', kind: 'addon' }),
      monthlyPeriod('2026-09', { providerPeriodId: 'inv_tax', kind: 'tax_only' }),
    ]);
    expect(plan.accruals).toEqual([]);
    expect(new Set(plan.skipped.map((s) => s.reason))).toEqual(
      new Set(['NOT_SUBSCRIPTION_PERIOD']),
    );
  });

  it('a school change mid-month: this month accrues to the old school, next month to the new one', () => {
    const changed = planSchoolDesignation({
      designations: MAPLE_SINCE_JANUARY,
      newSchoolId: OAK,
      now: new Date('2026-09-15T19:00:00.000Z'),
      programZone: ZONE,
    });
    if (!changed.ok) throw new Error('unexpected');
    const plan = accrue([monthlyPeriod('2026-09'), monthlyPeriod('2026-10')], {
      designations: changed.value.designations,
    });
    expect(plan.accruals.map((a) => [a.donationMonth, a.schoolId])).toEqual([
      ['2026-09', MAPLE],
      ['2026-10', OAK],
    ]);
  });

  it('refuses to mix periods from different families in one plan', () => {
    expect(() =>
      accrue([monthlyPeriod('2026-09'), monthlyPeriod('2026-10', { familyId: OTHER_FAMILY })]),
    ).toThrow(RangeError);
  });

  it('property: at most one accrual per month, none for already-accrued months, independent of order', () => {
    const periodArb = fc
      .record({
        month: fc.constantFrom('2026-07', '2026-08', '2026-09', '2026-10'),
        day: fc.integer({ min: 1, max: 27 }),
        discountPct: fc.constantFrom(0, 0, 0, 5, 50, 100),
        settlement: fc.constantFrom<BillingPeriodFact['settlement']>(
          'settled',
          'settled',
          'pending',
          'refunded',
        ),
      })
      .map(({ month, day, discountPct, settlement }) => {
        const start = new Date(`${month}-${String(day).padStart(2, '0')}T18:00:00.000Z`);
        return period({
          providerPeriodId: `txn_${month}_${day}_${discountPct}_${settlement}`,
          periodStart: start,
          periodEnd: new Date(start.getTime() + 28 * 86_400_000),
          settlement,
          settledAt: settlement === 'pending' ? null : start,
          refundedCents: settlement === 'refunded' ? 4998 : 0,
          ...(discountPct > 0 ? discountFields(discountPct) : {}),
        });
      });
    const uniqueById = (list: BillingPeriodFact[]) => [
      ...new Map(list.map((p) => [p.providerPeriodId, p])).values(),
    ];
    fc.assert(
      fc.property(
        fc.array(periodArb, { maxLength: 10 }).map(uniqueById),
        fc.subarray(['2026-07', '2026-08', '2026-09', '2026-10']),
        fc.integer({ min: 0, max: 1_000_000 }),
        (periods, existingMonths, seed) => {
          const existing = new Set(existingMonths);
          const plan = accrue(periods, { existing });
          const planned = months(plan);
          expect(new Set(planned).size).toBe(planned.length);
          for (const month of planned) expect(existing.has(month)).toBe(false);
          for (const a of plan.accruals) {
            expect(a.amountCents).toBe(100);
            expect(a.idempotencyKey).toBe(`${FAMILY}:${a.donationMonth}`);
          }
          // Every input period is either accrued or skipped with a reason.
          expect(plan.accruals.length + plan.skipped.length).toBe(periods.length);
          // Input order never changes the outcome.
          const shuffled = [...periods].sort(
            (a, b) => hash(a.providerPeriodId, seed) - hash(b.providerPeriodId, seed) || 0,
          );
          expect(accrue(shuffled, { existing })).toEqual(plan);
          // Re-running with the planned months recorded adds nothing.
          const rerun = accrue(periods, { existing: new Set([...existing, ...planned]) });
          expect(rerun.accruals).toEqual([]);
        },
      ),
    );
  });
});

function hash(text: string, seed: number): number {
  let h = seed | 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return h;
}
