import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  ChildSubject,
  ParentPracticeSet,
  learningScheduleResponseSchema,
  practiceSetsResponseSchema,
  testDatesResponseSchema,
} from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import { DAILY_STATE, formatInZone } from './format.ts';
import { PracticeSetsSection } from './PracticeSetsSection.tsx';
import { ScheduleSection } from './ScheduleSection.tsx';
import { StudyMaterialSection } from './StudyMaterialSection.tsx';
import { SubjectsSection } from './SubjectsSection.tsx';
import { TestDatesSection } from './TestDatesSection.tsx';

/**
 * HUNT5-F-10, as the lead settled it. Two designs were on the table for an archived child's planner
 * and only one ships:
 *
 * The planner's archived notice frames everything below it — "the times below are what the schedule
 * would produce if the profile were active again" — so the schedule's release times STAY. A
 * hypothetical instant under an explicit "if reactivated" heading is honest, and blanking it would
 * throw away the stored plan the parent came to read.
 *
 * HUNT7-H-2: this block used to add "ScheduleSection therefore has no status to branch on at all …
 * and is gone", which the tree has contradicted since round 6 and this file's own comments say twice
 * below. ScheduleSection does take the status, and the planner passes it — it governs the EDITOR and
 * the advice beside it, never the release times: `readOnly` disables the fields, drops "Save
 * schedule", early-returns from submit() and decides the empty-review sentence (HUNT7-H-4), while the
 * instants stay whatever the status is. The `@ts-expect-error -- ScheduleSection takes no childStatus
 * prop` that used to enforce the old sentence went with it.
 *
 * What is NOT honest is a per-set line that PROMISES something to the child: "Shown to your child
 * from <instant>" is a promise no archived profile can keep. `app.current_child_id()` requires
 * `c.status = 'active'` (migration 0001), so no request from the child's device can open any set,
 * whatever release instant it carries, and the API refuses every write with CHILD_ARCHIVED. So
 * PracticeSetsSection keeps a `childStatus` prop — wired from the planner — and uses it for exactly
 * that one sentence: the instant stays, the promise becomes the notice's conditional.
 *
 * What an ACTIVE child sees is unchanged and is asserted here too. A DRAFT child's is NOT: it keeps every write control, because `ownedChild(c, 'write')` admits a draft and its subjects, schedule and test dates are all meant to be editable while the parent waits for a paid slot — but it no longer gets the forward-looking promises, because no non-active profile receives a review (HUNT7-H-3, and `receivesPractice` in format.ts is the one place that decides it). HUNT7-H-2: not because
 * "a draft really is waiting for a paid slot" — HUNT6-H-4 established that premise as false and the
 * comment at the draft practice-set case below states it in full: `releaseSlotlessProfiles`
 * (apps/api/src/services/billing-sync.ts) puts a previously ACTIVE child back into 'draft' when an
 * expiry or a store-confirmed downgrade releases its slot, so a draft is either a profile that never
 * held a paid slot or one that lost one, and no copy here says "again" for it. What is asserted is that
 * a draft keeps every write control, because `ownedChild(c, 'write')` keeps a draft writable on purpose
 * (apps/api/src/routes/learning.ts), and that its schedule still describes what will happen while it
 * holds a slot.
 *
 * Synthetic data only (Riley).
 */

const CHILD = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const MATH_SUBJECT = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const ZONE = 'America/Chicago';
const REVIEW_AT = '2026-09-30T21:00:00.000Z';
const DAILY_AT = '2026-09-28T20:30:00.000Z';

const SUBJECTS: readonly ChildSubject[] = [
  {
    id: MATH_SUBJECT,
    subjectKey: 'math',
    displayName: 'Math',
    enabled: true,
    generatedPractice: true,
  },
];

const SCHEDULE: z.infer<typeof learningScheduleResponseSchema> = {
  schedule: {
    reviewWeekday: 4,
    reviewLocalTime: '16:00',
    reviewQuestionsPerSubject: 8,
    dailyLocalTime: '15:30',
    dailyQuestionCount: 5,
    pause: null,
    quietHours: null,
    childRemindersPermitted: false,
    scheduleVersion: 1,
  },
  timezone: ZONE,
  nextReviewReleases: [
    {
      subjectKey: 'math',
      weekKey: '2026-W40',
      releaseAt: REVIEW_AT,
      reason: 'default_schedule',
      testDate: null,
    },
  ],
  dailyPractice: { localDate: '2026-09-28', state: 'not_yet_released', releaseAt: DAILY_AT },
  pointsPolicy: { expireEarnedPoints: false, penalizeMissedDays: false },
};

const SET: ParentPracticeSet = {
  id: '33333333-3333-4333-8333-000000000001',
  kind: 'daily',
  status: 'ready',
  subjectKey: 'math',
  localDate: '2026-09-28',
  reviewWeek: null,
  version: 1,
  optional: false,
  readyAt: '2026-09-27T15:00:00.000Z',
  releaseAt: DAILY_AT,
  mix: {},
  notes: [],
  items: [],
};

const SETS: z.infer<typeof practiceSetsResponseSchema> = { sets: [SET], nextCursor: null };

function scheduleApi(over: Partial<typeof SCHEDULE> = {}): Partial<ApiClient> {
  return {
    get: <S extends z.ZodType>(_path: string, schema: S) =>
      Promise.resolve(schema.parse({ ...SCHEDULE, ...over })),
  };
}

