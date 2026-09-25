import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMockModerationClient,
  createMockResponsesClient,
  type ResponsesClient,
  type ResponsesRequest,
  type ResponsesResult,
} from '@pencillift/ai';
import {
  adminSafetyReportResponseSchema,
  childAssignmentDetailResponseSchema,
  safetyReportResponseSchema,
  safetyReportsResponseSchema,
  type SafetyReport,
} from '@pencillift/contracts';
import { cryptoRandom } from '@pencillift/domain';
import {
  grantAdultUnlock,
  seedFamily,
  seedOwnerAdmin,
  type SeededFamily,
} from '@pencillift/db/testing/fixtures';
import { runJobs, type JobDeps, type JobHandler } from '../src/jobs/dispatcher.ts';
import { createScanProcessHandler } from '../src/jobs/scan-process.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * The parent acts on a safety flag (owner decision, 2026-09-25: the parent is the only person
 * PencilLift sends a safety message to, and the parent addresses the concern). PATCH
 * /v1/safety-reports/:id, end to end against real Postgres with a LABELED MOCK AI client: "This
 * was a false alarm" clears the flag exactly as the reviewer's clearing does (the child's notice
 * goes, the question is graded), "I've looked into this" resolves it and changes nothing for the
 * child. Synthetic worksheet content and children (Riley) only.
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

