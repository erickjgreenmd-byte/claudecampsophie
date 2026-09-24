import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  childRewardsResponseSchema,
  pointsHistoryResponseSchema,
  rewardsOverviewResponseSchema,
} from '@pencillift/contracts';
import { grantAdultUnlock, seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { rewardsRoutes } from '../src/routes/rewards.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

// Synthetic family: Riley (child 0) and Sam (child 1). Another family is used for isolation checks.
let api: TestApi;
let fam: SeededFamily;
let other: SeededFamily;
let token: string; // unlocked parent session
let lockedToken: string; // same parent, a session without a step-up
let otherToken: string; // unlocked parent of another family
const SESSION = 'a1a1a1a1-1111-4111-8111-111111111111';
const LOCKED_SESSION = 'b2b2b2b2-2222-4222-8222-222222222222';
const OTHER_SESSION = 'c3c3c3c3-3333-4333-8333-333333333333';
let pairCount = 0;

type ErrorBody = { error: { code: string; rule?: string; message: string } };

beforeAll(async () => {
  api = await createTestApi();
  fam = await seedFamily(api.db, { childCount: 2 });
  other = await seedFamily(api.db, { childCount: 1 });
  await grantAdultUnlock(api.db, fam.ownerId, SESSION, 3600);
  await grantAdultUnlock(api.db, other.ownerId, OTHER_SESSION, 3600);
  token = await parentToken(fam.ownerId, { sessionId: SESSION });
  lockedToken = await parentToken(fam.ownerId, { sessionId: LOCKED_SESSION });
  otherToken = await parentToken(other.ownerId, { sessionId: OTHER_SESSION });
});

afterAll(async () => {
  await api?.close();
});

/** Pairs a new device for a child through the real pairing flow and returns its access token. */
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

/** Fixture: a system learning award (the learning vertical owns real awards; not an API route). */
async function award(family: SeededFamily, index: number, points: number): Promise<void> {
  await api.db.sql`
    insert into public.points_ledger (family_id, child_id, kind, points, idempotency_key, actor_kind)
    values (${family.familyId}, ${family.children[index]!.id}, 'award', ${points}, ${'attempt:' + randomUUID()}, 'system')
  `;
}

async function balance(family: SeededFamily, index = 0): Promise<number> {
  const rows = await api.db.sql<{ balance: number }[]>`
    select balance from public.point_balances where child_id = ${family.children[index]!.id}`;
  return rows[0]?.balance ?? 0;
}

async function createReward(
  body: Record<string, unknown>,
  t = token,
): Promise<{ status: number; id: string }> {
  const res = await api.request('/v1/rewards', { method: 'POST', token: t, body });
  const payload = await json<{ reward?: { id: string } }>(res);
  return { status: res.status, id: payload.reward?.id ?? '' };
}

async function newReward(pointCost: number, childId: string | null = null): Promise<string> {
  const created = await createReward({ title: 'Trip to the library', pointCost, childId });
  expect(created.status).toBe(201);
  return created.id;
}

function requestReward(child: string, rewardId: string, requestId: string = randomUUID()) {
  return api.request(`/v1/child/rewards/${rewardId}/request`, {
    method: 'POST',
    token: child,
    body: { requestId },
  });
}

function decide(requestId: string, action: string, t = token) {
  return api.request(`/v1/reward-requests/${requestId}/decision`, {
    method: 'POST',
    token: t,
    body: { action },
  });
}

function adjust(body: Record<string, unknown>, t = token) {
  return api.request('/v1/points/adjustments', { method: 'POST', token: t, body });
}

let riley: string; // Riley's device token
let rileySecondDevice: string;
let sam: string; // Sam's device token
let otherChild: string;

beforeAll(async () => {
  riley = await childToken(fam, token, 0);
  rileySecondDevice = await childToken(fam, token, 0);
  sam = await childToken(fam, token, 1);
  otherChild = await childToken(other, otherToken, 0);
});

describe('parent reward catalog (spec P9)', () => {
  it('creating and editing a reward requires a recent step-up', async () => {
    const denied = await api.request('/v1/rewards', {
      method: 'POST',
      token: lockedToken,
      body: { title: 'Pick the movie', pointCost: 30, childId: null },
    });
    expect(denied.status).toBe(403);
    expect((await json<ErrorBody>(denied)).error.code).toBe('STEP_UP_REQUIRED');

    const created = await api.request('/v1/rewards', {
      method: 'POST',
      token,
      body: {
        title: '  Pick the movie ',
        pointCost: 30,
        childId: null,
        instructions: 'Friday night',
      },
    });
    expect(created.status).toBe(201);
    const { reward } = await json<{ reward: Record<string, unknown> }>(created);
    expect(reward).toMatchObject({
      title: 'Pick the movie',
      pointCost: 30,
      childId: null,
      instructions: 'Friday night',
      active: true,
    });

    const lockedEdit = await api.request(`/v1/rewards/${String(reward.id)}`, {
      method: 'PATCH',
      token: lockedToken,
      body: { pointCost: 40 },
    });
    expect(lockedEdit.status).toBe(403);
    expect((await json<ErrorBody>(lockedEdit)).error.code).toBe('STEP_UP_REQUIRED');

    const edited = await api.request(`/v1/rewards/${String(reward.id)}`, {
      method: 'PATCH',
      token,
      body: { pointCost: 40, instructions: null, active: false },
    });
    expect(edited.status).toBe(200);
    expect((await json<{ reward: Record<string, unknown> }>(edited)).reward).toMatchObject({
      title: 'Pick the movie',
      pointCost: 40,
      instructions: null,
      active: false,
    });
  });

  it('rejects mass assignment, links, bad costs, empty edits and children of another family', async () => {
    const base = { title: 'Board game night', pointCost: 20, childId: null };
    expect((await createReward({ ...base, familyId: other.familyId })).status).toBe(400);
    expect((await createReward({ ...base, createdBy: other.ownerId })).status).toBe(400);
    expect((await createReward({ ...base, title: 'Book from amzn.to/abc' })).status).toBe(400);
    expect(
      (await createReward({ ...base, instructions: 'See https://example.com/deal' })).status,
    ).toBe(400);
    expect((await createReward({ ...base, pointCost: 0 })).status).toBe(400);
    expect((await createReward({ ...base, pointCost: 2.5 })).status).toBe(400);
    expect((await createReward({ ...base, title: '   ' })).status).toBe(400);
    const foreignChild = await createReward({ ...base, childId: other.children[0]!.id });
    expect(foreignChild.status).toBe(404);
    const id = await newReward(5);
    const empty = await api.request(`/v1/rewards/${id}`, { method: 'PATCH', token, body: {} });
    expect(empty.status).toBe(400);
    const childMove = await api.request(`/v1/rewards/${id}`, {
      method: 'PATCH',
      token,
      body: { childId: other.children[0]!.id },
    });
    expect(childMove.status).toBe(400);
  });

  it('reward text refuses marketplace, share and hidden links on create and edit, but not prose', async () => {
    // P16.3: "No affiliate URL in a push, SMS, exported child worksheet or learning reward."
    const base = { title: 'Board game night', pointCost: 20, childId: null };
    for (const text of [
      'Order amazon.it/dp/B000000000?tag=family-21',
      'amazon.com.be deal',
      'Book amzn.eu/d/abc123',
      'See shop.example.fr for details',
      'Look at bookshop.nu/list',
      'amzn​.to/xyz', // zero-width space inside the host
      'ａｍｚｎ.to/xyz', // full-width letters
    ]) {
      expect((await createReward({ ...base, instructions: text })).status, text).toBe(400);
    }
    const id = await newReward(5);
    const linkEdit = await api.request(`/v1/rewards/${id}`, {
      method: 'PATCH',
      token,
      body: { instructions: 'amazon.es/dp/B000000000' },
    });
    expect(linkEdit.status).toBe(400);
    for (const title of ['Dr. Seuss book', '2.5 hours at the park', 'Pizza/tacos night']) {
      expect((await createReward({ ...base, title })).status, title).toBe(201);
    }
  });

  it('control characters in reward text or a reason are a 400, never stored (P13)', async () => {
    const base = { title: 'Board game night', pointCost: 20, childId: null };
    expect((await createReward({ ...base, title: 'Movie\u0001night' })).status).toBe(400);
    expect((await createReward({ ...base, instructions: 'Stay up\u0000late' })).status).toBe(400);
    const id = await newReward(5);
    const edit = await api.request(`/v1/rewards/${id}`, {
      method: 'PATCH',
      token,
      body: { title: 'Park\u0000trip' },
    });
    expect(edit.status).toBe(400);
    // Line breaks in the instructions stay allowed.
    const multiLine = await createReward({ ...base, instructions: 'Saturday\nafter lunch' });
    expect(multiLine.status).toBe(201);
    const [row] = await api.db.sql<
      { title: string }[]
    >`select title from public.rewards where id = ${id}`;
    expect(row!.title).not.toContain('\u0000');
    expect(api.logs.some((l) => l.event === 'unhandled_error')).toBe(false);
  });

  it('another family cannot see or edit this family’s rewards', async () => {
    const id = await newReward(15);
    const edit = await api.request(`/v1/rewards/${id}`, {
      method: 'PATCH',
      token: otherToken,
      body: { pointCost: 1 },
    });
    expect(edit.status).toBe(404);
    const [row] = await api.db.sql<
      { point_cost: number }[]
    >`select point_cost from public.rewards where id = ${id}`;
    expect(row!.point_cost).toBe(15);
    const overview = rewardsOverviewResponseSchema.parse(
      await json(await api.request('/v1/rewards', { token: otherToken })),
    );
    expect(overview.rewards.map((r) => r.id)).not.toContain(id);
    expect(overview.children.map((c) => c.childId)).toEqual([other.children[0]!.id]);
    expect((await api.request('/v1/rewards/not-a-uuid', { method: 'PATCH', token })).status).toBe(
      404,
    );
  });

  it('the overview lists rewards, per-child balances and open requests', async () => {
    const f = await seedFamily(api.db, { childCount: 2 });
    const session = randomUUID();
    await grantAdultUnlock(api.db, f.ownerId, session, 3600);
    const t = await parentToken(f.ownerId, { sessionId: session });
    const child = await childToken(f, t, 0);
    await award(f, 0, 25);
    const created = await createReward(
      { title: 'Extra story time', pointCost: 10, childId: null },
      t,
    );
    const request = randomUUID();
    expect((await requestReward(child, created.id, request)).status).toBe(201);
    const res = await api.request('/v1/rewards', { token: t });
    expect(res.status).toBe(200);
    const overview = rewardsOverviewResponseSchema.parse(await json(res));
    expect(overview.rewards.map((r) => r.id)).toEqual([created.id]);
    expect(overview.children).toEqual([
      { childId: f.children[0]!.id, nickname: 'Riley', balance: 15, status: 'active' },
      { childId: f.children[1]!.id, nickname: 'Sam', balance: 0, status: 'active' },
    ]);
    expect(overview.openRequests).toHaveLength(1);
    expect(overview.openRequests[0]).toMatchObject({
      id: request,
      childNickname: 'Riley',
      rewardTitle: 'Extra story time',
      pointCost: 10,
      state: 'pending',
    });
    expect(overview.recentRequests).toEqual([]);
  });
});

describe('child rewards view and isolation (AC_ACCESS_05)', () => {
  it('shows only this child’s balance, rewards and requests with allowlisted fields', async () => {
    await award(fam, 0, 12);
    await award(fam, 1, 99);
    const forAll = await newReward(10);
    const samOnly = await newReward(3, fam.children[1]!.id);
    const retired = await newReward(4);
    await api.request(`/v1/rewards/${retired}`, {
      method: 'PATCH',
      token,
      body: { active: false },
    });
    const samRequest = randomUUID();
    expect((await requestReward(sam, samOnly, samRequest)).status).toBe(201);

    const res = await api.request('/v1/child/rewards', { token: riley });
    expect(res.status).toBe(200);
    const raw = await json<Record<string, unknown>>(res);
    const body = childRewardsResponseSchema.parse(raw);
    expect(Object.keys(raw).sort()).toEqual(['balance', 'earningRules', 'requests', 'rewards']);
    // Spec P9 published rules, point values only (the anti-farming threshold stays server-side).
    expect(Object.keys(raw.earningRules as object).sort()).toEqual([
      'firstTryBonus',
      'pointsPerTry',
      'setCompletionPoints',
    ]);
    expect(body.balance).toBe(await balance(fam, 0));
    const ids = body.rewards.map((r) => r.id);
    expect(ids).toContain(forAll);
    expect(ids).not.toContain(samOnly);
    expect(ids).not.toContain(retired);
    for (const reward of raw.rewards as Record<string, unknown>[]) {
      expect(Object.keys(reward).sort()).toEqual(['id', 'instructions', 'pointCost', 'title']);
    }
    expect(body.requests.map((r) => r.id)).not.toContain(samRequest);
    const text = JSON.stringify(raw);
    for (const secret of [
      fam.familyId,
      fam.ownerId,
      fam.children[1]!.id,
      'familyId',
      'createdBy',
      'childId',
      'reason',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('a child cannot request a sibling-only, inactive or other-family reward', async () => {
    await award(fam, 0, 50);
    const before = await balance(fam, 0);
    const samOnly = await newReward(1, fam.children[1]!.id);
    const sibling = await requestReward(riley, samOnly);
    expect(sibling.status).toBe(404);
    const otherCreated = await createReward(
      { title: 'Other family treat', pointCost: 1, childId: null },
      otherToken,
    );
    expect((await requestReward(riley, otherCreated.id)).status).toBe(404);
    expect((await requestReward(otherChild, samOnly)).status).toBe(404);
    const inactive = await newReward(2);
    await api.request(`/v1/rewards/${inactive}`, {
      method: 'PATCH',
      token,
      body: { active: false },
    });
    expect((await requestReward(riley, inactive)).status).toBe(404);
    expect(await balance(fam, 0)).toBe(before);
  });

  it('a request reserves points once, even when retried with the same id', async () => {
    const f = await seedFamily(api.db);
    const session = randomUUID();
    await grantAdultUnlock(api.db, f.ownerId, session, 3600);
    const t = await parentToken(f.ownerId, { sessionId: session });
    const child = await childToken(f, t);
    await award(f, 0, 30);
    const reward = (await createReward({ title: 'Park trip', pointCost: 10, childId: null }, t)).id;
    const requestId = randomUUID();
    const first = await requestReward(child, reward, requestId);
    expect(first.status).toBe(201);
    const body = await json<{ request: Record<string, unknown>; balance: number }>(first);
    expect(body.balance).toBe(20);
    expect(body.request).toMatchObject({
      id: requestId,
      rewardId: reward,
      rewardTitle: 'Park trip',
      pointCost: 10,
      state: 'pending',
    });
    expect(Object.keys(body.request).sort()).toEqual([
      'decidedAt',
      'fulfilledAt',
      'id',
      'pointCost',
      'requestedAt',
      'rewardId',
      'rewardTitle',
      'state',
    ]);
    const retry = await requestReward(child, reward, requestId);
    expect(retry.status).toBe(201);
    expect(await balance(f)).toBe(20);
  });

  it('a request id owned by another child is a conflict, not a takeover', async () => {
    await award(fam, 0, 5);
    await award(fam, 1, 5);
    const reward = await newReward(1);
    const requestId = randomUUID();
    expect((await requestReward(riley, reward, requestId)).status).toBe(201);
    const stolen = await requestReward(sam, reward, requestId);
    expect(stolen.status).toBe(409);
  });

  it('insufficient points is a 422 business rule and creates nothing', async () => {
    const f = await seedFamily(api.db);
    const session = randomUUID();
    await grantAdultUnlock(api.db, f.ownerId, session, 3600);
    const t = await parentToken(f.ownerId, { sessionId: session });
    const child = await childToken(f, t);
    await award(f, 0, 4);
    const reward = (await createReward({ title: 'Bike ride', pointCost: 5, childId: null }, t)).id;
    const requestId = randomUUID();
    const res = await requestReward(child, reward, requestId);
    expect(res.status).toBe(422);
    const body = await json<ErrorBody>(res);
    expect(body.error.code).toBe('BUSINESS_RULE');
    expect(body.error.rule).toBe('INSUFFICIENT_POINTS');
    expect(
      await api.db.sql`select id from public.reward_redemptions where id = ${requestId}`,
    ).toHaveLength(0);
    expect(await balance(f)).toBe(4);
  });

  it('two devices requesting at once cannot spend the same points (AC_REWARDS_02)', async () => {
    const f = await seedFamily(api.db);
    const session = randomUUID();
    await grantAdultUnlock(api.db, f.ownerId, session, 3600);
    const t = await parentToken(f.ownerId, { sessionId: session });
    const deviceA = await childToken(f, t);
    const deviceB = await childToken(f, t);
    await award(f, 0, 10);
    const reward = (await createReward({ title: 'Game time', pointCost: 10, childId: null }, t)).id;
    const results = await Promise.all([
      requestReward(deviceA, reward),
      requestReward(deviceB, reward),
      requestReward(deviceA, reward),
      requestReward(deviceB, reward),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 422, 422, 422]);
    for (const res of results.filter((r) => r.status === 422)) {
      expect((await json<ErrorBody>(res)).error.rule).toBe('INSUFFICIENT_POINTS');
    }
    expect(await balance(f)).toBe(0);
    const reserves = await api.db.sql`
      select id from public.points_ledger where child_id = ${f.children[0]!.id} and kind = 'redemption_reserve'`;
    expect(reserves).toHaveLength(1);
  });

  it('a child cancels only their own pending request, refunding exactly once', async () => {
    await award(fam, 0, 20);
    const reward = await newReward(6);
    const pending = randomUUID();
    expect((await requestReward(riley, reward, pending)).status).toBe(201);
    const afterRequest = await balance(fam, 0);
    const cancel = (t: string, id: string) =>
      api.request(`/v1/child/reward-requests/${id}/cancel`, { method: 'POST', token: t });
    expect((await cancel(sam, pending)).status).toBe(404);
    expect((await cancel(otherChild, pending)).status).toBe(404);
    const first = await cancel(riley, pending);
    expect(first.status).toBe(200);
    expect((await json<{ request: { state: string } }>(first)).request.state).toBe('cancelled');
    expect((await cancel(rileySecondDevice, pending)).status).toBe(200);
    expect(await balance(fam, 0)).toBe(afterRequest + 6);

    const approved = randomUUID();
    expect((await requestReward(riley, reward, approved)).status).toBe(201);
    expect((await decide(approved, 'approve')).status).toBe(200);
    const late = await cancel(riley, approved);
    expect(late.status).toBe(422);
    expect((await json<ErrorBody>(late)).error.rule).toBe('INVALID_TRANSITION');
  });

  it('child and parent tokens cannot cross into each other’s endpoints', async () => {
    expect((await api.request('/v1/rewards', { token: riley })).status).toBe(401);
    expect(
      (
        await adjust(
          { childId: fam.children[0]!.id, points: 500, reason: 'x', adjustmentId: randomUUID() },
          riley,
        )
      ).status,
    ).toBe(401);
    expect((await decide(randomUUID(), 'approve', riley)).status).toBe(401);
    expect((await api.request('/v1/child/rewards', { token })).status).toBe(401);
    expect((await api.request('/v1/child/rewards')).status).toBe(401);
  });
});

describe('parent decisions (AC_REWARDS_03, AC_REWARDS_04)', () => {
  async function pendingRequest(cost = 8): Promise<string> {
    await award(fam, 0, cost);
    const reward = await newReward(cost);
    const id = randomUUID();
    expect((await requestReward(riley, reward, id)).status).toBe(201);
    return id;
  }

  it('decisions need a recent step-up; approve then fulfill keeps the points spent', async () => {
    const id = await pendingRequest();
    const locked = await decide(id, 'approve', lockedToken);
    expect(locked.status).toBe(403);
    expect((await json<ErrorBody>(locked)).error.code).toBe('STEP_UP_REQUIRED');
    const spent = await balance(fam, 0);
    const approved = await decide(id, 'approve');
    expect(approved.status).toBe(200);
    const approvedBody = await json<{ request: Record<string, unknown>; balance: number }>(
      approved,
    );
    expect(approvedBody.request).toMatchObject({ id, state: 'approved', childNickname: 'Riley' });
    expect(approvedBody.balance).toBe(spent);
    const fulfilled = await decide(id, 'fulfill');
    expect(fulfilled.status).toBe(200);
    const body = await json<{ request: { state: string; fulfilledAt: string | null } }>(fulfilled);
    expect(body.request.state).toBe('fulfilled');
    expect(body.request.fulfilledAt).not.toBeNull();
    expect(await balance(fam, 0)).toBe(spent);
    // Fulfilment is only a parent record: no payment or purchase rows exist anywhere for it.
    const late = await decide(id, 'cancel');
    expect(late.status).toBe(422);
    expect((await json<ErrorBody>(late)).error.rule).toBe('INVALID_TRANSITION');
  });

  it('decline is idempotent and refunds the reserved points exactly once', async () => {
    const id = await pendingRequest(9);
    const reserved = await balance(fam, 0);
    const first = await decide(id, 'decline');
    const second = await decide(id, 'decline');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await json<{ request: { state: string } }>(second)).request.state).toBe('declined');
    expect(await balance(fam, 0)).toBe(reserved + 9);
    const releases = await api.db.sql`
      select id from public.points_ledger where redemption_id = ${id} and kind = 'redemption_release'`;
    expect(releases).toHaveLength(1);
    const reopen = await decide(id, 'approve');
    expect(reopen.status).toBe(422);
    expect((await json<ErrorBody>(reopen)).error.rule).toBe('INVALID_TRANSITION');
  });

  it('fulfilling straight from pending is an invalid transition', async () => {
    const id = await pendingRequest();
    const res = await decide(id, 'fulfill');
    expect(res.status).toBe(422);
    expect((await json<ErrorBody>(res)).error.rule).toBe('INVALID_TRANSITION');
  });

  it('a parent can cancel an approved request and the points return once', async () => {
    const id = await pendingRequest(7);
    await decide(id, 'approve');
    const reserved = await balance(fam, 0);
    expect((await decide(id, 'cancel')).status).toBe(200);
    expect((await decide(id, 'cancel')).status).toBe(200);
    expect(await balance(fam, 0)).toBe(reserved + 7);
  });

  it('a parent cannot decide another family’s request', async () => {
    const id = await pendingRequest();
    const res = await decide(id, 'approve', otherToken);
    expect(res.status).toBe(404);
    const [row] = await api.db.sql<
      { state: string }[]
    >`select state from public.reward_redemptions where id = ${id}`;
    expect(row!.state).toBe('pending');
    expect((await decide(randomUUID(), 'approve')).status).toBe(404);
    expect((await decide('nope', 'approve')).status).toBe(404);
  });

  it('rejects unknown actions', async () => {
    const id = await pendingRequest();
    expect((await decide(id, 'refund')).status).toBe(400);
    expect((await decide(id, 'pay')).status).toBe(400);
  });
});

describe('adjustments and history (AC_REWARDS_05)', () => {
  it('an adjustment needs a reason and a step-up, and applies once per adjustment id', async () => {
    const childId = fam.children[1]!.id;
    const start = await balance(fam, 1);
    const adjustmentId = randomUUID();
    const body = { childId, points: 5, reason: 'Extra reading', adjustmentId };
    for (const bad of [
      { ...body, reason: undefined },
      { ...body, reason: '   ' },
      { ...body, reason: '!!!' },
      { ...body, reason: 'Helped\u0000out' },
      { ...body, reason: 'Helped\u0007out' },
      { ...body, points: 0 },
      { ...body, points: 1.5 },
      { ...body, points: 10_001 },
      { ...body, familyId: fam.familyId },
      { ...body, adjustmentId: 'retry-1' },
    ]) {
      expect((await adjust(bad)).status).toBe(400);
    }
    const locked = await adjust(body, lockedToken);
    expect(locked.status).toBe(403);
    expect((await json<ErrorBody>(locked)).error.code).toBe('STEP_UP_REQUIRED');
    const first = await adjust(body);
    expect(first.status).toBe(201);
    expect(await json(first)).toEqual({ childId, balance: start + 5, applied: true });
    const retry = await adjust(body);
    expect(retry.status).toBe(200);
    expect(await json(retry)).toEqual({ childId, balance: start + 5, applied: false });
    expect(await balance(fam, 1)).toBe(start + 5);
  });

  it('a deduction below zero is refused with INSUFFICIENT_POINTS', async () => {
    const f = await seedFamily(api.db);
    const session = randomUUID();
    await grantAdultUnlock(api.db, f.ownerId, session, 3600);
    const t = await parentToken(f.ownerId, { sessionId: session });
    await award(f, 0, 3);
    const res = await adjust(
      { childId: f.children[0]!.id, points: -4, reason: 'Correction', adjustmentId: randomUUID() },
      t,
    );
    expect(res.status).toBe(422);
    expect((await json<ErrorBody>(res)).error.rule).toBe('INSUFFICIENT_POINTS');
    expect(await balance(f)).toBe(3);
  });

  it('a parent cannot adjust another family’s child', async () => {
    const res = await adjust(
      {
        childId: fam.children[0]!.id,
        points: 100,
        reason: 'Bonus',
        adjustmentId: randomUUID(),
      },
      otherToken,
    );
    expect(res.status).toBe(404);
  });

  it('history shows reasons and its totals reconcile with the balance after reversals', async () => {
    const f = await seedFamily(api.db);
    const session = randomUUID();
    await grantAdultUnlock(api.db, f.ownerId, session, 3600);
    const t = await parentToken(f.ownerId, { sessionId: session });
    const child = await childToken(f, t);
    const childId = f.children[0]!.id;
    await award(f, 0, 20);
    await adjust(
      { childId, points: 5, reason: 'Helped a sibling read', adjustmentId: randomUUID() },
      t,
    );
    const reward = (await createReward({ title: 'Museum visit', pointCost: 15, childId: null }, t))
      .id;
    const declined = randomUUID();
    await requestReward(child, reward, declined);
    await decide(declined, 'decline', t);
    const kept = randomUUID();
    await requestReward(child, reward, kept);
    await decide(kept, 'approve', t);
    await adjust(
      { childId, points: -3, reason: 'Duplicate award reversed', adjustmentId: randomUUID() },
      t,
    );

    const res = await api.request(`/v1/points/history?childId=${childId}`, { token: t });
    expect(res.status).toBe(200);
    const history = pointsHistoryResponseSchema.parse(await json(res));
    expect(history.balance).toBe(7);
    expect(history.totals).toEqual({
      awarded: 20,
      adjustments: 2,
      reserved: -30,
      released: 15,
      net: 7,
    });
    expect(history.totals.net).toBe(history.balance);
    expect(history.entries.reduce((sum, e) => sum + e.points, 0)).toBe(history.balance);
    expect(history.hasMore).toBe(false);
    expect(history.entries.map((e) => e.kind)).toEqual([
      'adjustment',
      'redemption_reserve',
      'redemption_release',
      'redemption_reserve',
      'adjustment',
      'award',
    ]);
    expect(history.entries[0]).toMatchObject({
      points: -3,
      reason: 'Duplicate award reversed',
      actor: 'parent',
    });
    expect(history.entries[1]).toMatchObject({ rewardTitle: 'Museum visit', redemptionId: kept });
  });

  it('history is limited to the caller’s own family', async () => {
    const childId = fam.children[0]!.id;
    expect(
      (await api.request(`/v1/points/history?childId=${childId}`, { token: otherToken })).status,
    ).toBe(404);
    expect((await api.request('/v1/points/history?childId=bad', { token })).status).toBe(400);
    expect((await api.request('/v1/points/history', { token })).status).toBe(400);
    expect(
      (await api.request(`/v1/points/history?childId=${childId}`, { token: riley })).status,
    ).toBe(401);
    expect((await api.request(`/v1/points/history?childId=${childId}`, { token })).status).toBe(
      200,
    );
  });
});

describe('no commercial point sources (AC_MON_13, spec P16.4)', () => {
  it('the rewards router exposes only the documented endpoints', () => {
    const routes = [
      ...new Set(
        rewardsRoutes()
          .routes.filter((r) => r.method !== 'ALL')
          .map((r) => `${r.method} ${r.path}`),
      ),
    ].sort();
    expect(routes).toEqual(
      [
        'GET /child/rewards',
        'GET /points/history',
        'GET /reward-rules',
        'GET /rewards',
        'PATCH /rewards/:id',
        'POST /child/reward-requests/:id/cancel',
        'POST /child/rewards/:rewardId/request',
        'POST /points/adjustments',
        'POST /reward-requests/:id/decision',
        'POST /rewards',
        'PUT /reward-rules',
      ].sort(),
    );
    for (const route of routes) {
      expect(route).not.toMatch(
        /award|\bads?\b|sponsor|affiliate|purchase|referr|click|cash|wallet/i,
      );
    }
  });

  it('commercial-looking point endpoints do not exist for children or parents', async () => {
    for (const path of [
      '/v1/points/awards',
      '/v1/child/points',
      '/v1/child/points/ad-view',
      '/v1/child/rewards/ad-bonus',
      '/v1/points/affiliate-click',
      '/v1/points/purchase',
      '/v1/points/referral',
    ]) {
      for (const t of [riley, token]) {
        const res = await api.request(path, { method: 'POST', token: t, body: { points: 100 } });
        expect([401, 404]).toContain(res.status);
      }
    }
  });

  it('logs never contain reasons, reward text or tokens', () => {
    const text = JSON.stringify(api.logs);
    expect(text).not.toContain('Extra reading');
    expect(text).not.toContain('Museum visit');
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });
});
