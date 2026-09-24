import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHILD_FORBIDDEN_HOMEWORK_KEYS,
  assignmentDetailResponseSchema,
  assignmentListResponseSchema,
  assignmentSolutionsResponseSchema,
  assignmentStateResponseSchema,
  childAssignmentDetailResponseSchema,
  childAssignmentListResponseSchema,
  correctTranscriptionResponseSchema,
  overrideResultResponseSchema,
  uploadLimitsResponseSchema,
  uploadPagesResponseSchema,
} from '@pencillift/contracts';
import { grantAdultUnlock, seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import type { AppEnv } from '../src/middleware/context.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

// Synthetic families only: Riley (child 0) and Sam (child 1), plus other families for isolation.
let api: TestApi;
let fam: SeededFamily;
let other: SeededFamily;
let token: string; // unlocked parent session (step-up present)
let lockedToken: string; // same parent, a different auth session without a step-up
let otherToken: string; // unlocked parent of another family
let riley: string; // Riley's child access token
let sam: string; // Sam's child access token
let otherChild: string; // child in another family
const SESSION = 'd1d1d1d1-1111-4111-8111-111111111111';
const LOCKED_SESSION = 'e2e2e2e2-2222-4222-8222-222222222222';
const OTHER_SESSION = 'f3f3f3f3-3333-4333-8333-333333333333';
const START = new Date('2026-09-24T15:00:00Z');
let pairCount = 0;

// Distinctive private values: any appearance in a child payload or log is a leak.
const SECRET_ANSWER = 'SECRET-KEY-7Q4';
const SECRET_SOLUTION = 'SECRET-WORKED-9Z2';
const SECRET_MISCONCEPTION = 'SECRET-MISCONCEPTION-3K';
const PROMPT = 'What is 3/4 + 1/8?';
const STUDENT_ANSWER = '4/12';

type ErrorBody = { error: { code: string; rule?: string; message: string } };
type Row = Record<string, unknown>;

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

/**
 * Gives each listed child an open paid slot, exactly as POST /v1/children/:id/activate does. An
 * `active` profile holds a paid slot (migration 0001); capture refuses a profile without one
 * (RV-homework-3), so fixtures must model activation rather than only the profile status.
 */
async function assignSlots(family: SeededFamily, indexes?: number[]): Promise<void> {
  for (const i of indexes ?? family.children.map((_, n) => n)) {
    await api.db.sql`
      insert into public.child_slot_assignments (family_id, child_id)
      values (${family.familyId}, ${family.children[i]!.id})`;
  }
}

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

const key = () => randomUUID();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function pages(count: number, overrides: Partial<Row> = {}): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    pageNumber: i + 1,
    mimeType: 'image/jpeg',
    byteSize: 250_000,
    sha256: sha(`page-${i + 1}-${randomUUID()}`),
    ...overrides,
  }));
}

function create(t: string, body: Row) {
  return api.request('/v1/assignments', { method: 'POST', token: t, body });
}

function upload(t: string, id: string, body: Row) {
  return api.request(`/v1/assignments/${id}/uploads`, { method: 'POST', token: t, body });
}

function finalize(t: string, id: string, idempotencyKey = key()) {
  return api.request(`/v1/assignments/${id}/finalize`, {
    method: 'POST',
    token: t,
    body: { idempotencyKey },
  });
}

function cancel(t: string, id: string) {
  return api.request(`/v1/assignments/${id}/cancel`, { method: 'POST', token: t });
}

async function created(t: string, body: Row): Promise<string> {
  const res = await create(t, body);
  expect(res.status).toBe(201);
  return assignmentStateResponseSchema.parse(await json(res)).assignment.id;
}

/** Simulates the device PUTting every page's bytes to its signed URL. */
async function markUploaded(assignmentId: string): Promise<void> {
  const rows = await api.db.sql<{ storage_path: string }[]>`
    select storage_path from public.source_pages where assignment_id = ${assignmentId}`;
  for (const r of rows) api.providers.storage.objects.add(r.storage_path);
}

/** Creates, uploads and finalizes a scan; returns the assignment id. */
async function queuedScan(t: string, body: Row, pageCount = 2): Promise<string> {
  const id = await created(t, { pageCount, idempotencyKey: key(), ...body });
  expect((await upload(t, id, { pages: pages(pageCount) })).status).toBe(200);
  await markUploaded(id);
  const fin = await finalize(t, id);
  expect(fin.status).toBe(200);
  return id;
}

async function advance(assignmentId: string, statuses: string[]): Promise<void> {
  for (const s of statuses) {
    await api.db.sql`update public.assignments set status = ${s} where id = ${assignmentId}`;
  }
}

interface SeededResult {
  assignmentId: string;
  questionId: string;
  secondQuestionId: string;
  attemptId: string;
}

/**
 * Fixture standing in for the later extraction/grading job: questions, a private solution, child-safe
 * results and guarded feedback, then the state machine walked to `ready`.
 */
async function readyScan(family: SeededFamily, t: string, childIndex = 0): Promise<SeededResult> {
  const childId = family.children[childIndex]!.id;
  const assignmentId = await queuedScan(t, { childId }, 1);
  const [page] = await api.db.sql<{ id: string }[]>`
    select id from public.source_pages where assignment_id = ${assignmentId}`;
  const insertQuestion = async (n: string, prompt: string, answer: string) => {
    const [q] = await api.db.sql<{ id: string }[]>`
      insert into public.extracted_questions
        (assignment_id, family_id, child_id, page_id, question_number, prompt_text, student_answer_text,
         answer_kind, subject_key, skill, uncertainty)
      values (${assignmentId}, ${family.familyId}, ${childId}, ${page!.id}, ${n}, ${prompt}, ${answer},
              'numeric', 'math', 'fraction_addition', 'low')
      returning id`;
    return q!.id;
  };
  const questionId = await insertQuestion('1', PROMPT, STUDENT_ANSWER);
  const secondQuestionId = await insertQuestion('2', 'What is 2 + 5?', '7');
  await api.db.sql`
    insert into private.question_solutions
      (question_id, family_id, correct_answer, worked_solution, rubric, misconception, grader_version)
    values (${questionId}, ${family.familyId}, ${SECRET_ANSWER}, ${SECRET_SOLUTION},
            ${api.db.sql.json({ criterion: 'common denominator' })}, ${SECRET_MISCONCEPTION}, 'g1')`;
  await api.db.sql`
    insert into public.question_results (question_id, family_id, child_id, verdict, route, disagreement, grader_version)
    values (${questionId}, ${family.familyId}, ${childId}, 'incorrect', 'escalated', true, 'g1'),
           (${secondQuestionId}, ${family.familyId}, ${childId}, 'correct', 'deterministic', false, 'g1')`;
  await api.db.sql`
    insert into public.child_feedback (question_id, family_id, child_id, kind, body, guard_version)
    values (${questionId}, ${family.familyId}, ${childId}, 'hint',
            'Try finding a common denominator first.', 'guard-v1')`;
  const [attempt] = await api.db.sql<{ id: string }[]>`
    insert into public.attempts
      (family_id, child_id, question_instance_id, source, subject_key, skill, attempt_number,
       correctness, grader_version, idempotency_key, occurred_at)
    values (${family.familyId}, ${childId}, ${questionId}, 'homework', 'math', 'fraction_addition', 1,
            'incorrect', 'g1', ${'hw-attempt:' + questionId}, now())
    returning id`;
  await advance(assignmentId, ['extracting', 'checking', 'verifying', 'ready']);
  return { assignmentId, questionId, secondQuestionId, attemptId: attempt!.id };
}

function expectNoChildLeak(payload: unknown): void {
  const text = JSON.stringify(payload);
  for (const k of CHILD_FORBIDDEN_HOMEWORK_KEYS) expect(text).not.toContain(`"${k}"`);
  for (const secret of [SECRET_ANSWER, SECRET_SOLUTION, SECRET_MISCONCEPTION, 'escalated']) {
    expect(text).not.toContain(secret);
  }
}

