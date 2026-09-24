// Notification timing (spec P14): parent opted-in devices by default; child reminders only with
// parent permission; quiet hours in the family's local time (may span midnight); opt-outs win.
// Content rules (generic readiness text, no answers or struggle labels) live with the sender.
import { DateTime } from 'luxon';
import { err, ok, type Result } from '../shared/result.ts';
import type { SchedulingErrorCode } from './errors.ts';
import {
  addCalendarDays,
  isSchedulingZone,
  isValidInstant,
  isValidLocalTime,
  localDateOf,
  resolveLocalDateTime,
  type LocalTime,
} from './local-time.ts';

export interface QuietHours {
  /** Inclusive local start `HH:mm`. */
  readonly start: LocalTime;
  /** Exclusive local end `HH:mm`; earlier than `start` means the window spans midnight. */
  readonly end: LocalTime;
}

export type NotificationAudience = 'parent' | 'child';

export function isNotificationAudience(value: unknown): value is NotificationAudience {
  return value === 'parent' || value === 'child';
}

export interface NotificationRequest {
  readonly desiredAt: Date;
  /** Family IANA zone. */
  readonly zone: string;
  readonly quietHours: QuietHours | null;
  readonly audience: NotificationAudience;
  /** Parent permission for child reminders (not consulted for parents, but must be a boolean). */
  readonly childRemindersPermitted: boolean;
  /** The recipient device/channel is opted in. */
  readonly optedIn: boolean;
}

export type NotificationDecision =
  | { readonly send: false; readonly reason: 'opted_out' | 'child_reminders_not_permitted' }
  | { readonly send: true; readonly sendAt: Date };

/** Local wall time of `instant` as minutes since local midnight (fractional seconds included). */
function localMinutes(instant: Date, zone: string): number {
  const local = DateTime.fromJSDate(instant, { zone });
  return local.hour * 60 + local.minute + (local.second + local.millisecond / 1000) / 60;
}

function minutesOf(time: LocalTime): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function inQuietHours(minutes: number, start: number, end: number): boolean {
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/**
 * Decide whether and when to send. Opt-out and missing child permission suppress the send; a
 * desired instant inside quiet hours moves to the first allowed instant, i.e. the local quiet-hours
 * end. Decision: that is the next occurrence of the end time strictly after `desiredAt` (during a
 * fall-back repeat, the later occurrence, so a send never moves backwards), or the first valid
 * instant after a spring-forward gap when the end time does not exist that day.
 * Decision: `start === end` is rejected as ambiguous (none vs. all day) rather than guessed.
 * Runtime values outside the declared domains (an audience other than `parent`/`child`, or flags
 * that are not real booleans) return INVALID_AUDIENCE / INVALID_NOTIFICATION_FLAG, never a send.
 */
export function scheduleNotification(
  request: NotificationRequest,
): Result<NotificationDecision, SchedulingErrorCode> {
  if (!isSchedulingZone(request.zone)) {
    return err('INVALID_TIME_ZONE', 'Family time zone must be a valid IANA zone');
  }
  if (!isValidInstant(request.desiredAt)) return err('INVALID_INSTANT', 'desiredAt is invalid');
  const quiet = request.quietHours;
  if (
    quiet !== null &&
    (!isValidLocalTime(quiet.start) || !isValidLocalTime(quiet.end) || quiet.start === quiet.end)
  ) {
    return err('INVALID_QUIET_HOURS', 'Quiet hours need distinct HH:mm start and end times');
  }
  // Consent gates fail closed (RV-scheduling-2). Stored, JSON or queue data can bypass the types:
  // the audience is allow-listed and both flags must be real booleans, never truthy strings.
  if (!isNotificationAudience(request.audience)) {
    return err('INVALID_AUDIENCE', "Notification audience must be 'parent' or 'child'");
  }
  if (
    typeof request.optedIn !== 'boolean' ||
    typeof request.childRemindersPermitted !== 'boolean'
  ) {
    return err('INVALID_NOTIFICATION_FLAG', 'optedIn and childRemindersPermitted must be booleans');
  }
  if (request.optedIn !== true) return ok({ send: false, reason: 'opted_out' });
  if (request.audience !== 'parent' && request.childRemindersPermitted !== true) {
    return ok({ send: false, reason: 'child_reminders_not_permitted' });
  }
  if (quiet === null) return ok({ send: true, sendAt: request.desiredAt });

  const { zone, desiredAt } = request;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  const now = localMinutes(desiredAt, zone);
  if (!inQuietHours(now, start, end)) return ok({ send: true, sendAt: desiredAt });

  // The quiet window ends later today, unless it spans midnight and we are in its evening part.
  const today = localDateOf(desiredAt, zone);
  const endDate = start > end && now >= start ? addCalendarDays(today, 1) : today;
  const resolved = resolveLocalDateTime(zone, endDate, quiet.end);
  const after = resolved.occurrences.find((instant) => instant.getTime() > desiredAt.getTime());
  const sendAt = after ?? resolved.gapResolution;
  if (sendAt === null || sendAt.getTime() < desiredAt.getTime()) {
    throw new Error('Unreachable: quiet-hours end precedes the desired send time');
  }
  return ok({ send: true, sendAt });
}