function setsApi(): Partial<ApiClient> {
  return {
    get: <S extends z.ZodType>(_path: string, schema: S) => Promise.resolve(schema.parse(SETS)),
  };
}

/** The release instants as the page would print them, so presence is asserted on one string. */
const REVIEW_TEXT = formatInZone(REVIEW_AT, ZONE);
const DAILY_TEXT = formatInZone(DAILY_AT, ZONE);

afterEach(cleanup);

describe('[HUNT5-F-10] the schedule section keeps the release times whatever the status', () => {
  it('an archived child still sees the times the notice explains', async () => {
    renderPage(
      // HUNT6-H-1: the prop is back, and it is wired — but it governs the EDITOR, not the times. The
      // assertions below are what HUNT5-F-10 settled: an archived profile's saved schedule and its
      // next release instants stay on screen, under the planner notice that frames them.
      <ScheduleSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECTS}
        refreshKey={0}
        childStatus="archived"
      />,
      { api: scheduleApi() },
    );
    const coming = await screen.findByRole('region', { name: /coming up for riley/i });
    expect(coming.textContent).toContain(REVIEW_TEXT);
    expect(coming.textContent).toContain(DAILY_TEXT);
    // HUNT7-H-1: the INSTANT stays, which is what HUNT5-F-10 settled and what this case is for; the
    // sentence around it is now the hypothetical, because "Today's daily practice opens <time>." is a
    // present-tense claim about a profile the API prepares nothing for. The states that carry no instant
    // are covered in their own describe below, over every non-active status.
    expect(coming.textContent).toMatch(/would open at .* if Riley’s profile were active\./i);
    // No stand-in region: the times are what the planner's archived notice frames.
    expect(screen.queryByRole('region', { name: /nothing is coming up/i })).toBeNull();
    // The stored schedule itself stays readable — an archived profile is history, not a blank.
    expect(screen.getByLabelText(/daily questions/i)).toBeTruthy();
  });

  it('lists them for an active child, and for a draft child that has no slot yet', async () => {
    const { unmount } = renderPage(
      <ScheduleSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECTS}
        refreshKey={0}
        childStatus="active"
      />,
      { api: scheduleApi() },
    );
    const coming = await screen.findByRole('region', { name: /coming up for riley/i });
    expect(coming.textContent).toContain(REVIEW_TEXT);
    expect(coming.textContent).toMatch(/Math/);
    // The status is named rather than left out: an ACTIVE profile is the one this plain sentence is true
    // of, and HUNT7-H-1 made the sentence depend on that (an absent prop fails closed to the
    // hypothetical, like every other forward-looking line in the planner).
    expect(coming.textContent).toMatch(/daily practice opens/i);
    unmount();

    renderPage(
      <ScheduleSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECTS}
        refreshKey={0}
        childStatus="draft"
      />,
      { api: scheduleApi() },
    );
    const draft = await screen.findByRole('region', { name: /coming up for riley/i });
    // The draft child's stored plan stays listed in full — the times are the point of this describe —
    // and only the claim about them hedges.
    expect(draft.textContent).toContain(REVIEW_TEXT);
    expect(draft.textContent).toContain(DAILY_TEXT);
    expect(draft.textContent).toMatch(/Math/);
    expect(draft.textContent).not.toMatch(/daily practice opens/i);
  });
});

/**
 * HUNT7-H-4: `nextReviewReleases` is empty when the child has no ENABLED BANK subject — `storedPlan`
 * builds the set from `child_subjects … and enabled` and keeps only `BANK_SUBJECTS`, `scheduleResponse`
 * drops any release whose subject is not a bank subject, and with an enabled bank subject it iterates
 * the current AND next ISO week so a future release exists (apps/api/src/routes/learning.ts). Three
 * ways an archived profile gets there: subjects turned off before archiving, only CUSTOM subjects, and
 * a profile archived before the planner was ever opened (the subjects GET skips
 * `ensureLearningDefaults` for an archived one). For that profile the section printed "Turn on at least
 * one subject to get a review", while the subject checkbox is `disabled={readOnly || busy !== null}`
 * and the add-subject form is not rendered (SubjectsSection) — so the instruction pointed at a dead
 * control, and the section that owns the control says on the same page that subjects can't be turned on
 * or off.
 *
 * The repair's own hole, and why the fixtures below differ per case: the replacement asserted "no
 * subject is on", which the component does not check and which is FALSE for the custom-only profile the
 * finding itself listed — `SubjectsSection` prints that subject as "On" in the same region. The claim is
 * computed from `subjects`, the very array the Subjects card renders, so the two cards cannot disagree;
 * and the list is ALSO empty with a bank subject on (an invalid stored schedule or week key makes
 * `reviewReleases` answer !ok for both weeks), which is the third case below and names no cause at all.
 * Synthetic names only.
 */
const NO_REVIEWS: z.infer<typeof learningScheduleResponseSchema> = {
  ...SCHEDULE,
  nextReviewReleases: [],
};

function noReviewsApi(): Partial<ApiClient> {
  return {
    get: <S extends z.ZodType>(_path: string, schema: S) =>
      Promise.resolve(schema.parse(NO_REVIEWS)),
  };
}

