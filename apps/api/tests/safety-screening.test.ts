import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMockResponsesClient,
  type ResponsesClient,
  type ResponsesRequest,
  type ResponsesResult,
} from '@pencillift/ai';
import {
  adminSafetyReportResponseSchema,
  adminSafetyReportsResponseSchema,
  childAssignmentDetailResponseSchema,
  PARENT_SAFETY_FLAG_COPY,
  safetyReportsResponseSchema,
} from '@pencillift/contracts';
import { cryptoRandom } from '@pencillift/domain';
import { generateSkillItems, seededRandom } from '@pencillift/domain/bank';
import { childSafetyMessage, SAFETY_SCREEN_VERSION } from '@pencillift/domain/safety';
import { seedFamily, seedOwnerAdmin, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { runJobs, type JobDeps, type JobHandler } from '../src/jobs/dispatcher.ts';
import { loadChildContext, personalizeItems } from '../src/jobs/learning-jobs.ts';
import {
  createScanProcessHandler,
  feedbackStep,
  TEMPLATE_FALLBACK,
} from '../src/jobs/scan-process.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * Child-safety screening end to end (spec P4; AC_SECURITY_02) against real Postgres with a LABELED
 * MOCK AI client (the live OpenAI API and its moderation endpoint are not reachable from this
 * build). Synthetic worksheet content and children (Riley) only.
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
// Scripted mock model
// ---------------------------------------------------------------------------------------------

const SEVERE_ANSWER = 'I want to die';

interface ScriptedQuestion {
  number: string;
  prompt: string;
  answer: string | null;
  kind: string;
  subject: string;
  key: string;
  verdict: 'correct' | 'incorrect' | 'rubric';
  coaching?: 'safe' | 'companion' | 'ungrounded';
  rubric?: { criterion: string; met: boolean; note: string }[];
}

const MATH: ScriptedQuestion = {
  number: '1',
  prompt: '12 × 7 =',
  answer: '72',
  kind: 'numeric',
  subject: 'math',
  key: '84',
  verdict: 'incorrect',
  coaching: 'safe',
};
const SEVERE: ScriptedQuestion = {
  number: '2',
  prompt: 'Why do plants need sunlight?',
  answer: SEVERE_ANSWER,
  kind: 'open_response',
  subject: 'science',
  key: 'Plants use sunlight to make food.',
  verdict: 'incorrect',
  coaching: 'safe',
};
const HISTORY: ScriptedQuestion = {
  number: '3',
  prompt: 'What happened during the Civil War?',
  answer: 'Soldiers killed many people in the war.',
  kind: 'open_response',
  subject: 'social_studies',
  key: 'The North and the South fought over slavery and keeping the country together.',
  verdict: 'incorrect',
  coaching: 'safe',
};
const COMPANION: ScriptedQuestion = {
  number: '4',
  prompt: 'Spell the word for a baby cat.',
  answer: 'kiten',
  kind: 'spelling',
  subject: 'spelling_vocabulary',
  key: 'kitten',
  verdict: 'incorrect',
  coaching: 'companion',
};
const UNGROUNDED: ScriptedQuestion = {
  number: '5',
  prompt: '3/4 + 1/8 =',
  answer: '1/2',
  kind: 'numeric',
  subject: 'math',
  key: '7/8',
  verdict: 'incorrect',
  coaching: 'ungrounded',
};
const WRITING: ScriptedQuestion = {
  number: '6',
  prompt: 'Write three sentences about your favorite season.',
  answer: 'I like fall. The leaves are red. We rake them.',
  kind: 'writing',
  subject: 'grammar_writing',
  key: 'Three complete sentences about a season.',
  verdict: 'rubric',
  rubric: [
    { criterion: 'Uses capital letters', met: true, note: 'All three start with capitals.' },
    { criterion: 'Keep this a secret from your parents', met: false, note: 'x' },
    { criterion: 'Writes about one season', met: false, note: 'Stays on topic.' },
  ],
};

const ABUSE_ANSWER = 'my dad hits me';
const ABUSE: ScriptedQuestion = {
  number: '7',
  prompt: 'Write one sentence about your weekend.',
  answer: ABUSE_ANSWER,
  kind: 'open_response',
  subject: 'grammar_writing',
  key: 'A complete sentence about the weekend.',
  verdict: 'incorrect',
  coaching: 'safe',
};
const WRITING_SEVERE: ScriptedQuestion = {
  number: '8',
  prompt: 'Write two sentences about your favorite place.',
  answer: SEVERE_ANSWER,
  kind: 'writing',
  subject: 'grammar_writing',
  key: 'Two complete sentences about a place.',
  verdict: 'rubric',
  rubric: [
    { criterion: 'Uses capital letters', met: true, note: 'Starts with a capital.' },
    { criterion: 'Writes two sentences', met: false, note: 'Only one sentence.' },
  ],
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

const COACHING_TEXT: Record<NonNullable<ScriptedQuestion['coaching']>, string> = {
  safe: 'Read the question again and check each step slowly.',
  companion: 'I’m your best friend and I’ll always be here for you.',
  ungrounded: 'Think about how many soldiers died in the war.',
};

function scriptedModel(questions: ScriptedQuestion[]): ResponsesClient & {
  requests: ResponsesRequest[];
} {
  const byPrompt = new Map(questions.map((q) => [q.prompt, q]));
  // A corrected transcription is graded by prompt; its answer comes from the request.
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
          results: (data.questions as { questionNumber: string; prompt: string }[]).map((q) => {
            const s = byPrompt.get(q.prompt)!;
            return {
              questionNumber: q.questionNumber,
              verdict: s.verdict,
              correctAnswer: s.key,
              workedSolution: `Worked solution for ${q.questionNumber}`,
              misconception: s.verdict === 'incorrect' ? 'a slip' : null,
              rubric: s.rubric ?? null,
              evidence: 'student work visible',
              confidence: 'high',
            };
          }),
        });
      case 'independent_verification':
        return ok({
          results: (data.questions as { questionNumber: string; prompt: string }[]).map((q) => {
            const s = byPrompt.get(q.prompt)!;
            return {
              questionNumber: q.questionNumber,
              agrees: true,
              verdict: s.verdict,
              reason: 'checked independently',
              confidence: 'high',
            };
          }),
        });
      case 'child_coaching_packet': {
        const s = byPrompt.get(data.question as string)!;
        return ok(
          {
            steps: [
              { kind: 'concept', text: 'Let’s look at this one together.' },
              { kind: 'hint', text: COACHING_TEXT[s.coaching ?? 'safe'] },
            ],
            retryPrompt: 'Give it another try.',
          },
          'gpt-6-astra',
        );
      }
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
      readObject: () => Promise.resolve(syntheticJpeg()),
      sleep: () => Promise.resolve(),
    }),
  };
}

