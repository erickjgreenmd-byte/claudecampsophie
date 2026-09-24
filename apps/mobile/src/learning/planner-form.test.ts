import { describe, expect, it } from 'vitest';
import {
  LEARNING_LIMITS,
  type LearningSchedule,
  type LearningScheduleResponse,
} from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import {
  buildUpcomingView,
  formatInZone,
  normalizeTimeInput,
  plannerError,
  scheduleToPlannerForm,
  stepCount,
  validatePlannerForm,
  type PlannerForm,
} from './planner-form.ts';

const SCHEDULE: LearningSchedule = {
  reviewWeekday: 4,
  reviewLocalTime: '16:00',
  reviewQuestionsPerSubject: 8,
  dailyLocalTime: '15:30',
  dailyQuestionCount: 5,
  pause: null,
  quietHours: null,
  childRemindersPermitted: false,
  scheduleVersion: 2,
};

function form(overrides: Partial<PlannerForm> = {}): PlannerForm {
  return { ...scheduleToPlannerForm(SCHEDULE), ...overrides };
}

describe('mobile planner form (mirrors PUT /v1/children/:id/learning-schedule)', () => {
  it('turns the loaded schedule back into the exact request (no version, no extra keys)', () => {
    expect(validatePlannerForm(form())).toEqual({
      ok: true,
      value: {
        reviewWeekday: 4,
        reviewLocalTime: '16:00',
        reviewQuestionsPerSubject: 8,
        dailyLocalTime: '15:30',
        dailyQuestionCount: 5,
        pause: null,
        quietHours: null,
        childRemindersPermitted: false,
      },
    });
  });

  it('accepts phone-keypad times and rejects impossible ones', () => {
    expect(normalizeTimeInput('4:05')).toBe('04:05');
    expect(normalizeTimeInput('1600')).toBe('16:00');
    expect(normalizeTimeInput(' 07:30 ')).toBe('07:30');
    for (const bad of ['24:00', '12:60', '4pm', '', '123'])
      expect(normalizeTimeInput(bad)).toBeNull();
    const result = validatePlannerForm(form({ reviewLocalTime: '5:15', dailyLocalTime: '0700' }));
    expect(result.ok && [result.value.reviewLocalTime, result.value.dailyLocalTime]).toEqual([
      '05:15',
      '07:00',
    ]);
    const bad = validatePlannerForm(form({ dailyLocalTime: '25:00' }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.dailyLocalTime).toMatch(/24-hour/);
  });

  it('steppers stay inside the contract limits (daily 3-10, review 4-20)', () => {
    const daily = LEARNING_LIMITS.dailyQuestionCount;
    expect(stepCount(10, 1, daily)).toBe(10);
    expect(stepCount(3, -1, daily)).toBe(3);
    expect(stepCount(5, 1, daily)).toBe(6);
    const review = LEARNING_LIMITS.reviewQuestionsPerSubject;
    expect(stepCount(4, -1, review)).toBe(4);
    expect(stepCount(20, 1, review)).toBe(20);
    expect(validatePlannerForm(form({ dailyQuestionCount: 11 })).ok).toBe(false);
    expect(validatePlannerForm(form({ reviewQuestionsPerSubject: 3 })).ok).toBe(false);
  });

  it('validates the vacation pause and quiet hours like the web planner', () => {
    const backwards = validatePlannerForm(
      form({ pauseEnabled: true, pauseFrom: '2026-12-31', pauseTo: '2026-12-01' }),
    );
    expect(!backwards.ok && backwards.errors.pause).toMatch(/not end before it starts/);
    expect(
      validatePlannerForm(
        form({ pauseEnabled: true, pauseFrom: '2026-02-29', pauseTo: '2026-03-01' }),
      ).ok,
    ).toBe(false);
    const ok = validatePlannerForm(
      form({
        pauseEnabled: true,
        pauseFrom: '2026-12-21',
        pauseTo: '2027-01-02',
        quietEnabled: true,
        quietStart: '20:00',
        quietEnd: '7:00',
      }),
    );
    expect(ok.ok && ok.value.pause).toEqual({ from: '2026-12-21', to: '2027-01-02' });
    expect(ok.ok && ok.value.quietHours).toEqual({ start: '20:00', end: '07:00' });
    expect(
      validatePlannerForm(form({ quietEnabled: true, quietStart: '20:00', quietEnd: '20:00' })).ok,
    ).toBe(false);
  });

  it('shows releases in the family zone (DST-aware) and names the zone', () => {
    const data: LearningScheduleResponse = {
      schedule: SCHEDULE,
      timezone: 'America/Los_Angeles',
      nextReviewReleases: [
        {
          subjectKey: 'math',
          weekKey: '2026-W45',
          releaseAt: '2026-11-05T00:00:00.000Z',
          reason: 'default_schedule',
          testDate: null,
        },
        {
          subjectKey: 'science',
          weekKey: '2026-W45',
          releaseAt: null,
          reason: 'skipped_week',
          testDate: null,
        },
      ],
      dailyPractice: {
        localDate: '2026-11-04',
        state: 'paused',
        releaseAt: '2026-11-04T23:30:00.000Z',
      },
      pointsPolicy: { expireEarnedPoints: false, penalizeMissedDays: false },
    };
    const view = buildUpcomingView(data, 'Sam');
    expect(view.zoneLine).toBe('Times are in your family’s time zone: America/Los_Angeles.');
    expect(view.reviewLines[0]).toMatch(/^Math: Wed, Nov 4, 4:00\sPM PST \(review day\)$/);
    expect(view.reviewLines[1]).toBe('Science: not this week (no review this week)');
    expect(view.dailyLine).toBe('Daily practice is paused today.');
    expect(view.pointsLine).toMatch(/never removes points Sam already earned/);
    // Summer time in the same zone.
    expect(formatInZone('2026-07-02T23:00:00.000Z', 'America/Los_Angeles')).toMatch(/4:00\sPM PDT/);
    expect(formatInZone('2026-07-02T23:00:00.000Z', 'Not/AZone')).toBe('2026-07-02 23:00 UTC');
  });

  it('maps errors to parent copy and routes a missing PIN to the unlock screen', () => {
    expect(plannerError(new ApiRequestError('STEP_UP_REQUIRED', 'x', 403))).toEqual({
      message: 'Enter your parent PIN to continue.',
      needsPin: true,
    });
    expect(
      plannerError(new ApiRequestError('CONFLICT', 'That name is already used', 409)).message,
    ).toBe('That name is already used');
    expect(plannerError(new Error('boom')).needsPin).toBe(false);
  });
});
