import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  childRewardsResponseSchema,
  practiceAnswerResponseSchema,
  rewardRulesResponseSchema,
  rewardRulesUpdateResponseSchema,
  type FamilyRewardRules,
  type PracticeAnswerResponse,
} from '@pencillift/contracts';
import { cryptoRandom } from '@pencillift/domain';
import { keyAnswerText, type AnswerSpec } from '@pencillift/domain/bank';
import { grantAdultUnlock, seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { runJobs, type JobDeps } from '../src/jobs/dispatcher.ts';
import { createLearningHandlers, enqueueDueLearningJobs } from '../src/jobs/learning-jobs.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * Family earning rules (spec P9 "configurable earning rules"; AC_REWARDS_01 "Earned points, bonus
 * rules and caps match the published family rules; empty/rapid retries do not farm points").
 * Real Postgres through the production client; awards come from the real practice answer route.
 * Synthetic families: Riley and Sam in `fam`; one child each in `other` and `low`.
 */

let api: TestApi;
let deps: JobDeps;
let fam: SeededFamily;
let other: SeededFamily;
let low: SeededFamily;
let token: string; // unlocked owner session
let lockedToken: string; // same owner, no step-up
let guardianToken: string; // unlocked second adult (guardian) of `fam`
let otherToken: string; // unlocked owner of another family
let lowToken: string;
let riley: string;
let otherChild: string;
let lowChild: string;
let pairCount = 0;
const SESSION = 'a1a1a1a1-1111-4111-8111-111111111750';
const LOCKED_SESSION = 'b2b2b2b2-2222-4222-8222-222222222750';
const GUARDIAN_SESSION = 'c3c3c3c3-3333-4333-8333-333333333750';
const OTHER_SESSION = 'd4d4d4d4-4444-4444-8444-444444444750';
const LOW_SESSION = 'e5e5e5e5-5555-4555-8555-555555555750';

const SUGGESTED: FamilyRewardRules = {
  attemptPoints: 2,
  independentCorrectBonus: 3,
  setCompletionPoints: 5,
  minMeaningfulResponseMs: 1500,
};

type ErrorBody = { error: { code: string; message: string } };

async function childToken(family: SeededFamily, parent: string, index = 0): Promise<string> {
  const code = await api.request(`/v1/children/${family.children[index]!.id}/pairing-code`, {
    method: 'POST',
    token: parent,
  });
  expect(code.status).toBe(201);
  pairCount += 1;
  const paired = await api.request('/v1/child/pair', {
    method: 'POST',
    headers: { 'cf-connecting-ip': `198.51.100.${pairCount + 100}` },
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
  low = await seedFamily(api.db, { childCount: 1, timezone: 'America/Chicago' });
  const guardianId = await api.db.createUser();
  await api.db.sql`
    insert into public.family_memberships (family_id, user_id, role, status, invited_by)
    values (${fam.familyId}, ${guardianId}, 'guardian', 'active', ${fam.ownerId})`;
  await grantAdultUnlock(api.db, fam.ownerId, SESSION, 3600);
  await grantAdultUnlock(api.db, guardianId, GUARDIAN_SESSION, 3600);
  await grantAdultUnlock(api.db, other.ownerId, OTHER_SESSION, 3600);
  await grantAdultUnlock(api.db, low.ownerId, LOW_SESSION, 3600);
  token = await parentToken(fam.ownerId, { sessionId: SESSION });
  lockedToken = await parentToken(fam.ownerId, { sessionId: LOCKED_SESSION });
  guardianToken = await parentToken(guardianId, { sessionId: GUARDIAN_SESSION });
  otherToken = await parentToken(other.ownerId, { sessionId: OTHER_SESSION });
  lowToken = await parentToken(low.ownerId, { sessionId: LOW_SESSION });
  riley = await childToken(fam, token, 0);
  otherChild = await childToken(other, otherToken, 0);
  lowChild = await childToken(low, lowToken, 0);
});

afterAll(async () => {
  await api?.close();
});

function getRules(t: string) {
  return api.request('/v1/reward-rules', { token: t });
}

function putRules(body: unknown, t = token) {
  return api.request('/v1/reward-rules', { method: 'PUT', token: t, body });
}

async function rulesOf(t: string): Promise<FamilyRewardRules> {
  const res = await getRules(t);
  expect(res.status).toBe(200);
  return rewardRulesResponseSchema.parse(await json(res)).rules;
}

async function ruleAudits(familyId: string) {
  return api.db.sql<{ actor_user_id: string; metadata: { after: unknown } }[]>`
    select actor_user_id, metadata from public.audit_events
     where family_id = ${familyId} and action = 'reward_rules.updated' order by id`;
}

// ---------------------------------------------------------------------------------------------
// Parent API
// ---------------------------------------------------------------------------------------------

describe('family earning rules: parent API (spec P9)', () => {
  it('shows the suggested rules until the family changes them; reading needs no step-up', async () => {
    const res = await getRules(lockedToken);
    expect(res.status).toBe(200);
    const raw = await json<Record<string, unknown>>(res);
    const body = rewardRulesResponseSchema.parse(raw);
    expect(Object.keys(raw).sort()).toEqual(['rules', 'suggested', 'updatedAt']);
    expect(body).toEqual({ rules: SUGGESTED, suggested: SUGGESTED, updatedAt: null });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('changing the rules needs a recent parent step-up', async () => {
    const denied = await putRules({ ...SUGGESTED, attemptPoints: 9 }, lockedToken);
    expect(denied.status).toBe(403);
    expect((await json<ErrorBody>(denied)).error.code).toBe('STEP_UP_REQUIRED');
    expect(await rulesOf(token)).toEqual(SUGGESTED);
    expect(await ruleAudits(fam.familyId)).toEqual([]);
  });

  it('validates like the database: whole points 0–100, threshold 500–60000 ms, nothing extra', async () => {
    const invalid: unknown[] = [
      { ...SUGGESTED, attemptPoints: 101 },
      { ...SUGGESTED, attemptPoints: -1 },
      { ...SUGGESTED, independentCorrectBonus: 2.5 },
      { ...SUGGESTED, setCompletionPoints: '5' },
      { ...SUGGESTED, minMeaningfulResponseMs: 499 },
      { ...SUGGESTED, minMeaningfulResponseMs: 0 },
      { ...SUGGESTED, minMeaningfulResponseMs: 60_001 },
      { attemptPoints: 2, independentCorrectBonus: 3, setCompletionPoints: 5 },
      { ...SUGGESTED, familyId: other.familyId },
      { ...SUGGESTED, maxAwardsPerQuestionInstance: 5 },
      [],
      null,
    ];
    for (const body of invalid) {
      const res = await putRules(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await json<ErrorBody>(res)).error.code).toBe('VALIDATION_FAILED');
    }
    expect(await rulesOf(token)).toEqual(SUGGESTED);
    expect(await ruleAudits(fam.familyId)).toEqual([]);
  });

  it('a save is an idempotent upsert: the same rules twice change nothing and audit once', async () => {
    const next = {
      attemptPoints: 4,
      independentCorrectBonus: 6,
      setCompletionPoints: 10,
      minMeaningfulResponseMs: 2000,
    };
    const first = await putRules(next);
    expect(first.status).toBe(200);
    const saved = rewardRulesUpdateResponseSchema.parse(await json(first));
    expect(saved).toMatchObject({ rules: next, suggested: SUGGESTED, changed: true });
    expect(saved.updatedAt).not.toBeNull();
    const again = rewardRulesUpdateResponseSchema.parse(await json(await putRules(next)));
    expect(again).toMatchObject({ rules: next, changed: false, updatedAt: saved.updatedAt });
    expect(await rulesOf(lockedToken)).toEqual(next);
    const audits = await ruleAudits(fam.familyId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_user_id: fam.ownerId, metadata: { after: next } });
    // The lowest and highest published values are accepted.
    const lowest = { ...next, attemptPoints: 0, minMeaningfulResponseMs: 500 };
    expect((await putRules(lowest)).status).toBe(200);
    const highest = {
      attemptPoints: 100,
      independentCorrectBonus: 100,
      setCompletionPoints: 100,
      minMeaningfulResponseMs: 60_000,
    };
    expect((await putRules(highest)).status).toBe(200);
    expect(await rulesOf(token)).toEqual(highest);
  });

  it('a guardian can change the rules; a child device and signed-out callers cannot', async () => {
    const byGuardian = await putRules({ ...SUGGESTED, setCompletionPoints: 8 }, guardianToken);
    expect(byGuardian.status).toBe(200);
    expect(await rulesOf(token)).toEqual({ ...SUGGESTED, setCompletionPoints: 8 });
    const [last] = (await ruleAudits(fam.familyId)).slice(-1);
    expect(last!.actor_user_id).not.toBe(fam.ownerId);

    const byChild = await putRules({ ...SUGGESTED, attemptPoints: 100 }, riley);
    expect(byChild.status).toBe(401);
    expect((await getRules(riley)).status).toBe(401);
    const signedOut = await api.request('/v1/reward-rules', {
      method: 'PUT',
      body: { ...SUGGESTED, attemptPoints: 100 },
    });
    expect(signedOut.status).toBe(401);
    expect(await rulesOf(token)).toEqual({ ...SUGGESTED, setCompletionPoints: 8 });
  });

  it('another family can neither read nor change these rules', async () => {
    const mine = await rulesOf(token);
    expect(await rulesOf(otherToken)).toEqual(SUGGESTED);
    const theirs = { ...SUGGESTED, attemptPoints: 50 };
    expect((await putRules(theirs, otherToken)).status).toBe(200);
    expect(await rulesOf(otherToken)).toEqual(theirs);
    expect(await rulesOf(token)).toEqual(mine);
    const otherChildView = childRewardsResponseSchema.parse(
      await json(await api.request('/v1/child/rewards', { token: otherChild })),
    );
    expect(otherChildView.earningRules.pointsPerTry).toBe(50);
  });
});

// ---------------------------------------------------------------------------------------------
// Child view
// ---------------------------------------------------------------------------------------------

describe('child rewards view: “How you earn points”', () => {
  it('shows the published point values with allowlisted fields only, never the threshold', async () => {
    expect(
      (
        await putRules({
          attemptPoints: 3,
          independentCorrectBonus: 4,
          setCompletionPoints: 6,
          minMeaningfulResponseMs: 2750,
        })
      ).status,
    ).toBe(200);
    const res = await api.request('/v1/child/rewards', { token: riley });
    expect(res.status).toBe(200);
    const raw = await json<Record<string, unknown>>(res);
    const body = childRewardsResponseSchema.parse(raw);
    expect(Object.keys(raw.earningRules as object).sort()).toEqual([
      'firstTryBonus',
      'pointsPerTry',
      'setCompletionPoints',
    ]);
    expect(body.earningRules).toEqual({
      pointsPerTry: 3,
      firstTryBonus: 4,
      setCompletionPoints: 6,
    });
    const text = JSON.stringify(raw);
    expect(text).not.toMatch(/minMeaningful|ResponseMs|2750|updatedAt/);
    expect(text).not.toContain(fam.familyId);

    // A family that never changed its rules shows the suggested values.
    const lowView = childRewardsResponseSchema.parse(
      await json(await api.request('/v1/child/rewards', { token: lowChild })),
    );
    expect(lowView.earningRules).toEqual({
      pointsPerTry: 2,
      firstTryBonus: 3,
      setCompletionPoints: 5,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Awards follow the published rules (practice answer route)
// ---------------------------------------------------------------------------------------------

interface KeyRow {
  item_id: string;
  answer_spec: { spec: AnswerSpec };
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

/** Generates today's daily set for a child through the real job and returns its answer keys. */
async function dailySet(
  child: string,
  childId: string,
): Promise<{ setId: string; keys: KeyRow[] }> {
  at('2026-09-24T21:00:00Z'); // 16:00 CDT, after the 15:30 release
  await api.request('/v1/child/practice/today', { token: child }); // enqueues on demand
  await enqueueDueLearningJobs(deps, api.now.value);
  await runJobs(deps, createLearningHandlers());
  const [set] = await api.db.sql<{ id: string }[]>`
    select id from public.practice_sets
     where child_id = ${childId} and kind = 'daily' and local_date = '2026-09-24'`;
  const keys = await api.db.sql<KeyRow[]>`
    select i.id as item_id, k.answer_spec from public.practice_items i
      join private.practice_item_keys k on k.item_id = i.id
     where i.set_id = ${set!.id} order by i.position`;
  expect(keys).toHaveLength(5);
  return { setId: set!.id, keys };
}

async function answer(child: string, k: KeyRow, text: string): Promise<PracticeAnswerResponse> {
  const res = await api.request(`/v1/child/practice/items/${k.item_id}/answer`, {
    method: 'POST',
    token: child,
    body: { answer: text, idempotencyKey: randomUUID() },
  });
  expect(res.status).toBe(200);
  return practiceAnswerResponseSchema.parse(await json(res));
}

const right = (k: KeyRow) => keyAnswerText(k.answer_spec.spec);
const wrong = (k: KeyRow) => wrongAnswer(k.answer_spec.spec);

async function ledger(childId: string) {
  return api.db.sql<{ id: string; idempotency_key: string; points: number; created_at: Date }[]>`
    select id, idempotency_key, points, created_at from public.points_ledger
     where child_id = ${childId} order by id`;
}

async function balance(childId: string): Promise<number> {
  const [row] = await api.db.sql<{ balance: number }[]>`
    select balance from public.point_balances where child_id = ${childId}`;
  return row?.balance ?? 0;
}

describe('awards follow the published family rules (AC_REWARDS_01)', () => {
  it('a changed rule changes the next award; points already earned are never recomputed', async () => {
    const RILEY = fam.children[0]!.id;
    expect((await putRules(SUGGESTED)).status).toBe(200);
    const { setId, keys } = await dailySet(riley, RILEY);
    const [k0, k1, k2, k3, k4] = keys as [KeyRow, KeyRow, KeyRow, KeyRow, KeyRow];

    advance(20_000);
    expect((await answer(riley, k0, right(k0))).pointsAwarded).toBe(2 + 3);
    const earned = await ledger(RILEY);
    expect(earned.map((e) => e.points)).toEqual([2, 3]);

    const changed = rewardRulesUpdateResponseSchema.parse(
      await json(
        await putRules({
          attemptPoints: 7,
          independentCorrectBonus: 11,
          setCompletionPoints: 13,
          minMeaningfulResponseMs: 1500,
        }),
      ),
    );
    expect(changed.changed).toBe(true);
    // Rules apply to future awards only: the entries already in the ledger are untouched.
    expect(await ledger(RILEY)).toEqual(earned);
    expect(await balance(RILEY)).toBe(5);

    advance(20_000);
    expect((await answer(riley, k1, right(k1))).pointsAwarded).toBe(7 + 11);
    advance(20_000);
    expect((await answer(riley, k2, wrong(k2))).pointsAwarded).toBe(7); // effort despite an error
    advance(20_000);
    expect((await answer(riley, k2, right(k2))).pointsAwarded).toBe(0); // one award per question
    advance(20_000);
    expect((await answer(riley, k3, right(k3))).pointsAwarded).toBe(7 + 11);
    advance(20_000);
    const last = await answer(riley, k4, right(k4));
    expect(last).toMatchObject({ setCompleted: true, pointsAwarded: 7 + 11 + 13 });

    const after = await ledger(RILEY);
    expect(after.slice(0, earned.length)).toEqual(earned);
    expect(after.filter((e) => e.idempotency_key === `set:${setId}`)).toMatchObject([
      { points: 13 },
    ]);
    expect(await balance(RILEY)).toBe(5 + 18 + 7 + 18 + 31);
  });

  it('at the lowest allowed threshold (500 ms), empty and rapid retries still earn nothing extra', async () => {
    const LOW = low.children[0]!.id;
    const lowest = { ...SUGGESTED, minMeaningfulResponseMs: 500 };
    expect((await putRules(lowest, lowToken)).status).toBe(200);
    // Parents cannot go below the floor.
    expect((await putRules({ ...lowest, minMeaningfulResponseMs: 499 }, lowToken)).status).toBe(
      400,
    );
    const { setId, keys } = await dailySet(lowChild, LOW);
    // An item whose grader reads a blank answer as unreadable (not multiple choice).
    const blank = keys.find((k) => k.answer_spec.spec.kind !== 'multiple_choice');
    expect(blank).toBeDefined();
    const [r0, r1, r2, r3] = keys.filter((k) => k !== blank) as [KeyRow, KeyRow, KeyRow, KeyRow];
    const results: number[] = [];
    const record = async (child: string, k: KeyRow, text: string) => {
      const res = await answer(child, k, text);
      results.push(res.pointsAwarded);
      return res;
    };

    advance(20_000);
    expect((await record(lowChild, r0, right(r0))).pointsAwarded).toBe(5);
    // Faster than 500 ms: graded, but no points, and the question is not used up.
    advance(499);
    expect(await record(lowChild, r1, wrong(r1))).toMatchObject({
      result: 'try_again',
      pointsAwarded: 0,
    });
    advance(499);
    expect((await record(lowChild, r1, wrong(r1))).pointsAwarded).toBe(0);
    // Exactly 500 ms is meaningful: the one effort award for this question.
    advance(500);
    expect(await record(lowChild, r1, wrong(r1))).toMatchObject({
      pointsAwarded: 2,
      offerHelp: true,
    });
    advance(500);
    expect(await record(lowChild, r1, right(r1))).toMatchObject({
      result: 'unresolved',
      pointsAwarded: 0,
    });
    // A blank answer is never meaningful, however slow.
    advance(500);
    expect(await record(lowChild, blank!, '   ')).toMatchObject({
      result: 'unresolved',
      pointsAwarded: 0,
    });
    advance(500);
    expect((await record(lowChild, blank!, right(blank!))).pointsAwarded).toBe(5);
    // Rapid-fire retries and re-answers: graded, never paid.
    expect((await record(lowChild, blank!, right(blank!))).pointsAwarded).toBe(0);
    for (let i = 0; i < 3; i += 1) {
      expect((await record(lowChild, r2, wrong(r2))).pointsAwarded).toBe(0);
    }
    const done = await record(lowChild, r3, right(r3));
    expect(done).toMatchObject({ result: 'correct', setCompleted: true, pointsAwarded: 0 });

    // 12 points in all: one award per question, none for rapid or blank tries, and no completion
    // points for a set finished by rapid guesses.
    expect(results.reduce((a, b) => a + b, 0)).toBe(12);
    const keysPaid = (await ledger(LOW)).map((e) => e.idempotency_key).sort();
    expect(keysPaid).toEqual(
      [
        `attempt:${r0.item_id}`,
        `independent:${r0.item_id}`,
        `attempt:${r1.item_id}`,
        `attempt:${blank!.item_id}`,
        `independent:${blank!.item_id}`,
      ].sort(),
    );
    expect(keysPaid).not.toContain(`set:${setId}`);
    expect(await balance(LOW)).toBe(12);
  });
});
