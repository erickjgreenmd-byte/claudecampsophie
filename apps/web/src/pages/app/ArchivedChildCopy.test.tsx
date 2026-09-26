import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import HomeworkPage from './HomeworkPage.tsx';
import LearningPlannerPage from './LearningPlannerPage.tsx';

/**
 * WEBR4-10: both child pickers spelled every non-active child " (no paid slot yet)" and the planner
 * added "{name} doesn't have a paid slot yet … see Subscription". That copy was written when 'draft'
 * was the only non-active state a portal user could reach; WEB-R2-03 makes 'archived' reachable in
 * one click (and a requested deletion archives a child too). For an archived child the sentence is
 * false — no slot is waiting to be bought, the profile is history only — and unactionable, while the
 * scan uploader was still offered although POST /v1/assignments answers CHILD_NOT_ACTIVE.
 *
 * Synthetic names only.
 */

const FAMILY = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';

const archivedRiley = {
  id: RILEY,
  nickname: 'Riley',
  gradeLevel: 3,
  ageBand: '8-10',
  status: 'archived',
};

function familyWith(child: Record<string, unknown>) {
  return {
    id: FAMILY,
    displayName: 'Test Family',
    timezone: 'America/Chicago',
    paidSlots: 1,
    billingConflict: null,
    managingChannel: 'app_store',
    children: [child],
  };
}

const family = familyWith(archivedRiley);

const emptyList = {
  assignments: [],
  allowance: {
    periodKey: 'pages:2026-09',
    childPagesUsed: 0,
    childPagesAllowed: 0,
    familyPagesUsed: 0,
    familyPagesAllowed: 40,
  },
  nextCursor: null,
};

function api(
  extra: (path: string) => unknown = () => undefined,
  overview: unknown = family,
): Partial<ApiClient> {
  return {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      // `extra` wins, so a test can make a path the defaults cover answer what the API really
      // answers (a NOT_FOUND assignment list for a child whose deletion is under way).
      const override = extra(path);
      const value =
        override !== undefined
          ? override
          : path === '/v1/family'
            ? overview
            : path.startsWith('/v1/assignments?childId=')
              ? emptyList
              : undefined;
      if (value === undefined) {
        return Promise.reject(new ApiRequestError('NOT_FOUND', `unexpected GET ${path}`, 404));
      }
      if (value instanceof ApiRequestError) return Promise.reject(value);
      return Promise.resolve(schema.parse(value));
    },
    send: () => Promise.reject(new ApiRequestError('NOT_FOUND', 'unexpected send', 404)),
  };
}

/** What the API really answers for a child whose data deletion is `requested` or `processing`. */
const childNotFound = () => new ApiRequestError('NOT_FOUND', 'Child not found', 404);
const deletingRiley = familyWith({ ...archivedRiley, deletionPending: true });

afterEach(cleanup);

describe('[WEBR4-10] an archived child is never described as waiting for a paid slot', () => {
  it('labels the homework picker honestly and offers no scan uploader', async () => {
    renderPage(<HomeworkPage />, { api: api() });
    const picker = await screen.findByLabelText('Child');
    const option = within(picker).getByRole('option');
    expect(option.textContent).not.toMatch(/no paid slot yet/i);
    expect(option.textContent).toMatch(/archived/i);
    // The uploader would only reach CHILD_NOT_ACTIVE, and no client can assign a slot from there.
    expect(screen.queryByRole('region', { name: 'Add a scan' })).toBeNull();
  });

  it('labels the planner picker honestly and drops the "see Subscription" instruction', async () => {
    renderPage(<LearningPlannerPage />, {
      api: api((path) => (path.endsWith('/subjects') ? { subjects: [] } : undefined)),
    });
    const picker = await screen.findByLabelText('Child');
    const option = within(picker).getByRole('option');
    expect(option.textContent).not.toMatch(/no paid slot yet/i);
    expect(option.textContent).toMatch(/archived/i);
    const plan = await screen.findByRole('region', { name: /learning plan for riley/i });
    expect(plan.textContent).not.toMatch(/doesn’t have a paid slot yet/i);
    expect(plan.textContent).toMatch(/archived/i);
  });
});

/**
 * HUNT5-F-2: childPickerSuffix branches on `deletionPending` first, because migration 0600's
 * request_deletion archives the child too — but both pickers parsed GET /v1/family through a local
 * z.object that selected id/nickname/status only, and z.object strips unknown keys, so the flag never
 * reached either page and that branch was dead. Such a child was labelled "(archived — history only)"
 * while the purge deletes that history, the planner promised "What was planned and practised stays
 * readable" and offered an activation POST /children/:id/activate answers NOT_FOUND for, and the
 * homework list — which 404s for such a child — showed a bare "Child not found" with a Try again that
 * can never succeed, for a child the picker above names.
 */
