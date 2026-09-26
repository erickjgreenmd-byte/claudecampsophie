import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMockModerationClient,
  createMockResponsesClient,
  type ModerationClient,
  type ModerationResult,
  type ResponsesClient,
  type ResponsesRequest,
  type ResponsesResult,
} from '@pencillift/ai';
import { safetyReportsResponseSchema } from '@pencillift/contracts';
import { cryptoRandom } from '@pencillift/domain';
import {
  grantAdultUnlock,
  seedFamily,
  seedOwnerAdmin,
  type SeededFamily,
} from '@pencillift/db/testing/fixtures';
import { runJobs, type JobDeps, type JobHandler } from '../src/jobs/dispatcher.ts';
import { createScanProcessHandler } from '../src/jobs/scan-process.ts';
import { UNRESOLVED_REPORTS_PAGE_SIZE } from '../src/routes/privacy.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * Round-2 hardening of the safety-flag and consent paths (CS-R2-01, CS-R2-03, CS-R2-04 =
 * JOBS-R2-03, CS-R2-07). Real local Postgres; the AI and moderation providers are LABELED MOCKS
 * (no key exists and nothing here calls the network). Synthetic worksheet content and children
 * ("Riley" from the seed fixture) only. Every fixture instant derives from the pinned request
 * clock (L-027).
 *
 * The four defects, each reproduced before its fix:
 *  - CS-R2-01 a false-match clearance built its next scan job key from a COUNT of kept
 *    `scan:<id>:v%` rows, so once job retention pruned v1 while v2 was kept the insert collided
 *    (409, whole clearance rolled back). The key now follows the HIGHEST kept version (L-033).
 *  - CS-R2-03 a provider moderation flag on the child's own answer with no mapped category (no
 *    category at all, a category added after this code, or harassment/hate/illicit) read as
 *    level 'none': the answer was graded and coached and the parent was never told.
 *  - CS-R2-04 / JOBS-R2-03 consent withdrawal cancelled queued scan jobs and left their scans in
 *    'queued' or 'checking' for good (no correction, no cancel, results hidden, allowance held).
 *  - CS-R2-07 the family's report list was hard-capped at the newest 100 rows, so an older
 *    unresolved flag dropped off and could no longer be acted on.
 */

let api: TestApi;
let deps: JobDeps;

