import {
  SUBJECT_DISPLAY_NAMES,
  SUPPORTED_SUBJECT_KEYS,
  type ChildSubject,
  type LearningScheduleResponse,
  type ParentPracticeSet,
} from '@pencillift/contracts';

/**
 * Copy and formatting for the learning planner (spec P7, P8, P10). Every status is text (never
 * colour alone); every time is shown in the family's IANA zone with the zone named.
 */

/** ISO weekday 1 (Monday) .. 7 (Sunday), matching the schedule contract. */
export const WEEKDAYS: readonly { value: number; label: string }[] = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 7, label: 'Sunday' },
];

export function weekdayLabel(value: number): string {
  return WEEKDAYS.find((d) => d.value === value)?.label ?? `Day ${value}`;
}

/** The subject's name for this child (custom names included), falling back to the standard name. */
export function subjectName(subjectKey: string | null, subjects: readonly ChildSubject[]): string {
  if (subjectKey === null) return 'Mixed subjects';
  const own = subjects.find((s) => s.subjectKey === subjectKey && s.subjectKey !== 'custom');
  if (own) return own.displayName;
  return (SUBJECT_DISPLAY_NAMES as Readonly<Record<string, string>>)[subjectKey] ?? subjectKey;
}

/** Display order: the six supported subjects, then anything else alphabetically. */
export function subjectOrder(a: string, b: string): number {
  const order = SUPPORTED_SUBJECT_KEYS as readonly string[];
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  if (ia !== ib) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Short zone name (e.g. "EDT") at `at`, or null if the zone is unknown to this browser. */
export function zoneAbbreviation(zone: string, at: Date = new Date()): string | null {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? null;
  } catch {
    return null;
  }
}

/** "America/New_York (EDT)" — the zone every schedule time is interpreted in. */
export function zoneLabel(zone: string, at: Date = new Date()): string {
  const short = zoneAbbreviation(zone, at);
  return short && short !== zone ? `${zone} (${short})` : zone;
}

/** An instant shown in the family zone, e.g. "Thu, Sep 24, 4:00 PM EDT". */
export function formatInZone(iso: string, zone: string): string {
  const date = new Date(iso);
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  };
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', options).format(date);
  }
}

/** A calendar date (YYYY-MM-DD) as "Fri, Oct 2, 2026" without any time-zone shift. */
export function formatCalendarDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const utc = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(utc);
}

export function percent(value: number | null): string {
  return value === null ? 'not measured yet' : `${Math.round(value * 100)}%`;
}

export const RELEASE_REASON: Record<
  LearningScheduleResponse['nextReviewReleases'][number]['reason'],
  (testDate: string | null) => string
> = {
  default_schedule: () => 'regular review day',
  test_date_eve: (testDate) =>
    testDate ? `moved before the test on ${formatCalendarDate(testDate)}` : 'moved before a test',
  skipped_week: () => 'no review this week',
};

export const DAILY_STATE: Record<
  LearningScheduleResponse['dailyPractice']['state'],
  (releaseAt: string, zone: string) => string
> = {
  available: () => 'Today’s daily practice is available.',
  not_yet_released: (releaseAt, zone) =>
    `Today’s daily practice opens ${formatInZone(releaseAt, zone)}.`,
  paused: () => 'Daily practice is paused today.',
  vacation: () => 'Daily practice is paused today (vacation).',
};

export const SET_KIND_LABEL: Record<ParentPracticeSet['kind'], string> = {
  daily: 'Daily practice',
  thursday_review: 'Weekly review',
  top_up: 'Extra practice (optional)',
};

export const SET_STATUS_LABEL: Record<ParentPracticeSet['status'], string> = {
  generating: 'Being prepared',
  ready: 'Ready',
  in_progress: 'In progress',
  completed: 'Completed',
  expired: 'Expired',
  failed: 'Could not be prepared',
};

export const ITEM_STATUS_LABEL: Record<
  ParentPracticeSet['items'][number]['progress']['status'],
  string
> = {
  not_started: 'Not started',
  correct: '✓ Solved',
  try_again: '↻ Still trying',
  help_offered: '? Help offered after three tries',
};

const MIX_LABELS: Readonly<Record<string, string>> = {
  weak: 'from weaker skills',
  spaced: 'spaced review',
  confidence: 'confidence builders',
  diagnostic: 'grade-level starters',
  weakness: 'from this week’s weaker skills',
  cumulative: 'cumulative review',
};

/** "5 from weaker skills, 2 spaced review" (the requested length is not part of the mix). */
export function mixSummary(mix: Readonly<Record<string, number>>): string | null {
  const parts = Object.entries(mix)
    .filter(([key, count]) => key !== 'requested' && count > 0)
    .map(([key, count]) => `${count} ${MIX_LABELS[key] ?? key.replace(/_/g, ' ')}`);
  return parts.length > 0 ? parts.join(', ') : null;
}

export function choiceLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

export function questionsLabel(count: number): string {
  return `${count} ${count === 1 ? 'question' : 'questions'}`;
}
