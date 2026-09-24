// Thursday review scheduling (spec P8, E4 Scheduling; AC_LEARNING_08, AC_LEARNING_09): release
// instants in the family zone, per-subject test-date overrides and skipped weeks, idempotency
// keys, lead time / evidence cutoff, lateness monitoring and versioned optional top-ups. What goes
// into a review is decided by the learning module (`learning/thursday.ts`).
import { err, ok, type Result } from '../shared/result.ts';
import type { CalendarDate } from '../shared/time.ts';
import type { SchedulingErrorCode } from './errors.ts';
import { encodeKeyComponent, isValidSubject } from './identifiers.ts';
import {
  addCalendarDays,
  dateInIsoWeek,
  isIsoWeekday,
  isSchedulingZone,
  isValidCalendarDate,
  isValidInstant,
  isValidLocalTime,
  isValidWeekKey,
  localDateTimeToUtc,
  weekKeyOfDate,
  type IsoWeekKey,
  type LocalTime,
} from './local-time.ts';

/** ISO weekday 4 = Thursday. */
export const DEFAULT_REVIEW_WEEKDAY = 4;
export const DEFAULT_REVIEW_LOCAL_TIME: LocalTime = '16:00';
/** Decision: schedule versions start at 1 and increase on every parent schedule change. */
export const INITIAL_SCHEDULE_VERSION = 1;

export interface SubjectScheduleOverride {
  /** Test dates for this subject; a test inside an ISO week moves that week's release. */
  readonly testDates?: readonly CalendarDate[];
  /** ISO week keys with no review for this subject (holiday, no test). */
  readonly skipWeeks?: readonly IsoWeekKey[];
}

export interface ReviewSchedule {
  /** ISO weekday 1 (Monday) .. 7 (Sunday); default 4 (Thursday). */
  readonly weekday: number;
  /** Local release time `HH:mm`; default `16:00`. */
  readonly localTime: LocalTime;
  /** Positive integer, part of the review idempotency key. */
  readonly scheduleVersion: number;
  readonly subjectOverrides?: Readonly<Record<string, SubjectScheduleOverride>>;
}

export function defaultReviewSchedule(): ReviewSchedule {
  return {
    weekday: DEFAULT_REVIEW_WEEKDAY,
    localTime: DEFAULT_REVIEW_LOCAL_TIME,
    scheduleVersion: INITIAL_SCHEDULE_VERSION,
  };
}

type SchedulingResult<T> = Result<T, SchedulingErrorCode>;

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Own-property lookup so subjects such as `constructor` never hit `Object.prototype`. */
function overrideFor(
  schedule: ReviewSchedule,
  subject: string,
): SubjectScheduleOverride | undefined {
  const overrides = schedule.subjectOverrides;
  if (overrides === undefined || !Object.hasOwn(overrides, subject)) return undefined;
  return overrides[subject];
}

/** Validates a parent-configured review schedule; returns the first problem found. */
export function validateReviewSchedule(schedule: ReviewSchedule): SchedulingResult<ReviewSchedule> {
  if (!isIsoWeekday(schedule.weekday)) {
    return err('INVALID_WEEKDAY', 'Review weekday must be an ISO weekday 1 (Mon) .. 7 (Sun)');
  }
  if (!isValidLocalTime(schedule.localTime)) {
    return err('INVALID_LOCAL_TIME', 'Review time must be HH:mm (00:00..23:59)');
  }
  if (!isPositiveSafeInteger(schedule.scheduleVersion)) {
    return err('INVALID_SCHEDULE_VERSION', 'Schedule version must be a positive integer');
  }
  const overrides = schedule.subjectOverrides ?? {};
  for (const subject of Object.keys(overrides)) {
    if (!isValidSubject(subject)) {
      return err('INVALID_SUBJECT', 'Subject override names must be non-empty identifiers');
    }
    const override = overrides[subject];
    for (const date of override?.testDates ?? []) {
      if (!isValidCalendarDate(date)) {
        return err('INVALID_CALENDAR_DATE', 'Test dates must be YYYY-MM-DD calendar dates', {
          subject,
        });
      }
    }
    for (const week of override?.skipWeeks ?? []) {
      if (!isValidWeekKey(week)) {
        return err('INVALID_WEEK_KEY', 'Skipped weeks must be existing ISO weeks (YYYY-Www)', {
          subject,
        });
      }
    }
  }
  return ok(schedule);
}

export type ReviewReleaseReason = 'default_schedule' | 'test_date_eve' | 'skipped_week';

export interface ReviewRelease {
  readonly subject: string;
  readonly weekKey: IsoWeekKey;
  /** UTC release instant, or null when the parent skipped this week for the subject. */
  readonly releaseAt: Date | null;
  /** Family-local release date, or null when skipped. */
  readonly localDate: CalendarDate | null;
  readonly reason: ReviewReleaseReason;
  /** Earliest test date for this subject inside the week (also reported when skipped). */
  readonly testDate: CalendarDate | null;
}