// ---------------------------------------------------------------------------------------------
// Scripted mock model (a trimmed copy of safety-screening.test.ts: same envelope and stages)
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
const SEVERE_ANSWER = 'I want to die';
const SEVERE: ScriptedQuestion = {
  number: '2',
  prompt: 'Why do plants need sunlight?',
  answer: SEVERE_ANSWER,
  kind: 'open_response',
  subject: 'science',
  key: 'Plants use sunlight to make food.',
};
// A word match on homework hyperbole: the flag a guardian may call a false alarm.
const FALSE_MATCH_ANSWER = 'please kill me now, this homework is so long';
const FALSE_MATCH: ScriptedQuestion = {
  number: '3',
  prompt: 'Write one sentence about your homework tonight.',
  answer: FALSE_MATCH_ANSWER,
  kind: 'open_response',
  subject: 'grammar_writing',
  key: 'A complete sentence about homework.',
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

async function consent(fam: SeededFamily) {
  await api.db.sql`
    insert into public.consent_records (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
    values (${fam.familyId}, ${fam.ownerId}, 'mock', 'mock', 'child_learning_data', 'v1', 'verified', true, now())`;
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

function handlers(client: ResponsesClient): Record<string, JobHandler> {
  return {
    scan_process: createScanProcessHandler({
      ai: client,
      moderation: createMockModerationClient(),
      readObject: () => Promise.resolve(syntheticJpeg()),
      sleep: () => Promise.resolve(),
    }),
  };
}

interface Scan {
  fam: SeededFamily;
  assignmentId: string;
}

async function queuedScan(family: SeededFamily): Promise<Scan> {
  const childId = family.children[0]!.id;
  const [a] = await api.db.sql<{ id: string }[]>`
    insert into public.assignments (family_id, child_id, idempotency_key, created_by_kind, page_count, status)
    values (${family.familyId}, ${childId}, ${'scan-' + randomUUID()}, 'child', 1, 'queued') returning id`;
  const pageId = randomUUID();
  await api.db.sql`
    insert into public.source_pages (id, assignment_id, family_id, child_id, page_number, storage_path, mime_type, byte_size, sha256)
    values (${pageId}, ${a!.id}, ${family.familyId}, ${childId}, 1, ${`${family.familyId}/${childId}/${a!.id}/${pageId}.jpg`},
            'image/jpeg', ${syntheticJpeg().length},
            ${createHash('sha256').update(syntheticJpeg()).digest('hex')})`;
  await api.db.sql`
    insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, max_attempts, run_after)
    values ('scan_process', ${`scan:${a!.id}:v1`}, ${family.familyId}, ${childId},
            ${JSON.stringify({ assignmentId: a!.id, mode: 'initial' })}::text::jsonb, 5,
            ${new Date(api.now.value.getTime() - 1000)})`;
  return { fam: family, assignmentId: a!.id };
}

/** A scanned family whose flagged question is `flagged` (the scan job ran with the mock model). */
async function flaggedFamily(questions: ScriptedQuestion[], flagged: ScriptedQuestion) {
  const fam = await seedFamily(api.db, { childCount: 1 });
  await consent(fam);
  const scan = await queuedScan(fam);
  const client = scriptedModel(questions);
  expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
  const [q] = await api.db.sql<{ id: string }[]>`
    select id from public.extracted_questions where assignment_id = ${scan.assignmentId} and prompt_text = ${flagged.prompt}`;
  const [report] = await api.db.sql<{ id: string }[]>`
    select id from public.safety_reports where question_id = ${q!.id} and reporter_kind = 'system'`;
  return { fam, scan, client, questionId: q!.id, reportId: report!.id };
}

async function dueNow(fam: SeededFamily) {
  api.now.value = new Date(api.now.value.getTime() + 60_000);
  await api.db.sql`
    update public.jobs set run_after = ${new Date(api.now.value.getTime() - 1000)}
     where family_id = ${fam.familyId} and status = 'queued'`;
}

let pairCount = 0;
/** A paired child session for the family's first child, and the parent's unlocked token. */
async function childSession(fam: SeededFamily): Promise<{ parent: string; child: string }> {
  const session = randomUUID();
  await grantAdultUnlock(api.db, fam.ownerId, session, 3600);
  const parent = await parentToken(fam.ownerId, { sessionId: session });
  const code = await api.request(`/v1/children/${fam.children[0]!.id}/pairing-code`, {
    method: 'POST',
    token: parent,
  });
  expect(code.status).toBe(201);
  pairCount += 1;
  const paired = await api.request('/v1/child/pair', {
    method: 'POST',
    headers: { 'cf-connecting-ip': `192.0.2.${pairCount}` },
    body: {
      code: (await json<{ code: string }>(code)).code,
      deviceLabel: `Tablet ${pairCount}`,
      platform: 'ios',
    },
  });
  expect(paired.status).toBe(201);
  return { parent, child: (await json<{ accessToken: string }>(paired)).accessToken };
}

/** A parent token with a recent PIN unlock (no device pairing). */
async function unlockedParent(userId: string): Promise<string> {
  const session = randomUUID();
  await grantAdultUnlock(api.db, userId, session, 3600);
  return parentToken(userId, { sessionId: session });
}

const childDetail = async (scan: Scan, token: string) => {
  const res = await api.request(`/v1/child/assignments/${scan.assignmentId}`, { token });
  expect(res.status).toBe(200);
  return childAssignmentDetailResponseSchema.parse(await res.json());
};

const act = (token: string, id: string, body: unknown) =>
  api.request(`/v1/safety-reports/${id}`, { method: 'PATCH', token, body });

async function familyList(token: string): Promise<SafetyReport[]> {
  const res = await api.request('/v1/safety-reports', { token });
  expect(res.status).toBe(200);
  return safetyReportsResponseSchema.parse(await res.json()).reports;
}

type ErrorBody = { error: { code: string; rule?: string } };

/** Every grading, verification or coaching request that carried `text` anywhere in its input. */
function modelRequestsWith(client: { requests: ResponsesRequest[] }, text: string) {
  return client.requests.filter((r) => JSON.stringify(r.input).includes(text));
}

// ---------------------------------------------------------------------------------------------

describe('a guardian clears a flag as a false alarm (PATCH /v1/safety-reports/:id)', () => {
  it('hides the child’s notice, grades the question with the mock AI, and is final', async () => {
    const { fam, scan, client, questionId, reportId } = await flaggedFamily(
      [FALSE_MATCH, MATH],
      FALSE_MATCH,
    );
    const { parent, child } = await childSession(fam);
    const flagged = async () =>
      (await childDetail(scan, child)).questions.find((q) => q.id === questionId)!;
    expect((await flagged()).feedback.map((f) => f.kind)).toEqual(['safety']);
    expect(modelRequestsWith(client, FALSE_MATCH_ANSWER)).toEqual([]);

    // Listed at once (no hold), with the recorded delivery: the email job has not run here.
    expect(await familyList(parent)).toMatchObject([
      {
        id: reportId,
        reporterKind: 'system',
        status: 'escalated',
        clearedAsFalseMatch: false,
        parentOutcome: null,
        parentActionAt: null,
        emailStatus: 'not_sent',
        emailedAt: null,
      },
    ]);

    const res = await act(parent, reportId, { outcome: 'false_match' });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(FALSE_MATCH_ANSWER);
    const { report } = safetyReportResponseSchema.parse(JSON.parse(raw));
    expect(report).toMatchObject({
      id: reportId,
      status: 'resolved',
      resolvedAt: api.now.value.toISOString(),
      clearedAsFalseMatch: true,
      parentOutcome: 'false_match',
      parentActionAt: api.now.value.toISOString(),
    });

    // (a) At once: the notice is gone and the scan is re-checking.
    const waiting = await childDetail(scan, child);
    expect(waiting.assignment.status).toBe('checking');
    expect(waiting.questions.find((q) => q.id === questionId)!.feedback).toEqual([]);

    // (b) The recheck grades the question normally, files no new report and no new notice.
    const before = client.requests.length;
    await dueNow(fam);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    const recheck = { requests: client.requests.slice(before) };
    expect(modelRequestsWith(recheck, FALSE_MATCH_ANSWER).length).toBeGreaterThan(0);
    const graded = await flagged();
    expect(graded.verdict).toBe('incorrect');
    expect(graded.feedback.length).toBeGreaterThan(0);
    expect(graded.feedback.map((f) => f.kind)).not.toContain('safety');
    expect(
      await api.db.sql`select id from public.safety_reports where family_id = ${fam.familyId}`,
    ).toHaveLength(1);

    // (c) The audit row names the guardian's action with ids and codes only.
    const audit = await api.db.sql<
      { family_id: string | null; actor_kind: string; action: string; metadata: unknown }[]
    >`select family_id, actor_kind, action, metadata from public.audit_events
       where target_id = ${reportId} and action = 'safety_report.parent_action'`;
    expect(audit).toEqual([
      {
        family_id: fam.familyId,
        actor_kind: 'parent',
        action: 'safety_report.parent_action',
        metadata: { from: 'escalated', to: 'resolved', outcome: 'false_match', recheck: 'queued' },
      },
    ]);
    expect(JSON.stringify(api.logs)).not.toContain(FALSE_MATCH_ANSWER);
    expect(api.logs).toContainEqual(
      expect.objectContaining({
        event: 'safety_report_parent_action',
        code: 'FALSE_MATCH_RECHECK_QUEUED',
      }),
    );

    // (d) Resolved is final for the guardian (409) and for the reviewer (invalid transition).
    const again = await act(parent, reportId, { outcome: 'addressed' });
    expect(again.status).toBe(409);
    expect((await json<ErrorBody>(again)).error.rule).toBe('REPORT_ALREADY_RESOLVED');
    const aal2 = await parentToken(await seedOwnerAdmin(api.db), { aal: 'aal2' });
    const admin = await api.request(`/v1/admin/safety-reports/${reportId}`, {
      method: 'PATCH',
      token: aal2,
      body: { status: 'resolved', resolutionNote: 'SYNTHETIC: reviewed after the parent' },
    });
    expect(admin.status).toBe(422);
    expect((await json<ErrorBody>(admin)).error.rule).toBe('INVALID_TRANSITION');
    expect(await familyList(parent)).toMatchObject([
      { id: reportId, status: 'resolved', clearedAsFalseMatch: true, parentOutcome: 'false_match' },
    ]);
  });

  it('is refused while the scan is still being checked, like the reviewer’s clearing', async () => {
    const { fam, scan, reportId } = await flaggedFamily([SEVERE, MATH], SEVERE);
    const parent = await unlockedParent(fam.ownerId);
    await api.db
      .sql`update public.assignments set status = 'checking' where id = ${scan.assignmentId}`;
    const res = await act(parent, reportId, { outcome: 'false_match' });
    expect(res.status).toBe(422);
    expect((await json<ErrorBody>(res)).error.rule).toBe('SCAN_STILL_CHECKING');
    expect((await familyList(parent))[0]).toMatchObject({
      status: 'escalated',
      parentOutcome: null,
    });
  });
});

describe('a guardian marks a flag looked into', () => {
  it('resolves the report; the child’s notice stays and no AI runs on that question', async () => {
    const { fam, scan, client, questionId, reportId } = await flaggedFamily([SEVERE, MATH], SEVERE);
    const { parent, child } = await childSession(fam);
    const [assignmentBefore] = await api.db.sql<{ status: string }[]>`
      select status from public.assignments where id = ${scan.assignmentId}`;
    const statusBefore = assignmentBefore!.status;
    const requestsBefore = client.requests.length;

    const res = await act(parent, reportId, { outcome: 'addressed' });
    expect(res.status).toBe(200);
    const { report } = safetyReportResponseSchema.parse(await res.json());
    expect(report).toMatchObject({
      id: reportId,
      status: 'resolved',
      clearedAsFalseMatch: false,
      parentOutcome: 'addressed',
      parentActionAt: api.now.value.toISOString(),
    });

    const detail = await childDetail(scan, child);
    expect(detail.assignment.status).toBe(statusBefore);
    const flagged = detail.questions.find((q) => q.id === questionId)!;
    expect(flagged.feedback.map((f) => f.kind)).toEqual(['safety']);
    expect(flagged.verdict).not.toBe('incorrect');
    // No recheck was queued and nothing more went to the model.
    const jobs = await api.db.sql<{ kind: string; status: string }[]>`
      select kind, status from public.jobs where family_id = ${fam.familyId} and kind = 'scan_process'`;
    expect(jobs).toEqual([{ kind: 'scan_process', status: 'succeeded' }]);
    await dueNow(fam);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(0);
    expect(client.requests.length).toBe(requestsBefore);
    expect(modelRequestsWith(client, SEVERE_ANSWER)).toEqual([]);

    const [audit] = await api.db.sql<{ metadata: unknown }[]>`
      select metadata from public.audit_events where target_id = ${reportId} and action = 'safety_report.parent_action'`;
    expect(audit!.metadata).toEqual({ from: 'escalated', to: 'resolved', outcome: 'addressed' });
    expect(await familyList(parent)).toMatchObject([
      { id: reportId, status: 'resolved', parentOutcome: 'addressed', clearedAsFalseMatch: false },
    ]);
  });
});

describe('who may act, and on what', () => {
  it('another family’s guardian gets 404; a child token 401; an unknown id 404', async () => {
    const { reportId } = await flaggedFamily([SEVERE, MATH], SEVERE);
    const other = await seedFamily(api.db, { childCount: 1 });
    const stranger = await unlockedParent(other.ownerId);
    for (const outcome of ['addressed', 'false_match']) {
      expect((await act(stranger, reportId, { outcome })).status).toBe(404);
    }
    expect((await act(stranger, randomUUID(), { outcome: 'addressed' })).status).toBe(404);
    expect((await act(stranger, 'not-a-uuid', { outcome: 'addressed' })).status).toBe(404);
    const { child } = await childSession(other);
    expect((await act(child, reportId, { outcome: 'addressed' })).status).toBe(401);
    const [row] = await api.db.sql<{ status: string; parent_action_at: Date | null }[]>`
      select status, parent_action_at from public.safety_reports where id = ${reportId}`;
    expect(row).toEqual({ status: 'escalated', parent_action_at: null });
  });

  it('needs a recent PIN unlock (spec P3): the step-up rule, and nothing changes', async () => {
    const { fam, reportId } = await flaggedFamily([SEVERE, MATH], SEVERE);
    const stale = await parentToken(fam.ownerId); // this session has no unlock
    for (const outcome of ['addressed', 'false_match']) {
      const res = await act(stale, reportId, { outcome });
      expect(res.status).toBe(403);
      expect((await json<ErrorBody>(res)).error.code).toBe('STEP_UP_REQUIRED');
    }
    expect((await familyList(stale))[0]).toMatchObject({
      status: 'escalated',
      parentOutcome: null,
    });
    // After the unlock the same action goes through.
    const unlocked = await unlockedParent(fam.ownerId);
    expect((await act(unlocked, reportId, { outcome: 'addressed' })).status).toBe(200);
  });

  it('a child’s report can be looked into, never cleared as a false alarm', async () => {
    const { fam, questionId } = await flaggedFamily([SEVERE, MATH], SEVERE);
    const { parent, child } = await childSession(fam);
    const filed = await api.request('/v1/child/reports', {
      method: 'POST',
      token: child,
      body: { category: 'upsetting', questionId },
    });
    expect(filed.status).toBe(201);
    const childReport = (await familyList(parent)).find((r) => r.reporterKind === 'child')!;
    expect(childReport).toMatchObject({ status: 'open', emailStatus: 'not_sent' });
    const cleared = await act(parent, childReport.id, { outcome: 'false_match' });
    expect(cleared.status).toBe(422);
    expect((await json<ErrorBody>(cleared)).error.rule).toBe('FALSE_MATCH_SYSTEM_ONLY');
    const looked = await act(parent, childReport.id, { outcome: 'addressed' });
    expect(looked.status).toBe(200);
    expect(safetyReportResponseSchema.parse(await looked.json()).report).toMatchObject({
      status: 'resolved',
      parentOutcome: 'addressed',
      clearedAsFalseMatch: false,
    });
  });

  it('a parent’s own report is reviewed by PencilLift, not self-resolved', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const parent = await unlockedParent(fam.ownerId);
    const filed = await api.request('/v1/safety-reports', {
      method: 'POST',
      token: parent,
      body: { category: 'other', note: 'SYNTHETIC parent report' },
    });
    expect(filed.status).toBe(201);
    const { report } = safetyReportResponseSchema.parse(await filed.json());
    expect(report).toMatchObject({ parentOutcome: null, emailStatus: 'not_sent', emailedAt: null });
    for (const outcome of ['addressed', 'false_match']) {
      const res = await act(parent, report.id, { outcome });
      expect(res.status).toBe(422);
      expect((await json<ErrorBody>(res)).error.rule).toBe('PARENT_ACTION_NOT_FOR_REPORT');
    }
  });

  it('the body is strict: only the two outcomes, nothing else rides along', async () => {
    const { fam, reportId } = await flaggedFamily([SEVERE, MATH], SEVERE);
    const parent = await unlockedParent(fam.ownerId);
    for (const body of [
      { outcome: 'resolved' },
      { outcome: 'addressed', resolutionNote: 'x' },
      { outcome: 'addressed', familyVisible: true },
      {},
    ]) {
      expect((await act(parent, reportId, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await familyList(parent))[0]).toMatchObject({ status: 'escalated' });
  });
});

describe('the owner admin queue stays a support tool', () => {
  it('the reviewer’s clearing still hides the notice and grades the question, without a parent outcome', async () => {
    const { fam, scan, client, questionId, reportId } = await flaggedFamily(
      [FALSE_MATCH, MATH],
      FALSE_MATCH,
    );
    const { parent, child } = await childSession(fam);
    const aal2 = await parentToken(await seedOwnerAdmin(api.db), { aal: 'aal2' });
    const cleared = await api.request(`/v1/admin/safety-reports/${reportId}`, {
      method: 'PATCH',
      token: aal2,
      body: {
        status: 'resolved',
        resolutionNote:
          'SYNTHETIC: false match (screen code SELF_HARM_KILL_ME); homework hyperbole.',
        resolution: 'false_match',
      },
    });
    expect(cleared.status).toBe(200);
    const body = adminSafetyReportResponseSchema.parse(await cleared.json());
    expect(body.recheck).toBe('queued');
    expect(body.report).toMatchObject({ status: 'resolved', resolution: 'false_match' });
    expect(
      (await childDetail(scan, child)).questions.find((q) => q.id === questionId)!.feedback,
    ).toEqual([]);
    await dueNow(fam);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    const graded = (await childDetail(scan, child)).questions.find((q) => q.id === questionId)!;
    expect(graded.verdict).toBe('incorrect');
    expect(graded.feedback.map((f) => f.kind)).not.toContain('safety');
    expect(await familyList(parent)).toMatchObject([
      {
        id: reportId,
        status: 'resolved',
        clearedAsFalseMatch: true,
        parentOutcome: null,
        parentActionAt: null,
      },
    ]);
    // The guardian can no longer act on it.
    expect((await act(parent, reportId, { outcome: 'addressed' })).status).toBe(409);
  });

  it('the reviewer sees a guardian’s outcome in the queue and cannot send `addressed` itself', async () => {
    const { fam, reportId } = await flaggedFamily([SEVERE, MATH], SEVERE);
    const parent = await unlockedParent(fam.ownerId);
    expect((await act(parent, reportId, { outcome: 'addressed' })).status).toBe(200);
    const aal2 = await parentToken(await seedOwnerAdmin(api.db), { aal: 'aal2' });
    const queue = await api.request('/v1/admin/safety-reports?status=resolved', { token: aal2 });
    expect(queue.status).toBe(200);
    const listed = (
      (await queue.json()) as { reports: { id: string; resolution: string | null }[] }
    ).reports.find((r) => r.id === reportId);
    expect(listed).toMatchObject({ resolution: 'addressed' });
    const { reportId: fresh } = await flaggedFamily([SEVERE, MATH], SEVERE);
    const forged = await api.request(`/v1/admin/safety-reports/${fresh}`, {
      method: 'PATCH',
      token: aal2,
      body: { status: 'resolved', resolutionNote: 'SYNTHETIC', resolution: 'addressed' },
    });
    expect(forged.status).toBe(400);
  });
});
