import {
  LEARNING_LIMITS,
  dailyPracticeCopy,
  noWeeklyReviewsCopy,
  reviewReleaseReasonCopy,
  reviewReleaseWhen,
  subjectName,
  updateLearningScheduleRequestSchema,
  type ChildSubject,
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

export interface UpcomingView {
  readonly zoneLine: string;
  readonly dailyLine: string;
  readonly reviewLines: readonly string[];
  /**
   * Printed in place of `reviewLines` when there are none. The portal's four sentences, shared
   * (`noWeeklyReviewsCopy`): the cause where this screen can establish it, the instruction only where
   * the subject toggles above can be pressed, and the promise only for a profile that receives one.
   */
  readonly noReviewsLine: string;
  readonly pointsLine: string;
}

/**
 * The "Coming up" card's lines.
 *
 * BUG-411: every sentence here is `packages/contracts`' — `dailyPracticeCopy`, `noWeeklyReviewsCopy`,
 * `reviewReleaseReasonCopy`, `reviewReleaseWhen` and `subjectName` — and the portal's planner calls the
 * same five. This module holds NO copy of any of them and derives no status predicate of its own. It
 * used to hold four: a `receivesPractice` beside the portal's, a `DAILY_STATE` table byte-identical to
 * the portal's, a `RELEASE_REASON` table that was NOT (it mapped each reason to a plain string, so it
 * threw away the `testDate` the same contract carries and the portal prints), and an empty-review line
 * the portal's HUNT7-H-4 arms had outgrown. Two identical bodies are a coincidence with good odds
 * (L-066); a test that greps the other surface's source guards the words and not the meaning (L-070).
 *
 * `childStatus` and `subjects` are REQUIRED and both accept the "I do not know" value, so a caller must
 * say so rather than get the promising copy by omission: the shared functions then hedge every
 * forward-looking line and claim no cause (fail closed).
 */
export function buildUpcomingView(input: {
  readonly data: LearningScheduleResponse;
  readonly childName: string;
  /** The profile's status as GET /v1/family reports it; `undefined` fails closed. */
  readonly childStatus: string | undefined;
  /**
   * The child's subjects as the Subject toggles above the card render them, or `undefined` while that
   * second request is still in flight or has failed. Passing `[]` for "not loaded" would claim a cause
   * the screen cannot establish, which is why the unknown is its own value (L-071).
   */
  readonly subjects: readonly ChildSubject[] | undefined;
}): UpcomingView {
  const { data, childName, childStatus, subjects } = input;
  const zone = data.timezone;
  return {
    zoneLine: `Times are in your family’s time zone: ${zone}.`,
    dailyLine: dailyPracticeCopy({
      dailyPractice: data.dailyPractice,
      zone,
      childName,
      childStatus,
    }),
    noReviewsLine: noWeeklyReviewsCopy({ childName, childStatus, subjects }),
    reviewLines: data.nextReviewReleases.map(
      (r) =>
        `${subjectName(r.subjectKey, subjects ?? [])}: ${reviewReleaseWhen(r, zone)} (${reviewReleaseReasonCopy(r)})`,
    ),
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