export interface ReviewReleasesInput {
  readonly schedule: ReviewSchedule;
  /** Family IANA zone. */
  readonly zone: string;
  /** Enabled subjects (each gets a release decision, in input order). */
  readonly subjects: readonly string[];
  readonly weekKey: IsoWeekKey;
}

/**
 * Per-subject release instants for one ISO week in the family zone.
 *
 * - Default: the configured weekday at the configured local time of that ISO week.
 * - Test date inside the week: release at the configured local time on the day BEFORE the test
 *   (Friday test -> Thursday, Wednesday test -> Tuesday). Decision: a Monday test releases on the
 *   preceding Sunday (the previous ISO week) but stays keyed to the test's week.
 *   Decision: with several test dates in one week, the earliest one wins so the review is ready
 *   before the first test.
 * - Skipped week: no release for that subject. Decision: an explicit skip wins over a test date
 *   (the parent's schedule is authoritative, spec P8); the conflicting test date is reported so
 *   the planner can show it.
 * Local times resolve with `localDateTimeToUtc` DST rules (gap -> first valid instant after it;
 * overlap -> earlier occurrence).
 */
export function reviewReleases(input: ReviewReleasesInput): SchedulingResult<ReviewRelease[]> {
  if (!isSchedulingZone(input.zone)) {
    return err('INVALID_TIME_ZONE', 'Family time zone must be a valid IANA zone');
  }
  const valid = validateReviewSchedule(input.schedule);
  if (!valid.ok) return valid;
  if (!isValidWeekKey(input.weekKey)) {
    return err('INVALID_WEEK_KEY', 'Week key must be an existing ISO week (YYYY-Www)');
  }
  const seen = new Set<string>();
  for (const subject of input.subjects) {
    if (!isValidSubject(subject)) return err('INVALID_SUBJECT', 'Subjects must be identifiers');
    if (seen.has(subject)) return err('DUPLICATE_SUBJECT', 'Each subject may appear only once');
    seen.add(subject);
  }

  const { schedule, zone, weekKey } = input;
  const defaultDate = dateInIsoWeek(weekKey, schedule.weekday);
  return ok(
    input.subjects.map((subject): ReviewRelease => {
      const override = overrideFor(schedule, subject);
      const testsThisWeek = (override?.testDates ?? [])
        .filter((date) => weekKeyOfDate(date) === weekKey)
        .sort();
      const testDate = testsThisWeek[0] ?? null;
      if ((override?.skipWeeks ?? []).includes(weekKey)) {
        return {
          subject,
          weekKey,
          releaseAt: null,
          localDate: null,
          reason: 'skipped_week',
          testDate,
        };
      }
      const localDate = testDate === null ? defaultDate : addCalendarDays(testDate, -1);
      return {
        subject,
        weekKey,
        releaseAt: localDateTimeToUtc(zone, localDate, schedule.localTime),
        localDate,
        reason: testDate === null ? 'default_schedule' : 'test_date_eve',
        testDate,
      };
    }),
  );
}

/**
 * Durable-job idempotency key `(child, subject, review_week, schedule_version)` (spec P8). Stable
 * across worker retries; components are percent-encoded so distinct tuples never collide. The
 * database enforces uniqueness. Throws RangeError on malformed components (programmer error).
 */
export function reviewIdempotencyKey(
  childId: string,
  subject: string,
  weekKey: IsoWeekKey,
  scheduleVersion: number,
): string {
  if (!isValidWeekKey(weekKey)) throw new RangeError('Invalid ISO week key');
  if (!isPositiveSafeInteger(scheduleVersion)) {
    throw new RangeError('scheduleVersion must be a positive integer');
  }
  return [
    'review',
    encodeKeyComponent(childId, 'childId'),
    encodeKeyComponent(subject, 'subject'),
    weekKey,
    `s${scheduleVersion}`,
  ].join(':');
}

export interface ReviewKeyParts {
  readonly childId: string;
  readonly subject: string;
  readonly weekKey: IsoWeekKey;
  readonly scheduleVersion: number;
}

const SCHEDULE_VERSION_PART_RE = /^s(\d{1,16})$/;

/**
 * Inverse of `reviewIdempotencyKey`: the tuple of a canonical base review key, or null for
 * anything else (a top-up key, a bare `review:` prefix, non-canonical encoding). Canonical means
 * `reviewIdempotencyKey` rebuilds exactly the same string, so each tuple has exactly one base key.
 */
