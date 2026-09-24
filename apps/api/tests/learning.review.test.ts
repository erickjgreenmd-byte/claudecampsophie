import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  childReviewsResponseSchema,
  practiceAnswerResponseSchema,
  skillsResponseSchema,
} from '@pencillift/contracts';
import { createMockResponsesClient, type ResponsesResult } from '@pencillift/ai';
import { cryptoRandom } from '@pencillift/domain';
import { generateSkillItems, seededRandom, type AnswerSpec } from '@pencillift/domain/bank';
import { grantAdultUnlock, seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { runJobs, type JobDeps, type JobRow } from '../src/jobs/dispatcher.ts';
import {
  createLearningHandlers,
  enqueueDueLearningJobs,
  loadChildContext,
  personalizeItems,
  rescheduleReviewJobs,
} from '../src/jobs/learning-jobs.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * Adversarial review regressions for the learning vertical (spec P6-P9; AC_LEARNING_01/02/06/08,
 * AC_REWARDS_01). Real Postgres. Synthetic children only (Riley, Sam). AI calls use a LABELED MOCK
 * client (createMockResponsesClient); no provider result is fabricated as real.
 */

let api: TestApi;
let deps: JobDeps;
let pairCount = 0;

const at = (iso: string) => {
  api.now.value = new Date(iso);
};
/** A parent session with a recent step-up (pairing codes need one). */
async function unlockedParent(family: SeededFamily): Promise<string> {
  const sessionId = randomUUID();
  await grantAdultUnlock(api.db, family.ownerId, sessionId, 3600);
  return parentToken(family.ownerId, { sessionId });
}
const advance = (ms: number) => {
  api.now.value = new Date(api.now.value.getTime() + ms);
};

async function childToken(family: SeededFamily, parent: string, index = 0): Promise<string> {
  const code = await api.request(`/v1/children/${family.children[index]!.id}/pairing-code`, {
    method: 'POST',
    token: parent,
  });
  expect(code.status).toBe(201);
  pairCount += 1;
  const paired = await api.request('/v1/child/pair', {
    method: 'POST',
    headers: { 'cf-connecting-ip': `203.0.113.${pairCount}` },
    body: {
      code: (await json<{ code: string }>(code)).code,
      deviceLabel: `Review tablet ${pairCount}`,
      platform: 'ios',
    },
  });
  expect(paired.status).toBe(201);
  return (await json<{ accessToken: string }>(paired)).accessToken;
}

async function onlySubjects(fam: SeededFamily, keys: string[], childIndex = 0) {
  const childId = fam.children[childIndex]!.id;
  await api.db.sql`
    insert into public.learning_schedules (child_id, family_id) values (${childId}, ${fam.familyId})
    on conflict do nothing`;
  for (const key of keys) {
    await api.db.sql`
      insert into public.child_subjects (family_id, child_id, subject_key, display_name)
      values (${fam.familyId}, ${childId}, ${key}, ${key})`;
  }
}

interface DirectItem {
  readonly subject: string;
  readonly skill: string;
  readonly text: string;
  readonly spec: AnswerSpec;
  readonly instanceKey: string;
  readonly templateKey: string;
}

