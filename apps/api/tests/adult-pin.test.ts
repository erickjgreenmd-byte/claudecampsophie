import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantAdultUnlock, seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * Adult PIN step-up edges around the identity review fixes (RV-lead-identity-access-1/2/8 and
 * review note c). Real local Postgres; synthetic adults only.
 */

let api: TestApi;
const FIXED_NOW = new Date('2026-09-24T15:00:00Z');

beforeAll(async () => {
  api = await createTestApi();
});

afterAll(async () => {
  await api?.close();
});

let seq = 0;
function sessionId(): string {
  seq += 1;
  return `ad0a${seq.toString(16).padStart(4, '0')}-0000-4000-8000-000000000000`;
}

async function adultWithPin(pin = '739164'): Promise<{ fam: SeededFamily; session: string }> {
  const fam = await seedFamily(api.db);
  const session = sessionId();
  const token = await parentToken(fam.ownerId, { sessionId: session });
  expect((await api.request('/v1/adult/pin', { method: 'PUT', token, body: { pin } })).status).toBe(
    200,
  );
  return { fam, session };
}

const unlock = (token: string, pin: string) =>
  api.request('/v1/adult/unlock', { method: 'POST', token, body: { method: 'pin', pin } });

const addChild = (token: string) =>
  api.request('/v1/children', {
    method: 'POST',
    token,
    body: { nickname: 'Sam', gradeLevel: 2, ageBand: '5-7' },
  });

describe('PIN attempts (RV-lead-identity-access-1)', () => {
  it('guesses spread over several sessions share one per-adult limit', async () => {
    const { fam } = await adultWithPin();
    const statuses: number[] = [];
    // 3 sessions x 7 attempts: each session stays under its own limit of 10.
    for (let s = 0; s < 3; s += 1) {
      const token = await parentToken(fam.ownerId, { sessionId: sessionId() });
      for (let i = 0; i < 7; i += 1) statuses.push((await unlock(token, '000001')).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 403 || s === 423)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('the lock ends after its period and the right PIN then works; a wrong one counts again', async () => {
    const { fam, session } = await adultWithPin();
    const token = await parentToken(fam.ownerId, { sessionId: session });
    for (let i = 0; i < 5; i += 1) await unlock(token, '000002');
    const locked = await unlock(token, '739164');
    expect(locked.status).toBe(423);
    api.now.value = new Date(FIXED_NOW.getTime() + 16 * 60 * 1000);
    try {
      const wrong = await unlock(token, '000003');
      expect(wrong.status).toBe(403);
      const [row] = await api.db.sql<{ failed_attempts: number }[]>`
        select failed_attempts from private.parent_pins where user_id = ${fam.ownerId}`;
      expect(row!.failed_attempts).toBe(1);
      expect((await unlock(token, '739164')).status).toBe(200);
    } finally {
      api.now.value = FIXED_NOW;
    }
  });

  it('the fifth wrong PIN answers 423 with a Retry-After of the lock period', async () => {
    const { fam, session } = await adultWithPin();
    const token = await parentToken(fam.ownerId, { sessionId: session });
    for (let i = 0; i < 4; i += 1) expect((await unlock(token, '000004')).status).toBe(403);
    const fifth = await unlock(token, '000004');
    expect(fifth.status).toBe(423);
    expect(Number(fifth.headers.get('retry-after'))).toBe(15 * 60);
  });
});

describe('PIN reset budget (RV-lead-identity-access-2)', () => {
  it('real resets are still limited to five a day', async () => {
    const { fam } = await adultWithPin();
    const fresh = await parentToken(fam.ownerId, {
      sessionId: sessionId(),
      amr: [{ method: 'password', timestamp: Math.floor(api.now.value.getTime() / 1000) - 30 }],
    });
    const pins = ['731846', '842957', '953168', '164379', '275481', '386592'];
    const statuses: number[] = [];
    for (const pin of pins) {
      statuses.push(
        (await api.request('/v1/adult/pin/reset', { method: 'POST', token: fresh, body: { pin } }))
          .status,
      );
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe('PIN set/change budget (API-AUTH-R1-04 follow-up)', () => {
  it('an adult can replace their PIN ten times an hour; the eleventh call is refused', async () => {
    const { fam, session } = await adultWithPin('739164');
    await grantAdultUnlock(api.db, fam.ownerId, session, 3600);
    const token = await parentToken(fam.ownerId, { sessionId: session });
    const pins = [
      '842957',
      '953168',
      '164379',
      '275481',
      '386592',
      '497613',
      '518724',
      '629835',
      '740916',
      '851027',
    ];
    const statuses: number[] = [];
    for (const pin of pins) {
      statuses.push(
        (await api.request('/v1/adult/pin', { method: 'PUT', token, body: { pin } })).status,
      );
    }
    // The first set counted as one of the ten; nine changes follow, then 429 with retry-after.
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 429]);
    const refused = await api.request('/v1/adult/pin', {
      method: 'PUT',
      token,
      body: { pin: '962138' },
    });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    // A weak PIN is refused before the budget is touched, so it never counts against the parent.
    const weak = await api.request('/v1/adult/pin', {
      method: 'PUT',
      token,
      body: { pin: '111111' },
    });
    expect(weak.status).toBe(400);
  });
});

describe('changing the PIN ends other sessions’ step-ups (review note c)', () => {
  it('other sessions must unlock again with the new PIN; this session keeps its step-up', async () => {
    const { fam, session } = await adultWithPin('739164');
    const here = await parentToken(fam.ownerId, { sessionId: session });
    const elsewhere = sessionId();
    const other = await parentToken(fam.ownerId, { sessionId: elsewhere });
    await grantAdultUnlock(api.db, fam.ownerId, elsewhere, 3600);
    expect((await unlock(here, '739164')).status).toBe(200);

    const change = await api.request('/v1/adult/pin', {
      method: 'PUT',
      token: here,
      body: { pin: '846201' },
    });
    expect(change.status).toBe(200);
    expect((await addChild(other)).status).toBe(403);
    expect((await addChild(here)).status).toBe(201);
    expect((await unlock(other, '739164')).status).toBe(403);
    expect((await unlock(other, '846201')).status).toBe(200);
  });
});

describe('step-up lifetime uses one clock (RV-lead-identity-access-8)', () => {
  for (const skewHours of [-24, -1, 1, 24]) {
    it(`an unlock is honoured when the request clock is ${skewHours} h off the database`, async () => {
      const { fam, session } = await adultWithPin();
      const token = await parentToken(fam.ownerId, { sessionId: session });
      const [db] = await api.db.sql<{ now: Date }[]>`select now() as now`;
      api.now.value = new Date(db!.now.getTime() + skewHours * 3600 * 1000);
      try {
        const res = await unlock(token, '739164');
        expect(res.status).toBe(200);
        // The reported expiry is the one the server enforces (database clock + TTL).
        const { unlockedUntil } = await json<{ unlockedUntil: string }>(res);
        const [row] = await api.db.sql<{ expires_at: Date }[]>`
          select expires_at from private.adult_unlocks
           where user_id = ${fam.ownerId} and revoked_at is null`;
        expect(new Date(unlockedUntil).getTime()).toBe(row!.expires_at.getTime());
        expect((await addChild(token)).status).toBe(201);
      } finally {
        api.now.value = FIXED_NOW;
      }
    });
  }
});
