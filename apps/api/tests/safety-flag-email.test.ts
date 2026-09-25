import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMockModerationClient,
  createMockResponsesClient,
  type ModerationClient,
  type ResponsesClient,
  type ResponsesRequest,
  type ResponsesResult,
} from '@pencillift/ai';
import { safetyReportsResponseSchema, type SafetyReport } from '@pencillift/contracts';
import { cryptoRandom } from '@pencillift/domain';
import { seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import {
  DEFAULT_HANDLERS,
  runJobs,
  safetyFlagEmailHandler,
  type JobDeps,
  type JobHandler,
} from '../src/jobs/dispatcher.ts';
import { createScanProcessHandler } from '../src/jobs/scan-process.ts';
import { EMAIL_TEMPLATES, type EmailProvider } from '../src/providers/index.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * The guardian email a safety flag sends (owner decision, 2026-09-25: the parent is the only person
 * PencilLift sends a safety message to). The scan job files the flag and enqueues one
 * `safety_flag_email` job; the job emails every active guardian through the LABELED outbox mock
 * with no child name, no homework text and no category, and records the delivery on the report so
 * the family's list says truthfully whether an email was sent. Real Postgres, mock AI client,
 * synthetic worksheet content and children (Riley) only.
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

beforeEach(async () => {
  api.logs.length = 0;
  // The ledger is shared across the scenarios' families: an email job an earlier scenario left
  // queued never counts in this one's tick report.
  await api.db.sql`
    update public.jobs set status = 'cancelled'
     where kind = 'safety_flag_email' and status in ('queued', 'failed_retryable')`;
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

function scriptedModel(questions: ScriptedQuestion[]): ResponsesClient {
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

const scanHandlers = (
  client: ResponsesClient,
  moderation: ModerationClient = createMockModerationClient(),
): Record<string, JobHandler> => ({
  scan_process: createScanProcessHandler({
    ai: client,
    moderation,
    readObject: () => Promise.resolve(syntheticJpeg()),
    sleep: () => Promise.resolve(),
  }),
});

/** Only the email job runs here: exactly the handler the Worker registers (DEFAULT_HANDLERS). */
const EMAIL_ONLY: Record<string, JobHandler> = {
  safety_flag_email: DEFAULT_HANDLERS.safety_flag_email!,
};

interface Flagged {
  fam: SeededFamily;
  assignmentId: string;
  reportId: string;
  ownerEmail: string;
}

/** A consented family with one queued scan of a synthetic page (the scan job has not run). */
async function queuedScan(): Promise<{ fam: SeededFamily; assignmentId: string }> {
  const fam = await seedFamily(api.db, { childCount: 1 });
  await consent(fam);
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

/** The system report the scan filed (ids and the visibility flag only). */
async function systemReport(
  assignmentId: string,
): Promise<{ id: string; family_visible: boolean }> {
  const [report] = await api.db.sql<{ id: string; family_visible: boolean }[]>`
    select r.id, r.family_visible from public.safety_reports r
      join public.extracted_questions q on q.id = r.question_id
     where q.assignment_id = ${assignmentId} and r.reporter_kind = 'system'`;
  if (!report) throw new Error('the scan filed no system report');
  return report;
}

/** A family whose scan the safety screen flagged (the mock model ran; the email job has not). */
async function flaggedFamily(): Promise<Flagged> {
  const { fam, assignmentId } = await queuedScan();
  expect((await runJobs(deps, scanHandlers(scriptedModel([SEVERE, MATH])))).succeeded).toBe(1);
  const report = await systemReport(assignmentId);
  const [owner] = await api.db.sql<{ email: string }[]>`
    select email from auth.users where id = ${fam.ownerId}`;
  return { fam, assignmentId, reportId: report.id, ownerEmail: owner!.email };
}

/** An accepted guardian (an active membership) with a verified address, as acceptance creates. */
async function addGuardian(
  fam: SeededFamily,
  email: string,
  status: 'active' | 'revoked' = 'active',
): Promise<string> {
  const userId = await api.db.createUser(email);
  await api.db.sql`
    insert into public.family_memberships (family_id, user_id, role, status, invited_by, revoked_at, revoked_by)
    values (${fam.familyId}, ${userId}, 'guardian', ${status}, ${fam.ownerId},
            ${status === 'revoked' ? api.now.value : null}, ${status === 'revoked' ? fam.ownerId : null})`;
  return userId;
}

interface EmailJob {
  id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  payload: unknown;
  idempotency_key: string;
  child_id: string | null;
  run_after: Date;
  last_error_code: string | null;
}

const emailJobs = (fam: SeededFamily) =>
  api.db.sql<EmailJob[]>`
    select id, status, attempts, max_attempts, payload, idempotency_key, child_id, run_after, last_error_code
      from public.jobs where family_id = ${fam.familyId} and kind = 'safety_flag_email'
     order by created_at`;

const emailState = async (reportId: string) => {
  const [row] = await api.db.sql<{ status: string; at: Date | null }[]>`
    select parent_email_status as status, parent_emailed_at as at from public.safety_reports where id = ${reportId}`;
  return row!;
};

async function familyList(fam: SeededFamily): Promise<SafetyReport[]> {
  const res = await api.request('/v1/safety-reports', { token: await parentToken(fam.ownerId) });
  expect(res.status).toBe(200);
  return safetyReportsResponseSchema.parse(await json(res)).reports;
}

/** Makes every queued or retryable job of the family due at the (advanced) clock. */
async function dueNow(fam: SeededFamily, advanceMs = 60_000) {
  api.now.value = new Date(api.now.value.getTime() + advanceMs);
  await api.db.sql`
    update public.jobs set run_after = ${new Date(api.now.value.getTime() - 1000)}
     where family_id = ${fam.familyId} and status in ('queued', 'failed_retryable')`;
}

const refusingEmail: EmailProvider = {
  name: 'not_configured',
  isMock: false,
  send: () => Promise.reject(new Error('email provider not configured')),
};

/**
 * Text no guardian email may carry: the answer, the child's name, the category (the screen's
 * codes are upper-case SAFETY_* constants; the template key `safety_flag` is not one).
 */
const FORBIDDEN = /I want to die|Riley|self[-_ ]harm|suicid|severe_risk|SAFETY_[A-Z]/;
/** The hotline's name is the reviewed resources line, not the kind of concern. */
const withoutHotline = (text: string) => text.replace(/988 Suicide & Crisis Lifeline/g, '');

// ---------------------------------------------------------------------------------------------

describe('a flag files one email job (scan-process safetyResponse)', () => {
  it('queues exactly one safety_flag_email job per system report, with the report id only', async () => {
    const { fam, reportId } = await flaggedFamily();
    const jobs = await emailJobs(fam);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      status: 'queued',
      attempts: 0,
      payload: { reportId },
      idempotency_key: `safety-flag-email:${reportId}`,
      child_id: fam.children[0]!.id,
      last_error_code: null,
    });
    // Due at the scan job's clock, like the other inserts of that run; no homework in the payload.
    expect(jobs[0]!.run_after.toISOString()).toBe(api.now.value.toISOString());
    expect(JSON.stringify(jobs[0]!.payload)).not.toMatch(FORBIDDEN);
    // Nothing was sent yet, and the family's list says so.
    expect(await emailState(reportId)).toEqual({ status: 'not_sent', at: null });
    expect(await familyList(fam)).toMatchObject([
      { id: reportId, emailStatus: 'not_sent', emailedAt: null },
    ]);
    // The Worker registers the handler under the job's kind.
    expect(DEFAULT_HANDLERS.safety_flag_email).toBe(safetyFlagEmailHandler);
  });

  it('a word-list flag filed while provider moderation is unavailable is listed at once and files the job too', async () => {
    // Owner decision (2026-09-25), a policy change and not a weakened test: a word-list flag
    // answered during a moderation outage used to be filed HELD (fail closed), so the family saw
    // nothing and no email went out. No flag is held now, an outage included: the report is
    // family-visible, its audit row names the family and records the outage, and the email job is
    // queued exactly as for any other flag. The scan itself still retries (grades nothing).
    const { fam, assignmentId } = await queuedScan();
    const moderation = createMockModerationClient();
    moderation.scripted.push({
      kind: 'error',
      status: 503,
      retryable: true,
      timedOut: false,
      latencyMs: 4,
    });
    expect(await runJobs(deps, scanHandlers(scriptedModel([SEVERE, MATH]), moderation))).toEqual({
      succeeded: 0,
      retried: 1,
      deadLettered: 0,
    });
    const report = await systemReport(assignmentId);
    expect(report.family_visible).toBe(true);
    const [audit] = await api.db.sql<{ family_id: string | null; metadata: unknown }[]>`
      select family_id, metadata from public.audit_events
       where target_id = ${report.id} and action = 'safety_report.created'`;
    expect(audit!.family_id).toBe(fam.familyId);
    expect(audit!.metadata).toMatchObject({ providerModeration: 'unavailable' });
    const jobs = await emailJobs(fam);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      status: 'queued',
      payload: { reportId: report.id },
      idempotency_key: `safety-flag-email:${report.id}`,
    });
    expect(await familyList(fam)).toMatchObject([
      { id: report.id, emailStatus: 'not_sent', emailedAt: null },
    ]);
    // The email job delivers like any other (the scan's retry is a different kind: not claimed here).
    const before = api.providers.email.outbox.length;
    await dueNow(fam);
    expect(await runJobs(deps, EMAIL_ONLY)).toEqual({ succeeded: 1, retried: 0, deadLettered: 0 });
    const sent = api.providers.email.outbox.slice(before);
    expect(sent.map((m) => m.templateKey)).toEqual(['safety_flag']);
    expect(withoutHotline(JSON.stringify(sent))).not.toMatch(FORBIDDEN);
    expect((await emailState(report.id)).status).toBe('sent');
    expect((await familyList(fam))[0]).toMatchObject({ emailStatus: 'sent' });
    // The scan's own retry stays in the ledger for its next tick; cancelled here so the later
    // scenarios' scan ticks start from an empty queue (the outage was this scenario's only).
    const [scan] = await api.db.sql<{ status: string }[]>`
      update public.jobs set status = 'cancelled'
       where kind = 'scan_process' and family_id = ${fam.familyId} and status = 'failed_retryable'
       returning 'failed_retryable'::text as status`;
    expect(scan?.status).toBe('failed_retryable');
  });
});

