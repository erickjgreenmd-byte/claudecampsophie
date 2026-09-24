import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMockResponsesClient,
  type ResponsesRequest,
  type ResponsesResult,
} from '@pencillift/ai';
import { cryptoRandom } from '@pencillift/domain';
import { generateSkillItems, seededRandom } from '@pencillift/domain/bank';
import { seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { runJobs, type JobDeps, type JobRow } from '../src/jobs/dispatcher.ts';
import {
  createLearningHandlers,
  enqueueDueLearningJobs,
  loadChildContext,
  personalizeItems,
  type LearningHandlerOptions,
} from '../src/jobs/learning-jobs.ts';
import { createTestApi, type TestApi } from './helpers.ts';

/**
 * Daily/Thursday generation against real Postgres (AC_LEARNING_03/04/06/07/08/09). AI calls use a
 * LABELED MOCK client (the live API is not reachable here and child data needs ZDR evidence).
 * Synthetic children only (Riley, Sam).
 */

let api: TestApi;
let deps: JobDeps;

beforeAll(async () => {
  api = await createTestApi();
  deps = {
    db: api.apiDb,
    config: api.config,
    clock: () => api.now.value,
    random: cryptoRandom,
    providers: api.providers,
    log: (e) => api.logs.push(e),
  };
});

afterAll(async () => {
  await api?.close();
});

beforeEach(async () => {
  api.logs.length = 0;
  // Each test owns its family: earlier families stop generating and their pending jobs are cancelled,
  // so the global tick and job runner only see this test's child.
  await api.db
    .sql`update public.child_profiles set status = 'archived', archived_at = now() where status = 'active'`;
  await api.db
    .sql`update public.jobs set status = 'cancelled' where status in ('queued', 'failed_retryable')`;
});

const at = (iso: string) => {
  api.now.value = new Date(iso);
};

function run(options: LearningHandlerOptions = {}) {
  return runJobs(deps, createLearningHandlers({ sleep: () => Promise.resolve(), ...options }));
}

async function family(timezone = 'America/New_York', childCount = 1): Promise<SeededFamily> {
  return seedFamily(api.db, { timezone, childCount });
}

async function jobs(childId: string, kind: string) {
  return api.db.sql<
    {
      id: string;
      status: string;
      idempotency_key: string;
      run_after: Date;
      payload: Record<string, string | number>;
    }[]
  >`
    select id, status, idempotency_key, run_after, payload from public.jobs
     where child_id = ${childId} and kind = ${kind} order by run_after, created_at`;
}

async function sets(childId: string) {
  return api.db.sql<
    {
      id: string;
      kind: string;
      set_key: string;
      status: string;
      subject_key: string | null;
      review_week: string | null;
      version: number;
      ready_at: Date;
      release_at: Date;
      evidence_cutoff_at: Date;
      child_intro: string | null;
    }[]
  >`
    select id, kind, set_key, status, subject_key, review_week, version, ready_at, release_at, evidence_cutoff_at, child_intro
      from public.practice_sets where child_id = ${childId} order by created_at, version`;
}

async function onlySubjects(fam: SeededFamily, keys: string[], childIndex = 0) {
  const childId = fam.children[childIndex]!.id;
  await api.db
    .sql`insert into public.learning_schedules (child_id, family_id) values (${childId}, ${fam.familyId}) on conflict do nothing`;
  for (const key of keys) {
    await api.db.sql`
      insert into public.child_subjects (family_id, child_id, subject_key, display_name)
      values (${fam.familyId}, ${childId}, ${key}, ${key})`;
  }
}

async function consent(fam: SeededFamily) {
  await api.db.sql`
    insert into public.consent_records (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
    values (${fam.familyId}, ${fam.ownerId}, 'mock', 'mock', 'child_learning_data', 'v1', 'verified', true, now())`;
}

async function homeworkAttempt(
  fam: SeededFamily,
  subject: string,
  skill: string,
  correctness: string,
  occurredAt: Date,
) {
  const id = randomUUID();
  await api.db.sql`
    insert into public.attempts (family_id, child_id, question_instance_id, source, subject_key, skill, attempt_number,
                                 correctness, grader_version, idempotency_key, occurred_at)
    values (${fam.familyId}, ${fam.children[0]!.id}, ${id}, 'homework', ${subject}, ${skill}, 1, ${correctness},
            'test', ${'homework:' + id}, ${occurredAt})`;
}

// ---------------------------------------------------------------------------------------------

describe('Thursday review scheduling in the family zone (AC_LEARNING_08)', () => {
  it('releases Thursday 4 pm New York time across the March DST change, with lead time', async () => {
    const fam = await family('America/New_York');
    const child = fam.children[0]!.id;
    await onlySubjects(fam, ['math']);
    at('2026-03-02T12:00:00Z'); // Monday of ISO week 2026-W10 (EST)
    const report = await enqueueDueLearningJobs(deps, api.now.value);
    expect(report.reviewJobs).toBe(2);
    const planned = await jobs(child, 'thursday_review_generate');
    expect(planned.map((j) => [j.payload.weekKey, j.payload.releaseAt])).toEqual([
      ['2026-W10', '2026-03-05T21:00:00.000Z'], // 16:00 EST (UTC-5)
      ['2026-W11', '2026-03-12T20:00:00.000Z'], // 16:00 EDT (UTC-4) after the switch on Mar 8
    ]);
    // Durable jobs start before release (default minimum lead 2 h), so reviews are ready in time.
    for (const job of planned) {
      expect(new Date(job.payload.releaseAt as string).getTime() - job.run_after.getTime()).toBe(
        2 * 3_600_000,
      );
    }
    // Keys are (child, subject, week, schedule_version); re-running the tick adds nothing.
    expect(planned[0]!.idempotency_key).toBe(`review:${child}:math:2026-W10:s1`);
    const again = await enqueueDueLearningJobs(deps, api.now.value);
    expect(again.reviewJobs).toBe(0);
    expect(await jobs(child, 'thursday_review_generate')).toHaveLength(2);
  });

  it('handles the November fall-back week', async () => {
    const fam = await family('America/New_York');
    await onlySubjects(fam, ['reading']);
    at('2026-10-26T12:00:00Z'); // Monday of 2026-W44 (EDT)
    await enqueueDueLearningJobs(deps, api.now.value);
    const planned = await jobs(fam.children[0]!.id, 'thursday_review_generate');
    expect(planned.map((j) => j.payload.releaseAt)).toEqual([
      '2026-10-29T20:00:00.000Z', // 16:00 EDT
      '2026-11-05T21:00:00.000Z', // 16:00 EST after Nov 1
    ]);
  });

  it('is ready before 4 pm with the app closed, visible only from the release instant, and never duplicated', async () => {
    const fam = await family('America/New_York');
    const child = fam.children[0]!.id;
    await onlySubjects(fam, ['math', 'science']);
    at('2026-09-21T12:00:00Z'); // Monday 2026-W39
    await enqueueDueLearningJobs(deps, api.now.value);
    const planned = (await jobs(child, 'thursday_review_generate')).filter(
      (j) => j.payload.weekKey === '2026-W39',
    );
    expect(planned).toHaveLength(2);
    // The scheduled tick reaches the job start time (release - lead): nothing depends on a client.
    at(planned[0]!.run_after.toISOString());
    const report = await run();
    expect(report.succeeded).toBeGreaterThanOrEqual(2);
    const ready = (await sets(child)).filter((s) => s.review_week === '2026-W39');
    expect(ready.map((s) => [s.kind, s.subject_key, s.status]).sort()).toEqual([
      ['thursday_review', 'math', 'ready'],
      ['thursday_review', 'science', 'ready'],
    ]);
    for (const s of ready) {
      expect(s.release_at.toISOString()).toBe('2026-09-24T20:00:00.000Z');
      expect(s.ready_at.getTime()).toBeLessThan(s.release_at.getTime());
      expect(s.evidence_cutoff_at.getTime()).toBeLessThanOrEqual(s.release_at.getTime());
    }
    const [count] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.practice_items where set_id = ${ready[0]!.id}`;
    expect(count!.n).toBe(8); // default: 6 weaker/current + 2 cumulative

    // Worker retry of the same job (and a duplicate delivery) creates nothing new.
    const handlers = createLearningHandlers();
    const job: JobRow = {
      id: planned[0]!.id,
      kind: 'thursday_review_generate',
      family_id: fam.familyId,
      child_id: child,
      payload: planned[0]!.payload,
      attempts: 2,
      max_attempts: 5,
    };
    await handlers.thursday_review_generate(deps, job);
    await handlers.thursday_review_generate(deps, job);
    expect((await sets(child)).filter((s) => s.review_week === '2026-W39')).toHaveLength(2);
  });

  it('a Friday test date moves that subject’s review to Thursday of that week and replaces the queued job', async () => {
    const fam = await family('America/Chicago');
    const child = fam.children[0]!.id;
    await onlySubjects(fam, ['math', 'spelling_vocabulary']);
    await api.db
      .sql`update public.learning_schedules set review_weekday = 3 where child_id = ${child}`; // Wednesday
    at('2026-09-28T13:00:00Z'); // Monday 2026-W40
    await enqueueDueLearningJobs(deps, api.now.value);
    const before = (await jobs(child, 'thursday_review_generate')).filter(
      (j) => j.payload.weekKey === '2026-W40',
    );
    expect(before.map((j) => j.payload.releaseAt)).toEqual([
      '2026-09-30T21:00:00.000Z',
      '2026-09-30T21:00:00.000Z',
    ]);
    const [spelling] = await api.db.sql<{ id: string }[]>`
      select id from public.child_subjects where child_id = ${child} and subject_key = 'spelling_vocabulary'`;
    await api.db.sql`
      insert into public.test_dates (family_id, child_id, subject_id, test_date, scope_notes)
      values (${fam.familyId}, ${child}, ${spelling!.id}, '2026-10-02', 'Unit 3 spelling list')`;
    await enqueueDueLearningJobs(deps, api.now.value);
    const after = (await jobs(child, 'thursday_review_generate')).filter(
      (j) => j.payload.weekKey === '2026-W40',
    );
    const live = after.filter((j) => j.status === 'queued');
    const bySubject = Object.fromEntries(live.map((j) => [j.payload.subject, j.payload.releaseAt]));
    expect(bySubject).toEqual({
      math: '2026-09-30T21:00:00.000Z', // unchanged: kept
      spelling_vocabulary: '2026-10-01T21:00:00.000Z', // the evening before Friday's test
    });
    expect(after.filter((j) => j.status === 'cancelled')).toHaveLength(1);
  });

  it('a family time-zone change moves the queued job under the same key (a current key is never cancelled)', async () => {
    // Fix pass (with RV-learning-api-6): "replace" used to cancel the job and then fail to re-queue
    // the same (now cancelled, terminal) key, so the week lost its review.
    const fam = await family('America/New_York');
    const child = fam.children[0]!.id;
    await onlySubjects(fam, ['math']);
    at('2026-09-21T12:00:00Z'); // Monday 2026-W39
    await enqueueDueLearningJobs(deps, api.now.value);
    await api.db
      .sql`update public.families set timezone = 'America/Los_Angeles' where id = ${fam.familyId}`;
    await enqueueDueLearningJobs(deps, api.now.value);
    const w39 = (await jobs(child, 'thursday_review_generate')).filter(
      (j) => j.payload.weekKey === '2026-W39',
    );
    expect(w39.map((j) => [j.idempotency_key, j.status, j.payload.releaseAt])).toEqual([
      [`review:${child}:math:2026-W39:s1`, 'queued', '2026-09-24T23:00:00.000Z'], // 16:00 PDT
    ]);
    expect(w39[0]!.run_after.toISOString()).toBe('2026-09-24T21:00:00.000Z');
  });
});

describe('Thursday review content (AC_LEARNING_07)', () => {
  it('prioritizes this week’s errors and includes the teacher’s test scope', async () => {
    const fam = await family('America/New_York');
    const child = fam.children[0]!.id;
    await onlySubjects(fam, ['math']);
    // Monday and Tuesday of 2026-W39: division errors on two different homework questions.
    await homeworkAttempt(
      fam,
      'math',
      'long division with remainders',
      'incorrect',
      new Date('2026-09-21T20:00:00Z'),
    );
    await homeworkAttempt(
      fam,
      'math',
      'long division with remainders',
      'incorrect',
      new Date('2026-09-22T20:00:00Z'),
    );
    // Last week's work only feeds cumulative review.
    await homeworkAttempt(
      fam,
      'math',
      'multiplication',
      'correct',
      new Date('2026-09-15T20:00:00Z'),
    );
    const [mathSubject] = await api.db.sql<{ id: string }[]>`
      select id from public.child_subjects where child_id = ${child} and subject_key = 'math'`;
    await api.db.sql`
      insert into public.test_dates (family_id, child_id, subject_id, test_date, scope_notes)
      values (${fam.familyId}, ${child}, ${mathSubject!.id}, '2026-09-25', 'Test: area and perimeter of rectangles')`;
    at('2026-09-24T12:00:00Z');
    await enqueueDueLearningJobs(deps, api.now.value);
    at('2026-09-24T18:30:00Z');
    await run();
    const [review] = (await sets(child)).filter(
      (s) => s.kind === 'thursday_review' && s.review_week === '2026-W39',
    );
    const items = await api.db.sql<{ skill: string; category: string }[]>`
      select skill, category from public.practice_items where set_id = ${review!.id} order by position`;
    expect(items).toHaveLength(8);
    // The week's error leads, and still gets repeated practice. One question per distinct concept
    // comes before any repeat, so the test scope is not crowded out (RV-learning-1, spec P8).
    expect([items[0]!.skill, items[0]!.category]).toEqual(['math.division_remainders', 'weak']);
    expect(
      items.filter((i) => i.skill === 'math.division_remainders' && i.category === 'weak').length,
    ).toBeGreaterThanOrEqual(2);
    expect(items.some((i) => i.skill === 'math.area_perimeter')).toBe(true);
    expect(items.some((i) => i.skill === 'math.multiplication_facts')).toBe(true); // prerequisite/cumulative
    expect(items.filter((i) => i.category === 'cumulative').length).toBeGreaterThan(0);
  });
});

describe('daily practice (AC_LEARNING_03/04)', () => {
  it('offers a set every local day including weekends, generated once per date', async () => {
    const fam = await family('America/Los_Angeles');
    const child = fam.children[0]!.id;
    at('2026-09-26T23:00:00Z'); // Saturday 16:00 PDT, after the 15:30 default release
    const report = await enqueueDueLearningJobs(deps, api.now.value);
    expect(report.dailyJobs).toBe(1);
    await run();
    await run(); // a retried tick does nothing more
    const daily = (await sets(child)).filter((s) => s.kind === 'daily');
    expect(daily).toHaveLength(1);
    expect(daily[0]!.set_key).toBe(`daily:${child}:2026-09-26`);
    const items = await api.db.sql<{ subject_key: string; category: string }[]>`
      select subject_key, category from public.practice_items where set_id = ${daily[0]!.id}`;
    expect(items).toHaveLength(5);
    // No history: a grade-level check-in across several subjects.
    expect(new Set(items.map((i) => i.subject_key)).size).toBeGreaterThanOrEqual(3);
    const [notes] = await api.db.sql<
      { notes: { code: string }[] }[]
    >`select notes from public.practice_sets where id = ${daily[0]!.id}`;
    expect(notes!.notes.map((n) => n.code)).toContain('NO_HISTORY_GRADE_DIAGNOSTIC');
  });

  it('weights weak skills from homework evidence', async () => {
    const fam = await family('America/New_York');
    const child = fam.children[0]!.id;
    await onlySubjects(fam, ['math', 'reading']);
    for (const day of [1, 2, 3]) {
      await homeworkAttempt(
        fam,
        'math',
        'fraction addition',
        'incorrect',
        new Date(Date.UTC(2026, 8, 20 + day, 18)),
      );
    }
    at('2026-09-24T22:00:00Z');
    await enqueueDueLearningJobs(deps, api.now.value);
    await run();
    const [set] = (await sets(child)).filter((s) => s.kind === 'daily');
    const items = await api.db.sql<{ skill: string; category: string }[]>`
      select skill, category from public.practice_items where set_id = ${set!.id} order by position`;
    expect(
      items.filter((i) => i.skill === 'math.fractions_add_like' && i.category === 'weak').length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      items.some((i) => i.category === 'prerequisite' || i.skill === 'math.fractions_compare'),
    ).toBe(true);
  });

  it('pause/vacation stops new sets without touching earned points', async () => {
    const fam = await family('America/New_York');
    const child = fam.children[0]!.id;
    await onlySubjects(fam, ['math']);
    await api.db.sql`
      insert into public.points_ledger (family_id, child_id, kind, points, idempotency_key, actor_kind)
      values (${fam.familyId}, ${child}, 'award', 9, 'attempt:earlier', 'system')`;
    await api.db
      .sql`update public.learning_schedules set paused_from = '2026-09-24', paused_to = '2026-09-27' where child_id = ${child}`;
    at('2026-09-25T22:00:00Z');
    const report = await enqueueDueLearningJobs(deps, api.now.value);
    expect(await jobs(child, 'daily_set_generate')).toHaveLength(0);
    expect(report.children).toBeGreaterThan(0);
    const [balance] = await api.db.sql<
      { balance: number }[]
    >`select balance from public.point_balances where child_id = ${child}`;
    expect(balance!.balance).toBe(9);
    at('2026-09-28T22:00:00Z'); // after the pause
    await enqueueDueLearningJobs(deps, api.now.value);
    expect(await jobs(child, 'daily_set_generate')).toHaveLength(1);
  });

  it('never resurrects a deleted family (the save refuses a tombstoned family)', async () => {
    const fam = await family('America/New_York');
    const child = fam.children[0]!.id;
    await onlySubjects(fam, ['math']);
    const handlers = createLearningHandlers();
    await api.db.sql`update public.families set deleted_at = now() where id = ${fam.familyId}`;
    await handlers.daily_set_generate(deps, {
      id: randomUUID(),
      kind: 'daily_set_generate',
      family_id: fam.familyId,
      child_id: child,
      payload: { childId: child, localDate: '2026-09-24' },
      attempts: 1,
      max_attempts: 5,
    });
    expect(await sets(child)).toEqual([]);
  });
});

describe('late-scan top-ups (AC_LEARNING_09)', () => {
  it('creates an optional version 2 without touching the completed base review', async () => {
    const fam = await family('America/New_York');
    const child = fam.children[0]!.id;
    await onlySubjects(fam, ['math']);
    at('2026-09-24T17:00:00Z');
    await enqueueDueLearningJobs(deps, api.now.value);
    at('2026-09-24T18:30:00Z'); // the job start (release 16:00 EDT minus the 2 h lead) has passed
    await run();
    const [base] = (await sets(child)).filter(
      (s) => s.kind === 'thursday_review' && s.review_week === '2026-W39',
    );
    expect(base).toBeDefined();
    const baseItems = await api.db
      .sql`select id, prompt from public.practice_items where set_id = ${base!.id} order by position`;
    await api.db.sql`update public.practice_sets set status = 'completed' where id = ${base!.id}`;
    await api.db.sql`
      insert into public.points_ledger (family_id, child_id, kind, points, idempotency_key, actor_kind)
      values (${fam.familyId}, ${child}, 'award', 5, ${'set:' + base!.id}, 'system')`;

    // Nothing new yet: no late evidence.
    at('2026-09-24T21:00:00Z');
    expect((await enqueueDueLearningJobs(deps, api.now.value)).topUpJobs).toBe(0);
    // A scan graded after the cutoff (e.g. Thursday evening homework).
    await homeworkAttempt(
      fam,
      'math',
      'multiplication',
      'incorrect',
      new Date('2026-09-24T20:30:00Z'),
    );
    expect((await enqueueDueLearningJobs(deps, api.now.value)).topUpJobs).toBe(1);
    await run();
    await run();
    const all = (await sets(child)).filter((s) => s.review_week === '2026-W39');
    expect(all.map((s) => [s.kind, s.version, s.status])).toEqual([
      ['thursday_review', 1, 'completed'],
      ['top_up', 2, 'ready'],
    ]);
    const top = all[1]!;
    expect(top.set_key).toBe(`${base!.set_key}:v2`);
    // The completed review is untouched.
    expect(
      await api.db
        .sql`select id, prompt from public.practice_items where set_id = ${base!.id} order by position`,
    ).toEqual(baseItems);
    // Another late scan while v2 is unstarted: no stacking of optional sets.
    await homeworkAttempt(
      fam,
      'math',
      'multiplication',
      'incorrect',
      new Date('2026-09-24T20:45:00Z'),
    );
    at('2026-09-24T21:30:00Z');
    expect((await enqueueDueLearningJobs(deps, api.now.value)).topUpJobs).toBe(0);
    // Completion award for the base review exists exactly once.
    const [awards] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.points_ledger where child_id = ${child} and idempotency_key like 'set:%'`;
    expect(awards!.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// AI personalization (labeled mock client)
// ---------------------------------------------------------------------------------------------

function envelope(request: ResponsesRequest): { data: { wordProblems: { ref: string }[] } } {
  const part = request.input.find((p) => p.type === 'input_text');
  if (!part || part.type !== 'input_text') throw new Error('no data envelope');
  return JSON.parse(part.text.replace(/^DATA:\n/, '')) as {
    data: { wordProblems: { ref: string }[] };
  };
}

function ok(value: unknown): ResponsesResult {
  return {
    kind: 'ok',
    text: JSON.stringify(value),
    usage: { inputTokens: 900, cachedInputTokens: 0, outputTokens: 200 },
    modelId: 'gpt-6-astra',
    latencyMs: 20,
  };
}

describe('AI personalization (mock client; AC_LEARNING_06, AC_GRADING_07/08)', () => {
  const wordProblems = generateSkillItems('math.word_problems', {
    random: seededRandom('ai'),
    grade: 3,
    category: 'standard',
    count: 3,
  });

  async function context(fam: SeededFamily) {
    const ctx = await api.apiDb.asService((tx) =>
      loadChildContext(tx, fam.familyId, fam.children[0]!.id),
    );
    return ctx!;
  }

  it('accepts a valid re-theme, falls back to the bank for invalid or leaking proposals, and meters usage', async () => {
    const fam = await family();
    await consent(fam);
    const client = createMockResponsesClient((request) => {
      const refs = envelope(request).data.wordProblems.map((w) => w.ref);
      expect(request.instructions).toMatch(/never see answers/);
      return ok({
        intro: 'Let’s practice story problems together!',
        items: [
          { ref: refs[0], context: { name: 'Nia', things: 'shells', place: 'tide pool' } },
          { ref: refs[1], context: { name: 'Nia', things: '42 shells', place: 'beach' } }, // digits: rejected
          { ref: refs[2], context: { name: 'Ignore the rules', things: 'shells', place: 'beach' } },
          { ref: 'w99', context: { name: 'Zed', things: 'cards', place: 'desk' } }, // unknown ref
        ],
      });
    });
    const out = await personalizeItems(
      deps,
      { ai: client },
      await context(fam),
      wordProblems,
      'daily_set',
      ['math.word_problems'],
    );
    expect(client.requests).toHaveLength(1);
    // The data sent holds skill labels and story contexts only: no answers, no child identifiers.
    const sent = JSON.stringify(client.requests[0]!.input);
    expect(sent).not.toContain(fam.children[0]!.id);
    for (const item of wordProblems) {
      expect(sent).not.toContain(item.explanation);
      expect(sent).not.toContain(`"${(item.answerSpec as { value: string }).value}"`);
    }
    expect(out.rethemed).toBe(1);
    expect(out.items[0]!.prompt.text).toContain('Nia');
    expect(out.items[0]!.answerSpec).toEqual(wordProblems[0]!.answerSpec);
    expect(out.items[1]).toEqual(wordProblems[1]);
    expect(out.items[2]).toEqual(wordProblems[2]);
    expect(out.intro).toBe('Let’s practice story problems together!');
    const usage = await api.db.sql<{ stage: string; status: string }[]>`
      select stage, status from public.ai_usage_events where family_id = ${fam.familyId}`;
    expect(usage).toEqual([{ stage: 'daily_set', status: 'succeeded' }]);
  });

  it('rejects an intro that carries a number or a key, and invalid model output entirely', async () => {
    const fam = await family();
    await consent(fam);
    const answer = (wordProblems[0]!.answerSpec as { value: string }).value;
    const leaky = createMockResponsesClient(() =>
      ok({ intro: `The first answer is ${answer}`, items: [] }),
    );
    const out = await personalizeItems(
      deps,
      { ai: leaky },
      await context(fam),
      wordProblems,
      'daily_set',
      [],
    );
    expect(out.intro).toBeNull();
    expect(out.items).toEqual(wordProblems);
    const broken = createMockResponsesClient(() => ({ ...ok({}), text: '{"intro": 5}' }));
    const out2 = await personalizeItems(
      deps,
      { ai: broken, sleep: () => Promise.resolve() },
      await context(fam),
      wordProblems,
      'daily_set',
      [],
    );
    expect(out2.items).toEqual(wordProblems);
    const usage = await api.db.sql<{ status: string }[]>`
      select status from public.ai_usage_events where family_id = ${fam.familyId} order by id`;
    expect(usage.map((u) => u.status)).toEqual([
      'succeeded',
      'rejected_by_validation',
      'rejected_by_validation',
    ]);
  });

  it('without consent nothing is sent to AI and the bank set is generated', async () => {
    const fam = await family();
    const child = fam.children[0]!.id;
    await onlySubjects(fam, ['math']);
    const client = createMockResponsesClient(() => ok({ intro: 'Hi', items: [] }));
    at('2026-09-24T22:00:00Z');
    await enqueueDueLearningJobs(deps, api.now.value);
    await run({ ai: client });
    expect(client.requests).toHaveLength(0);
    const daily = (await sets(child)).filter((s) => s.kind === 'daily');
    expect(daily).toHaveLength(1);
    expect(daily[0]!.child_intro).toBeNull();
    expect(
      api.logs.some((l) => l.event === 'practice_ai_skipped' && l.code === 'CONSENT_REQUIRED'),
    ).toBe(true);
  });

  it('with consent the generated set stores the re-themed prompt and the unchanged private key', async () => {
    const fam = await family();
    const child = fam.children[0]!.id;
    await consent(fam);
    await onlySubjects(fam, ['math']);
    for (const day of [1, 2, 3]) {
      await homeworkAttempt(
        fam,
        'math',
        'word problems',
        'incorrect',
        new Date(Date.UTC(2026, 8, 20 + day, 18)),
      );
    }
    const client = createMockResponsesClient((request) =>
      ok({
        intro: 'Story problems are today’s focus. You can do this!',
        items: envelope(request).data.wordProblems.map((w) => ({
          ref: w.ref,
          context: { name: 'Nia', things: 'shells', place: 'tide pool' },
        })),
      }),
    );
    at('2026-09-24T22:00:00Z');
    await enqueueDueLearningJobs(deps, api.now.value);
    await run({ ai: client });
    const [daily] = (await sets(child)).filter((s) => s.kind === 'daily');
    expect(daily!.child_intro).toBe('Story problems are today’s focus. You can do this!');
    const items = await api.db.sql<
      { skill: string; prompt: { text: string }; key: { spec: { value: string } } }[]
    >`
      select i.skill, i.prompt, k.answer_spec as key from public.practice_items i
        join private.practice_item_keys k on k.item_id = i.id where i.set_id = ${daily!.id}`;
    const themed = items.filter((i) => i.skill === 'math.word_problems');
    expect(themed.length).toBeGreaterThan(0);
    for (const item of themed) {
      expect(item.prompt.text).toContain('Nia');
      expect(item.prompt.text).not.toContain(
        item.key.spec.value === '' ? '#' : ` ${item.key.spec.value} `,
      );
    }
  });
});