beforeAll(async () => {
  api = await createTestApi();
  deps = {
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

beforeEach(() => {
  api.logs.length = 0;
});

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// Scripted mock model (same envelope and stages as safety-screening.test.ts)
// ---------------------------------------------------------------------------------------------

interface ScriptedQuestion {
  number: string;
  prompt: string;
  answer: string;
  kind: string;
  subject: string;
  key: string;
}

const MATH: ScriptedQuestion = {
  number: '1',
  prompt: '12 × 7 =',
  answer: '72',
  kind: 'numeric',
  subject: 'math',
  key: '84',
};
/** A word match on homework hyperbole: the flag a guardian may call a false alarm. */
const FALSE_MATCH: ScriptedQuestion = {
  number: '2',
  prompt: 'Write one sentence about your homework tonight.',
  answer: 'please kill me now, this homework is so long',
  kind: 'open_response',
  subject: 'grammar_writing',
  key: 'A complete sentence about homework.',
};
/**
 * Words the word-list screen does not flag: the provider's answer for them is scripted per test,
 * so every provider flag below is stated in its fixture.
 */
const PROVIDER_ONLY_ANSWER = 'My weekend was quiet and I stayed in bed all day.';
const PROVIDER_ONLY: ScriptedQuestion = {
  number: '3',
  prompt: 'Write one sentence about your weekend.',
  answer: PROVIDER_ONLY_ANSWER,
  kind: 'open_response',
  subject: 'grammar_writing',
  key: 'A complete sentence about the weekend.',
};

function envelope(request: ResponsesRequest): { data: Record<string, unknown> } {
  const part = request.input.find((p) => p.type === 'input_text');
  if (!part || part.type !== 'input_text') throw new Error('no data envelope');
  return JSON.parse(part.text.replace(/^DATA:\n/, '')) as { data: Record<string, unknown> };
}

function ok(value: unknown, modelId = 'gpt-5.6-terra'): ResponsesResult {
  return {
    kind: 'ok',
    text: JSON.stringify(value),
    usage: { inputTokens: 1200, cachedInputTokens: 0, outputTokens: 300 },
    modelId,
    latencyMs: 25,
  };
}

function scriptedModel(questions: ScriptedQuestion[]): ResponsesClient & {
  requests: ResponsesRequest[];
} {
  const byPrompt = new Map(questions.map((q) => [q.prompt, q]));
  return createMockResponsesClient((request) => {
    const data = envelope(request).data;
    switch (request.outputName) {
      case 'homework_extraction':
        return ok({
          pages: (data.pageNumbers as number[]).map((n) => ({
            pageNumber: n,
            readable: true,
            issues: [],
          })),
          questions: questions.map((q) => ({
            pageNumber: 1,
            questionNumber: q.number,
            boundingBox: null,
            promptText: q.prompt,
            studentAnswerText: q.answer,
            answerKind: q.kind,
            subject: q.subject,
            skill: 'synthetic skill',
            gradeEstimate: 3,
            uncertainty: 'low',
          })),
        });
      case 'private_grading':
        return ok({
          results: (data.questions as { questionNumber: string; prompt: string }[]).map((q) => ({
            questionNumber: q.questionNumber,
            verdict: 'incorrect',
            correctAnswer: byPrompt.get(q.prompt)!.key,
            workedSolution: `Worked solution for ${q.questionNumber}`,
            misconception: 'a slip',
            rubric: null,
            evidence: 'student work visible',
            confidence: 'high',
          })),
        });
      case 'independent_verification':
        return ok({
          results: (data.questions as { questionNumber: string }[]).map((q) => ({
            questionNumber: q.questionNumber,
            agrees: true,
            verdict: 'incorrect',
            reason: 'checked independently',
            confidence: 'high',
          })),
        });
      case 'child_coaching_packet':
        return ok(
          {
            steps: [
              { kind: 'concept', text: 'Let’s look at this one together.' },
              { kind: 'hint', text: 'Read the question again and check each step slowly.' },
            ],
            retryPrompt: 'Give it another try.',
          },
          'gpt-6-astra',
        );
      default:
        throw new Error(`unexpected stage ${request.outputName}`);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/** A verified consent record from the labeled mock provider (the only kind tests may use). */
async function testConsent(fam: SeededFamily) {
  await api.db.sql`
    insert into public.consent_records
      (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
    values (${fam.familyId}, ${fam.ownerId}, 'mock', 'mock', 'child_learning_data', 'v1', 'verified',
            true, ${api.now.value})`;
}

function syntheticJpeg(): Uint8Array {
  const seg = (marker: number, payload: number[]) => [
    0xff,
    marker,
    0,
    payload.length + 2,
    ...payload,
  ];
  const text = (t: string) => Array.from(t, (ch) => ch.charCodeAt(0));
  return new Uint8Array([
    0xff,
    0xd8,
    ...seg(0xe0, text('JFIF\0')),
    ...seg(0xdb, [0, ...new Array<number>(64).fill(1)]),
    ...seg(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
    ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
    0x12,
    0x34,
    0xff,
    0xd9,
  ]);
}

function handlers(
  ai: ResponsesClient,
  moderation: ModerationClient = createMockModerationClient(),
): Record<string, JobHandler> {
  return {
    scan_process: createScanProcessHandler({
      ai,
      moderation,
      readObject: () => Promise.resolve(syntheticJpeg()),
      sleep: () => Promise.resolve(),
    }),
  };
}

interface Scan {
  fam: SeededFamily;
  assignmentId: string;
}

/** A finalized scan of one synthetic page, with its initial `scan:<id>:v1` job due now. */
async function queuedScan(fam: SeededFamily): Promise<Scan> {
  const childId = fam.children[0]!.id;
  const [a] = await api.db.sql<{ id: string }[]>`
    insert into public.assignments (family_id, child_id, idempotency_key, created_by_kind, page_count, status)
    values (${fam.familyId}, ${childId}, ${'scan-' + randomUUID()}, 'child', 1, 'queued') returning id`;
  const pageId = randomUUID();
  await api.db.sql`
    insert into public.source_pages (id, assignment_id, family_id, child_id, page_number, storage_path, mime_type, byte_size, sha256)
    values (${pageId}, ${a!.id}, ${fam.familyId}, ${childId}, 1, ${`${fam.familyId}/${childId}/${a!.id}/${pageId}.jpg`},
            'image/jpeg', ${syntheticJpeg().length},
            ${createHash('sha256').update(syntheticJpeg()).digest('hex')})`;
  await api.db.sql`
    insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, max_attempts, run_after)
    values ('scan_process', ${`scan:${a!.id}:v1`}, ${fam.familyId}, ${childId},
            ${JSON.stringify({ assignmentId: a!.id, mode: 'initial' })}::text::jsonb, 5,
            ${new Date(api.now.value.getTime() - 1000)})`;
  return { fam, assignmentId: a!.id };
}

/** A paid slot for the family's child, exactly as POST /v1/children/:id/activate creates one. */
async function paidSlot(fam: SeededFamily) {
  await api.db.sql`
    insert into public.family_capacity (family_id, paid_slots, managing_channel)
    values (${fam.familyId}, 1, 'app_store')
    on conflict (family_id) do update set paid_slots = excluded.paid_slots`;
  await api.db.sql`
    insert into public.child_slot_assignments (family_id, child_id)
    values (${fam.familyId}, ${fam.children[0]!.id})`;
}

/** A scanned family whose question `flagged` carries the system flag (the scan job ran). */
async function flaggedFamily(questions: ScriptedQuestion[], flagged: ScriptedQuestion) {
  const fam = await seedFamily(api.db, { childCount: 1 });
  await testConsent(fam);
  const scan = await queuedScan(fam);
  const client = scriptedModel(questions);
  // At least this scan's job; an earlier test's re-check may also be due, and the scripted model
  // answers for the same prompts, so the count is not pinned here.
  const run = await runJobs(deps, handlers(client));
  expect(run.succeeded).toBeGreaterThanOrEqual(1);
  expect(run.deadLettered).toBe(0);
  const [q] = await api.db.sql<{ id: string }[]>`
    select id from public.extracted_questions
     where assignment_id = ${scan.assignmentId} and prompt_text = ${flagged.prompt}`;
  const [report] = await api.db.sql<{ id: string }[]>`
    select id from public.safety_reports where question_id = ${q!.id} and reporter_kind = 'system'`;
  return { fam, scan, client, questionId: q!.id, reportId: report!.id };
}

/** A parent token with a recent PIN unlock. */
async function unlockedParent(userId: string): Promise<string> {
  const session = randomUUID();
  await grantAdultUnlock(api.db, userId, session, 3600);
  return parentToken(userId, { sessionId: session });
}

async function scanJobs(assignmentId: string) {
  return api.db.sql<{ key: string; status: string; last_error_code: string | null }[]>`
    select idempotency_key as key, status, last_error_code from public.jobs
     where idempotency_key like ${`scan:${assignmentId}:v%`} order by idempotency_key`;
}

async function assignmentRow(assignmentId: string) {
  const [row] = await api.db.sql<{ status: string; error_code: string | null }[]>`
    select status, error_code from public.assignments where id = ${assignmentId}`;
  return row!;
}

async function reportRow(reportId: string) {
  const [row] = await api.db.sql<{ status: string; resolution: string | null }[]>`
    select status, resolution from public.safety_reports where id = ${reportId}`;
  return row!;
}

/**
 * Ages `scan:<id>:v1` past the job-retention horizon, adds a kept `scan:<id>:v2` from ten days ago
 * (an earlier parent correction's recheck) and prunes. Triggers are off for the aging writes only,
 * as job-retention.review.test.ts does: app.guard_job stamps updated_at on every write.
 */
async function pruneV1KeepV2(scan: Scan): Promise<string[]> {
  const old = new Date(api.now.value.getTime() - 100 * DAY_MS);
  const recent = new Date(api.now.value.getTime() - 10 * DAY_MS);
  await api.db.sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`
      update public.jobs set updated_at = ${old}
       where idempotency_key = ${`scan:${scan.assignmentId}:v1`}`;
    await tx`
      insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, status, max_attempts,
                               run_after, created_at, updated_at)
      values ('scan_process', ${`scan:${scan.assignmentId}:v2`}, ${scan.fam.familyId},
              ${scan.fam.children[0]!.id},
              ${JSON.stringify({ assignmentId: scan.assignmentId, mode: 'recheck', questionIds: [] })}::text::jsonb,
              'succeeded', 5, ${recent}, ${recent}, ${recent})`;
  });
  await api.db.sql`select app.prune_terminal_jobs(interval '90 days')`;
  return (await scanJobs(scan.assignmentId)).map((r) => r.key);
}

// ---------------------------------------------------------------------------------------------
// CS-R2-01: the clearance's next scan version follows the highest KEPT version (L-033)
// ---------------------------------------------------------------------------------------------

describe('CS-R2-01 false-match clearing after job retention pruned an earlier scan job', () => {
  it('the guardian clears the flag when scan:<id>:v1 was pruned and v2 is kept', async () => {
    const { fam, scan, reportId } = await flaggedFamily([FALSE_MATCH, MATH], FALSE_MATCH);
    expect(await pruneV1KeepV2(scan)).toEqual([`scan:${scan.assignmentId}:v2`]);

    const parent = await unlockedParent(fam.ownerId);
    const res = await api.request(`/v1/safety-reports/${reportId}`, {
      method: 'PATCH',
      token: parent,
      body: { outcome: 'false_match' },
    });
    // Before the fix: 409 CONFLICT "This was already done" (the count of kept rows was 1, so the
    // insert re-derived the key v2 that the kept row still holds) and the whole clearance rolled
    // back — the report stayed escalated and nothing was re-checked.
    expect(res.status).toBe(200);
    expect(await reportRow(reportId)).toEqual({ status: 'resolved', resolution: 'false_match' });
    expect(await assignmentRow(scan.assignmentId)).toMatchObject({ status: 'checking' });
    const jobs = await scanJobs(scan.assignmentId);
    expect(jobs.map((j) => [j.key, j.status])).toEqual([
      [`scan:${scan.assignmentId}:v2`, 'succeeded'],
      [`scan:${scan.assignmentId}:v3`, 'queued'],
    ]);
  });

  it('the owner’s reviewer clears the flag in the same state', async () => {
    const { scan, reportId } = await flaggedFamily([FALSE_MATCH, MATH], FALSE_MATCH);
    expect(await pruneV1KeepV2(scan)).toEqual([`scan:${scan.assignmentId}:v2`]);

    const aal2 = await parentToken(await seedOwnerAdmin(api.db), { aal: 'aal2' });
    const res = await api.request(`/v1/admin/safety-reports/${reportId}`, {
      method: 'PATCH',
      token: aal2,
      body: {
        status: 'resolved',
        resolutionNote: 'SYNTHETIC: false match (homework hyperbole).',
        resolution: 'false_match',
      },
    });
    expect(res.status).toBe(200);
    expect(await json<{ recheck: string }>(res)).toMatchObject({ recheck: 'queued' });
    expect(await reportRow(reportId)).toEqual({ status: 'resolved', resolution: 'false_match' });
    expect((await scanJobs(scan.assignmentId)).map((j) => j.key)).toEqual([
      `scan:${scan.assignmentId}:v2`,
      `scan:${scan.assignmentId}:v3`,
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// CS-R2-03: a provider flag with no mapped category on the child's own words fails closed
// ---------------------------------------------------------------------------------------------

/** The moderation mock's answer for the first call (the child's answers) of one scan. */
function flagAnswers(
  categories: readonly string[],
): (inputs: readonly string[]) => ModerationResult {
  return (inputs) => ({
    kind: 'ok',
    results: inputs.map((text) =>
      text === PROVIDER_ONLY_ANSWER
        ? { flagged: true, categories: [...categories], maxScore: 0.91 }
        : { flagged: false, categories: [], maxScore: 0.01 },
    ),
    modelId: 'mock-moderation',
    latencyMs: 1,
  });
}

describe('CS-R2-03 a provider flag with no mapped category still reaches the parent', () => {
  /**
   * Owner/lead decision (2026-09-25, recall first): on the CHILD'S OWN input a provider result that
   * is flagged but maps to no PencilLift category — no category at all, a category added after this
   * code, or harassment/hate/illicit — is treated as severe with the fallback category, so the
   * child gets the calm safety template and the parent gets a flag. Before the fix every case below
   * read as level 'none': the answer was graded, verified and coached, the parent was never told,
   * and the only trace was a warn log.
   */
  for (const [label, categories] of [
    ['flagged with no category at all', []],
    ['a category added after this code', ['self-harm/new-subcategory']],
    ['harassment on its own', ['harassment']],
    ['hate on its own', ['hate']],
    ['illicit on its own', ['illicit']],
  ] as const) {
    it(`${label}: the child gets the safety template, the parent a flag, and nothing is graded`, async () => {
      const fam = await seedFamily(api.db, { childCount: 1 });
      await testConsent(fam);
      const scan = await queuedScan(fam);
      const ai = scriptedModel([MATH, PROVIDER_ONLY]);
      const moderation = createMockModerationClient();
      moderation.scripted.push(flagAnswers(categories));
      expect((await runJobs(deps, handlers(ai, moderation))).succeeded).toBe(1);

      const [flagged] = await api.db.sql<{ id: string }[]>`
        select id from public.extracted_questions
         where assignment_id = ${scan.assignmentId} and prompt_text = ${PROVIDER_ONLY.prompt}`;
      const reports = await api.db.sql<{ screen_categories: string[]; status: string }[]>`
        select screen_categories, status from public.safety_reports
         where question_id = ${flagged!.id} and reporter_kind = 'system'`;
      expect(reports).toHaveLength(1);
      expect(reports[0]!.status).toBe('escalated');
      // The fallback category (moderation.ts PROVIDER_FALLBACK_CATEGORY), which on a child's own
      // words adds abuse like every other violence-type provider flag.
      expect(reports[0]!.screen_categories).toEqual(['abuse', 'violence']);

      // The child sees the reviewed safety template and no AI hint for that question. The template
      // is the calm one: a grown-up to talk to and the Childhelp line, no anger message (abuse takes
      // precedence) and no 988 line, which would imply a concern the provider did not report.
      const feedback = await api.db.sql<{ kind: string; body: string }[]>`
        select kind, body from public.child_feedback where question_id = ${flagged!.id}`;
      expect(feedback.map((f) => f.kind)).toEqual(['safety']);
      expect(feedback[0]!.body).toContain('1-800-422-4453');
      expect(feedback[0]!.body).not.toContain('988');
      expect(feedback[0]!.body).not.toContain('angry');

      // The flagged answer never reached the model, and the parent's email is queued.
      const carried = ai.requests.filter((r) =>
        JSON.stringify(r.input).includes(PROVIDER_ONLY_ANSWER),
      );
      expect(carried).toEqual([]);
      const [email] = await api.db.sql<{ n: number }[]>`
        select count(*)::int as n from public.jobs
         where family_id = ${fam.familyId} and kind = 'safety_flag_email'`;
      expect(email!.n).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// CS-R2-04 = JOBS-R2-03: consent withdrawal settles the scans whose jobs it cancels
// ---------------------------------------------------------------------------------------------

describe('CS-R2-04 consent withdrawal leaves no scan stranded', () => {
  it('a queued recheck returns to needs_parent_review and a queued initial scan fails with CONSENT_REQUIRED', async () => {
    // Scan A: flagged, then cleared as a false alarm — 'checking' with a recheck job queued.
    const { fam, scan, reportId, questionId } = await flaggedFamily(
      [FALSE_MATCH, MATH],
      FALSE_MATCH,
    );
    await paidSlot(fam);
    const before = await assignmentRow(scan.assignmentId);
    expect(before.status).toBe('ready');
    const parent = await unlockedParent(fam.ownerId);
    const cleared = await api.request(`/v1/safety-reports/${reportId}`, {
      method: 'PATCH',
      token: parent,
      body: { outcome: 'false_match' },
    });
    expect(cleared.status).toBe(200);
    expect(await assignmentRow(scan.assignmentId)).toMatchObject({ status: 'checking' });

    // Scan B: a second finalized scan still queued, with its page allowance reserved.
    const childId = fam.children[0]!.id;
    const queued = await queuedScan(fam);
    await api.db.sql`
      insert into public.usage_reservations (family_id, child_id, period_key, units, idempotency_key)
      values (${fam.familyId}, ${childId}, '2026-09', 1, ${`scan-usage:${queued.assignmentId}:v1`})`;

    const withdrawn = await api.request('/v1/consent/withdraw', {
      method: 'POST',
      token: parent,
      body: {},
    });
    expect(withdrawn.status).toBe(200);
    expect(await json<{ cancelledJobs: number }>(withdrawn)).toMatchObject({ cancelledJobs: 2 });

    // Before the fix both scans kept their pre-withdrawal status for good: the recheck sat in
    // 'checking' (no cancel, no correction, results hidden from the child) and scan B sat in
    // 'queued' with its reservation still counting against the month's allowance.
    expect(await assignmentRow(scan.assignmentId)).toEqual({
      status: 'needs_parent_review',
      error_code: 'CONSENT_REQUIRED',
    });
    expect(await assignmentRow(queued.assignmentId)).toEqual({
      status: 'failed_final',
      error_code: 'CONSENT_REQUIRED',
    });
    const [reservation] = await api.db.sql<{ status: string; release_reason: string | null }[]>`
      select status, release_reason from public.usage_reservations
       where idempotency_key = ${`scan-usage:${queued.assignmentId}:v1`}`;
    expect(reservation).toEqual({ status: 'released', release_reason: 'failed_final' });

    // The recheck's own job is cancelled with the withdrawal, and nothing runs later.
    expect((await scanJobs(scan.assignmentId)).map((j) => [j.status, j.last_error_code])).toEqual([
      ['succeeded', null],
      ['cancelled', 'consent_withdrawn'],
    ]);

    // With consent given again the parent can act on the scan once more (it is correctable and its
    // results are visible again), which the stranded 'checking' state made impossible for good.
    await testConsent(fam);
    const parent2 = await unlockedParent(fam.ownerId);
    const correction = await api.request(`/v1/questions/${questionId}/correction`, {
      method: 'POST',
      token: parent2,
      body: { studentAnswerText: 'This homework is really long.' },
    });
    expect(correction.status).toBe(200);
    expect(await assignmentRow(scan.assignmentId)).toMatchObject({ status: 'checking' });
  });
});

// ---------------------------------------------------------------------------------------------
// CS-R2-07: an unresolved flag is never cut off the family's list
// ---------------------------------------------------------------------------------------------

describe('CS-R2-07 the family’s report list never drops an unresolved flag', () => {
  it('lists an older escalated flag behind more than a hundred newer resolved reports', async () => {
    const { fam, reportId } = await flaggedFamily([FALSE_MATCH, MATH], FALSE_MATCH);
    // 120 resolved parent reports, every one NEWER than the flag (the shape a family with frequent
    // reports reaches). Only the count and the order matter, so they are inserted directly; no note
    // is stored. Each timestamp derives from the flag's own row, never from a second clock.
    await api.db.sql`
      insert into public.safety_reports (family_id, reporter_kind, category, status, created_at, resolved_at)
      select ${fam.familyId}, 'parent', 'wrong_or_confusing', 'resolved',
             flag.created_at + (n * interval '1 minute'), flag.created_at + (n * interval '1 minute')
        from generate_series(1, 120) as n,
             (select created_at from public.safety_reports where id = ${reportId}) as flag`;

    const parent = await unlockedParent(fam.ownerId);
    const res = await api.request('/v1/safety-reports', { token: parent });
    expect(res.status).toBe(200);
    const { reports } = safetyReportsResponseSchema.parse(await res.json());
    // Before the fix the list was `order by created_at desc limit 100`, so the flag (the oldest
    // row) was not returned at all and the guardian could no longer act on it.
    expect(reports.map((r) => r.id)).toContain(reportId);
    // Unresolved first, so a flag is never behind a page of resolved rows either.
    expect(reports[0]!.id).toBe(reportId);
    expect(reports[0]).toMatchObject({ status: 'escalated' });
    const patched = await api.request(`/v1/safety-reports/${reportId}`, {
      method: 'PATCH',
      token: parent,
      body: { outcome: 'addressed' },
    });
    expect(patched.status).toBe(200);
  });

  /**
   * Lead follow-up (the acceptance checker's residual on this fix): lifting the cap on the
   * unresolved branch left the response unbounded — nothing resolves a report but a grown-up, a
   * guardian may file 30 an hour, and system flags stay 'escalated'. The bound is on the OLDEST
   * unresolved rows, so it drains: each report acted on makes room for the next, and no report is
   * permanently unreachable the way a newest-first cap made it.
   */
  it('bounds the unresolved rows from the oldest end, so the bound drains', async () => {
    const { fam, reportId } = await flaggedFamily([FALSE_MATCH, MATH], FALSE_MATCH);
    const extra = UNRESOLVED_REPORTS_PAGE_SIZE + 5;
    // `extra` open parent reports, all NEWER than the flag. Timestamps derive from the flag's own
    // row, never from a second clock (L-027).
    await api.db.sql`
      insert into public.safety_reports (family_id, reporter_kind, category, status, created_at)
      select ${fam.familyId}, 'parent', 'wrong_or_confusing', 'open',
             flag.created_at + (n * interval '1 minute')
        from generate_series(1, ${extra}) as n,
             (select created_at from public.safety_reports where id = ${reportId}) as flag`;

    const parent = await unlockedParent(fam.ownerId);
    const first = safetyReportsResponseSchema.parse(
      await (await api.request('/v1/safety-reports', { token: parent })).json(),
    ).reports;
    // Bounded, and the oldest report — the flag a grown-up still has to answer — is in the page.
    expect(first).toHaveLength(UNRESOLVED_REPORTS_PAGE_SIZE);
    expect(first.map((r) => r.id)).toContain(reportId);
    const held = new Set(first.map((r) => r.id));

    // Six of the page resolved (the query is what is under test here, not the action path).
    await api.db.sql`
      update public.safety_reports set status = 'resolved', resolved_at = created_at
       where id = any(${api.db.sql.array(first.slice(0, 6).map((r) => r.id))}::uuid[])`;
    const second = safetyReportsResponseSchema.parse(
      await (await api.request('/v1/safety-reports', { token: parent })).json(),
    ).reports;
    // Still bounded, and six rows that the bound had held back are now in reach.
    const unresolvedNow = second.filter((r) => r.status !== 'resolved');
    expect(unresolvedNow).toHaveLength(UNRESOLVED_REPORTS_PAGE_SIZE - 6 + 6);
    expect(unresolvedNow.filter((r) => !held.has(r.id))).toHaveLength(6);
  });
});