async function errorOf(res: Response): Promise<ErrorBody['error']> {
  return (await json<ErrorBody>(res)).error;
}

beforeAll(async () => {
  api = await createTestApi();
  fam = await seedFamily(api.db, { childCount: 2, timezone: 'America/Chicago' });
  other = await seedFamily(api.db, { childCount: 1 });
  for (const f of [fam, other]) {
    await consent(f.familyId, f.ownerId);
    await capacity(f.familyId, f.children.length);
    await assignSlots(f);
  }
  await grantAdultUnlock(api.db, fam.ownerId, SESSION, 3600);
  await grantAdultUnlock(api.db, other.ownerId, OTHER_SESSION, 3600);
  token = await parentToken(fam.ownerId, { sessionId: SESSION });
  lockedToken = await parentToken(fam.ownerId, { sessionId: LOCKED_SESSION });
  otherToken = await parentToken(other.ownerId, { sessionId: OTHER_SESSION });
  riley = await childToken(fam, token, 0);
  sam = await childToken(fam, token, 1);
  otherChild = await childToken(other, otherToken, 0);
});

afterAll(async () => {
  await api?.close();
});

// ---------------------------------------------------------------------------------------------

describe('upload limits are visible before upload (spec P5)', () => {
  it('returns the configured limits to parents and children, never to anonymous callers', async () => {
    for (const t of [token, riley]) {
      const res = await api.request('/v1/assignments/limits', { token: t });
      expect(res.status).toBe(200);
      expect(uploadLimitsResponseSchema.parse(await json(res)).limits).toEqual({
        maxPages: 10,
        maxPageBytes: 15 * 1024 * 1024,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/heic', 'application/pdf'],
      });
    }
    expect((await api.request('/v1/assignments/limits')).status).toBe(401);
  });
});

