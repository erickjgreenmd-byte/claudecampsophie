// Local wall-clock <-> UTC instant conversion with explicit, documented DST rules, plus ISO week
// keys in the family zone (spec P8, E4). Every schedule in PencilLift is "a local date/time in an
// IANA zone"; this file is the only place that turns one into a UTC instant.
import { DateTime, IANAZone } from 'luxon';
import { assertIanaZone, isValidIanaZone, type CalendarDate } from '../shared/time.ts';

/** Local wall-clock time `HH:mm` (24-hour, 00:00..23:59). */
export type LocalTime = string;
/** ISO-8601 week key `YYYY-Www` (ISO week-numbering year, Monday-start weeks). */
export type IsoWeekKey = string;

const LOCAL_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEK_KEY_RE = /^(\d{4})-W(\d{2})$/;
/**
 * Leading sign of a raw UTC-offset spelling (`+05:00`, `-0800`, `\u221205:00`). Intl accepts
 * the ASCII signs and U+2212 MINUS SIGN; the other Unicode plus/minus/dash lookalikes are listed
 * too so a future ICU that accepts them still cannot smuggle a fixed offset in (RV-scheduling-1).
 */
const OFFSET_SIGN_RE =
  /^[+\-\u2212\u2010-\u2015\u2796\u207A\u207B\u208A\u208B\uFE62\uFE63\uFF0B\uFF0D]/u;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Offsets are sampled every 3 h over +/-30 h around the requested wall time. */
const OFFSET_SAMPLE_STEP_MS = 3 * HOUR_MS;
const OFFSET_SAMPLE_SPAN_MS = 30 * HOUR_MS;

/** Zone name Intl resolves `zone` to (`\u221205:00` -> `-05:00`); null if Intl rejects it. */
function intlResolvedZone(zone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * True when `zone` is a raw UTC offset: either it is spelled with a leading sign (any Unicode
 * plus/minus form), or Intl normalizes it to an offset. The resolved-name check does not depend on
 * which sign spellings a given ICU build accepts.
 */
function isFixedOffsetZone(zone: string): boolean {
  if (OFFSET_SIGN_RE.test(zone.trim())) return true;
  const resolved = intlResolvedZone(zone);
  return resolved !== null && OFFSET_SIGN_RE.test(resolved);
}

/**
 * True for an IANA zone name usable by schedules.
 *
 * Decision: raw UTC-offset strings such as `+05:00` or `\u221205:00` (U+2212 minus) are rejected
 * even though Node's Intl (and so `isValidIanaZone`) accepts them. A fixed offset silently ignores
 * daylight-saving rules, which the spec forbids for family schedules. IANA names (including `UTC`
 * and `Etc/*`) are accepted.
 */
export function isSchedulingZone(zone: unknown): zone is string {
  return typeof zone === 'string' && isValidIanaZone(zone) && !isFixedOffsetZone(zone);
}

/** Throws RangeError unless `zone` is a usable IANA zone (see `isSchedulingZone`). */
export function assertSchedulingZone(zone: string): string {
  assertIanaZone(zone);
  if (isFixedOffsetZone(zone)) {
    throw new RangeError(`Fixed UTC offsets are not IANA zones: ${zone}`);
  }
  return zone;
}

export function isValidLocalTime(value: unknown): value is LocalTime {
  return typeof value === 'string' && LOCAL_TIME_RE.test(value);
}

export function isValidCalendarDate(value: unknown): value is CalendarDate {
  if (typeof value !== 'string') return false;
  const match = CALENDAR_DATE_RE.exec(value);
  if (!match) return false;
  const dt = DateTime.fromObject(
    { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) },
    { zone: 'UTC' },
  );
  return dt.isValid;
}