/** The bank subject turned off: the plain "nothing is on" state. */
const SUBJECT_OFF: readonly ChildSubject[] = [{ ...SUBJECTS[0]!, enabled: false }];

/**
 * A custom subject that IS on. `generatedPractice` is false for it — the subjects GET computes it as
 * `isBankSubject(row.subject_key)` (apps/api/src/routes/learning.ts) — and that is exactly why it
 * yields no weekly review while the Subjects card lists it as On.
 */
const CUSTOM_ONLY: readonly ChildSubject[] = [
  {
    id: '2f6a7b8c-9d0e-4f12-8345-67890abcdef1',
    subjectKey: 'custom',
    displayName: 'Band',
    enabled: true,
    generatedPractice: false,
  },
];

describe('[HUNT7-H-4] the empty-review advice names a control the status leaves usable', () => {
  it('does not ask an archived child’s parent to turn a subject on', async () => {
    renderPage(
      <ScheduleSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECT_OFF}
        refreshKey={0}
        childStatus="archived"
      />,
      { api: noReviewsApi() },
    );
    const coming = await screen.findByRole('region', { name: /coming up for riley/i });
    // L-054: the constant the product renders, over the whole region.
    expect(coming.textContent).not.toMatch(/turn on at least one subject/i);
    // What is true, and the move the parent really has.
    expect(coming.textContent).toMatch(/no subject that gets a weekly review is on/i);
    expect(coming.textContent).toMatch(
      /can’t be turned on or off while Riley’s profile is archived/i,
    );
    expect(coming.textContent).toMatch(
      /Activate Riley again on the Children page, while a paid slot is free/i,
    );
  });

  it('does not say nothing is on for an archived child whose custom subject is on', async () => {
    renderPage(
      <ScheduleSection
        childId={CHILD}
        childName="Riley"
        subjects={CUSTOM_ONLY}
        refreshKey={0}
        childStatus="archived"
      />,
      { api: noReviewsApi() },
    );
    const coming = await screen.findByRole('region', { name: /coming up for riley/i });
    // The Subjects card in this same region prints "Band … On", so a bare "no subject is on" here is
    // the same two-cards-disagree defect the archived wording was written to remove.
    expect(coming.textContent).not.toMatch(/no subject is on/i);
    expect(coming.textContent).toMatch(/no subject that gets a weekly review is on/i);
  });

  it('names no cause when a review-bearing subject IS on and the list is still empty', async () => {
    // The state nobody enumerated (L-057): `reviewReleases` answers !ok for both weeks on an invalid
    // stored schedule or week key, so the list is empty with Math on. Neither "no subject is on" nor
    // "turn one on" is true, so the line reports the list and claims nothing about why.
    renderPage(
      <ScheduleSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECTS}
        refreshKey={0}
        childStatus="archived"
      />,
      { api: noReviewsApi() },
    );
    const coming = await screen.findByRole('region', { name: /coming up for riley/i });
    expect(coming.textContent).toMatch(/No weekly review is scheduled for this week or next\./i);
    expect(coming.textContent).not.toMatch(/subject/i);
  });

  it('keeps the instruction for a draft child, whose subject toggle really works', async () => {
    renderPage(
      <ScheduleSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECT_OFF}
        refreshKey={0}
        childStatus="draft"
      />,
      { api: noReviewsApi() },
    );
    const coming = await screen.findByRole('region', { name: /coming up for riley/i });
    expect(coming.textContent).toMatch(/turn on at least one subject/i);
    expect(coming.textContent).not.toMatch(/archived/i);
  });

  it('keeps it for an active child too, and for a caller that passes no status', async () => {
    const { unmount } = renderPage(
      <ScheduleSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECT_OFF}
        refreshKey={0}
        childStatus="active"
      />,
      { api: noReviewsApi() },
    );
    expect(
      (await screen.findByRole('region', { name: /coming up for riley/i })).textContent,
    ).toMatch(/turn on at least one subject/i);
    unmount();

    renderPage(
      <ScheduleSection childId={CHILD} childName="Riley" subjects={SUBJECT_OFF} refreshKey={0} />,
      { api: noReviewsApi() },
    );
    expect(
      (await screen.findByRole('region', { name: /coming up for riley/i })).textContent,
    ).toMatch(/turn on at least one subject/i);
  });
});

