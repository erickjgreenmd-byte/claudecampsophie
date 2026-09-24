import {
  LEARNING_LIMITS,
  updateLearningScheduleRequestSchema,
  type LearningSchedule,
  type UpdateLearningScheduleRequest,
} from '@pencillift/contracts';

/**
 * The learning-schedule form as the parent edits it (strings, as inputs hold them) and its
 * validation. The final check is the API's own request schema, so the client can never accept a
 * body the server would reject, and messages are friendly per field.
 */
export interface ScheduleForm {
  reviewWeekday: string;
  reviewLocalTime: string;
  reviewQuestionsPerSubject: string;
  dailyLocalTime: string;
  dailyQuestionCount: string;
  pauseEnabled: boolean;
  pauseFrom: string;
  pauseTo: string;
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  childRemindersPermitted: boolean;
}

export type ScheduleField =
  | 'reviewWeekday'
  | 'reviewLocalTime'
  | 'reviewQuestionsPerSubject'
  | 'dailyLocalTime'
  | 'dailyQuestionCount'
  | 'pause'
  | 'quietHours';

export type ScheduleErrors = Partial<Record<ScheduleField, string>>;

export type ScheduleValidation =
  { ok: true; value: UpdateLearningScheduleRequest } | { ok: false; errors: ScheduleErrors };

export function scheduleToForm(schedule: LearningSchedule): ScheduleForm {
  return {
    reviewWeekday: String(schedule.reviewWeekday),
    reviewLocalTime: schedule.reviewLocalTime,
    reviewQuestionsPerSubject: String(schedule.reviewQuestionsPerSubject),
    dailyLocalTime: schedule.dailyLocalTime,
    dailyQuestionCount: String(schedule.dailyQuestionCount),
    pauseEnabled: schedule.pause !== null,
    pauseFrom: schedule.pause?.from ?? '',
    pauseTo: schedule.pause?.to ?? '',
    quietEnabled: schedule.quietHours !== null,
    quietStart: schedule.quietHours?.start ?? '',
    quietEnd: schedule.quietHours?.end ?? '',
    childRemindersPermitted: schedule.childRemindersPermitted,
  };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Browsers may report "16:00:00" for a time input with seconds; the API wants "HH:mm". */
function normalizeTime(value: string): string {
  const trimmed = value.trim();
  const withSeconds = /^(\d{2}:\d{2}):\d{2}(\.\d+)?$/.exec(trimmed);
  return withSeconds?.[1] ?? trimmed;
}

function wholeNumber(value: string): number | null {
  const trimmed = value.trim();
  return /^\d{1,3}$/.test(trimmed) ? Number(trimmed) : null;
}

function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function validateScheduleForm(form: ScheduleForm): ScheduleValidation {
  const errors: ScheduleErrors = {};
  const { reviewQuestionsPerSubject: reviewLimits, dailyQuestionCount: dailyLimits } =
    LEARNING_LIMITS;

  const weekday = wholeNumber(form.reviewWeekday);
  if (weekday === null || weekday < 1 || weekday > 7) errors.reviewWeekday = 'Choose a review day.';

  const reviewTime = normalizeTime(form.reviewLocalTime);
  if (!TIME.test(reviewTime)) errors.reviewLocalTime = 'Enter a review time, like 4:00 PM.';

  const perSubject = wholeNumber(form.reviewQuestionsPerSubject);
  if (perSubject === null || perSubject < reviewLimits.min || perSubject > reviewLimits.max) {
    errors.reviewQuestionsPerSubject = `Choose between ${reviewLimits.min} and ${reviewLimits.max} questions per subject.`;
  }

  const dailyTime = normalizeTime(form.dailyLocalTime);
  if (!TIME.test(dailyTime)) errors.dailyLocalTime = 'Enter a daily practice time.';

  const dailyCount = wholeNumber(form.dailyQuestionCount);
  if (dailyCount === null || dailyCount < dailyLimits.min || dailyCount > dailyLimits.max) {
    errors.dailyQuestionCount = `Choose between ${dailyLimits.min} and ${dailyLimits.max} daily questions.`;
  }

  let pause: UpdateLearningScheduleRequest['pause'] = null;
  if (form.pauseEnabled) {
    const from = form.pauseFrom.trim();
    const to = form.pauseTo.trim();
    if (!isRealDate(from) || !isRealDate(to)) {
      errors.pause = 'Enter both the first and the last day of the pause.';
    } else if (from > to) {
      errors.pause = 'The pause must not end before it starts.';
    } else {
      pause = { from, to };
    }
  }

  let quietHours: UpdateLearningScheduleRequest['quietHours'] = null;
  if (form.quietEnabled) {
    const start = normalizeTime(form.quietStart);
    const end = normalizeTime(form.quietEnd);
    if (!TIME.test(start) || !TIME.test(end)) {
      errors.quietHours = 'Enter when quiet hours start and end.';
    } else if (start === end) {
      errors.quietHours = 'Quiet hours need different start and end times.';
    } else {
      quietHours = { start, end };
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const candidate = {
    reviewWeekday: weekday,
    reviewLocalTime: reviewTime,
    reviewQuestionsPerSubject: perSubject,
    dailyLocalTime: dailyTime,
    dailyQuestionCount: dailyCount,
    pause,
    quietHours,
    childRemindersPermitted: form.childRemindersPermitted,
  };
  // The server's own schema is the final word (strict: no extra keys can ride along).
  const parsed = updateLearningScheduleRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    const fallback: ScheduleErrors = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field === 'string' && field in FIELD_FALLBACK) {
        fallback[field as ScheduleField] = FIELD_FALLBACK[field as ScheduleField];
      }
    }
    return {
      ok: false,
      errors:
        Object.keys(fallback).length > 0 ? fallback : { reviewWeekday: 'Check the schedule.' },
    };
  }
  return { ok: true, value: parsed.data };
}

const FIELD_FALLBACK: Record<ScheduleField, string> = {
  reviewWeekday: 'Choose a review day.',
  reviewLocalTime: 'Enter a review time.',
  reviewQuestionsPerSubject: 'Check the number of review questions.',
  dailyLocalTime: 'Enter a daily practice time.',
  dailyQuestionCount: 'Check the number of daily questions.',
  pause: 'Check the pause dates.',
  quietHours: 'Check the quiet hours.',
};