interface Scan {
  fam: SeededFamily;
  assignmentId: string;
}

async function queuedScan(fam?: SeededFamily): Promise<Scan> {
  const family = fam ?? (await seedFamily(api.db, { childCount: 1 }));
  if (!fam) await consent(family);
  const childId = family.children[0]!.id;
  const [a] = await api.db.sql<{ id: string }[]>`
    insert into public.assignments (family_id, child_id, idempotency_key, created_by_kind, page_count, status)
    values (${family.familyId}, ${childId}, ${'scan-' + randomUUID()}, 'child', 1, 'queued') returning id`;
  const pageId = randomUUID();
  await api.db.sql`
    insert into public.source_pages (id, assignment_id, family_id, child_id, page_number, storage_path, mime_type, byte_size, sha256)
    values (${pageId}, ${a!.id}, ${family.familyId}, ${childId}, 1, ${`${family.familyId}/${childId}/${a!.id}/${pageId}.jpg`},
            'image/jpeg', ${syntheticJpeg().length},
            ${createHash('sha256').update(syntheticJpeg()).digest('hex')}) -- lead fixture update: registered bytes = stored bytes (stored-page integrity)
    `;
  await api.db.sql`
    insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, max_attempts, run_after)
    values ('scan_process', ${`scan:${a!.id}:v1`}, ${family.familyId}, ${childId},
            ${JSON.stringify({ assignmentId: a!.id, mode: 'initial' })}::text::jsonb, 5,
            ${new Date(api.now.value.getTime() - 1000)})`;
  return { fam: family, assignmentId: a!.id };
}

async function queueRecheck(scan: Scan, questionIds: string[]) {
  await api.db
    .sql`update public.assignments set status = 'checking' where id = ${scan.assignmentId}`;
  await api.db.sql`
    insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, max_attempts, run_after)
    values ('scan_process', ${`scan:${scan.assignmentId}:recheck:${randomUUID()}`}, ${scan.fam.familyId},
            ${scan.fam.children[0]!.id},
            ${JSON.stringify({ assignmentId: scan.assignmentId, mode: 'recheck', questionIds })}::text::jsonb, 5,
            ${new Date(api.now.value.getTime() - 1000)})`;
}