describe('[HUNT5-F-10] a practice set promises nothing to an archived child', () => {
  it('keeps the instant but turns the promise into the notice’s conditional', async () => {
    renderPage(
      <PracticeSetsSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECTS}
        zone={ZONE}
        childStatus="archived"
      />,
      { api: setsApi() },
    );
    const set = await screen.findByRole('listitem', { name: /daily practice/i });
    // No promise that the child will be shown anything: nothing from their device can open a set
    // while `app.current_child_id()` requires status 'active'.
    expect(set.textContent).not.toMatch(/shown to (your child|riley)/i);
    // The instant stays, as a hypothetical, in the words the planner's archived notice uses.
    expect(set.textContent).toContain(DAILY_TEXT);
    expect(set.textContent).toMatch(/would open for riley from/i);
    expect(set.textContent).toMatch(/once the profile is active again/i);
    // The set itself is still listed: history stays readable (BUG-070).
    expect(set.textContent).toMatch(/Math/);
  });

  it('a DRAFT child gets the same conditional: no promise before the profile is active', async () => {
    // The first fix tested only 'archived', but app.current_child_id() requires status 'active', so a
    // draft waiting for its paid slot cannot open a set either — and the planner's draft notice now
    // frames the times below it the same way.
    renderPage(
      <PracticeSetsSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECTS}
        zone={ZONE}
        childStatus="draft"
      />,
      { api: setsApi() },
    );
    const set = await screen.findByRole('listitem', { name: /daily practice/i });
    expect(set.textContent).not.toMatch(/shown to (your child|riley)/i);
    expect(set.textContent).toContain(DAILY_TEXT);
    expect(set.textContent).toMatch(/would open for riley from/i);
    // HUNT6-H-4: the wording stays, the reason for it does not. This used to say "'again' belongs to
    // a profile that WAS active; a draft never was", which is false: `releaseSlotlessProfiles`
    // (apps/api/src/services/billing-sync.ts) puts a previously ACTIVE child back into 'draft' when a
    // store downgrade or an expiry releases its slot. The plain sentence is true of both populations —
    // the one that never held a slot and the one that lost it — and "again", which asserts the second,
    // is what this page cannot know from the status alone.
    expect(set.textContent).toMatch(/once the profile is active\./i);
    expect(set.textContent).not.toMatch(/active again/i);
  });

  it('keeps the release promise for an active child', async () => {
    renderPage(
      <PracticeSetsSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECTS}
        zone={ZONE}
        childStatus="active"
      />,
      { api: setsApi() },
    );
    const set = await screen.findByRole('listitem', { name: /daily practice/i });
    await waitFor(() => expect(set.textContent).toMatch(/shown to your child from/i));
    expect(set.textContent).toContain(DAILY_TEXT);
    expect(within(set).queryByText(/once the profile is active again/i)).toBeNull();
  });

  it('an UNRECOGNISED status gets the conditional: only an absent prop keeps the promise', async () => {
    // HUNT6-H-3: the docstring and the inline comment in PracticeSetsSection both said "an unknown
    // value is treated as live", which is a claim about the VALUE; the code's condition is
    // `childStatus !== undefined && childStatus !== 'active'`, so an unrecognised value fails CLOSED
    // and only omitting the prop keeps the promise. Asserting the documented behaviour here
    // (/shown to your child/) went red — the card renders the conditional — which is what settled
    // which of the two is true (L-053). Failing closed is the one worth keeping: the promise is
    // "shown to your child", and `app.current_child_id()` requires `c.status = 'active'`, so any
    // status the page does not recognise must not make that promise on a guess.
    renderPage(
      <PracticeSetsSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECTS}
        zone={ZONE}
        childStatus="suspended"
      />,
      { api: setsApi() },
    );
    const set = await screen.findByRole('listitem', { name: /daily practice/i });
    expect(set.textContent).not.toMatch(/shown to (your child|riley)/i);
    expect(set.textContent).toMatch(/would open for riley from/i);
    // No "again": that belongs to a profile this page knows was archived.
    expect(set.textContent).not.toMatch(/active again/i);
    expect(set.textContent).toContain(DAILY_TEXT);
  });

  it('keeps it when no status is given at all, so an unwired caller loses nothing', async () => {
    renderPage(
      <PracticeSetsSection childId={CHILD} childName="Riley" subjects={SUBJECTS} zone={ZONE} />,
      { api: setsApi() },
    );
    const set = await screen.findByRole('listitem', { name: /daily practice/i });
    await waitFor(() => expect(set.textContent).toMatch(/shown to your child from/i));
    expect(set.textContent).toContain(DAILY_TEXT);
  });
});

/**
 * HUNT6-H-1: the four editing sections offer writes the API refuses for an archived profile.
 * `ownedChild(c, 'write')` throws BUSINESS_RULE CHILD_ARCHIVED for `status = 'archived'`
 * (apps/api/src/routes/learning.ts), and every write on these sections goes through it: POST/PATCH
 * /subjects, PUT /learning-schedule, POST and DELETE /test-dates, POST /study-materials. The reads
 * take `'read'`, which admits an archived profile, so the stored plan stays visible — that is the
 * history BUG-070/AC_CAPACITY_08 made readable, and what the planner's own notice promises.
 *
 * A DRAFT profile stays editable on purpose: the same guard admits it, because a parent sets the plan
 * up before activation (learning.ts's ownedChild docstring). So the test here is "is this profile
 * ARCHIVED?", not "is it active?" — the opposite of PracticeSetsSection's one sentence, which is a
 * promise to the CHILD and fails closed for any non-active profile.
 */
const TEST_DATES: z.infer<typeof testDatesResponseSchema> = {
  testDates: [
    {
      id: '44444444-4444-4444-8444-000000000001',
      subjectId: MATH_SUBJECT,
      subjectKey: 'math',
      testDate: '2026-10-06',
      scopeNotes: 'adding fractions',
      matchedSkills: [{ skill: 'fraction_addition', label: 'Adding fractions' }],
    },
  ],
};