/** Saves a set exactly as `saveSet` does (set + child-safe items + private keys). */
async function directSet(
  fam: SeededFamily,
  childIndex: number,
  kind: 'daily' | 'thursday_review',
  releaseAt: Date,
  items: readonly DirectItem[],
): Promise<{ setId: string; itemIds: string[] }> {
  const childId = fam.children[childIndex]!.id;
  const [set] = await api.db.sql<{ id: string }[]>`
    insert into public.practice_sets (family_id, child_id, kind, set_key, subject_key, local_date, review_week,
                                      version, status, ready_at, release_at, evidence_cutoff_at)
    values (${fam.familyId}, ${childId}, ${kind}, ${'review-test:' + randomUUID()},
            ${kind === 'daily' ? null : items[0]!.subject}, ${kind === 'daily' ? releaseAt.toISOString().slice(0, 10) : null},
            ${kind === 'daily' ? null : '2026-W39'}, 1, 'ready', ${releaseAt}, ${releaseAt}, ${releaseAt})
    returning id`;
  const itemIds: string[] = [];
  let position = 0;
  for (const item of items) {
    position += 1;
    const prompt = {
      text: item.text,
      choices: null,
      passage: null,
      responseFormat: 'number',
      unitHint: null,
    };
    const [row] = await api.db.sql<{ id: string }[]>`
      insert into public.practice_items (set_id, family_id, child_id, position, subject_key, skill, category, prompt)
      values (${set!.id}, ${fam.familyId}, ${childId}, ${position}, ${item.subject}, ${item.skill}, 'weak',
              ${JSON.stringify(prompt)}::text::jsonb)
      returning id`;
    const key = {
      spec: item.spec,
      instanceKey: item.instanceKey,
      templateKey: item.templateKey,
      generator: 'practice.v1',
    };
    await api.db.sql`
      insert into private.practice_item_keys (item_id, family_id, answer_spec, explanation)
      values (${row!.id}, ${fam.familyId}, ${JSON.stringify(key)}::text::jsonb, 'synthetic explanation')`;
    itemIds.push(row!.id);
  }
  return { setId: set!.id, itemIds };
}

function mathItem(a: number, b: number, instanceKey?: string): DirectItem {
  return {
    subject: 'math',
    skill: 'math.multiplication_facts',
    text: `What is ${a} × ${b}?`,
    spec: { kind: 'numeric', value: String(a * b), unit: null, alternates: [] },
    instanceKey: instanceKey ?? `math.multiplication_facts.v1#${a}x${b}`,
    templateKey: 'math.multiplication_facts.v1',
  };
}

function answer(child: string, itemId: string, text: string, idempotencyKey = randomUUID()) {
  return api.request(`/v1/child/practice/items/${itemId}/answer`, {
    method: 'POST',
    token: child,
    body: { answer: text, idempotencyKey },
  });
}

let fam: SeededFamily;
let owner: string;
let riley: string;
let sam: string;

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
  fam = await seedFamily(api.db, { childCount: 2, timezone: 'America/Chicago' });
  owner = await unlockedParent(fam);
  riley = await childToken(fam, owner, 0);
  sam = await childToken(fam, owner, 1);
});

afterAll(async () => {
  await api?.close();
});

// ---------------------------------------------------------------------------------------------
// RV-learning-api-1: the SAME bank question served again counts as a new "distinct" question
// ---------------------------------------------------------------------------------------------

describe('RV-learning-api-1: re-served bank questions must not inflate distinct evidence (AC_LEARNING_01/02, spec P7)', () => {
  it('five correct answers to one identical question are one distinct question, not five', async () => {
    // The bank re-serves an instance after RECENT_ITEM_DAYS (or when RECENT_TEMPLATE_REUSED); every
    // serving is a new practice item id, and attempts are keyed by that id.
    const sameQuestion = mathItem(7, 8, 'math.multiplication_facts.v1#deadbeef');
    for (let day = 0; day < 5; day += 1) {
      at(`2026-09-${25 + day}T20:00:00Z`);
      const { itemIds } = await directSet(
        fam,
        0,
        'daily',
        new Date(api.now.value.getTime() - 3_600_000),
        [sameQuestion],
      );
      const res = practiceAnswerResponseSchema.parse(
        await json(await answer(riley, itemIds[0]!, '56')),
      );
      expect(res.result).toBe('correct');
    }
    const body = skillsResponseSchema.parse(
      await json(await api.request(`/v1/children/${fam.children[0]!.id}/skills`, { token: owner })),
    );
    const skill = body.skills.find((s) => s.skill === 'math.multiplication_facts')!;
    // Actual: distinctIndependentQuestions = 5 and the status leaves "Not enough evidence" after
    // the child answered one memorized question five times.
    expect(skill.distinctIndependentQuestions).toBe(1);
    expect(skill.status).toBe('not_enough_evidence');
  });
});

