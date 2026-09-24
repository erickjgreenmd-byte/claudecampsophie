import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  childPracticeTodayResponseSchema,
  childReviewsResponseSchema,
  childSubjectsResponseSchema,
  learningScheduleResponseSchema,
  practiceAnswerResponseSchema,
  practiceSetsResponseSchema,
  skillsResponseSchema,
  type PracticeAnswerResponse,
} from '@pencillift/contracts';
import { cryptoRandom } from '@pencillift/domain';
import { findForbiddenFields } from '@pencillift/domain/answer-guard';
import { keyAnswerText, type AnswerSpec } from '@pencillift/domain/bank';
import { grantAdultUnlock, seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { runJobs, type JobDeps } from '../src/jobs/dispatcher.ts';
import { createLearningHandlers, enqueueDueLearningJobs } from '../src/jobs/learning-jobs.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

// Synthetic families: Riley (child 0) and Sam (child 1) in `fam`; one child in `other`.
let api: TestApi;
let deps: JobDeps;
let fam: SeededFamily;
let other: SeededFamily;
let token: string; // unlocked parent session
let lockedToken: string; // same parent, no step-up
let otherToken: string; // unlocked parent of another family
let riley: string;
let sam: string;
let otherChild: string;
let pairCount = 0;
const SESSION = 'a1a1a1a1-1111-4111-8111-111111111111';
const LOCKED_SESSION = 'b2b2b2b2-2222-4222-8222-222222222222';
const OTHER_SESSION = 'c3c3c3c3-3333-4333-8333-333333333333';

type ErrorBody = { error: { code: string; rule?: string; message: string } };

async function childToken(family: SeededFamily, parent: string, index = 0): Promise<string> {
  const code = await api.request(`/v1/children/${family.children[index]!.id}/pairing-code`, {
    method: 'POST',
    token: parent,
  });
  expect(code.status).toBe(201);
  pairCount += 1;
  const paired = await api.request('/v1/child/pair', {
    method: 'POST',
    headers: { 'cf-connecting-ip': `198.51.100.${pairCount}` },
    body: {
      code: (await json<{ code: string }>(code)).code,
      deviceLabel: `Tablet ${pairCount}`,
      platform: 'ios',
    },
  });
  expect(paired.status).toBe(201);
  return (await json<{ accessToken: string }>(paired)).accessToken;
}

const at = (iso: string) => {
  api.now.value = new Date(iso);
};
const advance = (ms: number) => {
  api.now.value = new Date(api.now.value.getTime() + ms);
};

beforeAll(async () => {
  // Child access tokens are minted at the fixed test clock; a long TTL keeps them valid while the
  // tests move the clock through one family day.
  api = await createTestApi({ CHILD_ACCESS_TTL_SECONDS: String(10 * 86_400) });
  deps = {
    db: api.apiDb,
    config: api.config,
    clock: () => api.now.value,
    random: cryptoRandom,
    providers: api.providers,
    log: (e) => api.logs.push(e),
  };
  fam = await seedFamily(api.db, { childCount: 2, timezone: 'America/Chicago' });
  other = await seedFamily(api.db, { childCount: 1, timezone: 'America/Chicago' });
  await grantAdultUnlock(api.db, fam.ownerId, SESSION, 3600);
  await grantAdultUnlock(api.db, other.ownerId, OTHER_SESSION, 3600);
  token = await parentToken(fam.ownerId, { sessionId: SESSION });
  lockedToken = await parentToken(fam.ownerId, { sessionId: LOCKED_SESSION });
  otherToken = await parentToken(other.ownerId, { sessionId: OTHER_SESSION });
  riley = await childToken(fam, token, 0);
  sam = await childToken(fam, token, 1);
  otherChild = await childToken(other, otherToken, 0);
});

afterAll(async () => {
  await api?.close();
});

const RILEY = () => fam.children[0]!.id;
const SAM = () => fam.children[1]!.id;

// ---------------------------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------------------------

describe('subjects (six supported + custom)', () => {
  it('creates the six supported subjects lazily and scopes them to the family', async () => {
    const res = await api.request(`/v1/children/${RILEY()}/subjects`, { token });
    expect(res.status).toBe(200);
    const body = childSubjectsResponseSchema.parse(await json(res));
    expect(body.subjects.map((s) => s.subjectKey)).toEqual([
      'math',
      'reading',
      'spelling_vocabulary',
      'grammar_writing',
      'science',
      'social_studies',
    ]);
    expect(body.subjects.every((s) => s.enabled && s.generatedPractice)).toBe(true);
    expect(
      (await api.request(`/v1/children/${RILEY()}/subjects`, { token: otherToken })).status,
    ).toBe(404);
    expect((await api.request(`/v1/children/${RILEY()}/subjects`, { token: riley })).status).toBe(
      401,
    );
    expect((await api.request(`/v1/children/not-a-uuid/subjects`, { token })).status).toBe(404);
  });

  it('adds a custom subject (no generated practice) and toggles subjects', async () => {
    const missingName = await api.request(`/v1/children/${RILEY()}/subjects`, {
      method: 'POST',
      token,
      body: { subjectKey: 'custom' },
    });
    expect(missingName.status).toBe(400);
    const created = await api.request(`/v1/children/${RILEY()}/subjects`, {
      method: 'POST',
      token,
      body: { subjectKey: 'custom', displayName: 'Piano theory' },
    });
    expect(created.status).toBe(201);
    const custom = (await json<{ subject: { id: string; generatedPractice: boolean } }>(created))
      .subject;
    expect(custom.generatedPractice).toBe(false);
    const dup = await api.request(`/v1/children/${RILEY()}/subjects`, {
      method: 'POST',
      token,
      body: { subjectKey: 'custom', displayName: 'piano THEORY' },
    });
    expect(dup.status).toBe(409);
    const extra = await api.request(`/v1/children/${RILEY()}/subjects`, {
      method: 'POST',
      token,
      body: { subjectKey: 'math', familyId: other.familyId },
    });
    expect(extra.status).toBe(400); // strict: no smuggled family id
    const off = await api.request(`/v1/children/${RILEY()}/subjects`, {
      method: 'PATCH',
      token,
      body: { subjectId: custom.id, enabled: false },
    });
    expect(off.status).toBe(200);
    expect((await json<{ subject: { enabled: boolean } }>(off)).subject.enabled).toBe(false);
    // A sibling's subject id is "not found" on Riley's route.
    const samSubjects = childSubjectsResponseSchema.parse(
      await json(await api.request(`/v1/children/${SAM()}/subjects`, { token })),
    );
    const cross = await api.request(`/v1/children/${RILEY()}/subjects`, {
      method: 'PATCH',
      token,
      body: { subjectId: samSubjects.subjects[0]!.id, enabled: false },
    });
    expect(cross.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------
// Learning schedule and test dates
// ---------------------------------------------------------------------------------------------

describe('learning schedule (spec P7/P8)', () => {
  const valid = {
    reviewWeekday: 4,
    reviewLocalTime: '16:00',
    reviewQuestionsPerSubject: 8,
    dailyLocalTime: '15:30',
    dailyQuestionCount: 5,
    pause: null,
    quietHours: { start: '20:00', end: '07:00' },
    childRemindersPermitted: false,
  };

  it('returns the defaults with DST-aware next releases in the family zone', async () => {
    at('2026-09-21T15:00:00Z'); // Monday
    const res = await api.request(`/v1/children/${SAM()}/learning-schedule`, { token });
    expect(res.status).toBe(200);
    const body = learningScheduleResponseSchema.parse(await json(res));
    expect(body.schedule).toMatchObject({
      reviewWeekday: 4,
      reviewLocalTime: '16:00',
      reviewQuestionsPerSubject: 8,
      scheduleVersion: 1,
      dailyQuestionCount: 5,
    });
    expect(body.timezone).toBe('America/Chicago');
    const math = body.nextReviewReleases.filter((r) => r.subjectKey === 'math');
    expect(math.map((r) => r.releaseAt)).toEqual([
      '2026-09-24T21:00:00.000Z',
      '2026-10-01T21:00:00.000Z',
    ]);
    expect(body.pointsPolicy).toEqual({ expireEarnedPoints: false, penalizeMissedDays: false });
    expect(
      (await api.request(`/v1/children/${SAM()}/learning-schedule`, { token: otherToken })).status,
    ).toBe(404);
  });

  it('validates every field', async () => {
    for (const bad of [
      { ...valid, reviewQuestionsPerSubject: 3 },
      { ...valid, reviewQuestionsPerSubject: 21 },
      { ...valid, dailyQuestionCount: 2 },
      { ...valid, dailyQuestionCount: 11 },
      { ...valid, reviewWeekday: 8 },
      { ...valid, reviewLocalTime: '25:00' },
      { ...valid, pause: { from: '2026-10-05', to: '2026-10-01' } },
      { ...valid, scheduleVersion: 7 },
      { ...valid, quietHours: { start: '20:00' } },
    ]) {
      const res = await api.request(`/v1/children/${SAM()}/learning-schedule`, {
        method: 'PUT',
        token,
        body: bad,
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('bumps the schedule version only when the review day/time changes', async () => {
    const same = await api.request(`/v1/children/${SAM()}/learning-schedule`, {
      method: 'PUT',
      token,
      body: { ...valid, dailyQuestionCount: 7, pause: { from: '2026-12-21', to: '2027-01-02' } },
    });
    expect(same.status).toBe(200);
    const sameBody = learningScheduleResponseSchema.parse(await json(same));
    expect(sameBody.schedule.scheduleVersion).toBe(1);
    expect(sameBody.schedule.pause).toEqual({ from: '2026-12-21', to: '2027-01-02' });
    const moved = await api.request(`/v1/children/${SAM()}/learning-schedule`, {
      method: 'PUT',
      token,
      body: { ...valid, reviewWeekday: 3, reviewLocalTime: '17:30' },
    });
    const movedBody = learningScheduleResponseSchema.parse(await json(moved));
    expect(movedBody.schedule.scheduleVersion).toBe(2);
    expect(movedBody.nextReviewReleases.find((r) => r.subjectKey === 'math')?.releaseAt).toBe(
      '2026-09-23T22:30:00.000Z',
    );
  });

  it('a Friday test date moves that subject’s review to Thursday and matches the scope to skills', async () => {
    const subjects = childSubjectsResponseSchema.parse(
      await json(await api.request(`/v1/children/${SAM()}/subjects`, { token })),
    );
    const math = subjects.subjects.find((s) => s.subjectKey === 'math')!;
    const created = await api.request(`/v1/children/${SAM()}/test-dates`, {
      method: 'POST',
      token,
      body: {
        subjectId: math.id,
        testDate: '2026-10-02',
        scopeNotes: 'Unit 3: division with remainders and multiplication facts',
      },
    });
    expect(created.status).toBe(201);
    const testDate = (
      await json<{ testDate: { id: string; matchedSkills: { skill: string }[] } }>(created)
    ).testDate;
    // Most specific (longest) keyword first: "multiplication" outranks "remainder".
    expect(testDate.matchedSkills.map((m) => m.skill)).toEqual([
      'math.multiplication_facts',
      'math.division_remainders',
    ]);
    const schedule = learningScheduleResponseSchema.parse(
      await json(await api.request(`/v1/children/${SAM()}/learning-schedule`, { token })),
    );
    expect(schedule.schedule.scheduleVersion).toBe(3);
    const w40 = schedule.nextReviewReleases.filter((r) => r.weekKey === '2026-W40');
    expect(w40.find((r) => r.subjectKey === 'math')).toMatchObject({
      reason: 'test_date_eve',
      testDate: '2026-10-02',
      releaseAt: '2026-10-01T22:30:00.000Z',
    });
    expect(w40.find((r) => r.subjectKey === 'reading')?.reason).toBe('default_schedule');
    const dup = await api.request(`/v1/children/${SAM()}/test-dates`, {
      method: 'POST',
      token,
      body: { subjectId: math.id, testDate: '2026-10-02' },
    });
    expect(dup.status).toBe(409);
    const foreign = await api.request(`/v1/children/${RILEY()}/test-dates`, {
      method: 'POST',
      token,
      body: { subjectId: math.id, testDate: '2026-10-09' },
    });
    expect(foreign.status).toBe(404); // Sam's subject on Riley's route
    const list = await json<{ testDates: unknown[] }>(
      await api.request(`/v1/children/${SAM()}/test-dates`, { token }),
    );
    expect(list.testDates).toHaveLength(1);
    expect(
      (
        await api.request(`/v1/children/${SAM()}/test-dates/${testDate.id}`, {
          method: 'DELETE',
          token: otherToken,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api.request(`/v1/children/${SAM()}/test-dates/${testDate.id}`, {
          method: 'DELETE',
          token,
        })
      ).status,
    ).toBe(204);
  });
});

describe('study material (text only, size-limited)', () => {
  it('stores a spelling list and taught notes and reports what it recognized', async () => {
    const list = await api.request(`/v1/children/${RILEY()}/study-materials`, {
      method: 'POST',
      token,
      body: { kind: 'spelling_list', text: 'bridge, island, kitchen; whistle\nthrough' },
    });
    expect(list.status).toBe(201);
    expect((await json<{ material: { spellingWords: number } }>(list)).material.spellingWords).toBe(
      5,
    );
    const notes = await api.request(`/v1/children/${RILEY()}/study-materials`, {
      method: 'POST',
      token,
      body: {
        kind: 'taught_notes',
        text: 'This week we learned about the water cycle and comparing fractions.',
      },
    });
    const matched = (await json<{ material: { matchedSkills: { skill: string }[] } }>(notes))
      .material.matchedSkills;
    expect(matched.map((m) => m.skill).sort()).toEqual([
      'math.fractions_compare',
      'science.earth_space',
    ]);
    const tooLong = await api.request(`/v1/children/${RILEY()}/study-materials`, {
      method: 'POST',
      token,
      body: { kind: 'spelling_list', text: 'word '.repeat(500) },
    });
    expect(tooLong.status).toBe(400);
    const noWords = await api.request(`/v1/children/${RILEY()}/study-materials`, {
      method: 'POST',
      token,
      body: { kind: 'spelling_list', text: '123 456 !!!' },
    });
    expect(noWords.status).toBe(400);
    const childTry = await api.request(`/v1/children/${RILEY()}/study-materials`, {
      method: 'POST',
      token: riley,
      body: { kind: 'taught_notes', text: 'hello' },
    });
    expect(childTry.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------
// Skill evidence (AC_LEARNING_01/02)
// ---------------------------------------------------------------------------------------------

describe('skill summaries', () => {
  async function attempt(
    childId: string,
    instance: string,
    n: number,
    correctness: string,
    day: number,
  ) {
    await api.db.sql`
      insert into public.attempts (family_id, child_id, question_instance_id, source, subject_key, skill, attempt_number,
                                   correctness, grader_version, idempotency_key, occurred_at)
      values (${fam.familyId}, ${childId}, ${instance}, 'homework', 'math', 'multiplication', ${n}, ${correctness}, 'test',
              ${'t:' + randomUUID()}, ${new Date(Date.UTC(2026, 8, day, 18))})`;
  }

  it('shows "Not enough evidence" under five distinct independent questions; retries never inflate it', async () => {
    at('2026-09-24T15:00:00Z');
    const q = Array.from({ length: 5 }, () => randomUUID());
    for (const [i, id] of q.slice(0, 4).entries()) await attempt(SAM(), id, 1, 'correct', 18 + i);
    // Many resubmissions of one question are one sample.
    await attempt(SAM(), q[0]!, 2, 'correct', 22);
    await attempt(SAM(), q[0]!, 3, 'correct', 22);
    let body = skillsResponseSchema.parse(
      await json(await api.request(`/v1/children/${SAM()}/skills`, { token })),
    );
    let skill = body.skills.find((s) => s.skill === 'multiplication')!;
    expect(skill.distinctIndependentQuestions).toBe(4);
    expect(skill.status).toBe('not_enough_evidence');
    expect(skill.statusLabel).toBe('Not enough evidence');
    // Initial accuracy and eventual completion stay distinct: wrong first, right after a retry.
    await attempt(SAM(), q[4]!, 1, 'incorrect', 23);
    await attempt(SAM(), q[4]!, 2, 'correct', 23);
    body = skillsResponseSchema.parse(
      await json(await api.request(`/v1/children/${SAM()}/skills`, { token })),
    );
    skill = body.skills.find((s) => s.skill === 'multiplication')!;
    expect(skill.distinctIndependentQuestions).toBe(5);
    expect(skill.initialAccuracy).toBeCloseTo(4 / 5);
    expect(skill.eventualCompletionRate).toBe(1);
    expect(skill.status).not.toBe('not_enough_evidence');
    expect(JSON.stringify(body)).not.toMatch(/master/i);
    expect(body.coverage.subjects).toHaveLength(6);
    expect(body.coverage.subjects.every((s) => s.unsupported.length > 0)).toBe(true);
    expect((await api.request(`/v1/children/${SAM()}/skills`, { token: otherToken })).status).toBe(
      404,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Child practice: questions only, graded server-side (AC_GRADING_06/09, AC_REWARDS_01/02)
// ---------------------------------------------------------------------------------------------

interface KeyRow {
  item_id: string;
  position: number;
  answer_spec: { spec: AnswerSpec; instanceKey: string; templateKey: string };
  explanation: string;
}

async function keysFor(setId: string): Promise<KeyRow[]> {
  return api.db.sql<KeyRow[]>`
    select i.id as item_id, i.position, k.answer_spec, k.explanation from public.practice_items i
      join private.practice_item_keys k on k.item_id = i.id where i.set_id = ${setId} order by i.position`;
}

function wrongAnswer(spec: AnswerSpec): string {
  switch (spec.kind) {
    case 'numeric':
      return `${Number(spec.value.split('/')[0]) + 1}${spec.value.includes('/') ? `/${spec.value.split('/')[1]}` : ''}`;
    case 'division_remainder':
      return `${spec.quotient + 1} R ${spec.remainder}`;
    case 'multiple_choice':
      return spec.validLetters.find((l) => l !== spec.letters[0])!;
    case 'spelling':
      return `${spec.target}zz`;
    case 'exact_text':
      return `${spec.accepted[0]}zz`;
  }
}

function answer(child: string, itemId: string, body: { answer: string; idempotencyKey: string }) {
  return api.request(`/v1/child/practice/items/${itemId}/answer`, {
    method: 'POST',
    token: child,
    body,
  });
}

async function balance(childId: string): Promise<number> {
  const [row] = await api.db.sql<
    { balance: number }[]
  >`select balance from public.point_balances where child_id = ${childId}`;
  return row?.balance ?? 0;
}

describe('child practice', () => {
  let setId: string;
  let keys: KeyRow[];

  beforeAll(async () => {
    at('2026-09-24T14:00:00Z'); // 09:00 CDT: before the 15:30 release
    const early = childPracticeTodayResponseSchema.parse(
      await json(await api.request('/v1/child/practice/today', { token: riley })),
    );
    expect(early).toMatchObject({ state: 'not_scheduled', set: null, localDate: '2026-09-24' });
    at('2026-09-24T21:00:00Z'); // 16:00 CDT
    const preparing = childPracticeTodayResponseSchema.parse(
      await json(await api.request('/v1/child/practice/today', { token: riley })),
    );
    expect(preparing.state).toBe('preparing'); // the durable job is enqueued on demand
    await enqueueDueLearningJobs(deps, api.now.value);
    await runJobs(deps, createLearningHandlers());
    const [set] = await api.db.sql<{ id: string }[]>`
      select id from public.practice_sets where child_id = ${RILEY()} and kind = 'daily' and local_date = '2026-09-24'`;
    setId = set!.id;
    keys = await keysFor(setId);
    expect(keys).toHaveLength(5);
  });

  it('serves questions only: no key, explanation or grading fields (AC_GRADING_06)', async () => {
    const res = await api.request('/v1/child/practice/today', { token: riley });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = childPracticeTodayResponseSchema.parse(JSON.parse(raw));
    expect(body.state).toBe('available');
    expect(body.set!.items).toHaveLength(5);
    expect(findForbiddenFields(JSON.parse(raw))).toEqual([]);
    expect(raw).not.toMatch(
      /"(answerSpec|answer_spec|explanation|instanceKey|templateKey|letters|validLetters|target|accepted|alternates|spec)"/,
    );
    for (const k of keys) {
      expect(raw).not.toContain(k.explanation);
      expect(raw).not.toContain(k.answer_spec.instanceKey);
      const spec = k.answer_spec.spec;
      if (spec.kind === 'spelling')
        expect(raw.toLowerCase()).not.toContain(spec.target.toLowerCase());
      if (spec.kind === 'exact_text')
        expect(raw.toLowerCase()).not.toContain(`"${spec.accepted[0]!.toLowerCase()}"`);
    }
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps siblings and other families apart (AC_ACCESS_05)', async () => {
    const itemId = keys[0]!.item_id;
    const samToday = childPracticeTodayResponseSchema.parse(
      await json(await api.request('/v1/child/practice/today', { token: sam })),
    );
    expect(samToday.set?.id).not.toBe(setId);
    for (const t of [sam, otherChild]) {
      const res = await answer(t, itemId, { answer: 'A', idempotencyKey: randomUUID() });
      expect(res.status).toBe(404);
    }
    const parentTry = await answer(token, itemId, { answer: 'A', idempotencyKey: randomUUID() });
    expect(parentTry.status).toBe(401);
    expect(
      await api.db.sql`select id from public.attempts where question_instance_id = ${itemId}`,
    ).toEqual([]);
  });

  it('grades server-side, caps target attempts at three without lockout, and never returns the answer', async () => {
    const k = keys[0]!;
    const spec = k.answer_spec.spec;
    const correct = keyAnswerText(spec);
    const before = await balance(RILEY());
    const responses = [];
    for (let i = 0; i < 3; i += 1) {
      advance(20_000);
      const res = await answer(riley, k.item_id, {
        answer: wrongAnswer(spec),
        idempotencyKey: randomUUID(),
      });
      expect(res.status).toBe(200);
      const raw = await res.text();
      const body = practiceAnswerResponseSchema.parse(JSON.parse(raw));
      expect(Object.keys(JSON.parse(raw)).sort()).toEqual(
        [
          'attemptNumber',
          'itemStatus',
          'offerHelp',
          'pointsAwarded',
          'result',
          'setCompleted',
        ].sort(),
      );
      if (spec.kind !== 'multiple_choice') expect(raw).not.toContain(`"${correct}"`);
      responses.push(body);
    }
    expect(responses.map((r) => [r.result, r.attemptNumber, r.offerHelp, r.itemStatus])).toEqual([
      ['try_again', 1, false, 'try_again'],
      ['try_again', 2, false, 'try_again'],
      ['try_again', 3, true, 'help_offered'],
    ]);
    // Effort points for the first meaningful try only (spec P9); retries earn nothing.
    expect(responses.map((r) => r.pointsAwarded)).toEqual([2, 0, 0]);
    // A fourth try (even the right answer, even with a fresh key) is not graded: help, no enumeration.
    advance(20_000);
    const fourth = practiceAnswerResponseSchema.parse(
      await json(await answer(riley, k.item_id, { answer: correct, idempotencyKey: randomUUID() })),
    );
    expect(fourth).toMatchObject({
      result: 'unresolved',
      offerHelp: true,
      itemStatus: 'help_offered',
      pointsAwarded: 0,
    });
    const rows = await api.db.sql<{ attempt_number: number; independent: boolean }[]>`
      select attempt_number, independent from public.attempts where question_instance_id = ${k.item_id} order by attempt_number`;
    expect(rows.map((r) => [r.attempt_number, r.independent])).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
    expect(await balance(RILEY())).toBe(before + 2);
  });

  it('unreadable input is neither right nor wrong and records nothing', async () => {
    const k = keys.find((x) => x.answer_spec.spec.kind !== 'multiple_choice') ?? keys[1]!;
    advance(20_000);
    const res = await answer(riley, k.item_id, {
      answer: k.answer_spec.spec.kind === 'multiple_choice' ? 'Z' : '   ',
      idempotencyKey: randomUUID(),
    });
    expect(practiceAnswerResponseSchema.parse(await json(res))).toMatchObject({
      result: 'unresolved',
      attemptNumber: 0,
      pointsAwarded: 0,
    });
    expect(
      await api.db.sql`select id from public.attempts where question_instance_id = ${k.item_id}`,
    ).toEqual([]);
  });

  it('concurrent duplicate submissions record one attempt and award once (AC_REWARDS_02)', async () => {
    const k = keys[1]!;
    const before = await balance(RILEY());
    advance(20_000);
    const idempotencyKey = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        answer(riley, k.item_id, { answer: keyAnswerText(k.answer_spec.spec), idempotencyKey }),
      ),
    );
    const bodies = await Promise.all(results.map((r) => json(r)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const b of bodies) expect(practiceAnswerResponseSchema.parse(b).result).toBe('correct');
    const attempts = await api.db
      .sql`select id from public.attempts where question_instance_id = ${k.item_id}`;
    expect(attempts).toHaveLength(1);
    // 2 effort + 3 independent-correct, exactly once.
    expect(await balance(RILEY())).toBe(before + 5);
    expect(
      bodies.reduce((sum, b) => sum + practiceAnswerResponseSchema.parse(b).pointsAwarded, 0),
    ).toBe(5);
  });

  it('rapid-fire answers earn no points (anti-farming), but are still graded', async () => {
    const k = keys[2]!;
    const before = await balance(RILEY());
    // No time passes since the previous submission in this set.
    const res = practiceAnswerResponseSchema.parse(
      await json(
        await answer(riley, k.item_id, {
          answer: wrongAnswer(k.answer_spec.spec),
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    expect(res).toMatchObject({ result: 'try_again', pointsAwarded: 0 });
    expect(await balance(RILEY())).toBe(before);
  });

  it('completes the set once and awards completion once (AC_REWARDS_01)', async () => {
    const before = await balance(RILEY());
    let last: PracticeAnswerResponse | undefined;
    for (const k of keys.slice(2)) {
      advance(30_000);
      last = practiceAnswerResponseSchema.parse(
        await json(
          await answer(riley, k.item_id, {
            answer: keyAnswerText(k.answer_spec.spec),
            idempotencyKey: randomUUID(),
          }),
        ),
      );
      expect(last.result).toBe('correct');
    }
    expect(last?.setCompleted).toBe(true);
    const [set] = await api.db.sql<
      { status: string }[]
    >`select status from public.practice_sets where id = ${setId}`;
    expect(set!.status).toBe('completed');
    const ledger = await api.db.sql<{ idempotency_key: string; points: number }[]>`
      select idempotency_key, points from public.points_ledger where child_id = ${RILEY()} and idempotency_key = ${'set:' + setId}`;
    expect(ledger).toEqual([{ idempotency_key: `set:${setId}`, points: 5 }]);
    // Item 3 was answered wrong first (rapid, no points) and correct now: a correct retry earns the
    // effort award it never got, but no independent bonus. Items 4 and 5: 5 each. Completion: 5.
    expect(await balance(RILEY())).toBe(before + 2 + 5 + 5 + 5);
    // Re-answering a solved question gives feedback only.
    advance(30_000);
    const again = practiceAnswerResponseSchema.parse(
      await json(
        await answer(riley, keys[4]!.item_id, {
          answer: keyAnswerText(keys[4]!.answer_spec.spec),
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    expect(again).toMatchObject({ result: 'correct', pointsAwarded: 0, setCompleted: true });
    expect(await balance(RILEY())).toBe(before + 17);
  });
});

// ---------------------------------------------------------------------------------------------
// Reviews, parent views, answer key and export requests
// ---------------------------------------------------------------------------------------------

describe('reviews, parent practice views and protected keys', () => {
  let reviewSetId: string;

  beforeAll(async () => {
    at('2026-09-24T19:30:00Z'); // after the job start (release 16:00 CDT = 21:00Z minus 2 h)
    await enqueueDueLearningJobs(deps, api.now.value);
    await runJobs(deps, createLearningHandlers());
    const [set] = await api.db.sql<{ id: string }[]>`
      select id from public.practice_sets where child_id = ${RILEY()} and kind = 'thursday_review' and subject_key = 'math'`;
    reviewSetId = set!.id;
  });

  it('shows this week’s review only from the release instant, in subject sections', async () => {
    const before = childReviewsResponseSchema.parse(
      await json(await api.request('/v1/child/reviews/current', { token: riley })),
    );
    expect(before.sections).toEqual([]);
    expect(before.weekKey).toBe('2026-W39');
    // Answering a not-yet-released review question is impossible.
    const [item] = await api.db.sql<
      { id: string }[]
    >`select id from public.practice_items where set_id = ${reviewSetId} limit 1`;
    expect(
      (await answer(riley, item!.id, { answer: 'A', idempotencyKey: randomUUID() })).status,
    ).toBe(404);
    at('2026-09-24T21:00:00Z');
    const raw = await (await api.request('/v1/child/reviews/current', { token: riley })).text();
    const after = childReviewsResponseSchema.parse(JSON.parse(raw));
    expect(after.state).toBe('available');
    expect(after.sections.map((s) => s.subjectKey)).toContain('math');
    for (const section of after.sections) expect(section.sets[0]!.items.length).toBeGreaterThan(0);
    expect(findForbiddenFields(JSON.parse(raw))).toEqual([]);
    const other = childReviewsResponseSchema.parse(
      await json(await api.request('/v1/child/reviews/current', { token: otherChild })),
    );
    expect(JSON.stringify(other)).not.toContain(reviewSetId);
  });

  it('a Monday test releases its review on Sunday and the child sees it then (keyed to the test week)', async () => {
    const subjects = childSubjectsResponseSchema.parse(
      await json(
        await api.request(`/v1/children/${other.children[0]!.id}/subjects`, { token: otherToken }),
      ),
    );
    const math = subjects.subjects.find((s) => s.subjectKey === 'math')!;
    const created = await api.request(`/v1/children/${other.children[0]!.id}/test-dates`, {
      method: 'POST',
      token: otherToken,
      body: { subjectId: math.id, testDate: '2026-09-28' },
    });
    expect(created.status).toBe(201);
    at('2026-09-27T19:30:00Z'); // Sunday; release 16:00 CDT = 21:00Z, job start 2 h earlier
    await enqueueDueLearningJobs(deps, api.now.value);
    await runJobs(deps, createLearningHandlers());
    at('2026-09-27T21:05:00Z');
    const body = childReviewsResponseSchema.parse(
      await json(await api.request('/v1/child/reviews/current', { token: otherChild })),
    );
    expect(body.weekKey).toBe('2026-W39');
    const mathSets = body.sections.find((s) => s.subjectKey === 'math')!.sets;
    expect(mathSets.map((s) => s.reviewWeek)).toContain('2026-W40');
    at('2026-09-24T21:00:00Z');
  });

  it('parents see sets with questions and progress, never keys', async () => {
    const res = await api.request(
      `/v1/children/${RILEY()}/practice-sets?kind=thursday_review&week=2026-W39`,
      { token },
    );
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = practiceSetsResponseSchema.parse(JSON.parse(raw));
    expect(body.sets.every((s) => s.kind === 'thursday_review')).toBe(true);
    expect(body.sets.find((s) => s.id === reviewSetId)!.notes.length).toBeGreaterThan(0);
    for (const k of await keysFor(reviewSetId)) expect(raw).not.toContain(k.explanation);
    const daily = practiceSetsResponseSchema.parse(
      await json(await api.request(`/v1/children/${RILEY()}/practice-sets?kind=daily`, { token })),
    );
    expect(
      daily.sets.find((d) => d.localDate === '2026-09-24')!.items.map((i) => i.progress.firstTry),
    ).toEqual(['incorrect', 'correct', 'incorrect', 'correct', 'correct']);
    expect(
      (await api.request(`/v1/children/${RILEY()}/practice-sets?kind=bogus`, { token })).status,
    ).toBe(400);
    expect(
      (await api.request(`/v1/children/${RILEY()}/practice-sets`, { token: otherToken })).status,
    ).toBe(404);
  });

  it('the answer key needs a parent with a recent step-up and the family’s own set', async () => {
    const locked = await api.request(`/v1/practice-sets/${reviewSetId}/answer-key`, {
      token: lockedToken,
    });
    expect(locked.status).toBe(403);
    expect((await json<ErrorBody>(locked)).error.code).toBe('STEP_UP_REQUIRED');
    expect(
      (await api.request(`/v1/practice-sets/${reviewSetId}/answer-key`, { token: otherToken }))
        .status,
    ).toBe(404);
    expect(
      (await api.request(`/v1/practice-sets/${reviewSetId}/answer-key`, { token: riley })).status,
    ).toBe(401);
    const ok = await api.request(`/v1/practice-sets/${reviewSetId}/answer-key`, { token });
    expect(ok.status).toBe(200);
    const body = await json<{ items: { itemId: string; answer: string; explanation: string }[] }>(
      ok,
    );
    const keys = await keysFor(reviewSetId);
    expect(body.items.map((i) => i.itemId)).toEqual(keys.map((k) => k.item_id));
    for (const [i, k] of keys.entries())
      expect(body.items[i]!.answer.startsWith(keyAnswerText(k.answer_spec.spec))).toBe(true);
    const [audit] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events where action = 'practice.answer_key_viewed' and target_id = ${reviewSetId}`;
    expect(audit!.n).toBe(1);
  });

  it('review PDF exports: parent + step-up only; the kind is fixed at request time (AC_LEARNING_10)', async () => {
    const body = { setId: reviewSetId, variant: 'questions' };
    expect(
      (await api.request('/v1/exports/review-pdf', { method: 'POST', token: riley, body })).status,
    ).toBe(401);
    const locked = await api.request('/v1/exports/review-pdf', {
      method: 'POST',
      token: lockedToken,
      body: { ...body, variant: 'answer_key' },
    });
    expect(locked.status).toBe(403);
    expect(
      (await api.request('/v1/exports/review-pdf', { method: 'POST', token: otherToken, body }))
        .status,
    ).toBe(404);
    expect(
      (
        await api.request('/v1/exports/review-pdf', {
          method: 'POST',
          token,
          body: { ...body, includeKey: true },
        })
      ).status,
    ).toBe(400);
    for (const variant of ['questions', 'answer_key'] as const) {
      const res = await api.request('/v1/exports/review-pdf', {
        method: 'POST',
        token,
        body: { setId: reviewSetId, variant },
      });
      expect(res.status).toBe(202);
      const created = await json<{ exportId: string; kind: string; status: string }>(res);
      expect(created.kind).toBe(
        variant === 'questions' ? 'review_questions_pdf' : 'review_answer_key_pdf',
      );
      const [job] = await api.db.sql<{ payload: { exportId: string; setId: string } }[]>`
        select payload from public.jobs where kind = 'export_build' and idempotency_key = ${'export:' + created.exportId}`;
      expect(job!.payload).toEqual({ exportId: created.exportId, setId: reviewSetId });
    }
  });
});
