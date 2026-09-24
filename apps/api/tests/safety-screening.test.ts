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
import {
  childSafetyMessage,
  SAFETY_SCREEN_VERSION,
  SAFETY_TEMPLATES_VERSION,
} from '@pencillift/domain/safety';
import {
  grantAdultUnlock,
  seedFamily,
  seedOwnerAdmin,
  type SeededFamily,
} from '@pencillift/db/testing/fixtures';
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
// RV-child-safety-1: a first-person disclosure in a reading answer (subject and cue "story").
const READING_DISCLOSURE_ANSWER = 'I was a victim of rape';
const READING_DISCLOSURE: ScriptedQuestion = {
  number: '9',
  prompt: 'Who is the hero of the story?',
  answer: READING_DISCLOSURE_ANSWER,
  kind: 'open_response',
  subject: 'reading',
  key: 'The girl who saves the town.',
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

function scriptedModel(
  questions: ScriptedQuestion[],
  options: { failGrading?: boolean } = {},
): ResponsesClient & {
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
        // Schema-invalid output on every attempt (a provider outage looks the same to the job).
        if (options.failGrading) return ok({ nonsense: true });
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

/** Every grading or verification request that carried `text` anywhere in its input. */
function gradingRequestsWith(client: { requests: ResponsesRequest[] }, text: string) {
  return client.requests.filter(
    (r) =>
      (r.outputName === 'private_grading' || r.outputName === 'independent_verification') &&
      JSON.stringify(r.input).includes(text),
  );
}

let pairCount = 0;
/** A paired child session for the family's first child (the parent needs a recent unlock). */
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

/** Every report in the owner admin queue for `query`, following `nextCursor` page by page. */
async function adminQueue(token: string, query = '') {
  const reports: ReturnType<typeof adminSafetyReportsResponseSchema.parse>['reports'] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams(query);
    if (after !== null) params.set('after', after);
    const res = await api.request(`/v1/admin/safety-reports?${params.toString()}`, { token });
    expect(res.status).toBe(200);
    const body = adminSafetyReportsResponseSchema.parse(await res.json());
    reports.push(...body.reports);
    if (body.nextCursor === null) return reports;
    after = body.nextCursor;
  }
  throw new Error('admin queue did not end');
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

  it('screens before grading: the severe answer reaches no grading or verification model (RV-child-safety-5)', () => {
    // Threat model T33: severe → no AI call for that question. The other questions are graded.
    expect(gradingRequestsWith(client, SEVERE_ANSWER)).toEqual([]);
    const graded = client.requests.filter((r) => r.outputName === 'private_grading');
    expect(graded).toHaveLength(1);
    expect(JSON.stringify(graded[0]!.input)).toContain(MATH.prompt);
    expect(JSON.stringify(graded[0]!.input)).not.toContain(SEVERE.prompt);
  });

  it('records no model grade or solution for the flagged answer and logs codes only', async () => {
    // Decision (RV-child-safety-5): a flagged question is not graded (no verdict, no worked
    // solution for a disclosure). The scan's status follows the other questions, so a held flag is
    // never announced to the household as "needs your review".
    expect(
      await api.db.sql`select verdict from public.question_results where question_id = ${severeId}`,
    ).toEqual([]);
    expect(
      await api.db.sql`select 1 from private.question_solutions where question_id = ${severeId}`,
    ).toEqual([]);
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
      // The answer this report flagged was corrected later (the second report is for the edit).
      transcriptionCorrected: true,
    });
    expect(flagged[1]).toMatchObject({ transcriptionCorrected: false });
    const resolved = await api.request(`/v1/admin/safety-reports/${flagged[0]!.id}`, {
      method: 'PATCH',
      token: aal2,
      body: { status: 'resolved', resolutionNote: 'Reviewed by ids; family contacted per policy.' },
    });
    expect(resolved.status).toBe(200);
  });
});

describe('first-person disclosures are never educational (RV-child-safety-1)', () => {
  it('a first-person disclosure in a reading answer is never coached', async () => {
    const scan = await queuedScan();
    const client = scriptedModel([READING_DISCLOSURE, MATH]);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    expect(coachedQuestions(client)).toEqual([MATH.prompt]);
    expect(gradingRequestsWith(client, READING_DISCLOSURE_ANSWER)).toEqual([]);
    const id = await questionId(scan, READING_DISCLOSURE.prompt);
    expect((await feedbackFor(id)).map((r) => r.kind)).toEqual(['safety']);
    const reports = await systemReports(scan.fam.familyId);
    expect(reports.map((r) => r.screen_categories)).toEqual([['abuse']]);
    expect(JSON.stringify(api.logs)).not.toContain(READING_DISCLOSURE_ANSWER);
  });
});

