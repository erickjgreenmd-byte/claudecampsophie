import {
  LEARNING_LIMITS,
  SUBJECT_DISPLAY_NAMES,
  updateLearningScheduleRequestSchema,
  type LearningSchedule,
  type LearningScheduleResponse,
  type UpdateLearningScheduleRequest,
} from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';

/**
 * Parent planner essentials on the phone (spec P7, P8): review day/time, questions per subject,
 * daily time and count, a vacation pause and quiet hours, all in the family's IANA zone. Pure and
 * unit-tested; the final check is the API's own strict request schema.
 */

export const WEEKDAY_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
  { value: '7', label: 'Sunday' },
];

export interface PlannerForm {
  reviewWeekday: string;
  reviewLocalTime: string;
  reviewQuestionsPerSubject: number;
  dailyLocalTime: string;
  dailyQuestionCount: number;
  pauseEnabled: boolean;
  pauseFrom: string;
  pauseTo: string;
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  childRemindersPermitted: boolean;
}

export type PlannerField =
  | 'reviewWeekday'
  | 'reviewLocalTime'
  | 'reviewQuestionsPerSubject'
  | 'dailyLocalTime'
  | 'dailyQuestionCount'
  | 'pause'
  | 'quietHours';

export type PlannerValidation =
  | { ok: true; value: UpdateLearningScheduleRequest }
  | { ok: false; errors: Partial<Record<PlannerField, string>> };

export function scheduleToPlannerForm(schedule: LearningSchedule): PlannerForm {
  return {
    reviewWeekday: String(schedule.reviewWeekday),
    reviewLocalTime: schedule.reviewLocalTime,
    reviewQuestionsPerSubject: schedule.reviewQuestionsPerSubject,
    dailyLocalTime: schedule.dailyLocalTime,
    dailyQuestionCount: schedule.dailyQuestionCount,
    pauseEnabled: schedule.pause !== null,
    pauseFrom: schedule.pause?.from ?? '',
    pauseTo: schedule.pause?.to ?? '',
    quietEnabled: schedule.quietHours !== null,
    quietStart: schedule.quietHours?.start ?? '',
    quietEnd: schedule.quietHours?.end ?? '',
    childRemindersPermitted: schedule.childRemindersPermitted,
  };
}

/**
 * Accepts what people type on a phone keypad: "16:00", "4:05" (padded to "04:05") and "1600".
 * Returns null when it is not a 24-hour time.
 */
export function normalizeTimeInput(value: string): string | null {
  // "123" is ambiguous, so without a colon exactly four digits are needed.
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim()) ?? /^(\d{2})(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** A stepper value kept inside the contract's limits. */
export function stepCount(
  value: number,
  delta: number,
  limits: { readonly min: number; readonly max: number },
): number {
  return Math.min(limits.max, Math.max(limits.min, Math.round(value) + delta));
}

export function validatePlannerForm(form: PlannerForm): PlannerValidation {
  const errors: Partial<Record<PlannerField, string>> = {};
  const { reviewQuestionsPerSubject: reviewLimits, dailyQuestionCount: dailyLimits } =
    LEARNING_LIMITS;
  const weekday = Number(form.reviewWeekday);
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
    errors.reviewWeekday = 'Choose a review day.';
  }
  const reviewTime = normalizeTimeInput(form.reviewLocalTime);
  if (reviewTime === null) errors.reviewLocalTime = 'Use 24-hour time, like 16:00.';
  const dailyTime = normalizeTimeInput(form.dailyLocalTime);
  if (dailyTime === null) errors.dailyLocalTime = 'Use 24-hour time, like 15:30.';
  if (
    !Number.isInteger(form.reviewQuestionsPerSubject) ||
    form.reviewQuestionsPerSubject < reviewLimits.min ||
    form.reviewQuestionsPerSubject > reviewLimits.max
  ) {
    errors.reviewQuestionsPerSubject = `Choose ${reviewLimits.min} to ${reviewLimits.max} questions.`;
  }
  if (
    !Number.isInteger(form.dailyQuestionCount) ||
    form.dailyQuestionCount < dailyLimits.min ||
    form.dailyQuestionCount > dailyLimits.max
  ) {
    errors.dailyQuestionCount = `Choose ${dailyLimits.min} to ${dailyLimits.max} questions.`;
  }
  let pause: UpdateLearningScheduleRequest['pause'] = null;
  if (form.pauseEnabled) {
    const from = form.pauseFrom.trim();
    const to = form.pauseTo.trim();
    if (!isRealDate(from) || !isRealDate(to)) {
      errors.pause = 'Enter both dates as YYYY-MM-DD.';
    } else if (from > to) {
      errors.pause = 'The pause must not end before it starts.';
    } else {
      pause = { from, to };
    }
  }
  let quietHours: UpdateLearningScheduleRequest['quietHours'] = null;
  if (form.quietEnabled) {
    const start = normalizeTimeInput(form.quietStart);
    const end = normalizeTimeInput(form.quietEnd);
    if (start === null || end === null) {
      errors.quietHours = 'Enter both times in 24-hour time, like 20:00.';
    } else if (start === end) {
      errors.quietHours = 'Quiet hours need different start and end times.';
    } else {
      quietHours = { start, end };
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const parsed = updateLearningScheduleRequestSchema.safeParse({
    reviewWeekday: weekday,
    reviewLocalTime: reviewTime,
    reviewQuestionsPerSubject: form.reviewQuestionsPerSubject,
    dailyLocalTime: dailyTime,
    dailyQuestionCount: form.dailyQuestionCount,
    pause,
    quietHours,
    childRemindersPermitted: form.childRemindersPermitted,
  });
  if (!parsed.success) return { ok: false, errors: { reviewWeekday: 'Check the schedule.' } };
  return { ok: true, value: parsed.data };
}

/** An instant in the family zone, e.g. "Thu, Sep 24, 4:00 PM EDT" (falls back if Intl lacks zones). */
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
    return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }
}