export function isValidInstant(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function parseLocalTime(time: LocalTime): { hour: number; minute: number } {
  const match = LOCAL_TIME_RE.exec(time);
  if (!match) throw new RangeError(`Invalid local time ${String(time)}; expected HH:mm`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function parseCalendarDate(date: CalendarDate): DateTime<true> {
  const match = typeof date === 'string' ? CALENDAR_DATE_RE.exec(date) : null;
  const dt = match
    ? DateTime.fromObject(
        { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) },
        { zone: 'UTC' },
      )
    : null;
  if (!dt?.isValid)
    throw new RangeError(`Invalid calendar date ${String(date)}; expected YYYY-MM-DD`);
  return dt;
}

function assertInstant(instant: Date, what = 'instant'): void {
  if (!isValidInstant(instant)) throw new RangeError(`Invalid ${what}`);
}

/** Pure calendar arithmetic on `YYYY-MM-DD` (no zone involved). */
export function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  if (!Number.isSafeInteger(days)) throw new RangeError('days must be an integer');
  return parseCalendarDate(date).plus({ days }).toISODate();
}

/** ISO weekday (1 = Monday .. 7 = Sunday) of a calendar date. */
export function isoWeekdayOf(date: CalendarDate): number {
  return parseCalendarDate(date).weekday;
}

/** The family-local calendar date containing `instant`. */
export function localDateOf(instant: Date, zone: string): CalendarDate {
  assertSchedulingZone(zone);
  assertInstant(instant);
  const local = DateTime.fromJSDate(instant, { zone });
  if (!local.isValid) throw new RangeError('Instant is outside the supported range');
  return local.toISODate();
}

function offsetMs(zone: IANAZone, epochMs: number): number {
  return zone.offset(epochMs) * MINUTE_MS;
}

/** Local wall clock at `epochMs`, expressed as milliseconds of a UTC-labelled "naive" clock. */
function wallMs(zone: IANAZone, epochMs: number): number {
  return epochMs + offsetMs(zone, epochMs);
}

/** Every UTC instant (ascending) whose local wall clock equals `naiveMs`; empty inside a gap. */
function occurrences(zone: IANAZone, naiveMs: number): number[] {
  const offsets = new Set<number>();
  for (let d = -OFFSET_SAMPLE_SPAN_MS; d <= OFFSET_SAMPLE_SPAN_MS; d += OFFSET_SAMPLE_STEP_MS) {
    offsets.add(offsetMs(zone, naiveMs + d));
  }
  const found = new Set<number>();
  for (const offset of offsets) {
    const candidate = naiveMs - offset;
    if (offsetMs(zone, candidate) === offset) found.add(candidate);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * First instant whose local wall clock is later than `naiveMs`, for a wall time that falls in a
 * spring-forward gap. Binary search between the instants the wall time would have under the
 * largest and smallest nearby offsets.
 */
function firstInstantAfterGap(zone: IANAZone, naiveMs: number): number {
  let maxOffset = Number.NEGATIVE_INFINITY;
  let minOffset = Number.POSITIVE_INFINITY;
  for (let d = -OFFSET_SAMPLE_SPAN_MS; d <= OFFSET_SAMPLE_SPAN_MS; d += OFFSET_SAMPLE_STEP_MS) {
    const offset = offsetMs(zone, naiveMs + d);
    maxOffset = Math.max(maxOffset, offset);
    minOffset = Math.min(minOffset, offset);
  }
  let lo = naiveMs - maxOffset; // wall clock here is before the requested time
  let hi = naiveMs - minOffset; // wall clock here is after the requested time
  if (!(wallMs(zone, lo) < naiveMs && wallMs(zone, hi) > naiveMs)) {
    throw new Error(`Could not bracket the DST gap for ${zone.name}`);
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (wallMs(zone, mid) > naiveMs) hi = mid;
    else lo = mid;
  }
  return hi;
}

function naiveMsOf(date: CalendarDate, time: LocalTime): number {
  const { hour, minute } = parseLocalTime(time);
  return parseCalendarDate(date).set({ hour, minute }).toMillis();
}

/**
 * Local occurrences of `date time` in `zone` as UTC epoch milliseconds (ascending). An ambiguous
 * fall-back time has two; a spring-forward gap time has none, and `gapResolution` is then the
 * first valid instant after the gap.
 */
export function resolveLocalDateTime(
  zone: string,
  date: CalendarDate,
  time: LocalTime,
): { readonly occurrences: readonly Date[]; readonly gapResolution: Date | null } {
  assertSchedulingZone(zone);
  const iana = IANAZone.create(zone);
  const naive = naiveMsOf(date, time);
  const found = occurrences(iana, naive);
  return found.length > 0
    ? { occurrences: found.map((ms) => new Date(ms)), gapResolution: null }
    : { occurrences: [], gapResolution: new Date(firstInstantAfterGap(iana, naive)) };
}

/**
 * The UTC instant of local `date` (`YYYY-MM-DD`) at `time` (`HH:mm`) in IANA `zone`.
 *
 * DST rules (documented contract, relied on by every schedule):
 * - Nonexistent local time (spring-forward gap, e.g. 02:30 on 2026-03-08 in New York): moves
 *   forward to the first valid instant after the gap (03:00 EDT), not "same offset shifted"
 *   (which would give 03:30).
 * - Ambiguous local time (fall-back overlap, e.g. 01:30 on 2026-11-01 in New York): resolves to
 *   the EARLIER occurrence (01:30 EDT), so a schedule is never later than the family expects.
 * - Throws RangeError on an invalid zone, date or time (callers validate untrusted input first).
 */
export function localDateTimeToUtc(zone: string, date: CalendarDate, time: LocalTime): Date {
  const resolved = resolveLocalDateTime(zone, date, time);
  const first = resolved.occurrences[0] ?? resolved.gapResolution;
  if (first === null) throw new Error('Unreachable: no occurrence and no gap resolution');
  return first;
}

/** First valid instant of a local date (local midnight, or later if midnight is skipped). */
export function startOfLocalDay(zone: string, date: CalendarDate): Date {
  return localDateTimeToUtc(zone, date, '00:00');
}

function formatWeekKey(weekYear: number, weekNumber: number): IsoWeekKey {
  return `${String(weekYear).padStart(4, '0')}-W${String(weekNumber).padStart(2, '0')}`;
}

/** Parses `YYYY-Www`; the week must exist in its ISO week-year (2026 has 53 weeks, 2027 52). */
export function parseWeekKey(weekKey: IsoWeekKey): { weekYear: number; weekNumber: number } {
  const match = typeof weekKey === 'string' ? WEEK_KEY_RE.exec(weekKey) : null;
  if (!match) throw new RangeError(`Invalid ISO week key ${String(weekKey)}; expected YYYY-Www`);
  const weekYear = Number(match[1]);
  const weekNumber = Number(match[2]);
  const weeksInYear = DateTime.fromObject(
    { weekYear, weekNumber: 1, weekday: 1 },
    { zone: 'UTC' },
  ).weeksInWeekYear;
  if (weekYear < 1 || weekNumber < 1 || weekNumber > weeksInYear) {
    throw new RangeError(`ISO week ${weekKey} does not exist`);
  }
  return { weekYear, weekNumber };
}

export function isValidWeekKey(value: unknown): value is IsoWeekKey {
  if (typeof value !== 'string') return false;
  try {
    parseWeekKey(value);
    return true;
  } catch {
    return false;
  }
}

export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export function isIsoWeekday(value: unknown): value is IsoWeekday {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 7;
}

/** The calendar date of ISO `weekday` (1 = Monday .. 7 = Sunday) in `weekKey`. */
export function dateInIsoWeek(weekKey: IsoWeekKey, weekday: number): CalendarDate {
  const { weekYear, weekNumber } = parseWeekKey(weekKey);
  if (!isIsoWeekday(weekday)) throw new RangeError('weekday must be an ISO weekday 1..7');
  const dt = DateTime.fromObject({ weekYear, weekNumber, weekday }, { zone: 'UTC' });
  if (!dt.isValid) throw new RangeError(`Invalid ISO week date ${weekKey}-${weekday}`);
  return dt.toISODate();
}

/** Monday and Sunday calendar dates of an ISO week. */
export function isoWeekDates(weekKey: IsoWeekKey): { monday: CalendarDate; sunday: CalendarDate } {
  return { monday: dateInIsoWeek(weekKey, 1), sunday: dateInIsoWeek(weekKey, 7) };
}

/** ISO week key of a calendar date (zone-free). */
export function weekKeyOfDate(date: CalendarDate): IsoWeekKey {
  const dt = parseCalendarDate(date);
  return formatWeekKey(dt.weekYear, dt.weekNumber);
}

/** ISO week `YYYY-Www` containing `instant` in the family `zone` (not server UTC). */
export function reviewWeekKey(instant: Date, zone: string): IsoWeekKey {
  return weekKeyOfDate(localDateOf(instant, zone));
}