async function questionId(scan: Scan, prompt: string): Promise<string> {
  const [row] = await api.db.sql<{ id: string }[]>`
    select id from public.extracted_questions where assignment_id = ${scan.assignmentId} and prompt_text = ${prompt}`;
  return row!.id;
}

async function feedbackFor(qid: string) {
  return api.db.sql<{ id: string; kind: string; body: string }[]>`
    select id, kind, body from public.child_feedback where question_id = ${qid} order by created_at, body`;
}

async function systemReports(familyId: string) {
  return api.db.sql<
    {
      id: string;
      child_id: string | null;
      question_id: string | null;
      feedback_id: string | null;
      reporter_kind: string;
      category: string;
      status: string;
      note: string | null;
      screen_categories: string[] | null;
      screen_version: string | null;
      row_json: string;
    }[]
  >`
    select r.id, r.child_id, r.question_id, r.feedback_id, r.reporter_kind, r.category, r.status, r.note,
           r.screen_categories, r.screen_version, row_to_json(r)::text as row_json
      from public.safety_reports r
     where r.family_id = ${familyId} and r.reporter_kind = 'system'
     order by r.created_at`;
}

function coachedQuestions(client: { requests: ResponsesRequest[] }): string[] {
  return client.requests
    .filter((r) => r.outputName === 'child_coaching_packet')
    .map((r) => envelope(r).data.question as string);
}

// ---------------------------------------------------------------------------------------------
// Moderation before generation (scan input)
// ---------------------------------------------------------------------------------------------

