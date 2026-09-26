import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMockModerationClient,
  createMockResponsesClient,
  mockModerationResult,
  type MockModerationClient,
  type ModerationClient,
  type ModerationResult,
  type ResponsesClient,
  type ResponsesRequest,
  type ResponsesResult,
} from '@pencillift/ai';
import { cryptoRandom } from '@pencillift/domain';
import { generateSkillItems, seededRandom } from '@pencillift/domain/bank';
import {
  childSafetyMessage,
  screenModelOutput,
  screenQuestion,
  screenText,
} from '@pencillift/domain/safety';
import { seedFamily, seedOwnerAdmin, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { loadConfig, productionReadiness, type ApiConfig } from '../src/config.ts';
import { buildRuntime, selectModerationClient, type WorkerEnv } from '../src/index.ts';
import { runJobs, type JobDeps, type JobHandler } from '../src/jobs/dispatcher.ts';
import {
  loadChildContext,
  personalizeItems,
  type LearningHandlerOptions,
} from '../src/jobs/learning-jobs.ts';
import {
  childInputScreen,
  createScanProcessHandler,
  TEMPLATE_FALLBACK,
} from '../src/jobs/scan-process.ts';
import { createTestApi, TEST_ENV, type TestApi } from './helpers.ts';

/**
 * Provider moderation before and after generation (spec P4; AC_SECURITY_02; round 5 lead decision:
 * a word list is not the safety control). Real Postgres; the AI and the moderation provider are
 * LABELED MOCKS: no OpenAI key exists and nothing here calls the network. The moderation mock flags
 * an input only when it carries `[mock-moderation:<openai-category>]` or a test scripts its answer,
 * so every flag below is explicit. Synthetic worksheet content and children only.
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
// Scripted mock model (LABELED MOCK) and scan fixtures
// ---------------------------------------------------------------------------------------------

interface ScriptedQuestion {
  number: string;
  prompt: string;
  answer: string | null;
  kind: string;
  subject: string;
  key: string;
  verdict: 'correct' | 'incorrect' | 'rubric';
  hint?: string;
  rubric?: { criterion: string; met: boolean; note: string }[];
}

const SAFE_HINT = 'Read the question again and check each step slowly.';

const MATH: ScriptedQuestion = {
  number: '1',
  prompt: '12 × 7 =',
  answer: '72',
  kind: 'numeric',
  subject: 'math',
  key: '84',
  verdict: 'incorrect',
};

/**
 * Words the word-list screen does not flag; the test scripts the provider's self-harm flag for them
 * (a `[mock-moderation:self-harm]` marker would itself be a word-list term, "self-harm").
 */
const PROVIDER_SELF_HARM_ANSWER = 'My weekend was quiet and I stayed in bed all day.';
const PROVIDER_ONLY: ScriptedQuestion = {
  number: '2',
  prompt: 'Write one sentence about your weekend.',
  answer: PROVIDER_SELF_HARM_ANSWER,
  kind: 'open_response',
  subject: 'grammar_writing',
  key: 'A complete sentence about the weekend.',
  verdict: 'incorrect',
};

const PROVIDER_VIOLENCE_ANSWER = 'We played tag at recess [mock-moderation:violence]';
const PROVIDER_VIOLENCE: ScriptedQuestion = {
  number: '3',
  prompt: 'What did you do at recess?',
  answer: PROVIDER_VIOLENCE_ANSWER,
  kind: 'open_response',
  subject: 'grammar_writing',
  key: 'A sentence about recess.',
  verdict: 'incorrect',
};

const SEVERE_ANSWER = 'I want to die';
const WORD_LIST_SEVERE: ScriptedQuestion = {
  number: '4',
  prompt: 'Why do plants need sunlight?',
  answer: SEVERE_ANSWER,
  kind: 'open_response',
  subject: 'science',
  key: 'Plants use sunlight to make food.',
  verdict: 'incorrect',
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
          results: (data.questions as { questionNumber: string; prompt: string }[]).map((q) => ({
            questionNumber: q.questionNumber,
            agrees: true,
            verdict: byPrompt.get(q.prompt)!.verdict,
            reason: 'checked independently',
            confidence: 'high',
          })),
        });
      case 'child_coaching_packet': {
        const s = byPrompt.get(data.question as string)!;
        return ok(
          {
            steps: [
              { kind: 'concept', text: 'Let’s look at this one together.' },
              { kind: 'hint', text: s.hint ?? SAFE_HINT },
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

function handlers(ai: ResponsesClient, moderation: ModerationClient): Record<string, JobHandler> {
  return {
    scan_process: createScanProcessHandler({
      ai,
      moderation,
      readObject: () => Promise.resolve(syntheticJpeg()),
      sleep: () => Promise.resolve(),
    }),
  };
}

async function testConsent(fam: SeededFamily) {
  await api.db.sql`
    insert into public.consent_records (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
    values (${fam.familyId}, ${fam.ownerId}, 'mock', 'mock', 'child_learning_data', 'v1', 'verified', true, now())`;
}

interface Scan {
  fam: SeededFamily;
  assignmentId: string;
}

async function queuedScan(options: { realConsent?: boolean } = {}): Promise<Scan> {
  const fam = await seedFamily(api.db, { childCount: 1 });
  if (options.realConsent) {
    await api.db.sql`
      insert into public.consent_records
        (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
      values (${fam.familyId}, ${fam.ownerId}, 'acme-consent', 'acme', 'child_data_processing', 'v1',
              'verified', false, now())`;
  } else {
    await testConsent(fam);
  }
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

async function questionId(scan: Scan, prompt: string): Promise<string> {
  const [row] = await api.db.sql<{ id: string }[]>`
    select id from public.extracted_questions where assignment_id = ${scan.assignmentId} and prompt_text = ${prompt}`;
  return row!.id;
}

async function feedback(scan: Scan, prompt: string) {
  const qid = await questionId(scan, prompt);
  return api.db.sql<{ kind: string; body: string }[]>`
    select kind, body from public.child_feedback where question_id = ${qid} order by created_at, body`;
}

async function reports(scan: Scan) {
  return api.db.sql<
    {
      id: string;
      question_id: string;
      screen_categories: string[];
      family_visible: boolean;
      status: string;
    }[]
  >`
    select id, question_id, screen_categories, family_visible, status from public.safety_reports
     where family_id = ${scan.fam.familyId} and reporter_kind = 'system' order by created_at`;
}

async function createdAudit(reportId: string) {
  return api.db.sql<{ family_id: string | null; metadata: Record<string, unknown> }[]>`
    select family_id, metadata from public.audit_events
     where target_id = ${reportId} and action = 'safety_report.created'`;
}

/**
 * The reviewer-only audit row carrying which layer flagged the answer and the provider's own
 * category codes (CS-R2-02). It is written with `family_id` null, so audit_member_read (0001) never
 * returns it to a family member; the family-readable 'safety_report.created' row says only that a
 * flag was filed. Read here as the service role, which is what a reviewer's path uses.
 */
async function screenCodesAudit(reportId: string) {
  return api.db.sql<{ family_id: string | null; metadata: Record<string, unknown> }[]>`
    select family_id, metadata from public.audit_events
     where action = 'safety_screen.codes' and metadata->>'reportId' = ${reportId}`;
}

async function assignment(scan: Scan) {
  const [row] = await api.db.sql<{ status: string; error_code: string | null }[]>`
    select status, error_code from public.assignments where id = ${scan.assignmentId}`;
  return row;
}

function stageRequests(client: { requests: ResponsesRequest[] }, outputName: string) {
  return client.requests.filter((r) => r.outputName === outputName);
}

/** A moderation answer that flags exactly the inputs equal to `text` with `category`. */
function flagging(text: string, category: string) {
  return (inputs: readonly string[]): ModerationResult => ({
    kind: 'ok',
    results: inputs.map((t) =>
      t === text
        ? { flagged: true, categories: [category], maxScore: 0.9 }
        : { flagged: false, categories: [], maxScore: 0.01 },
    ),
    modelId: 'mock-moderation',
    latencyMs: 1,
  });
}

const RETRYABLE_ERROR: ModerationResult = {
  kind: 'error',
  status: 503,
  retryable: true,
  timedOut: false,
  latencyMs: 4,
};

/** Logs carry codes and counts, never the child's words or the fixtures' markers. */
function expectNoChildTextInLogs(...texts: string[]) {
  const logged = JSON.stringify(api.logs);
  for (const text of texts) expect(logged).not.toContain(text);
  expect(logged).not.toContain('mock-moderation');
}

// ---------------------------------------------------------------------------------------------
// Before generation: the child's answers
// ---------------------------------------------------------------------------------------------

describe('provider moderation of the child’s answers before grading', () => {
  it('an answer the word list misses but the provider flags gets the safety response and no grading call', async () => {
    // Precondition: the deterministic screen alone lets this answer through.
    expect(
      screenQuestion({
        prompt: PROVIDER_ONLY.prompt,
        answer: PROVIDER_ONLY.answer,
        subject: PROVIDER_ONLY.subject,
        ageBand: '8-10',
      }).level,
    ).not.toBe('severe');
    const scan = await queuedScan();
    const ai = scriptedModel([MATH, PROVIDER_ONLY]);
    const moderation = createMockModerationClient();
    moderation.scripted.push(flagging(PROVIDER_SELF_HARM_ANSWER, 'self-harm/intent'));
    expect((await runJobs(deps, handlers(ai, moderation))).succeeded).toBe(1);

    // One moderation call for every answer, before any grading call.
    expect(moderation.requests[0]!.inputs).toEqual([MATH.answer, PROVIDER_SELF_HARM_ANSWER]);
    expect(moderation.requests[0]!.options.metadata).toEqual({
      stage: 'moderation_child_answers',
    });
    // Only the unflagged question reached grading, verification or coaching.
    for (const r of ai.requests.filter((x) => x.outputName !== 'homework_extraction')) {
      expect(JSON.stringify(r.input)).not.toContain(PROVIDER_SELF_HARM_ANSWER);
    }
    expect(stageRequests(ai, 'private_grading')).toHaveLength(1);
    expect(JSON.stringify(stageRequests(ai, 'private_grading')[0]!.input)).toContain(MATH.prompt);

    // The reviewed template and an escalated system report, with the provider as the source.
    expect(await feedback(scan, PROVIDER_ONLY.prompt)).toEqual([
      { kind: 'safety', body: childSafetyMessage(['self_harm'], '8-10') },
    ]);
    const [report, ...more] = await reports(scan);
    expect(more).toEqual([]);
    expect(report).toMatchObject({
      question_id: await questionId(scan, PROVIDER_ONLY.prompt),
      screen_categories: ['self_harm'],
      family_visible: true,
      status: 'escalated',
    });
    // CS-R2-02: the source layer and the provider's codes are reviewer-only now — the row the
    // family can read carries neither, so this assertion moved to the 'safety_screen.codes' row.
    const [codes] = await screenCodesAudit(report!.id);
    expect(codes!.family_id).toBeNull();
    expect(codes!.metadata).toMatchObject({
      source: 'provider_moderation',
      providerCodes: ['PROVIDER_SELF_HARM_INTENT'],
    });
    expect(api.logs).toContainEqual({
      level: 'warn',
      event: 'safety_screen_severe',
      code: 'PROVIDER_SELF_HARM_INTENT',
    });
    expect(
      await api.db
        .sql`select 1 from public.question_results where question_id = ${await questionId(scan, PROVIDER_ONLY.prompt)}`,
    ).toEqual([]);
    expectNoChildTextInLogs(PROVIDER_SELF_HARM_ANSWER, MATH.prompt);
  });

  it('a provider violence flag on the child’s words is filed as possible abuse and violence, visible to the family', async () => {
    // Owner decision (2026-09-25), a policy change and not a weakened test: this asserted that the
    // report started held from the family with no family id on its audit row. No flag is held now.
    // Precondition: the word list alone does not flag these words (the mock marker does).
    expect(
      screenQuestion({
        prompt: PROVIDER_VIOLENCE.prompt,
        answer: PROVIDER_VIOLENCE.answer,
        subject: PROVIDER_VIOLENCE.subject,
        ageBand: '8-10',
      }).level,
    ).not.toBe('severe');
    const scan = await queuedScan();
    const ai = scriptedModel([PROVIDER_VIOLENCE]);
    const moderation = createMockModerationClient();
    await runJobs(deps, handlers(ai, moderation));

    expect(stageRequests(ai, 'private_grading')).toEqual([]);
    expect(await feedback(scan, PROVIDER_VIOLENCE.prompt)).toEqual([
      { kind: 'safety', body: childSafetyMessage(['abuse', 'violence'], '8-10') },
    ]);
    const [report] = await reports(scan);
    expect(report).toMatchObject({
      screen_categories: ['abuse', 'violence'],
      family_visible: true,
    });
    // A visible report's audit row carries the family id (family members can read their audit log).
    const [audit] = await createdAudit(report!.id);
    expect(audit!.family_id).toBe(scan.fam.familyId);
    // CS-R2-02: which kind of concern the provider named is on the reviewer-only row, not this one.
    const [codes] = await screenCodesAudit(report!.id);
    expect(codes!.family_id).toBeNull();
    expect(codes!.metadata).toMatchObject({ providerCodes: ['PROVIDER_VIOLENCE'] });
    expectNoChildTextInLogs(PROVIDER_VIOLENCE_ANSWER);
  });

  it('merges with the word list: the most serious wins and the categories join', () => {
    const words = screenQuestion({
      prompt: WORD_LIST_SEVERE.prompt,
      answer: SEVERE_ANSWER,
      subject: 'science',
      ageBand: '8-10',
    });
    expect(words.categories).toEqual(['self_harm']);
    const merged = childInputScreen(words, {
      flagged: true,
      categories: ['violence'],
      maxScore: 0.8,
    });
    expect(merged.screen.categories).toEqual(['self_harm', 'abuse', 'violence']);
    expect(merged.source).toBe('safety_screen+provider_moderation');
    expect(childInputScreen(words, null)).toEqual({
      screen: words,
      source: 'safety_screen',
      providerCodes: [],
    });
  });

  // CS-R2-03, a policy change and not a weakened test: this asserted 'only logs a code; the
  // answer is graded'. That assertion WAS the defect — a provider flag whose category the map
  // did not know (no category at all, a category added after the 2024 list, or
  // harassment/hate/illicit) reached no one: the answer was graded and coached and the parent
  // was never told. The child-input screen now fails closed (providerSafetyScreen and
  // PROVIDER_FALLBACK_CATEGORY in packages/ai/src/moderation.ts), per the lead decision of
  // 2026-09-26: every provider flag on the child's own words is severe, so the child gets the
  // calm generic safety template and the parent gets a flag.
  it('a flag with no mapped PencilLift category is answered and reported (CS-R2-03)', async () => {
    const answer = 'The fox ran home fast [mock-moderation:harassment]';
    const question: ScriptedQuestion = {
      ...PROVIDER_ONLY,
      number: '5',
      prompt: 'What did the fox do?',
      answer,
      subject: 'reading',
    };
    const scan = await queuedScan();
    const ai = scriptedModel([question]);
    await runJobs(deps, handlers(ai, createMockModerationClient()));
    expect(stageRequests(ai, 'private_grading')).toEqual([]);
    expect((await feedback(scan, question.prompt)).map((f) => f.kind)).toEqual(['safety']);
    expect(await reports(scan)).toMatchObject([
      { screen_categories: ['abuse', 'violence'], status: 'escalated', family_visible: true },
    ]);
    expect(api.logs).toContainEqual({
      level: 'warn',
      event: 'moderation_flag_child_input',
      code: 'PROVIDER_HARASSMENT',
    });
    expectNoChildTextInLogs(answer);
  });

  it('never sends the printed prompt to moderation (a flag there would flag a lesson)', async () => {
    const prompt = 'Read the story. [mock-moderation:violence] What did the wolf do?';
    const question: ScriptedQuestion = {
      ...PROVIDER_ONLY,
      number: '6',
      prompt,
      answer: 'The wolf blew the house down.',
      subject: 'reading',
    };
    const scan = await queuedScan();
    const ai = scriptedModel([question]);
    const moderation = createMockModerationClient();
    await runJobs(deps, handlers(ai, moderation));
    const sent = moderation.requests.flatMap((r) => r.inputs);
    expect(moderation.requests[0]!.inputs).toEqual(['The wolf blew the house down.']);
    for (const text of sent) expect(text).not.toContain('Read the story.');
    expect(await reports(scan)).toEqual([]);
    expect(stageRequests(ai, 'private_grading')).toHaveLength(1);
  });

  it('runs only where grading may: a non-mock provider without ZDR approval is never sent the child’s words', async () => {
    const scan = await queuedScan();
    const ai = scriptedModel([MATH]);
    const inner = createMockModerationClient();
    const live: ModerationClient = {
      name: 'stub_live_moderation',
      isMock: false,
      moderate: (inputs, options) => inner.moderate(inputs, options),
    };
    await runJobs(deps, handlers(ai, live));
    expect(inner.requests).toEqual([]);
    expect(stageRequests(ai, 'private_grading')).toEqual([]);
    expect(await assignment(scan)).toEqual({
      status: 'failed_final',
      error_code: 'MODERATION_NOT_AVAILABLE',
    });
  });

  it('logs one count per call and no text', async () => {
    await queuedScan();
    const ai = scriptedModel([MATH, PROVIDER_ONLY]);
    await runJobs(deps, handlers(ai, createMockModerationClient()));
    expect(api.logs).toContainEqual(
      expect.objectContaining({
        level: 'info',
        event: 'moderation_checked',
        code: 'CHILD_ANSWERS',
        count: 2,
      }),
    );
    expectNoChildTextInLogs(PROVIDER_SELF_HARM_ANSWER, MATH.answer!);
  });
});

// ---------------------------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------------------------

describe('a moderation failure grades nothing (fail closed)', () => {
  it('a retryable error: no grading call, the job retries, the word-list flag is answered and listed at once', async () => {
    // Owner decision (2026-09-25), a policy change and not a weakened test: this asserted that a
    // word-list flag filed during a moderation outage was held from the family (fail closed). No
    // flag is held now, an outage included; the audit row still records that moderation failed.
    const scan = await queuedScan();
    const ai = scriptedModel([MATH, WORD_LIST_SEVERE]);
    const moderation = createMockModerationClient();
    moderation.scripted.push(RETRYABLE_ERROR);

    const first = await runJobs(deps, handlers(ai, moderation));
    expect(first).toEqual({ succeeded: 0, retried: 1, deadLettered: 0 });
    expect(ai.requests.map((r) => r.outputName)).toEqual(['homework_extraction']);
    expect(await assignment(scan)).toEqual({
      status: 'failed_retryable',
      error_code: 'MODERATION_FAILED',
    });
    // The word-list flag is not delayed by the provider's failure, and it is listed at once.
    expect(await feedback(scan, WORD_LIST_SEVERE.prompt)).toEqual([
      { kind: 'safety', body: childSafetyMessage(['self_harm'], '8-10') },
    ]);
    const [flag] = await reports(scan);
    expect(flag).toMatchObject({ screen_categories: ['self_harm'], family_visible: true });
    const [audit] = await createdAudit(flag!.id);
    expect(audit!.family_id).toBe(scan.fam.familyId);
    expect(audit!.metadata).toMatchObject({ providerModeration: 'unavailable' });
    expect(await feedback(scan, MATH.prompt)).toEqual([]);

    // The retry (after the backoff) moderates, grades and coaches; extraction is not repeated.
    const saved = api.now.value;
    api.now.value = new Date(saved.getTime() + 5 * 60_000);
    try {
      const second = await runJobs(deps, handlers(ai, moderation));
      expect(second).toEqual({ succeeded: 1, retried: 0, deadLettered: 0 });
    } finally {
      api.now.value = saved;
    }
    expect(stageRequests(ai, 'homework_extraction')).toHaveLength(1);
    expect(stageRequests(ai, 'private_grading')).toHaveLength(1);
    expect(JSON.stringify(stageRequests(ai, 'private_grading')[0]!.input)).not.toContain(
      SEVERE_ANSWER,
    );
    expect((await feedback(scan, MATH.prompt)).map((f) => f.kind)).toContain('hint');
    expect(await reports(scan)).toHaveLength(1);
    expectNoChildTextInLogs(SEVERE_ANSWER);
  });

  it('a timeout is a retryable failure with its own code', async () => {
    const scan = await queuedScan();
    const ai = scriptedModel([MATH]);
    const moderation = createMockModerationClient();
    moderation.scripted.push({ ...RETRYABLE_ERROR, status: null, timedOut: true });
    expect((await runJobs(deps, handlers(ai, moderation))).retried).toBe(1);
    expect(stageRequests(ai, 'private_grading')).toEqual([]);
    expect(await assignment(scan)).toEqual({
      status: 'failed_retryable',
      error_code: 'MODERATION_TIMEOUT',
    });
    // Finish the job so later tests start from an empty queue.
    const saved = api.now.value;
    api.now.value = new Date(saved.getTime() + 5 * 60_000);
    try {
      await runJobs(deps, handlers(ai, moderation));
    } finally {
      api.now.value = saved;
    }
    expect(stageRequests(ai, 'private_grading')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// After generation: coaching and rubric criteria
// ---------------------------------------------------------------------------------------------

describe('provider moderation after generation', () => {
  it('a flagged coaching packet falls back to the reviewed template', async () => {
    const flaggedHint = 'Check each step again, slowly. [mock-moderation:harassment]';
    // Precondition: the word-list screen of model output lets this packet through.
    expect(
      screenModelOutput(['Let’s look at this one together.', flaggedHint, 'Give it another try.'], {
        ageBand: '8-10',
        context: { prompt: '9 × 6 =', subject: 'math' },
      }).level,
    ).not.toBe('severe');
    const flagged: ScriptedQuestion = {
      ...MATH,
      number: '7',
      prompt: '9 × 6 =',
      answer: '56',
      key: '54',
      hint: flaggedHint,
    };
    const scan = await queuedScan();
    const ai = scriptedModel([MATH, flagged]);
    const moderation = createMockModerationClient();
    await runJobs(deps, handlers(ai, moderation));

    expect(stageRequests(ai, 'child_coaching_packet')).toHaveLength(2);
    expect(await feedback(scan, flagged.prompt)).toEqual([
      { kind: 'template_fallback', body: TEMPLATE_FALLBACK },
    ]);
    // The unflagged packet is shown as written.
    expect((await feedback(scan, MATH.prompt)).map((f) => f.body)).toContain(SAFE_HINT);
    expect(
      moderation.requests.filter((r) => r.options.metadata.stage === 'moderation_coaching'),
    ).toHaveLength(2);
    expect(api.logs).toContainEqual({
      level: 'warn',
      event: 'coaching_blocked_by_safety',
      code: 'SAFETY_PROVIDER_HARASSMENT',
    });
    expectNoChildTextInLogs(flaggedHint);
  });

  it('a coaching moderation failure shows the template, never the unmoderated packet', async () => {
    const scan = await queuedScan();
    const ai = scriptedModel([MATH]);
    const moderation = createMockModerationClient();
    moderation.scripted.push(mockModerationResult, RETRYABLE_ERROR);
    await runJobs(deps, handlers(ai, moderation));
    expect(stageRequests(ai, 'child_coaching_packet')).toHaveLength(1);
    expect(await feedback(scan, MATH.prompt)).toEqual([
      { kind: 'template_fallback', body: TEMPLATE_FALLBACK },
    ]);
    expect(api.logs).toContainEqual({
      level: 'warn',
      event: 'coaching_blocked_by_moderation',
      code: 'MODERATION_FAILED',
    });
  });

  const WRITING: ScriptedQuestion = {
    number: '8',
    prompt: 'Write three sentences about your favorite season.',
    answer: 'I like fall. The leaves are red. We rake them.',
    kind: 'writing',
    subject: 'grammar_writing',
    key: 'Three complete sentences about a season.',
    verdict: 'rubric',
    rubric: [
      { criterion: 'Uses capital letters', met: true, note: 'All three start with capitals.' },
      { criterion: 'Writes about one season', met: false, note: 'Stays on topic.' },
    ],
  };

  async function rubricRun(steps: Parameters<MockModerationClient['scripted']['push']>) {
    const scan = await queuedScan();
    const ai = scriptedModel([WRITING]);
    const moderation = createMockModerationClient();
    moderation.scripted.push(...steps);
    await runJobs(deps, handlers(ai, moderation));
    return { scan, moderation, bodies: (await feedback(scan, WRITING.prompt)).map((f) => f.body) };
  }

  it('a flagged criterion is dropped before it becomes a label; the others stay', async () => {
    const control = await rubricRun([]);
    expect(control.bodies.sort()).toEqual(
      [
        'You did this well: Uses capital letters.',
        'Next time, work on: Writes about one season.',
      ].sort(),
    );
    // The criteria are moderated as the model wrote them, in one call, before childRubricFeedback.
    expect(control.moderation.requests[1]).toMatchObject({
      inputs: ['Uses capital letters', 'Writes about one season'],
      options: { metadata: { stage: 'moderation_rubric_criteria' } },
    });

    api.logs.length = 0;
    const flagged = await rubricRun([
      mockModerationResult,
      flagging('Uses capital letters', 'violence'),
    ]);
    expect(flagged.bodies).toEqual(['Next time, work on: Writes about one season.']);
    expect(api.logs).toContainEqual({
      level: 'warn',
      event: 'rubric_label_blocked_by_safety',
      code: 'SAFETY_PROVIDER_VIOLENCE',
    });
  });

  it('a criterion carrying the mock marker is reported by the provider layer', async () => {
    const marked: ScriptedQuestion = {
      ...WRITING,
      number: '9',
      prompt: 'Write two sentences about your favorite place.',
      rubric: [
        { criterion: 'Uses capital letters', met: true, note: 'Starts with a capital.' },
        { criterion: 'Uses details [mock-moderation:sexual]', met: false, note: 'x' },
      ],
    };
    const scan = await queuedScan();
    await runJobs(deps, handlers(scriptedModel([marked]), createMockModerationClient()));
    expect((await feedback(scan, marked.prompt)).map((f) => f.body)).toEqual([
      'You did this well: Uses capital letters.',
    ]);
    expect(api.logs).toContainEqual({
      level: 'warn',
      event: 'rubric_label_blocked_by_safety',
      code: 'SAFETY_PROVIDER_SEXUAL',
    });
    expectNoChildTextInLogs('Uses details');
  });

  it('a rubric moderation failure shows no labels (a dropped label costs only a missing row)', async () => {
    const failed = await rubricRun([mockModerationResult, RETRYABLE_ERROR]);
    expect(failed.bodies).toEqual([]);
    expect(api.logs).toContainEqual({
      level: 'warn',
      event: 'rubric_label_blocked_by_moderation',
      code: 'MODERATION_FAILED',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Practice re-theming (learning jobs)
// ---------------------------------------------------------------------------------------------

describe('re-themed practice stories and intros are moderated before a child sees them', () => {
  const wordProblems = generateSkillItems('math.word_problems', {
    random: seededRandom('provider-moderation'),
    grade: 3,
    category: 'standard',
    count: 2,
  });
  const INTRO = 'Let’s practice story problems together!';

  function practiceModel() {
    return createMockResponsesClient((request) => {
      const refs = (envelope(request).data.wordProblems as { ref: string }[]).map((w) => w.ref);
      return ok(
        {
          intro: INTRO,
          items: [
            { ref: refs[0], context: { name: 'Nia', things: 'shells', place: 'tide pool' } },
            { ref: refs[1], context: { name: 'Sam', things: 'kites', place: 'park' } },
          ],
        },
        'gpt-6-astra',
      );
    });
  }

  async function personalize(moderation: ModerationClient | undefined) {
    const fam = await seedFamily(api.db, { childCount: 1 });
    await testConsent(fam);
    const ctx = await api.apiDb.asService((tx) =>
      loadChildContext(tx, fam.familyId, fam.children[0]!.id),
    );
    const ai = practiceModel();
    const options = { ai, moderation } as LearningHandlerOptions;
    const out = await personalizeItems(deps, options, ctx!, wordProblems, 'daily_set', [
      'math.word_problems',
    ]);
    return { out, ai };
  }

  it('control: both stories and the intro pass', async () => {
    const moderation = createMockModerationClient();
    const { out } = await personalize(moderation);
    expect(out.rethemed).toBe(2);
    expect(out.intro).toBe(INTRO);
    expect(moderation.requests).toHaveLength(1);
    expect(moderation.requests[0]!.inputs).toHaveLength(3);
    expect(moderation.requests[0]!.inputs[2]).toBe(INTRO);
  });

  it('a flagged story keeps its bank item; the others are used', async () => {
    const moderation = createMockModerationClient();
    moderation.scripted.push((inputs) => ({
      kind: 'ok',
      results: inputs.map((t) =>
        t.includes('kites')
          ? { flagged: true, categories: ['violence'], maxScore: 0.9 }
          : { flagged: false, categories: [], maxScore: 0.01 },
      ),
      modelId: 'mock-moderation',
      latencyMs: 1,
    }));
    const { out } = await personalize(moderation);
    expect(out.items[0]!.prompt.text).toContain('Nia');
    expect(out.items[1]).toEqual(wordProblems[1]);
    expect(out.rethemed).toBe(1);
    expect(out.intro).toBe(INTRO);
    expect(api.logs).toContainEqual({
      level: 'warn',
      event: 'practice_ai_blocked_by_safety',
      code: 'SAFETY_PROVIDER_VIOLENCE',
    });
  });

  it('a flagged intro is dropped', async () => {
    const moderation = createMockModerationClient();
    moderation.scripted.push(flagging(INTRO, 'self-harm'));
    const { out } = await personalize(moderation);
    expect(out.intro).toBeNull();
    expect(out.rethemed).toBe(2);
  });

  it('a moderation error keeps every bank item and no intro', async () => {
    const moderation = createMockModerationClient();
    moderation.scripted.push(RETRYABLE_ERROR);
    const { out, ai } = await personalize(moderation);
    expect(ai.requests).toHaveLength(1);
    expect(out).toEqual({ items: wordProblems, intro: null, rethemed: 0 });
    expect(api.logs).toContainEqual(
      expect.objectContaining({
        event: 'practice_ai_moderation_failed',
        code: 'MODERATION_FAILED',
      }),
    );
  });

  it('an AI client without a moderation client makes no AI call', async () => {
    const { out, ai } = await personalize(undefined);
    expect(ai.requests).toEqual([]);
    expect(out).toEqual({ items: wordProblems, intro: null, rethemed: 0 });
    expect(api.logs).toContainEqual({
      level: 'error',
      event: 'practice_ai_skipped',
      code: 'MODERATION_NOT_CONFIGURED',
    });
  });

  it('the word list does not flag these stories (the provider layer decides above)', () => {
    for (const item of wordProblems) {
      expect(screenText(item.prompt.text, { ageBand: '8-10', source: 'ai' }).level).not.toBe(
        'severe',
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Runtime selection and readiness
// ---------------------------------------------------------------------------------------------

const HYPERDRIVE = { connectionString: 'postgres://moderation-test:unused@127.0.0.1:1/unused' };

function config(vars: Record<string, string>): ApiConfig {
  const loaded = loadConfig({ ...TEST_ENV, ...vars });
  if (!loaded.ok) throw new Error(`config should load: ${JSON.stringify(loaded.errors)}`);
  return loaded.config;
}

function workerEnv(vars: Record<string, string>): WorkerEnv {
  return { HYPERDRIVE, ...TEST_ENV, ...vars };
}

describe('explicit moderation provider selection (AC_DEPLOY_07)', () => {
  it('the labeled mock only in development/test, the refusing client elsewhere without the key, OpenAI with it', () => {
    const selected = (vars: Record<string, string>) => {
      const result = selectModerationClient(config(vars), workerEnv(vars));
      if (!result.ok) throw new Error('selection should succeed');
      return { name: result.client.name, isMock: result.client.isMock };
    };
    for (const APP_ENV of ['development', 'test']) {
      expect(config({ APP_ENV }).providers.moderation).toBe('development_mock');
      expect(selected({ APP_ENV })).toEqual({ name: 'mock_moderation', isMock: true });
    }
    for (const APP_ENV of ['staging', 'production']) {
      expect(config({ APP_ENV }).providers.moderation).toBe('unavailable');
      expect(selected({ APP_ENV })).toEqual({ name: 'not_configured', isMock: false });
    }
    for (const APP_ENV of ['development', 'test', 'staging', 'production']) {
      // Building the client sends nothing (no network in tests).
      expect(selected({ APP_ENV, OPENAI_API_KEY: 'sk-synthetic-config-value' })).toEqual({
        name: 'openai_moderation',
        isMock: false,
      });
    }
  });

  it('never wires the mock outside development/test whatever the configuration says', () => {
    const staging = config({ APP_ENV: 'staging' });
    const forced: ApiConfig = {
      ...staging,
      providers: { ...staging.providers, moderation: 'development_mock' },
    };
    expect(selectModerationClient(forced, workerEnv({ APP_ENV: 'staging' }))).toEqual({
      ok: false,
      code: 'BLOCKED_EXTERNAL',
      message: 'Service is not ready',
    });
    const keyless: ApiConfig = {
      ...staging,
      providers: { ...staging.providers, moderation: 'openai' },
    };
    expect(selectModerationClient(keyless, workerEnv({ APP_ENV: 'staging' })).ok).toBe(false);
  });

  it('the Worker runtime carries the selected client', async () => {
    const built = buildRuntime(workerEnv({ APP_ENV: 'staging' }));
    if (!built.ok) throw new Error('staging should build');
    try {
      expect(built.runtime.moderation.name).toBe('not_configured');
    } finally {
      await built.runtime.sql.end({ timeout: 0 });
    }
  });

  it('readiness: ai_moderation is ready only with the real client', () => {
    const status = (vars: Record<string, string>) =>
      productionReadiness(config({ APP_ENV: 'production', ...vars })).find(
        (i) => i.check === 'ai_moderation',
      )!.status;
    expect(status({})).toBe('blocked');
    expect(status({ OPENAI_API_KEY: 'sk-synthetic-config-value' })).toBe('ready');
    expect(
      productionReadiness(config({ APP_ENV: 'test' })).find((i) => i.check === 'ai_moderation')!
        .status,
    ).toBe('blocked');
  });
});

describe('the refusing client in staging', () => {
  it('never grades: the scan ends like a missing provider and a word-list flag is still answered and listed', async () => {
    // Owner decision (2026-09-25): no flag is held, also while moderation is not available.
    const staging = config({
      APP_ENV: 'staging',
      ZDR_APPROVAL_EVIDENCE_REFERENCE: 'ZDR-TICKET-4471',
      ZDR_APPROVAL_VERIFIED_AT: '2026-09-01',
    });
    const selected = selectModerationClient(staging, workerEnv({ APP_ENV: 'staging' }));
    if (!selected.ok) throw new Error('staging selects the refusing client');
    expect(selected.client).toMatchObject({ name: 'not_configured', isMock: false });
    const stagingDeps: JobDeps = { ...deps, config: staging };
    // Staging spends only under an owner budget (removed again below).
    await api.db.sql`
      insert into public.spend_budgets (scope, period_key, budget_micros, created_by)
      values ('global', '2026-09', 1000000000000, ${await seedOwnerAdmin(api.db)})`;
    try {
      const scan = await queuedScan({ realConsent: true });
      const ai = scriptedModel([MATH, WORD_LIST_SEVERE]);
      await runJobs(stagingDeps, handlers(ai, selected.client));
      expect(ai.requests.map((r) => r.outputName)).toEqual(['homework_extraction']);
      expect(await assignment(scan)).toEqual({
        status: 'failed_final',
        error_code: 'MODERATION_NOT_AVAILABLE',
      });
      expect(await feedback(scan, MATH.prompt)).toEqual([]);
      expect((await feedback(scan, WORD_LIST_SEVERE.prompt)).map((f) => f.kind)).toEqual([
        'safety',
      ]);
      expect((await reports(scan))[0]).toMatchObject({ family_visible: true });
      expectNoChildTextInLogs(SEVERE_ANSWER);
    } finally {
      await api.db.sql`delete from public.spend_budgets where period_key = '2026-09'`;
    }
  });
});
