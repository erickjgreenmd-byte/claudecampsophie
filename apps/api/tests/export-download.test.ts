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

describe('export download (spec P4 exports, P8 protected answer key)', () => {
  it('returns a short-lived signed link for a ready export of the caller’s family only', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const other = await seedFamily(api.db, { childCount: 1 });
    const id = await exportRow(fam, 'family_data');
    const res = await download(await parentToken(fam.ownerId), id);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await json<{ url: string; expiresAt: string }>(res);
    expect(body.url).toContain(encodeURIComponent(`exports/${fam.familyId}/family_data.pdf`));
    expect((await download(await parentToken(other.ownerId), id)).status).toBe(404);
  });

  it('refuses exports that are not ready or have expired', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const token = await parentToken(fam.ownerId);
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
