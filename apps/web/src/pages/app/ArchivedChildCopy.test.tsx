import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

/** One saved test date, so the section renders its list rather than an error state. */
const oneTestDate = {
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

function plannerApi(overview?: unknown) {
  return api(
    (path) =>
      path.endsWith('/subjects')
        ? oneSubject
        : path.endsWith('/learning-schedule')
          ? scheduleWithReleases
          : path.endsWith('/test-dates')
            ? oneTestDate
            : path.includes('/practice-sets')
              ? oneSet
              : undefined,
    overview ?? family,
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

/**
 * HUNT6-H-1: the planner mounted every editing section for an archived child, with no branch on the
 * status, and each one offered a write the API refuses: PUT /learning-schedule, POST/PATCH /subjects,
 * POST and DELETE /test-dates, POST /study-materials all go through `ownedChild(c, 'write')`, which
 * answers 422 BUSINESS_RULE CHILD_ARCHIVED (apps/api/src/routes/learning.ts). The reads take `'read'`,
 * which admits an archived profile, so the sections really did mount and really were live. A parent
 * who archived a child to free a slot could edit the daily practice time, press Save and lose the
 * edit. Asserted here, on the planner, because the wiring is the half that goes missing (HUNT5-F-10).
 */
describe('[HUNT6-H-1] the archived planner offers no write the API refuses', () => {
  it('drops every write control while keeping the stored plan readable', async () => {
    renderPage(<LearningPlannerPage />, { api: plannerApi() });
    const plan = await screen.findByRole('region', { name: /learning plan for riley/i });
    // The sections have to be MOUNTED before their controls can be asserted absent: the schedule and
    // the test dates each load from their own GET, and a queryBy on a half-rendered page passes for
    // the wrong reason.
    await within(plan).findByRole('region', { name: /coming up for riley/i });
    await within(plan).findByLabelText('Saved test dates');
    expect(within(plan).getByRole('heading', { name: 'Subjects' })).toBeTruthy();
    expect(
      within(plan).getByRole('heading', { name: /spelling lists and class notes/i }),
    ).toBeTruthy();
    // Every submit that a 422 CHILD_ARCHIVED is waiting for.
    expect(within(plan).queryByRole('button', { name: /save schedule/i })).toBeNull();
    expect(within(plan).queryByRole('button', { name: /add subject/i })).toBeNull();
    expect(within(plan).queryByRole('button', { name: /save test date/i })).toBeNull();
    expect(within(plan).queryByRole('button', { name: /^save$/i })).toBeNull();
    expect(within(plan).queryByRole('button', { name: /remove the math test/i })).toBeNull();
    // The subject toggle is a PATCH, so it must not be pressable either.
    for (const box of within(plan).getAllByRole('checkbox')) {
      expect(box).toHaveProperty('disabled', true);
    }
    // And the plan the notice promises stays readable is still all there.
    expect(within(plan).getByLabelText(/daily questions/i)).toHaveProperty('value', '5');
    expect(within(plan).getByLabelText('Saved test dates').textContent).toMatch(
      /adding fractions/i,
    );
    expect(plan.textContent).toMatch(/Math/);
    expect(plan.textContent).toMatch(/can’t be changed while the profile is archived/i);
  });

  it('keeps every write control for a DRAFT child, which the API keeps writable on purpose', async () => {
    // `ownedChild` admits a draft for 'write' deliberately: a parent sets the plan up before a paid
    // slot is assigned, and a store downgrade puts a formerly active child back into this state.
    renderPage(<LearningPlannerPage />, {
      api: plannerApi(familyWith({ ...archivedRiley, status: 'draft' })),
    });
    const plan = await screen.findByRole('region', { name: /learning plan for riley/i });
    await within(plan).findByRole('region', { name: /coming up for riley/i });
    await within(plan).findByLabelText('Saved test dates');
    expect(within(plan).getByRole('button', { name: /save schedule/i })).toBeTruthy();
    expect(within(plan).getByRole('button', { name: /add subject/i })).toBeTruthy();
    expect(within(plan).getByRole('button', { name: /save test date/i })).toBeTruthy();
    expect(within(plan).getByRole('button', { name: /remove the math test/i })).toBeTruthy();
    for (const box of within(plan).getAllByRole('checkbox')) {
      expect(box).toHaveProperty('disabled', false);
    }
  });
});

/**
 * HUNT6-H-4: `releaseSlotlessProfiles` (apps/api/src/services/billing-sync.ts) sets `status = 'draft'`
 * on a previously ACTIVE child whenever verified provider state releases its slot — an expiry or a
 * store-confirmed downgrade. So "draft" is not only a profile that has never been paid for, and the
 * planner's draft notice told such a family their child "doesn’t have a paid slot YET … once they have
 * one", as if they had never paid for them. It is the same falsehood WEBR4-10 removed for archived
 * children, left standing because the comment above that branch assumed a draft is always
 * pre-purchase. The product says it correctly elsewhere: HomeworkPage's allowance card says "doesn’t
 * hold a paid child slot right now (for example after the plan changed to fewer children)".
 */
describe('[HUNT6-H-4] the draft notice does not claim the child never had a paid slot', () => {
  it('is state-neutral for a profile a downgrade left as a draft, and names both remedies', async () => {
    renderPage(<LearningPlannerPage />, {
      api: plannerApi(familyWith({ ...archivedRiley, status: 'draft' })),
    });
    const plan = await screen.findByRole('region', { name: /learning plan for riley/i });
    await within(plan).findByRole('region', { name: /coming up for riley/i });
    expect(plan.textContent).not.toMatch(/doesn’t have a paid slot yet/i);
    expect(plan.textContent).not.toMatch(/once they have one/i);
    // What is true for both populations, in the words HomeworkPage already uses.
    expect(plan.textContent).toMatch(/doesn’t have a paid slot right now/i);
    // Both ways a slot is got: an unused one assigned on the Children page (no purchase), or
    // capacity added in the store from the Subscription page (WEB-R1-04).
    expect(within(plan).getByRole('link', { name: /children page/i })).toBeTruthy();
    expect(within(plan).getByRole('link', { name: /subscription/i })).toBeTruthy();
  });
});

/**
 * G-THIRD-NOTICE: the portal has THREE deletion notices off the same `deletionPending` flag, and
 * G-I3-WEB corrected two. `deletionPending` carries no requester — GET /v1/family computes it from
 * the open request's scope and target and never exposes `deletion_requests.requested_by`
 * (apps/api/src/routes/family.ts) — any guardian may delete a child's data, and a child-scope
 * request leaves every other adult's membership active, so the family's OTHER adult is served the
 * same flag. The planner's notice still said "You asked for {name}'s data to be deleted", telling
 * that adult they had asked for something they may never have heard of. The other two name the open
 * request instead; the third has to, and a fourth must not be able to appear unnoticed.
 */
const PORTAL_SRC = resolve(import.meta.dirname, '../..');

/** Every portal source file (not its tests), as { path, text }. */
function portalSources(): { path: string; text: string }[] {
  return readdirSync(PORTAL_SRC, { recursive: true, encoding: 'utf8' })
    .filter((rel) => /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel))
    .map((rel) => ({ path: rel, text: readFileSync(join(PORTAL_SRC, rel), 'utf8') }));
}

/** The words every deletion notice leads with, and the status label the pickers print. */
const NOTICE_MARKER = 'Data deletion under way';

describe('[G-THIRD-NOTICE] no deletion notice in the portal claims the reader asked for it', () => {
  it('names the open request on the planner, in the words the other two notices use', async () => {
    renderPage(<LearningPlannerPage />, {
      api: api((path) => (path.endsWith('/subjects') ? childNotFound() : undefined), deletingRiley),
    });
    const plan = await screen.findByRole('region', { name: /learning plan for riley/i });
    expect(plan.textContent).not.toMatch(/\byou asked\b/i);
    expect(plan.textContent).toMatch(/deletion request covering Riley’s data is open/i);
    // Still says what is happening, and where a mistake is actually handled.
    expect(plan.textContent).toMatch(/deletion can’t be undone/i);
    expect(within(plan).getByRole('link', { name: /privacy page/i })).toBeTruthy();
    expect(within(plan).getByRole('link', { name: /contact support/i })).toBeTruthy();
  });

  it('holds for every deletion notice in the portal source, so a fourth cannot slip in', () => {
    const offenders: string[] = [];
    let notices = 0;
    for (const { path, text } of portalSources()) {
      for (
        let at = text.indexOf(NOTICE_MARKER);
        at !== -1;
        at = text.indexOf(NOTICE_MARKER, at + 1)
      ) {
        // The notice's own paragraph: to its closing tag, and never more than one block of copy.
        const close = text.indexOf('</p>', at);
        const block = text.slice(at, Math.min(close === -1 ? text.length : close, at + 900));
        notices += 1;
        if (/\byou asked\b/i.test(block)) offenders.push(`${path}: ${block.slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
    // Not vacuous: the three notices (plus the pickers' status label) are really being read.
    expect(notices).toBeGreaterThanOrEqual(3);
  });

  it('and no other portal copy tells the reader they asked for a deletion', () => {
    const offenders: string[] = [];
    for (const { path, text } of portalSources()) {
      for (const match of text.matchAll(/\byou asked\b/gi)) {
        const at = match.index;
        const around = text.slice(Math.max(0, at - 600), at + 600);
        if (/delet/i.test(around)) offenders.push(`${path}:${at} ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
