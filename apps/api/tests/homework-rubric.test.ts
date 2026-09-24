import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHILD_FORBIDDEN_HOMEWORK_KEYS,
  assignmentDetailResponseSchema,
  assignmentSolutionsResponseSchema,
  assignmentStateResponseSchema,
  childAssignmentDetailResponseSchema,
  homeworkRubricSchema,
} from '@pencillift/contracts';
import { grantAdultUnlock, seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * AC_GRADING_03: written work gets rubric feedback, not a right/wrong grade. The rubric reaches the
 * parent through the step-up solutions route (AC_GRADING_05) in the shape the grader stores
 * (packages/ai gradingOutputSchema), and never reaches a child DTO or the parent's no-step-up views.
 * Synthetic family only (Riley).
 */

let api: TestApi;
let fam: SeededFamily;
let token: string; // parent session with a recent step-up
let lockedToken: string; // same parent, a session without a step-up
let riley: string; // Riley's child access token
const SESSION = 'a4a4a4a4-4444-4444-8444-444444444444';
const LOCKED_SESSION = 'b5b5b5b5-5555-4555-8555-555555555555';

// Distinctive private values: any appearance outside the step-up solutions route is a leak.
const RUBRIC = [
  {
    criterion: 'RUBRIC-CRITERION-COMPLETE-SENTENCES',
    met: true,
    note: 'RUBRIC-NOTE-BOTH-COMPLETE',
  },
  { criterion: 'RUBRIC-CRITERION-GIVES-A-REASON', met: false, note: 'RUBRIC-NOTE-ADD-A-REASON' },
];
const PRIVATE_TEXT = RUBRIC.flatMap((r) => [r.criterion, r.note]);

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** Every object key anywhere in a payload (the verdict *value* `rubric` is allowed; the key is not). */
function keysOf(value: unknown): Set<string> {
  const keys = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (typeof v === 'object' && v !== null) {
      for (const [k, inner] of Object.entries(v)) {
        keys.add(k);
        visit(inner);
      }
    }
  };
  visit(value);
  return keys;
}

async function childToken(parent: string): Promise<string> {
  const code = await api.request(`/v1/children/${fam.children[0]!.id}/pairing-code`, {
    method: 'POST',
    token: parent,
  });
  expect(code.status).toBe(201);
  const paired = await api.request('/v1/child/pair', {
    method: 'POST',
    headers: { 'cf-connecting-ip': '203.0.113.77' },
    body: {
      code: (await json<{ code: string }>(code)).code,
      deviceLabel: 'Tablet rubric',
      platform: 'ios',
    },
  });
  expect(paired.status).toBe(201);
  return (await json<{ accessToken: string }>(paired)).accessToken;
}

/**
 * A finished scan with one written answer, standing in for the scan job's output: the writing item
 * is graded `rubric` (never right/wrong) and its private solution carries the grader's rubric.
 */
async function writingScan(): Promise<{ assignmentId: string; questionId: string }> {
  const childId = fam.children[0]!.id;
  const createdRes = await api.request('/v1/assignments', {
    method: 'POST',
    token,
    body: { childId, pageCount: 1, idempotencyKey: randomUUID() },
  });
  expect(createdRes.status).toBe(201);
  const assignmentId = assignmentStateResponseSchema.parse(await json(createdRes)).assignment.id;
  const uploaded = await api.request(`/v1/assignments/${assignmentId}/uploads`, {
    method: 'POST',
    token,
    body: {
      pages: [
        { pageNumber: 1, mimeType: 'image/jpeg', byteSize: 250_000, sha256: sha(randomUUID()) },
      ],
    },
  });
  expect(uploaded.status).toBe(200);
  const stored = await api.db.sql<{ id: string; storage_path: string }[]>`
    select id, storage_path from public.source_pages where assignment_id = ${assignmentId}`;
  for (const r of stored) api.providers.storage.objects.add(r.storage_path);
  const finalized = await api.request(`/v1/assignments/${assignmentId}/finalize`, {
    method: 'POST',
    token,
    body: { idempotencyKey: randomUUID() },
  });
  expect(finalized.status).toBe(200);

  const [q] = await api.db.sql<{ id: string }[]>`
    insert into public.extracted_questions
      (assignment_id, family_id, child_id, page_id, question_number, prompt_text, student_answer_text,
       answer_kind, subject_key, skill, uncertainty)
    values (${assignmentId}, ${fam.familyId}, ${childId}, ${stored[0]!.id}, '1',
            'Write two sentences about your favourite season.',
            'I like autumn. The leaves turn orange.', 'writing', 'writing', 'opinion_writing', 'low')
    returning id`;
  const questionId = q!.id;
  // Same JSON write the scan job uses (L-006: never a bare ::jsonb).
  await api.db.sql`
    insert into private.question_solutions
      (question_id, family_id, correct_answer, worked_solution, rubric, misconception, grader_version)
    values (${questionId}, ${fam.familyId}, '', '', ${JSON.stringify(RUBRIC)}::text::jsonb, null, 'g1')`;
  await api.db.sql`
    insert into public.question_results
      (question_id, family_id, child_id, verdict, route, disagreement, grader_version)
    values (${questionId}, ${fam.familyId}, ${childId}, 'rubric', 'deterministic', false, 'g1')`;
  for (const s of ['extracting', 'checking', 'verifying', 'ready']) {
    await api.db.sql`update public.assignments set status = ${s} where id = ${assignmentId}`;
  }
  return { assignmentId, questionId };
}

