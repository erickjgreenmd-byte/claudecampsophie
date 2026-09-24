import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assignmentDetailResponseSchema,
  assignmentListResponseSchema,
  assignmentSolutionsResponseSchema,
  childPracticeTodayResponseSchema,
  childSubjectsResponseSchema,
  learningScheduleResponseSchema,
  pointsHistoryResponseSchema,
  practiceSetsResponseSchema,
  rewardsOverviewResponseSchema,
  skillsResponseSchema,
  testDatesResponseSchema,
} from '@pencillift/contracts';
import { cryptoRandom } from '@pencillift/domain';
import { keyAnswerText, type AnswerSpec } from '@pencillift/domain/bank';
import {
  grantAdultUnlock,
  seedChild,
  seedFamily,
  type SeededFamily,
} from '@pencillift/db/testing/fixtures';
import { runJobs, type JobDeps } from '../src/jobs/dispatcher.ts';
import { createLearningHandlers, enqueueDueLearningJobs } from '../src/jobs/learning-jobs.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * AC_CAPACITY_08 / spec P11 "keep history for inactive profiles": an archived or downgraded-to-draft
 * profile keeps parent-readable history (learning, rewards, homework, exports) while every write
 * that would plan, store or generate something new for an archived profile is refused. Children of
 * a tombstoned family, and a child whose data deletion is under way, stay invisible.
 *
 * Synthetic family `fam`: Riley (history, then archived by the parent), Sam (history, then
 * downgraded back to draft), Jordan (history, then a child-data deletion is requested) and Avery
 * (archived before any learning setup). `other` is an unrelated family; `gone` is tombstoned.
 */

let api: TestApi;
let deps: JobDeps;
let fam: SeededFamily;
let other: SeededFamily;
let gone: SeededFamily;
let token: string; // unlocked parent session of `fam`
let lockedToken: string; // same parent, no step-up
let otherToken: string; // unlocked parent of `other`
let goneToken: string; // unlocked owner of the tombstoned family
let pairCount = 0;
const SESSION = 'a4a4a4a4-1111-4111-8111-111111111111';
const LOCKED_SESSION = 'b5b5b5b5-2222-4222-8222-222222222222';
const OTHER_SESSION = 'c6c6c6c6-3333-4333-8333-333333333333';
const GONE_SESSION = 'd7d7d7d7-4444-4444-8444-444444444444';

type ErrorBody = { error: { code: string; rule?: string; message: string } };

const RILEY = () => fam.children[0]!.id;
const SAM = () => fam.children[1]!.id;
const JORDAN = () => fam.children[2]!.id;
const AVERY = () => fam.children[3]!.id;

const at = (iso: string) => {
  api.now.value = new Date(iso);
};

async function childToken(family: SeededFamily, parent: string, index: number): Promise<string> {
  const code = await api.request(`/v1/children/${family.children[index]!.id}/pairing-code`, {
    method: 'POST',
    token: parent,
  });
  expect(code.status).toBe(201);
  pairCount += 1;
  const paired = await api.request('/v1/child/pair', {
    method: 'POST',
    headers: { 'cf-connecting-ip': `192.0.2.${pairCount}` },
    body: {
      code: (await json<{ code: string }>(code)).code,
      deviceLabel: `Tablet ${pairCount}`,
      platform: 'ios',
    },
  });
  expect(paired.status).toBe(201);
  return (await json<{ accessToken: string }>(paired)).accessToken;
}

async function getJson(path: string, t = token): Promise<{ status: number; body: unknown }> {
  const res = await api.request(path, { token: t });
  return { status: res.status, body: await res.json() };
}

/** Every parent learning read for one child. */
const learningReads = (childId: string) => [
  `/v1/children/${childId}/subjects`,
  `/v1/children/${childId}/learning-schedule`,
  `/v1/children/${childId}/test-dates`,
  `/v1/children/${childId}/skills`,
  `/v1/children/${childId}/practice-sets`,
];

/** Row counts of everything a learning write (or a lazily created default) could add. */
async function learningRows(childId: string): Promise<Record<string, number>> {
  const [row] = await api.db.sql<Record<string, number>[]>`
    select (select count(*)::int from public.child_subjects where child_id = ${childId}) as subjects,
           (select count(*)::int from public.learning_schedules where child_id = ${childId}) as schedules,
           (select coalesce(max(schedule_version), 0)::int from public.learning_schedules where child_id = ${childId}) as version,
           (select count(*)::int from public.test_dates where child_id = ${childId}) as test_dates,
           (select count(*)::int from public.study_materials where child_id = ${childId}) as materials,
           (select count(*)::int from public.practice_sets where child_id = ${childId}) as sets,
           (select count(*)::int from public.jobs where child_id = ${childId}) as jobs`;
  return row!;
}

