import { addMonths, calendarMonthOf, monthBoundsUtc, type CalendarMonth } from '../shared/time.ts';

/**
 * Company reporting buckets are UTC calendar months (spec F2: time is UTC instants; the owner's
 * revenue and spend views share one calendar with public.spend_budgets.period_key). `now` is
 * always an input: nothing here reads the wall clock.
 */

export const MAX_REPORT_MONTHS = 36;

/** The UTC calendar month containing `now`, formatted YYYY-MM. */
export function utcMonthKey(now: Date): CalendarMonth {
  return calendarMonthOf(now, 'UTC');
}

/** [start, end) UTC instants of a YYYY-MM month. */
export function utcMonthBounds(month: CalendarMonth): { start: Date; end: Date } {
  return monthBoundsUtc(month, 'UTC');
}

/**
 * The last `count` UTC months ending with the month containing `now`, oldest first. `count` is a
 * whole number from 1 to MAX_REPORT_MONTHS.
 */
export function recentUtcMonths(now: Date, count: number): CalendarMonth[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_REPORT_MONTHS) {
    throw new RangeError(`count must be a whole number from 1 to ${MAX_REPORT_MONTHS}`);
  }
  const current = utcMonthKey(now);
  const months: CalendarMonth[] = [];
  for (let back = count - 1; back >= 0; back -= 1) months.push(addMonths(current, -back));
  return months;
}
