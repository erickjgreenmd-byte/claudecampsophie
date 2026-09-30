import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
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
 * HUNT7-H-4: two sections of ONE page must not tell the parent opposite things. The schedule section's
 * empty-review line asked for a subject to be turned on; the subjects section, disabled by round 6's
 * fix for the same status, says on the same page that subjects can't be turned on or off. The state
 * that reaches the empty list is a profile with no ENABLED bank subject, which is why the fixtures
 * below turn the subject off and empty `nextReviewReleases` together — that is what
 * `scheduleResponse` answers for such a profile (apps/api/src/routes/learning.ts). Asserted at PAGE
 * level, over the pair, because the contradiction is between two components and neither one can see
 * it: this is the third time this shape has been filed (BUG-282, HUNT5-F-10). Synthetic names only.
 */
const subjectTurnedOff = {
  subjects: [{ ...oneSubject.subjects[0]!, enabled: false }],
};
const noReviewsScheduled = { ...scheduleWithReleases, nextReviewReleases: [] };

function noSubjectOnApi(overview?: unknown) {
  return api(
    (path) =>
      path.endsWith('/subjects')
        ? subjectTurnedOff
        : path.endsWith('/learning-schedule')
          ? noReviewsScheduled
          : path.endsWith('/test-dates')
            ? oneTestDate
            : path.includes('/practice-sets')
              ? oneSet
              : undefined,
    overview ?? family,
  );
}

