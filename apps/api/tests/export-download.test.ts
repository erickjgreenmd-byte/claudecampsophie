import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantAdultUnlock, seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

let api: TestApi;
const SESSION = '99999999-9999-4999-8999-999999999999';

beforeAll(async () => {
  api = await createTestApi();
});

afterAll(async () => {
  await api?.close();
});

async function exportRow(
  fam: SeededFamily,
  kind: string,
  status = 'ready',
  expiresAt: Date | null = null,
): Promise<string> {
  const childId = kind.startsWith('review') ? fam.children[0]!.id : null;
  const [row] = await api.db.sql<{ id: string }[]>`
    insert into public.data_exports (family_id, requested_by, kind, child_id, status, storage_path, expires_at)
    values (${fam.familyId}, ${fam.ownerId}, ${kind}, ${childId}, ${status},
            ${status === 'ready' ? `exports/${fam.familyId}/${kind}.pdf` : null}, ${expiresAt})
    returning id`;
  return row!.id;
}

const download = (token: string, id: string) =>
  api.request(`/v1/exports/${id}/download`, { token });

let sessionSeq = 0;
/** A parent token whose auth session has a recent adult unlock (spec P3 step-up for exports). */
async function unlockedToken(userId: string): Promise<string> {
  sessionSeq += 1;
  const sessionId = `0e0e${sessionSeq.toString(16).padStart(4, '0')}-0000-4000-8000-000000000000`;
  await grantAdultUnlock(api.db, userId, sessionId, 300);
  return parentToken(userId, { sessionId });
}

describe('export download (spec P3 step-up for exports, P4 exports, P8 protected answer key)', () => {
  it('returns a short-lived signed link for a ready export of the caller’s family only', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const other = await seedFamily(api.db, { childCount: 1 });
    const id = await exportRow(fam, 'family_data');
    const res = await download(await unlockedToken(fam.ownerId), id);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await json<{ url: string; expiresAt: string }>(res);
    expect(body.url).toContain(encodeURIComponent(`exports/${fam.familyId}/family_data.pdf`));
    // Another family's adult gets nothing, even with their own step-up.
    expect((await download(await unlockedToken(other.ownerId), id)).status).toBe(404);
  });

  it('[RV-lead-identity-access-3] every private export kind needs a recent unlock; a locked session is refused', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const locked = await parentToken(fam.ownerId, {
      sessionId: '0e0effff-0000-4000-8000-000000000000',
    });
    for (const kind of ['family_data', 'progress_pdf', 'progress_csv', 'review_answer_key_pdf']) {
      const res = await download(locked, await exportRow(fam, kind));
      expect({ kind, status: res.status }).toEqual({ kind, status: 403 });
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe('STEP_UP_REQUIRED');
    }
    // Relocking (switch to child mode) takes the download away again.
    const token = await unlockedToken(fam.ownerId);
    const id = await exportRow(fam, 'family_data');
    expect((await download(token, id)).status).toBe(200);
    expect((await api.request('/v1/adult/lock', { method: 'POST', token })).status).toBe(200);
    expect((await download(token, id)).status).toBe(403);
  });

  it('refuses exports that are not ready or have expired', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const token = await unlockedToken(fam.ownerId);
    expect((await download(token, await exportRow(fam, 'progress_csv', 'queued'))).status).toBe(
      409,
    );
    const expired = await exportRow(fam, 'progress_csv', 'ready', new Date('2026-09-01T00:00:00Z'));
    expect((await download(token, expired)).status).toBe(409);
  });

  it('the answer key needs a recent adult unlock; the questions PDF does not', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const token = await parentToken(fam.ownerId, { sessionId: SESSION });
    const key = await exportRow(fam, 'review_answer_key_pdf');
    const questions = await exportRow(fam, 'review_questions_pdf');
    expect((await download(token, questions)).status).toBe(200);
    expect((await download(token, key)).status).toBe(403);
    await grantAdultUnlock(api.db, fam.ownerId, SESSION, 300);
    expect((await download(token, key)).status).toBe(200);
  });

  it('children and anonymous callers get nothing', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const id = await exportRow(fam, 'family_data');
    expect((await api.request(`/v1/exports/${id}/download`)).status).toBe(401);
  });
});