/**
 * Labeled fixture standing in for the scan pipeline: one finished homework scan (page, question,
 * private solution, result) walked through the real state machine to `ready`.
 */
async function readyScan(family: SeededFamily, childId: string): Promise<string> {
  const [assignment] = await api.db.sql<{ id: string }[]>`
    insert into public.assignments (family_id, child_id, idempotency_key, created_by_kind, page_count)
    values (${family.familyId}, ${childId}, ${'hist-' + randomUUID()}, 'parent', 1)
    returning id`;
  const id = assignment!.id;
  const [page] = await api.db.sql<{ id: string }[]>`
    insert into public.source_pages (assignment_id, family_id, child_id, page_number, storage_path, mime_type, byte_size, sha256)
    values (${id}, ${family.familyId}, ${childId}, 1, ${`${family.familyId}/${childId}/${id}/p1.jpg`},
            'image/jpeg', 1000, ${createHash('sha256').update(id).digest('hex')})
    returning id`;
  const [question] = await api.db.sql<{ id: string }[]>`
    insert into public.extracted_questions
      (assignment_id, family_id, child_id, page_id, question_number, prompt_text, student_answer_text,
       answer_kind, subject_key, skill, uncertainty)
    values (${id}, ${family.familyId}, ${childId}, ${page!.id}, '1', 'What is 6 x 7?', '42',
            'numeric', 'math', 'multiplication', 'low')
    returning id`;
  await api.db.sql`
    insert into private.question_solutions (question_id, family_id, correct_answer, worked_solution, grader_version)
    values (${question!.id}, ${family.familyId}, '42', 'Six groups of seven make 42.', 'g1')`;
  await api.db.sql`
    insert into public.question_results (question_id, family_id, child_id, verdict, route, disagreement, grader_version)
    values (${question!.id}, ${family.familyId}, ${childId}, 'correct', 'deterministic', false, 'g1')`;
  for (const status of ['uploading', 'queued', 'extracting', 'checking', 'verifying', 'ready']) {
    await api.db.sql`update public.assignments set status = ${status} where id = ${id}`;
  }
  return id;
}

async function balance(childId: string): Promise<number> {
  const [row] = await api.db.sql<{ balance: number }[]>`
    select balance from public.point_balances where child_id = ${childId}`;
  return row?.balance ?? 0;
}

const before = new Map<string, unknown>(); // Riley's parent views before the archive
let rileySetId: string;
let rileyScanId: string;
let jordanScanId: string;
let rileyTestDateId: string;
let rileyMathId: string;
let rileyRequestId: string;

