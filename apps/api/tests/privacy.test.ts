import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  adminSafetyReportsResponseSchema,
  childReportResponseSchema,
  dataExportsResponseSchema,
  deletionRequestResponseSchema,
  deletionRequestsResponseSchema,
  safetyReportsResponseSchema,
} from '@pencillift/contracts';
import { cryptoRandom } from '@pencillift/domain';
import {
  grantAdultUnlock,
  seedFamily,
  seedOwnerAdmin,
  type SeededFamily,
} from '@pencillift/db/testing/fixtures';
import { deletionPurgeHandler, type JobDeps, type JobRow } from '../src/jobs/dispatcher.ts';
import { createExportBuildHandler } from '../src/jobs/export-build.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

// Privacy vertical: deletion, exports and safety reports (spec P4, P8, P10, P14, E4 Deletion;
// AC_ACCESS_10, AC_SECURITY_01, AC_SECURITY_05, AC_LEARNING_10 request side).
// Synthetic families only: Riley (child 0) and Sam (child 1).

let api: TestApi;
let fam: SeededFamily;
let other: SeededFamily;
let token: string; // owner of `fam`, unlocked
let lockedToken: string; // same owner, a session without a step-up
let otherToken: string; // owner of `other`, unlocked
let pairCount = 0;

type ErrorBody = { error: { code: string; rule?: string; message: string } };

const SESSION = 'd1d1d1d1-1111-4111-8111-111111111111';
const LOCKED_SESSION = 'd2d2d2d2-2222-4222-8222-222222222222';
const OTHER_SESSION = 'd3d3d3d3-3333-4333-8333-333333333333';

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

/** A new family whose owner holds an unlocked session. */
async function unlockedFamily(childCount = 1): Promise<{ family: SeededFamily; token: string }> {
  const family = await seedFamily(api.db, { childCount });
  const sessionId = randomUUID();
  await grantAdultUnlock(api.db, family.ownerId, sessionId, 3600);
  return { family, token: await parentToken(family.ownerId, { sessionId }) };
}

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
    headers: { 'cf-connecting-ip': `203.0.113.${pairCount}` },
    body: {
      code: (await json<{ code: string }>(code)).code,
      deviceLabel: `Tablet ${pairCount}`,
      platform: 'ios',
    },
  });
  expect(paired.status).toBe(201);
  return (await json<{ accessToken: string }>(paired)).accessToken;
}

/** Fixture: one extracted homework question (and a hint) for a child, as the scan pipeline makes. */
async function seedQuestion(
  family: SeededFamily,
  index = 0,
): Promise<{ questionId: string; feedbackId: string }> {
  const childId = family.children[index]!.id;
  const [a] = await api.db.sql<{ id: string }[]>`
    insert into public.assignments (family_id, child_id, idempotency_key, created_by_kind)
    values (${family.familyId}, ${childId}, ${'k-' + randomUUID()}, 'child') returning id`;
  const pageId = randomUUID();
  await api.db.sql`
    insert into public.source_pages (id, assignment_id, family_id, child_id, page_number, storage_path, mime_type, byte_size, sha256)
    values (${pageId}, ${a!.id}, ${family.familyId}, ${childId}, 1,
            ${`${family.familyId}/${childId}/${a!.id}/${pageId}.jpg`}, 'image/jpeg', 10, ${'c'.repeat(64)})`;
  const [q] = await api.db.sql<{ id: string }[]>`
    insert into public.extracted_questions (assignment_id, family_id, child_id, page_id, question_number, prompt_text, answer_kind, subject_key, skill)
    values (${a!.id}, ${family.familyId}, ${childId}, ${pageId}, '1', 'Synthetic prompt text', 'numeric', 'math', 'addition')
    returning id`;
  const [f] = await api.db.sql<{ id: string }[]>`
    insert into public.child_feedback (question_id, family_id, child_id, kind, body, guard_version)
    values (${q!.id}, ${family.familyId}, ${childId}, 'hint', 'Try counting on.', 'g1') returning id`;
  return { questionId: q!.id, feedbackId: f!.id };
}

function jobDeps(): JobDeps {
  return {
    db: api.apiDb,
    config: api.config,
    clock: () => api.now.value,
    random: cryptoRandom,
    providers: api.providers,
    log: () => undefined,
  };
}

async function jobByKey(key: string): Promise<JobRow> {
  const [job] = await api.db.sql<JobRow[]>`
    select id, kind, family_id, child_id, payload, attempts, max_attempts
      from public.jobs where idempotency_key = ${key}`;
  expect(job).toBeDefined();
  return job!;
}

