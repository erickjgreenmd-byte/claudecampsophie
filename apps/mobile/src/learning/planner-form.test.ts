import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHILD_PROFILE_STATUSES,
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
  receivesPractice,
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
    // The status is named, not omitted: HUNT7-H-1 made every forward-looking line depend on it, and this
    // case is about the ZONE arithmetic for a profile that really does receive practice.
    const view = buildUpcomingView(data, 'Sam', 'active');
    expect(view.zoneLine).toBe('Times are in your family’s time zone: America/Los_Angeles.');
    expect(view.reviewLines[0]).toMatch(/^Math: Wed, Nov 4, 4:00\sPM PST \(review day\)$/);
    expect(view.reviewLines[1]).toBe('Science: not this week (no review this week)');
    expect(view.dailyLine).toBe('Daily practice is paused today.');
    expect(view.pointsLine).toMatch(/never removes points Sam already earned/);
    // Summer time in the same zone.
    expect(formatInZone('2026-07-02T23:00:00.000Z', 'America/Los_Angeles')).toMatch(/4:00\sPM PDT/);
    expect(formatInZone('2026-07-02T23:00:00.000Z', 'Not/AZone')).toBe('2026-07-02 23:00 UTC');
  });

  it('[repro] a NOT_FOUND offers the retry the planner has, not a gesture it does not (HUNT7-J-2)', () => {
    // The only importer of `plannerError` is app/(parent)/planner.tsx, which renders inside <Screen>
    // (src/family/ui.tsx): its ScrollView has no RefreshControl, so "Pull to refresh." named the one
    // recovery that screen cannot offer. Its ErrorBoxes pass `onRetry`, which renders "Try again".
    const notFound = plannerError(new ApiRequestError('NOT_FOUND', 'No such child', 404));
    expect(notFound.needsPin).toBe(false);
    expect(notFound.message).not.toMatch(/pull to refresh/i);
    expect(notFound.message).toMatch(/try again/i);
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

/**
 * HUNT7-H-1, the phone half — one agent owning both surfaces, because the daily sentence diverged in the
 * first place by being fixed on one of them. `buildUpcomingView` built the line from the state alone, and
 * only 'not_yet_released' carried an instant, so the archived notice's "the times below" framing could not
 * reach the other states: for an archived or draft child the card said "Today's daily practice is
 * available." while nothing can open a set for them — `app.current_child_id()` requires `c.status =
 * 'active'` (supabase/migrations/0001_core_identity.sql) and `loadChildContext`
 * (apps/api/src/jobs/learning-jobs.ts) prepares nothing for a non-active profile. A DRAFT child got no
 * notice at all on this screen, so the claim stood entirely unframed.
 *
 * The literal sentences are written out once here (L-067) and the hedged/plain choice is then derived from
 * `receivesPractice`, the phone's one definition of the question — the same words the portal prints, which
 * the parity case below reads out of the portal's own source.
 */
const DAILY_LINES = [
  {
    state: 'available' as const,
    prepared: 'Today’s daily practice is available.',
    hedged: 'Today’s daily practice would be available if Sam’s profile were active.',
  },
  {
    state: 'not_yet_released' as const,
    prepared: 'Today’s daily practice opens Wed, Nov 4, 3:30 PM PST.',
    hedged:
      'Today’s daily practice would open at Wed, Nov 4, 3:30 PM PST if Sam’s profile were active.',
  },
  {
    state: 'paused' as const,
    prepared: 'Daily practice is paused today.',
    hedged: 'Daily practice would be paused today even if Sam’s profile were active.',
  },
  {
    state: 'vacation' as const,
    prepared: 'Daily practice is paused today (vacation).',
    hedged: 'Daily practice would be paused today (vacation) even if Sam’s profile were active.',
  },
];

function scheduleResponse(state: (typeof DAILY_LINES)[number]['state']): LearningScheduleResponse {
  return {
    schedule: SCHEDULE,
    timezone: 'America/Los_Angeles',
    nextReviewReleases: [],
    dailyPractice: { localDate: '2026-11-04', state, releaseAt: '2026-11-04T23:30:00.000Z' },
    pointsPolicy: { expireEarnedPoints: false, penalizeMissedDays: false },
  };
}

describe('[HUNT7-H-1] the phone hedges the daily line for a profile that receives no practice', () => {
  it('decides the question in ONE place on this surface, and it is not "can the plan be edited"', () => {
    // `receivesPractice` is the phone's single definition; `childPlanEditable` (src/family/family-view.ts)
    // is the DIFFERENT question — a draft profile is editable on purpose and still receives nothing, so
    // the two facts agree today only for 'archived' (L-068).
    expect(receivesPractice('active')).toBe(true);
    for (const status of ['draft', 'archived', 'suspended', '', undefined])
      expect(receivesPractice(status), String(status)).toBe(false);
  });

  for (const { state, prepared, hedged } of DAILY_LINES) {
    it(`hedges the ${state} line for a non-active profile and keeps it plain for an active one`, () => {
      const data = scheduleResponse(state);
      expect(buildUpcomingView(data, 'Sam', 'active').dailyLine).toBe(prepared);
      for (const status of ['archived', 'draft', 'suspended', undefined])
        expect(buildUpcomingView(data, 'Sam', status).dailyLine, String(status)).toBe(hedged);
    });
  }

  it('keeps the release instant in the hedged line, as the portal does (HUNT5-F-10)', () => {
    const line = buildUpcomingView(
      scheduleResponse('not_yet_released'),
      'Sam',
      'archived',
    ).dailyLine;
    expect(line).toContain(formatInZone('2026-11-04T23:30:00.000Z', 'America/Los_Angeles'));
  });

  it('hedges the empty-review line too, so no line on the card promises what the status refuses', () => {
    const data = scheduleResponse('paused');
    expect(buildUpcomingView(data, 'Sam', 'active').noReviewsLine).toBe(
      'No weekly reviews are scheduled yet.',
    );
    expect(buildUpcomingView(data, 'Sam', 'archived').noReviewsLine).toBe(
      'No weekly reviews are scheduled. A review is prepared once Sam’s profile is active.',
    );
  });

  it('prints the SAME hedged words as the portal, which is the parity this stage exists for', () => {
    // No module can be shared across the two apps without a contracts export, which is the lead's to
    // wire; what can be pinned from here is that the portal's table carries a hypothetical per state and
    // that both surfaces hedge in the same words. The fragments are the ones the phone prints above.
    const web = readFileSync(
      join(
        import.meta.dirname,
        '..',
        '..',
        '..',
        'web',
        'src',
        'components',
        'learning',
        'format.ts',
      ),
      'utf8',
    );
    expect(web).toContain('hypothetical');
    for (const fragment of [
      'Today’s daily practice would be available if ',
      'Today’s daily practice would open at ',
      'Daily practice would be paused today even if ',
      'Daily practice would be paused today (vacation) even if ',
      '’s profile were active.',
    ])
      expect(web, fragment).toContain(fragment);
  });
});

/**
 * The screen half (the Expo screens import react-native, which this pure suite cannot render, so its
 * source is read — the same technique as src/family/screens.test.ts). Two properties: the card is told
 * whether practice is prepared, through the one predicate rather than its own comparison, and the DRAFT
 * profile finally gets the notice the portal has had since HUNT6-H-4 — without it, the hedged line was the
 * only thing on the screen saying that nothing is prepared for a child with no paid slot.
 */
describe('[HUNT7-H-1] the planner screen passes the predicate and frames a draft profile', () => {
  const planner = readFileSync(
    join(import.meta.dirname, '..', '..', 'app', '(parent)', 'planner.tsx'),
    'utf8',
  );

  it('hands the Coming up card the one predicate, and re-derives it nowhere', () => {
    expect(planner).toMatch(/receivesPractice\(child\.status\)/);
    expect(planner).toMatch(/<ComingUp data=\{schedule\.state\.data\} child=\{child\} \/>/);
    // The card is handed the child and asks the shared helper from inside `buildUpcomingView`; it owns no
    // comparison, and neither does the screen beyond the one `receivesPractice` call above.
    expect(planner).toMatch(/buildUpcomingView\(data, child\.nickname, child\.status\)/);
    expect(planner).not.toMatch(/child\.status === 'active'/);
    expect(planner).not.toMatch(/No weekly reviews are scheduled yet/);
  });

  it('pins the status list the draft notice’s REASON depends on', () => {
    // The notice is rendered for "editable and not prepared", which is 'draft' exactly while these are the
    // three statuses; a fourth would inherit a sentence about paid slots that may not be its reason. Adding
    // one has to fail here and be given its own copy (L-068: name the fact, do not let it drift).
    expect(CHILD_PROFILE_STATUSES).toEqual(['draft', 'active', 'archived']);
  });

  it('frames a profile with no paid slot, in the portal’s words, and keeps the archived notice', () => {
    // The draft notice says what is true of BOTH draft populations (HUNT6-H-4): a profile that never held
    // a slot and one that lost it to `releaseSlotlessProfiles` (apps/api/src/services/billing-sync.ts), so
    // no "yet" and no "again".
    expect(planner).toMatch(/doesn’t have a paid slot right now/);
    expect(planner).toMatch(/what the schedule would produce while they hold one/);
    expect(planner).not.toMatch(/doesn’t have a paid slot yet/);
    // The archived notice HUNT7-J-3 landed is untouched.
    expect(planner).toMatch(/no new practice is prepared or released/);
  });
});
