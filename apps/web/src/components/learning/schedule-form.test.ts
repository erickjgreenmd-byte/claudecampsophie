import { describe, expect, it } from 'vitest';
import { updateLearningScheduleRequestSchema, type LearningSchedule } from '@pencillift/contracts';
import { scheduleToForm, validateScheduleForm, type ScheduleForm } from './schedule-form.ts';

const SCHEDULE: LearningSchedule = {
  reviewWeekday: 4,
  reviewLocalTime: '16:00',
  reviewQuestionsPerSubject: 8,
  dailyLocalTime: '15:30',
  dailyQuestionCount: 5,
  pause: null,
  quietHours: null,
  childRemindersPermitted: false,
  scheduleVersion: 3,
};

function form(overrides: Partial<ScheduleForm> = {}): ScheduleForm {
  return { ...scheduleToForm(SCHEDULE), ...overrides };
}

describe('schedule form validation (mirrors the PUT learning-schedule contract)', () => {
  it('round-trips the defaults into a strict request without the server-maintained version', () => {
    const result = validateScheduleForm(form());
    expect(result).toEqual({
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
    if (result.ok)
      expect(updateLearningScheduleRequestSchema.safeParse(result.value).success).toBe(true);
  });

  it.each([
    ['2', false],
    ['3', true],
    ['10', true],
    ['11', false],
    ['4.5', false],
    ['', false],
  ])('daily question count %s is valid: %s', (value, ok) => {
    const result = validateScheduleForm(form({ dailyQuestionCount: value }));
    expect(result.ok).toBe(ok);
    if (!result.ok) expect(result.errors.dailyQuestionCount).toMatch(/between 3 and 10/);
  });

  it.each([
    ['3', false],
    ['4', true],
    ['20', true],
    ['21', false],
  ])('review questions per subject %s is valid: %s', (value, ok) => {
    const result = validateScheduleForm(form({ reviewQuestionsPerSubject: value }));
    expect(result.ok).toBe(ok);
    if (!result.ok) expect(result.errors.reviewQuestionsPerSubject).toMatch(/between 4 and 20/);
  });

  it('accepts HH:mm and strips seconds a browser may add; rejects anything else', () => {
    const withSeconds = validateScheduleForm(form({ reviewLocalTime: '17:45:00' }));
    expect(withSeconds.ok && withSeconds.value.reviewLocalTime).toBe('17:45');
    for (const bad of ['24:00', '7:00', '', '16:60', '4pm']) {
      const result = validateScheduleForm(form({ dailyLocalTime: bad }));
      expect(result.ok, bad).toBe(false);
    }
  });

  it('a vacation pause needs both real dates and must not end before it starts', () => {
    expect(validateScheduleForm(form({ pauseEnabled: true })).ok).toBe(false);
    const backwards = validateScheduleForm(
      form({ pauseEnabled: true, pauseFrom: '2026-12-31', pauseTo: '2026-12-20' }),
    );
    expect(backwards.ok).toBe(false);
    if (!backwards.ok) expect(backwards.errors.pause).toMatch(/not end before it starts/);
    expect(
      validateScheduleForm(
        form({ pauseEnabled: true, pauseFrom: '2026-02-30', pauseTo: '2026-03-02' }),
      ).ok,
    ).toBe(false);
    const ok = validateScheduleForm(
      form({ pauseEnabled: true, pauseFrom: '2026-12-20', pauseTo: '2026-12-20' }),
    );
    expect(ok.ok && ok.value.pause).toEqual({ from: '2026-12-20', to: '2026-12-20' });
  });

  it('a disabled pause or quiet hours is sent as null even if dates were typed', () => {
    const result = validateScheduleForm(
      form({ pauseEnabled: false, pauseFrom: 'junk', quietEnabled: false, quietStart: 'x' }),
    );
    expect(result.ok && result.value.pause).toBeNull();
    expect(result.ok && result.value.quietHours).toBeNull();
  });

  it('quiet hours may cross midnight but need two different times', () => {
    const overnight = validateScheduleForm(
      form({ quietEnabled: true, quietStart: '20:00', quietEnd: '07:00' }),
    );
    expect(overnight.ok && overnight.value.quietHours).toEqual({ start: '20:00', end: '07:00' });
    expect(
      validateScheduleForm(form({ quietEnabled: true, quietStart: '20:00', quietEnd: '20:00' })).ok,
    ).toBe(false);
    expect(validateScheduleForm(form({ quietEnabled: true, quietStart: '20:00' })).ok).toBe(false);
  });

  it('keeps an existing pause and quiet hours when loading a schedule', () => {
    const loaded = scheduleToForm({
      ...SCHEDULE,
      pause: { from: '2026-12-21', to: '2027-01-02' },
      quietHours: { start: '20:00', end: '07:00' },
      childRemindersPermitted: true,
    });
    expect(loaded).toMatchObject({
      pauseEnabled: true,
      pauseFrom: '2026-12-21',
      pauseTo: '2027-01-02',
      quietEnabled: true,
      childRemindersPermitted: true,
    });
  });
});
