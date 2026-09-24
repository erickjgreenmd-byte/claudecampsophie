import { DateTime, IANAZone } from 'luxon';

/** Calendar month in some zone, formatted `YYYY-MM`. */
export type CalendarMonth = string;
/** Calendar date, formatted `YYYY-MM-DD`. */
export type CalendarDate = string;

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isValidIanaZone(zone: string): boolean {
  return IANAZone.isValidZone(zone);
}

export function assertIanaZone(zone: string): string {
  if (!isValidIanaZone(zone)) throw new RangeError(`Invalid IANA time zone: ${zone}`);
  return zone;
}

export function parseCalendarMonth(month: CalendarMonth): { year: number; month: number } {
  const match = MONTH_RE.exec(month);
  if (!match) throw new RangeError(`Invalid calendar month ${month}; expected YYYY-MM`);
  return { year: Number(match[1]), month: Number(match[2]) };
}

/** The calendar month containing `instant` in `zone`. */
export function calendarMonthOf(instant: Date, zone: string): CalendarMonth {
  assertIanaZone(zone);
  return DateTime.fromJSDate(instant, { zone }).toFormat('yyyy-MM');
}

export function addMonths(month: CalendarMonth, delta: number): CalendarMonth {
  const { year, month: m } = parseCalendarMonth(month);
  const index = year * 12 + (m - 1) + delta;
  const y = Math.floor(index / 12);
  const mm = (index % 12) + 1;
  return `${String(y).padStart(4, '0')}-${String(mm).padStart(2, '0')}`;
}

export function compareMonths(a: CalendarMonth, b: CalendarMonth): number {
  parseCalendarMonth(a);
  parseCalendarMonth(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** [start, end) UTC instants of a calendar month interpreted in `zone` (DST-correct). */
export function monthBoundsUtc(month: CalendarMonth, zone: string): { start: Date; end: Date } {
  assertIanaZone(zone);
  const { year, month: m } = parseCalendarMonth(month);
  const start = DateTime.fromObject({ year, month: m, day: 1 }, { zone }).startOf('day');
  return { start: start.toUTC().toJSDate(), end: start.plus({ months: 1 }).toUTC().toJSDate() };
}
