import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGE_BANDS, gradeLevelSchema } from '@pencillift/contracts';
import {
  grantAdultUnlock,
  seedFamily,
  seedOwnerAdmin,
  type SeededFamily,
} from '@pencillift/db/testing/fixtures';
import { knownConstraintError } from '../src/errors.ts';
import { RATE_RULES } from '../src/middleware/rate-limit.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * Hardening round 1, API input validation (findings API-AUTH-R1-01/03/04/05). Real Postgres;
 * synthetic adults and children only (Riley, Sam, Jordan).
 */

let api: TestApi;
let fam: SeededFamily;
let owner: string;
const SESSION = '61111111-1111-4111-8111-111111111111';

beforeAll(async () => {
  api = await createTestApi();
  fam = await seedFamily(api.db, { childCount: 1 });
  await grantAdultUnlock(api.db, fam.ownerId, SESSION, 24 * 3600);
  owner = await parentToken(fam.ownerId, { sessionId: SESSION });
});

afterAll(async () => {
  await api?.close();
});

interface ErrorBody {
  error: { code: string; rule?: string; message: string };
}

async function call(
  path: string,
  init: Parameters<TestApi['request']>[1],
): Promise<{ status: number; body: ErrorBody }> {
  const res = await api.request(path, init);
  return { status: res.status, body: await json<ErrorBody>(res) };
}

function expectValidationFailed(r: { status: number; body: ErrorBody }): void {
  expect(r.status).toBe(400);
  expect(r.body.error.code).toBe('VALIDATION_FAILED');
  // Never the raw Postgres wording.
  expect(r.body.error.message).not.toMatch(/UTF8|0x00|byte sequence/i);
}

// ---------------------------------------------------------------------------------------------
// API-AUTH-R1-01: control characters (U+0000 included) in free text are refused before Postgres
// ---------------------------------------------------------------------------------------------