// ---------------------------------------------------------------------------------------------
// RV-learning-api-2: loadEvidence keeps the OLDEST 5000 events and drops the newest
// ---------------------------------------------------------------------------------------------

describe('RV-learning-api-2: the skills dashboard must reflect the newest evidence (AC_LEARNING_01, spec P7/P10)', () => {
  it('recent practice is shown even when the child has more than 5000 attempts in the lookback year', async () => {
    at('2026-09-30T18:00:00Z');
    const samId = fam.children[1]!.id;
    // A busy year of older practice (well inside the 365-day skills window).
    await api.db.sql`
      insert into public.attempts (family_id, child_id, question_instance_id, source, subject_key, skill,
                                   attempt_number, correctness, grader_version, idempotency_key, occurred_at)
      select ${fam.familyId}, ${samId}, gen_random_uuid(), 'homework', 'math', 'math.multiplication_facts', 1,
             'correct', 'test', 'bulk-attempt:' || g, ${new Date('2026-03-01T18:00:00Z')}::timestamptz + g * interval '1 minute'
        from generate_series(1, 5000) g`;
    // This week's practice on another skill.
    for (let i = 0; i < 6; i += 1) {
      await api.db.sql`
        insert into public.attempts (family_id, child_id, question_instance_id, source, subject_key, skill,
                                     attempt_number, correctness, grader_version, idempotency_key, occurred_at)
        values (${fam.familyId}, ${samId}, ${randomUUID()}, 'homework', 'math', 'math.decimals', 1,
                ${i < 2 ? 'incorrect' : 'correct'}, 'test', ${'recent:' + randomUUID()},
                ${new Date(Date.UTC(2026, 8, 25 + (i % 4), 18))})`;
    }
    const body = skillsResponseSchema.parse(
      await json(await api.request(`/v1/children/${samId}/skills`, { token: owner })),
    );
    // Actual: `order by occurred_at, id limit 5000` keeps the 5000 OLDEST rows, so this week's
    // decimals practice (and every newer event) is missing from the dashboard and exports.
    const decimals = body.skills.find((s) => s.skill === 'math.decimals');
    expect(decimals?.distinctQuestions).toBe(6);
  });
});

// ---------------------------------------------------------------------------------------------
// RV-learning-api-3: completion points for a set "finished" only by rapid wrong guesses
// ---------------------------------------------------------------------------------------------