function testDatesApi(): Partial<ApiClient> {
  return {
    get: <S extends z.ZodType>(_path: string, schema: S) =>
      Promise.resolve(schema.parse(TEST_DATES)),
    // The add path, so the confirmation sentence a parent reads after saving can be asserted.
    send: <S extends z.ZodType>(_m: string, _p: string, _b: unknown, schema: S) =>
      Promise.resolve(schema.parse({ testDate: TEST_DATES.testDates[0] })),
  };
}

/** The same saved date with notes no skill matched, which is the section's other hint line. */
const UNRECOGNISED_NOTES: z.infer<typeof testDatesResponseSchema> = {
  testDates: [
    {
      ...TEST_DATES.testDates[0]!,
      scopeNotes: 'whatever Ms Diaz put on the board',
      matchedSkills: [],
    },
  ],
};

function unrecognisedNotesApi(): Partial<ApiClient> {
  return {
    get: <S extends z.ZodType>(_path: string, schema: S) =>
      Promise.resolve(schema.parse(UNRECOGNISED_NOTES)),
  };
}

describe('[HUNT6-H-1] an archived child’s planner offers no write the API refuses', () => {
  it('SubjectsSection: no add-a-subject submit and no live subject toggle', async () => {
    renderPage(
      <SubjectsSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECTS}
        onChanged={() => {}}
        childStatus="archived"
      />,
    );
    const section = await screen.findByRole('region', { name: 'Subjects' });
    expect(screen.queryByRole('button', { name: /add subject/i })).toBeNull();
    // The stored value stays readable, as history: the subject and its on/off state are still there.
    expect(section.textContent).toMatch(/Math/);
    expect(within(section).getByText('On')).toBeTruthy();
    // The toggle is a PATCH: it must not be pressable, and the reason has to be on screen.
    expect(within(section).getByRole('checkbox')).toHaveProperty('disabled', true);
    expect(section.textContent).toMatch(/archived/i);
  });

  it('SubjectsSection: a DRAFT child keeps every control, because the API keeps a draft writable', async () => {
    renderPage(
      <SubjectsSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECTS}
        onChanged={() => {}}
        childStatus="draft"
      />,
    );
    const section = await screen.findByRole('region', { name: 'Subjects' });
    expect(within(section).getByRole('button', { name: /add subject/i })).toBeTruthy();
    expect(within(section).getByRole('checkbox')).toHaveProperty('disabled', false);
  });

  it('ScheduleSection: no "Save schedule" submit, and the saved schedule still readable', async () => {
    renderPage(
      <ScheduleSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECTS}
        refreshKey={0}
        childStatus="archived"
      />,
      { api: scheduleApi() },
    );
    await screen.findByRole('region', { name: /coming up for riley/i });
    expect(screen.queryByRole('button', { name: /save schedule/i })).toBeNull();
    // The stored plan is what the parent came to read (the planner's notice promises it stays).
    expect(screen.getByLabelText(/daily questions/i)).toHaveProperty('value', '5');
    expect(screen.getByLabelText(/daily questions/i)).toHaveProperty('disabled', true);
  });

  it('ScheduleSection: a DRAFT child can still save, which is how a plan is set up before activation', async () => {
    renderPage(
      <ScheduleSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECTS}
        refreshKey={0}
        childStatus="draft"
      />,
      { api: scheduleApi() },
    );
    expect(await screen.findByRole('button', { name: /save schedule/i })).toBeTruthy();
    expect(screen.getByLabelText(/daily questions/i)).toHaveProperty('disabled', false);
  });

  it('TestDatesSection: no add form and no Remove, with the saved dates still listed', async () => {
    renderPage(
      <TestDatesSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECTS}
        onChanged={() => {}}
        childStatus="archived"
      />,
      { api: testDatesApi() },
    );
    const saved = await screen.findByLabelText('Saved test dates');
    // The history half stays pinned, anchored on the NEUTRAL line rather than on any occurrence of the
    // topic: "Covers: <notes>" is what the fix's docstring means by history (HUNT7-H-3).
    expect(saved.textContent).toMatch(/Covers: adding fractions/i);
    expect(screen.queryByRole('button', { name: /save test date/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove the math test/i })).toBeNull();
    expect(screen.queryByLabelText('Add a test date')).toBeNull();

    // HUNT7-H-3: and no future-tense promise of practice this profile can never receive.
    // `loadChildContext` returns null for an archived profile (apps/api/src/jobs/learning-jobs.ts) so
    // no review is generated, and `app.current_child_id()` requires `c.status = 'active'` (migration
    // 0001_core_identity.sql) so nothing from the child's device could open one — while the data that
    // produced the line is there all the same, because GET /test-dates admits an archived profile
    // through `ownedChild(c, 'read')` and `toTestDate` computes `matchedSkills` status-blind
    // (apps/api/src/routes/learning.ts). L-054: the constant the product renders, over the whole
    // region.
    expect(saved.textContent).not.toMatch(/Practice will include/i);
    expect(saved.textContent).not.toMatch(/the review uses this week’s skills/i);
    // What holds instead: the state that decides is named, and the topics are a conditional.
    expect(saved.textContent).toMatch(
      /No review is prepared while Riley’s profile is not active\. If it is activated, these topics would steer one: Adding fractions/i,
    );
  });

  it('TestDatesSection: a DRAFT child keeps the add form and Remove', async () => {
    renderPage(
      <TestDatesSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECTS}
        onChanged={() => {}}
        childStatus="draft"
      />,
      { api: testDatesApi() },
    );
    expect(await screen.findByRole('button', { name: /save test date/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /remove the math test/i })).toBeTruthy();
  });

  it('StudyMaterialSection: no Save for an archived child, and a DRAFT child keeps it', async () => {
    const { unmount } = renderPage(
      <StudyMaterialSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECTS}
        childStatus="archived"
      />,
    );
    const section = await screen.findByRole('region', { name: /spelling lists and class notes/i });
    expect(within(section).queryByRole('button', { name: /^save$/i })).toBeNull();
    expect(within(section).queryByRole('textbox')).toBeNull();
    expect(section.textContent).toMatch(/archived/i);
    unmount();

    renderPage(
      <StudyMaterialSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECTS}
        childStatus="draft"
      />,
    );
    expect(
      within(
        await screen.findByRole('region', { name: /spelling lists and class notes/i }),
      ).getByRole('button', { name: /^save$/i }),
    ).toBeTruthy();
  });
});

