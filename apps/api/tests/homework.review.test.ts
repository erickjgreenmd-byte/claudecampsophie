import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assignmentDetailResponseSchema,
  assignmentStateResponseSchema,
  childAssignmentListResponseSchema,
} from '@pencillift/contracts';
import { cryptoRandom } from '@pencillift/domain';
import { grantAdultUnlock, seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { purgeExpiredScans, type JobDeps } from '../src/jobs/dispatcher.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * Independent adversarial review of the homework vertical (REVIEW-HOMEWORK). Each `[RV-homework-n]`
 * test is a regression test for one defect found in review and fails on the reviewed code for the
 * reason stated in its title. Synthetic families only.
 */

let api: TestApi;
let jobDeps: JobDeps;
let pairCount = 0;

type Row = Record<string, unknown>;
type ErrorBody = { error: { code: string; rule?: string; message: string } };

const key = () => randomUUID();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

async function consent(familyId: string, ownerId: string, status = 'verified'): Promise<void> {
  await api.db.sql`
    insert into public.consent_records
      (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider,
       verified_at, withdrawn_at)
    values (${familyId}, ${ownerId}, 'development_mock', 'development_mock', 'child_data_processing',
            'v1', ${status}, true,
            ${status === 'verified' || status === 'withdrawn' ? new Date() : null},
            ${status === 'withdrawn' ? new Date() : null})`;
}

async function capacity(familyId: string, slots: number): Promise<void> {
  await api.db.sql`
    insert into public.family_capacity (family_id, paid_slots, managing_channel)
    values (${familyId}, ${slots}, 'app_store')
    on conflict (family_id) do update set paid_slots = excluded.paid_slots`;
}

/** A consented family with capacity for every child and an unlocked parent session. */
async function family(childCount = 1): Promise<{ f: SeededFamily; token: string }> {
  const f = await seedFamily(api.db, { childCount });
  await consent(f.familyId, f.ownerId);
  await capacity(f.familyId, childCount);
  const session = randomUUID();
  await grantAdultUnlock(api.db, f.ownerId, session, 3600);
  return { f, token: await parentToken(f.ownerId, { sessionId: session }) };
}

async function childToken(f: SeededFamily, parent: string, index = 0): Promise<string> {
  const code = await api.request(`/v1/children/${f.children[index]!.id}/pairing-code`, {
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
      deviceLabel: `Review tablet ${pairCount}`,
      platform: 'ios',
    },
  });
  expect(paired.status).toBe(201);
  return (await json<{ accessToken: string }>(paired)).accessToken;
}

function pages(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    pageNumber: i + 1,
    mimeType: 'image/jpeg',
    byteSize: 250_000,
    sha256: sha(`review-page-${i + 1}-${randomUUID()}`),
  }));
}

const create = (t: string, body: Row) =>
  api.request('/v1/assignments', { method: 'POST', token: t, body });
const upload = (t: string, id: string, body: Row) =>
  api.request(`/v1/assignments/${id}/uploads`, { method: 'POST', token: t, body });
const finalize = (t: string, id: string) =>
  api.request(`/v1/assignments/${id}/finalize`, {
    method: 'POST',
    token: t,
    body: { idempotencyKey: key() },
  });
const cancel = (t: string, id: string) =>
  api.request(`/v1/assignments/${id}/cancel`, { method: 'POST', token: t });

async function created(t: string, body: Row): Promise<string> {
  const res = await create(t, body);
  expect(res.status).toBe(201);
  return assignmentStateResponseSchema.parse(await json(res)).assignment.id;
}

async function storagePaths(assignmentId: string): Promise<string[]> {
  const rows = await api.db.sql<{ storage_path: string }[]>`
    select storage_path from public.source_pages where assignment_id = ${assignmentId}`;
  return rows.map((r) => r.storage_path);
}

async function queuedScan(t: string, body: Row, pageCount = 1): Promise<string> {
  const id = await created(t, { pageCount, idempotencyKey: key(), ...body });
  expect((await upload(t, id, { pages: pages(pageCount) })).status).toBe(200);
  for (const p of await storagePaths(id)) api.providers.storage.objects.add(p);
  expect((await finalize(t, id)).status).toBe(200);
  return id;
}

async function errorOf(res: Response): Promise<ErrorBody['error']> {
  return (await json<ErrorBody>(res)).error;
}