describe('RV-learning-api-3: rapid guessing must not farm set-completion points (AC_REWARDS_01, spec P9)', () => {
  it('a set exhausted by instant wrong guesses earns no completion award', async () => {
    at('2026-10-01T20:00:00Z');
    const { setId, itemIds } = await directSet(
      fam,
      1,
      'daily',
      new Date(api.now.value.getTime() - 3_600_000),
      [mathItem(3, 4, 'rv3#a'), mathItem(6, 7, 'rv3#b'), mathItem(8, 9, 'rv3#c')],
    );
    // Nine guesses submitted in the same instant (no time passes between them): every one after the
    // first is below the minimum meaningful response time.
    for (const itemId of itemIds) {
      for (let i = 0; i < 3; i += 1) {
        const res = await answer(sam, itemId, '1');
        expect(res.status).toBe(200);
      }
    }
    const [set] = await api.db.sql<{ status: string }[]>`
      select status from public.practice_sets where id = ${setId}`;
    expect(set!.status).toBe('completed');
    const completion = await api.db.sql<{ points: number }[]>`
      select points from public.points_ledger where idempotency_key = ${'set:' + setId}`;
    // Actual: 5 completion points for a set whose only "work" was nine instant guesses.
    expect(completion).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// RV-learning-api-4: concurrent answers on the last two open questions lose the completion
// ---------------------------------------------------------------------------------------------

describe('RV-learning-api-4: a set whose last questions are answered concurrently still completes (spec P9)', () => {
  it('two devices finishing the last two questions at the same time complete the set once', async () => {
    const riley2 = await childToken(fam, owner, 0); // Riley's second device
    const lost: string[] = [];
    for (let round = 0; round < 12; round += 1) {
      at(`2026-10-02T${String(8 + round).padStart(2, '0')}:00:00Z`);
      const { setId, itemIds } = await directSet(
        fam,
        0,
        'daily',
        new Date(api.now.value.getTime() - 3_600_000),
        [
          mathItem(2, 3, `rv4#${round}a`),
          mathItem(4, 5, `rv4#${round}b`),
          mathItem(6, 6, `rv4#${round}c`),
        ],
      );
      expect((await answer(riley, itemIds[0]!, '6')).status).toBe(200); // set -> in_progress
      // One wrong try on each remaining question (effort points are earned here) ...
      for (const itemId of itemIds.slice(1)) {
        advance(30_000);
        expect((await answer(riley, itemId, '1')).status).toBe(200);
      }
      advance(30_000);
      // ... then the corrected answers arrive together from two devices. They award no new
      // per-question points (already earned), so nothing else serializes the two transactions.
      const [a, b] = await Promise.all([
        answer(riley, itemIds[1]!, '20'),
        answer(riley2, itemIds[2]!, '36'),
      ]);
      expect(practiceAnswerResponseSchema.parse(await json(a)).result).toBe('correct');
      expect(practiceAnswerResponseSchema.parse(await json(b)).result).toBe('correct');
      const [set] = await api.db.sql<{ status: string }[]>`
        select status from public.practice_sets where id = ${setId}`;
      const award = await api.db.sql`
        select 1 from public.points_ledger where idempotency_key = ${'set:' + setId}`;
      if (set!.status !== 'completed' || award.length !== 1)
        lost.push(`round ${round}: ${set!.status}, completion awards ${award.length}`);
    }
    // Actual: under READ COMMITTED each transaction still counts the other's question as open, so
    // neither marks the set completed; with every question solved no later answer re-checks it,
    // and the completion award is never made.
    expect(lost).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// RV-learning-api-5: "next week" computed as now + 168 h skips a week before a DST spring-forward
// ---------------------------------------------------------------------------------------------

describe('RV-learning-api-5: a released Monday-test review stays visible on Sunday night in a DST week (AC_LEARNING_08)', () => {
  it('New York, Sunday 2026-03-01 23:30 EST: the W10 review released at 16:00 is still shown', async () => {
    const ny = await seedFamily(api.db, { childCount: 1, timezone: 'America/New_York' });
    const nyOwner = await unlockedParent(ny);
    at('2026-09-24T15:00:00Z');
    const child = await childToken(ny, nyOwner, 0);
    await onlySubjects(ny, ['math']);
    const [math] = await api.db.sql<{ id: string }[]>`
      select id from public.child_subjects where child_id = ${ny.children[0]!.id} and subject_key = 'math'`;
    await api.db.sql`
      insert into public.test_dates (family_id, child_id, subject_id, test_date)
      values (${ny.familyId}, ${ny.children[0]!.id}, ${math!.id}, '2026-03-02')`;
    // Sunday 2026-03-01 14:30 EST: the Monday-test review (keyed 2026-W10) is generated for 16:00 EST.
    at('2026-03-01T19:30:00Z');
    await enqueueDueLearningJobs(deps, api.now.value);
    await runJobs(deps, createLearningHandlers());
    const [set] = await api.db.sql<{ id: string; release_at: Date }[]>`
      select id, release_at from public.practice_sets
       where child_id = ${ny.children[0]!.id} and kind = 'thursday_review' and review_week = '2026-W10'`;
    expect(set!.release_at.toISOString()).toBe('2026-03-01T21:00:00.000Z');

    const visible = async () => {
      const body = childReviewsResponseSchema.parse(
        await json(await api.request('/v1/child/reviews/current', { token: child })),
      );
      return body.sections.flatMap((s) => s.sets.map((x) => x.id));
    };
    at('2026-03-02T03:30:00Z'); // Sunday 22:30 EST: visible (control)
    expect(await visible()).toContain(set!.id);
    at('2026-03-02T04:30:00Z'); // Sunday 23:30 EST, the night before the test
    // Actual: now + 7 * 24 h lands on Monday 2026-03-09 00:30 EDT (week W11), so the queried weeks
    // are [W09, W11] and the released W10 review disappears for the last hour of Sunday.
    expect(await visible()).toContain(set!.id);
  });
});

// ---------------------------------------------------------------------------------------------
// RV-learning-api-6: a tick that loaded the schedule just before a parent change kills the week
// ---------------------------------------------------------------------------------------------

describe('RV-learning-api-6: a schedule change racing the scheduled tick still gets a review (AC_LEARNING_08, spec P8)', () => {
  it('the week keeps exactly one live review job at the new time, and the review is generated', async () => {
    const other = await seedFamily(api.db, { childCount: 1, timezone: 'America/New_York' });
    const otherOwner = await unlockedParent(other);
    const childId = other.children[0]!.id;
    await onlySubjects(other, ['math']);
    at('2026-09-21T15:00:00Z'); // Monday 2026-W39
    await enqueueDueLearningJobs(deps, api.now.value); // v1 jobs: Thursday 16:00 EDT
    // The scheduled tick for this child has loaded its context (schedule_version 1) ...
    const staleCtx = (await api.apiDb.asService((tx) =>
      loadChildContext(tx, other.familyId, childId),
    ))!;
    expect(staleCtx.schedule.schedule_version).toBe(1);
    // ... when the parent moves the review to 18:00 (version 2; the route replaces the v1 jobs) ...
    const put = await api.request(`/v1/children/${childId}/learning-schedule`, {
      method: 'PUT',
      token: otherOwner,
      body: {
        reviewWeekday: 4,
        reviewLocalTime: '18:00',
        reviewQuestionsPerSubject: 8,
        dailyLocalTime: '15:30',
        dailyQuestionCount: 5,
        pause: null,
        quietHours: null,
        childRemindersPermitted: false,
      },
    });
    expect(put.status).toBe(200);
    // ... and the tick's per-child transaction then reads the jobs (READ COMMITTED: it sees the
    // parent's committed jobs but still plans with the schedule it loaded).
    await api.apiDb.asService((tx) => rescheduleReviewJobs(tx, staleCtx, api.now.value));
    // Later ticks run with the fresh schedule.
    await enqueueDueLearningJobs(deps, api.now.value);
    const live = await api.db.sql<{ payload: { weekKey: string; releaseAt: string } }[]>`
      select payload from public.jobs
       where kind = 'thursday_review_generate' and child_id = ${childId}
         and payload->>'weekKey' = '2026-W39' and status in ('queued', 'failed_retryable')`;
    // Actual: the stale tick cancels the v2 job and cannot re-insert the (cancelled) v1 key; the
    // next tick cannot re-insert the (cancelled) v2 key either, so no live job remains.
    expect(live.map((j) => j.payload.releaseAt)).toEqual(['2026-09-24T22:00:00.000Z']);
    at('2026-09-24T20:30:00Z');
    await enqueueDueLearningJobs(deps, api.now.value);
    // Test correction (fix pass): the queue is shared with the other families in this file (30 jobs
    // are due here, including RV-5's March leftovers) and one runJobs call claims at most 25, so
    // this job was never reached. Drain the due queue as successive scheduled ticks would.
    await runJobs(deps, createLearningHandlers(), 500);
    const reviews = await api.db.sql`
      select id from public.practice_sets
       where child_id = ${childId} and kind = 'thursday_review' and review_week = '2026-W39'`;
    expect(reviews).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// RV-learning-api-7: the AI intro line is released with no content check beyond charset + leak guard
// ---------------------------------------------------------------------------------------------

function mockOk(value: unknown): ResponsesResult {
  return {
    kind: 'ok',
    text: JSON.stringify(value),
    usage: { inputTokens: 900, cachedInputTokens: 0, outputTokens: 60 },
    modelId: 'gpt-6-astra',
    latencyMs: 20,
  };
}

describe('RV-learning-api-7: unsafe AI intro lines never reach the child (spec P6/P12; mock AI client)', () => {
  it('an intro that sends the child after the parent password and the answer key is rejected', async () => {
    const aiFam = await seedFamily(api.db, { childCount: 1, timezone: 'America/Chicago' });
    await api.db.sql`
      insert into public.consent_records (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
      values (${aiFam.familyId}, ${aiFam.ownerId}, 'mock', 'mock', 'child_learning_data', 'v1', 'verified', true, now())`;
    const ctx = (await api.apiDb.asService((tx) =>
      loadChildContext(tx, aiFam.familyId, aiFam.children[0]!.id),
    ))!;
    const items = generateSkillItems('math.word_problems', {
      random: seededRandom('rv7'),
      grade: 3,
      category: 'standard',
      count: 2,
    });
    // LABELED MOCK: a model output that the context validator would refuse word-for-word
    // ("parent", "password", "answer", "key" are on its denylist), placed in the intro instead.
    const mock = createMockResponsesClient(() =>
      mockOk({
        intro: 'Ask your parent for the password and type the answer key here',
        items: [],
      }),
    );
    const out = await personalizeItems(deps, { ai: mock }, ctx, items, 'daily_set', []);
    expect(mock.requests).toHaveLength(1);
    // Actual: the intro passes INTRO_RE (letters/spaces) and the answer-leak guard, and is stored
    // as practice_sets.child_intro, shown to the child.
    expect(out.intro).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// RV-learning-api-8: two review jobs of different schedule versions both create a base review
// ---------------------------------------------------------------------------------------------

describe('RV-learning-api-8: concurrent workers never create two base reviews for one child/subject/week (AC_LEARNING_08)', () => {
  it('jobs keyed s1 and s2 for the same week, run by two workers at once, save one review', async () => {
    const dup = await seedFamily(api.db, { childCount: 1, timezone: 'America/New_York' });
    const childId = dup.children[0]!.id;
    const subjects = [
      'math',
      'reading',
      'spelling_vocabulary',
      'grammar_writing',
      'science',
      'social_studies',
    ];
    await onlySubjects(dup, subjects);
    at('2026-09-24T18:30:00Z'); // Thursday 14:30 EDT: the jobs are due (release 16:00 EDT)
    const handlers = createLearningHandlers();
    const duplicated: string[] = [];
    for (const subject of subjects) {
      // Two live jobs for one week exist when `rescheduleReviewJobs` "replaces" a job that a worker
      // claimed between its status read and its cancel (the cancel updates 0 rows, the new key is
      // still inserted). Two workers then run one each at the same time (called directly, as the
      // dispatcher would after claiming them).
      const jobsForWeek: JobRow[] = [];
      for (const version of [1, 2]) {
        const payload = {
          childId,
          subject,
          weekKey: '2026-W39',
          scheduleVersion: version,
          releaseAt: '2026-09-24T20:00:00.000Z',
        };
        const [row] = await api.db.sql<{ id: string }[]>`
          insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, run_after, status, attempts)
          values ('thursday_review_generate', ${`review:${childId}:${subject}:2026-W39:s${version}`}, ${dup.familyId},
                  ${childId}, ${JSON.stringify(payload)}::text::jsonb, ${new Date('2026-09-24T18:00:00Z')}, 'running', 1)
          returning id`;
        jobsForWeek.push({
          id: row!.id,
          kind: 'thursday_review_generate',
          family_id: dup.familyId,
          child_id: childId,
          payload,
          attempts: 1,
          max_attempts: 5,
        });
      }
      await Promise.all(jobsForWeek.map((job) => handlers.thursday_review_generate(deps, job)));
      const reviews = await api.db.sql<{ set_key: string }[]>`
        select set_key from public.practice_sets
         where child_id = ${childId} and kind = 'thursday_review' and subject_key = ${subject}
           and review_week = '2026-W39'`;
      if (reviews.length !== 1) duplicated.push(`${subject}: ${reviews.length} base reviews`);
    }
    // Actual: the handler's "no base review exists yet" check and its insert run in separate
    // transactions under different set keys, so two workers both save a base review for the same
    // child/subject/week (two sets for the child, two completion awards possible).
    expect(duplicated).toEqual([]);
  });
});