/**
 * HUNT7-H-3 (repair): the forward-looking test-date lines were hedged for `archived` alone, and the
 * state that DECIDES them is not "is this profile archived" but "does this profile receive a review",
 * which is `status = 'active'` and nothing weaker. `loadChildContext` returns null for an archived
 * profile AND then for any status that is not 'active' unless `requireActive: false` is passed, which
 * only routes/learning.ts's own preview does; the nightly enqueue sweep selects `where c.status =
 * 'active'`; the practice-set insert re-checks `status = 'active'` under FOR SHARE
 * (apps/api/src/jobs/learning-jobs.ts); and `app.current_child_id()` requires `c.status = 'active'`
 * (migration 0001_core_identity.sql), so no non-active child's device could open a review either.
 *
 * So a DRAFT profile got "Practice will include: Adding fractions" under the planner's own notice
 * saying "Riley doesn't have a paid slot right now, so no practice is prepared" — the two-cards-
 * disagree defect, on the very page the archived fix had just cleared it from. Asserted over a SET of
 * statuses, including one this page has never heard of, because a single fixed status is what let the
 * fall-through through. Synthetic names only.
 */
describe('[HUNT7-H-3] a test date promises practice only where practice is prepared', () => {
  for (const childStatus of ['archived', 'draft', 'suspended'] as const) {
    it(`hedges both forward-looking lines for a ${childStatus} profile`, async () => {
      const { unmount } = renderPage(
        <TestDatesSection
          childId={CHILD}
          childName="Riley"
          subjects={SUBJECTS}
          onChanged={() => {}}
          childStatus={childStatus}
        />,
        { api: testDatesApi() },
      );
      const saved = await screen.findByLabelText('Saved test dates');
      // The history half stays for every one of them: the date, the subject and the parent's notes.
      expect(saved.textContent).toMatch(/Math/);
      expect(saved.textContent).toMatch(/Covers: adding fractions/i);
      // The promise does not. L-054: over the whole region, not one sentence of it.
      expect(saved.textContent).not.toMatch(/Practice will include/i);
      expect(saved.textContent).toMatch(
        /No review is prepared while Riley’s profile is not active\./i,
      );
      unmount();

      // The other forward-looking line, for notes no skill matched: there is no review to describe,
      // so it goes rather than being reworded.
      renderPage(
        <TestDatesSection
          childId={CHILD}
          childName="Riley"
          subjects={SUBJECTS}
          onChanged={() => {}}
          childStatus={childStatus}
        />,
        { api: unrecognisedNotesApi() },
      );
      const notes = await screen.findByLabelText('Saved test dates');
      expect(notes.textContent).toMatch(/Covers: whatever Ms Diaz put on the board/i);
      expect(notes.textContent).not.toMatch(/the review uses this week’s skills/i);
      expect(notes.textContent).not.toMatch(/No practice topics were recognized/i);
    });
  }

  /**
   * The re-check of this repair found HUNT7-H-3 INCOMPLETE: it hedged the two row lines and left two more
   * copies of the same forward promise in the SAME component, unkeyed — the add confirmation and the
   * section's standing intro. On a draft child's card the parent who had just saved a test date read
   * "“Coming up” shows when its review is ready." two lines above "No review is prepared while Riley's
   * profile is not active." That is L-053's third copy in PRODUCT COPY rather than in a comment, and the
   * reader of the hedged row is exactly the parent who triggered the confirmation.
   *
   * Every forward-tense promise in the component now answers to `receivesPractice`, and these cases
   * assert them over the same status SET as above rather than over the one status that was fixed.
   */
  for (const childStatus of ['archived', 'draft', 'suspended'] as const) {
    it(`hedges the add confirmation and the intro for a ${childStatus} profile`, async () => {
      renderPage(
        <TestDatesSection
          childId={CHILD}
          childName="Riley"
          subjects={SUBJECTS}
          onChanged={() => {}}
          childStatus={childStatus}
        />,
        { api: testDatesApi() },
      );
      const section = await screen.findByRole('region', { name: 'Upcoming tests' });
      // The intro renders for every status, outside every conditional, so it was the copy an archived
      // parent read while the same card told them test dates cannot be added at all.
      expect(section.textContent).not.toMatch(/so that subject’s review is planned before it/i);
      expect(section.textContent).toMatch(
        /A review is planned from them once Riley’s profile is active\./i,
      );
    });
  }

  it('hedges the add confirmation a DRAFT parent reads right after saving', async () => {
    // The add form is live for a draft (`readOnly` is archived-only, on purpose), so this path is
    // reachable and its sentence is the one the parent sees first.
    renderPage(
      <TestDatesSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECTS}
        onChanged={() => {}}
        childStatus="draft"
      />,
      { api: testDatesApi() },
    );
    const user = userEvent.setup();
    // The FIELD, not the form: 'Add a test date' is the <form>'s own aria-label, and the date input is
    // labelled 'Test date'. `fireEvent.change` rather than `user.type` because jsdom's date input does not
    // accept typed digits, which leaves the value empty and the form's own check refuses the submit.
    fireEvent.change(await screen.findByLabelText('Test date'), {
      target: { value: '2026-10-06' },
    });
    await user.click(screen.getByRole('button', { name: /save test date/i }));
    const feedback = await screen.findByRole('status');
    expect(feedback.textContent).toMatch(
      /If Riley’s profile is activated, “Coming up” will show when its review is ready\./i,
    );
    // And not the unconditional promise, which is what the parent used to be told.
    expect(feedback.textContent).not.toMatch(/^.*\. “Coming up” shows when its review is ready\./i);
  });

  it('keeps both lines whole for an ACTIVE profile, whose review really is prepared', async () => {
    const { unmount } = renderPage(
      <TestDatesSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECTS}
        onChanged={() => {}}
        childStatus="active"
      />,
      { api: testDatesApi() },
    );
    const saved = await screen.findByLabelText('Saved test dates');
    expect(saved.textContent).toMatch(/Practice will include: Adding fractions/i);
    expect(saved.textContent).not.toMatch(/No review is prepared/i);
    unmount();

    renderPage(
      <TestDatesSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECTS}
        onChanged={() => {}}
        childStatus="active"
      />,
      { api: unrecognisedNotesApi() },
    );
    const notes = await screen.findByLabelText('Saved test dates');
    expect(notes.textContent).toMatch(/the review uses this week’s skills/i);
  });
});