beforeAll(async () => {
  api = await createTestApi();
  jobDeps = {
    db: api.apiDb,
    config: api.config,
    clock: () => api.now.value,
    random: cryptoRandom,
    providers: api.providers,
    log: (e) => api.logs.push(e),
  };
});

afterAll(async () => {
  await api?.close();
});

describe('homework review regressions (REVIEW-HOMEWORK)', () => {
  it('[RV-homework-1] resuming an upload after consent was withdrawn must not hand out new upload URLs', async () => {
    const { f, token } = await family(1);
    const riley = await childToken(f, token, 0);
    const id = await created(riley, { pageCount: 2, idempotencyKey: key() });
    const p = pages(2);
    expect((await upload(riley, id, { pages: p })).status).toBe(200);

    // The parent withdraws consent while the upload is interrupted (spec P3/P4).
    await consent(f.familyId, f.ownerId, 'withdrawn');
    // New scans are already refused...
    const fresh = await create(riley, { pageCount: 1, idempotencyKey: key() });
    expect((await errorOf(fresh)).rule).toBe('CONSENT_REQUIRED');

    // ...but the resume path skips the consent gate and signs fresh PUT URLs for child photos.
    const resumed = await upload(riley, id, { pages: p });
    expect(resumed.status).toBe(422);
    expect((await errorOf(resumed)).rule).toBe('CONSENT_REQUIRED');
  });

  it('[RV-homework-2] pages left in storage by a cancel whose removal failed must still be purged by raw-scan retention', async () => {
    const { f, token } = await family(1);
    const id = await queuedScan(token, { childId: f.children[0]!.id }, 2);
    const paths = await storagePaths(id);
    const storage = api.providers.storage;
    expect(paths.every((p) => storage.objects.has(p))).toBe(true);

    // Storage is briefly unreachable during the cancel. The route logs and answers 200, relying on
    // "the retention purge job removes anything left behind".
    const originalRemove = storage.remove.bind(storage);
    storage.remove = () => Promise.reject(new Error('storage down'));
    try {
      expect((await cancel(token, id)).status).toBe(200);
    } finally {
      storage.remove = originalRemove;
    }
    expect(paths.every((p) => storage.objects.has(p))).toBe(true);

    // Well past the 30-day raw-scan retention (spec P4), the purge runs.
    const saved = api.now.value;
    api.now.value = new Date(Date.now() + 31 * 86_400_000);
    try {
      await purgeExpiredScans(jobDeps);
    } finally {
      api.now.value = saved;
    }
    // The cancel already stamped deleted_at, so the purge (which only selects deleted_at is null)
    // never sees these objects: the child's homework photos stay in storage indefinitely.
    expect(paths.filter((p) => storage.objects.has(p))).toEqual([]);
  });

  it('[RV-homework-3] a profile whose paid slot was released by a downgrade cannot start new paid scans', async () => {
    const { f, token } = await family(2);
    // Both children were activated into paid slots (as POST /v1/children/:id/activate does).
    for (const c of f.children) {
      await api.db.sql`
        insert into public.child_slot_assignments (family_id, child_id) values (${f.familyId}, ${c.id})`;
    }
    // Provider-confirmed downgrade to one slot, applied exactly as services/billing-sync.ts does:
    // capacity drops and the excess slot is released; the profile row is left untouched.
    await capacity(f.familyId, 1);
    await api.db.sql`
      update public.child_slot_assignments set released_at = now(), release_reason = 'downgrade'
       where child_id = ${f.children[1]!.id} and released_at is null`;

    const res = await create(token, {
      childId: f.children[1]!.id,
      pageCount: 1,
      idempotencyKey: key(),
    });
    // Spec P11: stop paid AI for profiles without a paid slot. The capture gate only reads
    // child_profiles.status, so the unpaid profile is accepted (201) and shares the paid allowance.
    expect(res.status).toBe(422);
    expect((await errorOf(res)).rule).toBe('CHILD_NOT_ACTIVE');
  });

  it('[RV-homework-5] once the parent has overridden every flagged answer the scan no longer says it needs review', async () => {
    const { f, token } = await family(1);
    const childId = f.children[0]!.id;
    const riley = await childToken(f, token, 0);
    const assignmentId = await queuedScan(token, { childId }, 1);
    const [page] = await api.db.sql<{ id: string }[]>`
      select id from public.source_pages where assignment_id = ${assignmentId}`;
    const [flagged] = await api.db.sql<{ id: string }[]>`
      insert into public.extracted_questions
        (assignment_id, family_id, child_id, page_id, question_number, prompt_text, student_answer_text,
         answer_kind, subject_key, skill, uncertainty)
      values (${assignmentId}, ${f.familyId}, ${childId}, ${page!.id}, '1', 'What is 6 x 7?', '42',
              'numeric', 'math', 'multiplication', 'medium')
      returning id`;
    // The grader could not settle question 1 and sent it to the parent (as scan-process.ts finish() does).
    await api.db.sql`
      insert into public.question_results (question_id, family_id, child_id, verdict, route, disagreement, grader_version)
      values (${flagged!.id}, ${f.familyId}, ${childId}, 'needs_parent_review', 'parent_review', true, 'g1')`;
    for (const s of ['extracting', 'checking', 'needs_parent_review']) {
      await api.db.sql`update public.assignments set status = ${s} where id = ${assignmentId}`;
    }

    const override = await api.request(`/v1/questions/${flagged!.id}/override`, {
      method: 'POST',
      token,
      body: { verdict: 'correct', reason: 'Checked against the worksheet' },
    });
    expect(override.status).toBe(200);

    // Nothing is left for the parent to review (the job's own rule treats an override as settling a
    // question), yet the scan stays "Needs your review" for the parent and "Ask a grown-up to review
    // this" for the child, with no action that can ever clear it.
    const detail = assignmentDetailResponseSchema.parse(
      await json(await api.request(`/v1/assignments/${assignmentId}`, { token })),
    );
    expect(detail.questions.every((q) => q.result?.override !== null)).toBe(true);
    expect(detail.assignment.status).toBe('ready');
    const childList = childAssignmentListResponseSchema.parse(
      await json(await api.request('/v1/child/assignments', { token: riley })),
    );
    expect(childList.assignments.find((a) => a.id === assignmentId)?.status).toBe('ready');
  });
});