describe('[HUNT7-H-4] the archived planner’s two cards agree about the subject toggle', () => {
  it('never asks for a subject to be turned on beside the notice that says it can’t be', async () => {
    renderPage(<LearningPlannerPage />, { api: noSubjectOnApi() });
    const plan = await screen.findByRole('region', { name: /learning plan for riley/i });
    await within(plan).findByRole('region', { name: /coming up for riley/i });
    // Both halves of the contradiction would be in this one region, so the assertion is over the pair.
    expect(plan.textContent).toMatch(/can’t be turned on or off/i);
    expect(plan.textContent).not.toMatch(/turn on at least one subject/i);
    // The control the old sentence named really is dead, which is what made it a contradiction.
    for (const box of within(plan).getAllByRole('checkbox')) {
      expect(box).toHaveProperty('disabled', true);
    }
    // And the parent's real move is on the page, as the other notices already say it.
    expect(within(plan).getAllByRole('link', { name: /children page/i }).length).toBeGreaterThan(0);
  });

  it('does not deny the custom subject the Subjects card beside it prints as On', async () => {
    // The state the first repair got wrong: a custom subject is enabled, so "no subject is on" is
    // false, and this page renders the refutation in the very next card. `generatedPractice` is false
    // for it — the subjects GET computes that as `isBankSubject(row.subject_key)`
    // (apps/api/src/routes/learning.ts) — so it yields no weekly review, which is what the line may
    // say. Asserted over the whole plan region, so the pair is read together.
    const custom = {
      subjects: [
        {
          id: '2f6a7b8c-9d0e-4f12-8345-67890abcdef1',
          subjectKey: 'custom',
          displayName: 'Band',
          enabled: true,
          generatedPractice: false,
        },
      ],
    };
    renderPage(<LearningPlannerPage />, {
      api: api(
        (path) =>
          path.endsWith('/subjects')
            ? custom
            : path.endsWith('/learning-schedule')
              ? noReviewsScheduled
              : path.endsWith('/test-dates')
                ? oneTestDate
                : path.includes('/practice-sets')
                  ? oneSet
                  : undefined,
        family,
      ),
    });
    const plan = await screen.findByRole('region', { name: /learning plan for riley/i });
    await within(plan).findByRole('region', { name: /coming up for riley/i });
    // The Subjects card really does say this subject is on, which is the other half of the pair.
    expect(plan.textContent).toMatch(/Band/);
    expect(plan.textContent).toMatch(/On/);
    expect(plan.textContent).not.toMatch(/no subject is on/i);
    expect(plan.textContent).toMatch(/no subject that gets a weekly review is on/i);
  });

  it('keeps the instruction on a DRAFT child’s planner, where the toggle works', async () => {
    const draftRiley = familyWith({ ...archivedRiley, status: 'draft' });
    renderPage(<LearningPlannerPage />, { api: noSubjectOnApi(draftRiley) });
    const plan = await screen.findByRole('region', { name: /learning plan for riley/i });
    await within(plan).findByRole('region', { name: /coming up for riley/i });
    expect(plan.textContent).toMatch(/turn on at least one subject/i);
    expect(plan.textContent).not.toMatch(/can’t be turned on or off/i);
    for (const box of within(plan).getAllByRole('checkbox')) {
      expect(box).toHaveProperty('disabled', false);
    }
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

/**
 * Every portal source file (not its tests), as { path, text } — with COMMENTS REMOVED, so the sweeps
 * below read what the product says to a parent and not what this repo says to the next engineer. Block
 * comments (including JSX `{/* … *\/}`) and whole-line `//` comments go; a `//` inside a string, such
 * as a URL, stays, because only lines that BEGIN with it are dropped (HUNT7-G-6).
 */
function portalCopy(): { path: string; text: string }[] {
  return readdirSync(PORTAL_SRC, { recursive: true, encoding: 'utf8' })
    .filter((rel) => /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel))
    .map((rel) => ({
      path: rel,
      text: readFileSync(join(PORTAL_SRC, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^[ \t]*\/\/.*$/gm, ' '),
    }));
}

/**
 * The deletion notice's lead sentence AS RENDERED COPY, which is what makes this a count of notices.
 *
 * HUNT7-G-6: the sweep used to find blocks by the bare string 'Data deletion under way', which also
 * appears as a `return 'Data deletion under way';` inside childStatusLabel and as HomeworkPage's
 * section aria-label — so its `notices >= 3` floor was met by a status label, an aria-label and ONE
 * real notice, and two of the three paragraphs could be deleted with the floor still green. For the
 * label occurrence the "paragraph" was not copy at all: `indexOf('</p>')` from it ran to the deletion
 * notice's closing tag hundreds of lines later and was cut off by the character cap, so the block
 * scanned was code and comments.
 */
const NOTICE_LEAD = '<strong>Data deletion under way.</strong>';

/** How many deletion notices the portal has. Pinned exactly, so a deleted notice fails here. */
const DELETION_NOTICES = 3;

/**
 * Attributing a deletion REQUEST to the reader, as a set rather than as the one phrase the last defect
 * happened to use (L-057). "you asked" was all the round-6 sweep knew, so "you requested", "you’ve
 * asked", "at your request" and "your deletion request" all passed it.
 */
const READER_ASKED =
  /\byou(?:’ve|'ve| have)? (?:asked|requested|chose|started)\b|\bat your request\b|\byour (?:deletion )?request\b|\byou deleted\b/gi;

/**
 * Attributing a CHANGE to another adult (HUNT7-G-2). The actor phrase alone is not the defect — the
 * guardian invite legitimately says "The other adult must sign in with this email" — so an offender is
 * an actor phrase and a writing verb in ONE sentence, which is the shape of "Another guardian changed
 * the grade to Grade 4".
 */
const OTHER_ADULT = /\b(?:another|the other|a second) (?:guardian|adult|parent)\b/gi;
const WROTE_IT =
  /\b(?:changed|changes|edited|updated|renamed|deleted|archived|asked|requested|set)\b/i;

/** Where each named function of a file starts, in order. The unit the sweep below is bounded to. */
function functionStarts(text: string): { name: string; at: number }[] {
  return [...text.matchAll(/function (\w+)/g)].map((match) => ({
    name: match[1]!,
    at: match.index,
  }));
}

// `enclosingFunction` used to live here, to allow ONE named function to carry the "you asked for a
// deletion" sentence. HUNT7-E-1 moved that sentence into the shared contract, so the portal now needs
// no allowance at all and the guard is strictly stronger: not "at most one, and only there" but "none
// here, and the one that exists is in the contract". The helper went with the allowance rather than
// being left unused. `functionStarts` stays — `componentAround` below still uses it.

/**
 * The COMPONENT a match sits in: from the function declaration that encloses it to the next one, or
 * the end of the file.
 *
 * L-054, and the same mechanism the lead condemned in HUNT7-G-6: a negative assertion is only as good
 * as its window, and this one used to be a "sentence" ending at the first '.' after the match. In JSX
 * that '.' is almost always inside an interpolation — `{drifted.join(' and ')}`,
 * `{gradeLabel(child.gradeLevel)}` — so "Another guardian {drifted.join(' and ')} changed this profile
 * while this form was open." was cut at `{drifted.` and the writing verb after the interpolation was
 * never seen: the offending copy this case exists to stop passed it. Its green run depended on the
 * accident that "changed" happened to precede the interpolation. Widening the window to the whole
 * function cannot be evaded by moving words around inside the copy, and it costs nothing here: the
 * portal's one legitimate actor phrase is in `InviteForm` (GuardiansPage), whose body has no writing
 * verb at all. A future component that needs both has to say so, the way `stillSignedInCopy` is named
 * in the case above.
 */
function componentAround(text: string, at: number): { name: string; body: string } {
  const starts = functionStarts(text);
  let from = 0;
  let name = '';
  let to = text.length;
  for (const start of starts) {
    if (start.at <= at) {
      from = start.at;
      name = start.name;
    } else {
      to = start.at;
      break;
    }
  }
  return { name, body: text.slice(from, to).replace(/\s+/g, ' ') };
}

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

  it('holds for every deletion notice in the portal source, and counts the notices exactly', () => {
    const offenders: string[] = [];
    const found: string[] = [];
    for (const { path, text } of portalCopy()) {
      for (let at = text.indexOf(NOTICE_LEAD); at !== -1; at = text.indexOf(NOTICE_LEAD, at + 1)) {
        const close = text.indexOf('</p>', at);
        const block = text.slice(at, close === -1 ? text.length : close);
        found.push(path);
        // Each notice says what the response can establish: that a request covering this child's data
        // is open. A notice that stopped saying it would fail here as loudly as one that blamed the
        // reader.
        if (!/deletion request covering/i.test(block))
          offenders.push(`${path}: no open-request line`);
        for (const match of block.matchAll(READER_ASKED)) {
          offenders.push(`${path}: “${match[0]}” in ${block.slice(0, 90)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // Not vacuous, and not satisfied by a status label or an aria-label: these are the rendered lead
    // sentences of the three notices, one per surface, and the count is exact in both directions.
    expect(found).toHaveLength(DELETION_NOTICES);
    expect([...found].sort()).toEqual([
      'pages/app/ChildrenPage.tsx',
      'pages/app/HomeworkPage.tsx',
      'pages/app/LearningPlannerPage.tsx',
    ]);
  });

  it('and no other portal copy tells the reader they asked for a deletion', () => {
    /**
     * The one sentence that may: `stillSignedInCopy` (PrivacyControlsPage) reports the outcome of the
     * account closure the reader has just pressed in that same flow, so "Your request is recorded" is
     * the reader's own request by construction — unlike a `deletionPending` flag, which GET /v1/family
     * computes from the request's scope and target and serves to every adult in the family
     * (apps/api/src/routes/family.ts). Named here rather than excluded by a narrower pattern, so a
     * FOURTH copy still has to come past this case; asserted below, so it cannot quietly stop existing.
     */
    // WHERE THE ALLOWED SENTENCE LIVES MOVED, and this case had to move with it. HUNT7-E-1 took the
    // closure outcome out of `stillSignedInCopy` and into the shared contract, because a `pending`
    // closure has TWO causes (a family purge, or a refused close the queue is retrying) and the portal
    // was printing the purge sentence for both. That left this guard with zero allowed occurrences and
    // the web suite red — two agents in one stage with DISJOINT FILE LISTS and a shared INVARIANT,
    // which file-level ownership cannot separate.
    //
    // Both halves of the guard are kept. No portal source may carry the sentence at all now; and the
    // one legitimate copy must still exist where it moved to, so it cannot quietly stop existing.
    const offenders: string[] = [];
    for (const { path, text } of portalCopy()) {
      for (const match of text.matchAll(READER_ASKED)) {
        const at = match.index;
        const around = text.slice(Math.max(0, at - 600), at + 600);
        if (!/delet/i.test(around)) continue;
        offenders.push(`${path}:${at} ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);

    // Anti-vacuity, in the contract that now owns it: the pending-after-purge outcome still says it,
    // and it is the ONLY pending outcome that mentions a deletion — the `retrying` arm must not, which
    // is the whole of HUNT7-E-1.
    const contract = readFileSync(
      join(
        import.meta.dirname,
        '..',
        '..',
        '..',
        '..',
        '..',
        'packages',
        'contracts',
        'src',
        'account.ts',
      ),
      'utf8',
    );
    const deletionClaims = [...contract.matchAll(READER_ASKED)].filter((m) =>
      /delet/i.test(contract.slice(Math.max(0, m.index - 300), m.index + 300)),
    );
    expect(deletionClaims.length).toBeGreaterThan(0);
    expect(contract).toMatch(/after_family_purge/);
  });

  it('and no portal copy attributes a change to an adult the response cannot name', () => {
    // HUNT7-G-2: GET /v1/family carries no actor — `familyChildSchema` and
    // `familyOverviewResponseSchema` are strict objects with no such field
    // (packages/contracts/src/family.ts) and the route selects no such column — so no copy driven by
    // it may name one. Two writers that are not another guardian reach the same diff: the reader on
    // the phone app or a second tab, and the reader's own save whose reload failed.
    //
    // L-054: bounded to the enclosing COMPONENT, not to a sentence — see `componentAround` for the
    // interpolation that made a sentence window evadable by the very copy this case exists to stop.
    const offenders: string[] = [];
    const scanned: string[] = [];
    for (const { path, text } of portalCopy()) {
      for (const match of text.matchAll(OTHER_ADULT)) {
        const { name, body } = componentAround(text, match.index);
        scanned.push(`${path}:${name}`);
        if (WROTE_IT.test(body)) offenders.push(`${path}: ${name}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
    // Not vacuous: the portal's one legitimate actor phrase is still there and still being read, so a
    // sweep that stopped matching anything at all would fail here.
    expect(scanned).toEqual(['pages/app/GuardiansPage.tsx:InviteForm']);
  });
});

/**
 * HUNT7-E-3: `ARCHIVED_CHILD_NO_NEW_SCAN_COPY` and `INACTIVE_CHILD_NO_NEW_SCAN_COPY` were put in
 * packages/contracts/src/privacy.ts with the reason "here rather than in a page so the portal and the
 * app say the same thing". Nothing under apps/mobile has ever imported either: the app has no
 * parent-facing assignment list, and apps/mobile/src/homework/ holds the CHILD's screens. A reason that
 * is not true is worse than no reason, because the next reader stops looking for the app's own copy —
 * the same over-claim HUNT6-F-SHARED-COPY corrected in packages/contracts/src/account.ts. Two sibling
 * docblocks in that file gave the identical reason, so it was house style rather than one slip, and it
 * is decided here for all of them at once.
 *
 * The rule is a BICONDITIONAL, so this is not a ban on a phrase: a docblock may say another surface
 * prints its string exactly when some file under apps/mobile imports it. `PARENT_SAFETY_FLAG_ACTIONS`
 * is that case and is checked as the positive row — apps/mobile/src/privacy/parent-privacy.ts does
 * import it — which also proves the detector fires on a real claim rather than on nothing. Give the app
 * a parent homework surface later and the negative rows fail, which is when the claim needs deciding
 * again.
 */
const REPO = resolve(import.meta.dirname, '../../../../..');

/** Where the copy is defined; excluded from the importer sweep, since defining is not printing. */
const CONTRACT_FILE = 'packages/contracts/src/privacy.ts';

/** `app: true` means some app file is expected to print this string too. */
const AUDIENCE_ROWS = [
  { name: 'CONSENT_WITHDRAWN_SCAN_COPY', app: false },
  { name: 'ARCHIVED_CHILD_SCAN_COPY', app: false },
  { name: 'ARCHIVED_CHILD_NO_NEW_SCAN_COPY', app: false },
  { name: 'INACTIVE_CHILD_NO_NEW_SCAN_COPY', app: false },
  { name: 'PARENT_SAFETY_FLAG_ACTIONS', app: true },
] as const;

/**
 * Every source root in the repo, so "only the portal prints it" is a claim about the product and not
 * about one app. Roots rather than a walk from the repo root: node_modules, build output and the native
 * projects hold neither imports of ours nor any copy.
 */
function sourceRoots(): string[] {
  const roots = ['apps/api/src', 'apps/web/src', 'apps/mobile/src', 'apps/mobile/app'];
  for (const pkg of readdirSync(join(REPO, 'packages'))) roots.push(`packages/${pkg}/src`);
  return roots;
}

/** Repo-relative paths of every non-test source file, as forward-slash paths. */
function sourceFiles(): string[] {
  return sourceRoots().flatMap((root) =>
    readdirSync(join(REPO, root), { recursive: true, encoding: 'utf8' })
      .filter((rel) => /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel))
      .map((rel) => `${root}/${rel.split(sep).join('/')}`),
  );
}

/**
 * Files that PRINT the string, not files that mention the name. Comments are stripped first (the same
 * way `portalCopy` above strips them), because the corrected docblock in
 * apps/mobile/src/homework/result-view.ts names both constants in order to say the app does NOT print
 * them — a sweep that counted that as an import would report the very claim it exists to refute.
 */
function importersOf(name: string): string[] {
  return sourceFiles().filter(
    (path) =>
      path !== CONTRACT_FILE &&
      readFileSync(join(REPO, path), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^[ \t]*\/\/.*$/gm, ' ')
        .includes(name),
  );
}

/** The doc comment immediately above `export const NAME =`. */
function docblockAbove(text: string, name: string): string {
  const at = text.indexOf(`export const ${name} =`);
  expect(at).toBeGreaterThan(0);
  const end = text.lastIndexOf('*/', at);
  const start = text.lastIndexOf('/**', end);
  expect(start).toBeGreaterThan(0);
  return text.slice(start, end + 2);
}

/**
 * Ways of saying that another surface prints this same string. Deliberately wider than the one sentence
 * removed, because the defect is the CLAIM and not its wording; a docblock that describes what the app
 * says INSTEAD ("the app's own line is `statusView` …") asserts nothing of the kind and must not match.
 */
const SAMENESS_CLAIM =
  /say the same|says the same|same (?:sentence|wording|words|copy|line)|shared with the (?:app|phone)|both (?:surfaces|clients)|every surface/i;

describe('[HUNT7-E-3] a shared-copy reason is given only where the app really prints the copy', () => {
  const contract = readFileSync(join(REPO, CONTRACT_FILE), 'utf8');

  it('the portal-only lines are imported by the portal page alone, and no app file', () => {
    const importers = Object.fromEntries(
      AUDIENCE_ROWS.filter((row) => !row.app).map((row) => [row.name, importersOf(row.name)]),
    );
    expect(importers).toEqual({
      CONSENT_WITHDRAWN_SCAN_COPY: ['apps/web/src/pages/app/HomeworkPage.tsx'],
      ARCHIVED_CHILD_SCAN_COPY: ['apps/web/src/pages/app/HomeworkPage.tsx'],
      ARCHIVED_CHILD_NO_NEW_SCAN_COPY: ['apps/web/src/pages/app/HomeworkPage.tsx'],
      INACTIVE_CHILD_NO_NEW_SCAN_COPY: ['apps/web/src/pages/app/HomeworkPage.tsx'],
    });
  });

  it('so each of their docblocks names that page, and claims no surface that does not print it', () => {
    for (const { name } of AUDIENCE_ROWS.filter((row) => !row.app)) {
      const doc = docblockAbove(contract, name);
      expect(doc).toContain('apps/web/src/pages/app/HomeworkPage.tsx');
      expect(doc).not.toMatch(SAMENESS_CLAIM);
      // Hedged, not deleted: the reader is still sent to the app's own child-facing line.
      expect(doc).toContain('apps/mobile/src/homework/result-view.ts');
    }
  });

  it('while copy the app does print may still say so — and one does', () => {
    for (const { name } of AUDIENCE_ROWS.filter((row) => row.app)) {
      expect(importersOf(name).filter((path) => path.startsWith('apps/mobile/'))).not.toEqual([]);
      expect(docblockAbove(contract, name)).toMatch(SAMENESS_CLAIM);
    }
  });
});