describe('[HUNT5-F-2] a child whose data deletion is under way is flagged, not called "history only"', () => {
  it('labels the planner picker and says what is happening instead of promising kept history', async () => {
    renderPage(<LearningPlannerPage />, {
      api: api((path) => (path.endsWith('/subjects') ? childNotFound() : undefined), deletingRiley),
    });
    const picker = await screen.findByLabelText('Child');
    const option = within(picker).getByRole('option');
    expect(option.textContent).toMatch(/data deletion under way/i);
    expect(option.textContent).not.toMatch(/history only/i);
    const plan = await screen.findByRole('region', { name: /learning plan for riley/i });
    expect(plan.textContent).toMatch(/deletion/i);
    expect(plan.textContent).not.toMatch(/stays readable/i);
    expect(within(plan).queryByRole('link', { name: /activate riley again/i })).toBeNull();
    // Where a mistake is actually handled — the same two places the Children page names.
    expect(within(plan).getByRole('link', { name: /privacy page/i })).toBeTruthy();
    expect(within(plan).getByRole('link', { name: /support/i })).toBeTruthy();
  });

  it('explains the deletion on the homework page instead of a bare "Child not found"', async () => {
    renderPage(<HomeworkPage />, {
      api: api(
        (path) => (path.startsWith('/v1/assignments?childId=') ? childNotFound() : undefined),
        deletingRiley,
      ),
    });
    const picker = await screen.findByLabelText('Child');
    expect(within(picker).getByRole('option').textContent).toMatch(/data deletion under way/i);
    expect(await screen.findByText(/deleted/i)).toBeTruthy();
    expect(screen.queryByText(/Child not found/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    // No uploader: POST /v1/assignments refuses such a child too.
    expect(screen.queryByRole('region', { name: 'Add a scan' })).toBeNull();
  });
});

/**
 * HUNT5-F-10: the archived notice (WEBR4-10) said "nothing here is released to them", while the
 * schedule section right below it prints "Coming up for Riley" with the next daily and weekly review
 * instants. docs/Bug_Ledger records the preview itself as a known-open item (BUG-070 residual); what
 * was new is copy that denied it on the same screen. The notice now says what holds: nothing NEW is
 * prepared, and the times below are what the schedule would produce if the profile were active again.
 *
 * That framing is what keeps the times honest, and it reaches only as far as the notice's own words.
 * A practice-set card saying "Shown to your child from <instant>" is not a hypothetical, it is a
 * promise, and an archived profile cannot keep it: `app.current_child_id()` requires
 * `c.status = 'active'` (migration 0001), so nothing from the child's device can open a set at all.
 * PracticeSetsSection takes a `childStatus` prop for exactly that sentence, and the planner — which
 * has `child.status` in scope two lines above — has to pass it, or the branch is dead for every real
 * archived child. Asserted here, on the planner, because the wiring is the thing that was missing.
 */
const MATH_SUBJECT = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

const oneSubject = {
  subjects: [
    {
      id: MATH_SUBJECT,
      subjectKey: 'math',
      displayName: 'Math',
      enabled: true,
      generatedPractice: true,
    },
  ],
};

const scheduleWithReleases = {
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
  timezone: 'America/Chicago',
  nextReviewReleases: [
    {
      subjectKey: 'math',
      weekKey: '2026-W40',
      releaseAt: '2026-09-30T21:00:00.000Z',
      reason: 'default_schedule',
      testDate: null,
    },
  ],
  dailyPractice: {
    localDate: '2026-09-28',
    state: 'not_yet_released',
    releaseAt: '2026-09-28T20:30:00.000Z',
  },
  pointsPolicy: { expireEarnedPoints: false, penalizeMissedDays: false },
};

/** One prepared daily set, carrying the release instant the card used to promise the child. */
const oneSet = {
  sets: [
    {
      id: '33333333-3333-4333-8333-000000000001',
      kind: 'daily',
      status: 'ready',
      subjectKey: 'math',
      localDate: '2026-09-28',
      reviewWeek: null,
      version: 1,
      optional: false,
      readyAt: '2026-09-27T15:00:00.000Z',
      releaseAt: '2026-09-28T20:30:00.000Z',
      mix: {},
      notes: [],
      items: [],
    },
  ],
  nextCursor: null,
};

function plannerApi() {
  return api((path) =>
    path.endsWith('/subjects')
      ? oneSubject
      : path.endsWith('/learning-schedule')
        ? scheduleWithReleases
        : path.includes('/practice-sets')
          ? oneSet
          : undefined,
  );
}

describe('[HUNT5-F-10] the archived notice does not contradict the release times below it', () => {
  it('explains the upcoming-release times instead of denying that anything is released', async () => {
    renderPage(<LearningPlannerPage />, { api: plannerApi() });
    const plan = await screen.findByRole('region', { name: /learning plan for riley/i });
    // The other half of the contradiction is on screen: future release instants for this child.
    const coming = await within(plan).findByRole('region', { name: /coming up for riley/i });
    expect(coming.textContent).toMatch(/Math/);
    expect(plan.textContent).not.toMatch(/nothing here is released to them/i);
    expect(plan.textContent).toMatch(/if the profile were active again/i);
  });

  it('promises no set card will be shown to an archived child, and passes the status to say so', async () => {
    renderPage(<LearningPlannerPage />, { api: plannerApi() });
    const plan = await screen.findByRole('region', { name: /learning plan for riley/i });
    const set = await within(plan).findByRole('listitem', { name: /daily practice/i });
    // The hypothetical the notice licenses, not a promise the archived profile cannot keep.
    expect(set.textContent).toMatch(/would open for riley from/i);
    expect(set.textContent).toMatch(/once the profile is active again/i);
    expect(plan.textContent).not.toMatch(/shown to (your child|riley)/i);
  });
});