describe('homework review probes (passing checks of risky behaviour)', () => {
  it('a child token never finalizes, cancels or uploads to a sibling scan created by the parent', async () => {
    const { f, token } = await family(2);
    const riley = await childToken(f, token, 0);
    const samScan = await created(token, {
      childId: f.children[1]!.id,
      pageCount: 1,
      idempotencyKey: key(),
    });
    expect((await upload(riley, samScan, { pages: pages(1) })).status).toBe(404);
    expect((await finalize(riley, samScan)).status).toBe(404);
    expect((await cancel(riley, samScan)).status).toBe(404);
    const [row] = await api.db.sql<{ status: string }[]>`
      select status from public.assignments where id = ${samScan}`;
    expect(row!.status).toBe('draft');
  });

  it('server contract behind RV-homework-4: a retried create after finalize returns the queued scan and /uploads answers 422', async () => {
    const { f, token } = await family(1);
    const riley = await childToken(f, token, 0);
    const createKey = key();
    const id = await created(riley, { pageCount: 1, idempotencyKey: createKey });
    const p = pages(1);
    expect((await upload(riley, id, { pages: p })).status).toBe(200);
    for (const path of await storagePaths(id)) api.providers.storage.objects.add(path);
    expect((await finalize(riley, id)).status).toBe(200);
    // The device never saw that response and retries the whole flow with the same keys and pages.
    const again = await create(riley, { pageCount: 1, idempotencyKey: createKey });
    expect(again.status).toBe(200);
    expect(assignmentStateResponseSchema.parse(await json(again)).assignment).toMatchObject({
      id,
      status: 'queued',
    });
    const reupload = await upload(riley, id, { pages: p });
    expect(reupload.status).toBe(422);
    expect((await errorOf(reupload)).rule).toBe('INVALID_TRANSITION');
  });

  it('a parent step-up session cannot be replaced by a child token on the solutions route', async () => {
    const { f, token } = await family(1);
    const riley = await childToken(f, token, 0);
    const id = await queuedScan(token, { childId: f.children[0]!.id }, 1);
    const res = await api.request(`/v1/assignments/${id}/solutions`, { token: riley });
    expect(res.status).toBe(401);
    expect(JSON.stringify(await json(res))).not.toMatch(/correctAnswer|workedSolution/);
  });
});