beforeAll(async () => {
  api = await createTestApi({ CHILD_ACCESS_TTL_SECONDS: String(10 * 86_400) });
  deps = {
    db: api.apiDb,
    config: api.config,
    clock: () => api.now.value,
    random: cryptoRandom,
    providers: api.providers,
    log: (e) => api.logs.push(e),
  };
  fam = await seedFamily(api.db, { childCount: 4, timezone: 'America/Chicago' });
  other = await seedFamily(api.db, { childCount: 1, timezone: 'America/Chicago' });
  gone = await seedFamily(api.db, { childCount: 1, timezone: 'America/Chicago' });
  await grantAdultUnlock(api.db, fam.ownerId, SESSION, 3600);
  await grantAdultUnlock(api.db, other.ownerId, OTHER_SESSION, 3600);
  await grantAdultUnlock(api.db, gone.ownerId, GONE_SESSION, 3600);
  token = await parentToken(fam.ownerId, { sessionId: SESSION });
  lockedToken = await parentToken(fam.ownerId, { sessionId: LOCKED_SESSION });
  otherToken = await parentToken(other.ownerId, { sessionId: OTHER_SESSION });
  goneToken = await parentToken(gone.ownerId, { sessionId: GONE_SESSION });

  // Avery is archived before anything was ever planned for her.
  at('2026-09-24T14:00:00Z');
  const archivedAvery = await api.request(`/v1/children/${AVERY()}/archive`, {
    method: 'POST',
    token,
  });
  expect(archivedAvery.status).toBe(200);

  // History while Riley, Sam and Jordan are active: subjects, a test date, study material, a daily
  // set, a graded answer with points, a reward request and a homework scan.
  for (const childId of [RILEY(), SAM(), JORDAN()]) {
    const subjects = childSubjectsResponseSchema.parse(
      (await getJson(`/v1/children/${childId}/subjects`)).body,
    );
    const math = subjects.subjects.find((s) => s.subjectKey === 'math')!;
    const created = await api.request(`/v1/children/${childId}/test-dates`, {
      method: 'POST',
      token,
      body: { subjectId: math.id, testDate: '2026-10-02', scopeNotes: 'multiplication facts' },
    });
    expect(created.status).toBe(201);
    if (childId === RILEY()) {
      rileyMathId = math.id;
      rileyTestDateId = (await json<{ testDate: { id: string } }>(created)).testDate.id;
    }
    const material = await api.request(`/v1/children/${childId}/study-materials`, {
      method: 'POST',
      token,
      body: { kind: 'spelling_list', text: 'apple, river, garden' },
    });
    expect(material.status).toBe(201);
  }
  const riley = await childToken(fam, token, 0);
  at('2026-09-24T21:00:00Z'); // 16:00 CDT, after the 15:30 daily release
  const preparing = childPracticeTodayResponseSchema.parse(
    await json(await api.request('/v1/child/practice/today', { token: riley })),
  );
  expect(preparing.state).toBe('preparing');
  await enqueueDueLearningJobs(deps, api.now.value);
  await runJobs(deps, createLearningHandlers());
  const [set] = await api.db.sql<{ id: string }[]>`
    select id from public.practice_sets where child_id = ${RILEY()} and kind = 'daily'`;
  rileySetId = set!.id;
  const [first] = await api.db.sql<{ item_id: string; answer_spec: { spec: AnswerSpec } }[]>`
    select i.id as item_id, k.answer_spec from public.practice_items i
      join private.practice_item_keys k on k.item_id = i.id
     where i.set_id = ${rileySetId} order by i.position limit 1`;
  at('2026-09-24T21:01:00Z');
  const answered = await api.request(`/v1/child/practice/items/${first!.item_id}/answer`, {
    method: 'POST',
    token: riley,
    body: { answer: keyAnswerText(first!.answer_spec.spec), idempotencyKey: randomUUID() },
  });
  expect(answered.status).toBe(200);
  expect(await balance(RILEY())).toBeGreaterThan(0);
  const reward = await api.request('/v1/rewards', {
    method: 'POST',
    token,
    body: { title: 'Pick the movie', pointCost: 1, childId: RILEY() },
  });
  expect(reward.status).toBe(201);
  rileyRequestId = randomUUID();
  const requested = await api.request(
    `/v1/child/rewards/${(await json<{ reward: { id: string } }>(reward)).reward.id}/request`,
    { method: 'POST', token: riley, body: { requestId: rileyRequestId } },
  );
  expect(requested.status).toBe(201);
  // Labeled fixture: a system learning award for Sam (awards are a server-side job, not a route).
  await api.db.sql`
    insert into public.points_ledger (family_id, child_id, kind, points, idempotency_key, actor_kind)
    values (${fam.familyId}, ${SAM()}, 'award', 7, ${'attempt:' + randomUUID()}, 'system')`;
  rileyScanId = await readyScan(fam, RILEY());
  jordanScanId = await readyScan(fam, JORDAN());
  await readyScan(gone, gone.children[0]!.id);

  for (const path of learningReads(RILEY())) {
    const read = await getJson(path);
    expect(read.status, path).toBe(200);
    before.set(path, read.body);
  }

  // Riley: archived by the parent (the real route: frees the slot, ends sessions, keeps history).
  const archived = await api.request(`/v1/children/${RILEY()}/archive`, { method: 'POST', token });
  expect(archived.status).toBe(200);
  // Sam: labeled fixture of a verified downgrade that released his slot (services/billing-sync.ts
  // releaseSlotlessProfiles moves the profile back to draft).
  await api.db.sql`update public.child_profiles set status = 'draft' where id = ${SAM()}`;
  // Jordan: the parent asks for this child's data to be deleted (the purge job has not run yet).
  const deletion = await api.request('/v1/deletion', {
    method: 'POST',
    token,
    body: { scope: 'child', childId: JORDAN() },
  });
  expect(deletion.status).toBe(202);
  // `gone`: the owner deletes the whole family (tombstoned now, purged later).
  const tombstone = await api.request('/v1/deletion', {
    method: 'POST',
    token: goneToken,
    body: { scope: 'family' },
  });
  expect(tombstone.status).toBe(202);
});