describe('the job emails every active guardian once (labeled outbox mock)', () => {
  it('sends one email per active guardian with no child text, and records "sent"', async () => {
    const flagged = await flaggedFamily();
    const { fam, reportId } = flagged;
    const guardianEmail = `guardian_${randomUUID().slice(0, 8)}@example.test`;
    await addGuardian(fam, guardianEmail);
    await addGuardian(fam, `former_${randomUUID().slice(0, 8)}@example.test`, 'revoked');

    const before = api.providers.email.outbox.length;
    const logsBefore = api.logs.length; // the scan's own codes precede the email job's entries
    await dueNow(fam);
    expect(await runJobs(deps, EMAIL_ONLY)).toEqual({ succeeded: 1, retried: 0, deadLettered: 0 });
    const sent = api.providers.email.outbox.slice(before);
    expect(sent.map((m) => m.to).sort()).toEqual([flagged.ownerEmail, guardianEmail].sort());
    for (const message of sent) {
      expect(message.templateKey).toBe('safety_flag');
      // The portal address only: no child name, no question, no category, no report id.
      expect(message.params).toEqual({ portalUrl: 'https://app.pencillift.test/app/privacy' });
      expect(message.subject).toBe(EMAIL_TEMPLATES.safety_flag!.subject);
      expect(message.body).toContain('https://app.pencillift.test/app/privacy');
      expect(message.body).toContain('988');
      expect(withoutHotline(JSON.stringify(message))).not.toMatch(FORBIDDEN);
      expect(JSON.stringify(message)).not.toContain(reportId);
    }
    expect(await emailState(reportId)).toEqual({ status: 'sent', at: api.now.value });
    expect(await familyList(fam)).toMatchObject([
      { id: reportId, emailStatus: 'sent', emailedAt: api.now.value.toISOString() },
    ]);
    // The audit row counts recipients; it carries no address and no homework.
    const audit = await api.db.sql<{ family_id: string; metadata: unknown }[]>`
      select family_id, metadata from public.audit_events
       where target_id = ${reportId} and action = 'safety_report.guardian_emailed'`;
    expect(audit).toEqual([
      { family_id: fam.familyId, metadata: { provider: 'outbox_mock', recipients: 2, refused: 0 } },
    ]);
    const jobLogs = JSON.stringify(api.logs.slice(logsBefore));
    expect(jobLogs).toContain('safety_flag_email_sent');
    expect(jobLogs).not.toMatch(FORBIDDEN);
    expect(jobLogs).not.toContain(guardianEmail);
    expect(jobLogs).not.toContain(flagged.ownerEmail);
    expect((await emailJobs(fam))[0]!.status).toBe('succeeded');
  });

  it('never emails twice for one report: a second run after a recorded delivery sends nothing', async () => {
    const { fam, reportId } = await flaggedFamily();
    await dueNow(fam);
    expect((await runJobs(deps, EMAIL_ONLY)).succeeded).toBe(1);
    const before = api.providers.email.outbox.length;
    // A retry the ledger could produce after a lost claim (the report already says "sent").
    await api.db.sql`
      insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, run_after)
      values ('safety_flag_email', ${`safety-flag-email:${reportId}:retry`}, ${fam.familyId}, ${fam.children[0]!.id},
              ${JSON.stringify({ reportId })}::text::jsonb, ${new Date(api.now.value.getTime() - 1000)})`;
    expect((await runJobs(deps, EMAIL_ONLY)).succeeded).toBe(1);
    expect(api.providers.email.outbox.length).toBe(before);
    expect((await emailState(reportId)).status).toBe('sent');
  });

  it('records "sent" when at least one guardian address accepted the email', async () => {
    const flagged = await flaggedFamily();
    const { fam, reportId } = flagged;
    const guardianEmail = `guardian_${randomUUID().slice(0, 8)}@example.test`;
    await addGuardian(fam, guardianEmail);
    const accepted: string[] = [];
    const partial: JobDeps = {
      ...deps,
      providers: {
        ...api.providers,
        email: {
          name: 'partial_mock',
          isMock: true,
          send: (input) => {
            if (input.to === flagged.ownerEmail) return Promise.reject(new Error('bounced'));
            accepted.push(input.to);
            return Promise.resolve({ messageId: `m-${accepted.length}` });
          },
        },
      },
    };
    await dueNow(fam);
    expect(await runJobs(partial, EMAIL_ONLY)).toEqual({
      succeeded: 1,
      retried: 0,
      deadLettered: 0,
    });
    expect(accepted).toEqual([guardianEmail]);
    expect((await emailState(reportId)).status).toBe('sent');
    const [audit] = await api.db.sql<{ metadata: unknown }[]>`
      select metadata from public.audit_events
       where target_id = ${reportId} and action = 'safety_report.guardian_emailed'`;
    expect(audit!.metadata).toEqual({ provider: 'partial_mock', recipients: 1, refused: 1 });
  });

  it('an active guardian whose address is not verified is not emailed (the inactivity-notice rule)', async () => {
    const flagged = await flaggedFamily();
    const { fam, reportId } = flagged;
    const unverifiedEmail = `unverified_${randomUUID().slice(0, 8)}@example.test`;
    const unverified = await addGuardian(fam, unverifiedEmail);
    await api.db.sql`update auth.users set email_confirmed_at = null where id = ${unverified}`;
    const before = api.providers.email.outbox.length;
    await dueNow(fam);
    expect((await runJobs(deps, EMAIL_ONLY)).succeeded).toBe(1);
    expect(api.providers.email.outbox.slice(before).map((m) => m.to)).toEqual([flagged.ownerEmail]);
    expect((await emailState(reportId)).status).toBe('sent');
  });

  it('with no verified guardian address nothing is sent, the state stays "not_sent", and the job ends', async () => {
    const { fam, reportId } = await flaggedFamily();
    await api.db.sql`update auth.users set email_confirmed_at = null where id = ${fam.ownerId}`;
    const before = api.providers.email.outbox.length;
    await dueNow(fam);
    expect(await runJobs(deps, EMAIL_ONLY)).toEqual({ succeeded: 1, retried: 0, deadLettered: 0 });
    expect(api.providers.email.outbox.length).toBe(before);
    expect(await emailState(reportId)).toEqual({ status: 'not_sent', at: null });
    expect((await familyList(fam))[0]).toMatchObject({ emailStatus: 'not_sent', emailedAt: null });
    expect(api.logs).toContainEqual(
      expect.objectContaining({
        event: 'safety_flag_email_undeliverable',
        code: 'NO_VERIFIED_EMAIL',
      }),
    );
  });

  it('a report purged with the child leaves nothing to send: the job is gone with it', async () => {
    const { fam, reportId } = await flaggedFamily();
    await api.db
      .sql`insert into public.deletion_requests (family_id, scope, child_id, target_child_id, requested_by)
                     values (${fam.familyId}, 'child', ${fam.children[0]!.id}, ${fam.children[0]!.id}, ${fam.ownerId})`;
    await api.db.sql`select app.purge_family_data(${fam.familyId}, ${fam.children[0]!.id})`;
    expect(await emailJobs(fam)).toEqual([]);
    expect(await api.db.sql`select id from public.safety_reports where id = ${reportId}`).toEqual(
      [],
    );
  });
});

