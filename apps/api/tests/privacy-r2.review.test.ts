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
import {
  deletionPurgeHandler,
  runJobs,
  type JobDeps,
  type JobHandler,
} from '../src/jobs/dispatcher.ts';
import { createExportBuildHandler, exportPath } from '../src/jobs/export-build.ts';
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
   * guardian may file 30 an hour, and system flags stay 'escalated'. So the unresolved rows are
   * bounded too.
   *
   * ASSERTIONS CHANGED for CS-R4-01. This test used to require the response to be exactly
   * UNRESOLVED_REPORTS_PAGE_SIZE rows — one page over all unresolved rows, taken from the oldest end
   * — and proved the "it drains" claim by resolving six of those rows with raw SQL, noting that "the
   * query is what is under test here, not the action path". Both were wrong, and the lead wrote both
   * the defect and this too-kind test: the action path is exactly what decides whether the bound
   * drains, and it REFUSES a parent's own report (422 parentActionNotForReport; migration 0790 allows
   * a resolution only on 'system' and 'child' reports). A single oldest-end page therefore let 200
   * open parent reports hide every later flag for good — the failure CS-R2-07 set out to remove,
   * reintroduced from the other end (see the CS-R4-01 case below, where the flag is NEWER than the
   * filler rows). The bound is now per reporter kind, so this test keeps what was true — the response
   * is bounded and the old flag is in it — and proves the drain through the guardian's own action.
   *
   * The filler ROSE from one page + 5 to TWO pages + 5, and the counts with it, when the catch-all
   * branch got its oldest-first second window (B-ABSENCE-CLAIM): the per-kind bound is two pages, so a
   * one-page filler no longer reaches it and would leave nothing here bounded. The assertions stay
   * exact counts against that bound rather than an inequality.
   */
  it('bounds the unresolved rows per reporter kind, and the flag still drains', async () => {
    const { fam, reportId } = await flaggedFamily([FALSE_MATCH, MATH], FALSE_MATCH);
    const extra = 2 * UNRESOLVED_REPORTS_PAGE_SIZE + 5;
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
    // Bounded on the family's own branch: 405 open parent reports, its two pages listed.
    expect(
      first.filter((r) => r.reporterKind === 'parent' && r.status !== 'resolved'),
    ).toHaveLength(2 * UNRESOLVED_REPORTS_PAGE_SIZE);
    // And the oldest report — the flag a grown-up still has to answer — is in the response.
    expect(first.map((r) => r.id)).toContain(reportId);
    expect(first.filter((r) => r.status !== 'resolved')).toHaveLength(
      2 * UNRESOLVED_REPORTS_PAGE_SIZE + 1,
    );

    // The drain, through the product's own path and not raw SQL: the guardian acts on the flag while
    // all 405 of their own reports are still open, and the flag leaves the unresolved set.
    const patched = await api.request(`/v1/safety-reports/${reportId}`, {
      method: 'PATCH',
      token: parent,
      body: { outcome: 'addressed' },
    });
    expect(patched.status).toBe(200);
    const second = safetyReportsResponseSchema.parse(
      await (await api.request('/v1/safety-reports', { token: parent })).json(),
    ).reports;
    expect(second.find((r) => r.id === reportId)).toMatchObject({
      status: 'resolved',
      parentOutcome: 'addressed',
    });
    expect(second.filter((r) => r.status !== 'resolved')).toHaveLength(
      2 * UNRESOLVED_REPORTS_PAGE_SIZE,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Round-4 findings ON the round-3 fixes above (CS-R4-01, CS-R4-02). They live in this file
// because they reproduce through the same scan harness and the same flagged family.
// ---------------------------------------------------------------------------------------------

/**
 * CS-R4-01. The oldest-end bound the lead added to the unresolved branch (UNRESOLVED_REPORTS_PAGE_SIZE,
 * justified above with "the bound drains") does NOT drain for a report the family itself filed: the
 * guardian action path refuses `reporter_kind = 'parent'` (PRIVACY_RULES.parentActionNotForReport)
 * and migration 0790 permits a resolution only on 'system' and 'child' reports. So once 200 open
 * parent reports exist, every LATER system flag and later child report fell outside the single page
 * and was absent from the response — unreachable and unactionable from the portal, the app and the
 * flag email's link, which is the exact failure CS-R2-07 set out to remove, reintroduced from the
 * other end. The bound is now taken PER REPORTER KIND (the lead's decision), so rows the family
 * cannot act on can never consume the room a flag needs.
 */
describe('CS-R4-01 a new flag while the family already filed 200+ reports of its own', () => {
  it('lists a newer flag and a newer child report behind 200+ older open parent reports', async () => {
    const { fam, reportId } = await flaggedFamily([FALSE_MATCH, MATH], FALSE_MATCH);
    // Two pages + 5, so the per-kind bound still bites after the catch-all branch got its
    // oldest-first second window (B-ABSENCE-CLAIM); it was one page + 5 while that branch held one.
    const filler = 2 * UNRESOLVED_REPORTS_PAGE_SIZE + 5;
    // `filler` open parent reports, every one OLDER than the flag — what a guardian reaches in a long
    // day at the 30/hour limit, and what an adult who is the subject of a child's disclosure can
    // pre-fill on purpose. Timestamps derive from the flag's own row, never from a second clock
    // (L-027). No note is stored.
    await api.db.sql`
      insert into public.safety_reports (family_id, reporter_kind, category, status, created_at)
      select ${fam.familyId}, 'parent', 'wrong_or_confusing', 'open',
             flag.created_at - (n * interval '1 minute')
        from generate_series(1, ${filler}) as n,
             (select created_at from public.safety_reports where id = ${reportId}) as flag`;
    // The child's own report, also newer than the filler rows. A guardian may act on this one too.
    const [childReport] = await api.db.sql<{ id: string }[]>`
      insert into public.safety_reports (family_id, child_id, reporter_kind, category, status, created_at)
      select ${fam.familyId}, ${fam.children[0]!.id}, 'child', 'upsetting', 'open',
             flag.created_at - interval '30 seconds'
        from (select created_at from public.safety_reports where id = ${reportId}) as flag
      returning id`;

    const parent = await unlockedParent(fam.ownerId);
    const res = await api.request('/v1/safety-reports', { token: parent });
    expect(res.status).toBe(200);
    const { reports } = safetyReportsResponseSchema.parse(await res.json());
    // Before the fix: the 200 oldest unresolved rows were all parent reports, so neither the flag
    // nor the child's report was in the response at all, and nothing the family could do freed a
    // slot (PATCH on a parent report is 422 parentActionNotForReport).
    expect(reports.map((r) => r.id)).toContain(reportId);
    expect(reports.map((r) => r.id)).toContain(childReport!.id);
    // The flag is still first: unresolved before resolved, newest first inside that.
    expect(reports[0]).toMatchObject({ id: reportId, status: 'escalated' });
    // The family's own pending reports stay bounded on their own branch: two pages, not all 405.
    const pendingParent = reports.filter(
      (r) => r.reporterKind === 'parent' && r.status !== 'resolved',
    );
    expect(pendingParent).toHaveLength(2 * UNRESOLVED_REPORTS_PAGE_SIZE);

    // Drain proved through the product's own path, not raw SQL: the guardian acts on both rows they
    // are meant to act on while all 405 parent reports are still open.
    for (const id of [reportId, childReport!.id]) {
      const patched = await api.request(`/v1/safety-reports/${id}`, {
        method: 'PATCH',
        token: parent,
        body: { outcome: 'addressed' },
      });
      expect(patched.status).toBe(200);
    }
  });
});

/**
 * CS-R4-02. The `childFeedback` rows CS-R2-05 added to the 'family_data' export were selected with
 * no filter on `kind`, so a safety notice's BODY was exported verbatim. That body is
 * childSafetyMessage(categories, ageBand): a self-harm screen adds the 988 line, an abuse-type
 * screen adds the Childhelp line and drops the anger line, so the wording says WHICH KIND of
 * concern was flagged — the one thing the family must never learn (owner decision 2026-09-25),
 * which the same commit's safetyFlags block claimed the export could not say. The export now
 * carries the FACT and instant of a notice and its template version, never its wording.
 */
describe('CS-R4-02 the family_data export and the child’s safety notice', () => {
  it('exports that a notice exists, its instant and its template version, never its wording', async () => {
    const { fam, questionId } = await flaggedFamily([FALSE_MATCH, MATH], FALSE_MATCH);
    const [notice] = await api.db.sql<{ id: string; body: string; guard_version: string }[]>`
      select id, body, guard_version from public.child_feedback
       where question_id = ${questionId} and kind = 'safety'`;
    // The body really is the distinguishing wording (this is what must not travel).
    expect(notice!.body).toMatch(/988|1-800-422-4453/);

    const parent = await unlockedParent(fam.ownerId);
    const requested = await api.request('/v1/exports', {
      method: 'POST',
      token: parent,
      body: { kind: 'family_data' },
    });
    expect(requested.status).toBe(202);
    const uploads = new Map<string, Uint8Array>();
    await runJobs(deps, {
      export_build: createExportBuildHandler({
        upload: (path, bytes) => {
          uploads.set(path, bytes);
          return Promise.resolve();
        },
      }),
    });
    const [row] = await api.db.sql<{ status: string; storage_path: string | null }[]>`
      select status, storage_path from public.data_exports
       where family_id = ${fam.familyId} and kind = 'family_data'`;
    expect(row).toMatchObject({ status: 'ready' });
    const body = new TextDecoder().decode(uploads.get(row!.storage_path!));

    // Before the fix the exported JSON contained the notice body word for word, and safetyFlags'
    // feedback_id named which flag each notice belonged to. This is the assertion that carries the
    // finding.
    expect(body).not.toContain(notice!.body);
    // The distinguishing sentences, matched as whole phrases. A bare `not.toContain('988')` here
    // made this test flaky (it failed about one run in three): the document is full of random v4
    // UUIDs and millisecond timestamps, and any UUID group containing '988' reddened a run with
    // nothing leaked. A phrase with spaces, or a number grouped `1-800-...`, cannot occur in a UUID
    // or an ISO instant, so these match only real wording.
    for (const phrase of ['call or text 988', '1-800-422-4453']) {
      expect(body).not.toContain(phrase);
    }
    // Every column jobs/export-build.ts selects for childFeedback, so the shape here cannot hide one
    // from the sweep below (HUNT5-B-6: `question_id` and `child_id` were missing from this
    // annotation, and that is how they stayed in the searched string).
    const data = JSON.parse(body) as {
      childFeedback: {
        id: string;
        question_id: string | null;
        child_id: string;
        kind: string;
        body: string | null;
        created_at: string;
        safety_template_version: string | null;
      }[];
    };
    const exported = data.childFeedback.find((f) => f.id === notice!.id)!;
    // The fact, the instant and the template version stay: the family can see that PencilLift put a
    // notice on that question and when, which the report list already tells them.
    expect(exported).toMatchObject({
      kind: 'safety',
      body: null,
      safety_template_version: notice!.guard_version,
    });
    expect(typeof exported.created_at).toBe('string');
    // Scoped to the rows that carry the risk: no safety notice in the export has a body at all, and
    // none of them carries the hotline wording, whatever else the document happens to contain.
    const safetyRows = data.childFeedback.filter((f) => f.kind === 'safety');
    expect(safetyRows.length).toBeGreaterThan(0);
    expect(safetyRows.every((f) => f.body === null)).toBe(true);
    // The hotline check searches the three fields that could carry wording, listed rather than
    // rest-spread (HUNT5-B-6). A v4 UUID group or a millisecond timestamp can contain '988' by
    // chance: dropping `id` and `created_at` and searching the REST left `question_id` and `child_id`
    // — two more random UUIDs per row — in the string, so the flake this sweep's comment claimed to
    // have removed was still there at about the same rate. The row-level assertions above are what
    // prove nothing else leaked.
    //
    // Because the sweep is narrow, it has to be told when the export gains a column. HUNT6-B-5: the
    // check that claimed to do that read `Object.keys` of the `wording` literal the test itself
    // builds two lines below, so no production change could redden it and a new column stayed
    // silently outside the searched string. These are the keys of a REAL exported row, minus the four
    // random UUID/instant fields deliberately left out of the string, so a column added to
    // jobs/export-build.ts's childFeedback select appears here and reds this case.
    const searched = Object.keys(safetyRows[0]!).filter(
      (k) => !['id', 'question_id', 'child_id', 'created_at'].includes(k),
    );
    expect(searched).toEqual(['kind', 'body', 'safety_template_version']);
    const wording = safetyRows.map((f) => ({
      kind: f.kind,
      body: f.body,
      safety_template_version: f.safety_template_version,
    }));
    expect(JSON.stringify(wording)).not.toMatch(/988|422-4453/);
    // The coaching feedback CS-R2-05 added is untouched: only the safety notice loses its wording.
    expect(data.childFeedback.some((f) => f.kind !== 'safety' && f.body !== null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Round-5 findings on the round-4 fixes (HUNT5-B-2, HUNT5-B-4, HUNT5-B-5).
// ---------------------------------------------------------------------------------------------

/**
 * HUNT5-B-2, the API half. FL-R4-01's slot release (releaseChildSlot) switches to the service role
 * for one UPDATE inside the caller's transaction, and every statement of it sat inside the try block
 * whose catch maps SQLSTATE 42501 to STEP_UP_REQUIRED "Enter your parent PIN to continue". 42501 from
 * the RPC does mean a missing step-up; 42501 from the release means the deployment's UPDATE grant on
 * public.child_slot_assignments is gone, which no PIN can satisfy — so the parent was asked for a PIN
 * forever and their child's data was never deleted. (The database half is migration 0890 plus
 * supabase/tests/hardening_r5_db.test.ts; the release stays here as idempotent belt-and-braces.)
 */
describe('HUNT5-B-2 a slot-release permission failure is not reported as a missing PIN', () => {
  it('answers an honest server error instead of asking for a PIN no PIN can satisfy', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const child = fam.children[0]!;
    await api.db.sql`
      insert into public.family_capacity (family_id, paid_slots, managing_channel)
      values (${fam.familyId}, 1, 'app_store')`;
    await api.db.sql`
      insert into public.child_slot_assignments (family_id, child_id)
      values (${fam.familyId}, ${child.id})`;
    const parent = await unlockedParent(fam.ownerId);
    // One of the release's failure modes, made reachable: take the service role's UPDATE grant away so
    // its statement raises 42501. Restored in `finally` — the grant is the deployment's. It is not the
    // only one (HUNT6-B-4: its UPDATE can also be a deadlock or lock-timeout victim, and those
    // SQLSTATEs must survive the wrapper — see the HUNT6-B-4 case below).
    await api.db.sql`revoke update on public.child_slot_assignments from service_role`;
    let res: Response;
    try {
      res = await api.request('/v1/deletion', {
        method: 'POST',
        token: parent,
        body: { scope: 'child', childId: child.id },
      });
    } finally {
      await api.db.sql`grant update on public.child_slot_assignments to service_role`;
    }
    const body = await json<{ error?: { code?: string; message?: string } }>(res);
    expect(body.error?.code).not.toBe('STEP_UP_REQUIRED');
    expect(body.error?.message ?? '').not.toContain('PIN');
    // A missing grant is a server fault, and the request still rolls back whole: the release must
    // never land apart from the request, so no deletion row is acknowledged either.
    expect(res.status).toBe(500);
    const [open] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.deletion_requests
       where family_id = ${fam.familyId} and status in ('requested', 'processing')`;
    expect(open!.n).toBe(0);
  });
});

/**
 * HUNT5-B-4. The unresolved CHILD branch was bounded newest-first while the system branch beside it
 * was oldest-first, and the file's own rule for the direction is whether the family can drain the
 * branch: a guardian resolves a child's report through PATCH /safety-reports/:id (only
 * `reporter_kind = 'parent'` is refused, and migration 0790 permits 'addressed' on 'system' and
 * 'child'), nothing else ever closes one, and a child may file 20 an hour. So past 200 open child
 * reports the EARLIEST one — the most likely genuine disclosure — was absent from the family's only
 * list, which is the failure CS-R2-07 removed. The branch is oldest-first now, like the system one.
 */
describe('HUNT5-B-4 a child’s oldest open report is not hidden by newer ones', () => {
  it('lists the child’s earliest open report behind 200+ newer child reports', async () => {
    const { fam, reportId } = await flaggedFamily([FALSE_MATCH, MATH], FALSE_MATCH);
    const childId = fam.children[0]!.id;
    // The child's first report, an hour before the flag. Every instant derives from the flag's own
    // row, never from a second clock (L-027).
    const [earliest] = await api.db.sql<{ id: string }[]>`
      insert into public.safety_reports (family_id, child_id, reporter_kind, category, status, created_at)
      select ${fam.familyId}, ${childId}, 'child', 'upsetting', 'open',
             flag.created_at - interval '1 hour'
        from (select created_at from public.safety_reports where id = ${reportId}) as flag
      returning id`;
    // Then more than a page of NEWER child reports — eleven hours of the 20/hour child limit.
    await api.db.sql`
      insert into public.safety_reports (family_id, child_id, reporter_kind, category, status, created_at)
      select ${fam.familyId}, ${childId}, 'child', 'wrong_or_confusing', 'open',
             flag.created_at - interval '1 hour' + (n * interval '10 seconds')
        from generate_series(1, ${UNRESOLVED_REPORTS_PAGE_SIZE + 5}) as n,
             (select created_at from public.safety_reports where id = ${reportId}) as flag`;

    const parent = await unlockedParent(fam.ownerId);
    const res = await api.request('/v1/safety-reports', { token: parent });
    expect(res.status).toBe(200);
    const { reports } = safetyReportsResponseSchema.parse(await res.json());
    // Before the fix the child branch was `order by created_at desc limit 200`, so the six oldest
    // child reports — including the child's first — were not in the response at all.
    expect(reports.map((r) => r.id)).toContain(earliest!.id);
    // Still bounded on that branch, and the flag on its own branch is untouched. The bound is two
    // pages of that kind since HUNT6-B-1 widened the newest-first window from one row to a page, so
    // the whole open queue is still never returned — 206 open child reports are all listed here
    // because 206 is under that bound, not because the branch is unbounded.
    const pendingChild = reports.filter(
      (r) => r.reporterKind === 'child' && r.status !== 'resolved',
    );
    expect(pendingChild.length).toBeLessThanOrEqual(2 * UNRESOLVED_REPORTS_PAGE_SIZE);
    expect(reports.map((r) => r.id)).toContain(reportId);

    // The drain, through the product's own path: a guardian may act on the child's earliest report.
    const patched = await api.request(`/v1/safety-reports/${earliest!.id}`, {
      method: 'PATCH',
      token: parent,
      body: { outcome: 'addressed' },
    });
    expect(patched.status).toBe(200);
  });
});

/**
 * HUNT5-B-5. The system branch takes the 200 OLDEST unresolved flags, so with 200 already open a
 * flag filed now was row 201 and absent from the response — while its email tells the parent
 * "open Privacy & safety to see the flag and what you can do next: <origin>/app/privacy"
 * (providers/index.ts), the page renders exactly this list, and there is no GET
 * /v1/safety-reports/:id and no per-report deep link. Eventual reachability is not what the email
 * promises. The oldest-first window stays (it drains), and the NEWEST unresolved row of each kind is
 * always in the response as well, so a just-emailed flag is never missing.
 */
describe('HUNT5-B-5 the newest unresolved flag is on the page its email names', () => {
  it('lists a just-filed flag behind a full page of older open flags', async () => {
    const { fam, reportId, questionId } = await flaggedFamily([FALSE_MATCH, MATH], FALSE_MATCH);
    // A full page of system flags OLDER than the real one, shaped to satisfy
    // safety_reports_system_shape (child, question, no note, 'escalated', screen columns) and
    // distinct on safety_reports_system_once's (question_id, transcription_at).
    await api.db.sql`
      insert into public.safety_reports (family_id, child_id, reporter_kind, category, question_id,
                                         status, created_at, transcription_at, screen_version, screen_categories)
      select ${fam.familyId}, ${fam.children[0]!.id}, 'system', 'severe_risk', ${questionId},
             'escalated', flag.created_at - (n * interval '1 minute'),
             flag.transcription_at - (n * interval '1 minute'), flag.screen_version, flag.screen_categories
        from generate_series(1, ${UNRESOLVED_REPORTS_PAGE_SIZE}) as n,
             (select created_at, transcription_at, screen_version, screen_categories
                from public.safety_reports where id = ${reportId}) as flag`;

    const parent = await unlockedParent(fam.ownerId);
    const res = await api.request('/v1/safety-reports', { token: parent });
    expect(res.status).toBe(200);
    const { reports } = safetyReportsResponseSchema.parse(await res.json());
    // Before the fix the 200 oldest flags filled the branch and the newest — the one the email
    // announced — was not in the response at all.
    expect(reports.map((r) => r.id)).toContain(reportId);
    // Bounded still: the drain window plus at most the newest row of that kind.
    const pendingFlags = reports.filter(
      (r) => r.reporterKind === 'system' && r.status !== 'resolved',
    );
    expect(pendingFlags).toHaveLength(UNRESOLVED_REPORTS_PAGE_SIZE + 1);
    // And the oldest flag still leads the drain, so the page a guardian works through is unchanged.
    const oldest = pendingFlags.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
    const patched = await api.request(`/v1/safety-reports/${oldest.id}`, {
      method: 'PATCH',
      token: parent,
      body: { outcome: 'addressed' },
    });
    expect(patched.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Round-6 findings on the round-5 fixes (HUNT6-B-1, HUNT6-B-4, HUNT6-B-5).
// ---------------------------------------------------------------------------------------------

/**
 * HUNT6-B-1. HUNT5-B-5's second window was `order by created_at desc limit 1`, so the response was
 * "the 200 oldest unresolved rows of the kind" UNION "exactly one row". One `safety_flag_email` job
 * is enqueued PER report (jobs/scan-process.ts, inside safetyResponse, which runs once per question),
 * so a single worksheet that flags two answers produces two flags and two emails — and each email
 * says "open Privacy & safety to see the flag and what you can do next: <origin>/app/privacy" with
 * no per-report deep link and no GET /v1/safety-reports/:id to fall back on. Behind a full window the
 * one-row branch returned only the LATER of the two, so a guardian was emailed about a flag that was
 * on no page of the product. The second window is a full page now, so a kind's unresolved rows are
 * absent only from the MIDDLE of a queue longer than two pages.
 */
describe('HUNT6-B-1 every just-emailed flag is on the page its email names, not only the last one', () => {
  it('lists both of two flags filed behind a full page of older open flags', async () => {
    const { fam, reportId, questionId } = await flaggedFamily([FALSE_MATCH, MATH], FALSE_MATCH);
    // A full page of system flags OLDER than the real one (the HUNT5-B-5 shape), shaped to satisfy
    // safety_reports_system_shape and distinct on safety_reports_system_once's
    // (question_id, transcription_at).
    await api.db.sql`
      insert into public.safety_reports (family_id, child_id, reporter_kind, category, question_id,
                                         status, created_at, transcription_at, screen_version, screen_categories)
      select ${fam.familyId}, ${fam.children[0]!.id}, 'system', 'severe_risk', ${questionId},
             'escalated', flag.created_at - (n * interval '1 minute'),
             flag.transcription_at - (n * interval '1 minute'), flag.screen_version, flag.screen_categories
        from generate_series(1, ${UNRESOLVED_REPORTS_PAGE_SIZE}) as n,
             (select created_at, transcription_at, screen_version, screen_categories
                from public.safety_reports where id = ${reportId}) as flag`;
    // The SECOND answer the same screen flagged: one minute later, its own report and its own email.
    const [second] = await api.db.sql<{ id: string }[]>`
      insert into public.safety_reports (family_id, child_id, reporter_kind, category, question_id,
                                         status, created_at, transcription_at, screen_version, screen_categories)
      select ${fam.familyId}, ${fam.children[0]!.id}, 'system', 'severe_risk', ${questionId},
             'escalated', flag.created_at + interval '1 minute',
             flag.transcription_at + interval '1 minute', flag.screen_version, flag.screen_categories
        from (select created_at, transcription_at, screen_version, screen_categories
                from public.safety_reports where id = ${reportId}) as flag
      returning id`;

    const parent = await unlockedParent(fam.ownerId);
    const res = await api.request('/v1/safety-reports', { token: parent });
    expect(res.status).toBe(200);
    const { reports } = safetyReportsResponseSchema.parse(await res.json());
    const listed = reports.map((r) => r.id);
    // With a one-row second window only `second` came back: 202 unresolved flags, the 200 oldest in
    // the drain window and the single newest beside them, so the earlier of the two emailed flags
    // was in no response and reachable from no surface.
    expect(listed).toContain(second!.id);
    expect(listed).toContain(reportId);
    // Still bounded: at most two pages of that kind, never the whole open queue (CS-R4-01).
    const pendingFlags = reports.filter(
      (r) => r.reporterKind === 'system' && r.status !== 'resolved',
    );
    expect(pendingFlags.length).toBeLessThanOrEqual(2 * UNRESOLVED_REPORTS_PAGE_SIZE);
    // And the oldest flag still leads the drain, so the page a guardian works through is unchanged.
    const oldest = pendingFlags.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
    const patched = await api.request(`/v1/safety-reports/${oldest.id}`, {
      method: 'PATCH',
      token: parent,
      body: { outcome: 'addressed' },
    });
    expect(patched.status).toBe(200);
  });

  it('lists a child’s three latest disclosures behind a full page of older child reports', async () => {
    const { fam, reportId } = await flaggedFamily([FALSE_MATCH, MATH], FALSE_MATCH);
    const childId = fam.children[0]!.id;
    // A full page of older child reports, then three the child filed just now. Every instant derives
    // from the flag's own row, never from a second clock (L-027).
    await api.db.sql`
      insert into public.safety_reports (family_id, child_id, reporter_kind, category, status, created_at)
      select ${fam.familyId}, ${childId}, 'child', 'wrong_or_confusing', 'open',
             flag.created_at - interval '2 hours' + (n * interval '10 seconds')
        from generate_series(1, ${UNRESOLVED_REPORTS_PAGE_SIZE}) as n,
             (select created_at from public.safety_reports where id = ${reportId}) as flag`;
    const latest = await api.db.sql<{ id: string }[]>`
      insert into public.safety_reports (family_id, child_id, reporter_kind, category, status, created_at)
      select ${fam.familyId}, ${childId}, 'child', 'upsetting', 'open',
             flag.created_at + (n * interval '1 minute')
        from generate_series(1, 3) as n,
             (select created_at from public.safety_reports where id = ${reportId}) as flag
      returning id`;
    expect(latest).toHaveLength(3);

    const parent = await unlockedParent(fam.ownerId);
    const res = await api.request('/v1/safety-reports', { token: parent });
    expect(res.status).toBe(200);
    const { reports } = safetyReportsResponseSchema.parse(await res.json());
    const listed = reports.map((r) => r.id);
    // The one-row branch returned the newest of the three; the child's other two disclosures were
    // absent from the only list a guardian has.
    for (const row of latest) expect(listed).toContain(row.id);
    const pendingChild = reports.filter(
      (r) => r.reporterKind === 'child' && r.status !== 'resolved',
    );
    expect(pendingChild.length).toBeLessThanOrEqual(2 * UNRESOLVED_REPORTS_PAGE_SIZE);
  });

  /**
   * The absence bound at UNRESOLVED_REPORTS_PAGE_SIZE and above r.get('/safety-reports') is stated
   * over EVERY reporter kind: "never that kind's oldest rows and never its newest", absent only in
   * the middle of a queue longer than two pages. The parent / catch-all branch had ONE newest-first
   * page and no second window, so from row 201 of that kind onward its oldest rows were absent — an
   * unlisted exception to a quantified claim, and the same loss HUNT5-B-4 fixed for the child branch:
   * the EARLIEST report is the one most likely to be the substantive one, and it is the one that fell
   * off. The branch has the oldest-first window too now.
   */
  it('lists the oldest of a kind that only has a newest-first page: the parent\u2019s own reports', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    // One page of open parent reports plus one, so the newest-first window cannot hold them all.
    // Every instant derives from the pinned request clock (L-027).
    const filed = await api.db.sql<{ id: string }[]>`
      insert into public.safety_reports (family_id, reporter_kind, category, note, status, created_at)
      select ${fam.familyId}, 'parent', 'other', 'synthetic parent report ' || n, 'open',
             ${api.now.value}::timestamptz - ((${UNRESOLVED_REPORTS_PAGE_SIZE + 1} - n) * interval '1 minute')
        from generate_series(1, ${UNRESOLVED_REPORTS_PAGE_SIZE + 1}) as n
      returning id`;
    expect(filed).toHaveLength(UNRESOLVED_REPORTS_PAGE_SIZE + 1);
    const oldest = filed[0]!.id;
    const newest = filed[filed.length - 1]!.id;

    const parent = await unlockedParent(fam.ownerId);
    const res = await api.request('/v1/safety-reports', { token: parent });
    expect(res.status).toBe(200);
    const { reports } = safetyReportsResponseSchema.parse(await res.json());
    const listed = reports.map((r) => r.id);
    // The newest was always there — the branch is newest-first. The OLDEST was on no page of the
    // product, while the bound above the handler said no kind's oldest rows can be absent.
    expect(listed).toContain(newest);
    expect(listed).toContain(oldest);
    // Still bounded per kind: two pages, not the whole open queue (CS-R4-01).
    const pendingParent = reports.filter(
      (r) => r.reporterKind === 'parent' && r.status !== 'resolved',
    );
    expect(pendingParent.length).toBeLessThanOrEqual(2 * UNRESOLVED_REPORTS_PAGE_SIZE);
  });
});

/**
 * HUNT6-B-4. HUNT5-B-2 stopped POST /deletion reading a 42501 from the slot release as a missing PIN
 * by wrapping EVERY throw out of releaseChildSlot in SlotReleaseFailed, whose cause pgErrorCode()
 * does not walk. That hid three more SQLSTATEs the application deliberately distinguishes: 40P01,
 * 40001 and 55P03 are lock contention the database resolved by aborting the transaction, which
 * app.ts answers 503 PROVIDER_UNAVAILABLE with Retry-After and logs as a `db_transient_conflict`
 * warning. Wrapped, such a failure reached app.ts as an unexpected error: 500 INTERNAL, no
 * Retry-After, and an error-level `unhandled_error` — a retryable failure told to the parent as
 * "Something went wrong" with nothing to retry on. The wrapper now re-throws a transient error
 * unchanged and keeps wrapping everything else.
 */
describe('HUNT6-B-4 a slot-release lock conflict stays a retryable 503', () => {
  it('answers PROVIDER_UNAVAILABLE with Retry-After instead of an unexpected 500', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const child = fam.children[0]!;
    await api.db.sql`
      insert into public.family_capacity (family_id, paid_slots, managing_channel)
      values (${fam.familyId}, 1, 'app_store')`;
    await api.db.sql`
      insert into public.child_slot_assignments (family_id, child_id)
      values (${fam.familyId}, ${child.id})`;
    const parent = await unlockedParent(fam.ownerId);
    // A LABELED TEST FIXTURE, not a production path: a statement-level trigger that raises 40P01 for
    // the slot release only. It is keyed on `current_user = 'service_role'`, which is true exactly
    // inside releaseChildSlot's `set local role service_role` and false inside
    // public.request_deletion (SECURITY DEFINER, so its own release statement runs as the owner), so
    // the conflict lands on the statement this finding is about. Statement level because migration
    // 0890 has already released the row, so the API's belt-and-braces UPDATE matches no rows and a
    // row-level trigger would never fire. Dropped in `finally`.
    await api.db.sql`
      create function pl_test_release_conflict() returns trigger language plpgsql as $$
      begin
        if current_user = 'service_role' then
          raise exception 'injected lock contention' using errcode = '40P01';
        end if;
        return null;
      end $$`;
    await api.db.sql`
      create trigger pl_test_release_conflict before update on public.child_slot_assignments
      for each statement execute function pl_test_release_conflict()`;
    let res: Response;
    try {
      res = await api.request('/v1/deletion', {
        method: 'POST',
        token: parent,
        body: { scope: 'child', childId: child.id },
      });
    } finally {
      await api.db.sql`drop trigger pl_test_release_conflict on public.child_slot_assignments`;
      await api.db.sql`drop function pl_test_release_conflict()`;
    }
    const body = await json<{ error?: { code?: string; message?: string } }>(res);
    // Wrapped, this was 500 INTERNAL "Something went wrong. Please try again." with no Retry-After.
    expect(res.status).toBe(503);
    expect(body.error?.code).toBe('PROVIDER_UNAVAILABLE');
    expect(res.headers.get('retry-after')).toBe('1');
    // And operations see the transient warning, not an error-level unhandled_error.
    expect(api.logs.filter((e) => e.event === 'db_transient_conflict')).toHaveLength(1);
    expect(api.logs.filter((e) => e.event === 'unhandled_error')).toEqual([]);
    // The request still rolls back whole: the release must never land apart from it.
    const [open] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.deletion_requests
       where family_id = ${fam.familyId} and status in ('requested', 'processing')`;
    expect(open!.n).toBe(0);
  });

  /**
   * And the FACT that corrects SlotReleaseFailed's own doc (B-PROSE / L-053). That doc stated as
   * present-tense fact that the release's UPDATE "contends for the child's assignment row with the
   * archive route", which is what the wrapper's transient pass-through was first justified by. It
   * matches nothing in the shipped schema: public.request_deletion released that row in the SAME
   * transaction a statement earlier (0890, reordered by 0930), so `released_at is null` is already
   * false, the UPDATE affects no row, and it takes no row lock on it to contend with. The case above
   * has to raise its conflict from a STATEMENT-level trigger for exactly this reason; here the same
   * trigger is ROW-level, so it fires only if a row is actually updated as the service role — and
   * nothing goes wrong, which is the observable.
   */
  it('affects no assignment row at all, so it cannot contend for one', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const child = fam.children[0]!;
    await api.db.sql`
      insert into public.family_capacity (family_id, paid_slots, managing_channel)
      values (${fam.familyId}, 1, 'app_store')`;
    await api.db.sql`
      insert into public.child_slot_assignments (family_id, child_id)
      values (${fam.familyId}, ${child.id})`;
    const parent = await unlockedParent(fam.ownerId);
    // A LABELED TEST FIXTURE, not a production path, and the same guard as the case above: keyed on
    // `current_user = 'service_role'`, true exactly inside releaseChildSlot's `set local role
    // service_role` and false inside public.request_deletion (SECURITY DEFINER, so its own release
    // runs as the owner). FOR EACH ROW, so it can only fire if that statement updates a row. It
    // returns `new` rather than null, which a BEFORE ROW trigger must do or it would cancel the
    // update it is watching. Dropped in `finally`.
    await api.db.sql`
      create function pl_test_release_row_conflict() returns trigger language plpgsql as $$
      begin
        if current_user = 'service_role' then
          raise exception 'injected lock contention' using errcode = '40P01';
        end if;
        return new;
      end $$`;
    await api.db.sql`
      create trigger pl_test_release_row_conflict before update on public.child_slot_assignments
      for each row execute function pl_test_release_row_conflict()`;
    let res: Response;
    try {
      res = await api.request('/v1/deletion', {
        method: 'POST',
        token: parent,
        body: { scope: 'child', childId: child.id },
      });
    } finally {
      await api.db.sql`drop trigger pl_test_release_row_conflict on public.child_slot_assignments`;
      await api.db.sql`drop function pl_test_release_row_conflict()`;
    }
    // Take the slot release out of public.request_deletion and this is 503: the belt-and-braces
    // UPDATE then matches the open row, fires the trigger as the service role, and the request that
    // is supposed to be the database's own backstop becomes the thing that needs retrying.
    expect(res.status).toBe(202);
    expect(api.logs.filter((e) => e.event === 'db_transient_conflict')).toEqual([]);
    // The slot is free and the request is open, both from the one transaction.
    const [slot] = await api.db.sql<{ released_at: Date | null; release_reason: string | null }[]>`
      select released_at, release_reason from public.child_slot_assignments
       where family_id = ${fam.familyId} and child_id = ${child.id}`;
    expect(slot!.released_at).not.toBeNull();
    expect(slot!.release_reason).toBe('archived');
    const [requested] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.deletion_requests
       where family_id = ${fam.familyId} and status in ('requested', 'processing')`;
    expect(requested!.n).toBe(1);
  });
});

/**
 * HUNT6-B-2, the user-visible half. `public.request_deletion` is granted to `authenticated`
 * (migration 0840), so the Supabase Data API can file a deletion with a parent's own token and no
 * Hono handler in the path. The export withdrawal lived only in the handler, so on that surface a
 * finished family_data file holding the deleted child's homework, transcriptions, results and
 * safety-notice rows stayed downloadable — export-download.ts reads kind, status, storage_path and
 * expires_at and nothing about deletion — until the deletion_purge job removed the objects, and for
 * ever if that job dead-lettered. Migration 0920 expires the rows inside the function; the handler's
 * `withdrawExports` stays as the half that removes the files.
 */
describe('HUNT6-B-2 a deletion filed through the Data API withdraws the finished export', () => {
  it('refuses the download that was served before the request', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const child = fam.children[0]!;
    // A finished export as the export_build job leaves one; synthetic path, no real bytes.
    const [built] = await api.db.sql<{ id: string }[]>`
      insert into public.data_exports (family_id, requested_by, kind, child_id, status,
                                       storage_path, expires_at)
      values (${fam.familyId}, ${fam.ownerId}, 'family_data', ${child.id}, 'ready',
              'exports/synthetic-family-data.json', ${new Date(api.now.value.getTime() + 7 * DAY_MS)})
      returning id`;
    const parent = await unlockedParent(fam.ownerId);
    const before = await api.request(`/v1/exports/${built!.id}/download`, { token: parent });
    expect(before.status).toBe(200);

    // The Data API's own call: `authenticated`, the parent's claims, no handler in the path.
    await grantAdultUnlock(api.db, fam.ownerId);
    await api.db.asParent(
      fam.ownerId,
      (tx) => tx`
        select id from public.request_deletion(${fam.familyId}::uuid, ${child.id}::uuid)`,
    );

    // Before 0920 this was still 200 with a signed URL for the deleted child's homework.
    const after = await api.request(`/v1/exports/${built!.id}/download`, { token: parent });
    expect(after.status).toBe(409);
    expect((await json<{ error?: { code?: string } }>(after)).error?.code).toBe('CONFLICT');
    const [row] = await api.db.sql<{ status: string; storage_path: string | null }[]>`
      select status, storage_path from public.data_exports where id = ${built!.id}`;
    expect(row!.status).toBe('expired');
    // The file is still named: removing it is the handler's half and the purge job's.
    expect(row!.storage_path).not.toBeNull();
  });
});

/**
 * HUNT7-D-1, the API halves. 0920/0930 withdrew only the exports that were ALREADY 'ready' and left
 * the 'queued' ones, on this justification, in three places: "a 'queued' export is untouched: the
 * builder leaves out every child with an open deletion request (privacy.ts)". The check is not in
 * privacy.ts — it is `childrenBeingDeleted` in jobs/export-build.ts — it is a plain SELECT taken
 * inside the BUILD transaction under READ COMMITTED and BEFORE the file is composed, and for a
 * FAMILY-scope request it checks nothing at all (it requires `target_child_id is not null`). So a
 * deletion that committed after that SELECT left the excluded-children list empty, the settle's only
 * guard was `status = 'queued'` — exactly what the migration had left standing — and the row flipped
 * to 'ready' with a live path and a seven-day expiry AFTER the request. Migration 0960 settles the
 * in-scope 'queued' rows in the request's own transaction; these two cases are the halves that live
 * in this package.
 */
describe('HUNT7-D-1 an export that finishes after the deletion request is never published', () => {
  it('refuses to publish the file when a deletion request appeared during the upload', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const child = fam.children[0]!;
    const parent = await unlockedParent(fam.ownerId);
    // A family-wide export: the kind POST /v1/exports accepts while a child deletion is pending,
    // and the kind that lists every child, so it is the one that can carry the deleted child's rows.
    const requested = await api.request('/v1/exports', {
      method: 'POST',
      token: parent,
      body: { kind: 'family_data' },
    });
    expect(requested.status).toBe(202);
    const [queued] = await api.db.sql<{ id: string }[]>`
      select id from public.data_exports
       where family_id = ${fam.familyId} and kind = 'family_data' and status = 'queued'`;

    // The deletion lands BETWEEN the build transaction and the settle — the window the builder's own
    // check cannot see, because its snapshot was taken inside the build. The row is written directly
    // rather than through public.request_deletion on purpose: this case is the BUILDER's guard, so
    // the function's own statement (which would settle this row itself) must not be what closes it.
    // A direct writer of public.deletion_requests is not hypothetical — app.inactivity_delete_family
    // is one, and it had no data_exports statement at all before 0960.
    let uploadedPath: string | null = null;
    await runJobs(deps, {
      export_build: createExportBuildHandler({
        upload: async (path, bytes) => {
          uploadedPath = path;
          api.providers.storage.put(path, bytes);
          await api.db.sql`
            insert into public.deletion_requests (family_id, scope, child_id, target_child_id, requested_by)
            values (${fam.familyId}, 'child', ${child.id}, ${child.id}, ${fam.ownerId})`;
        },
      }),
    });
    expect(uploadedPath).toBe(exportPath(fam.familyId, queued!.id, 'json'));

    const [row] = await api.db.sql<{ status: string; storage_path: string | null }[]>`
      select status, storage_path from public.data_exports where id = ${queued!.id}`;
    // Before the fix: ('ready', 'exports/<family>/<id>.json') with a seven-day expiry, and the next
    // line was a 200 with a signed URL for a file holding the deleted child's homework prompts, the
    // transcriptions of their answers, their grading verdicts and the fact a safety notice was
    // placed on a question.
    expect(row!.status).toBe('failed');
    expect(row!.storage_path).toBeNull();
    const download = await api.request(`/v1/exports/${queued!.id}/download`, { token: parent });
    expect(download.status).toBe(409);
    // And the bytes the builder had already uploaded do not stay in private storage waiting for the
    // purge: the builder that refused to publish removes what it wrote.
    expect([...api.providers.storage.objects]).not.toContain(uploadedPath);
  });

  it('still schedules the late storage pass for the export the deletion settled mid-build', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const child = fam.children[0]!;
    const parent = await unlockedParent(fam.ownerId);
    const requested = await api.request('/v1/exports', {
      method: 'POST',
      token: parent,
      body: { kind: 'family_data' },
    });
    expect(requested.status).toBe(202);
    const [queued] = await api.db.sql<{ id: string }[]>`
      select id from public.data_exports
       where family_id = ${fam.familyId} and kind = 'family_data' and status = 'queued'`;
    // And this child's OWN export, also still building. The two are judged by different parties, which
    // is what the assertions below pin.
    const ownRequested = await api.request('/v1/exports', {
      method: 'POST',
      token: parent,
      body: { kind: 'progress_csv', childId: child.id },
    });
    expect(ownRequested.status).toBe(202);
    const [ownQueued] = await api.db.sql<{ id: string }[]>`
      select id from public.data_exports
       where family_id = ${fam.familyId} and kind = 'progress_csv' and status = 'queued'`;

    // The parent asks for this child's data to be deleted while both exports are still building.
    const deletion = await api.request('/v1/deletion', {
      method: 'POST',
      token: parent,
      body: { scope: 'child', childId: child.id },
    });
    expect(deletion.status).toBe(202);
    // Migration 0960 settles the row it can judge without reading any file — the export ABOUT the
    // deleted child — so that one can never be published.
    const [ownSettled] = await api.db.sql<{ status: string }[]>`
      select status from public.data_exports where id = ${ownQueued!.id}`;
    expect(ownSettled!.status).toBe('failed');
    // The FAMILY-WIDE row is deliberately left standing: whether it is safe depends on what its bytes
    // contain, and only the builder knows that (the case above proves the builder refuses it when the
    // bytes were composed before the request; tests/export-build.test.ts proves it publishes when they
    // were composed after, which is what spec P4 requires — the family keeps that export, minus the
    // deleted child). If 0960 failed this row too, every parent with a family export in flight would
    // lose it to one child's deletion.
    const [famSettled] = await api.db.sql<{ status: string }[]>`
      select status from public.data_exports where id = ${queued!.id}`;
    expect(famSettled!.status).toBe('queued');

    // And the purge must still schedule the SECOND storage pass for BOTH. A worker that was mid-upload
    // when the deletion committed can put bytes at the deterministic path after the purge has run;
    // jobs/dispatcher.ts built that late-removal list from `status === 'queued'` alone, so the row
    // 0960 had just settled to 'failed' lost its private.storage_removals entry and the file would
    // have been left behind for ever (nothing else removes an object of a non-'ready' row). The rule is
    // now `status !== 'ready'`, which is why the 'failed' row is covered as well as the 'queued' one —
    // the very distinction that made the old predicate wrong.
    await runJobs(deps, { deletion_purge: deletionPurgeHandler });
    const removals = await api.db.sql<{ storage_path: string }[]>`
      select storage_path from private.storage_removals where reason = 'deletion_late_upload'`;
    const scheduled = removals.map((r) => r.storage_path);
    expect(scheduled).toContain(exportPath(fam.familyId, queued!.id, 'json'));
    // The row 0960 settled to 'failed' is the one `status === 'queued'` would have missed.
    expect(scheduled).toContain(exportPath(fam.familyId, ownQueued!.id, 'csv'));
  });
});

/**
 * HUNT7-E-4. The per-kind bound the handler promises is TWO pages of that kind
 * (UNRESOLVED_REPORTS_PAGE_SIZE, and the claim stated above r.get('/safety-reports')), and every
 * assertion that claimed to keep it was satisfied without reaching it: the four cases above hold 206,
 * 202, 203 and 201 open rows of a kind against a bound of 400, so `limit
 * ${UNRESOLVED_REPORTS_PAGE_SIZE}` could be deleted from `newest_flags` or from `newest_child` and the
 * whole suite stayed green. Only the PARENT kind was ever pinned at the bound (the 405-row cases with
 * an exact `toHaveLength(400)`). These two cases put the two kinds that matter most — the safety
 * screen's flags, and a child's own reports — over the bound with an exact count, so the bound bites
 * where the flag email points a parent.
 */
describe('HUNT7-E-4 the two-page bound bites on the system and child kinds too', () => {
  it('returns exactly two pages of system flags with 400+ open, both ends included', async () => {
    const { fam, reportId, questionId } = await flaggedFamily([FALSE_MATCH, MATH], FALSE_MATCH);
    // Two pages and five OLDER system flags, the HUNT5-B-5 shape (child, question, no note,
    // 'escalated', the screen columns) and distinct on safety_reports_system_once's
    // (question_id, transcription_at). Every instant derives from the flag's own row (L-027).
    const filler = 2 * UNRESOLVED_REPORTS_PAGE_SIZE + 5;
    const older = await api.db.sql<{ id: string; created_at: Date }[]>`
      insert into public.safety_reports (family_id, child_id, reporter_kind, category, question_id,
                                         status, created_at, transcription_at, screen_version, screen_categories)
      select ${fam.familyId}, ${fam.children[0]!.id}, 'system', 'severe_risk', ${questionId},
             'escalated', flag.created_at - (n * interval '1 minute'),
             flag.transcription_at - (n * interval '1 minute'), flag.screen_version, flag.screen_categories
        from generate_series(1, ${filler}) as n,
             (select created_at, transcription_at, screen_version, screen_categories
                from public.safety_reports where id = ${reportId}) as flag
      returning id, created_at`;
    expect(older).toHaveLength(filler);
    // 406 open flags in all: the real one is the newest, and `n = filler` is the oldest.
    const oldest = older.reduce((a, b) => (a.created_at <= b.created_at ? a : b));

    const parent = await unlockedParent(fam.ownerId);
    const res = await api.request('/v1/safety-reports', { token: parent });
    expect(res.status).toBe(200);
    const { reports } = safetyReportsResponseSchema.parse(await res.json());
    const pendingFlags = reports.filter(
      (r) => r.reporterKind === 'system' && r.status !== 'resolved',
    );
    // EXACTLY the bound, against 406 open rows of the kind. Remove the `limit` from `newest_flags`
    // and this is 406.
    expect(pendingFlags).toHaveLength(2 * UNRESOLVED_REPORTS_PAGE_SIZE);
    // And what the bound promises about WHICH rows: never the oldest of the kind, never its newest.
    const listed = pendingFlags.map((r) => r.id);
    expect(listed).toContain(oldest.id);
    expect(listed).toContain(reportId);
  });

  it('returns exactly two pages of a child’s own reports with 400+ open, both ends included', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const childId = fam.children[0]!.id;
    // Two pages and six open child reports, oldest first. Every instant derives from the pinned
    // request clock (L-027).
    const total = 2 * UNRESOLVED_REPORTS_PAGE_SIZE + 6;
    const filed = await api.db.sql<{ id: string }[]>`
      insert into public.safety_reports (family_id, child_id, reporter_kind, category, status, created_at)
      select ${fam.familyId}, ${childId}, 'child', 'upsetting', 'open',
             ${api.now.value}::timestamptz - ((${total} - n) * interval '1 minute')
        from generate_series(1, ${total}) as n
      returning id`;
    expect(filed).toHaveLength(total);
    const oldest = filed[0]!.id;
    const newest = filed[filed.length - 1]!.id;

    const parent = await unlockedParent(fam.ownerId);
    const res = await api.request('/v1/safety-reports', { token: parent });
    expect(res.status).toBe(200);
    const { reports } = safetyReportsResponseSchema.parse(await res.json());
    const pendingChild = reports.filter(
      (r) => r.reporterKind === 'child' && r.status !== 'resolved',
    );
    // EXACTLY the bound, against 406 open rows of the kind. Remove the `limit` from `newest_child`
    // and this is 406.
    expect(pendingChild).toHaveLength(2 * UNRESOLVED_REPORTS_PAGE_SIZE);
    const listed = pendingChild.map((r) => r.id);
    expect(listed).toContain(oldest);
    expect(listed).toContain(newest);
  });
});