describe('the safety response does not depend on grading (RV-child-safety-5)', () => {
  it('a scan whose grading fails permanently still files the safety template and report', async () => {
    const scan = await queuedScan();
    const client = scriptedModel([MATH, SEVERE], { failGrading: true });
    const severeRun = await runJobs(deps, handlers(client));
    expect(severeRun.retried).toBe(1);
    const severeId = await questionId(scan, SEVERE.prompt);
    // Filed on the first attempt, before any grading call.
    expect((await feedbackFor(severeId)).map((r) => r.kind)).toEqual(['safety']);
    expect(await systemReports(scan.fam.familyId)).toHaveLength(1);
    // Grading keeps failing until the job gives up; nothing is duplicated.
    for (let i = 0; i < 8; i += 1) {
      api.now.value = new Date(api.now.value.getTime() + 6 * 3_600_000);
      await runJobs(deps, handlers(client));
    }
    const [a] = await api.db.sql<{ status: string }[]>`
      select status from public.assignments where id = ${scan.assignmentId}`;
    expect(a!.status).toBe('failed_final');
    expect((await feedbackFor(severeId)).map((r) => r.kind)).toEqual(['safety']);
    expect(await systemReports(scan.fam.familyId)).toHaveLength(1);
    expect(gradingRequestsWith(client, SEVERE_ANSWER)).toEqual([]);
  });
});

describe('the child sees the safety notice as soon as it is filed (RV-child-safety-5, end to end)', () => {
  const childDetail = async (scan: Scan, token: string) => {
    const res = await api.request(`/v1/child/assignments/${scan.assignmentId}`, { token });
    expect(res.status).toBe(200);
    return childAssignmentDetailResponseSchema.parse(await res.json());
  };

  it('while grading waits for a retry and after it failed for good', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    await consent(fam);
    const { child } = await childSession(fam);
    const scan = await queuedScan(fam);
    const client = scriptedModel([MATH, SEVERE], { failGrading: true });
    expect((await runJobs(deps, handlers(client))).retried).toBe(1);
    const severeId = await questionId(scan, SEVERE.prompt);
    const mathId = await questionId(scan, MATH.prompt);
    const during = await childDetail(scan, child);
    // Grading failed once and waits for its retry: no results are visible yet.
    expect(during.assignment.status).toBe('failed_retryable');
    const flagged = during.questions.find((q) => q.id === severeId)!;
    expect(flagged.feedback.map((f) => f.kind)).toEqual(['safety']);
    expect(flagged.feedback[0]!.body).toBe(childSafetyMessage(['self_harm'], '8-10'));
    expect(flagged.verdict).toBeNull();
    // Nothing else is shown before results: no verdict and no feedback on the other question.
    expect(during.questions.find((q) => q.id === mathId)).toMatchObject({
      verdict: null,
      feedback: [],
    });
    for (let i = 0; i < 8; i += 1) {
      api.now.value = new Date(api.now.value.getTime() + 6 * 3_600_000);
      await runJobs(deps, handlers(client));
    }
    // Two days later the first access token has expired; the child signs in again.
    const after = await childDetail(scan, (await childSession(fam)).child);
    expect(after.assignment.status).toBe('failed_final');
    expect(after.questions.find((q) => q.id === severeId)!.feedback.map((f) => f.kind)).toEqual([
      'safety',
    ]);
    expect(after.questions.find((q) => q.id === mathId)).toMatchObject({
      verdict: null,
      feedback: [],
    });
  });

  it('after a correction: shown while the recheck waits, and once after it', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    await consent(fam);
    const childId = fam.children[0]!.id;
    await api.db.sql`
      insert into public.family_capacity (family_id, paid_slots, managing_channel)
      values (${fam.familyId}, 1, 'app_store')`;
    await api.db.sql`
      insert into public.child_slot_assignments (family_id, child_id) values (${fam.familyId}, ${childId})`;
    const { parent, child } = await childSession(fam);
    const scan = await queuedScan(fam);
    const client = scriptedModel([ABUSE, MATH]);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    const abuseId = await questionId(scan, ABUSE.prompt);
    const notice = childSafetyMessage(['abuse'], '8-10');
    const flaggedFeedback = async () =>
      (await childDetail(scan, child)).questions
        .find((q) => q.id === abuseId)!
        .feedback.map((f) => [f.kind, f.body]);
    expect(await flaggedFeedback()).toEqual([['safety', notice]]);

    api.now.value = new Date(api.now.value.getTime() + 60_000);
    const corrected = await api.request(`/v1/questions/${abuseId}/correction`, {
      method: 'POST',
      token: parent,
      body: { studentAnswerText: 'my dad helps me' },
    });
    expect(corrected.status).toBe(200);
    // The recheck has not run yet: the scan is being checked again and the notice stays.
    const waiting = await childDetail(scan, child);
    expect(waiting.assignment.status).not.toBe('ready');
    expect(await flaggedFeedback()).toEqual([['safety', notice]]);

    api.now.value = new Date(api.now.value.getTime() + 60_000);
    await api.db.sql`
      update public.jobs set run_after = ${new Date(api.now.value.getTime() - 1000)}
       where family_id = ${fam.familyId} and status = 'queued'`;
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    // The recheck copied the template for the corrected transcription: still one notice.
    expect(await flaggedFeedback()).toEqual([['safety', notice]]);
  });
});

