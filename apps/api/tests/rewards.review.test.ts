// Independent adversarial review of the rewards vertical (fresh context). Synthetic data only.
// Findings are named "[RV-rewards-<n>]"; "probe:" tests pin the riskiest behaviour that held up.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { childRewardsResponseSchema } from '@pencillift/contracts';
import { grantAdultUnlock, seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

let api: TestApi;
let pairCount = 0;

beforeAll(async () => {
  api = await createTestApi();
});

afterAll(async () => {
  await api?.close();
});

interface Family {
  fam: SeededFamily;
  token: string;
}

async function unlockedFamily(childCount = 1): Promise<Family> {
  const fam = await seedFamily(api.db, { childCount });
  const session = randomUUID();
  await grantAdultUnlock(api.db, fam.ownerId, session, 3600);
  return { fam, token: await parentToken(fam.ownerId, { sessionId: session }) };
}

async function childToken(f: Family, index = 0): Promise<string> {
  const code = await api.request(`/v1/children/${f.fam.children[index]!.id}/pairing-code`, {
    method: 'POST',
    token: f.token,
  });
  expect(code.status).toBe(201);
  pairCount += 1;
  const paired = await api.request('/v1/child/pair', {
    method: 'POST',
    headers: { 'cf-connecting-ip': `203.0.113.${pairCount}` },
    body: {
      code: (await json<{ code: string }>(code)).code,
      deviceLabel: `Review tablet ${pairCount}`,
      platform: 'android',
    },
  });
  expect(paired.status).toBe(201);
  return (await json<{ accessToken: string }>(paired)).accessToken;
}

async function award(f: Family, points: number, index = 0): Promise<void> {
  await api.db.sql`
    insert into public.points_ledger (family_id, child_id, kind, points, idempotency_key, actor_kind)
    values (${f.fam.familyId}, ${f.fam.children[index]!.id}, 'award', ${points}, ${'review:' + randomUUID()}, 'system')`;
}

async function balance(f: Family, index = 0): Promise<number> {
  const rows = await api.db.sql<{ balance: number }[]>`
    select balance from public.point_balances where child_id = ${f.fam.children[index]!.id}`;
  return rows[0]?.balance ?? 0;
}

async function createReward(f: Family, body: Record<string, unknown>) {
  return api.request('/v1/rewards', { method: 'POST', token: f.token, body });
}

async function newReward(f: Family, pointCost: number): Promise<string> {
  const res = await createReward(f, { title: 'Pick the weekend game', pointCost, childId: null });
  expect(res.status).toBe(201);
  return (await json<{ reward: { id: string } }>(res)).reward.id;
}

function requestReward(child: string, rewardId: string, requestId: string) {
  return api.request(`/v1/child/rewards/${rewardId}/request`, {
    method: 'POST',
    token: child,
    body: { requestId },
  });
}

describe('rewards review findings', () => {
  it('[RV-rewards-1] reward text refuses Amazon affiliate/short links on country domains (P16.3)', async () => {
    // P16.3: "No affiliate URL in a push, SMS, exported child worksheet or learning reward."
    // The implementer's own rule: reward text may not contain links because children see it.
    const f = await unlockedFamily();
    const base = { title: 'New chapter book', pointCost: 40, childId: null };
    const affiliateInstructions = await createReward(f, {
      ...base,
      instructions: 'We will order amazon.fr/dp/B000000000?tag=family-21 together',
    });
    const shortLinkTitle = await createReward(f, { ...base, title: 'Book amzn.eu/d/abc123' });
    expect([affiliateInstructions.status, shortLinkTitle.status]).toEqual([400, 400]);
    const rows = await api.db.sql`
      select id from public.rewards where family_id = ${f.fam.familyId}`;
    expect(rows).toHaveLength(0);
  });

  it('[RV-rewards-2] a NUL character in reward text or a reason is a 400, not a 500', async () => {
    // P13: every endpoint defines payload limits, validation and an error code.
    const f = await unlockedFamily();
    const created = await createReward(f, {
      title: 'Movie\u0000night',
      pointCost: 10,
      childId: null,
    });
    const adjusted = await api.request('/v1/points/adjustments', {
      method: 'POST',
      token: f.token,
      body: {
        childId: f.fam.children[0]!.id,
        points: 5,
        reason: 'Helped\u0000out',
        adjustmentId: randomUUID(),
      },
    });
    expect([created.status, adjusted.status]).toEqual([400, 400]);
    expect(api.logs.some((l) => l.event === 'unhandled_error')).toBe(false);
  });
});

describe('rewards review probes (riskiest behaviour that held up)', () => {
  it('probe: two devices sending the same request id at once reserve points once', async () => {
    const f = await unlockedFamily();
    const a = await childToken(f);
    const b = await childToken(f);
    await award(f, 30);
    const reward = await newReward(f, 10);
    const requestId = randomUUID();
    const results = await Promise.all([
      requestReward(a, reward, requestId),
      requestReward(b, reward, requestId),
      requestReward(a, reward, requestId),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(await balance(f)).toBe(20);
    const reserves = await api.db.sql`
      select id from public.points_ledger where redemption_id = ${requestId} and kind = 'redemption_reserve'`;
    expect(reserves).toHaveLength(1);
  });

  it('probe: a parent decline racing a child cancel refunds exactly once', async () => {
    const f = await unlockedFamily();
    const child = await childToken(f);
    await award(f, 12);
    const reward = await newReward(f, 12);
    for (let i = 0; i < 5; i += 1) {
      const requestId = randomUUID();
      expect((await requestReward(child, reward, requestId)).status).toBe(201);
      expect(await balance(f)).toBe(0);
      const [decline, cancel] = await Promise.all([
        api.request(`/v1/reward-requests/${requestId}/decision`, {
          method: 'POST',
          token: f.token,
          body: { action: 'decline' },
        }),
        api.request(`/v1/child/reward-requests/${requestId}/cancel`, {
          method: 'POST',
          token: child,
        }),
      ]);
      expect([200, 422]).toContain(decline.status);
      expect([200, 422]).toContain(cancel.status);
      expect(await balance(f)).toBe(12);
      const releases = await api.db.sql`
        select id from public.points_ledger where redemption_id = ${requestId} and kind = 'redemption_release'`;
      expect(releases).toHaveLength(1);
    }
  });

  it('probe: concurrent retries of one adjustment id apply once', async () => {
    const f = await unlockedFamily();
    const body = {
      childId: f.fam.children[0]!.id,
      points: 7,
      reason: 'Helped with reading',
      adjustmentId: randomUUID(),
    };
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        api.request('/v1/points/adjustments', { method: 'POST', token: f.token, body }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(await balance(f)).toBe(7);
  });

  it('probe: child responses after parent decisions still carry no internal ids or actors', async () => {
    const f = await unlockedFamily(2);
    const child = await childToken(f);
    await award(f, 20);
    const reward = await newReward(f, 5);
    const approved = randomUUID();
    const declined = randomUUID();
    await requestReward(child, reward, approved);
    await requestReward(child, reward, declined);
    for (const [id, action] of [
      [approved, 'approve'],
      [declined, 'decline'],
    ] as const) {
      const res = await api.request(`/v1/reward-requests/${id}/decision`, {
        method: 'POST',
        token: f.token,
        body: { action },
      });
      expect(res.status).toBe(200);
    }
    const raw = await json(await api.request('/v1/child/rewards', { token: child }));
    childRewardsResponseSchema.parse(raw);
    const text = JSON.stringify(raw);
    for (const secret of [
      f.fam.familyId,
      f.fam.ownerId,
      f.fam.children[0]!.id,
      f.fam.children[1]!.id,
      'decidedBy',
      'cancelledBy',
      'childNickname',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('probe: a child cannot cancel or replay a sibling request id, and its points stay put', async () => {
    const f = await unlockedFamily(2);
    const riley = await childToken(f, 0);
    const sam = await childToken(f, 1);
    await award(f, 10, 0);
    await award(f, 10, 1);
    const reward = await newReward(f, 4);
    const samRequest = randomUUID();
    expect((await requestReward(sam, reward, samRequest)).status).toBe(201);
    const cancel = await api.request(`/v1/child/reward-requests/${samRequest}/cancel`, {
      method: 'POST',
      token: riley,
    });
    expect(cancel.status).toBe(404);
    const replay = await requestReward(riley, reward, samRequest);
    expect(replay.status).toBe(409);
    expect(JSON.stringify(await json(replay))).not.toContain(f.fam.children[1]!.id);
    expect(await balance(f, 0)).toBe(10);
    expect(await balance(f, 1)).toBe(6);
  });
});