describe('[API-AUTH-R1-01] free text with control characters is a 400, never a 500', () => {
  it('family: POST /v1/families displayName', async () => {
    const userId = await api.db.createUser();
    const token = await parentToken(userId, { sessionId: randomUUID() });
    expectValidationFailed(
      await call('/v1/families', {
        method: 'POST',
        token,
        body: { displayName: 'Fam\u0000ily', timezone: 'America/Chicago' },
      }),
    );
  });

  it('family: POST /v1/children nickname (NUL and a bell character)', async () => {
    for (const nickname of ['Ri\u0000ley', 'Ri\u0007ley', 'Riley\u001b[31m']) {
      expectValidationFailed(
        await call('/v1/children', {
          method: 'POST',
          token: owner,
          body: { nickname, gradeLevel: 3, ageBand: '8-10' },
        }),
      );
    }
  });

  it('privacy: POST /v1/safety-reports note', async () => {
    expectValidationFailed(
      await call('/v1/safety-reports', {
        method: 'POST',
        token: owner,
        body: { category: 'other', note: 'note\u0000here' },
      }),
    );
  });

  it('learning: study material text, custom subject name and test-date scope notes', async () => {
    const childId = fam.children[0]!.id;
    expectValidationFailed(
      await call(`/v1/children/${childId}/study-materials`, {
        method: 'POST',
        token: owner,
        body: { kind: 'taught_notes', text: 'fractions\u0000 and decimals' },
      }),
    );
    expectValidationFailed(
      await call(`/v1/children/${childId}/subjects`, {
        method: 'POST',
        token: owner,
        body: { subjectKey: 'custom', displayName: 'Chess\u0000' },
      }),
    );
    expectValidationFailed(
      await call(`/v1/children/${childId}/test-dates`, {
        method: 'POST',
        token: owner,
        body: { subjectId: randomUUID(), testDate: '2026-10-10', scopeNotes: 'ch\u00001-3' },
      }),
    );
  });

  it('support: case subject and message', async () => {
    expectValidationFailed(
      await call('/v1/support/cases', {
        method: 'POST',
        token: owner,
        body: { kind: 'other', subject: 'Hello\u0000there', message: 'Body text here' },
      }),
    );
    expectValidationFailed(
      await call('/v1/support/cases', {
        method: 'POST',
        token: owner,
        body: { kind: 'other', subject: 'Hello there', message: 'Body\u0000text' },
      }),
    );
  });

  it('support: tabs and line breaks in a message stay allowed', async () => {
    const res = await api.request('/v1/support/cases', {
      method: 'POST',
      token: owner,
      body: { kind: 'other', subject: 'Two lines', message: 'Line one\n\tLine two\r\nEnd' },
    });
    expect(res.status).toBe(201);
  });

  it('homework: override reason and transcription correction text', async () => {
    const questionId = randomUUID();
    expectValidationFailed(
      await call(`/v1/questions/${questionId}/override`, {
        method: 'POST',
        token: owner,
        body: { verdict: 'correct', reason: 'Looks\u0000fine' },
      }),
    );
    expectValidationFailed(
      await call(`/v1/questions/${questionId}/correction`, {
        method: 'POST',
        token: owner,
        body: { promptText: '3 +\u0000 4' },
      }),
    );
  });

  it('auth: pairing deviceLabel', async () => {
    expectValidationFailed(
      await call('/v1/child/pair', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '198.51.100.77' },
        body: { code: 'ABCD-EFGH', deviceLabel: 'Tab\u0000let', platform: 'android' },
      }),
    );
  });

  it('the central error mapper turns Postgres 22021/22P05 into VALIDATION_FAILED', () => {
    for (const code of ['22021', '22P05']) {
      const mapped = knownConstraintError({
        code,
        message: 'invalid byte sequence for encoding "UTF8": 0x00',
      });
      expect(mapped?.code).toBe('VALIDATION_FAILED');
      expect(mapped?.status).toBe(400);
      expect(mapped?.message).not.toMatch(/UTF8|0x00/);
    }
    expect(knownConstraintError({ code: '22P02' })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// API-AUTH-R1-03: admin keyset cursors that pass the regex but overflow bigint
// ---------------------------------------------------------------------------------------------

describe('[API-AUTH-R1-03] admin keyset cursors beyond int64 or in the future are refused', () => {
  it('both admin queues answer VALIDATION_FAILED, never 500', async () => {
    const adminId = await seedOwnerAdmin(api.db);
    const admin = await parentToken(adminId, { aal: 'aal2' });
    const id = '00000000-0000-4000-8000-000000000001';
    const bad = [
      `9999999999999999999_${id}`, // above int64 max
      `9223372036854775808_${id}`, // int64 max + 1
      `9223372036854775807_${id}`, // int64 max (interval overflow)
      `4102444800000000_${id}`, // 2100-01-01: far in the future of any request clock
    ];
    for (const cursor of bad) {
      const a = await call(`/v1/admin/safety-reports?after=${cursor}`, { token: admin });
      expect(a.status, `safety ${cursor}`).toBe(400);
      expect(a.body.error.code).toBe('VALIDATION_FAILED');
      const b = await call(`/v1/admin/support/cases?after=${cursor}`, { token: admin });
      expect(b.status, `support ${cursor}`).toBe(400);
      expect(b.body.error.code).toBe('VALIDATION_FAILED');
    }
    // A well-formed cursor in the past still pages (empty queue: no rows, no error).
    const ok = await api.request(`/v1/admin/safety-reports?after=1000000_${id}`, {
      token: admin,
    });
    expect(ok.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// API-AUTH-R1-04: per-family limits on parent create routes; a hard cap on child profiles
// ---------------------------------------------------------------------------------------------

describe('[API-AUTH-R1-04] per-family caps and rate rules on parent create routes', () => {
  it('a family cannot hold more than 12 non-archived child profiles', async () => {
    // Two seeded profiles (SQL, not counted by the limiter) plus ten created through the API.
    const f = await seedFamily(api.db, { childCount: 2 });
    const session = randomUUID();
    await grantAdultUnlock(api.db, f.ownerId, session, 24 * 3600);
    const token = await parentToken(f.ownerId, { sessionId: session });
    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const res = await api.request('/v1/children', {
        method: 'POST',
        token,
        body: { nickname: `Draft ${i}`, gradeLevel: 3, ageBand: '8-10' },
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual(new Array<number>(10).fill(201));
    const thirteenth = await call('/v1/children', {
      method: 'POST',
      token,
      body: { nickname: 'One too many', gradeLevel: 3, ageBand: '8-10' },
    });
    expect(thirteenth.status).toBe(422);
    expect(thirteenth.body.error.code).toBe('BUSINESS_RULE');
    expect(thirteenth.body.error.rule).toBe('CHILD_PROFILE_LIMIT');
    const [count] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.child_profiles where family_id = ${f.familyId}`;
    expect(count!.n).toBe(12);

    // Archiving one frees room again (archived profiles keep their history, spec P11).
    const draft = await api.db.sql<{ id: string }[]>`
      select id from public.child_profiles where family_id = ${f.familyId} and status = 'draft' limit 1`;
    const archived = await api.request(`/v1/children/${draft[0]!.id}/archive`, {
      method: 'POST',
      token,
    });
    expect(archived.status).toBe(200);
    const again = await api.request('/v1/children', {
      method: 'POST',
      token,
      body: { nickname: 'Jordan', gradeLevel: 2, ageBand: '5-7' },
    });
    expect(again.status).toBe(201);
  });

  it('child profile creation is rate limited per family', async () => {
    const f = await seedFamily(api.db, { childCount: 0 });
    const session = randomUUID();
    await grantAdultUnlock(api.db, f.ownerId, session, 24 * 3600);
    const token = await parentToken(f.ownerId, { sessionId: session });
    // The cap (12) is above the rule's window limit, so the limiter answers first.
    expect(RATE_RULES.childCreatePerFamily.limit).toBeLessThanOrEqual(12);
    let limited = 0;
    for (let i = 0; i < RATE_RULES.childCreatePerFamily.limit + 1; i += 1) {
      const res = await api.request('/v1/children', {
        method: 'POST',
        token,
        body: { nickname: `Sam ${i}`, gradeLevel: 1, ageBand: '5-7' },
      });
      if (res.status === 429) {
        limited += 1;
        expect(res.headers.get('retry-after')).not.toBeNull();
      }
    }
    expect(limited).toBe(1);
  });

  it('rewards, custom subjects, test dates, study materials and schedule updates have per-family rules', async () => {
    const f = await seedFamily(api.db, { childCount: 1 });
    const childId = f.children[0]!.id;
    const session = randomUUID();
    await grantAdultUnlock(api.db, f.ownerId, session, 24 * 3600);
    const token = await parentToken(f.ownerId, { sessionId: session });
    const cases: { name: string; limit: number; request: (i: number) => Promise<Response> }[] = [
      {
        name: 'rewards',
        limit: RATE_RULES.rewardCreatePerFamily.limit,
        request: (i) =>
          api.request('/v1/rewards', {
            method: 'POST',
            token,
            body: { title: `Reward ${i}`, pointCost: 5, childId: null },
          }),
      },
      {
        name: 'subjects',
        limit: RATE_RULES.subjectCreatePerFamily.limit,
        request: (i) =>
          api.request(`/v1/children/${childId}/subjects`, {
            method: 'POST',
            token,
            body: { subjectKey: 'custom', displayName: `Club ${i}` },
          }),
      },
      {
        name: 'test dates',
        limit: RATE_RULES.testDateCreatePerFamily.limit,
        request: () =>
          api.request(`/v1/children/${childId}/test-dates`, {
            method: 'POST',
            token,
            body: { subjectId: randomUUID(), testDate: '2026-10-10' },
          }),
      },
      {
        name: 'study materials',
        limit: RATE_RULES.studyMaterialCreatePerFamily.limit,
        request: (i) =>
          api.request(`/v1/children/${childId}/study-materials`, {
            method: 'POST',
            token,
            body: { kind: 'taught_notes', text: `Fractions lesson ${i}` },
          }),
      },
      {
        name: 'schedule',
        limit: RATE_RULES.scheduleUpdatePerFamily.limit,
        request: () =>
          api.request(`/v1/children/${childId}/learning-schedule`, {
            method: 'PUT',
            token,
            body: {
              reviewWeekday: 6,
              reviewLocalTime: '10:00',
              reviewQuestionsPerSubject: 5,
              dailyLocalTime: '16:00',
              dailyQuestionCount: 6,
              pause: null,
              quietHours: null,
              childRemindersPermitted: false,
            },
          }),
      },
    ];
    for (const c of cases) {
      let limited = 0;
      for (let i = 0; i < c.limit + 1; i += 1) {
        const res = await c.request(i);
        expect(res.status, `${c.name} #${i}`).not.toBe(500);
        if (res.status === 429) limited += 1;
      }
      expect(limited, c.name).toBe(1);
    }
  });

  it('POST /v1/child/refresh is rate limited per client network before the token lookup', async () => {
    const rule = RATE_RULES.childRefreshPerNetwork;
    const headers = { 'cf-connecting-ip': '203.0.113.9' };
    const statuses = new Set<number>();
    for (let i = 0; i < rule.limit + 1; i += 1) {
      const res = await api.request('/v1/child/refresh', {
        method: 'POST',
        headers,
        body: { refreshToken: `not-a-real-token-${randomUUID()}` },
      });
      statuses.add(res.status);
    }
    expect(statuses.has(429)).toBe(true);
    // Another network is unaffected.
    const other = await api.request('/v1/child/refresh', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '203.0.113.10' },
      body: { refreshToken: `not-a-real-token-${randomUUID()}` },
    });
    expect(other.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------
// API-AUTH-R1-05: launch scope is K-8, under 13
// ---------------------------------------------------------------------------------------------

describe('[API-AUTH-R1-05] child profiles are K-8 and under 13 at the API boundary', () => {
  it('the contracts offer no 14-18 band and cap the grade at 8', () => {
    expect([...AGE_BANDS]).toEqual(['5-7', '8-10', '11-13']);
    expect(gradeLevelSchema.safeParse(8).success).toBe(true);
    expect(gradeLevelSchema.safeParse(9).success).toBe(false);
  });

  it('POST /v1/children refuses grade 9-12 and the 14-18 band', async () => {
    for (const body of [
      { nickname: 'Teen', gradeLevel: 12, ageBand: '14-18' },
      { nickname: 'Teen', gradeLevel: 9, ageBand: '11-13' },
      { nickname: 'Teen', gradeLevel: 8, ageBand: '14-18' },
    ]) {
      expectValidationFailed(await call('/v1/children', { method: 'POST', token: owner, body }));
    }
    const eighth = await api.request('/v1/children', {
      method: 'POST',
      token: owner,
      body: { nickname: 'Jordan', gradeLevel: 8, ageBand: '11-13' },
    });
    expect(eighth.status).toBe(201);
  });
});
