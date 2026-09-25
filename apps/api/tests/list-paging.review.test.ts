import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assignmentListResponseSchema, pointsHistoryResponseSchema } from '@pencillift/contracts';
import { grantAdultUnlock, seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * API-AUTH-R1-02: the parent homework list and the points history page with keyset cursors, so a
 * family with more than 100 scans or ledger rows can still reach every one (spec P11 keeps the
 * history). Real Postgres; synthetic family only.
 */

let api: TestApi;
let fam: SeededFamily;
let token: string;
const SESSION = '62222222-2222-4222-8222-222222222222';
const ROWS = 130;

beforeAll(async () => {
  api = await createTestApi();
  fam = await seedFamily(api.db, { childCount: 1 });
  await grantAdultUnlock(api.db, fam.ownerId, SESSION, 3600);
  token = await parentToken(fam.ownerId, { sessionId: SESSION });
  const childId = fam.children[0]!.id;
  // Scans one second apart, with a few that share a created_at to exercise the id tiebreak.
  await api.db.sql`
    insert into public.assignments (family_id, child_id, idempotency_key, created_by_kind, page_count, status, created_at)
    select ${fam.familyId}, ${childId}, 'page-scan-' || i, 'parent', 1, 'ready',
           timestamptz '2026-08-01T00:00:00Z' + ((i / 3) * interval '1 second')
      from generate_series(1, ${ROWS}) as i`;
  await api.db.sql`
    insert into public.points_ledger (family_id, child_id, kind, points, idempotency_key, actor_kind)
    select ${fam.familyId}, ${childId}, 'award', 1, 'attempt:' || i, 'system'
      from generate_series(1, ${ROWS}) as i`;
});

afterAll(async () => {
  await api?.close();
});

describe('[API-AUTH-R1-02] GET /v1/assignments pages with after=<created_at_micros>_<id>', () => {
  it('walks every scan newest first without repeats or gaps', async () => {
    const childId = fam.children[0]!.id;
    const seen: string[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const path =
        `/v1/assignments?childId=${childId}` +
        (cursor ? `&after=${encodeURIComponent(cursor)}` : '');
      const res = await api.request(path, { token });
      expect(res.status).toBe(200);
      const body = assignmentListResponseSchema.parse(await json(res));
      expect(body.assignments.length).toBeLessThanOrEqual(100);
      const stamps = body.assignments.map((a) => Date.parse(a.createdAt));
      expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);
      seen.push(...body.assignments.map((a) => a.id));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(2);
    expect(seen).toHaveLength(ROWS);
    expect(new Set(seen).size).toBe(ROWS);
    // The first page is full and says where to continue; the last page says there is no more.
    const first = assignmentListResponseSchema.parse(
      await json(await api.request(`/v1/assignments?childId=${childId}`, { token })),
    );
    expect(first.assignments).toHaveLength(100);
    expect(first.nextCursor).toMatch(/^[0-9]{1,19}_[0-9a-f-]{36}$/);
  });

  it('refuses a malformed, overflowing or far-future cursor with VALIDATION_FAILED', async () => {
    const childId = fam.children[0]!.id;
    for (const bad of [
      'abc',
      `9999999999999999999_${randomUUID()}`,
      `4102444800000000_${randomUUID()}`,
      '123_not-a-uuid',
    ]) {
      const res = await api.request(
        `/v1/assignments?childId=${childId}&after=${encodeURIComponent(bad)}`,
        { token },
      );
      expect(res.status, bad).toBe(400);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('[API-AUTH-R1-02] GET /v1/points/history pages with before=<ledger id>', () => {
  it('walks every ledger entry newest first without repeats or gaps', async () => {
    const childId = fam.children[0]!.id;
    const seen: string[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const path = `/v1/points/history?childId=${childId}` + (cursor ? `&before=${cursor}` : '');
      const res = await api.request(path, { token });
      expect(res.status).toBe(200);
      const body = pointsHistoryResponseSchema.parse(await json(res));
      expect(body.entries.length).toBeLessThanOrEqual(100);
      const ids = body.entries.map((e) => BigInt(e.id));
      expect([...ids].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))).toEqual(ids);
      // Totals and balance describe the whole ledger on every page.
      expect(body.totals.net).toBe(ROWS);
      expect(body.balance).toBe(ROWS);
      expect(body.hasMore).toBe(body.nextCursor !== null);
      seen.push(...body.entries.map((e) => e.id));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(2);
    expect(seen).toHaveLength(ROWS);
    expect(new Set(seen).size).toBe(ROWS);
  });

  it('refuses a malformed or overflowing cursor with VALIDATION_FAILED', async () => {
    const childId = fam.children[0]!.id;
    for (const bad of ['abc', '-1', '9223372036854775808', '1e5']) {
      const res = await api.request(
        `/v1/points/history?childId=${childId}&before=${encodeURIComponent(bad)}`,
        { token },
      );
      expect(res.status, bad).toBe(400);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe('VALIDATION_FAILED');
    }
  });
});