describe('a correction keeps the safety notice of a flagged question (RV-child-safety-7)', () => {
  it('the child still sees the safety template, the tutor is not called, the admin sees the edit', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    await consent(fam);
    const childId = fam.children[0]!.id;
    await api.db.sql`
      insert into public.family_capacity (family_id, paid_slots, managing_channel)
      values (${fam.familyId}, 1, 'app_store')`;
    await api.db.sql`
      insert into public.child_slot_assignments (family_id, child_id) values (${fam.familyId}, ${childId})`;
    const { parent, child } = await childSession(fam);
    const scan = await queuedScan(fam);
    const client = scriptedModel([ABUSE, MATH]);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    const abuseId = await questionId(scan, ABUSE.prompt);
    const childView = async () => {
      const res = await api.request(`/v1/child/assignments/${scan.assignmentId}`, { token: child });
      expect(res.status).toBe(200);
      const detail = childAssignmentDetailResponseSchema.parse(await res.json());
      return detail.questions.find((q) => q.id === abuseId)!;
    };
    expect((await childView()).feedback.map((f) => f.kind)).toEqual(['safety']);

    api.now.value = new Date(api.now.value.getTime() + 60_000);
    const corrected = await api.request(`/v1/questions/${abuseId}/correction`, {
      method: 'POST',
      token: parent,
      body: { studentAnswerText: 'my dad helps me' },
    });
    expect(corrected.status).toBe(200);
    api.now.value = new Date(api.now.value.getTime() + 60_000);
    await api.db.sql`
      update public.jobs set run_after = ${new Date(api.now.value.getTime() - 1000)}
       where family_id = ${fam.familyId} and status = 'queued'`;
    const before = client.requests.length;
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);

    const after = await childView();
    expect(after.studentAnswerText).toBe('my dad helps me');
    expect(after.feedback.map((f) => f.kind)).toEqual(['safety']);
    expect(after.feedback[0]!.body).toBe(childSafetyMessage(['abuse'], '8-10'));
    expect(coachedQuestions({ requests: client.requests.slice(before) })).toEqual([]);
    // Still one report (the corrected text is not a new disclosure); the admin sees the edit.
    expect(await systemReports(fam.familyId)).toHaveLength(1);
    const adminId = await seedOwnerAdmin(api.db);
    const aal2 = await parentToken(adminId, { aal: 'aal2' });
    const queue = await adminQueue(aal2, 'status=escalated');
    expect(queue.find((r) => r.questionId === abuseId)).toMatchObject({
      familyVisible: false,
      transcriptionCorrected: true,
    });
  });
});