export interface UpcomingView {
  readonly zoneLine: string;
  readonly dailyLine: string;
  readonly reviewLines: readonly string[];
  /** Printed in place of `reviewLines` when there are none; hedged for the same reason as `dailyLine`. */
  readonly noReviewsLine: string;
  readonly pointsLine: string;
}

/**
 * Whether PencilLift prepares practice and weekly reviews for a profile in this state — the ONE
 * definition of that question on the phone, mirroring the portal's `receivesPractice`
 * (apps/web/src/components/learning/format.ts) sentence for sentence. It is here, beside the copy it
 * decides, because the alternative was each card in app/(parent)/planner.tsx comparing the status itself,
 * which is how the portal's cards came to contradict each other four rounds running (L-068).
 *
 * It is `active`, and these statements in the product decide it, none of them about whether the parent may
 * EDIT anything:
 *   * `loadChildContext` (apps/api/src/jobs/learning-jobs.ts) returns null unless the child is active, for
 *     every caller except the planner preview in routes/learning.ts, which passes `requireActive: false`;
 *   * the nightly sweep selects `where c.status = 'active'`;
 *   * the practice-set insert re-checks `status = 'active'` under FOR SHARE;
 *   * `app.current_child_id()` refuses a non-active child's own device
 *     (supabase/migrations/0001_core_identity.sql).
 *
 * The nearby question this is NOT: `childPlanEditable` (src/family/family-view.ts), which is
 * `status !== 'archived'` because `ownedChild(c, 'write')` keeps a DRAFT plan writable on purpose. The two
 * facts agree for 'archived' today and disagree for every draft: that profile can be planned and receives
 * nothing. A card that PROMISES practice answers to this predicate; a control that can be pressed answers
 * to `childPlanEditable`.
 */
export function receivesPractice(childStatus: string | undefined): boolean {
  return childStatus === 'active';
}

/**
 * The two sentences a daily-practice state has, in the portal's words (`DAILY_STATE` in
 * apps/web/src/components/learning/format.ts). A hypothetical PER STATE, not one string per state, is the
 * shape of the fix (HUNT7-H-1): the phone printed 'Today’s daily practice is available.' for an archived
 * or draft child, and only the `not_yet_released` sentence carried a time, so the archived notice's "the
 * times below" framing could not reach the rest — and a draft child had no notice at all. The instant
 * stays wherever there is one; only the claim hedges. 'vacation' had no sentence of its own here at all
 * and fell through to the plain paused line, which the portal has always distinguished.
 */
