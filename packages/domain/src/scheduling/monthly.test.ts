// Spec P17 monthly generator timing (AC_PROMO_01, timing side) and the donation accrual run:
// deterministic instants in the template/program calendar zone so every worker and retry agrees.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addMonths, monthBoundsUtc } from '../shared/time.ts';
import {
  DEFAULT_GENERATION_LEAD_DAYS,
  DEFAULT_SETTLEMENT_GRACE_DAYS,
  donationAccrualRunAt,
  dueGenerationMonths,
  nextMonthlyGenerationAt,
} from './index.ts';

const at = (iso: string): Date => new Date(iso);

describe('AC_PROMO_01 (timing): monthly campaign generation runs ahead of the campaign month', () => {
  it('defaults to 5 days before the first instant of the month', () => {
    expect(DEFAULT_GENERATION_LEAD_DAYS).toBe(5);
    expect(nextMonthlyGenerationAt({ month: '2026-10', zone: 'UTC' })).toEqual(
      at('2026-09-26T00:00:00Z'),
    );
  });

  it('uses the template calendar zone (drafts default to UTC; New York differs)', () => {
    expect(nextMonthlyGenerationAt({ month: '2026-10', zone: 'America/New_York' })).toEqual(
      at('2026-09-26T04:00:00Z'),
    );
  });

  it('counts lead days as local calendar days across a DST change (Europe/London Nov 2026)', () => {
    // Nov 1 00:00 GMT minus 7 local days = Oct 25 00:00 BST (DST ends at 01:00Z that day).
    expect(
      nextMonthlyGenerationAt({ month: '2026-11', zone: 'Europe/London', leadDays: 7 }),
    ).toEqual(at('2026-10-24T23:00:00Z'));
  });

  it('handles both sides of the date line and the year boundary', () => {
    expect(nextMonthlyGenerationAt({ month: '2026-10', zone: 'Pacific/Kiritimati' })).toEqual(
      at('2026-09-25T10:00:00Z'),
    );
    expect(nextMonthlyGenerationAt({ month: '2026-10', zone: 'Pacific/Pago_Pago' })).toEqual(
      at('2026-09-26T11:00:00Z'),
    );
    expect(nextMonthlyGenerationAt({ month: '2027-01', zone: 'UTC' })).toEqual(
      at('2026-12-27T00:00:00Z'),
    );
  });

  it('is deterministic, so concurrent workers and retries agree on the same run', () => {
    const a = nextMonthlyGenerationAt({ month: '2026-12', zone: 'America/Los_Angeles' });
    const b = nextMonthlyGenerationAt({ month: '2026-12', zone: 'America/Los_Angeles' });
    expect(a).toEqual(b);
  });

  it('property: generation always precedes the month; lead 0 equals the month start', () => {
    const zones = [
      'UTC',
      'America/New_York',
      'Europe/London',
      'Australia/Lord_Howe',
      'America/Santiago',
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...zones),
        fc.integer({ min: 0, max: 12 * 10 }),
        fc.integer({ min: 1, max: 28 }),
        (zone, offset, leadDays) => {
          const month = addMonths('2024-01', offset);
          const { start } = monthBoundsUtc(month, zone);
          expect(nextMonthlyGenerationAt({ month, zone, leadDays }).getTime()).toBeLessThan(
            start.getTime(),
          );
          expect(nextMonthlyGenerationAt({ month, zone, leadDays: 0 })).toEqual(start);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('rejects invalid inputs (programmer/config errors throw)', () => {
    expect(() => nextMonthlyGenerationAt({ month: '2026-13', zone: 'UTC' })).toThrow(RangeError);
    expect(() => nextMonthlyGenerationAt({ month: '2026-10', zone: 'Bad/Zone' })).toThrow(
      RangeError,
    );
    expect(() => nextMonthlyGenerationAt({ month: '2026-10', zone: 'UTC', leadDays: -1 })).toThrow(
      RangeError,
    );
    expect(() => nextMonthlyGenerationAt({ month: '2026-10', zone: 'UTC', leadDays: 29 })).toThrow(
      RangeError,
    );
    expect(() => nextMonthlyGenerationAt({ month: '2026-10', zone: 'UTC', leadDays: 1.5 })).toThrow(
      RangeError,
    );
  });

  it('RV-scheduling-1: a U+2212 fixed offset is not a calendar zone for the monthly timers', () => {
    const zone = '\u221205:00';
    expect(() => nextMonthlyGenerationAt({ month: '2026-10', zone })).toThrow(RangeError);
    expect(() => dueGenerationMonths({ now: at('2026-10-10T00:00:00Z'), zone })).toThrow(
      RangeError,
    );
    expect(() => donationAccrualRunAt({ month: '2026-10', zone })).toThrow(RangeError);
  });
});

describe('AC_PROMO_01 (timing): which campaign months are due at a given instant', () => {
  it('before the lead window only the current month is due (idempotent catch-up)', () => {
    expect(dueGenerationMonths({ now: at('2026-09-25T23:59:59Z'), zone: 'UTC' })).toEqual([
      '2026-09',
    ]);
  });

  it('inside the lead window the next month is also due', () => {
    expect(dueGenerationMonths({ now: at('2026-09-26T00:00:00Z'), zone: 'UTC' })).toEqual([
      '2026-09',
      '2026-10',
    ]);
  });

  it('uses the template zone to decide the current month', () => {
    // 2026-10-01T02:00Z is still September 30 in New York.
    expect(
      dueGenerationMonths({ now: at('2026-10-01T02:00:00Z'), zone: 'America/New_York' }),
    ).toEqual(['2026-09', '2026-10']);
    expect(dueGenerationMonths({ now: at('2026-10-01T02:00:00Z'), zone: 'UTC' })).toEqual([
      '2026-10',
    ]);
  });

  it('rejects an invalid instant', () => {
    expect(() => dueGenerationMonths({ now: new Date(Number.NaN), zone: 'UTC' })).toThrow(
      RangeError,
    );
  });
});

describe('P17 donation accrual run waits for settlement after the program month', () => {
  it('defaults to 7 days after the first instant of the next month', () => {
    expect(DEFAULT_SETTLEMENT_GRACE_DAYS).toBe(7);
    expect(donationAccrualRunAt({ month: '2026-09', zone: 'UTC' })).toEqual(
      at('2026-10-08T00:00:00Z'),
    );
    expect(donationAccrualRunAt({ month: '2026-12', zone: 'UTC' })).toEqual(
      at('2027-01-08T00:00:00Z'),
    );
  });

  it('February and DST: local midnight of Mar 8 2026 in New York is still EST', () => {
    expect(donationAccrualRunAt({ month: '2026-02', zone: 'America/New_York' })).toEqual(
      at('2026-03-08T05:00:00Z'),
    );
    expect(donationAccrualRunAt({ month: '2026-10', zone: 'America/New_York' })).toEqual(
      at('2026-11-08T05:00:00Z'),
    );
  });

  it('grace 0 equals the end of the program month', () => {
    const zone = 'Australia/Lord_Howe';
    expect(donationAccrualRunAt({ month: '2026-09', zone, settlementGraceDays: 0 })).toEqual(
      monthBoundsUtc('2026-09', zone).end,
    );
  });

  it('rejects invalid grace days', () => {
    expect(() =>
      donationAccrualRunAt({ month: '2026-09', zone: 'UTC', settlementGraceDays: -1 }),
    ).toThrow(RangeError);
    expect(() =>
      donationAccrualRunAt({ month: '2026-09', zone: 'UTC', settlementGraceDays: 29 }),
    ).toThrow(RangeError);
  });
});
