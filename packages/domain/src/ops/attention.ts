/**
 * Attention rules for the owner's overview: what the company must look at now. Each rule names
 * its window as a constant so the API query and the UI note read the same number. `now` is an
 * input; ages are whole hours, rounded down.
 */

/** Jobs that ended failed_final or dead_letter within this many days are listed. */
export const FAILED_JOBS_WINDOW_DAYS = 7;
/** Spec P4 target: a deletion completes within 30 days of the request. */
export const DELETION_TARGET_DAYS = 30;
/** A deletion still not completed this many days after the request is flagged before the target. */
export const DELETION_OVERDUE_AFTER_DAYS = 25;

export const OPEN_CASE_STATUSES = ['open', 'in_progress', 'waiting_on_parent'] as const;
export const OPEN_SAFETY_REPORT_STATUSES = ['open', 'escalated'] as const;
export const FAILED_JOB_STATUSES = ['failed_final', 'dead_letter'] as const;

export const ATTENTION_KINDS = [
  'jobs_failed',
  'billing_events_failed',
  'safety_reports_open',
  'deletions_overdue',
  'support_cases_open',
  'readiness_blocked',
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function assertInstant(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError(`${label} must be a valid Date`);
  }
}

/** Jobs whose last change is at or after this instant fall inside the failed-jobs window. */
export function failedJobsWindowStart(now: Date): Date {
  assertInstant(now, 'now');
  return new Date(now.getTime() - FAILED_JOBS_WINDOW_DAYS * DAY_MS);
}

/** A deletion requested at or before this instant and not completed is overdue for attention. */
export function deletionOverdueBefore(now: Date): Date {
  assertInstant(now, 'now');
  return new Date(now.getTime() - DELETION_OVERDUE_AFTER_DAYS * DAY_MS);
}

/** Whole hours from `since` to `now`, never negative (a future instant reads as 0). */
export function ageHours(since: Date, now: Date): number {
  assertInstant(since, 'since');
  assertInstant(now, 'now');
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / HOUR_MS));
}

export interface AttentionItem {
  readonly kind: AttentionKind;
  /** A sub-key within the kind (a support case kind, a readiness check); null for the whole rule. */
  readonly key: string | null;
  readonly count: number;
  /** The oldest item's instant; null for an empty rule or a rule without timestamps (readiness). */
  readonly oldestAt: Date | null;
  readonly oldestAgeHours: number | null;
}

/** One attention line; zero counts are kept so the UI can show an honest "none" per rule. */
export function attentionItem(
  kind: AttentionKind,
  count: number,
  oldestAt: Date | null,
  now: Date,
  key: string | null = null,
): AttentionItem {
  if (!Number.isInteger(count) || count < 0) throw new RangeError('count must be a count');
  if (count === 0 && oldestAt !== null) throw new RangeError('an empty rule has no oldest item');
  return {
    kind,
    key,
    count,
    oldestAt,
    oldestAgeHours: oldestAt === null ? null : ageHours(oldestAt, now),
  };
}

/** Items that need a person, oldest first; empty rules drop out. */
export function needsAttention(items: readonly AttentionItem[]): AttentionItem[] {
  return items
    .filter((item) => item.count > 0)
    .sort((a, b) => (b.oldestAgeHours ?? 0) - (a.oldestAgeHours ?? 0));
}