export function parseReviewIdempotencyKey(reviewKey: unknown): ReviewKeyParts | null {
  if (typeof reviewKey !== 'string') return null;
  const parts = reviewKey.split(':');
  if (parts.length !== 5 || parts[0] !== 'review') return null;
  const [, encodedChild = '', encodedSubject = '', weekKey = '', versionPart = ''] = parts;
  const version = SCHEDULE_VERSION_PART_RE.exec(versionPart);
  if (version === null) return null;
  try {
    const childId = decodeURIComponent(encodedChild);
    const subject = decodeURIComponent(encodedSubject);
    const scheduleVersion = Number(version[1]);
    return reviewIdempotencyKey(childId, subject, weekKey, scheduleVersion) === reviewKey
      ? { childId, subject, weekKey, scheduleVersion }
      : null;
  } catch {
    // Malformed percent-encoding (URIError) or components reviewIdempotencyKey rejects.
    return null;
  }
}

/**
 * Key of optional top-up `reviewVersion` (>= 2) of the review identified by `reviewKey`.
 * `reviewKey` must be a canonical base key from `reviewIdempotencyKey` (RV-scheduling-3): deriving
 * from a top-up key would give `<base>:v2:v3`, a second key for the same version as `<base>:v3`.
 */
export function topUpIdempotencyKey(reviewKey: string, reviewVersion: number): string {
  if (parseReviewIdempotencyKey(reviewKey) === null) {
    throw new RangeError('reviewKey must be a base key from reviewIdempotencyKey');
  }
  if (!isPositiveSafeInteger(reviewVersion) || reviewVersion < 2) {
    throw new RangeError('Top-up review versions start at 2 (version 1 is the base review)');
  }
  return `${reviewKey}:v${reviewVersion}`;
}

export const DEFAULT_SAFETY_MARGIN_MS = 30 * 60_000;
export const DEFAULT_MINIMUM_LEAD_MS = 2 * 3_600_000;
/**
 * Decision: the lead is capped at 24 h by default so a runaway latency measurement (stuck queue,
 * outlier) cannot silently move the evidence cutoff days earlier; exceeding it is flagged as a
 * lateness risk for operations instead.
 */
export const MAX_REVIEW_LEAD_MS = 24 * 3_600_000;

export interface ReviewJobInput {
  readonly releaseAt: Date;
  /** Measured p95 generation time; null when not yet measured. */
  readonly measuredP95ProcessingMs: number | null;
  /** Measured p95 queue wait; null when not yet measured. */
  readonly queueLagP95Ms: number | null;
  readonly safetyMarginMs?: number;
  readonly minimumLeadMs?: number;
  readonly maxLeadMs?: number;
  /**
   * Decision: when planned after the ideal start (late schedule change, backlog), the job starts
   * at `now`, the evidence cutoff is `now`, and the plan is flagged as a lateness risk.
   */
  readonly now?: Date;
}

export interface ReviewJobPlan {
  readonly jobStartAt: Date;
  /** Evidence after this instant is late evidence (top-up material). Equals `jobStartAt`. */
  readonly evidenceCutoffAt: Date;
  /** `releaseAt - jobStartAt` (smaller than required when planned late; <= 0 past release). */
  readonly leadMs: number;
  /** max(minimum lead, p95 processing + p95 queue lag + safety margin), before capping. */
  readonly requiredLeadMs: number;
  readonly basis: 'measured' | 'default_minimum';
  /** True when the plan cannot provide `requiredLeadMs` (capped, or planned too late). */
  readonly latenessRisk: boolean;
}

function checkDuration(value: unknown, positive: boolean): boolean {
  return isNonNegativeSafeInteger(value) && (!positive || value > 0);
}

/**
 * E4: Thursday 16:00 is the release target, not the start of work. The job starts
 * `lead = max(minimumLead, p95 + queueLag + margin)` before release, and that start is also the
 * evidence cutoff. Decision: an unknown queue lag counts as 0 while a measured processing p95
 * still applies; the minimum lead always applies, so the job never starts at the release time.
 */