afterAll(async () => {
  await api?.close();
});

// ---------------------------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------------------------

describe('an archived child keeps parent-readable learning history (AC_CAPACITY_08)', () => {
  it('every parent learning read still works and shows the same history as before the archive', async () => {
    const rowsBefore = await learningRows(RILEY());
    for (const path of learningReads(RILEY())) {
      const read = await getJson(path);
      expect(read.status, path).toBe(200);
      expect(read.body, path).toEqual(before.get(path));
    }
    const subjects = childSubjectsResponseSchema.parse(
      (await getJson(`/v1/children/${RILEY()}/subjects`)).body,
    );
    expect(subjects.subjects).toHaveLength(6);
    const testDates = testDatesResponseSchema.parse(
      (await getJson(`/v1/children/${RILEY()}/test-dates`)).body,
    );
    expect(testDates.testDates.map((t) => t.id)).toEqual([rileyTestDateId]);
    const skills = skillsResponseSchema.parse(
      (await getJson(`/v1/children/${RILEY()}/skills`)).body,
    );
    expect(skills.skills.length).toBeGreaterThan(0);
    const sets = practiceSetsResponseSchema.parse(
      (await getJson(`/v1/children/${RILEY()}/practice-sets`)).body,
    );
    expect(sets.sets.map((s) => s.id)).toContain(rileySetId);
    expect(sets.sets.find((s) => s.id === rileySetId)!.items[0]!.progress.firstTry).toBe('correct');
    learningScheduleResponseSchema.parse(
      (await getJson(`/v1/children/${RILEY()}/learning-schedule`)).body,
    );
    // Reading history is read-only: no defaults, versions or jobs are created for the profile.
    expect(await learningRows(RILEY())).toEqual(rowsBefore);
  });

  it('the protected answer key and review exports of an archived child stay available', async () => {
    const locked = await api.request(`/v1/practice-sets/${rileySetId}/answer-key`, {
      token: lockedToken,
    });
    expect(locked.status).toBe(403);
    const key = await api.request(`/v1/practice-sets/${rileySetId}/answer-key`, { token });
    expect(key.status).toBe(200);
    const exported = await api.request('/v1/exports/review-pdf', {
      method: 'POST',
      token,
      body: { setId: rileySetId, variant: 'questions' },
    });
    expect(exported.status).toBe(202);
  });

  it('a profile archived before any setup reads as empty history without creating defaults', async () => {
    const subjects = await getJson(`/v1/children/${AVERY()}/subjects`);
    expect(subjects.status).toBe(200);
    expect(childSubjectsResponseSchema.parse(subjects.body).subjects).toEqual([]);
    const schedule = await getJson(`/v1/children/${AVERY()}/learning-schedule`);
    expect(schedule.status).toBe(200);
    const archivedPlan = learningScheduleResponseSchema.parse(schedule.body);
    expect(archivedPlan.nextReviewReleases).toEqual([]);
    for (const path of learningReads(AVERY()).slice(2)) {
      expect((await getJson(path)).status, path).toBe(200);
    }
    expect(await learningRows(AVERY())).toEqual({
      subjects: 0,
      schedules: 0,
      version: 0,
      test_dates: 0,
      materials: 0,
      sets: 0,
      jobs: 0,
    });
    // The plan shown is exactly the database default a new profile gets (guards against drift).
    const fresh = await seedChild(api.db, fam.familyId, 'Kai', 'draft');
    const freshPlan = learningScheduleResponseSchema.parse(
      (await getJson(`/v1/children/${fresh.id}/learning-schedule`)).body,
    );
    expect(archivedPlan.schedule).toEqual(freshPlan.schedule);
    expect(archivedPlan.timezone).toBe(freshPlan.timezone);
  });

  it('every learning write for an archived child is refused and changes nothing', async () => {
    const rowsBefore = await learningRows(RILEY());
    const attempts: [string, string, unknown][] = [
      ['POST', `/v1/children/${RILEY()}/subjects`, { subjectKey: 'custom', displayName: 'Chess' }],
      ['PATCH', `/v1/children/${RILEY()}/subjects`, { subjectId: rileyMathId, enabled: false }],
      [
        'PUT',
        `/v1/children/${RILEY()}/learning-schedule`,
        {
          reviewWeekday: 3,
          reviewLocalTime: '17:00',
          reviewQuestionsPerSubject: 8,
          dailyLocalTime: '15:30',
          dailyQuestionCount: 5,
          pause: null,
          quietHours: null,
          childRemindersPermitted: false,
        },
      ],
      [
        'POST',
        `/v1/children/${RILEY()}/test-dates`,
        { subjectId: rileyMathId, testDate: '2026-10-09' },
      ],
      ['DELETE', `/v1/children/${RILEY()}/test-dates/${rileyTestDateId}`, undefined],
      [
        'POST',
        `/v1/children/${RILEY()}/study-materials`,
        { kind: 'taught_notes', text: 'Fractions on a number line' },
      ],
    ];
    for (const [method, path, body] of attempts) {
      const res = await api.request(path, { method, token, body });
      expect(res.status, `${method} ${path}`).toBe(422);
      const error = (await json<ErrorBody>(res)).error;
      expect(error, `${method} ${path}`).toMatchObject({
        code: 'BUSINESS_RULE',
        rule: 'CHILD_ARCHIVED',
      });
    }
    expect(await learningRows(RILEY())).toEqual(rowsBefore);
  });
});