beforeAll(async () => {
  api = await createTestApi();
  fam = await seedFamily(api.db, { childCount: 1, timezone: 'America/Chicago' });
  await api.db.sql`
    insert into public.consent_records
      (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider,
       verified_at)
    values (${fam.familyId}, ${fam.ownerId}, 'development_mock', 'development_mock',
            'child_data_processing', 'v1', 'verified', true, now())`;
  await api.db.sql`
    insert into public.family_capacity (family_id, paid_slots, managing_channel)
    values (${fam.familyId}, 1, 'app_store')`;
  await api.db.sql`
    insert into public.child_slot_assignments (family_id, child_id)
    values (${fam.familyId}, ${fam.children[0]!.id})`;
  await grantAdultUnlock(api.db, fam.ownerId, SESSION, 3600);
  token = await parentToken(fam.ownerId, { sessionId: SESSION });
  lockedToken = await parentToken(fam.ownerId, { sessionId: LOCKED_SESSION });
  riley = await childToken(token);
});

afterAll(async () => {
  await api?.close();
});

describe('rubric feedback for written work (AC_GRADING_03, AC_GRADING_05)', () => {
  it('the parent sees each rubric criterion and its feedback after a step-up', async () => {
    const { assignmentId, questionId } = await writingScan();
    const res = await api.request(`/v1/assignments/${assignmentId}/solutions`, { token });
    expect(res.status).toBe(200);
    const body = assignmentSolutionsResponseSchema.parse(await json(res));
    expect(body.solutions).toHaveLength(1);
    const [solution] = body.solutions;
    expect(solution).toMatchObject({ questionId, questionNumber: '1', misconception: null });
    // The DTO keeps `rubric` as JSON; the grader's shape narrows with the shared contract schema.
    expect(homeworkRubricSchema.parse(solution!.rubric)).toEqual(RUBRIC);
  });

  it('without a step-up the parent gets no rubric, and the parent detail never carries one', async () => {
    const { assignmentId } = await writingScan();
    const locked = await api.request(`/v1/assignments/${assignmentId}/solutions`, {
      token: lockedToken,
    });
    expect(locked.status).toBe(403);
    const lockedText = await locked.text();
    for (const secret of PRIVATE_TEXT) expect(lockedText).not.toContain(secret);

    const detailRes = await api.request(`/v1/assignments/${assignmentId}`, { token: lockedToken });
    expect(detailRes.status).toBe(200);
    const detail = assignmentDetailResponseSchema.parse(await json(detailRes));
    expect(detail.questions[0]!.result).toMatchObject({
      verdict: 'rubric',
      gradedVerdict: 'rubric',
    });
    expect(keysOf(detail).has('rubric')).toBe(false);
    const detailText = JSON.stringify(detail);
    for (const secret of PRIVATE_TEXT) expect(detailText).not.toContain(secret);
  });

  it('the child sees a rubric verdict, never the rubric itself', async () => {
    const { assignmentId } = await writingScan();
    const res = await api.request(`/v1/child/assignments/${assignmentId}`, { token: riley });
    expect(res.status).toBe(200);
    const raw = await json(res);
    const body = childAssignmentDetailResponseSchema.parse(raw);
    expect(body.questions[0]!.verdict).toBe('rubric');
    const keys = keysOf(raw);
    for (const k of CHILD_FORBIDDEN_HOMEWORK_KEYS) expect(keys.has(k)).toBe(false);
    const text = JSON.stringify(raw);
    for (const secret of PRIVATE_TEXT) expect(text).not.toContain(secret);
  });
});