export function planReviewJob(input: ReviewJobInput): SchedulingResult<ReviewJobPlan> {
  if (!isValidInstant(input.releaseAt)) return err('INVALID_INSTANT', 'releaseAt is invalid');
  if (input.now !== undefined && !isValidInstant(input.now)) {
    return err('INVALID_INSTANT', 'now is invalid');
  }
  const margin = input.safetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS;
  const minimum = input.minimumLeadMs ?? DEFAULT_MINIMUM_LEAD_MS;
  const maxLead = input.maxLeadMs ?? MAX_REVIEW_LEAD_MS;
  const p95 = input.measuredP95ProcessingMs;
  const lag = input.queueLagP95Ms;
  if (
    !checkDuration(margin, false) ||
    !checkDuration(minimum, true) ||
    !checkDuration(maxLead, true) ||
    minimum > maxLead ||
    (p95 !== null && !checkDuration(p95, false)) ||
    (lag !== null && !checkDuration(lag, false))
  ) {
    return err(
      'INVALID_DURATION',
      'Durations must be non-negative integer milliseconds; 0 < minimum lead <= maximum lead',
    );
  }
  const measured = (p95 ?? 0) + (lag ?? 0) + margin;
  const measuredWins = (p95 !== null || lag !== null) && measured > minimum;
  const requiredLeadMs = Math.max(minimum, measured);
  const plannedLead = Math.min(requiredLeadMs, maxLead);
  const release = input.releaseAt.getTime();
  const idealStart = release - plannedLead;
  const start = input.now !== undefined ? Math.max(idealStart, input.now.getTime()) : idealStart;
  const leadMs = release - start;
  return ok({
    jobStartAt: new Date(start),
    evidenceCutoffAt: new Date(start),
    leadMs,
    requiredLeadMs,
    basis: measuredWins ? 'measured' : 'default_minimum',
    latenessRisk: leadMs < requiredLeadMs,
  });
}

export type ReviewLatenessStatus = 'on_time' | 'late' | 'pending' | 'overdue';

/** E4 lateness monitoring: compares readiness with the release target. */
export function assessReviewLateness(input: {
  readonly releaseAt: Date;
  readonly readyAt: Date | null;
  readonly now: Date;
}): { readonly status: ReviewLatenessStatus; readonly latenessMs: number } {
  if (!isValidInstant(input.releaseAt) || !isValidInstant(input.now)) {
    throw new RangeError('Invalid instant');
  }
  const release = input.releaseAt.getTime();
  if (input.readyAt !== null) {
    if (!isValidInstant(input.readyAt)) throw new RangeError('Invalid readyAt');
    const lateness = input.readyAt.getTime() - release;
    return lateness > 0
      ? { status: 'late', latenessMs: lateness }
      : { status: 'on_time', latenessMs: 0 };
  }
  const overdue = input.now.getTime() - release;
  return overdue >= 0
    ? { status: 'overdue', latenessMs: overdue }
    : { status: 'pending', latenessMs: 0 };
}

export type ReviewVersionStatus = 'ready' | 'in_progress' | 'completed';

export interface ExistingReviewVersion {
  readonly version: number;
  readonly status: ReviewVersionStatus;
}

/**
 * Decision: at most four versions (base + three top-ups) per child/subject/week by default, a
 * per-period cost control (spec E4); a parent can still review evidence on the dashboard.
 */
export const DEFAULT_MAX_REVIEW_VERSIONS = 4;

export type TopUpDecision =
  | {
      readonly create: false;
      readonly reason:
        'no_base_review' | 'no_late_evidence' | 'pending_top_up_exists' | 'top_up_limit_reached';
    }
  | { readonly create: true; readonly version: number; readonly optional: true };

/**
 * AC_LEARNING_09: late scans may produce an optional top-up as a NEW version (max + 1). Existing
 * versions (ready, in progress or completed) are never overwritten or regenerated, so completed
 * work and its rewards stay untouched. `lateEvidenceCount` counts evidence after the latest
 * version's cutoff. Decision: at most one unstarted ('ready') top-up exists at a time, so repeated
 * late scans do not stack optional sets on the child; version 1 is the base review, not a top-up.
 */
export function planTopUp(input: {
  readonly existingVersions: readonly ExistingReviewVersion[];
  readonly lateEvidenceCount: number;
  readonly maxVersions?: number;
}): SchedulingResult<TopUpDecision> {
  const maxVersions = input.maxVersions ?? DEFAULT_MAX_REVIEW_VERSIONS;
  if (!isNonNegativeSafeInteger(input.lateEvidenceCount) || !isPositiveSafeInteger(maxVersions)) {
    return err('INVALID_COUNT', 'Counts must be non-negative integers; maxVersions >= 1');
  }
  const seen = new Set<number>();
  for (const v of input.existingVersions) {
    const statusOk = v.status === 'ready' || v.status === 'in_progress' || v.status === 'completed';
    if (!isPositiveSafeInteger(v.version) || seen.has(v.version) || !statusOk) {
      return err('INVALID_REVIEW_VERSIONS', 'Review versions must be unique positive integers');
    }
    seen.add(v.version);
  }
  if (input.existingVersions.length === 0) return ok({ create: false, reason: 'no_base_review' });
  if (input.lateEvidenceCount === 0) return ok({ create: false, reason: 'no_late_evidence' });
  if (input.existingVersions.some((v) => v.version > 1 && v.status === 'ready')) {
    return ok({ create: false, reason: 'pending_top_up_exists' });
  }
  const next = Math.max(...input.existingVersions.map((v) => v.version)) + 1;
  if (next > maxVersions) return ok({ create: false, reason: 'top_up_limit_reached' });
  return ok({ create: true, version: next, optional: true });
}