describe('a downgraded (draft) child keeps its history and gets no new practice work', () => {
  it('parent reads work and setup changes plan no practice for the unpaid profile', async () => {
    for (const path of learningReads(SAM())) {
      expect((await getJson(path)).status, path).toBe(200);
    }
    const rowsBefore = await learningRows(SAM());
    const changed = await api.request(`/v1/children/${SAM()}/learning-schedule`, {
      method: 'PUT',
      token,
      body: {
        reviewWeekday: 2,
        reviewLocalTime: '17:00',
        reviewQuestionsPerSubject: 8,
        dailyLocalTime: '15:30',
        dailyQuestionCount: 5,
        pause: null,
        quietHours: null,
        childRemindersPermitted: false,
      },
    });
    expect(changed.status).toBe(200);
    // The schedule is saved for a later re-activation, but no daily/review job (paid or bank work)
    // is queued for a profile without a paid slot.
    expect((await learningRows(SAM())).jobs).toBe(rowsBefore.jobs);
  });
});

describe('invisible children', () => {
  it('a child whose data deletion is under way is not readable anywhere', async () => {
    for (const path of learningReads(JORDAN())) {
      expect((await getJson(path)).status, path).toBe(404);
    }
    expect((await getJson(`/v1/points/history?childId=${JORDAN()}`)).status).toBe(404);
    expect((await getJson(`/v1/assignments?childId=${JORDAN()}`)).status).toBe(404);
    expect((await getJson(`/v1/assignments/${jordanScanId}`)).status).toBe(404);
    const overview = rewardsOverviewResponseSchema.parse((await getJson('/v1/rewards')).body);
    expect(overview.children.map((c) => c.childId)).not.toContain(JORDAN());
    // Nor are the child's practice sets: no answer key and no new export of data being deleted.
    const [set] = await api.db.sql<{ id: string }[]>`
      select id from public.practice_sets where child_id = ${JORDAN()} limit 1`;
    expect((await getJson(`/v1/practice-sets/${set!.id}/answer-key`)).status).toBe(404);
    const exported = await api.request('/v1/exports/review-pdf', {
      method: 'POST',
      token,
      body: { setId: set!.id, variant: 'questions' },
    });
    expect(exported.status).toBe(404);
  });

  it('children of a tombstoned family stay invisible, to their own parent and to others', async () => {
    const child = gone.children[0]!.id;
    for (const t of [goneToken, token, otherToken]) {
      for (const path of learningReads(child)) {
        expect((await getJson(path, t)).status, path).toBe(404);
      }
      expect((await getJson(`/v1/points/history?childId=${child}`, t)).status).toBe(404);
      expect((await getJson(`/v1/assignments?childId=${child}`, t)).status).toBe(404);
    }
    expect((await getJson('/v1/rewards', goneToken)).status).toBe(404);
  });

  it('another family never sees an archived child’s history', async () => {
    for (const childId of [RILEY(), SAM(), AVERY()]) {
      for (const path of learningReads(childId)) {
        expect((await getJson(path, otherToken)).status, path).toBe(404);
      }
      expect((await getJson(`/v1/points/history?childId=${childId}`, otherToken)).status).toBe(404);
      expect((await getJson(`/v1/assignments?childId=${childId}`, otherToken)).status).toBe(404);
    }
    expect((await getJson(`/v1/assignments/${rileyScanId}`, otherToken)).status).toBe(404);
    const theirs = rewardsOverviewResponseSchema.parse(
      (await getJson('/v1/rewards', otherToken)).body,
    );
    expect(theirs.children.map((c) => c.childId)).toEqual([other.children[0]!.id]);
  });
});