/** Runs the real deletion purge job for a deletion request (what the scheduled tick would do). */
async function runPurge(deletionId: string): Promise<void> {
  await deletionPurgeHandler(jobDeps(), await jobByKey('deletion:' + deletionId));
}

/** The real export builder; the signed upload is a labeled test double writing to mock storage. */
const buildExport = createExportBuildHandler({
  upload: (path) => {
    api.providers.storage.objects.add(path);
    return Promise.resolve();
  },
});

async function countRows(table: string, where: string, value: string): Promise<number> {
  const [row] = await api.db.sql.unsafe<{ n: number }[]>(
    `select count(*)::int as n from ${table} where ${where} = $1`,
    [value],
  );
  return row!.n;
}

// ---------------------------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------------------------

describe('deletion requests (spec P4, E4 Deletion; AC_ACCESS_10, AC_SECURITY_05)', () => {
  it('requires a recent step-up and changes nothing without it', async () => {
    const res = await api.request('/v1/deletion', {
      method: 'POST',
      token: lockedToken,
      body: { scope: 'family' },
    });
    expect(res.status).toBe(403);
    expect((await json<ErrorBody>(res)).error.code).toBe('STEP_UP_REQUIRED');
    expect(await countRows('public.deletion_requests', 'family_id', fam.familyId)).toBe(0);
    const [family] = await api.db.sql<{ deleted_at: Date | null }[]>`
      select deleted_at from public.families where id = ${fam.familyId}`;
    expect(family!.deleted_at).toBeNull();
  });

  it('validates the scope/child pairing and rejects smuggled fields', async () => {
    const send = (body: unknown) => api.request('/v1/deletion', { method: 'POST', token, body });
    expect((await send({ scope: 'child' })).status).toBe(400);
    expect((await send({ scope: 'family', childId: fam.children[0]!.id })).status).toBe(400);
    expect((await send({ scope: 'family', familyId: other.familyId })).status).toBe(400);
    expect((await send({ scope: 'everything' })).status).toBe(400);
    expect(await countRows('public.deletion_requests', 'family_id', fam.familyId)).toBe(0);
  });

  it('a parent cannot delete a child of another family', async () => {
    const res = await api.request('/v1/deletion', {
      method: 'POST',
      token: otherToken,
      body: { scope: 'child', childId: fam.children[0]!.id },
    });
    expect(res.status).toBe(404);
    expect(await countRows('public.deletion_requests', 'family_id', fam.familyId)).toBe(0);
    expect(await countRows('public.deletion_requests', 'family_id', other.familyId)).toBe(0);
    const [child] = await api.db.sql<{ status: string }[]>`
      select status from public.child_profiles where id = ${fam.children[0]!.id}`;
    expect(child!.status).toBe('active');
  });

  it('child deletion signs out only that child, enqueues one purge job and reports completeBy', async () => {
    const { family, token: t } = await unlockedFamily(2);
    const rileyToken = await childToken(family, t, 0);
    const samToken = await childToken(family, t, 1);

    const res = await api.request('/v1/deletion', {
      method: 'POST',
      token: t,
      body: { scope: 'child', childId: family.children[0]!.id },
    });
    expect(res.status).toBe(202);
    const { deletion } = deletionRequestResponseSchema.parse(await res.json());
    expect(deletion).toMatchObject({
      scope: 'child',
      childId: family.children[0]!.id,
      status: 'requested',
      completedAt: null,
    });
    const days = (Date.parse(deletion.completeBy) - Date.parse(deletion.requestedAt)) / 86_400_000;
    expect(days).toBe(30);

    expect((await api.request('/v1/child/me', { token: rileyToken })).status).toBe(401);
    expect((await api.request('/v1/child/me', { token: samToken })).status).toBe(200);

    const jobs = await api.db.sql<{ kind: string; status: string; child_id: string | null }[]>`
      select kind, status, child_id from public.jobs where idempotency_key = ${'deletion:' + deletion.id}`;
    expect(jobs).toEqual([
      { kind: 'deletion_purge', status: 'queued', child_id: family.children[0]!.id },
    ]);

    // One open request per target: a repeat is a conflict, not a second job.
    const again = await api.request('/v1/deletion', {
      method: 'POST',
      token: t,
      body: { scope: 'child', childId: family.children[0]!.id },
    });
    expect(again.status).toBe(409);
    expect(await countRows('public.deletion_requests', 'family_id', family.familyId)).toBe(1);
  });

  it('only the family owner can delete the whole family; a guardian can still delete a child', async () => {
    const { family } = await unlockedFamily(1);
    const guardianId = await api.db.createUser();
    await api.db.sql`
      insert into public.family_memberships (family_id, user_id, role, invited_by)
      values (${family.familyId}, ${guardianId}, 'guardian', ${family.ownerId})`;
    const sessionId = randomUUID();
    await grantAdultUnlock(api.db, guardianId, sessionId, 3600);
    const guardianToken = await parentToken(guardianId, { sessionId });

    const denied = await api.request('/v1/deletion', {
      method: 'POST',
      token: guardianToken,
      body: { scope: 'family' },
    });
    expect(denied.status).toBe(403);
    expect((await json<ErrorBody>(denied)).error.rule).toBe('OWNER_ONLY_FAMILY_DELETION');
    const [row] = await api.db.sql<{ deleted_at: Date | null }[]>`
      select deleted_at from public.families where id = ${family.familyId}`;
    expect(row!.deleted_at).toBeNull();

    const child = await api.request('/v1/deletion', {
      method: 'POST',
      token: guardianToken,
      body: { scope: 'child', childId: family.children[0]!.id },
    });
    expect(child.status).toBe(202);
  });

  it('family deletion stops child tokens at once; the parent can still follow it to completion', async () => {
    const { family, token: t } = await unlockedFamily(1);
    const kidToken = await childToken(family, t, 0);
    expect((await api.request('/v1/child/me', { token: kidToken })).status).toBe(200);

    const res = await api.request('/v1/deletion', {
      method: 'POST',
      token: t,
      body: { scope: 'family' },
    });
    expect(res.status).toBe(202);
    const { deletion } = deletionRequestResponseSchema.parse(await res.json());
    expect(deletion).toMatchObject({ scope: 'family', childId: null, status: 'requested' });

    // Access stops immediately (tombstone + revoked sessions), before any purge runs.
    expect((await api.request('/v1/child/me', { token: kidToken })).status).toBe(401);
    const report = await api.request('/v1/child/reports', {
      method: 'POST',
      token: kidToken,
      body: { category: 'other' },
    });
    expect(report.status).toBe(401);
    expect((await api.request('/v1/family', { token: t })).status).toBe(404);
    expect((await api.request('/v1/exports', { token: t })).status).toBe(404);

    // The tombstoned family is invisible to RLS, yet the requester still sees their request.
    const pending = deletionRequestsResponseSchema.parse(
      await (await api.request('/v1/deletion', { token: t })).json(),
    );
    expect(pending.requests.map((r) => [r.id, r.status])).toEqual([[deletion.id, 'requested']]);

    await runPurge(deletion.id);
    const done = deletionRequestsResponseSchema.parse(
      await (await api.request('/v1/deletion', { token: t })).json(),
    );
    expect(done.requests).toHaveLength(1);
    expect(done.requests[0]).toMatchObject({ id: deletion.id, status: 'completed' });
    expect(done.requests[0]!.completedAt).not.toBeNull();
    expect(await countRows('public.child_profiles', 'family_id', family.familyId)).toBe(0);

    // Nobody else can see it.
    const others = deletionRequestsResponseSchema.parse(
      await (await api.request('/v1/deletion', { token: otherToken })).json(),
    );
    expect(others.requests.map((r) => r.id)).not.toContain(deletion.id);
  });

  it('GET /v1/deletion needs a parent token', async () => {
    expect((await api.request('/v1/deletion')).status).toBe(401);
  });

  it('another guardian of a deleted family sees its deletion; a removed guardian does not', async () => {
    // RV-privacy-5 (spec P14 deleted-account state): the tombstoned family is invisible to RLS, so
    // the list is read for the verified caller's own active memberships only.
    const { family, token: t } = await unlockedFamily(1);
    const guardian = async (status: 'active' | 'revoked'): Promise<string> => {
      const userId = await api.db.createUser();
      await api.db.sql`
        insert into public.family_memberships (family_id, user_id, role, invited_by, status, revoked_at)
        values (${family.familyId}, ${userId}, 'guardian', ${family.ownerId}, ${status},
                ${status === 'revoked' ? new Date() : null})`;
      return parentToken(userId);
    };
    const staying = await guardian('active');
    const removed = await guardian('revoked');
    const res = await api.request('/v1/deletion', {
      method: 'POST',
      token: t,
      body: { scope: 'family' },
    });
    expect(res.status).toBe(202);
    const { deletion } = deletionRequestResponseSchema.parse(await res.json());

    const seen = async (who: string) =>
      deletionRequestsResponseSchema
        .parse(await (await api.request('/v1/deletion', { token: who })).json())
        .requests.map((r) => [r.id, r.scope, r.status]);
    expect(await seen(staying)).toEqual([[deletion.id, 'family', 'requested']]);
    expect(await seen(removed)).toEqual([]);
    expect((await seen(otherToken)).map(([id]) => id)).not.toContain(deletion.id);

    // The purge revokes the remaining membership; the requester still follows it to completion.
    await runPurge(deletion.id);
    expect(await seen(t)).toEqual([[deletion.id, 'family', 'completed']]);
    expect(await seen(staying)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Exports and deletion (spec P4 "stop processing immediately", "purge ... derivatives")
// ---------------------------------------------------------------------------------------------

describe('export files and deletion (spec P4, E4 Deletion; AC_ACCESS_10)', () => {
  /** Requests an export and runs the real builder for it; returns its id. */
  async function builtExport(t: string, body: unknown): Promise<string> {
    const res = await api.request('/v1/exports', { method: 'POST', token: t, body });
    expect(res.status).toBe(202);
    const { export: created } = await json<{ export: { id: string } }>(res);
    await buildExport(jobDeps(), await jobByKey('export:' + created.id));
    return created.id;
  }

  async function stored(id: string): Promise<{ status: string; storage_path: string | null }> {
    const [row] = await api.db.sql<{ status: string; storage_path: string | null }[]>`
      select status, storage_path from public.data_exports where id = ${id}`;
    expect(row).toBeDefined();
    return row!;
  }

  async function listed(t: string): Promise<Record<string, string>> {
    const { exports } = dataExportsResponseSchema.parse(
      await (await api.request('/v1/exports', { token: t })).json(),
    );
    return Object.fromEntries(exports.map((e) => [e.id, e.status]));
  }

  const download = async (t: string, id: string) =>
    (await api.request(`/v1/exports/${id}/download`, { token: t })).status;

  it('a child deletion withdraws that child’s and the family-wide exports at once, not a sibling’s', async () => {
    const { family, token: t } = await unlockedFamily(2);
    const [riley, sam] = family.children.map((c) => c.id);
    const whole = await builtExport(t, { kind: 'family_data' });
    const rileys = await builtExport(t, { kind: 'progress_csv', childId: riley });
    const sams = await builtExport(t, { kind: 'progress_csv', childId: sam });
    const paths = {
      whole: (await stored(whole)).storage_path!,
      rileys: (await stored(rileys)).storage_path!,
      sams: (await stored(sams)).storage_path!,
    };
    expect(await listed(t)).toEqual({ [whole]: 'ready', [rileys]: 'ready', [sams]: 'ready' });

    const del = await api.request('/v1/deletion', {
      method: 'POST',
      token: t,
      body: { scope: 'child', childId: riley },
    });
    expect(del.status).toBe(202);

    // Before any purge runs: every file holding Riley's data is gone and refused; Sam's is not.
    expect(await listed(t)).toEqual({ [whole]: 'expired', [rileys]: 'expired', [sams]: 'ready' });
    expect([await download(t, whole), await download(t, rileys), await download(t, sams)]).toEqual([
      409, 409, 200,
    ]);
    const objects = api.providers.storage.objects;
    expect([objects.has(paths.whole), objects.has(paths.rileys), objects.has(paths.sams)]).toEqual([
      false,
      false,
      true,
    ]);
    expect((await stored(whole)).storage_path).toBeNull();
  });

  it('a family deletion removes every export file of the family before the purge runs', async () => {
    const { family, token: t } = await unlockedFamily(1);
    const id = await builtExport(t, { kind: 'progress_pdf' });
    const path = (await stored(id)).storage_path!;
    expect(api.providers.storage.objects.has(path)).toBe(true);
    const del = await api.request('/v1/deletion', {
      method: 'POST',
      token: t,
      body: { scope: 'family' },
    });
    expect(del.status).toBe(202);
    expect(api.providers.storage.objects.has(path)).toBe(false);
    expect(await stored(id)).toEqual({ status: 'expired', storage_path: null });
    expect(
      [...api.providers.storage.objects].filter((p) => p.startsWith(`exports/${family.familyId}/`)),
    ).toEqual([]);
  });

  it('if removing a file fails, the deletion is still accepted and the export stays refused', async () => {
    const { family, token: t } = await unlockedFamily(1);
    const id = await builtExport(t, { kind: 'family_data' });
    const path = (await stored(id)).storage_path!;
    const remove = vi
      .spyOn(api.providers.storage, 'remove')
      .mockRejectedValueOnce(new Error('synthetic storage outage'));
    let deletionId: string;
    try {
      const del = await api.request('/v1/deletion', {
        method: 'POST',
        token: t,
        body: { scope: 'child', childId: family.children[0]!.id },
      });
      expect(del.status).toBe(202);
      deletionId = deletionRequestResponseSchema.parse(await del.json()).deletion.id;
    } finally {
      remove.mockRestore();
    }
    // Refused for download at once; the path is kept so the purge can still remove the file.
    expect(await stored(id)).toEqual({ status: 'expired', storage_path: path });
    expect(await listed(t)).toEqual({ [id]: 'expired' });
    expect(await download(t, id)).toBe(409);
    expect(api.logs.map((l) => l.event)).toContain('export_withdraw_failed');

    await runPurge(deletionId);
    expect(api.providers.storage.objects.has(path)).toBe(false);
  });

  it('GET /v1/exports shows ready until expires_at and expired from that instant', async () => {
    // RV-privacy-8: the list matches the download route, which refuses the file from expires_at.
    const { token: t } = await unlockedFamily(1);
    const id = await builtExport(t, { kind: 'progress_csv' });
    const [row] = await api.db.sql<{ expires_at: Date }[]>`
      select expires_at from public.data_exports where id = ${id}`;
    const start = api.now.value;
    try {
      api.now.value = new Date(row!.expires_at.getTime() - 1);
      expect(await listed(t)).toEqual({ [id]: 'ready' });
      expect(await download(t, id)).toBe(200);
      api.now.value = row!.expires_at;
      expect(await listed(t)).toEqual({ [id]: 'expired' });
      expect(await download(t, id)).toBe(409);
    } finally {
      api.now.value = start;
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------------------------

describe('private exports (spec P8, P10; AC_LEARNING_10 request side, AC_SECURITY_05)', () => {
  it('requires a recent step-up', async () => {
    const res = await api.request('/v1/exports', {
      method: 'POST',
      token: lockedToken,
      body: { kind: 'family_data' },
    });
    expect(res.status).toBe(403);
    expect((await json<ErrorBody>(res)).error.code).toBe('STEP_UP_REQUIRED');
    const answerKey = await api.request('/v1/exports/answer-key', {
      method: 'POST',
      token: lockedToken,
      body: { childId: fam.children[0]!.id },
    });
    expect(answerKey.status).toBe(403);
    expect(await countRows('public.data_exports', 'family_id', fam.familyId)).toBe(0);
  });

  it('records the request and enqueues exactly one export_build job', async () => {
    const res = await api.request('/v1/exports', {
      method: 'POST',
      token,
      body: { kind: 'family_data' },
    });
    expect(res.status).toBe(202);
    const body = await json<{ export: { id: string; kind: string; status: string } }>(res);
    expect(body.export).toMatchObject({ kind: 'family_data', status: 'queued' });
    const jobs = await api.db.sql<{ kind: string; family_id: string; payload: unknown }[]>`
      select kind, family_id, payload from public.jobs where idempotency_key = ${'export:' + body.export.id}`;
    expect(jobs).toEqual([
      { kind: 'export_build', family_id: fam.familyId, payload: { exportId: body.export.id } },
    ]);
    const audit = await api.db.sql<{ action: string }[]>`
      select action from public.audit_events where target_id = ${body.export.id}`;
    expect(audit.map((a) => a.action)).toContain('export.requested');
  });

  it('a questions-only review export cannot be switched to include the answer key', async () => {
    const send = (path: string, body: unknown) =>
      api.request(path, { method: 'POST', token, body });
    const childId = fam.children[0]!.id;
    expect(
      (await send('/v1/exports', { kind: 'review_questions_pdf', childId, includeAnswers: true }))
        .status,
    ).toBe(400);
    expect((await send('/v1/exports', { kind: 'review_answer_key_pdf', childId })).status).toBe(
      400,
    );
    expect((await send('/v1/exports', { kind: 'review_questions_pdf' })).status).toBe(400);
    expect(
      (await send('/v1/exports/answer-key', { childId, kind: 'review_questions_pdf' })).status,
    ).toBe(400);

    const questions = await send('/v1/exports', { kind: 'review_questions_pdf', childId });
    expect(questions.status).toBe(202);
    expect((await json<{ export: { kind: string } }>(questions)).export.kind).toBe(
      'review_questions_pdf',
    );
    const key = await send('/v1/exports/answer-key', { childId });
    expect(key.status).toBe(202);
    expect((await json<{ export: { kind: string; childId: string } }>(key)).export).toMatchObject({
      kind: 'review_answer_key_pdf',
      childId,
    });
  });

  it('children can never request or list exports', async () => {
    const kid = await childToken(fam, token, 1);
    const post = await api.request('/v1/exports', {
      method: 'POST',
      token: kid,
      body: { kind: 'review_questions_pdf', childId: fam.children[1]!.id },
    });
    expect(post.status).toBe(401);
    const key = await api.request('/v1/exports/answer-key', {
      method: 'POST',
      token: kid,
      body: { childId: fam.children[1]!.id },
    });
    expect(key.status).toBe(401);
    expect((await api.request('/v1/exports', { token: kid })).status).toBe(401);
  });

  it('refuses a child id from another family', async () => {
    const before = await countRows('public.data_exports', 'family_id', fam.familyId);
    const res = await api.request('/v1/exports', {
      method: 'POST',
      token: otherToken,
      body: { kind: 'progress_pdf', childId: fam.children[0]!.id },
    });
    expect(res.status).toBe(404);
    const key = await api.request('/v1/exports/answer-key', {
      method: 'POST',
      token: otherToken,
      body: { childId: fam.children[0]!.id },
    });
    expect(key.status).toBe(404);
    expect(await countRows('public.data_exports', 'family_id', fam.familyId)).toBe(before);
    expect(await countRows('public.data_exports', 'family_id', other.familyId)).toBe(0);
  });

  it('refuses to export a child whose deletion is pending', async () => {
    const { family, token: t } = await unlockedFamily(1);
    const childId = family.children[0]!.id;
    expect(
      (
        await api.request('/v1/deletion', {
          method: 'POST',
          token: t,
          body: { scope: 'child', childId },
        })
      ).status,
    ).toBe(202);
    const res = await api.request('/v1/exports', {
      method: 'POST',
      token: t,
      body: { kind: 'progress_csv', childId },
    });
    expect(res.status).toBe(422);
    expect((await json<ErrorBody>(res)).error.rule).toBe('CHILD_DELETION_PENDING');
  });

  it('lists only the caller family exports, without storage paths', async () => {
    const mine = dataExportsResponseSchema.parse(
      await (await api.request('/v1/exports', { token })).json(),
    );
    expect(mine.exports.length).toBeGreaterThanOrEqual(3);
    expect(mine.exports.every((e) => e.status === 'queued')).toBe(true);
    const theirs = dataExportsResponseSchema.parse(
      await (await api.request('/v1/exports', { token: otherToken })).json(),
    );
    const mineIds = new Set(mine.exports.map((e) => e.id));
    expect(theirs.exports.some((e) => mineIds.has(e.id))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Safety reports
// ---------------------------------------------------------------------------------------------

describe('safety reports and the admin queue (spec P4; AC_SECURITY_01)', () => {
  let rileyQuestion: { questionId: string; feedbackId: string };
  let samQuestion: { questionId: string; feedbackId: string };
  let otherQuestion: { questionId: string; feedbackId: string };
  let rileyToken: string;
  let adminId: string;

  beforeAll(async () => {
    rileyQuestion = await seedQuestion(fam, 0);
    samQuestion = await seedQuestion(fam, 1);
    otherQuestion = await seedQuestion(other, 0);
    rileyToken = await childToken(fam, token, 0);
    adminId = await seedOwnerAdmin(api.db);
  });

  it('a child report attaches only the child’s own question or hint', async () => {
    const report = (body: unknown) =>
      api.request('/v1/child/reports', { method: 'POST', token: rileyToken, body });
    expect((await report({ category: 'wrong_or_confusing', ...samQuestion })).status).toBe(404);
    expect(
      (await report({ category: 'answer_revealed', questionId: otherQuestion.questionId })).status,
    ).toBe(404);
    expect(
      (await report({ category: 'answer_revealed', feedbackId: samQuestion.feedbackId })).status,
    ).toBe(404);
    // No family, child or reporter can be smuggled in; unknown categories are refused.
    expect(
      (await report({ category: 'other', childId: fam.children[1]!.id, familyId: other.familyId }))
        .status,
    ).toBe(400);
    expect((await report({ category: 'bad_category' })).status).toBe(400);
    expect(await countRows('public.safety_reports', 'family_id', fam.familyId)).toBe(0);

    const ok = await report({ category: 'answer_revealed', ...rileyQuestion });
    expect(ok.status).toBe(201);
    const body = childReportResponseSchema.parse(await ok.json());
    expect(body.received).toBe(true);
    // Calm, and never a promise that a parent was alerted (spec P4).
    expect(body.message).not.toMatch(/parent|alert|notif|told your/i);

    const rows = await api.db.sql<
      { child_id: string; reporter_kind: string; question_id: string; feedback_id: string }[]
    >`select child_id, reporter_kind, question_id, feedback_id from public.safety_reports where family_id = ${fam.familyId}`;
    expect(rows).toEqual([
      {
        child_id: fam.children[0]!.id,
        reporter_kind: 'child',
        question_id: rileyQuestion.questionId,
        feedback_id: rileyQuestion.feedbackId,
      },
    ]);
  });

  it('a child report works without a question, and parent tokens cannot use the child route', async () => {
    const ok = await api.request('/v1/child/reports', {
      method: 'POST',
      token: rileyToken,
      body: { category: 'upsetting' },
    });
    expect(ok.status).toBe(201);
    const asParent = await api.request('/v1/child/reports', {
      method: 'POST',
      token,
      body: { category: 'upsetting' },
    });
    expect(asParent.status).toBe(401);
  });

  it('a parent report links only this family’s questions and derives the child', async () => {
    const cross = await api.request('/v1/safety-reports', {
      method: 'POST',
      token,
      body: { category: 'unsafe_content', questionId: otherQuestion.questionId },
    });
    expect(cross.status).toBe(404);

    const res = await api.request('/v1/safety-reports', {
      method: 'POST',
      token: lockedToken, // reporting a concern needs no step-up
      body: {
        category: 'wrong_or_confusing',
        questionId: samQuestion.questionId,
        note: 'The hint did not match the worksheet.',
      },
    });
    expect(res.status).toBe(201);
    const { report } = await json<{
      report: { childId: string; reporterKind: string; status: string; note: string };
    }>(res);
    expect(report).toMatchObject({
      childId: fam.children[1]!.id,
      reporterKind: 'parent',
      status: 'open',
      note: 'The hint did not match the worksheet.',
    });
  });

  it('guardians see their own family reports only; children cannot list them', async () => {
    const mine = safetyReportsResponseSchema.parse(
      await (await api.request('/v1/safety-reports', { token })).json(),
    );
    expect(mine.reports.map((r) => r.reporterKind).sort()).toEqual(['child', 'child', 'parent']);
    const theirs = safetyReportsResponseSchema.parse(
      await (await api.request('/v1/safety-reports', { token: otherToken })).json(),
    );
    expect(theirs.reports).toEqual([]);
    expect((await api.request('/v1/safety-reports', { token: rileyToken })).status).toBe(401);
  });

  it('the admin queue requires an owner admin with MFA (aal2)', async () => {
    const aal1 = await parentToken(adminId, { aal: 'aal1' });
    expect((await api.request('/v1/admin/safety-reports', { token: aal1 })).status).toBe(403);
    const notAdmin = await parentToken(fam.ownerId, { aal: 'aal2' });
    expect((await api.request('/v1/admin/safety-reports', { token: notAdmin })).status).toBe(403);
    expect((await api.request('/v1/admin/safety-reports', { token: rileyToken })).status).toBe(401);

    const aal2 = await parentToken(adminId, { aal: 'aal2' });
    const res = await api.request('/v1/admin/safety-reports?status=open', { token: aal2 });
    expect(res.status).toBe(200);
    const raw = await res.text();
    // Ids, category, status and timestamps only: no homework text, nickname or parent note.
    expect(raw).not.toMatch(/Synthetic prompt text|Try counting on|Riley|Sam|did not match/);
    expect(raw).not.toMatch(/nickname|prompt|note"\s*:\s*"/i);
    const body = adminSafetyReportsResponseSchema.parse(JSON.parse(raw));
    const familyReports = body.reports.filter((r) => r.familyId === fam.familyId);
    expect(familyReports).toHaveLength(3);
    expect(familyReports.find((r) => r.reporterKind === 'parent')?.hasNote).toBe(true);
    expect(
      (await api.request('/v1/admin/safety-reports?status=nope', { token: aal2 })).status,
    ).toBe(400);
  });

  it('the admin workflow triages, escalates and resolves with an audit trail', async () => {
    const aal2 = await parentToken(adminId, { aal: 'aal2' });
    const [target] = await api.db.sql<{ id: string }[]>`
      select id from public.safety_reports where family_id = ${fam.familyId} and reporter_kind = 'parent'`;
    const patch = (body: unknown, t = aal2, id = target!.id) =>
      api.request(`/v1/admin/safety-reports/${id}`, { method: 'PATCH', token: t, body });

    const notAdmin = await parentToken(fam.ownerId, { aal: 'aal2' });
    expect((await patch({ status: 'triaged' }, notAdmin)).status).toBe(403);
    expect((await patch({ status: 'triaged' }, aal2, randomUUID())).status).toBe(404);
    expect((await patch({ status: 'open' })).status).toBe(400);

    const triaged = await patch({ status: 'triaged' });
    expect(triaged.status).toBe(200);
    const t1 = await json<{ report: { status: string; triagedAt: string | null } }>(triaged);
    expect(t1.report.status).toBe('triaged');
    expect(t1.report.triagedAt).not.toBeNull();

    expect((await patch({ status: 'escalated' })).status).toBe(200);
    const noNote = await patch({ status: 'resolved' });
    expect(noNote.status).toBe(422);
    expect((await json<ErrorBody>(noNote)).error.rule).toBe('RESOLUTION_NOTE_REQUIRED');
    const resolved = await patch({ status: 'resolved', resolutionNote: 'Template corrected.' });
    expect(resolved.status).toBe(200);
    expect(
      (await json<{ report: { resolvedAt: string | null } }>(resolved)).report.resolvedAt,
    ).not.toBeNull();
    const reopen = await patch({ status: 'triaged' });
    expect(reopen.status).toBe(422);
    expect((await json<ErrorBody>(reopen)).error.rule).toBe('INVALID_TRANSITION');

    const audit = await api.db.sql<{ action: string; actor_kind: string }[]>`
      select action, actor_kind from public.audit_events where target_id = ${target!.id} order by id`;
    expect(audit).toEqual([
      { action: 'safety_report.created', actor_kind: 'parent' },
      { action: 'safety_report.updated', actor_kind: 'admin' },
      { action: 'safety_report.updated', actor_kind: 'admin' },
      { action: 'safety_report.updated', actor_kind: 'admin' },
    ]);

    // The family sees the outcome status (not the internal resolution note).
    const mine = safetyReportsResponseSchema.parse(
      await (await api.request('/v1/safety-reports', { token })).json(),
    );
    expect(mine.reports.find((r) => r.id === target!.id)?.status).toBe('resolved');

    // The queue filter: open reports exclude it; the unfiltered queue includes it.
    const open = adminSafetyReportsResponseSchema.parse(
      await (await api.request('/v1/admin/safety-reports?status=open', { token: aal2 })).json(),
    );
    expect(open.reports.map((r) => r.id)).not.toContain(target!.id);
    const all = adminSafetyReportsResponseSchema.parse(
      await (await api.request('/v1/admin/safety-reports', { token: aal2 })).json(),
    );
    expect(all.reports.find((r) => r.id === target!.id)).toMatchObject({
      status: 'resolved',
      resolutionNote: 'Template corrected.',
    });
  });

  it('a parent report on a child’s question does not block that child’s purge', async () => {
    const { family, token: t } = await unlockedFamily(1);
    const q = await seedQuestion(family, 0);
    const reported = await api.request('/v1/safety-reports', {
      method: 'POST',
      token: t,
      body: { category: 'answer_revealed', questionId: q.questionId },
    });
    expect(reported.status).toBe(201);
    const res = await api.request('/v1/deletion', {
      method: 'POST',
      token: t,
      body: { scope: 'child', childId: family.children[0]!.id },
    });
    expect(res.status).toBe(202);
    const { deletion } = deletionRequestResponseSchema.parse(await res.json());
    await runPurge(deletion.id);
    expect(await countRows('public.safety_reports', 'family_id', family.familyId)).toBe(0);
    expect(await countRows('public.extracted_questions', 'family_id', family.familyId)).toBe(0);
    const status = deletionRequestsResponseSchema.parse(
      await (await api.request('/v1/deletion', { token: t })).json(),
    );
    expect(status.requests[0]).toMatchObject({ id: deletion.id, status: 'completed' });
  });
});
