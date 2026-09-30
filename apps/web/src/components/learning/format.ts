import { SUPPORTED_SUBJECT_KEYS, type ParentPracticeSet } from '@pencillift/contracts';

/**
 * Copy and formatting for the learning planner (spec P7, P8, P10). Every status is text (never
 * colour alone); every time is shown in the family's IANA zone with the zone named.
 *
 * WHAT IS NOT HERE ANY MORE (BUG-411). The decisions the parent portal and the phone app BOTH make —
 * `receivesPractice`, `dailyPracticeCopy`, `reviewReleaseReasonCopy`, `noWeeklyReviewsCopy`,
 * `subjectName`, `formatInZone`, `formatCalendarDate` — live in `packages/contracts` and are imported
 * by both surfaces. They were duplicated here and in apps/mobile/src/learning/planner-form.ts, with
 * the two copies tied together by tests that read each other's source text, and a source pin guards
 * the words and not the meaning (L-070).
 *
 * This file briefly RE-EXPORTED them so the two sections that already imported from here kept one
 * import site. That is gone too: a pointer is not a copy, but it is a second NAME for one thing, and
 * a second name is where a second definition starts — the next person needing a local tweak edits the
 * barrel rather than the package. SkillsSection and TestDatesSection now import from
 * `@pencillift/contracts` directly, and ArchivedChildSections.test.tsx asserts this file declares and
 * re-exports none of them. The names are listed above so a reader knows where to look, which is what
 * a comment is for.
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

export function percent(value: number | null): string {
  return value === null ? 'not measured yet' : `${Math.round(value * 100)}%`;
}

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
