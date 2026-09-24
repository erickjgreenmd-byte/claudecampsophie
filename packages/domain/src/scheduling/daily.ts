// Daily extra-credit availability (spec P7, AC_LEARNING_03): offered every local day, including
// weekends, from a parent-selected local time in the family zone; pause, vacation dates and
// subject exclusions; no missed-day penalty and no expiry of earned points.
import { err, ok, type Result } from '../shared/result.ts';
import type { CalendarDate } from '../shared/time.ts';
import type { SchedulingErrorCode } from './errors.ts';
import { encodeKeyComponent, isValidSubject } from './identifiers.ts';
import {
  isSchedulingZone,
  isValidCalendarDate,
  isValidInstant,
  isValidLocalTime,
  localDateOf,
  localDateTimeToUtc,
  type LocalTime,
} from './local-time.ts';

export const DEFAULT_DAILY_PRACTICE_LOCAL_TIME: LocalTime = '15:30';

/**
 * Pausing, vacations and missed days never remove or expire points the child already earned and
 * never impose a penalty (spec P7). Exposed so screens state the rule truthfully.
 */
export const DAILY_PRACTICE_POINTS_POLICY = Object.freeze({
  expireEarnedPoints: false,
  penalizeMissedDays: false,
} as const);

export interface DailyPracticeSettings {
  /** Parent-selected local release time `HH:mm`; default 15:30. */
  readonly localTime: LocalTime;
  /** Inclusive local-date range with no new daily set, or null. */
  readonly paused: { readonly from: CalendarDate; readonly to: CalendarDate } | null;
  readonly vacationDates: readonly CalendarDate[];
  /** Subjects the parent excluded from daily practice (see `dailyPracticeSubjects`). */
  readonly excludedSubjects: readonly string[];
}

export type DailyPracticeReason = 'available' | 'not_yet_released' | 'paused' | 'vacation';

export interface DailyPracticeState {
  /** Family-local date of `now`; the daily set is identified by (child, localDate). */
  readonly localDate: CalendarDate;
  readonly available: boolean;
  readonly reason: DailyPracticeReason;
  /** Release instant of this local date's set (reported even when paused or on vacation). */
  readonly releaseAt: Date;
  readonly pointsPolicy: typeof DAILY_PRACTICE_POINTS_POLICY;
}

type SchedulingResult<T> = Result<T, SchedulingErrorCode>;

function validateSettings(
  settings: DailyPracticeSettings,
): SchedulingResult<DailyPracticeSettings> {
  if (!isValidLocalTime(settings.localTime)) {
    return err('INVALID_LOCAL_TIME', 'Daily practice time must be HH:mm (00:00..23:59)');
  }
  if (settings.paused !== null) {
    const { from, to } = settings.paused;
    if (!isValidCalendarDate(from) || !isValidCalendarDate(to)) {
      return err('INVALID_CALENDAR_DATE', 'Pause dates must be YYYY-MM-DD calendar dates');
    }
    if (from > to) return err('INVALID_DATE_RANGE', 'A pause must not end before it starts');
  }
  for (const date of settings.vacationDates) {
    if (!isValidCalendarDate(date)) {
      return err('INVALID_CALENDAR_DATE', 'Vacation dates must be YYYY-MM-DD calendar dates');
    }
  }
  for (const subject of settings.excludedSubjects) {
    if (!isValidSubject(subject)) {
      return err('INVALID_SUBJECT', 'Excluded subjects must be non-empty identifiers');
    }
  }
  return ok(settings);
}

/**
 * Whether today's (family-local) daily set is available at `now`. Available on every local day,
 * weekends included, once `releaseAt` (the parent's local time on that date, resolved with the
 * documented DST rules) has passed, until local midnight. Decision: a pause range is inclusive
 * and is reported ahead of a vacation date on the same day; before the release time the reason is
 * `not_yet_released` (an extra state beyond available/paused/vacation). Neither pause nor vacation
 * affects already-earned points (`DAILY_PRACTICE_POINTS_POLICY`).
 */
export function dailyPracticeState(input: {
  readonly zone: string;
  readonly now: Date;
  readonly settings: DailyPracticeSettings;
}): SchedulingResult<DailyPracticeState> {
  if (!isSchedulingZone(input.zone)) {
    return err('INVALID_TIME_ZONE', 'Family time zone must be a valid IANA zone');
  }
  if (!isValidInstant(input.now)) return err('INVALID_INSTANT', 'now is invalid');
  const valid = validateSettings(input.settings);
  if (!valid.ok) return valid;
  const { settings, zone, now } = input;

  const localDate = localDateOf(now, zone);
  const releaseAt = localDateTimeToUtc(zone, localDate, settings.localTime);
  const base = { localDate, releaseAt, pointsPolicy: DAILY_PRACTICE_POINTS_POLICY };
  if (
    settings.paused !== null &&
    settings.paused.from <= localDate &&
    localDate <= settings.paused.to
  ) {
    return ok({ ...base, available: false, reason: 'paused' });
  }
  if (settings.vacationDates.includes(localDate)) {
    return ok({ ...base, available: false, reason: 'vacation' });
  }
  const released = now.getTime() >= releaseAt.getTime();
  return ok({ ...base, available: released, reason: released ? 'available' : 'not_yet_released' });
}

/** Enabled subjects minus parent exclusions, preserving the enabled order. */
export function dailyPracticeSubjects(
  enabledSubjects: readonly string[],
  excludedSubjects: readonly string[],
): SchedulingResult<string[]> {
  for (const subject of [...enabledSubjects, ...excludedSubjects]) {
    if (!isValidSubject(subject)) return err('INVALID_SUBJECT', 'Subjects must be identifiers');
  }
  const excluded = new Set(excludedSubjects);
  return ok(enabledSubjects.filter((subject) => !excluded.has(subject)));
}

/**
 * Stable identity of a child's daily set for a family-local date: the set is generated once,
 * saved and reused on retries/reopening (spec P7). Throws RangeError on malformed input.
 */
export function dailySetKey(childId: string, localDate: CalendarDate): string {
  if (!isValidCalendarDate(localDate)) throw new RangeError('localDate must be YYYY-MM-DD');
  return `daily:${encodeKeyComponent(childId, 'childId')}:${localDate}`;
}