describe('a child’s "Get help" report on a held flag (RV-child-safety-6)', () => {
  it('is held with the flag: the family list does not show the flagged question', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    await consent(fam);
    const { parent, child } = await childSession(fam);
    const scan = await queuedScan(fam);
    expect((await runJobs(deps, handlers(scriptedModel([ABUSE, MATH])))).succeeded).toBe(1);
    const abuseId = await questionId(scan, ABUSE.prompt);
    const [safety] = await feedbackFor(abuseId);
    const filed = await api.request('/v1/child/reports', {
      method: 'POST',
      token: child,
      body: { category: 'upsetting', questionId: abuseId, feedbackId: safety!.id },
    });
    expect(filed.status).toBe(201);
    const raw = await (await api.request('/v1/safety-reports', { token: parent })).text();
    expect(raw).not.toContain(abuseId);
    expect(safetyReportsResponseSchema.parse(JSON.parse(raw)).reports).toEqual([]);
    // The reviewer sees both, held, and can release each (forward only).
    const adminId = await seedOwnerAdmin(api.db);
    const aal2 = await parentToken(adminId, { aal: 'aal2' });
    const queue = await adminQueue(aal2, 'status=open');
    const childReport = queue.find((r) => r.questionId === abuseId && r.reporterKind === 'child');
    expect(childReport).toMatchObject({ familyVisible: false, category: 'upsetting' });
    const released = await api.request(`/v1/admin/safety-reports/${childReport!.id}`, {
      method: 'PATCH',
      token: aal2,
      body: { familyVisible: true },
    });
    expect(released.status).toBe(200);
    const list = safetyReportsResponseSchema.parse(
      await json(await api.request('/v1/safety-reports', { token: parent })),
    );
    expect(list.reports.map((r) => [r.reporterKind, r.questionId])).toEqual([['child', abuseId]]);
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
    const queue = await adminQueue(aal2, 'status=escalated');
    const held = queue.find((r) => r.questionId === abuseId)!;
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
      PARENT_SAFETY_FLAG_COPY.cleared,
    ].join(' ');
    // Round 3: a cleared flag says what changed for the child, and still claims no alert.
    expect(PARENT_SAFETY_FLAG_COPY.cleared).toMatch(/not a concern/);
    expect(PARENT_SAFETY_FLAG_COPY.cleared).toMatch(/no longer show the message/);
    expect(described).not.toMatch(/abuse|suicid|self-harm|sexual|violen|threat/i);
  });

  it('is approved with the child templates: a wording change needs a new template version', () => {
    // RV-child-safety-14: Owner action #24 approves this wording together with the child templates
    // (SAFETY_TEMPLATES_VERSION); the digest is pinned per version.
    const digest = createHash('sha256')
      .update(JSON.stringify(PARENT_SAFETY_FLAG_COPY))
      .digest('hex');
    // A new version adds a line here (never edit an existing one) and needs a new approval.
    const PINNED: Readonly<Record<string, string>> = {
      'safety-templates.v2': '547e9cfe6c51df40d0ddd377ac5e6a53e23800544b977f9227aec29df10da1d3',
      // v3 (round 3): `cleared` for a visible flag a reviewer cleared as a false match.
      'safety-templates.v3': '6512da2f8739561d559ada52dc55a6cb9391d83f0d1a05ca583a64b457d30853',
    };
    expect({ version: SAFETY_TEMPLATES_VERSION, digest }).toEqual({
      version: SAFETY_TEMPLATES_VERSION,
      digest: PINNED[SAFETY_TEMPLATES_VERSION],
    });
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

// Runs last: it fills the queue with 201 reports.
describe('the admin queue reaches every report (RV-child-safety-9)', () => {
  it('pages past the first 200 escalated reports with a cursor', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const childId = fam.children[0]!.id;
    const [a] = await api.db.sql<{ id: string }[]>`
      insert into public.assignments (family_id, child_id, idempotency_key, created_by_kind)
      values (${fam.familyId}, ${childId}, ${'k-' + randomUUID()}, 'child') returning id`;
    const pageId = randomUUID();
    await api.db.sql`
      insert into public.source_pages (id, assignment_id, family_id, child_id, page_number, storage_path, mime_type, byte_size, sha256)
      values (${pageId}, ${a!.id}, ${fam.familyId}, ${childId}, 1,
              ${`${fam.familyId}/${childId}/${a!.id}/${pageId}.jpg`}, 'image/jpeg', 10, ${'c'.repeat(64)})`;
    const [q] = await api.db.sql<{ id: string }[]>`
      insert into public.extracted_questions (assignment_id, family_id, child_id, page_id, question_number, prompt_text,
                                              student_answer_text, answer_kind, subject_key, skill)
      values (${a!.id}, ${fam.familyId}, ${childId}, ${pageId}, '1', 'Synthetic prompt', 'synthetic', 'open_response', 'science', 's')
      returning id`;
    // 200 older escalated system reports (one question, a transcription each), all at one instant
    // so the cursor must break ties by id, then one new held abuse report.
    const old = new Date(api.now.value.getTime() - 86_400_000);
    await api.db.sql`
      insert into public.safety_reports (family_id, child_id, reporter_kind, category, question_id, status,
                                         transcription_at, screen_categories, screen_version, created_at)
      select ${fam.familyId}, ${childId}, 'system', 'severe_risk', ${q!.id}, 'escalated',
             ${old}::timestamptz + make_interval(secs => n), array['violence'], ${SAFETY_SCREEN_VERSION}, ${old}
        from generate_series(1, 200) as n`;
    const [newest] = await api.db.sql<{ id: string }[]>`
      insert into public.safety_reports (family_id, child_id, reporter_kind, category, question_id, status,
                                         transcription_at, screen_categories, screen_version, family_visible)
      values (${fam.familyId}, ${childId}, 'system', 'severe_risk', ${q!.id}, 'escalated',
              ${api.now.value}, array['abuse'], ${SAFETY_SCREEN_VERSION}, false)
      returning id`;

    const adminId = await seedOwnerAdmin(api.db);
    const aal2 = await parentToken(adminId, { aal: 'aal2' });
    const seen = new Set<string>();
    let path: string | null = '/v1/admin/safety-reports?status=escalated';
    let pages = 0;
    while (path !== null && pages < 10) {
      const res = await api.request(path, { token: aal2 });
      expect(res.status).toBe(200);
      const page = adminSafetyReportsResponseSchema.parse(await res.json());
      expect(page.reports.length).toBeLessThanOrEqual(200);
      for (const r of page.reports) {
        expect(seen.has(r.id)).toBe(false); // no report twice
        seen.add(r.id);
      }
      pages += 1;
      path =
        page.nextCursor === null
          ? null
          : `/v1/admin/safety-reports?status=escalated&after=${encodeURIComponent(page.nextCursor)}`;
    }
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(seen.has(newest!.id)).toBe(true);
    const mine = await api.db.sql<{ id: string }[]>`
      select id from public.safety_reports where family_id = ${fam.familyId}`;
    for (const r of mine) expect(seen.has(r.id)).toBe(true);
    // A malformed cursor is refused, not ignored.
    expect(
      (await api.request('/v1/admin/safety-reports?after=not-a-cursor', { token: aal2 })).status,
    ).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
// Round 3 (CHK2-CS-5; spec P4 "human review procedures"): a reviewer clears a false match
// ---------------------------------------------------------------------------------------------

// Documented false matches (packages/domain/src/safety/corpus.ts REVIEWER_CLEARED_PASS5 and index.ts
// KNOWN LIMITS): everyday words that are also a disclosure, so the screen escalates them by design.
const HELD_FALSE_MATCH_ANSWER = 'They don’t give me food I don’t like';
const HELD_FALSE_MATCH: ScriptedQuestion = {
  number: '10',
  prompt: 'Write one sentence about dinner at your house.',
  answer: HELD_FALSE_MATCH_ANSWER,
  kind: 'open_response',
  subject: 'grammar_writing',
  key: 'A complete sentence about dinner.',
  verdict: 'incorrect',
  coaching: 'safe',
};
const VISIBLE_FALSE_MATCH_ANSWER = 'please kill me now, this homework is so long';
const VISIBLE_FALSE_MATCH: ScriptedQuestion = {
  number: '11',
  prompt: 'Write one sentence about your homework tonight.',
  answer: VISIBLE_FALSE_MATCH_ANSWER,
  kind: 'open_response',
  subject: 'grammar_writing',
  key: 'A complete sentence about homework.',
  verdict: 'incorrect',
  coaching: 'safe',
};

// Round 4 (CHK3-CS-7): written work flagged by a word match, graded with rubric rows once cleared.
const WRITING_FALSE_MATCH_ANSWER = 'This homework is so long, please kill me now. I like fall.';
const WRITING_FALSE_MATCH: ScriptedQuestion = {
  number: '12',
  prompt: 'Write two sentences about your homework tonight.',
  answer: WRITING_FALSE_MATCH_ANSWER,
  kind: 'writing',
  subject: 'grammar_writing',
  key: 'Two complete sentences about homework.',
  verdict: 'rubric',
  rubric: [
    { criterion: 'Uses capital letters', met: true, note: 'Both start with capitals.' },
    { criterion: 'Writes about homework', met: false, note: 'Stay on the topic.' },
  ],
};

describe('a reviewer clears a false match (round 3, CHK2-CS-5)', () => {
  type ErrorBody = { error: { code: string; rule?: string } };
  const childDetail = async (scan: Scan, token: string) => {
    const res = await api.request(`/v1/child/assignments/${scan.assignmentId}`, { token });
    expect(res.status).toBe(200);
    return childAssignmentDetailResponseSchema.parse(await res.json());
  };
  const dueNow = async (fam: SeededFamily) => {
    api.now.value = new Date(api.now.value.getTime() + 60_000);
    await api.db.sql`
      update public.jobs set run_after = ${new Date(api.now.value.getTime() - 1000)}
       where family_id = ${fam.familyId} and status = 'queued'`;
  };
  const adminToken = async () => parentToken(await seedOwnerAdmin(api.db), { aal: 'aal2' });
  const patch = (token: string, id: string, body: unknown) =>
    api.request(`/v1/admin/safety-reports/${id}`, { method: 'PATCH', token, body });
  const CLEAR = {
    status: 'resolved',
    resolutionNote: 'SYNTHETIC: false match (screen code ABUSE_NEGLECT_NOT_FED); a house rule.',
    resolution: 'false_match',
  } as const;
  async function paidSlot(fam: SeededFamily) {
    await api.db.sql`
      insert into public.family_capacity (family_id, paid_slots, managing_channel)
      values (${fam.familyId}, 1, 'app_store')`;
    await api.db.sql`
      insert into public.child_slot_assignments (family_id, child_id)
      values (${fam.familyId}, ${fam.children[0]!.id})`;
  }

  it('a held flag: the child’s notice goes, the question is graded, the family never learns of it', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    await consent(fam);
    const { parent, child } = await childSession(fam);
    const scan = await queuedScan(fam);
    const client = scriptedModel([HELD_FALSE_MATCH, MATH]);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    const flaggedId = await questionId(scan, HELD_FALSE_MATCH.prompt);
    const flagged = async () =>
      (await childDetail(scan, child)).questions.find((q) => q.id === flaggedId)!;
    expect((await flagged()).feedback.map((f) => f.kind)).toEqual(['safety']);
    expect(gradingRequestsWith(client, HELD_FALSE_MATCH_ANSWER)).toEqual([]);

    const aal2 = await adminToken();
    const [held] = (await adminQueue(aal2, 'status=escalated')).filter(
      (r) => r.questionId === flaggedId,
    );
    expect(held).toMatchObject({
      screenCategories: ['abuse'],
      familyVisible: false,
      resolution: null,
    });

    // A clearance is part of resolving and is never combined with a release.
    expect((await patch(aal2, held!.id, { resolution: 'false_match' })).status).toBe(400);
    expect((await patch(aal2, held!.id, { ...CLEAR, familyVisible: true })).status).toBe(400);

    const cleared = await patch(aal2, held!.id, CLEAR);
    expect(cleared.status).toBe(200);
    const body = adminSafetyReportResponseSchema.parse(await json(cleared));
    expect(body.recheck).toBe('queued');
    expect(body.report).toMatchObject({
      status: 'resolved',
      resolution: 'false_match',
      familyVisible: false,
    });

    // (a) At once, before the recheck runs: the child no longer sees the notice.
    const waiting = await childDetail(scan, child);
    expect(waiting.assignment.status).toBe('checking');
    expect(waiting.questions.find((q) => q.id === flaggedId)!.feedback).toEqual([]);

    // (c) The held flag is never released, and a second clearance is refused (resolved is final).
    const release = await patch(aal2, held!.id, { familyVisible: true });
    expect(release.status).toBe(422);
    expect((await json<ErrorBody>(release)).error.rule).toBe('FALSE_MATCH_NOT_RELEASABLE');
    const again = await patch(aal2, held!.id, CLEAR);
    expect(again.status).toBe(422);
    expect((await json<ErrorBody>(again)).error.rule).toBe('INVALID_TRANSITION');

    // (b) The recheck grades the question normally with the labeled mock AI, files no new report
    // and no new notice.
    const before = client.requests.length;
    await dueNow(fam);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    const recheckRequests = { requests: client.requests.slice(before) };
    expect(gradingRequestsWith(recheckRequests, HELD_FALSE_MATCH_ANSWER).length).toBeGreaterThan(0);
    expect(coachedQuestions(recheckRequests)).toEqual([HELD_FALSE_MATCH.prompt]);
    expect(
      await api.db
        .sql`select verdict from public.question_results where question_id = ${flaggedId}`,
    ).toEqual([{ verdict: 'incorrect' }]);
    expect(await systemReports(fam.familyId)).toHaveLength(1);
    expect((await feedbackFor(flaggedId)).filter((r) => r.kind === 'safety')).toHaveLength(1);
    const graded = await flagged();
    expect(graded.verdict).toBe('incorrect');
    expect(graded.feedback.length).toBeGreaterThan(0);
    expect(graded.feedback.map((f) => f.kind)).not.toContain('safety');
    expect(api.logs).toContainEqual({
      level: 'info',
      event: 'safety_flag_cleared_graded',
      code: 'SAFETY_CLEARED',
    });

    // (c) The family's list and audit log never show the held report.
    const raw = await (await api.request('/v1/safety-reports', { token: parent })).text();
    expect(safetyReportsResponseSchema.parse(JSON.parse(raw)).reports).toEqual([]);
    expect(raw).not.toContain(held!.id);
    const audit = await api.db.sql<
      { family_id: string | null; action: string; metadata: unknown }[]
    >`
      select family_id, action, metadata from public.audit_events where target_id = ${held!.id} order by id`;
    expect(audit.map((a) => [a.family_id, a.action])).toEqual([
      [null, 'safety_report.created'],
      [null, 'safety_report.updated'],
    ]);
    expect(audit[1]!.metadata).toEqual({
      from: 'escalated',
      to: 'resolved',
      resolution: 'false_match',
      recheck: 'queued',
    });

    // (d) Nothing about the answer text is stored with the clearance or logged.
    const [row] = await api.db.sql<{ row_json: string }[]>`
      select row_to_json(r)::text as row_json from public.safety_reports r where id = ${held!.id}`;
    expect(row!.row_json).not.toContain('food');
    expect(JSON.stringify(api.logs)).not.toContain(HELD_FALSE_MATCH_ANSWER);
    expect(JSON.stringify(audit)).not.toContain('food');
  });

  it('a visible flag: the family list says it was cleared; a new transcription is screened afresh', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    await consent(fam);
    await paidSlot(fam);
    const { parent, child } = await childSession(fam);
    const scan = await queuedScan(fam);
    const client = scriptedModel([VISIBLE_FALSE_MATCH, MATH]);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    const flaggedId = await questionId(scan, VISIBLE_FALSE_MATCH.prompt);
    const familyList = async () =>
      safetyReportsResponseSchema
        .parse(await json(await api.request('/v1/safety-reports', { token: parent })))
        .reports.filter((r) => r.reporterKind === 'system');
    expect(await familyList()).toMatchObject([
      { status: 'escalated', questionId: flaggedId, clearedAsFalseMatch: false },
    ]);

    const aal2 = await adminToken();
    const [flag] = (await adminQueue(aal2, 'status=escalated')).filter(
      (r) => r.questionId === flaggedId,
    );
    expect(flag).toMatchObject({ screenCategories: ['self_harm'], familyVisible: true });
    const cleared = await patch(aal2, flag!.id, {
      ...CLEAR,
      resolutionNote: 'SYNTHETIC: false match (screen code SELF_HARM_KILL_ME); homework hyperbole.',
    });
    expect(cleared.status).toBe(200);
    expect(adminSafetyReportResponseSchema.parse(await json(cleared)).recheck).toBe('queued');
    await dueNow(fam);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    expect(await familyList()).toMatchObject([
      { status: 'resolved', questionId: flaggedId, clearedAsFalseMatch: true },
    ]);
    const graded = (await childDetail(scan, child)).questions.find((q) => q.id === flaggedId)!;
    expect(graded.verdict).toBe('incorrect');
    expect(graded.feedback.map((f) => f.kind)).not.toContain('safety');

    // The clearance is that transcription's only: a grown-up's correction to a new severe answer is
    // screened again, flagged with a new report and not graded.
    api.now.value = new Date(api.now.value.getTime() + 60_000);
    const corrected = await api.request(`/v1/questions/${flaggedId}/correction`, {
      method: 'POST',
      token: parent,
      body: { studentAnswerText: SEVERE_ANSWER },
    });
    expect(corrected.status).toBe(200);
    const before = client.requests.length;
    await dueNow(fam);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    expect(gradingRequestsWith({ requests: client.requests.slice(before) }, SEVERE_ANSWER)).toEqual(
      [],
    );
    const reports = await systemReports(fam.familyId);
    expect(reports.map((r) => r.status)).toEqual(['resolved', 'escalated']);
    const reflagged = (await childDetail(scan, child)).questions.find((q) => q.id === flaggedId)!;
    expect(reflagged.feedback.map((f) => f.kind)).toEqual(['safety']);
    expect(reflagged.feedback[0]!.body).toBe(childSafetyMessage(['self_harm'], '8-10'));
  });

  it('a scan waiting for its retry is graded by the retry; a scan still being checked is refused', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    await consent(fam);
    const scan = await queuedScan(fam);
    const failing = scriptedModel([VISIBLE_FALSE_MATCH, MATH], { failGrading: true });
    expect((await runJobs(deps, handlers(failing))).retried).toBe(1);
    const flaggedId = await questionId(scan, VISIBLE_FALSE_MATCH.prompt);
    const aal2 = await adminToken();
    const [flag] = (await adminQueue(aal2, 'status=escalated')).filter(
      (r) => r.questionId === flaggedId,
    );

    // Mid-run (the retry is extracting or checking) a clearance could miss the pre-grading screen.
    await api.db
      .sql`update public.assignments set status = 'queued' where id = ${scan.assignmentId}`;
    const busy = await patch(aal2, flag!.id, CLEAR);
    expect(busy.status).toBe(422);
    expect((await json<ErrorBody>(busy)).error.rule).toBe('SCAN_STILL_CHECKING');
    const [still] = await api.db.sql<{ status: string; resolution: string | null }[]>`
      select status, resolution from public.safety_reports where id = ${flag!.id}`;
    expect(still).toEqual({ status: 'escalated', resolution: null });
    // Back to waiting for the retry (queued → extracting → failed_retryable, as a failed run does).
    for (const status of ['extracting', 'failed_retryable']) {
      await api.db
        .sql`update public.assignments set status = ${status} where id = ${scan.assignmentId}`;
    }

    const cleared = await patch(aal2, flag!.id, CLEAR);
    expect(cleared.status).toBe(200);
    expect(adminSafetyReportResponseSchema.parse(await json(cleared)).recheck).toBe('on_retry');
    // The scan's own retry (a working model now) grades the cleared question normally.
    api.now.value = new Date(api.now.value.getTime() + 6 * 3_600_000);
    const working = scriptedModel([VISIBLE_FALSE_MATCH, MATH]);
    expect((await runJobs(deps, handlers(working))).succeeded).toBe(1);
    expect(gradingRequestsWith(working, VISIBLE_FALSE_MATCH_ANSWER).length).toBeGreaterThan(0);
    const detail = await childDetail(scan, (await childSession(fam)).child);
    expect(detail.assignment.status).toBe('ready');
    const graded = detail.questions.find((q) => q.id === flaggedId)!;
    expect(graded.verdict).toBe('incorrect');
    expect(graded.feedback.map((f) => f.kind)).not.toContain('safety');
  });

  it('a notice kept after a correction (RV-child-safety-7) goes once its flag is cleared', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    await consent(fam);
    await paidSlot(fam);
    const { parent, child } = await childSession(fam);
    const scan = await queuedScan(fam);
    const client = scriptedModel([HELD_FALSE_MATCH, MATH]);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    const flaggedId = await questionId(scan, HELD_FALSE_MATCH.prompt);
    const flagged = async () =>
      (await childDetail(scan, child)).questions.find((q) => q.id === flaggedId)!;
    // A grown-up corrects the transcription to text that does not screen severe: the notice stays
    // and the question is not graded (RV-child-safety-7).
    api.now.value = new Date(api.now.value.getTime() + 60_000);
    const corrected = await api.request(`/v1/questions/${flaggedId}/correction`, {
      method: 'POST',
      token: parent,
      body: { studentAnswerText: 'They give me food I like' },
    });
    expect(corrected.status).toBe(200);
    await dueNow(fam);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    expect((await flagged()).feedback.map((f) => f.kind)).toEqual(['safety']);
    expect((await flagged()).verdict).toBeNull();

    const aal2 = await adminToken();
    const [flag] = (await adminQueue(aal2, 'status=escalated')).filter(
      (r) => r.questionId === flaggedId,
    );
    expect(flag).toMatchObject({ transcriptionCorrected: true, familyVisible: false });
    const cleared = await patch(aal2, flag!.id, CLEAR);
    expect(cleared.status).toBe(200);
    expect(adminSafetyReportResponseSchema.parse(await json(cleared)).recheck).toBe('queued');
    await dueNow(fam);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    const graded = await flagged();
    expect(graded.verdict).toBe('incorrect');
    expect(graded.feedback.map((f) => f.kind)).not.toContain('safety');
    expect(await systemReports(fam.familyId)).toHaveLength(1);
  });

  it('a cleared writing question gets its rubric rows (round 4, CHK3-CS-7)', async () => {
    // The rubric step's crash-replay check counts this transcription's feedback rows; the kept
    // safety notice is not one, or a cleared writing question would be graded with no rubric rows.
    const fam = await seedFamily(api.db, { childCount: 1 });
    await consent(fam);
    const { child } = await childSession(fam);
    const scan = await queuedScan(fam);
    const client = scriptedModel([WRITING_FALSE_MATCH, MATH]);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    const flaggedId = await questionId(scan, WRITING_FALSE_MATCH.prompt);
    expect((await feedbackFor(flaggedId)).map((r) => r.kind)).toEqual(['safety']);

    const aal2 = await adminToken();
    const [flag] = (await adminQueue(aal2, 'status=escalated')).filter(
      (r) => r.questionId === flaggedId,
    );
    expect(flag).toMatchObject({ screenCategories: ['self_harm'], familyVisible: true });
    const cleared = await patch(aal2, flag!.id, {
      ...CLEAR,
      resolutionNote: 'SYNTHETIC: false match (category self_harm); homework hyperbole.',
    });
    expect(cleared.status).toBe(200);
    expect(adminSafetyReportResponseSchema.parse(await json(cleared)).recheck).toBe('queued');
    await dueNow(fam);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);

    const rows = await feedbackFor(flaggedId);
    expect(rows.map((r) => r.body)).toEqual(
      expect.arrayContaining([
        'You did this well: Uses capital letters.',
        'Next time, work on: Writes about homework.',
      ]),
    );
    const graded = (await childDetail(scan, child)).questions.find((q) => q.id === flaggedId)!;
    expect(graded.verdict).toBe('rubric');
    expect(graded.feedback.map((f) => f.kind).sort()).toEqual(['encouragement', 'method_step']);
    expect(JSON.stringify(api.logs)).not.toContain(WRITING_FALSE_MATCH_ANSWER);
  });

  it('a question is graded only once every flag on it is cleared (round 4, CHK3-CS-8)', async () => {
    // Two system reports on one question: the original transcription and a grown-up's correction
    // that also screens severe. Clearing one of them is harmless: the notice stays, nothing is
    // graded or coached, so the child never gets hints next to a notice.
    const fam = await seedFamily(api.db, { childCount: 1 });
    await consent(fam);
    await paidSlot(fam);
    const { parent, child } = await childSession(fam);
    const scan = await queuedScan(fam);
    const client = scriptedModel([VISIBLE_FALSE_MATCH, MATH]);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    const flaggedId = await questionId(scan, VISIBLE_FALSE_MATCH.prompt);
    const flagged = async () =>
      (await childDetail(scan, child)).questions.find((q) => q.id === flaggedId)!;

    api.now.value = new Date(api.now.value.getTime() + 60_000);
    const correctedAnswer = 'please kill me, this homework is so long and so hard';
    const corrected = await api.request(`/v1/questions/${flaggedId}/correction`, {
      method: 'POST',
      token: parent,
      body: { studentAnswerText: correctedAnswer },
    });
    expect(corrected.status).toBe(200);
    await dueNow(fam);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    const aal2 = await adminToken();
    const flags = (await adminQueue(aal2, 'status=escalated')).filter(
      (r) => r.questionId === flaggedId,
    );
    expect(flags).toHaveLength(2);
    const [original, latest] = flags;
    expect(original).toMatchObject({ transcriptionCorrected: true });
    expect(latest).toMatchObject({ transcriptionCorrected: false });

    // The latest transcription's report alone: its recheck keeps the notice and grades nothing.
    const first = await patch(aal2, latest!.id, CLEAR);
    expect(first.status).toBe(200);
    expect(adminSafetyReportResponseSchema.parse(await json(first)).recheck).toBe('queued');
    let before = client.requests.length;
    await dueNow(fam);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    let recheck = { requests: client.requests.slice(before) };
    expect(gradingRequestsWith(recheck, correctedAnswer)).toEqual([]);
    expect(coachedQuestions(recheck)).toEqual([]);
    expect(
      await api.db
        .sql`select verdict from public.question_results where question_id = ${flaggedId}`,
    ).toEqual([]);
    const partial = await flagged();
    expect(partial.verdict).toBeNull();
    expect(partial.feedback.map((f) => f.kind)).toEqual(['safety']);
    expect((await feedbackFor(flaggedId)).map((r) => r.kind)).toEqual(['safety', 'safety']);
    expect(api.logs.map((l) => l.event)).not.toContain('safety_flag_cleared_graded');

    // The last report cleared: the next recheck grades and coaches it, and the notice goes.
    const second = await patch(aal2, original!.id, CLEAR);
    expect(second.status).toBe(200);
    expect(adminSafetyReportResponseSchema.parse(await json(second)).recheck).toBe('queued');
    before = client.requests.length;
    await dueNow(fam);
    expect((await runJobs(deps, handlers(client))).succeeded).toBe(1);
    recheck = { requests: client.requests.slice(before) };
    expect(gradingRequestsWith(recheck, correctedAnswer).length).toBeGreaterThan(0);
    expect(coachedQuestions(recheck)).toEqual([VISIBLE_FALSE_MATCH.prompt]);
    const graded = await flagged();
    expect(graded.verdict).toBe('incorrect');
    expect(graded.feedback.length).toBeGreaterThan(0);
    expect(graded.feedback.map((f) => f.kind)).not.toContain('safety');
    expect(await systemReports(fam.familyId)).toHaveLength(2);
  });

  it('only a system report can be cleared as a false match', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const token = await parentToken(fam.ownerId);
    const filed = await api.request('/v1/safety-reports', {
      method: 'POST',
      token,
      body: { category: 'other', note: 'SYNTHETIC parent report' },
    });
    expect(filed.status).toBe(201);
    const { report } = await json<{ report: { id: string } }>(filed);
    const aal2 = await adminToken();
    const res = await patch(aal2, report.id, CLEAR);
    expect(res.status).toBe(422);
    expect((await json<ErrorBody>(res)).error.rule).toBe('FALSE_MATCH_SYSTEM_ONLY');
  });
});