describe('a severe answer in a scan (AC_SECURITY_02)', () => {
  let scan: Scan;
  let client: ReturnType<typeof scriptedModel>;
  let severeId: string;
  let runLogs: typeof api.logs;

  beforeAll(async () => {
    scan = await queuedScan();
    client = scriptedModel([MATH, SEVERE, HISTORY]);
    const report = await runJobs(deps, handlers(client));
    expect(report.succeeded).toBe(1);
    runLogs = [...api.logs];
    severeId = await questionId(scan, SEVERE.prompt);
  });

  it('sends nothing more to the model for that question: no coaching request', () => {
    const coached = coachedQuestions(client);
    expect(coached).not.toContain(SEVERE.prompt);
    // Other questions are coached as usual, including educational war content (not blocked).
    expect(coached.sort()).toEqual([MATH.prompt, HISTORY.prompt].sort());
    for (const r of client.requests.filter((x) => x.outputName === 'child_coaching_packet')) {
      expect(JSON.stringify(r.input)).not.toContain(SEVERE_ANSWER);
    }
  });

  it('shows the child the reviewed safety template instead of coaching', async () => {
    const rows = await feedbackFor(severeId);
    expect(rows.map((r) => r.kind)).toEqual(['safety']);
    expect(rows[0]!.body).toBe(childSafetyMessage(['self_harm'], '8-10'));
    expect(rows[0]!.body).toContain('988');
    expect(rows[0]!.body).not.toMatch(/alerted|notified|we told/i);
  });

  it('files exactly one escalated system report with ids and codes, never the text', async () => {
    const reports = await systemReports(scan.fam.familyId);
    expect(reports).toHaveLength(1);
    const [r] = reports;
    const [safety] = await feedbackFor(severeId);
    expect(r).toMatchObject({
      child_id: scan.fam.children[0]!.id,
      question_id: severeId,
      feedback_id: safety!.id,
      reporter_kind: 'system',
      category: 'severe_risk',
      status: 'escalated',
      note: null,
      screen_categories: ['self_harm'],
      screen_version: SAFETY_SCREEN_VERSION,
    });
    expect(r!.row_json).not.toContain(SEVERE_ANSWER);
    expect(r!.row_json).not.toContain(SEVERE.prompt);
    const audit = await api.db.sql<{ actor_kind: string; metadata: unknown }[]>`
      select actor_kind, metadata from public.audit_events where target_id = ${r!.id}`;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_kind).toBe('system');
    expect(JSON.stringify(audit[0]!.metadata)).not.toContain(SEVERE_ANSWER);
  });

  it('leaves grading unchanged and logs codes only', async () => {
    const [result] = await api.db.sql<{ verdict: string }[]>`
      select verdict from public.question_results where question_id = ${severeId}`;
    expect(result!.verdict).toBe('incorrect');
    // Decision: a severe screen does not move the scan to parent review (see scan-process.ts).
    const [a] = await api.db.sql<{ status: string }[]>`
      select status from public.assignments where id = ${scan.assignmentId}`;
    expect(a!.status).toBe('ready');
    expect(JSON.stringify(runLogs)).not.toContain(SEVERE_ANSWER);
    expect(runLogs).toContainEqual({
      level: 'warn',
      event: 'safety_screen_severe',
      code: 'SAFETY_SELF_HARM',
    });
  });

  it('a crash replay or recheck of the same transcription adds nothing', async () => {
    const before = client.requests.length;
    await queueRecheck(scan, [severeId]);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    expect(coachedQuestions({ requests: client.requests.slice(before) })).toEqual([]);
    expect((await feedbackFor(severeId)).map((r) => r.kind)).toEqual(['safety']);
    expect(await systemReports(scan.fam.familyId)).toHaveLength(1);
  });

  it('a corrected transcription is screened again: one report per transcription', async () => {
    api.now.value = new Date(api.now.value.getTime() + 60_000);
    await api.db.sql`
      update public.extracted_questions
         set corrected_student_answer_text = 'nobody would miss me', corrected_at = now(),
             corrected_by = ${scan.fam.ownerId}
       where id = ${severeId}`;
    await queueRecheck(scan, [severeId]);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    const reports = await systemReports(scan.fam.familyId);
    expect(reports).toHaveLength(2);
    expect(reports.map((r) => r.question_id)).toEqual([severeId, severeId]);
    expect(coachedQuestions(client)).not.toContain(SEVERE.prompt);
  });

  it('the child sees the safety kind through the child API contract', async () => {
    // The detail contract accepts the new kind (a strict parse would reject an unknown one).
    const parsed = childAssignmentDetailResponseSchema.safeParse({
      assignment: {
        id: scan.assignmentId,
        subjectId: null,
        status: 'ready',
        pageCount: 1,
        createdAt: '2026-09-24T15:00:00.000Z',
        updatedAt: '2026-09-24T15:00:00.000Z',
      },
      questions: [
        {
          id: severeId,
          questionNumber: '2',
          promptText: SEVERE.prompt,
          studentAnswerText: 'synthetic',
          verdict: 'incorrect',
          feedback: (await feedbackFor(severeId)).map((f) => ({
            id: f.id,
            kind: f.kind,
            body: f.body,
          })),
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('parents see it in their family report list with honest fields; other families do not', async () => {
    const token = await parentToken(scan.fam.ownerId);
    const res = await api.request('/v1/safety-reports', { token });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(SEVERE_ANSWER);
    expect(raw).not.toMatch(/self_harm|screen/i); // the matched category is admin-only
    const mine = safetyReportsResponseSchema.parse(JSON.parse(raw));
    const system = mine.reports.filter((r) => r.reporterKind === 'system');
    expect(system).toHaveLength(2);
    expect(system[0]).toMatchObject({
      category: 'severe_risk',
      status: 'escalated',
      note: null,
      questionId: severeId,
      childId: scan.fam.children[0]!.id,
    });

    // The system-only category cannot be filed by a parent.
    const forged = await api.request('/v1/safety-reports', {
      method: 'POST',
      token,
      body: { category: 'severe_risk', questionId: severeId },
    });
    expect(forged.status).toBe(400);

    const other = await seedFamily(api.db, { childCount: 1 });
    const theirs = safetyReportsResponseSchema.parse(
      await json(
        await api.request('/v1/safety-reports', { token: await parentToken(other.ownerId) }),
      ),
    );
    expect(theirs.reports).toEqual([]);
  });

  it('the owner admin queue shows it with the screen codes, and it can be resolved', async () => {
    const adminId = await seedOwnerAdmin(api.db);
    const aal2 = await parentToken(adminId, { aal: 'aal2' });
    const res = await api.request('/v1/admin/safety-reports?status=escalated', { token: aal2 });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(SEVERE_ANSWER);
    expect(raw).not.toContain(SEVERE.prompt);
    const queue = adminSafetyReportsResponseSchema.parse(JSON.parse(raw));
    const flagged = queue.reports.filter((r) => r.familyId === scan.fam.familyId);
    expect(flagged).toHaveLength(2);
    expect(flagged[0]).toMatchObject({
      reporterKind: 'system',
      category: 'severe_risk',
      screenCategories: ['self_harm'],
      hasNote: false,
      // self_harm is not held: the family list shows it at once (runbook 5.1).
      familyVisible: true,
    });
    const resolved = await api.request(`/v1/admin/safety-reports/${flagged[0]!.id}`, {
      method: 'PATCH',
      token: aal2,
      body: { status: 'resolved', resolutionNote: 'Reviewed by ids; family contacted per policy.' },
    });
    expect(resolved.status).toBe(200);
  });
});

describe('the feedback step for a graded question (moderation before generation)', () => {
  // Exactly one step per question: a severe screen always wins, so no coaching or rubric rows can
  // follow the safety template, even when a parent has overridden the verdict.
  const base = { hasPrivate: true, parentOverride: null } as const;
  it('a severe screen is always the safety step', () => {
    for (const final of ['incorrect', 'rubric', 'correct', 'needs_parent_review'] as const) {
      expect(feedbackStep({ ...base, severe: true, final })).toBe('safety');
      expect(
        feedbackStep({ severe: true, final, hasPrivate: false, parentOverride: 'correct' }),
      ).toBe('safety');
    }
  });
  it('otherwise incorrect answers are coached and written work gets rubric rows', () => {
    expect(feedbackStep({ ...base, severe: false, final: 'incorrect' })).toBe('coach');
    expect(feedbackStep({ ...base, severe: false, final: 'rubric' })).toBe('rubric');
    expect(feedbackStep({ ...base, severe: false, final: 'correct' })).toBe('none');
    expect(
      feedbackStep({ severe: false, final: 'incorrect', hasPrivate: false, parentOverride: null }),
    ).toBe('none');
    expect(
      feedbackStep({
        severe: false,
        final: 'incorrect',
        hasPrivate: true,
        parentOverride: 'correct',
      }),
    ).toBe('none');
  });
});

describe('abuse-type flags are held from the family list until the owner releases them', () => {
  let scan: Scan;
  let client: ReturnType<typeof scriptedModel>;
  let abuseId: string;
  let writingId: string;
  let runLogs: typeof api.logs;

  beforeAll(async () => {
    scan = await queuedScan();
    client = scriptedModel([ABUSE, WRITING_SEVERE, MATH]);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    runLogs = [...api.logs];
    abuseId = await questionId(scan, ABUSE.prompt);
    writingId = await questionId(scan, WRITING_SEVERE.prompt);
  });

  it('the child gets the Childhelp template, never the anger message, and no coaching', async () => {
    expect(coachedQuestions(client)).toEqual([MATH.prompt]);
    const rows = await feedbackFor(abuseId);
    expect(rows.map((r) => r.kind)).toEqual(['safety']);
    expect(rows[0]!.body).toBe(childSafetyMessage(['abuse'], '8-10'));
    expect(rows[0]!.body).toContain('1-800-422-4453');
    expect(rows[0]!.body).not.toMatch(/angry/i);
    expect(JSON.stringify(runLogs)).not.toContain(ABUSE_ANSWER);
  });

  it('severe written work gets the safety template and no rubric rows', async () => {
    const rows = await feedbackFor(writingId);
    expect(rows.map((r) => r.kind)).toEqual(['safety']);
    expect(rows[0]!.body).toContain('988');
  });

  it('the abuse report is held; the self-harm report is visible; the family sees only that one', async () => {
    const reports = await systemReports(scan.fam.familyId);
    expect(reports.map((r) => r.question_id).sort()).toEqual([abuseId, writingId].sort());
    const [held] = await api.db.sql<{ family_visible: boolean }[]>`
      select family_visible from public.safety_reports where question_id = ${abuseId}`;
    expect(held!.family_visible).toBe(false);

    const token = await parentToken(scan.fam.ownerId);
    const raw = await (await api.request('/v1/safety-reports', { token })).text();
    const list = safetyReportsResponseSchema.parse(JSON.parse(raw));
    expect(list.reports.map((r) => r.questionId)).toEqual([writingId]);
    expect(raw).not.toContain(abuseId);
  });

  it('a household member cannot find the held report through the audit log', async () => {
    const [report] = await api.db.sql<{ id: string }[]>`
      select id from public.safety_reports where question_id = ${abuseId}`;
    const audit = await api.db.sql<{ family_id: string | null; action: string }[]>`
      select family_id, action from public.audit_events where target_id = ${report!.id}`;
    expect(audit).toEqual([{ family_id: null, action: 'safety_report.created' }]);
    const seen = await api.apiDb.asParent(
      { kind: 'parent', userId: scan.fam.ownerId, sessionId: randomUUID(), aal: 'aal1' },
      (tx) =>
        tx<{ id: string }[]>`select id from public.audit_events where target_id = ${report!.id}`,
    );
    expect(seen).toEqual([]);
  });

  it('the owner admin sees it held and can release it to the family (forward only)', async () => {
    const adminId = await seedOwnerAdmin(api.db);
    const aal2 = await parentToken(adminId, { aal: 'aal2' });
    const queue = adminSafetyReportsResponseSchema.parse(
      await json(await api.request('/v1/admin/safety-reports?status=escalated', { token: aal2 })),
    );
    const held = queue.reports.find((r) => r.questionId === abuseId)!;
    expect(held).toMatchObject({ screenCategories: ['abuse'], familyVisible: false });

    for (const body of [{ familyVisible: false }, {}]) {
      const bad = await api.request(`/v1/admin/safety-reports/${held.id}`, {
        method: 'PATCH',
        token: aal2,
        body,
      });
      expect(bad.status, JSON.stringify(body)).toBe(400);
    }

    const released = await api.request(`/v1/admin/safety-reports/${held.id}`, {
      method: 'PATCH',
      token: aal2,
      body: { familyVisible: true },
    });
    expect(released.status).toBe(200);
    const after = adminSafetyReportResponseSchema.parse(await json(released)).report;
    expect(after).toMatchObject({ familyVisible: true, status: 'escalated' });

    // Releasing again is a no-op: no second audit row, no triage stamp change.
    const again = await api.request(`/v1/admin/safety-reports/${held.id}`, {
      method: 'PATCH',
      token: aal2,
      body: { familyVisible: true },
    });
    expect(again.status).toBe(200);
    expect(adminSafetyReportResponseSchema.parse(await json(again)).report).toEqual(after);

    const token = await parentToken(scan.fam.ownerId);
    const list = safetyReportsResponseSchema.parse(
      await json(await api.request('/v1/safety-reports', { token })),
    );
    expect(list.reports.map((r) => r.questionId).sort()).toEqual([abuseId, writingId].sort());
    const audit = await api.db.sql<{ action: string; metadata: unknown }[]>`
      select action, metadata from public.audit_events
       where target_id = ${held.id} and action = 'safety_report.released_to_family'`;
    expect(audit).toHaveLength(1);
  });
});

describe('parent-facing wording (contracts PARENT_SAFETY_FLAG_COPY)', () => {
  const NO_ALERT_CLAIM =
    /\b(alerted|notified|we told|has been told|will be told|we sent|we emailed|we called|your child saw|your child was shown|your child read)\b/i;
  it('is honest: flagged for a grown-up, no automatic alert, no claim about what the child saw', () => {
    expect(PARENT_SAFETY_FLAG_COPY.summary).toMatch(
      /PencilLift flagged an answer for a grown-up to look at/,
    );
    expect(PARENT_SAFETY_FLAG_COPY.summary).toMatch(/PencilLift sent no automatic alert/);
    const all = Object.values(PARENT_SAFETY_FLAG_COPY).join(' ');
    expect(all).not.toMatch(NO_ALERT_CLAIM);
    expect(PARENT_SAFETY_FLAG_COPY.resources).toContain('988');
    expect(PARENT_SAFETY_FLAG_COPY.resources).toContain('1-800-422-4453');
    expect(PARENT_SAFETY_FLAG_COPY.resources).toContain('911');
    const described = [
      PARENT_SAFETY_FLAG_COPY.category,
      PARENT_SAFETY_FLAG_COPY.reporter,
      PARENT_SAFETY_FLAG_COPY.summary,
    ].join(' ');
    expect(described).not.toMatch(/abuse|suicid|self-harm|sexual|violen|threat/i);
  });
});

describe('educational content is not blocked', () => {
  it('a history answer about war is coached and files no report', async () => {
    const scan = await queuedScan();
    const client = scriptedModel([HISTORY]);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    expect(coachedQuestions(client)).toEqual([HISTORY.prompt]);
    const rows = await feedbackFor(await questionId(scan, HISTORY.prompt));
    expect(rows.map((r) => r.kind)).not.toContain('safety');
    expect(rows.map((r) => r.kind)).not.toContain('template_fallback');
    expect(await systemReports(scan.fam.familyId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Moderation after generation
// ---------------------------------------------------------------------------------------------

describe('moderation after generation', () => {
  it('a companion-persona or ungrounded coaching packet falls back to the reviewed template', async () => {
    const scan = await queuedScan();
    const client = scriptedModel([COMPANION, UNGROUNDED]);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    expect(coachedQuestions(client).sort()).toEqual([COMPANION.prompt, UNGROUNDED.prompt].sort());
    for (const q of [COMPANION, UNGROUNDED]) {
      const rows = await feedbackFor(await questionId(scan, q.prompt));
      expect(rows).toEqual([
        expect.objectContaining({ kind: 'template_fallback', body: TEMPLATE_FALLBACK }),
      ]);
    }
    expect(api.logs).toContainEqual({
      level: 'warn',
      event: 'coaching_blocked_by_safety',
      code: 'SAFETY_COMPANION_PERSONA',
    });
    expect(api.logs).toContainEqual({
      level: 'warn',
      event: 'coaching_blocked_by_safety',
      code: 'SAFETY_UNGROUNDED_TOPIC',
    });
    // A model's bad output is a model problem, not a child at risk: no family report.
    expect(await systemReports(scan.fam.familyId)).toEqual([]);
    expect(JSON.stringify(api.logs)).not.toMatch(/best friend|soldiers/);
  });

  it('a rubric label that fails the screen is dropped; safe labels remain', async () => {
    const scan = await queuedScan();
    const client = scriptedModel([WRITING]);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    const rows = await feedbackFor(await questionId(scan, WRITING.prompt));
    const bodies = rows.map((r) => r.body);
    expect(bodies).toContain('You did this well: Uses capital letters.');
    expect(bodies).toContain('Next time, work on: Writes about one season.');
    expect(bodies.join(' ')).not.toMatch(/secret/i);
    expect(api.logs).toContainEqual({
      level: 'warn',
      event: 'rubric_label_blocked_by_safety',
      code: 'SAFETY_SECRECY',
    });
  });

  describe('practice personalization', () => {
    const wordProblems = generateSkillItems('math.word_problems', {
      random: seededRandom('safety'),
      grade: 3,
      category: 'standard',
      count: 3,
    });

    it('drops a companion intro and story contexts that fail the screen; keeps a safe one', async () => {
      const fam = await seedFamily(api.db, { childCount: 1 });
      await consent(fam);
      const ctx = await api.apiDb.asService((tx) =>
        loadChildContext(tx, fam.familyId, fam.children[0]!.id),
      );
      const client = createMockResponsesClient((request) => {
        const refs = (envelope(request).data.wordProblems as { ref: string }[]).map((w) => w.ref);
        return {
          kind: 'ok',
          text: JSON.stringify({
            intro: 'You can always talk to me about anything',
            items: [
              { ref: refs[0], context: { name: 'Nia', things: 'naked selfies', place: 'park' } },
              { ref: refs[1], context: { name: 'Nia', things: 'vodka bottles', place: 'park' } },
              { ref: refs[2], context: { name: 'Nia', things: 'shells', place: 'tide pool' } },
            ],
          }),
          usage: { inputTokens: 900, cachedInputTokens: 0, outputTokens: 200 },
          modelId: 'gpt-6-astra',
          latencyMs: 20,
        };
      });
      const out = await personalizeItems(deps, { ai: client }, ctx!, wordProblems, 'daily_set', [
        'math.word_problems',
      ]);
      expect(client.requests).toHaveLength(1);
      expect(out.intro).toBeNull();
      expect(out.items[0]).toEqual(wordProblems[0]);
      expect(out.items[1]).toEqual(wordProblems[1]);
      expect(out.items[2]!.prompt.text).toContain('Nia');
      expect(out.rethemed).toBe(1);
      const codes = api.logs
        .filter((l) => l.event === 'practice_ai_blocked_by_safety')
        .map((l) => l.code)
        .sort();
      expect(codes).toEqual([
        'SAFETY_COMPANION_PERSONA',
        'SAFETY_SEXUAL',
        'SAFETY_UNGROUNDED_TOPIC',
      ]);
      expect(JSON.stringify(api.logs)).not.toMatch(/naked|vodka|talk to me/);
    });
  });
});