describe('a refusing provider (staging/production without an email adapter)', () => {
  it('records "failed" at once, retries a bounded number of times, then dead-letters; the list says so', async () => {
    const { fam, reportId } = await flaggedFamily();
    const staging: JobDeps = {
      ...deps,
      config: { ...api.config, environment: 'staging' },
      providers: { ...api.providers, email: refusingEmail },
    };
    const before = api.providers.email.outbox.length;
    const [job] = await emailJobs(fam);
    let report = { succeeded: 0, retried: 0, deadLettered: 0 };
    for (let attempt = 1; attempt <= job!.max_attempts; attempt += 1) {
      // Past any backoff the ledger applied (capped at six hours).
      await dueNow(fam, 7 * 3600_000);
      report = await runJobs(staging, EMAIL_ONLY);
      if (attempt < job!.max_attempts) {
        expect(report).toEqual({ succeeded: 0, retried: 1, deadLettered: 0 });
        expect((await emailJobs(fam))[0]).toMatchObject({
          status: 'failed_retryable',
          attempts: attempt,
        });
      }
      // The family's list is truthful from the first refusal on.
      expect(await emailState(reportId)).toEqual({ status: 'failed', at: null });
    }
    expect(report).toEqual({ succeeded: 0, retried: 0, deadLettered: 1 });
    const [final] = await emailJobs(fam);
    expect(final).toMatchObject({
      status: 'dead_letter',
      attempts: job!.max_attempts,
      // The pipeline code, not the class name (JOBS-R1-04): the refusing provider fails the send.
      last_error_code: 'EMAIL_SEND_FAILED',
    });
    // Bounded: nothing more is claimed.
    await dueNow(fam, 7 * 3600_000);
    expect(await runJobs(staging, EMAIL_ONLY)).toEqual({
      succeeded: 0,
      retried: 0,
      deadLettered: 0,
    });
    expect(api.providers.email.outbox.length).toBe(before);
    expect((await familyList(fam))[0]).toMatchObject({
      id: reportId,
      emailStatus: 'failed',
      emailedAt: null,
    });
    expect(api.logs).toContainEqual(
      expect.objectContaining({
        event: 'safety_flag_email_send_failed',
        code: 'EMAIL_SEND_FAILED',
      }),
    );
    expect(api.logs).toContainEqual(
      expect.objectContaining({ event: 'job_dead_letter', code: 'safety_flag_email' }),
    );
  });

  it('outside development and test the outbox mock is never used: no email, "failed", a retry', async () => {
    const { fam, reportId } = await flaggedFamily();
    const stagingWithMock: JobDeps = { ...deps, config: { ...api.config, environment: 'staging' } };
    const before = api.providers.email.outbox.length;
    await dueNow(fam);
    expect(await runJobs(stagingWithMock, EMAIL_ONLY)).toEqual({
      succeeded: 0,
      retried: 1,
      deadLettered: 0,
    });
    expect(api.providers.email.outbox.length).toBe(before);
    expect(await emailState(reportId)).toEqual({ status: 'failed', at: null });
    expect(api.logs).toContainEqual(
      expect.objectContaining({ event: 'safety_flag_email_blocked', code: 'EMAIL_PROVIDER_MOCK' }),
    );
  });
});