/**
 * The second blocker the re-check found: the two repairs picked DIFFERENT deciding states for the SAME
 * question. HUNT7-H-3 settled that a review needs `status === 'active'`, and HUNT7-H-4's fall-through arm
 * still told a draft parent "…to get a review" — the very promise H-3 had removed, on the same screen.
 *
 * `receivesPractice` in format.ts is now the one definition, imported by both sections, so the question is
 * decided once. These cases read the two cards TOGETHER, which is the only way the contradiction was
 * visible: each card on its own was self-consistent.
 */
describe('[HUNT7-H-3/H-4] the schedule card and the test-date card answer the same question the same way', () => {
  for (const childStatus of ['draft', 'suspended'] as const) {
    it(`hedges the schedule card's promise for a ${childStatus} profile too`, async () => {
      renderPage(
        <ScheduleSection
          childId={CHILD}
          childName="Riley"
          subjects={[{ ...SUBJECTS[0]!, enabled: false }]}
          refreshKey={0}
          childStatus={childStatus}
        />,
        { api: scheduleApi({ nextReviewReleases: [] }) },
      );
      const section = await screen.findByRole('region', { name: /coming up for riley/i });
      // The INSTRUCTION stays — the control it names really is live for these statuses — but its promise
      // is conditional, which is the difference between "do this and you get a review" and the truth.
      expect(section.textContent).toMatch(
        /Turn on at least one subject that PencilLift makes practice for/i,
      );
      expect(section.textContent).toMatch(/a review is prepared once Riley’s profile is active\./i);
      expect(section.textContent).not.toMatch(/makes practice for to get a review\./i);
    });
  }

  it('keeps the unconditional instruction for an ACTIVE profile, which really does get one', async () => {
    renderPage(
      <ScheduleSection
        childId={CHILD}
        childName="Riley"
        subjects={[{ ...SUBJECTS[0]!, enabled: false }]}
        refreshKey={0}
        childStatus="active"
      />,
      { api: scheduleApi({ nextReviewReleases: [] }) },
    );
    const section = await screen.findByRole('region', { name: /coming up for riley/i });
    expect(section.textContent).toMatch(/makes practice for to get a review\./i);
    expect(section.textContent).not.toMatch(/a review is prepared once/i);
  });

  it('decides the question in ONE place, so the two sections cannot drift apart again', () => {
    // The structural half. Both files import `receivesPractice` and neither re-derives the predicate, so
    // a future change to what "receives practice" means reaches both cards or neither.
    for (const file of [
      'apps/web/src/components/learning/TestDatesSection.tsx',
      'apps/web/src/components/learning/ScheduleSection.tsx',
    ]) {
      const source = readFileSync(
        join(import.meta.dirname, '..', '..', '..', '..', '..', file),
        'utf8',
      );
      expect(source, file).toContain('receivesPractice');
      // Neither may carry its own copy of the expression the helper owns.
      expect(source, file).not.toMatch(/childStatus === 'active'/);
    }
  });
});