// ---------------------------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------------------------

describe('reward records of archived and downgraded children stay readable', () => {
  it('the overview lists every live child’s balance, including archived and draft profiles', async () => {
    const overview = rewardsOverviewResponseSchema.parse((await getJson('/v1/rewards')).body);
    const byId = new Map(overview.children.map((c) => [c.childId, c]));
    expect(byId.get(RILEY())).toMatchObject({ nickname: 'Riley', balance: await balance(RILEY()) });
    expect(byId.get(SAM())).toMatchObject({ nickname: 'Sam', balance: 7 });
    expect(byId.has(AVERY())).toBe(true);
    expect(byId.has(JORDAN())).toBe(false);
    expect(overview.openRequests.map((r) => r.id)).toContain(rileyRequestId);
  });

  it('points history of an archived child is readable; new rewards for it are refused', async () => {
    const history = await getJson(`/v1/points/history?childId=${RILEY()}`);
    expect(history.status).toBe(200);
    const body = pointsHistoryResponseSchema.parse(history.body);
    expect(body.balance).toBe(await balance(RILEY()));
    expect(body.entries.map((e) => e.kind)).toContain('award');
    const reward = await api.request('/v1/rewards', {
      method: 'POST',
      token,
      body: { title: 'Ice cream', pointCost: 5, childId: RILEY() },
    });
    expect(reward.status).toBe(422);
    expect((await json<ErrorBody>(reward)).error).toMatchObject({
      code: 'BUSINESS_RULE',
      rule: 'CHILD_ARCHIVED',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Homework
// ---------------------------------------------------------------------------------------------

describe('homework history of an archived child stays readable', () => {
  it('lists, opens and (with a step-up) shows solutions for an archived child’s scans', async () => {
    const list = await getJson(`/v1/assignments?childId=${RILEY()}`);
    expect(list.status).toBe(200);
    const parsed = assignmentListResponseSchema.parse(list.body);
    expect(parsed.assignments.map((a) => a.id)).toEqual([rileyScanId]);
    expect(parsed.allowance?.childHasPaidSlot).toBe(false);
    const detail = await getJson(`/v1/assignments/${rileyScanId}`);
    expect(detail.status).toBe(200);
    expect(assignmentDetailResponseSchema.parse(detail.body).questions).toHaveLength(1);
    expect((await getJson(`/v1/assignments/${rileyScanId}/solutions`, lockedToken)).status).toBe(
      403,
    );
    const solutions = await getJson(`/v1/assignments/${rileyScanId}/solutions`);
    expect(solutions.status).toBe(200);
    expect(assignmentSolutionsResponseSchema.parse(solutions.body).solutions).toHaveLength(1);
  });
  it('a transcription correction queues no paid recheck for an archived or downgraded child', async () => {
    const samScanId = await readyScan(fam, SAM()); // Sam's profile is draft (slot released)
    for (const [childId, scanId] of [
      [RILEY(), rileyScanId],
      [SAM(), samScanId],
    ] as const) {
      const [question] = await api.db.sql<{ id: string }[]>`
        select id from public.extracted_questions where assignment_id = ${scanId}`;
      const res = await api.request(`/v1/questions/${question!.id}/correction`, {
        method: 'POST',
        token,
        body: { studentAnswerText: '41' },
      });
      expect(res.status, childId).toBe(422);
      const [state] = await api.db.sql<{ status: string }[]>`
        select status from public.assignments where id = ${scanId}`;
      expect(state!.status).toBe('ready');
      const [row] = await api.db.sql<{ corrected: string | null }[]>`
        select corrected_student_answer_text as corrected from public.extracted_questions
         where id = ${question!.id}`;
      expect(row!.corrected).toBeNull();
      const jobs = await api.db.sql`
        select 1 from public.jobs
         where kind = 'scan_process' and payload->>'assignmentId' = ${scanId}
           and payload->>'mode' = 'recheck'`;
      expect(jobs).toHaveLength(0);
    }
  });
});
