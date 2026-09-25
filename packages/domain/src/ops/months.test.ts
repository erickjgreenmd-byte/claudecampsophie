import { describe, expect, it } from 'vitest';
import { MAX_REPORT_MONTHS, recentUtcMonths, utcMonthBounds, utcMonthKey } from './index.ts';

describe('UTC month buckets', () => {
  it('keys the month by UTC, not by any local zone', () => {
    // 23:30 on 30 September in UTC-5 is already 1 October in UTC.
    expect(utcMonthKey(new Date('2026-09-30T23:30:00-05:00'))).toBe('2026-10');
    expect(utcMonthKey(new Date('2026-10-01T00:00:00Z'))).toBe('2026-10');
    expect(utcMonthKey(new Date('2026-09-30T23:59:59.999Z'))).toBe('2026-09');
  });

  it('bounds a month as [start, end) in UTC', () => {
    expect(utcMonthBounds('2026-02')).toEqual({
      start: new Date('2026-02-01T00:00:00Z'),
      end: new Date('2026-03-01T00:00:00Z'),
    });
    expect(utcMonthBounds('2026-12').end).toEqual(new Date('2027-01-01T00:00:00Z'));
  });

  it('lists the last N months oldest first, ending with the current month, across a year boundary', () => {
    expect(recentUtcMonths(new Date('2026-02-10T12:00:00Z'), 6)).toEqual([
      '2025-09',
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
    expect(recentUtcMonths(new Date('2026-09-24T15:00:00Z'), 1)).toEqual(['2026-09']);
  });

  it('refuses a count outside 1..MAX_REPORT_MONTHS or a fractional count', () => {
    const now = new Date('2026-09-24T15:00:00Z');
    expect(() => recentUtcMonths(now, 0)).toThrow(RangeError);
    expect(() => recentUtcMonths(now, MAX_REPORT_MONTHS + 1)).toThrow(RangeError);
    expect(() => recentUtcMonths(now, 2.5)).toThrow(RangeError);
    expect(recentUtcMonths(now, MAX_REPORT_MONTHS)).toHaveLength(MAX_REPORT_MONTHS);
  });
});