interface DailyStateCopy {
  readonly prepared: (releaseAt: string, zone: string) => string;
  readonly hypothetical: (releaseAt: string, zone: string, childName: string) => string;
}

const DAILY_STATE: Record<LearningScheduleResponse['dailyPractice']['state'], DailyStateCopy> = {
  available: {
    prepared: () => 'Today’s daily practice is available.',
    hypothetical: (_releaseAt, _zone, childName) =>
      `Today’s daily practice would be available if ${childName}’s profile were active.`,
  },
  not_yet_released: {
    prepared: (releaseAt, zone) => `Today’s daily practice opens ${formatInZone(releaseAt, zone)}.`,
    hypothetical: (releaseAt, zone, childName) =>
      `Today’s daily practice would open at ${formatInZone(releaseAt, zone)} if ${childName}’s profile were active.`,
  },
  paused: {
    prepared: () => 'Daily practice is paused today.',
    hypothetical: (_releaseAt, _zone, childName) =>
      `Daily practice would be paused today even if ${childName}’s profile were active.`,
  },
  vacation: {
    prepared: () => 'Daily practice is paused today (vacation).',
    hypothetical: (_releaseAt, _zone, childName) =>
      `Daily practice would be paused today (vacation) even if ${childName}’s profile were active.`,
  },
};

const RELEASE_REASON: Record<
  LearningScheduleResponse['nextReviewReleases'][number]['reason'],
  string
> = {
  default_schedule: 'review day',
  test_date_eve: 'before a test',
  skipped_week: 'no review this week',
};

/**
 * The "Coming up" card's lines. `childStatus` is required, and undefined is a legal value for it, so a
 * caller that has no status must say so rather than get the promising copy by omission: every
 * forward-looking line here then hedges (fail closed, as the portal's sections do).
 */
export function buildUpcomingView(
  data: LearningScheduleResponse,
  childName: string,
  childStatus: string | undefined,
): UpcomingView {
  const zone = data.timezone;
  const daily = data.dailyPractice;
  const prepared = receivesPractice(childStatus);
  const copy = DAILY_STATE[daily.state];
  const dailyLine = prepared
    ? copy.prepared(daily.releaseAt, zone)
    : copy.hypothetical(daily.releaseAt, zone, childName);
  return {
    zoneLine: `Times are in your family’s time zone: ${zone}.`,
    dailyLine,
    noReviewsLine: prepared
      ? 'No weekly reviews are scheduled yet.'
      : `No weekly reviews are scheduled. A review is prepared once ${childName}’s profile is active.`,
    reviewLines: data.nextReviewReleases.map((r) => {
      const name = SUBJECT_DISPLAY_NAMES[r.subjectKey];
      const when = r.releaseAt ? formatInZone(r.releaseAt, zone) : 'not this week';
      return `${name}: ${when} (${RELEASE_REASON[r.reason]})`;
    }),
    pointsLine: `Pausing or missing a day never removes points ${childName} already earned.`,
  };
}

/** Parent-facing error text; `needsPin` routes to the PIN unlock screen. */
export function plannerError(error: unknown): { message: string; needsPin: boolean } {
  if (!(error instanceof ApiRequestError)) {
    return { message: 'Something went wrong. Please try again.', needsPin: false };
  }
  if (error.code === 'STEP_UP_REQUIRED') {
    return { message: 'Enter your parent PIN to continue.', needsPin: true };
  }
  if (error.code === 'NETWORK') {
    return {
      message: 'You appear to be offline. Check your connection and try again.',
      needsPin: false,
    };
  }
  if (error.code === 'NOT_FOUND') {
    // "Pull to refresh." named a gesture this message's only screen does not have (HUNT7-J-2):
    // app/(parent)/planner.tsx renders inside <Screen>, whose ScrollView carries no RefreshControl.
    // Its ErrorBoxes pass `onRetry`, so "Try again" is the control the parent can actually see.
    return { message: 'That child or subject was not found. Try again.', needsPin: false };
  }
  // Validation and conflict messages are written for adults and safe to show.
  if (error.code === 'VALIDATION_FAILED' || error.code === 'CONFLICT') {
    return { message: error.message, needsPin: false };
  }
  return { message: 'Something went wrong. Please try again.', needsPin: false };
}
