import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHILD_PROFILE_STATUSES,
  DAILY_PRACTICE_COPY,
  LEARNING_LIMITS,
  REVIEW_RELEASE_REASON_COPY,
  dailyPracticeStatusSchema,
  formatInZone,
  receivesPractice,
  reviewReleaseSchema,
  type ChildSubject,
  type LearningSchedule,
  type LearningScheduleResponse,
} from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import {
  buildUpcomingView,
  normalizeTimeInput,
  plannerError,
  scheduleToPlannerForm,
  stepCount,
  validatePlannerForm,
  type PlannerForm,
} from './planner-form.ts';

/** Synthetic subjects, as GET /v1/children/:id/subjects reports them. */
const MATH: ChildSubject = {
  id: '11111111-1111-4111-8111-111111111111',
  subjectKey: 'math',
  displayName: 'Mathematics',
  enabled: true,
  generatedPractice: true,
};
const BAND: ChildSubject = {
  id: '22222222-2222-4222-8222-222222222222',
  subjectKey: 'custom',
  displayName: 'Band',
  enabled: true,
  generatedPractice: false,
};

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
    // The status and the subjects are named, not omitted: HUNT7-H-1 made every forward-looking line
    // depend on the status, BUG-411 made the empty-review line depend on the subjects, and this case is
    // about the ZONE arithmetic for a profile that really does receive practice.
    const view = buildUpcomingView({
      data,
      childName: 'Sam',
      childStatus: 'active',
      subjects: [MATH],
    });
    expect(view.zoneLine).toBe('Times are in your family’s time zone: America/Los_Angeles.');
    // BUG-411: 'regular review day' is the PORTAL's word, and the phone said 'review day'. The subject
    // name is the parent's own, for the same reason: the phone printed SUBJECT_DISPLAY_NAMES' 'Math'
    // where the portal printed the child's 'Mathematics'.
    expect(view.reviewLines[0]).toMatch(
      /^Mathematics: Wed, Nov 4, 4:00\sPM PST \(regular review day\)$/,
    );
    expect(view.reviewLines[1]).toBe('Science: not this week (no review this week)');
    expect(view.dailyLine).toBe('Daily practice is paused today.');
    expect(view.pointsLine).toMatch(/never removes points Sam already earned/);
    // Summer time in the same zone.
    expect(formatInZone('2026-07-02T23:00:00.000Z', 'America/Los_Angeles')).toMatch(/4:00\sPM PDT/);
    // A zone this runtime cannot resolve names UTC rather than silently reformatting in the DEVICE's
    // zone, which is what the portal's copy of this function did (BUG-411).
    expect(formatInZone('2026-07-02T23:00:00.000Z', 'Not/AZone')).toBe('2026-07-02 23:00 UTC');
  });

  /**
   * BUG-411, divergence (1). `reviewReleaseSchema` carries `testDate` BESIDE `reason`, and the portal
   * printed it — "moved before the test on Thu, Oct 1, 2026" — while the phone's table was keyed to a
   * plain string, so `RELEASE_REASON[r.reason]` dropped the date and said only "before a test". The
   * shared function takes the RELEASE, so there is no argument left to drop.
   */
  it('[repro] the phone prints the test date the release carries, as the portal does', () => {
    const data: LearningScheduleResponse = {
      schedule: SCHEDULE,
      timezone: 'America/Los_Angeles',
      nextReviewReleases: [
        {
          subjectKey: 'math',
          weekKey: '2026-W40',
          releaseAt: '2026-09-30T23:00:00.000Z',
          reason: 'test_date_eve',
          testDate: '2026-10-01',
        },
      ],
      dailyPractice: {
        localDate: '2026-09-30',
        state: 'paused',
        releaseAt: '2026-09-30T22:30:00.000Z',
      },
      pointsPolicy: { expireEarnedPoints: false, penalizeMissedDays: false },
    };
    const line = buildUpcomingView({
      data,
      childName: 'Sam',
      childStatus: 'active',
      subjects: [MATH],
    }).reviewLines[0] as string;
    expect(line).toContain('moved before the test on Thu, Oct 1, 2026');
    expect(line).not.toBe('Mathematics: not this week (before a test)');
    expect(line).not.toMatch(/\(before a test\)/);
  });

  /**
   * The fall-through halves of the two shared tables (L-057). Neither can gain a case that silently
   * inherits a sentence written for another: the Records are keyed on the schema's own enums, so a fifth
   * daily state or a fourth release reason is a compile error at the table, and these assert the key SET
   * rather than the names in any one brief.
   */
  it('pins the two shared copy tables to the schema enums they answer for', () => {
    const states = dailyPracticeStatusSchema.shape.state.options;
    expect(Object.keys(DAILY_PRACTICE_COPY).sort()).toEqual([...states].sort());
    const reasons = reviewReleaseSchema.shape.reason.options;
    expect(Object.keys(REVIEW_RELEASE_REASON_COPY).sort()).toEqual([...reasons].sort());
    // Every state has BOTH variants, which is the shape HUNT7-H-1 settled: a state with no hypothetical
    // is a state that can make an unconditional present-tense claim again.
    for (const state of states) {
      expect(typeof DAILY_PRACTICE_COPY[state].prepared, state).toBe('function');
      expect(typeof DAILY_PRACTICE_COPY[state].hypothetical, state).toBe('function');
    }
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
      expect(
        buildUpcomingView({
          data,
          childName: 'Sam',
          childStatus: 'active',
          subjects: [MATH],
        }).dailyLine,
      ).toBe(prepared);
      for (const status of ['archived', 'draft', 'suspended', undefined])
        expect(
          buildUpcomingView({ data, childName: 'Sam', childStatus: status, subjects: [MATH] })
            .dailyLine,
          String(status),
        ).toBe(hedged);
    });
  }

  it('keeps the release instant in the hedged line, as the portal does (HUNT5-F-10)', () => {
    const line = buildUpcomingView({
      data: scheduleResponse('not_yet_released'),
      childName: 'Sam',
      childStatus: 'archived',
      subjects: [MATH],
    }).dailyLine;
    expect(line).toContain(formatInZone('2026-11-04T23:30:00.000Z', 'America/Los_Angeles'));
  });

  /**
   * BUG-411, divergence (2). HUNT7-H-1 agreed the DAILY line across the surfaces and stopped, leaving
   * this weekly half behind: the phone had TWO sentences against the portal's four, said
   * "No weekly reviews are scheduled." where the portal said "…scheduled yet.", named no subject, and
   * had no archived arm at all. All four are `noWeeklyReviewsCopy` now, and the phone gets every one.
   *
   * The cases run over a representative SET — a review-bearing subject on, only a custom subject on,
   * nothing on, subjects not loaded — crossed with the statuses, rather than the arms named in a brief.
   */
  const NO_REVIEWS = scheduleResponse('paused');
  const line = (childStatus: string | undefined, subjects: readonly ChildSubject[] | undefined) =>
    buildUpcomingView({ data: NO_REVIEWS, childName: 'Sam', childStatus, subjects }).noReviewsLine;

  it('claims no cause while a review-bearing subject is on, and still hedges the promise', () => {
    expect(line('active', [MATH])).toBe('No weekly review is scheduled for this week or next.');
    for (const status of ['draft', 'archived', 'suspended', undefined])
      expect(line(status, [MATH]), String(status)).toBe(
        'No weekly review is scheduled for this week or next. A review is prepared once Sam’s profile is active.',
      );
  });

  it('claims no cause while the subjects are NOT LOADED, whatever the status', () => {
    // The screen renders this card as soon as the SCHEDULE arrives; the subjects are a second request.
    // An empty array would have claimed "no subject that gets a weekly review is on", which is not
    // known yet, so `undefined` is its own value (L-071: the caller is where the defect lives).
    expect(line('active', undefined)).toBe('No weekly review is scheduled for this week or next.');
    expect(line('archived', undefined)).toBe(
      'No weekly review is scheduled for this week or next. A review is prepared once Sam’s profile is active.',
    );
  });

  it('names the cause and the parent’s real move for an ARCHIVED profile', () => {
    // The subject toggles are disabled for this one status, so "Turn on at least one subject" would
    // point at a dead control on this very screen — the two-parts-disagree defect the portal's arm was
    // written to remove, which the phone did not have.
    expect(line('archived', [BAND])).toBe(
      'No weekly reviews are scheduled: no subject that gets a weekly review is on, and subjects can’t be turned on or off while Sam’s profile is archived. Activate Sam again on the Children page, while a paid slot is free, to change that.',
    );
    expect(line('archived', [])).toContain('while Sam’s profile is archived');
  });

  it('keeps the instruction for a DRAFT profile, whose toggles work, and drops the promise', () => {
    // A custom-only child has subjects ON and no weekly review, which is why the cause is read from
    // `generatedPractice` and not from "is the list empty".
    for (const subjects of [[BAND], []] as const)
      expect(line('draft', subjects), JSON.stringify(subjects)).toBe(
        'No weekly reviews are scheduled yet. Turn on at least one subject that PencilLift makes practice for; a review is prepared once Sam’s profile is active.',
      );
    expect(line('draft', [BAND])).not.toMatch(/makes practice for to get a review/);
    expect(line('suspended', [BAND])).toBe(line('draft', [BAND]));
  });

  it('keeps the unconditional instruction for an ACTIVE profile, which really does get one', () => {
    expect(line('active', [BAND])).toBe(
      'No weekly reviews are scheduled yet. Turn on at least one subject that PencilLift makes practice for to get a review.',
    );
  });

  it('holds NO copy of the shared copy, and pins no other surface’s source text', () => {
    /*
     * This replaces the case that read apps/web/src/components/learning/format.ts and asserted the
     * portal's sentences were spelled the same. That was a SOURCE PIN: it guarded the words and not the
     * meaning (L-070), it left the portal free to widen the predicate behind them, and reverting one
     * portal sentence once left this whole suite green at 859/859. The coverage it carried — "both
     * surfaces print the same sentence" — is now carried by the sentences ABOVE being asserted against
     * the ONE definition in packages/contracts that the portal also calls, which is a guarantee rather
     * than an assertion about another file's text.
     *
     * What is left to check on this side is that the phone kept no copy, since a copy is how the
     * divergence started.
     */
    const src = readFileSync(join(import.meta.dirname, 'planner-form.ts'), 'utf8');
    for (const copy of [
      'Today’s daily practice',
      'Daily practice is paused',
      'profile were active',
      'No weekly review',
      'regular review day',
      'before a test',
      "=== 'active'",
    ])
      expect(src, copy).not.toContain(copy);
    // Nor may either table come back as a declaration (the prose above names them by design).
    expect(src).not.toMatch(/(const|let|var)\s+(DAILY_STATE|RELEASE_REASON)\b/);
    // ...and that it reaches the shared definitions by importing them.
    expect(src).toMatch(
      /import \{[\s\S]*?dailyPracticeCopy[\s\S]*?noWeeklyReviewsCopy[\s\S]*?reviewReleaseReasonCopy[\s\S]*?\} from '@pencillift\/contracts';/,
    );
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
    // BUG-411: the predicate is imported from the package the PORTAL imports it from, not from a copy
    // beside the copy it decides. A `from '../../src/learning/planner-form.ts'` import of it would mean
    // the phone had its own again.
    expect(planner).toMatch(
      /import \{[\s\S]*?receivesPractice,[\s\S]*?\} from '@pencillift\/contracts';/,
    );
    expect(planner).toMatch(
      /<ComingUp data=\{schedule\.state\.data\} child=\{child\} subjects=\{loadedSubjects\} \/>/,
    );
    // The card is handed the child and the subjects and asks the shared copy from inside
    // `buildUpcomingView`; it owns no comparison, and neither does the screen beyond the one
    // `receivesPractice` call above.
    expect(planner).toMatch(
      /buildUpcomingView\(\{\s*data,\s*childName: child\.nickname,\s*childStatus: child\.status,\s*subjects,\s*\}\)/,
    );
    expect(planner).not.toMatch(/child\.status === 'active'/);
    expect(planner).not.toMatch(/No weekly reviews are scheduled yet/);
    // The subjects reach it as the loaded ARRAY or as the unknown, never as `[]` standing in for both
    // (L-071: the caller is what would restore the defect — an empty array claims a cause).
    expect(planner).toMatch(
      /const loadedSubjects =\s*subjects\.state\.status === 'ready' \? subjects\.state\.data\.subjects : undefined;/,
    );
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