describe('creating a scan (spec P5, P3 consent gate)', () => {
  it('a parent creates a draft for their own active child', async () => {
    const res = await create(token, {
      childId: fam.children[0]!.id,
      pageCount: 2,
      idempotencyKey: key(),
    });
    expect(res.status).toBe(201);
    const { assignment } = assignmentStateResponseSchema.parse(await json(res));
    expect(assignment).toMatchObject({ status: 'draft', pageCount: 2, subjectId: null });
    const [row] = await api.db.sql<
      { child_id: string; family_id: string; created_by_kind: string }[]
    >`
      select child_id, family_id, created_by_kind from public.assignments where id = ${assignment.id}`;
    expect(row).toEqual({
      child_id: fam.children[0]!.id,
      family_id: fam.familyId,
      created_by_kind: 'parent',
    });
  });

  it('parents must name a child; children may not name one', async () => {
    expect((await create(token, { pageCount: 1, idempotencyKey: key() })).status).toBe(400);
    const res = await create(riley, {
      childId: fam.children[1]!.id,
      pageCount: 1,
      idempotencyKey: key(),
    });
    expect(res.status).toBe(400);
  });

  it('a child creates a scan only for itself', async () => {
    const res = await create(riley, { pageCount: 1, idempotencyKey: key() });
    expect(res.status).toBe(201);
    const { assignment } = assignmentStateResponseSchema.parse(await json(res));
    const [row] = await api.db.sql<{ child_id: string; created_by_kind: string }[]>`
      select child_id, created_by_kind from public.assignments where id = ${assignment.id}`;
    expect(row).toEqual({ child_id: fam.children[0]!.id, created_by_kind: 'child' });
  });

  it('the same idempotency key from the same family returns the existing scan', async () => {
    const body = { childId: fam.children[0]!.id, pageCount: 3, idempotencyKey: key() };
    const first = await create(token, body);
    expect(first.status).toBe(201);
    const again = await create(token, body);
    expect(again.status).toBe(200);
    const a = assignmentStateResponseSchema.parse(await json(first)).assignment;
    const b = assignmentStateResponseSchema.parse(await json(again)).assignment;
    expect(b.id).toBe(a.id);
    const concurrent = { ...body, idempotencyKey: key() };
    const results = await Promise.all([create(token, concurrent), create(token, concurrent)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    const [count] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.assignments where idempotency_key like ${'%' + concurrent.idempotencyKey}`;
    expect(count!.n).toBe(1);
  });

  it('a key reused by another family creates an independent scan (no cross-family collision)', async () => {
    const shared = key();
    const mine = await created(token, {
      childId: fam.children[0]!.id,
      pageCount: 1,
      idempotencyKey: shared,
    });
    const res = await create(otherToken, {
      childId: other.children[0]!.id,
      pageCount: 1,
      idempotencyKey: shared,
    });
    expect(res.status).toBe(201);
    expect(assignmentStateResponseSchema.parse(await json(res)).assignment.id).not.toBe(mine);
  });

  it('reusing a key for a different child is a conflict, not a silent reuse', async () => {
    const k = key();
    await created(token, { childId: fam.children[0]!.id, pageCount: 1, idempotencyKey: k });
    const res = await create(token, {
      childId: fam.children[1]!.id,
      pageCount: 1,
      idempotencyKey: k,
    });
    expect(res.status).toBe(409);
  });

  it('refuses another family’s child, draft children and foreign subjects', async () => {
    expect(
      (await create(token, { childId: other.children[0]!.id, pageCount: 1, idempotencyKey: key() }))
        .status,
    ).toBe(404);
    const [draft] = await api.db.sql<{ id: string }[]>`
      insert into public.child_profiles (family_id, nickname, grade_level, age_band)
      values (${fam.familyId}, 'Jordan', 2, '5-7') returning id`;
    const res = await create(token, { childId: draft!.id, pageCount: 1, idempotencyKey: key() });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).rule).toBe('CHILD_NOT_ACTIVE');
    const [samSubject] = await api.db.sql<{ id: string }[]>`
      insert into public.child_subjects (family_id, child_id, subject_key, display_name)
      values (${fam.familyId}, ${fam.children[1]!.id}, 'math', 'Math') returning id`;
    const wrongChild = await create(token, {
      childId: fam.children[0]!.id,
      subjectId: samSubject!.id,
      pageCount: 1,
      idempotencyKey: key(),
    });
    expect(wrongChild.status).toBe(404);
    const ok = await create(token, {
      childId: fam.children[1]!.id,
      subjectId: samSubject!.id,
      pageCount: 1,
      idempotencyKey: key(),
    });
    expect(ok.status).toBe(201);
    expect(assignmentStateResponseSchema.parse(await json(ok)).assignment.subjectId).toBe(
      samSubject!.id,
    );
  });

  it('refuses more pages than the configured limit with an explicit rule', async () => {
    const res = await create(token, {
      childId: fam.children[0]!.id,
      pageCount: 11,
      idempotencyKey: key(),
    });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).rule).toBe('TOO_MANY_PAGES');
  });

  it('requires verified consent before any child data is collected (CONSENT_REQUIRED)', async () => {
    const pending = await seedFamily(api.db, { childCount: 1 });
    await capacity(pending.familyId, 1);
    await assignSlots(pending);
    await grantAdultUnlock(api.db, pending.ownerId, SESSION, 3600);
    const t = await parentToken(pending.ownerId, { sessionId: SESSION });
    const body = () => ({ childId: pending.children[0]!.id, pageCount: 1, idempotencyKey: key() });
    const none = await create(t, body());
    expect(none.status).toBe(422);
    expect((await errorOf(none)).rule).toBe('CONSENT_REQUIRED');
    await consent(pending.familyId, pending.ownerId, 'pending');
    expect((await errorOf(await create(t, body()))).rule).toBe('CONSENT_REQUIRED');
    await consent(pending.familyId, pending.ownerId, 'verified');
    expect((await create(t, body())).status).toBe(201);
    // Withdrawal (the latest record) stops new scans immediately.
    await consent(pending.familyId, pending.ownerId, 'withdrawn');
    expect((await errorOf(await create(t, body()))).rule).toBe('CONSENT_REQUIRED');
    // The child route is gated the same way.
    const kid = await childToken(pending, t, 0);
    expect((await errorOf(await create(kid, { pageCount: 1, idempotencyKey: key() }))).rule).toBe(
      'CONSENT_REQUIRED',
    );
  });

  it('a development/test consent record never enables production processing', async () => {
    const prod = await createTestApi({ APP_ENV: 'production' });
    try {
      const f = await seedFamily(prod.db, { childCount: 1 });
      await prod.db.sql`
        insert into public.consent_records
          (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
        values (${f.familyId}, ${f.ownerId}, 'development_mock', 'development_mock', 'child_data_processing',
                'v1', 'verified', true, now())`;
      await prod.db
        .sql`insert into public.family_capacity (family_id, paid_slots) values (${f.familyId}, 1)`;
      const res = await prod.request('/v1/assignments', {
        method: 'POST',
        token: await parentToken(f.ownerId),
        body: { childId: f.children[0]!.id, pageCount: 1, idempotencyKey: key() },
      });
      expect(res.status).toBe(422);
      expect((await json<ErrorBody>(res)).error.rule).toBe('CONSENT_REQUIRED');
    } finally {
      await prod.close();
    }
  });
});

describe('paid profile gate (spec P11; RV-homework-3)', () => {
  /** A consented family with every child activated into a paid slot and an unlocked parent. */
  async function paidFamily(children: number) {
    const f = await seedFamily(api.db, { childCount: children });
    await consent(f.familyId, f.ownerId);
    await capacity(f.familyId, children);
    await assignSlots(f);
    const session = randomUUID();
    await grantAdultUnlock(api.db, f.ownerId, session, 3600);
    return { f, t: await parentToken(f.ownerId, { sessionId: session }) };
  }

  async function allowanceOf(t: string, childId: string) {
    const res = await api.request(`/v1/assignments?childId=${childId}`, { token: t });
    expect(res.status).toBe(200);
    return assignmentListResponseSchema.parse(await json(res)).allowance!;
  }

  it('a downgrade that releases a slot stops create, finalize and child capture for that profile only', async () => {
    const { f, t } = await paidFamily(2);
    const [first, second] = [f.children[0]!.id, f.children[1]!.id];
    const kid = await childToken(f, t, 1);
    // The second child's scan is mid-upload when the downgrade lands.
    const inFlight = await created(kid, { pageCount: 1, idempotencyKey: key() });
    expect((await upload(kid, inFlight, { pages: pages(1) })).status).toBe(200);
    await markUploaded(inFlight);
    expect((await allowanceOf(t, second)).childHasPaidSlot).toBe(true);

    // Provider-confirmed downgrade to one slot, applied as services/billing-sync.ts does.
    await capacity(f.familyId, 1);
    await api.db.sql`
      update public.child_slot_assignments set released_at = now(), release_reason = 'downgrade'
       where child_id = ${second} and released_at is null`;

    const parentCreate = await create(t, { childId: second, pageCount: 1, idempotencyKey: key() });
    expect(parentCreate.status).toBe(422);
    const parentError = await errorOf(parentCreate);
    expect(parentError.rule).toBe('CHILD_NOT_ACTIVE');
    expect(parentError.message).toMatch(/no paid child slot/);
    const childError = await errorOf(await create(kid, { pageCount: 1, idempotencyKey: key() }));
    expect(childError.rule).toBe('CHILD_NOT_ACTIVE');
    expect(childError.message).not.toMatch(/slot|paid/i); // no commercial copy for a child
    // Finalize would reserve paid AI: refused, and the uploaded work is kept (not charged).
    const fin = await finalize(kid, inFlight);
    expect((await errorOf(fin)).rule).toBe('CHILD_NOT_ACTIVE');
    const [row] = await api.db.sql<{ status: string; jobs: number }[]>`
      select a.status,
             (select count(*)::int from public.jobs j where j.idempotency_key like ${'scan:' + inFlight + ':%'}) as jobs
        from public.assignments a where a.id = ${inFlight}`;
    expect(row).toEqual({ status: 'uploading', jobs: 0 });
    // A resumed upload signs new URLs for child photos, so it is gated too.
    expect((await errorOf(await upload(kid, inFlight, { pages: pages(1) }))).rule).toBe(
      'CHILD_NOT_ACTIVE',
    );
    expect((await allowanceOf(t, second)).childHasPaidSlot).toBe(false);

    // The child who kept the slot is unaffected.
    expect((await create(t, { childId: first, pageCount: 1, idempotencyKey: key() })).status).toBe(
      201,
    );
    expect((await allowanceOf(t, first)).childHasPaidSlot).toBe(true);
  });

  it('after expiry (no paid capacity) capture says there is no paid slot, not that pages are used up', async () => {
    const { f, t } = await paidFamily(1);
    const childId = f.children[0]!.id;
    await capacity(f.familyId, 0);
    await api.db.sql`
      update public.child_slot_assignments set released_at = now(), release_reason = 'expired'
       where child_id = ${childId} and released_at is null`;
    const res = await create(t, { childId, pageCount: 1, idempotencyKey: key() });
    expect((await errorOf(res)).rule).toBe('CHILD_NOT_ACTIVE');
    const allowance = await allowanceOf(t, childId);
    expect(allowance).toMatchObject({
      childPagesUsed: 0,
      familyPagesAllowed: 0,
      childHasPaidSlot: false,
    });
  });

  it('active profiles without any slot record are covered only while capacity covers all of them', async () => {
    // e.g. profiles made active outside the activation route: never more than paid capacity.
    const f = await seedFamily(api.db, { childCount: 2 });
    await consent(f.familyId, f.ownerId);
    await capacity(f.familyId, 1);
    const t = await parentToken(f.ownerId);
    for (const child of f.children) {
      const res = await create(t, { childId: child.id, pageCount: 1, idempotencyKey: key() });
      expect((await errorOf(res)).rule).toBe('CHILD_NOT_ACTIVE');
    }
    await capacity(f.familyId, 2);
    expect(
      (await create(t, { childId: f.children[1]!.id, pageCount: 1, idempotencyKey: key() })).status,
    ).toBe(201);
  });
});

describe('page uploads (AC_CAPTURE_02)', () => {
  it('registers pages under a family/child/assignment storage path and returns signed URLs', async () => {
    const id = await created(token, {
      childId: fam.children[0]!.id,
      pageCount: 2,
      idempotencyKey: key(),
    });
    const res = await upload(token, id, {
      pages: [
        { pageNumber: 1, mimeType: 'image/jpeg', byteSize: 1000, sha256: sha('a') },
        { pageNumber: 2, mimeType: 'application/pdf', byteSize: 2000, sha256: sha('b') },
      ],
    });
    expect(res.status).toBe(200);
    const body = uploadPagesResponseSchema.parse(await json(res));
    expect(body.assignment.status).toBe('uploading');
    expect(body.uploads).toHaveLength(2);
    expect(body.uploads.every((u) => u.method === 'PUT' && !u.alreadyUploaded)).toBe(true);
    const rows = await api.db.sql<{ id: string; storage_path: string; page_number: number }[]>`
      select id, storage_path, page_number from public.source_pages
       where assignment_id = ${id} order by page_number`;
    expect(rows.map((r) => r.storage_path)).toEqual([
      `${fam.familyId}/${fam.children[0]!.id}/${id}/${rows[0]!.id}.jpg`,
      `${fam.familyId}/${fam.children[0]!.id}/${id}/${rows[1]!.id}.pdf`,
    ]);
    expect(body.uploads.map((u) => u.pageId)).toEqual(rows.map((r) => r.id));
  });

  it('rejects unsupported types, oversized pages and too many pages with explicit rules', async () => {
    const id = await created(token, {
      childId: fam.children[0]!.id,
      pageCount: 1,
      idempotencyKey: key(),
    });
    const cases: [Row[], string][] = [
      [pages(1, { mimeType: 'image/gif' }), 'UNSUPPORTED_FILE_TYPE'],
      [pages(1, { mimeType: 'text/html' }), 'UNSUPPORTED_FILE_TYPE'],
      [pages(1, { byteSize: 15 * 1024 * 1024 + 1 }), 'PAGE_TOO_LARGE'],
      [pages(11), 'TOO_MANY_PAGES'],
      [pages(2), 'PAGE_COUNT_MISMATCH'],
    ];
    for (const [p, rule] of cases) {
      const res = await upload(token, id, { pages: p });
      expect(res.status).toBe(422);
      expect((await errorOf(res)).rule).toBe(rule);
    }
    // Malformed requests: duplicate/gapped page numbers, bad digest, unknown fields.
    const bad: Row[][] = [
      [...pages(1), ...pages(1)],
      pages(1, { pageNumber: 2 }),
      pages(1, { sha256: 'NOT-A-DIGEST' }),
      pages(1, { storagePath: 'x/y' }),
    ];
    for (const p of bad) expect((await upload(token, id, { pages: p })).status).toBe(400);
    const [row] = await api.db.sql<{ status: string; n: number }[]>`
      select a.status, (select count(*)::int from public.source_pages p where p.assignment_id = a.id) as n
        from public.assignments a where a.id = ${id}`;
    expect(row).toEqual({ status: 'draft', n: 0 });
  });

  it('an interrupted upload resumes with the same pages; different pages are refused', async () => {
    const id = await created(riley, { pageCount: 2, idempotencyKey: key() });
    const p = pages(2);
    const first = uploadPagesResponseSchema.parse(
      await json(await upload(riley, id, { pages: p })),
    );
    // Only page 1 reached storage before the connection dropped.
    const [page1] = await api.db.sql<{ storage_path: string }[]>`
      select storage_path from public.source_pages where assignment_id = ${id} and page_number = 1`;
    api.providers.storage.objects.add(page1!.storage_path);
    const resumed = await upload(riley, id, { pages: p });
    expect(resumed.status).toBe(200);
    const again = uploadPagesResponseSchema.parse(await json(resumed));
    expect(again.uploads.map((u) => u.pageId)).toEqual(first.uploads.map((u) => u.pageId));
    expect(again.uploads.map((u) => u.alreadyUploaded)).toEqual([true, false]);
    expect((await upload(riley, id, { pages: pages(2) })).status).toBe(409);
  });

  it('reports storage outages honestly without losing the registered pages', async () => {
    const id = await created(token, {
      childId: fam.children[0]!.id,
      pageCount: 1,
      idempotencyKey: key(),
    });
    const storage = api.providers.storage;
    const original = storage.createSignedUploadUrl.bind(storage);
    storage.createSignedUploadUrl = () => Promise.reject(new Error('storage down'));
    const p = pages(1);
    try {
      const res = await upload(token, id, { pages: p });
      expect(res.status).toBe(503);
      expect((await errorOf(res)).code).toBe('PROVIDER_UNAVAILABLE');
    } finally {
      storage.createSignedUploadUrl = original;
    }
    expect((await upload(token, id, { pages: p })).status).toBe(200);
  });
});

describe('finalize, quota and jobs (AC_CAPTURE_06, AC_SECURITY_06)', () => {
  it('refuses to finalize before every page reached storage, then queues exactly one job', async () => {
    const id = await created(token, {
      childId: fam.children[0]!.id,
      pageCount: 2,
      idempotencyKey: key(),
    });
    expect((await finalize(token, id)).status).toBe(422); // no pages yet (NO_PAGES)
    await upload(token, id, { pages: pages(2) });
    const early = await finalize(token, id);
    expect(early.status).toBe(422);
    expect((await errorOf(early)).rule).toBe('UPLOAD_INCOMPLETE');
    await markUploaded(id);
    const res = await finalize(token, id);
    expect(res.status).toBe(200);
    expect(assignmentStateResponseSchema.parse(await json(res)).assignment.status).toBe('queued');
    const reservations = await api.db.sql<Row[]>`
      select child_id, period_key, units, status from public.usage_reservations
       where family_id = ${fam.familyId} and idempotency_key like ${'%' + id + '%'}`;
    expect(reservations).toEqual([
      { child_id: fam.children[0]!.id, period_key: 'pages:2026-09', units: 2, status: 'reserved' },
    ]);
    const jobs = await api.db.sql<{ kind: string; idempotency_key: string; payload: Row }[]>`
      select kind, idempotency_key, payload from public.jobs where idempotency_key like ${'%' + id + '%'}`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.kind).toBe('scan_process');
    expect(jobs[0]!.idempotency_key).toBe(`scan:${id}:v1`);
    // Payloads hold references only, never homework content.
    expect(Object.keys(jobs[0]!.payload).sort()).toEqual(['assignmentId', 'mode', 'reservationId']);
  });

  it('duplicate and concurrent finalize events create one job and one quota charge', async () => {
    const id = await created(riley, { pageCount: 3, idempotencyKey: key() });
    await upload(riley, id, { pages: pages(3) });
    await markUploaded(id);
    const results = await Promise.all([
      finalize(riley, id),
      finalize(riley, id),
      finalize(riley, id),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const later = await finalize(riley, id);
    expect(later.status).toBe(200);
    expect(assignmentStateResponseSchema.parse(await json(later)).assignment.status).toBe('queued');
    const [counts] = await api.db.sql<{ reservations: number; units: number; jobs: number }[]>`
      select (select count(*)::int from public.usage_reservations where idempotency_key like ${'%' + id + '%'}) as reservations,
             (select coalesce(sum(units), 0)::int from public.usage_reservations where idempotency_key like ${'%' + id + '%'}) as units,
             (select count(*)::int from public.jobs where idempotency_key like ${'%' + id + '%'}) as jobs`;
    expect(counts).toEqual({ reservations: 1, units: 3, jobs: 1 });
  });

  it('counts in-flight reservations toward the per-child allowance and preserves work on refusal', async () => {
    const f = await seedFamily(api.db, { childCount: 1 });
    await consent(f.familyId, f.ownerId);
    await capacity(f.familyId, 1);
    await assignSlots(f);
    await grantAdultUnlock(api.db, f.ownerId, SESSION, 3600);
    const t = await parentToken(f.ownerId, { sessionId: SESSION });
    const childId = f.children[0]!.id;
    // 30 pages committed + 6 in flight + 10 released (released never counts).
    await api.db.sql`
      insert into public.usage_reservations (family_id, child_id, period_key, units, idempotency_key, status, release_reason)
      values (${f.familyId}, ${childId}, 'pages:2026-09', 30, ${'seed:' + key()}, 'committed', null),
             (${f.familyId}, ${childId}, 'pages:2026-09', 6, ${'seed:' + key()}, 'reserved', null),
             (${f.familyId}, ${childId}, 'pages:2026-09', 10, ${'seed:' + key()}, 'released', 'unreadable'),
             (${f.familyId}, ${childId}, 'pages:2026-08', 40, ${'seed:' + key()}, 'committed', null)`;
    // Early, advisory refusal at create when the declared pages cannot fit.
    const early = await create(t, { childId, pageCount: 5, idempotencyKey: key() });
    expect(early.status).toBe(422);
    expect((await errorOf(early)).rule).toBe('QUOTA_EXCEEDED');
    // Authoritative refusal at finalize: another in-flight scan took the space after this one started.
    const id = await created(t, { childId, pageCount: 4, idempotencyKey: key() });
    await upload(t, id, { pages: pages(4) });
    await markUploaded(id);
    await api.db.sql`
      insert into public.usage_reservations (family_id, child_id, period_key, units, idempotency_key)
      values (${f.familyId}, ${childId}, 'pages:2026-09', 1, ${'seed:' + key()})`;
    const refused = await finalize(t, id);
    expect(refused.status).toBe(422);
    expect((await errorOf(refused)).rule).toBe('QUOTA_EXCEEDED');
    const [state] = await api.db.sql<
      { status: string; pages: number; jobs: number; mine: number }[]
    >`
      select a.status,
             (select count(*)::int from public.source_pages p where p.assignment_id = a.id and p.deleted_at is null) as pages,
             (select count(*)::int from public.jobs j where j.idempotency_key like ${'%' + id + '%'}) as jobs,
             (select count(*)::int from public.usage_reservations u where u.idempotency_key like ${'%' + id + '%'}) as mine
        from public.assignments a where a.id = ${id}`;
    expect(state).toEqual({ status: 'uploading', pages: 4, jobs: 0, mine: 0 });
    // The list shows the parent where the allowance stands.
    const list = assignmentListResponseSchema.parse(
      await json(await api.request(`/v1/assignments?childId=${childId}`, { token: t })),
    );
    expect(list.allowance).toEqual({
      periodKey: 'pages:2026-09',
      childPagesUsed: 37,
      childPagesAllowed: 40,
      familyPagesUsed: 37,
      familyPagesAllowed: 40,
      childHasPaidSlot: true,
    });
    // Releasing the in-flight scan (e.g. unreadable) frees the space again.
    await api.db.sql`
      update public.usage_reservations set status = 'released', release_reason = 'unreadable'
       where family_id = ${f.familyId} and status = 'reserved'`;
    expect((await finalize(t, id)).status).toBe(200);
  });

  it('enforces the family ceiling (paid slots × allowance) across children', async () => {
    // Decision (RV-homework-3): a profile without a paid slot cannot scan at all, so the ceiling is
    // exercised the way it bites in practice — a sibling's pages from earlier this month still count
    // after the family moved to one paid slot (spec P11: reassigning profiles must not reset usage).
    const f = await seedFamily(api.db, { childCount: 2 });
    await consent(f.familyId, f.ownerId);
    await capacity(f.familyId, 1);
    await assignSlots(f, [1]); // the one paid slot now belongs to the second child
    const t = await parentToken(f.ownerId);
    const id = await created(t, {
      childId: f.children[1]!.id,
      pageCount: 3,
      idempotencyKey: key(),
    });
    await upload(t, id, { pages: pages(3) });
    await markUploaded(id);
    // The sibling's scan earlier this month used 38 of the family's 40 pages.
    await api.db.sql`
      insert into public.usage_reservations (family_id, child_id, period_key, units, idempotency_key)
      values (${f.familyId}, ${f.children[0]!.id}, 'pages:2026-09', 38, ${'seed:' + key()})`;
    const res = await finalize(t, id);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).rule).toBe('QUOTA_EXCEEDED');
  });

  it('uses the calendar month in the family time zone as the period key', async () => {
    // 03:00 UTC on 1 October is still 30 September in America/Chicago.
    api.now.value = new Date('2026-10-01T03:00:00Z');
    try {
      const id = await queuedScan(token, { childId: fam.children[1]!.id }, 1);
      const [r] = await api.db.sql<{ period_key: string }[]>`
        select period_key from public.usage_reservations where idempotency_key like ${'%' + id + '%'}`;
      expect(r!.period_key).toBe('pages:2026-09');
    } finally {
      api.now.value = START;
    }
  });
});

describe('cancelling a scan', () => {
  it('cancels a queued scan, releases its reservation, cancels its job and removes stored pages', async () => {
    const id = await queuedScan(riley, {}, 2);
    const paths = (
      await api.db.sql<{ storage_path: string }[]>`
        select storage_path from public.source_pages where assignment_id = ${id}`
    ).map((r) => r.storage_path);
    expect(paths.every((p) => api.providers.storage.objects.has(p))).toBe(true);
    const res = await cancel(riley, id);
    expect(res.status).toBe(200);
    expect(assignmentStateResponseSchema.parse(await json(res)).assignment.status).toBe(
      'cancelled',
    );
    const [state] = await api.db.sql<
      { reservation: string; reason: string; job: string; live_pages: number }[]
    >`
      select (select status from public.usage_reservations where idempotency_key like ${'%' + id + '%'}) as reservation,
             (select release_reason from public.usage_reservations where idempotency_key like ${'%' + id + '%'}) as reason,
             (select status from public.jobs where idempotency_key = ${`scan:${id}:v1`}) as job,
             (select count(*)::int from public.source_pages where assignment_id = ${id} and deleted_at is null) as live_pages`;
    expect(state).toEqual({
      reservation: 'released',
      reason: 'cancelled',
      job: 'cancelled',
      live_pages: 0,
    });
    expect(paths.some((p) => api.providers.storage.objects.has(p))).toBe(false);
    // Repeating the cancel is harmless.
    expect((await cancel(riley, id)).status).toBe(200);
  });

  it('a cancel whose storage removal fails keeps the pages live until a retried cancel removes them', async () => {
    const id = await queuedScan(riley, {}, 2);
    const live = async () =>
      (
        await api.db.sql<{ n: number }[]>`
          select count(*)::int as n from public.source_pages
           where assignment_id = ${id} and deleted_at is null`
      )[0]!.n;
    const paths = (
      await api.db.sql<{ storage_path: string }[]>`
        select storage_path from public.source_pages where assignment_id = ${id}`
    ).map((r) => r.storage_path);
    const storage = api.providers.storage;
    const original = storage.remove.bind(storage);
    storage.remove = () => Promise.reject(new Error('storage down'));
    try {
      expect((await cancel(riley, id)).status).toBe(200);
    } finally {
      storage.remove = original;
    }
    // Not marked deleted while the objects still exist, so the retention purge still sees them.
    expect(await live()).toBe(2);
    expect(paths.every((p) => storage.objects.has(p))).toBe(true);
    expect(api.logs.some((e) => e.event === 'homework_storage_remove_failed')).toBe(true);
    // Repeating the cancel retries the removal.
    const again = await cancel(riley, id);
    expect(again.status).toBe(200);
    expect(assignmentStateResponseSchema.parse(await json(again)).assignment.status).toBe(
      'cancelled',
    );
    expect(await live()).toBe(0);
    expect(paths.some((p) => storage.objects.has(p))).toBe(false);
  });

  it('refuses to cancel finished work', async () => {
    const { assignmentId } = await readyScan(fam, token);
    const res = await cancel(token, assignmentId);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).rule).toBe('INVALID_TRANSITION');
  });
});

describe('lists and detail views', () => {
  it('parents list a child’s scans; children list only their own', async () => {
    const mine = await created(riley, { pageCount: 1, idempotencyKey: key() });
    const sams = await created(sam, { pageCount: 1, idempotencyKey: key() });
    const parentList = assignmentListResponseSchema.parse(
      await json(await api.request(`/v1/assignments?childId=${fam.children[0]!.id}`, { token })),
    );
    expect(parentList.assignments.some((a) => a.id === mine)).toBe(true);
    expect(parentList.assignments.some((a) => a.id === sams)).toBe(false);
    expect(parentList.assignments.every((a) => a.childId === fam.children[0]!.id)).toBe(true);
    expect(parentList.allowance?.childPagesAllowed).toBe(40);
    const all = assignmentListResponseSchema.parse(
      await json(await api.request('/v1/assignments', { token })),
    );
    expect(all.allowance).toBeNull();
    expect(all.assignments.some((a) => a.id === sams)).toBe(true);
    const childRes = await api.request('/v1/child/assignments', { token: riley });
    expect(childRes.status).toBe(200);
    const childList = childAssignmentListResponseSchema.parse(await json(childRes));
    expect(childList.assignments.some((a) => a.id === mine)).toBe(true);
    expect(childList.assignments.some((a) => a.id === sams)).toBe(false);
    // Another family's child id in the parent filter reveals nothing.
    const foreign = await api.request(`/v1/assignments?childId=${other.children[0]!.id}`, {
      token,
    });
    expect(foreign.status).toBe(404);
  });

  it('parent detail shows answers, verdicts, route and disagreement but never solutions', async () => {
    const seeded = await readyScan(fam, token);
    const res = await api.request(`/v1/assignments/${seeded.assignmentId}`, { token });
    expect(res.status).toBe(200);
    const raw = await json(res);
    const body = assignmentDetailResponseSchema.parse(raw);
    expect(body.assignment.status).toBe('ready');
    const q1 = body.questions.find((q) => q.id === seeded.questionId)!;
    expect(q1).toMatchObject({
      questionNumber: '1',
      promptText: PROMPT,
      studentAnswerText: STUDENT_ANSWER,
      correctedPromptText: null,
      uncertainty: 'low',
      result: {
        verdict: 'incorrect',
        gradedVerdict: 'incorrect',
        route: 'escalated',
        disagreement: true,
      },
    });
    const text = JSON.stringify(raw);
    for (const secret of [SECRET_ANSWER, SECRET_SOLUTION, SECRET_MISCONCEPTION]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain('"correctAnswer"');
    expect(text).not.toContain('"workedSolution"');
  });

  it('child detail carries only prompt, own answer, verdict and feedback (AC_GRADING_06)', async () => {
    const seeded = await readyScan(fam, token, 0);
    const res = await api.request(`/v1/child/assignments/${seeded.assignmentId}`, { token: riley });
    expect(res.status).toBe(200);
    const raw = await json(res);
    const body = childAssignmentDetailResponseSchema.parse(raw);
    expectNoChildLeak(raw);
    const q1 = body.questions.find((q) => q.id === seeded.questionId)!;
    expect(q1).toEqual({
      id: seeded.questionId,
      questionNumber: '1',
      promptText: PROMPT,
      studentAnswerText: STUDENT_ANSWER,
      verdict: 'incorrect',
      feedback: [
        { id: expect.any(String), kind: 'hint', body: 'Try finding a common denominator first.' },
      ],
    });
    expect(Object.keys(body.assignment).sort()).toEqual(
      ['createdAt', 'id', 'pageCount', 'status', 'subjectId', 'updatedAt'].sort(),
    );
    // Also true of every other child homework response.
    for (const path of ['/v1/child/assignments', '/v1/assignments/limits']) {
      expectNoChildLeak(await json(await api.request(path, { token: riley })));
    }
  });

  it('while a scan is still being checked the child sees no verdicts yet', async () => {
    const seeded = await readyScan(fam, token, 0);
    await advance(seeded.assignmentId, ['checking']);
    const body = childAssignmentDetailResponseSchema.parse(
      await json(
        await api.request(`/v1/child/assignments/${seeded.assignmentId}`, { token: riley }),
      ),
    );
    expect(body.assignment.status).toBe('checking');
    expect(body.questions.every((q) => q.verdict === null)).toBe(true);
  });
});

describe('parent solutions need a server-verified recent step-up (AC_GRADING_05)', () => {
  it('refuses without a step-up and returns solutions with one', async () => {
    const seeded = await readyScan(fam, token);
    const path = `/v1/assignments/${seeded.assignmentId}/solutions`;
    const locked = await api.request(path, { token: lockedToken });
    expect(locked.status).toBe(403);
    expect((await errorOf(locked)).code).toBe('STEP_UP_REQUIRED');
    expect(
      JSON.stringify(await api.request(path, { token: lockedToken }).then(json)),
    ).not.toContain(SECRET_ANSWER);
    const res = await api.request(path, { token });
    expect(res.status).toBe(200);
    const body = assignmentSolutionsResponseSchema.parse(await json(res));
    expect(body.solutions).toEqual([
      {
        questionId: seeded.questionId,
        questionNumber: '1',
        correctAnswer: SECRET_ANSWER,
        workedSolution: SECRET_SOLUTION,
        rubric: { criterion: 'common denominator' },
        misconception: SECRET_MISCONCEPTION,
      },
    ]);
  });

  it('an expired step-up no longer unlocks solutions', async () => {
    const seeded = await readyScan(fam, token);
    const session = randomUUID();
    await grantAdultUnlock(api.db, fam.ownerId, session, 1);
    await api.db.sql`
      update private.adult_unlocks set expires_at = now() - interval '1 second', created_at = now() - interval '10 minutes'
       where auth_session_id = ${session}`;
    const t = await parentToken(fam.ownerId, { sessionId: session });
    const res = await api.request(`/v1/assignments/${seeded.assignmentId}/solutions`, { token: t });
    expect((await errorOf(res)).code).toBe('STEP_UP_REQUIRED');
  });

  it('children and other families never reach solutions', async () => {
    const seeded = await readyScan(fam, token);
    const path = `/v1/assignments/${seeded.assignmentId}/solutions`;
    expect((await api.request(path, { token: riley })).status).toBe(401);
    expect((await api.request(path, { token: otherToken })).status).toBe(404);
  });
});

describe('parent override (AC_GRADING_10)', () => {
  it('needs a step-up and a reason, is audited, updates evidence and never claws back points', async () => {
    const seeded = await readyScan(fam, token, 0);
    const childId = fam.children[0]!.id;
    await api.db.sql`
      insert into public.points_ledger (family_id, child_id, kind, points, idempotency_key, actor_kind)
      values (${fam.familyId}, ${childId}, 'award', 5, ${'attempt:' + randomUUID()}, 'system')`;
    const balance = async () =>
      (
        await api.db.sql<{ balance: number }[]>`
          select balance from public.point_balances where child_id = ${childId}`
      )[0]?.balance ?? 0;
    const before = await balance();
    const path = `/v1/questions/${seeded.questionId}/override`;
    const body = { verdict: 'correct', reason: 'Equivalent fraction written differently' };
    const locked = await api.request(path, { method: 'POST', token: lockedToken, body });
    expect((await errorOf(locked)).code).toBe('STEP_UP_REQUIRED');
    expect(
      (
        await api.request(path, {
          method: 'POST',
          token,
          body: { verdict: 'correct', reason: ' ' },
        })
      ).status,
    ).toBe(400);
    const res = await api.request(path, { method: 'POST', token, body });
    expect(res.status).toBe(200);
    const result = overrideResultResponseSchema.parse(await json(res)).result;
    expect(result).toMatchObject({
      verdict: 'correct',
      gradedVerdict: 'incorrect',
      override: { verdict: 'correct', reason: body.reason },
    });
    const [audit] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where action = 'grading.override' and target_id = ${seeded.questionId}`;
    expect(audit!.n).toBe(1);
    const evidence = await api.db.sql<{ correctness: string; reason: string }[]>`
      select correctness, reason from public.attempt_overrides where attempt_id = ${seeded.attemptId}`;
    expect(evidence).toEqual([{ correctness: 'correct', reason: body.reason }]);
    // Overriding back to incorrect does not remove earned points (no unfair clawback).
    await api.request(path, {
      method: 'POST',
      token,
      body: { verdict: 'incorrect', reason: 'Checked again with the worksheet' },
    });
    expect(await balance()).toBe(before);
    // The child sees the parent's decision, not the stale graded verdict.
    await api.request(path, { method: 'POST', token, body });
    const child = childAssignmentDetailResponseSchema.parse(
      await json(
        await api.request(`/v1/child/assignments/${seeded.assignmentId}`, { token: riley }),
      ),
    );
    expect(child.questions.find((q) => q.id === seeded.questionId)!.verdict).toBe('correct');
  });

  it('a scan waiting for parent review becomes ready only once every open question is settled (RV-homework-5)', async () => {
    const childId = fam.children[1]!.id;
    const assignmentId = await queuedScan(token, { childId }, 1);
    const [page] = await api.db.sql<{ id: string }[]>`
      select id from public.source_pages where assignment_id = ${assignmentId}`;
    const ids: string[] = [];
    for (const [n, verdict] of [
      ['1', 'needs_parent_review'],
      ['2', 'unresolved'],
      ['3', 'correct'],
    ] as const) {
      const [q] = await api.db.sql<{ id: string }[]>`
        insert into public.extracted_questions
          (assignment_id, family_id, child_id, page_id, question_number, prompt_text, student_answer_text,
           answer_kind, subject_key, skill, uncertainty)
        values (${assignmentId}, ${fam.familyId}, ${childId}, ${page!.id}, ${n}, ${'Question ' + n}, '5',
                'numeric', 'math', 'addition', 'low')
        returning id`;
      await api.db.sql`
        insert into public.question_results (question_id, family_id, child_id, verdict, route, disagreement, grader_version)
        values (${q!.id}, ${fam.familyId}, ${childId}, ${verdict},
                ${verdict === 'correct' ? 'deterministic' : 'parent_review'}, ${verdict !== 'correct'}, 'g1')`;
      ids.push(q!.id);
    }
    // Question 3 was corrected after grading and its re-check failed, so its result is stale.
    await api.db.sql`
      update public.question_results set graded_at = now() - interval '10 minutes'
       where question_id = ${ids[2]!}`;
    await api.db.sql`
      update public.extracted_questions set corrected_student_answer_text = '6',
             corrected_at = now() - interval '5 minutes'
       where id = ${ids[2]!}`;
    await advance(assignmentId, ['extracting', 'checking', 'needs_parent_review']);
    await api.db
      .sql`update public.assignments set error_code = 'GRADE_FAILED' where id = ${assignmentId}`;
    const status = async () =>
      assignmentDetailResponseSchema.parse(
        await json(await api.request(`/v1/assignments/${assignmentId}`, { token })),
      ).assignment;
    const override = (id: string, verdict: string) =>
      api.request(`/v1/questions/${id}/override`, {
        method: 'POST',
        token,
        body: { verdict, reason: 'Checked against the worksheet' },
      });

    expect((await override(ids[0]!, 'correct')).status).toBe(200);
    expect((await status()).status).toBe('needs_parent_review'); // question 2 is still undecided
    // A parent may settle a question as unresolved; the scan job's recheck rule counts any override.
    expect((await override(ids[1]!, 'unresolved')).status).toBe(200);
    expect((await status()).status).toBe('needs_parent_review'); // question 3's result is stale
    expect((await override(ids[2]!, 'incorrect')).status).toBe(200);
    expect(await status()).toMatchObject({ status: 'ready', errorCode: null });
    const [audit] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where action = 'homework.review_settled' and target_id = ${assignmentId}`;
    expect(audit!.n).toBe(1);
    // Overriding again on a ready scan changes nothing about its state.
    expect((await override(ids[0]!, 'incorrect')).status).toBe(200);
    expect((await status()).status).toBe('ready');
  });

  it('refuses other families’ questions and child callers', async () => {
    const seeded = await readyScan(fam, token);
    const path = `/v1/questions/${seeded.questionId}/override`;
    const body = { verdict: 'correct', reason: 'Looks right' };
    expect((await api.request(path, { method: 'POST', token: otherToken, body })).status).toBe(404);
    expect((await api.request(path, { method: 'POST', token: riley, body })).status).toBe(401);
  });
});

describe('transcription correction (spec P5)', () => {
  it('keeps the original, records the correction and queues a re-check', async () => {
    const seeded = await readyScan(fam, token);
    const path = `/v1/questions/${seeded.questionId}/correction`;
    const res = await api.request(path, {
      method: 'POST',
      token: lockedToken,
      body: { studentAnswerText: '7/8' },
    });
    expect(res.status).toBe(200);
    const body = correctTranscriptionResponseSchema.parse(await json(res));
    expect(body.assignment.status).toBe('checking');
    expect(body.question).toMatchObject({
      studentAnswerText: STUDENT_ANSWER,
      correctedStudentAnswerText: '7/8',
      correctedPromptText: null,
    });
    const [row] = await api.db.sql<Row[]>`
      select student_answer_text, corrected_student_answer_text, corrected_by, transcription_version
        from public.extracted_questions where id = ${seeded.questionId}`;
    expect(row).toEqual({
      student_answer_text: STUDENT_ANSWER,
      corrected_student_answer_text: '7/8',
      corrected_by: fam.ownerId,
      transcription_version: 2,
    });
    const jobs = await api.db.sql<{ idempotency_key: string; payload: Row }[]>`
      select idempotency_key, payload from public.jobs
       where idempotency_key like ${`scan:${seeded.assignmentId}:%`} order by created_at`;
    expect(jobs.map((j) => j.idempotency_key)).toEqual([
      `scan:${seeded.assignmentId}:v1`,
      `scan:${seeded.assignmentId}:v2`,
    ]);
    expect(jobs[1]!.payload).toEqual({
      assignmentId: seeded.assignmentId,
      mode: 'recheck',
      questionIds: [seeded.questionId],
    });
    // While re-checking, another correction waits (state machine).
    const again = await api.request(path, { method: 'POST', token, body: { promptText: 'x' } });
    expect(again.status).toBe(422);
    expect((await errorOf(again)).rule).toBe('INVALID_TRANSITION');
  });

  it('checks ownership explicitly and refuses children', async () => {
    const seeded = await readyScan(fam, token);
    const path = `/v1/questions/${seeded.questionId}/correction`;
    const body = { promptText: 'What is 3/4 + 1/4?' };
    expect((await api.request(path, { method: 'POST', token: otherToken, body })).status).toBe(404);
    expect((await api.request(path, { method: 'POST', token: riley, body })).status).toBe(401);
    expect((await api.request(path, { method: 'POST', token, body: {} })).status).toBe(400);
    const [row] = await api.db.sql<{ corrected_prompt_text: string | null }[]>`
      select corrected_prompt_text from public.extracted_questions where id = ${seeded.questionId}`;
    expect(row!.corrected_prompt_text).toBeNull();
  });
});

describe('sibling and cross-family isolation (AC_ACCESS_05)', () => {
  it('a child cannot read or act on a sibling’s or another family’s scan by swapping ids', async () => {
    const samScan = await readyScan(fam, token, 1);
    const samDraft = await created(sam, { pageCount: 1, idempotencyKey: key() });
    const foreign = await readyScan(other, otherToken, 0);
    for (const id of [samScan.assignmentId, foreign.assignmentId]) {
      expect((await api.request(`/v1/child/assignments/${id}`, { token: riley })).status).toBe(404);
      expect((await cancel(riley, id)).status).toBe(404);
      expect((await finalize(riley, id)).status).toBe(404);
    }
    expect((await upload(riley, samDraft, { pages: pages(1) })).status).toBe(404);
    expect((await cancel(otherChild, samDraft)).status).toBe(404);
    const [state] = await api.db.sql<{ status: string }[]>`
      select status from public.assignments where id = ${samDraft}`;
    expect(state!.status).toBe('draft');
    // Parents of other families fare no better.
    expect(
      (await api.request(`/v1/assignments/${samScan.assignmentId}`, { token: otherToken })).status,
    ).toBe(404);
    expect((await cancel(otherToken, samDraft)).status).toBe(404);
    // Non-UUID ids are simply not found.
    expect((await api.request('/v1/child/assignments/not-a-uuid', { token: riley })).status).toBe(
      404,
    );
  });

  it('child tokens cannot reach parent-only homework routes', async () => {
    expect((await api.request('/v1/assignments', { token: riley })).status).toBe(401);
    const seeded = await readyScan(fam, token);
    expect(
      (await api.request(`/v1/assignments/${seeded.assignmentId}`, { token: riley })).status,
    ).toBe(401);
  });

  it('logs never contain homework text, answers or tokens', () => {
    const text = JSON.stringify(api.logs);
    for (const s of [SECRET_ANSWER, SECRET_SOLUTION, PROMPT, STUDENT_ANSWER, 'Bearer']) {
      expect(text).not.toContain(s);
    }
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });
});

describe('Supabase Storage adapter request shapes (fake fetch; untested against a live service)', () => {
  interface Seen {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  }
  function fakeFetch(respond: (seen: Seen) => Response) {
    const seen: Seen[] = [];
    const impl = (input: RequestInfo | URL, init?: RequestInit) => {
      const s: Seen = {
        url: input instanceof URL ? input.href : typeof input === 'string' ? input : input.url,
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      seen.push(s);
      return Promise.resolve(respond(s));
    };
    return { seen, impl: impl };
  }
  const SERVICE_KEY = 'test-service-role-key-not-real-0000';
  const at = new Date('2026-09-24T15:00:00Z');

  it('signs uploads and reads, checks existence and removes objects', async () => {
    const { createSupabaseStorage } = await import('../src/providers/supabase-storage.ts');
    const { seen, impl } = fakeFetch((s) => {
      if (s.url.includes('/object/upload/sign/')) {
        return Response.json({ url: '/object/upload/sign/homework/f/c/a/p.jpg?token=abc' });
      }
      if (s.url.includes('/object/sign/')) {
        return Response.json({ signedURL: '/object/sign/homework/f/c/a/p.jpg?token=def' });
      }
      if (s.method === 'HEAD')
        return new Response(null, { status: s.url.endsWith('missing.jpg') ? 400 : 200 });
      return Response.json([]);
    });
    const storage = createSupabaseStorage({
      supabaseUrl: 'https://project.supabase.co',
      serviceRoleKey: SERVICE_KEY,
      fetchImpl: impl,
      clock: () => at,
    });
    expect(storage.isMock).toBe(false);
    const upload = await storage.createSignedUploadUrl('f/c/a/p.jpg', 900);
    expect(upload.url).toBe(
      'https://project.supabase.co/storage/v1/object/upload/sign/homework/f/c/a/p.jpg?token=abc',
    );
    // Supabase fixes upload URL lifetime at two hours; the adapter reports the real expiry.
    expect(upload.expiresAt.toISOString()).toBe('2026-09-24T17:00:00.000Z');
    const read = await storage.createSignedReadUrl('f/c/a/p.jpg', 60);
    expect(read.url).toBe(
      'https://project.supabase.co/storage/v1/object/sign/homework/f/c/a/p.jpg?token=def',
    );
    expect(read.expiresAt.toISOString()).toBe('2026-09-24T15:01:00.000Z');
    expect(await storage.exists('f/c/a/p.jpg')).toBe(true);
    expect(await storage.exists('f/c/a/missing.jpg')).toBe(false);
    await storage.remove(['f/c/a/p.jpg']);
    expect(
      seen.map((s) => `${s.method} ${s.url.replace('https://project.supabase.co', '')}`),
    ).toEqual([
      'POST /storage/v1/object/upload/sign/homework/f/c/a/p.jpg',
      'POST /storage/v1/object/sign/homework/f/c/a/p.jpg',
      'HEAD /storage/v1/object/homework/f/c/a/p.jpg',
      'HEAD /storage/v1/object/homework/f/c/a/missing.jpg',
      'DELETE /storage/v1/object/homework',
    ]);
    expect(seen[0]!.headers).toMatchObject({
      authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
      'x-upsert': 'false',
    });
    expect(seen[1]!.body).toEqual({ expiresIn: 60 });
    expect(seen[4]!.body).toEqual({ prefixes: ['f/c/a/p.jpg'] });
  });

  it('refuses traversal paths, insecure URLs and surfaces failures by status only', async () => {
    const { createSupabaseStorage, StorageRequestError } =
      await import('../src/providers/supabase-storage.ts');
    const { impl } = fakeFetch(
      () => new Response('{"message":"f/c/a/p.jpg exploded"}', { status: 500 }),
    );
    expect(() =>
      createSupabaseStorage({
        supabaseUrl: 'http://project.supabase.co',
        serviceRoleKey: SERVICE_KEY,
      }),
    ).toThrow(/https/);
    const storage = createSupabaseStorage({
      supabaseUrl: 'https://project.supabase.co',
      serviceRoleKey: SERVICE_KEY,
      fetchImpl: impl,
    });
    await expect(storage.exists('f/../other-family/x.jpg')).rejects.toThrow(
      /Invalid storage object path/,
    );
    const failure = await storage
      .createSignedUploadUrl('f/c/a/p.jpg', 900)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(StorageRequestError);
    expect((failure as Error).message).not.toContain('exploded');
    await expect(storage.exists('f/c/a/p.jpg')).rejects.toThrow(/HTTP 500/);
  });
});

describe('configurable limits (spec P5)', () => {
  it('uses configured limits, which may only tighten the database ceilings', async () => {
    const { Hono } = await import('hono');
    const { homeworkRoutes } = await import('../src/routes/homework.ts');
    const { ApiError } = await import('../src/errors.ts');
    const { createParentVerifier } = await import('../src/auth/parent.ts');
    const { createDbRateLimiter } = await import('../src/middleware/rate-limit.ts');
    const { cryptoRandom } = await import('@pencillift/domain');
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('deps', {
        config: api.config,
        db: api.apiDb,
        clock: () => api.now.value,
        random: cryptoRandom,
        verifyParentToken: createParentVerifier(api.config),
        rateLimiter: createDbRateLimiter(api.apiDb),
        providers: api.providers,
        log: () => undefined,
      });
      c.set('requestId', 'test');
      await next();
    });
    app.onError((error, c) =>
      error instanceof ApiError
        ? c.json({ error: { code: error.code, rule: error.rule ?? null } }, error.status as 400)
        : c.json({ error: { code: 'INTERNAL', rule: null } }, 500),
    );
    app.route(
      '/v1',
      homeworkRoutes({
        limits: { maxPages: 99, maxPageBytes: 1024, allowedMimeTypes: ['image/png'] },
      }),
    );
    const call = (path: string, method = 'GET', body?: unknown) =>
      app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const limits = uploadLimitsResponseSchema.parse(
      await json(await call('/v1/assignments/limits')),
    );
    expect(limits.limits).toEqual({
      maxPages: 50,
      maxPageBytes: 1024,
      allowedMimeTypes: ['image/png'],
    });
    const createdRes = await call('/v1/assignments', 'POST', {
      childId: fam.children[1]!.id,
      pageCount: 1,
      idempotencyKey: key(),
    });
    expect(createdRes.status).toBe(201);
    const id = assignmentStateResponseSchema.parse(await json(createdRes)).assignment.id;
    const jpeg = await call(`/v1/assignments/${id}/uploads`, 'POST', { pages: pages(1) });
    expect((await json<{ error: { rule: string } }>(jpeg)).error.rule).toBe(
      'UNSUPPORTED_FILE_TYPE',
    );
    const big = await call(`/v1/assignments/${id}/uploads`, 'POST', {
      pages: pages(1, { mimeType: 'image/png', byteSize: 1025 }),
    });
    expect((await json<{ error: { rule: string } }>(big)).error.rule).toBe('PAGE_TOO_LARGE');
    const ok = await call(`/v1/assignments/${id}/uploads`, 'POST', {
      pages: pages(1, { mimeType: 'image/png', byteSize: 1024 }),
    });
    expect(ok.status).toBe(200);
  });
});