/**
 * HUNT7-H-1, the FOURTH occurrence of L-068's shape and the first one in a lookup TABLE. The daily line
 * is `DAILY_STATE[state](releaseAt, zone)` and only ONE of the four entries ever contained an instant
 * ('not_yet_released'), so the planner notice's framing — "the times below are what the schedule would
 * produce if the profile were active again" — could not reach the other three: they carry no time to
 * frame. 'available' is reachable for BOTH non-active statuses (the archived branch of GET
 * /learning-schedule recomputes `dailyPracticeState` from the clock on every request, and
 * `dailyPracticeState` answers 'available' on any local day past `daily_local_time` with no pause), and
 * it is false for both, because `app.current_child_id()` requires `c.status = 'active'` (migration 0001)
 * and `loadChildContext` prepares nothing for a non-active profile (apps/api/src/jobs/learning-jobs.ts).
 * So a few inches under "no new practice is prepared for them", the same region said today's practice is
 * available.
 *
 * The table now carries a hypothetical PER STATE, so no state can print an unconditional present-tense
 * sentence, and `receivesPractice` — the planner's one definition of "is practice prepared for this
 * child" (format.ts) — chooses between them, the same value the empty-review advice above uses. The
 * instants stay wherever there is one: HUNT5-F-10's ruling is unchanged.
 *
 * The cases below run over the whole non-active SET rather than the one status that was reported, which
 * is what HUNT7-H-3's and H-4's repairs each got wrong in turn. Synthetic names only (Riley).
 */
const DAILY_STATES = [
  {
    state: 'available' as const,
    prepared: 'Today’s daily practice is available.',
    hedged: 'Today’s daily practice would be available if Riley’s profile were active.',
  },
  {
    state: 'not_yet_released' as const,
    prepared: `Today’s daily practice opens ${DAILY_TEXT}.`,
    hedged: `Today’s daily practice would open at ${DAILY_TEXT} if Riley’s profile were active.`,
  },
  {
    state: 'paused' as const,
    prepared: 'Daily practice is paused today.',
    hedged: 'Daily practice would be paused today even if Riley’s profile were active.',
  },
  {
    state: 'vacation' as const,
    prepared: 'Daily practice is paused today (vacation).',
    hedged: 'Daily practice would be paused today (vacation) even if Riley’s profile were active.',
  },
];

function dailyApi(state: (typeof DAILY_STATES)[number]['state']): Partial<ApiClient> {
  return scheduleApi({
    dailyPractice: { localDate: '2026-09-28', state, releaseAt: DAILY_AT },
  });
}

describe('[HUNT7-H-1] the daily line is a hypothetical for every profile that receives no practice', () => {
  for (const { state, prepared, hedged } of DAILY_STATES) {
    for (const childStatus of ['archived', 'draft', 'suspended'] as const) {
      it(`hedges the ${state} line for a ${childStatus} profile`, async () => {
        renderPage(
          <ScheduleSection
            childId={CHILD}
            childName="Riley"
            subjects={SUBJECTS}
            refreshKey={0}
            childStatus={childStatus}
          />,
          { api: dailyApi(state) },
        );
        const coming = await screen.findByRole('region', { name: /coming up for riley/i });
        // The present-tense claim is gone from the whole region (L-054), not merely reworded nearby.
        expect(coming.textContent).not.toContain(prepared);
        expect(coming.textContent).toContain(hedged);
      });
    }

    it(`keeps the plain ${state} line for an ACTIVE profile, which does receive practice`, async () => {
      renderPage(
        <ScheduleSection
          childId={CHILD}
          childName="Riley"
          subjects={SUBJECTS}
          refreshKey={0}
          childStatus="active"
        />,
        { api: dailyApi(state) },
      );
      const coming = await screen.findByRole('region', { name: /coming up for riley/i });
      expect(coming.textContent).toContain(prepared);
      expect(coming.textContent).not.toContain(hedged);
    });
  }

  it('keeps the release instant in the hedged line, for every status (HUNT5-F-10)', async () => {
    for (const childStatus of ['archived', 'draft', 'active'] as const) {
      const { unmount } = renderPage(
        <ScheduleSection
          childId={CHILD}
          childName="Riley"
          subjects={SUBJECTS}
          refreshKey={0}
          childStatus={childStatus}
        />,
        { api: dailyApi('not_yet_released') },
      );
      const coming = await screen.findByRole('region', { name: /coming up for riley/i });
      // Blanking the stored plan would throw away what the parent came to read; only the claim hedges.
      expect(coming.textContent, childStatus).toContain(DAILY_TEXT);
      unmount();
    }
  });

  it('gives EVERY state a hypothetical, so a fifth state cannot print a present-tense claim', () => {
    // The table half of the fix. A test on the rendered copy passes the day a state is added and only
    // fails once someone reads that state's sentence, so the property is asserted on the table itself:
    // every entry has both variants, and no hypothetical is the prepared sentence over again.
    const states = Object.keys(DAILY_STATE) as (keyof typeof DAILY_STATE)[];
    expect(states.sort()).toEqual(DAILY_STATES.map((d) => d.state).sort());
    for (const state of states) {
      const copy = DAILY_STATE[state];
      const prepared = copy.prepared(DAILY_AT, ZONE);
      const hedged = copy.hypothetical(DAILY_AT, ZONE, 'Riley');
      expect(hedged, state).not.toBe(prepared);
      expect(hedged, state).toMatch(/would/);
      expect(hedged, state).toMatch(/if Riley’s profile were active/);
    }
  });
});
