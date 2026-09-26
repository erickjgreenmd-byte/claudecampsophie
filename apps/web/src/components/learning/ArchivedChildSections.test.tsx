import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  ChildSubject,
  ParentPracticeSet,
  learningScheduleResponseSchema,
  practiceSetsResponseSchema,
} from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import { formatInZone } from './format.ts';
import { PracticeSetsSection } from './PracticeSetsSection.tsx';
import { ScheduleSection } from './ScheduleSection.tsx';

/**
 * HUNT5-F-10, as the lead settled it. Two designs were on the table for an archived child's planner
 * and only one ships:
 *
 * The planner's archived notice frames everything below it — "the times below are what the schedule
 * would produce if the profile were active again" — so the schedule's release times STAY. A
 * hypothetical instant under an explicit "if reactivated" heading is honest, and blanking it would
 * throw away the stored plan the parent came to read. ScheduleSection therefore has no status to
 * branch on at all: the hiding branch built for the other design was dead for every real archived
 * child (the planner, its only caller, never passed a status) and is gone.
 *
 * What is NOT honest is a per-set line that PROMISES something to the child: "Shown to your child
 * from <instant>" is a promise no archived profile can keep. `app.current_child_id()` requires
 * `c.status = 'active'` (migration 0001), so no request from the child's device can open any set,
 * whatever release instant it carries, and the API refuses every write with CHILD_ARCHIVED. So
 * PracticeSetsSection keeps a `childStatus` prop — wired from the planner — and uses it for exactly
 * that one sentence: the instant stays, the promise becomes the notice's conditional.
 *
 * What an active or a draft child sees is unchanged, and is asserted here too: a draft really is
 * waiting for a paid slot, and its schedule still describes what will happen when it gets one.
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

function scheduleApi(): Partial<ApiClient> {
  return {
    get: <S extends z.ZodType>(_path: string, schema: S) => Promise.resolve(schema.parse(SCHEDULE)),
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
  it('has no status branch at all: an archived child still sees the times the notice explains', async () => {
    renderPage(
      <ScheduleSection
        childId={CHILD}
        childName="Riley"
        subjects={SUBJECTS}
        refreshKey={0}
        // The type-level half of the assertion: under the shipped design there is no status to
        // branch on, so this prop must not exist. While it did, the branch it fed was dead for
        // every real archived child — the planner, its only caller, passed no status.
        // @ts-expect-error -- ScheduleSection takes no childStatus prop.
        childStatus="archived"
      />,
      { api: scheduleApi() },
    );
    const coming = await screen.findByRole('region', { name: /coming up for riley/i });
    expect(coming.textContent).toContain(REVIEW_TEXT);
    expect(coming.textContent).toContain(DAILY_TEXT);
    expect(coming.textContent).toMatch(/daily practice opens/i);
    // No stand-in region: the times are what the planner's archived notice frames.
    expect(screen.queryByRole('region', { name: /nothing is coming up/i })).toBeNull();
    // The stored schedule itself stays readable — an archived profile is history, not a blank.
    expect(screen.getByLabelText(/daily questions/i)).toBeTruthy();
  });

  it('lists them for an active child, and for a draft child waiting for a slot', async () => {
    renderPage(
      <ScheduleSection childId={CHILD} childName="Riley" subjects={SUBJECTS} refreshKey={0} />,
      { api: scheduleApi() },
    );
    const coming = await screen.findByRole('region', { name: /coming up for riley/i });
    expect(coming.textContent).toContain(REVIEW_TEXT);
    expect(coming.textContent).toMatch(/Math/);
    expect(coming.textContent).toMatch(/daily practice opens/i);
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
    // 'again' belongs to a profile that WAS active; a draft never was.
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
