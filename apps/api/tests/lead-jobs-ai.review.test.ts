import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMockResponsesClient,
  type ResponsesClient,
  type ResponsesRequest,
  type ResponsesResult,
} from '@pencillift/ai';
import { cryptoRandom } from '@pencillift/domain';
import {
  grantAdultUnlock,
  seedFamily,
  seedOwnerAdmin,
  type SeededFamily,
} from '@pencillift/db/testing/fixtures';
import {
  inactivitySweep,
  purgeExpiredScans,
  runJobs,
  runScheduledTick,
  type JobDeps,
  type JobHandler,
  type JobRow,
} from '../src/jobs/dispatcher.ts';
import { createScanProcessHandler } from '../src/jobs/scan-process.ts';
import { stripImageMetadata } from '../src/services/image-metadata.ts';
import type { Db } from '../src/db.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * Adversarial review of the jobs / AI slice (dispatcher, scan processing, image metadata, deletion
 * purge, retention). Every test here states the behaviour the spec requires and is expected to FAIL
 * against the code under review; see the RV-lead-jobs-ai-N ids. Real local Postgres, a LABELED MOCK
 * AI client and the in-memory storage mock. Synthetic worksheet content and names only.
 */

interface Env {
  api: TestApi;
  deps: JobDeps;
}

const envs: Env[] = [];

async function env(): Promise<Env> {
  const api = await createTestApi();
  const deps: JobDeps = {
    db: api.apiDb,
    config: api.config,
    clock: () => api.now.value,
    random: cryptoRandom,
    providers: api.providers,
    log: (e) => api.logs.push(e),
  };
  const e = { api, deps };
  envs.push(e);
  return e;
}

afterAll(async () => {
  for (const e of envs) await e.api.close();
});

const DAY = 86_400_000;

function shift(e: Env, ms: number): void {
  e.api.now.value = new Date(e.api.now.value.getTime() + ms);
}

// ---------------------------------------------------------------------------------------------
// Scripted mock model (labeled mock) and scan fixtures
// ---------------------------------------------------------------------------------------------

interface Q {
  page: number;
  number: string;
  prompt: string;
  answer: string | null;
  kind: string;
  subject?: string;
  /** The key the (mock) grading model reports. */
  key: string;
  verdict: 'correct' | 'incorrect';
  verifier?: 'correct' | 'incorrect';
  /** Coaching hint text the (mock) tutor model returns. */
  hint?: string;
}

function envelope(request: ResponsesRequest): Record<string, unknown> {
  const part = request.input.find((p) => p.type === 'input_text');
  if (!part || part.type !== 'input_text') throw new Error('no data envelope');
  return (JSON.parse(part.text.replace(/^DATA:\n/, '')) as { data: Record<string, unknown> }).data;
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

interface ModelOptions {
  /** Called for every extraction request (lets a retry see a different transcription). */
  questions: () => Q[];
  /** Runs before the scripted answer is produced (e.g. a parent acting mid-run). */
  before?: (request: ResponsesRequest) => Promise<void>;
  /** Number of grading requests that fail with a retryable provider error. */
  gradingFailures?: number;
}

function scriptedModel(options: ModelOptions): ResponsesClient & { requests: ResponsesRequest[] } {
  let gradingFailures = options.gradingFailures ?? 0;
  let last: Q[] = [];
  const byPrompt = () => new Map(last.map((q) => [q.prompt, q]));
  return createMockResponsesClient(async (request) => {
    if (options.before) await options.before(request);
    const data = envelope(request);
    switch (request.outputName) {
      case 'homework_extraction': {
        last = options.questions();
        return ok({
          pages: (data.pageNumbers as number[]).map((n) => ({
            pageNumber: n,
            readable: true,
            issues: [],
          })),
          questions: last.map((q) => ({
            pageNumber: q.page,
            questionNumber: q.number,
            boundingBox: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
            promptText: q.prompt,
            studentAnswerText: q.answer,
            answerKind: q.kind,
            subject: q.subject ?? 'math',
            skill: 'synthetic skill',
            gradeEstimate: 4,
            uncertainty: 'low',
          })),
        });
      }
      case 'private_grading': {
        if (gradingFailures > 0) {
          gradingFailures -= 1;
          return { kind: 'error', status: 503, retryable: true, latencyMs: 10, timedOut: false };
        }
        const map = byPrompt();
        return ok({
          results: (data.questions as { questionNumber: string; prompt: string }[]).map((q) => {
            const s = map.get(q.prompt)!;
            return {
              questionNumber: q.questionNumber,
              verdict: s.verdict,
              correctAnswer: s.key,
              workedSolution: `Worked solution for ${q.questionNumber}`,
              misconception: s.verdict === 'incorrect' ? 'slipped on one step' : null,
              rubric: null,
              evidence: 'student work visible',
              confidence: 'high',
            };
          }),
        });
      }
      case 'independent_verification': {
        const map = byPrompt();
        return ok({
          results: (data.questions as { questionNumber: string; prompt: string }[]).map((q) => {
            const s = map.get(q.prompt)!;
            const verdict = s.verifier ?? s.verdict;
            return {
              questionNumber: q.questionNumber,
              agrees: verdict === s.verdict,
              verdict,
              reason: 'checked independently',
              confidence: 'high',
            };
          }),
        });
      }
      case 'child_coaching_packet': {
        const s = byPrompt().get(data.question as string)!;
        return ok(
          {
            steps: [
              { kind: 'concept', text: 'Let us look at the idea behind this question together.' },
              { kind: 'hint', text: s.hint ?? 'Try the first step again slowly.' },
            ],
            retryPrompt: 'Give it another try!',
          },
          'gpt-6-astra',
        );
      }
      default:
        throw new Error(`unexpected stage ${request.outputName}`);
    }
  });
}

/** Structurally valid synthetic JPEG (SOI, JFIF, quant table, frame, scan, EOI). */
function syntheticJpeg(): Uint8Array {
  const seg = (marker: number, payload: number[]) => [
    0xff,
    marker,
    0,
    payload.length + 2,
    ...payload,
  ];
  return new Uint8Array([
    0xff,
    0xd8,
    ...seg(
      0xe0,
      Array.from('JFIF\0', (c) => c.charCodeAt(0)),
    ),
    ...seg(0xdb, [0, ...new Array<number>(64).fill(1)]),
    ...seg(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
    ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
    0x12,
    0x34,
    0xff,
    0xd9,
  ]);
}

function scanHandler(client: ResponsesClient): JobHandler {
  return createScanProcessHandler({
    ai: client,
    readObject: () => Promise.resolve(syntheticJpeg()),
    sleep: () => Promise.resolve(),
  });
}

interface Scan {
  fam: SeededFamily;
  childId: string;
  assignmentId: string;
  reservationId: string;
  jobId: string;
}

async function consent(e: Env, fam: SeededFamily): Promise<void> {
  await e.api.db.sql`
    insert into public.consent_records (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
    values (${fam.familyId}, ${fam.ownerId}, 'mock', 'mock', 'child_learning_data', 'v1', 'verified', true, now())`;
}

/** A finalized scan exactly as the finalize route leaves it: queued assignment, reservation, job. */
async function queuedScan(
  e: Env,
  options: { pages?: number; maxAttempts?: number } = {},
): Promise<Scan> {
  const sql = e.api.db.sql;
  const fam = await seedFamily(e.api.db, { childCount: 1 });
  await consent(e, fam);
  const childId = fam.children[0]!.id;
  const pages = options.pages ?? 1;
  const [a] = await sql<{ id: string }[]>`
    insert into public.assignments (family_id, child_id, idempotency_key, created_by_kind, page_count, status)
    values (${fam.familyId}, ${childId}, ${'scan-' + randomUUID()}, 'child', ${pages}, 'queued') returning id`;
  for (let n = 1; n <= pages; n++) {
    const pageId = randomUUID();
    const path = `${fam.familyId}/${childId}/${a!.id}/${pageId}.jpg`;
    await sql`
      insert into public.source_pages (id, assignment_id, family_id, child_id, page_number, storage_path, mime_type, byte_size, sha256)
      values (${pageId}, ${a!.id}, ${fam.familyId}, ${childId}, ${n}, ${path}, 'image/jpeg', 10, ${'e'.repeat(64)})`;
    e.api.providers.storage.objects.add(path);
  }
  const [r] = await sql<{ id: string }[]>`
    insert into public.usage_reservations (family_id, child_id, period_key, units, idempotency_key)
    values (${fam.familyId}, ${childId}, 'pages:2026-09', ${pages}, ${`scan-usage:${a!.id}:v1`}) returning id`;
  const [j] = await sql<{ id: string }[]>`
    insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, max_attempts, run_after)
    values ('scan_process', ${`scan:${a!.id}:v1`}, ${fam.familyId}, ${childId},
            ${JSON.stringify({ assignmentId: a!.id, mode: 'initial', reservationId: r!.id })}::text::jsonb,
            ${options.maxAttempts ?? 5}, ${new Date(e.api.now.value.getTime() - 1000)})
    returning id`;
  return { fam, childId, assignmentId: a!.id, reservationId: r!.id, jobId: j!.id };
}

async function jobRow(e: Env, id: string): Promise<JobRow> {
  const [row] = await e.api.db.sql<JobRow[]>`
    select id, kind, family_id, child_id, payload, attempts, max_attempts from public.jobs where id = ${id}`;
  return row!;
}

async function feedbackBodies(e: Env, assignmentId: string): Promise<string[]> {
  const rows = await e.api.db.sql<{ body: string }[]>`
    select f.body from public.child_feedback f
      join public.extracted_questions q on q.id = f.question_id
     where q.assignment_id = ${assignmentId}`;
  return rows.map((r) => r.body);
}

// =============================================================================================
// Job ledger / dispatcher
// =============================================================================================

describe('job ledger under realistic run times (spec E4 Scheduling, P5 "durable server job")', () => {
  let e: Env;
  beforeAll(async () => {
    e = await env();
  });

  it('RV-lead-jobs-ai-1: a job claimed in a batch is never run twice when earlier jobs outlast the 10-minute lock', async () => {
    const sql = e.api.db.sql;
    const queue = async (ageMs: number) => {
      const [row] = await sql<{ id: string }[]>`
        insert into public.jobs (kind, idempotency_key, family_id, run_after)
        values ('payout_prepare', ${'rv1:' + randomUUID()}, null, ${new Date(e.api.now.value.getTime() - ageMs)})
        returning id`;
      return row!.id;
    };
    const ids = [await queue(2000), await queue(1000)];
    const runs = new Map<string, number>();
    let overlapping: Promise<unknown> | null = null;
    const start = e.api.now.value;
    const handlers: Record<string, JobHandler> = {
      payout_prepare: async (_d, job) => {
        runs.set(job.id, (runs.get(job.id) ?? 0) + 1);
        if (overlapping === null) {
          // The first job of the batch takes 11 minutes (a multi-page scan: extraction, grading,
          // verification and per-question Astra coaching, each with retries). Meanwhile the next
          // 5-minute Cron Trigger tick runs in another isolate.
          shift(e, 11 * 60_000);
          overlapping = runJobs(e.deps, handlers);
          await overlapping;
        }
      },
    };
    try {
      await runJobs(e.deps, handlers);
    } finally {
      e.api.now.value = start;
    }
    // Both jobs were claimed (status running) by the first tick; each must run exactly once.
    expect(ids.map((id) => runs.get(id))).toEqual([1, 1]);
  });

  it('RV-lead-jobs-ai-2: a scan whose final attempt is lost to an expired lock ends failed_final and releases its allowance', async () => {
    const scan = await queuedScan(e, { maxAttempts: 1 });
    const sql = e.api.db.sql;
    // A worker claimed the only (final) attempt, entered extraction, then died (Worker wall-time
    // limit, deploy, isolate eviction) — exactly the case the LOCK_EXPIRED recovery exists for.
    await sql`update public.jobs set status = 'running', attempts = 1,
                locked_until = ${new Date(e.api.now.value.getTime() - 60_000)} where id = ${scan.jobId}`;
    await sql`update public.assignments set status = 'extracting' where id = ${scan.assignmentId}`;

    const client = scriptedModel({ questions: () => [] });
    await runJobs(e.deps, { scan_process: scanHandler(client) });

    const [state] = await sql<{ job: string; assignment: string; reservation: string }[]>`
      select (select status from public.jobs where id = ${scan.jobId}) as job,
             (select status from public.assignments where id = ${scan.assignmentId}) as assignment,
             (select status from public.usage_reservations where id = ${scan.reservationId}) as reservation`;
    expect(state!.job).toBe('dead_letter');
    // The scan can never progress again: it must not sit in "extracting" forever holding the
    // child's monthly page allowance (spec P5 failed_final; P11 failed scans do not consume it).
    expect(state!.assignment).toBe('failed_final');
    expect(state!.reservation).toBe('released');
  });
});

// =============================================================================================
// Deletion and retention (spec P4, E4 Deletion)
// =============================================================================================

describe('deletion purge and raw-file retention (spec P4, E4 Deletion)', () => {
  let e: Env;
  beforeAll(async () => {
    e = await env();
  });

  async function readyExport(fam: SeededFamily, kind: string, childId: string | null) {
    const [row] = await e.api.db.asParent(
      fam.ownerId,
      (tx) =>
        tx<
          { id: string }[]
        >`select public.request_export(${fam.familyId}, ${kind}, ${childId}::uuid) as id`,
    );
    const ext = kind === 'family_data' ? 'json' : 'pdf';
    const path = `exports/${fam.familyId}/${row!.id}.${ext}`;
    // What the export builder leaves behind: a ready row and the private file in storage.
    await e.api.db.sql`
      update public.data_exports set status = 'ready', storage_path = ${path},
             expires_at = ${new Date(e.api.now.value.getTime() + 7 * DAY)}
       where id = ${row!.id}`;
    e.api.providers.storage.objects.add(path);
    return { id: row!.id, path };
  }

  it('RV-lead-jobs-ai-4: a family deletion removes the family’s export files from storage', async () => {
    const fam = await seedFamily(e.api.db, { childCount: 1 });
    await grantAdultUnlock(e.api.db, fam.ownerId);
    const exported = await readyExport(fam, 'family_data', null);
    await e.api.db.asParent(
      fam.ownerId,
      (tx) => tx`select public.request_deletion(${fam.familyId}, null)`,
    );
    await runJobs(e.deps);
    const [job] = await e.api.db.sql<{ status: string }[]>`
      select status from public.jobs where family_id = ${fam.familyId} and kind = 'deletion_purge'`;
    expect(job!.status).toBe('succeeded');
    const [rows] = await e.api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.data_exports where family_id = ${fam.familyId}`;
    expect(rows!.n).toBe(0); // the row is purged ...
    // ... but the file holding the whole family's data must not outlive it.
    expect(e.api.providers.storage.objects.has(exported.path)).toBe(false);
  });

  it('RV-lead-jobs-ai-4: a child deletion removes that child’s export files from storage', async () => {
    const fam = await seedFamily(e.api.db, { childCount: 2 });
    await grantAdultUnlock(e.api.db, fam.ownerId);
    const doomed = fam.children[0]!.id;
    const exported = await readyExport(fam, 'progress_pdf', doomed);
    await e.api.db.asParent(
      fam.ownerId,
      (tx) => tx`select public.request_deletion(${fam.familyId}, ${doomed})`,
    );
    await runJobs(e.deps);
    const [left] = await e.api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.child_profiles where id = ${doomed}`;
    expect(left!.n).toBe(0);
    expect(e.api.providers.storage.objects.has(exported.path)).toBe(false);
  });

  it('RV-lead-jobs-ai-5: pages of a cancelled scan whose storage delete failed are removed by the 30-day retention purge', async () => {
    const fam = await seedFamily(e.api.db, { childCount: 1 });
    const childId = fam.children[0]!.id;
    await e.api.db.sql`
      insert into public.consent_records (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
      values (${fam.familyId}, ${fam.ownerId}, 'development_mock', 'development_mock', 'child_data_processing', 'v1', 'verified', true, now())`;
    await e.api.db.sql`
      insert into public.family_capacity (family_id, paid_slots, managing_channel)
      values (${fam.familyId}, 1, 'app_store') on conflict (family_id) do update set paid_slots = 1`;
    const token = await parentToken(fam.ownerId);
    const created = await e.api.request('/v1/assignments', {
      method: 'POST',
      token,
      body: { childId, pageCount: 1, idempotencyKey: randomUUID() },
    });
    expect(created.status).toBe(201);
    const id = (await json<{ assignment: { id: string } }>(created)).assignment.id;
    const uploaded = await e.api.request(`/v1/assignments/${id}/uploads`, {
      method: 'POST',
      token,
      body: {
        pages: [
          { pageNumber: 1, mimeType: 'image/jpeg', byteSize: 250_000, sha256: 'a'.repeat(64) },
        ],
      },
    });
    expect(uploaded.status).toBe(200);
    const [page] = await e.api.db.sql<{ storage_path: string }[]>`
      select storage_path from public.source_pages where assignment_id = ${id}`;
    e.api.providers.storage.objects.add(page!.storage_path); // the device PUT the photo

    // The cancel route deletes the photo right away; its storage call fails transiently. The route
    // documents: "the retention purge job removes anything left behind".
    const storage = e.api.providers.storage;
    const originalRemove = storage.remove.bind(storage);
    storage.remove = () => Promise.reject(new Error('storage unavailable'));
    try {
      const cancelled = await e.api.request(`/v1/assignments/${id}/cancel`, {
        method: 'POST',
        token,
      });
      expect(cancelled.status).toBe(200);
    } finally {
      storage.remove = originalRemove;
    }
    expect(storage.objects.has(page!.storage_path)).toBe(true);

    const start = e.api.now.value;
    shift(e, 31 * DAY);
    try {
      await purgeExpiredScans(e.deps);
    } finally {
      e.api.now.value = start;
    }
    // Raw homework photos are kept at most 30 days (spec P4).
    expect(storage.objects.has(page!.storage_path)).toBe(false);
  });

  it('RV-lead-jobs-ai-17: deleting a child does not hand the family a fresh page allowance for the month', async () => {
    const fam = await seedFamily(e.api.db, { childCount: 1 });
    const [first] = fam.children;
    await e.api.db.sql`
      insert into public.consent_records (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
      values (${fam.familyId}, ${fam.ownerId}, 'development_mock', 'development_mock', 'child_data_processing', 'v1', 'verified', true, now())`;
    await e.api.db.sql`
      insert into public.family_capacity (family_id, paid_slots, managing_channel)
      values (${fam.familyId}, 1, 'app_store') on conflict (family_id) do update set paid_slots = 1`;
    // One paid slot; this month the child has used the whole 40-page allowance (AI already paid).
    await e.api.db.sql`
      insert into public.usage_reservations (family_id, child_id, period_key, units, idempotency_key, status)
      values (${fam.familyId}, ${first!.id}, 'pages:2026-09', 40, ${'scan-usage:' + randomUUID() + ':v1'}, 'committed')`;
    const token = await parentToken(fam.ownerId);
    const before = await e.api.request('/v1/assignments', {
      method: 'POST',
      token,
      body: { childId: first!.id, pageCount: 1, idempotencyKey: randomUUID() },
    });
    expect(before.status).toBe(422); // control: the month really is used up
    await grantAdultUnlock(e.api.db, fam.ownerId);
    await e.api.db.asParent(
      fam.ownerId,
      (tx) => tx`select public.request_deletion(${fam.familyId}, ${first!.id})`,
    );
    await runJobs(e.deps);
    // The parent adds a new profile on the freed slot (no new purchase needed) ...
    const [second] = await e.api.db.sql<{ id: string }[]>`
      insert into public.child_profiles (family_id, nickname, grade_level, age_band, status)
      values (${fam.familyId}, 'Sam', 3, '8-10', 'active') returning id`;
    const res = await e.api.request('/v1/assignments', {
      method: 'POST',
      token,
      body: { childId: second!.id, pageCount: 1, idempotencyKey: randomUUID() },
    });
    // ... but the family's month is still used up (spec P11: removing profiles must not reset
    // existing usage or farm allowances).
    expect(res.status).toBe(422);
    expect((await json<{ error: { rule?: string } }>(res)).error.rule).toBe('QUOTA_EXCEEDED');
  });

  it('RV-lead-jobs-ai-20: a photo whose signed upload finishes after the family purge does not stay in storage', async () => {
    const fam = await seedFamily(e.api.db, { childCount: 1 });
    const childId = fam.children[0]!.id;
    await e.api.db.sql`
      insert into public.consent_records (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
      values (${fam.familyId}, ${fam.ownerId}, 'development_mock', 'development_mock', 'child_data_processing', 'v1', 'verified', true, now())`;
    await e.api.db.sql`
      insert into public.family_capacity (family_id, paid_slots, managing_channel)
      values (${fam.familyId}, 1, 'app_store') on conflict (family_id) do update set paid_slots = 1`;
    const token = await parentToken(fam.ownerId);
    const created = await e.api.request('/v1/assignments', {
      method: 'POST',
      token,
      body: { childId, pageCount: 1, idempotencyKey: randomUUID() },
    });
    expect(created.status).toBe(201);
    const id = (await json<{ assignment: { id: string } }>(created)).assignment.id;
    const uploaded = await e.api.request(`/v1/assignments/${id}/uploads`, {
      method: 'POST',
      token,
      body: {
        pages: [
          { pageNumber: 1, mimeType: 'image/jpeg', byteSize: 250_000, sha256: 'b'.repeat(64) },
        ],
      },
    });
    expect(uploaded.status).toBe(200);
    const [page] = await e.api.db.sql<{ storage_path: string }[]>`
      select storage_path from public.source_pages where assignment_id = ${id}`;
    // The device holds a 15-minute signed upload URL and is still sending the photo on a slow
    // connection when the parent deletes the family; the next 5-minute tick purges it.
    await grantAdultUnlock(e.api.db, fam.ownerId);
    await e.api.db.asParent(
      fam.ownerId,
      (tx) => tx`select public.request_deletion(${fam.familyId}, null)`,
    );
    await runJobs(e.deps);
    const [purge] = await e.api.db.sql<{ status: string; pages: number }[]>`
      select (select status from public.jobs where family_id = ${fam.familyId} and kind = 'deletion_purge') as status,
             (select count(*)::int from public.source_pages where family_id = ${fam.familyId}) as pages`;
    expect(purge).toEqual({ status: 'succeeded', pages: 0 }); // the purge itself completed
    e.api.providers.storage.objects.add(page!.storage_path); // the PUT completes afterwards
    const start = e.api.now.value;
    shift(e, 31 * DAY); // past the URL expiry and the proposed 30-day deletion target
    try {
      await runScheduledTick(e.deps);
    } finally {
      e.api.now.value = start;
    }
    // Spec P4: active uploads are purged on deletion and a race must not recreate deleted data.
    expect(e.api.providers.storage.objects.has(page!.storage_path)).toBe(false);
  });

  it('RV-lead-jobs-ai-6: expired export files are removed from storage by the retention sweep', async () => {
    const fam = await seedFamily(e.api.db, { childCount: 1 });
    await grantAdultUnlock(e.api.db, fam.ownerId);
    const exported = await readyExport(fam, 'review_answer_key_pdf', fam.children[0]!.id);
    const start = e.api.now.value;
    shift(e, 30 * DAY); // well past the 7-day export TTL
    try {
      await runScheduledTick(e.deps);
    } finally {
      e.api.now.value = start;
    }
    // A parent-only answer-key file must not stay in private storage indefinitely.
    expect(e.api.providers.storage.objects.has(exported.path)).toBe(false);
  });
});

// =============================================================================================
// Scan processing (spec P4, P5, P6, P12)
// =============================================================================================

describe('scan processing races and answer protection (spec P4, P5, P6)', () => {
  let e: Env;
  beforeAll(async () => {
    e = await env();
  });

  const WORKSHEET: Q[] = [
    {
      page: 1,
      number: '1',
      prompt: '3/4 + 1/8 =',
      answer: '7/8',
      kind: 'numeric',
      key: '7/8',
      verdict: 'correct',
    },
    {
      page: 1,
      number: '2',
      prompt: 'Spell the word for a baby dog.',
      answer: 'pupy',
      kind: 'spelling',
      subject: 'spelling_vocabulary',
      key: 'puppy',
      verdict: 'incorrect',
    },
  ];

  it('RV-lead-jobs-ai-3: a family deletion requested mid-run stops the scan — no further child data goes to the AI provider', async () => {
    const scan = await queuedScan(e);
    await grantAdultUnlock(e.api.db, scan.fam.ownerId);
    const client = scriptedModel({
      questions: () => WORKSHEET,
      before: async (request) => {
        if (request.outputName !== 'homework_extraction') return;
        // The parent deletes the family while the extraction call is in flight.
        await e.api.db.asParent(
          scan.fam.ownerId,
          (tx) => tx`select public.request_deletion(${scan.fam.familyId}, null)`,
        );
      },
    });
    await scanHandler(client)(e.deps, await jobRow(e, scan.jobId));
    // Spec P4: "Deletion requests should stop processing immediately."
    expect(client.requests.map((r) => r.outputName)).toEqual(['homework_extraction']);
    const [written] = await e.api.db.sql<{ questions: number; feedback: number }[]>`
      select (select count(*)::int from public.extracted_questions where family_id = ${scan.fam.familyId}) as questions,
             (select count(*)::int from public.child_feedback where family_id = ${scan.fam.familyId}) as feedback`;
    expect(written).toEqual({ questions: 0, feedback: 0 });
  });

  it('RV-lead-jobs-ai-3: a child deletion requested mid-run stops that child’s scan', async () => {
    const scan = await queuedScan(e);
    await grantAdultUnlock(e.api.db, scan.fam.ownerId);
    const client = scriptedModel({
      questions: () => WORKSHEET,
      before: async (request) => {
        if (request.outputName !== 'homework_extraction') return;
        await e.api.db.asParent(
          scan.fam.ownerId,
          (tx) => tx`select public.request_deletion(${scan.fam.familyId}, ${scan.childId})`,
        );
      },
    });
    await scanHandler(client)(e.deps, await jobRow(e, scan.jobId));
    expect(client.requests.map((r) => r.outputName)).toEqual(['homework_extraction']);
  });

  it('RV-lead-jobs-ai-7: when the prompt-computed key decides, that key is protected in child hints (not only the model’s key)', async () => {
    const scan = await queuedScan(e);
    const q: Q = {
      page: 1,
      number: '4',
      prompt: '12 × 7 =',
      answer: '74',
      kind: 'numeric',
      key: '82', // the grading model's key is wrong; the deterministic key (84) decides "incorrect"
      verdict: 'incorrect',
      hint: 'So close! 12 × 7 is 84, so check your multiplication.',
    };
    await scanHandler(scriptedModel({ questions: () => [q] }))(e.deps, await jobRow(e, scan.jobId));
    const [result] = await e.api.db.sql<{ verdict: string; route: string }[]>`
      select r.verdict, r.route from public.question_results r
        join public.extracted_questions q on q.id = r.question_id
       where q.assignment_id = ${scan.assignmentId}`;
    expect(result).toEqual({ verdict: 'incorrect', route: 'deterministic' });
    const bodies = await feedbackBodies(e, scan.assignmentId);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body).not.toMatch(/\b84\b/); // spec P6: no final numeric value
  });

  it('RV-lead-jobs-ai-8: a multiple-choice key written with its option text still protects the letter', async () => {
    const scan = await queuedScan(e);
    const q: Q = {
      page: 1,
      number: '3',
      prompt: 'Which fraction is equal to 1/2? (A) 2/3 (B) 3/6 (C) 3/4',
      answer: 'A',
      kind: 'multiple_choice',
      key: 'B) 3/6',
      verdict: 'incorrect',
      hint: 'Look closely at choice B and compare its top and bottom numbers.',
    };
    await scanHandler(scriptedModel({ questions: () => [q] }))(e.deps, await jobRow(e, scan.jobId));
    const bodies = await feedbackBodies(e, scan.assignmentId);
    expect(bodies.length).toBeGreaterThan(0);
    // Spec P6: no original problem's multiple-choice letter in hints.
    for (const body of bodies) expect(body).not.toMatch(/\bchoice B\b/i);
  });

  it('RV-lead-jobs-ai-8: a numeric key written as an equation ("x = 4") still protects the value', async () => {
    const scan = await queuedScan(e);
    const q: Q = {
      page: 1,
      number: '6',
      prompt: 'Solve for x: 2x + 3 = 11',
      answer: 'x = 5',
      kind: 'numeric',
      key: 'x = 4',
      verdict: 'incorrect',
      hint: 'Undo the plus 3 first, then halve what is left: x is 4.',
    };
    await scanHandler(scriptedModel({ questions: () => [q] }))(e.deps, await jobRow(e, scan.jobId));
    const bodies = await feedbackBodies(e, scan.assignmentId);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body).not.toMatch(/\bx is 4\b/);
  });

  it('RV-lead-jobs-ai-9: a retry after a failure does not leave the first extraction’s questions behind as duplicates', async () => {
    const scan = await queuedScan(e);
    let extraction = 0;
    const client = scriptedModel({
      // Vision transcription is not deterministic: the retry labels the same two problems "1."/"2."
      questions: () => {
        extraction += 1;
        return extraction === 1
          ? WORKSHEET
          : WORKSHEET.map((w) => ({ ...w, number: `${w.number}.` }));
      },
      gradingFailures: 3, // the first run's grading stage exhausts its provider retries
    });
    const handler = scanHandler(client);
    const job = await jobRow(e, scan.jobId);
    await expect(handler(e.deps, { ...job, attempts: 1 })).rejects.toThrow();
    await handler(e.deps, { ...job, attempts: 2 });

    const [counts] = await e.api.db.sql<{ questions: number; attempts: number; results: number }[]>`
      select (select count(*)::int from public.extracted_questions where assignment_id = ${scan.assignmentId}) as questions,
             (select count(*)::int from public.question_results r join public.extracted_questions q on q.id = r.question_id
               where q.assignment_id = ${scan.assignmentId}) as results,
             (select count(*)::int from public.attempts a join public.extracted_questions q on q.id = a.question_instance_id
               where q.assignment_id = ${scan.assignmentId}) as attempts`;
    // The worksheet has two problems; the child's skill evidence must count each once.
    expect(counts).toEqual({ questions: 2, results: 2, attempts: 2 });
  });

  it('RV-lead-jobs-ai-19: a recheck after a transcription fix keeps the shown verdict and the skill evidence consistent with the parent override', async () => {
    const scan = await queuedScan(e);
    const client = scriptedModel({ questions: () => WORKSHEET });
    const handler = scanHandler(client);
    await handler(e.deps, await jobRow(e, scan.jobId));
    const [q] = await e.api.db.sql<{ id: string }[]>`
      select id from public.extracted_questions
       where assignment_id = ${scan.assignmentId} and prompt_text = 'Spell the word for a baby dog.'`;
    const session = randomUUID();
    await grantAdultUnlock(e.api.db, scan.fam.ownerId, session, 3600);
    const token = await parentToken(scan.fam.ownerId, { sessionId: session });

    // Lead fixture update (coverage pass): a correction queues a paid recheck, so since b0496a8 it
    // needs what any real scan implies — the child holds a paid slot. queuedScan inserts the scan
    // directly and skipped that precondition; the assertions below are unchanged.
    await e.api.db.sql`
      insert into public.family_capacity (family_id, paid_slots, managing_channel)
      values (${scan.fam.familyId}, 1, 'app_store')
      on conflict (family_id) do update set paid_slots = 1`;
    await e.api.db.sql`
      insert into public.child_slot_assignments (family_id, child_id)
      values (${scan.fam.familyId}, ${scan.fam.children[0]!.id})`;

    // The parent accepts the child's spelling (the teacher did) ...
    const overridden = await e.api.request(`/v1/questions/${q!.id}/override`, {
      method: 'POST',
      token,
      body: { verdict: 'correct', reason: 'The teacher accepted this spelling' },
    });
    expect(overridden.status).toBe(200);
    // ... then fixes a small transcription slip in the same answer, which queues a recheck.
    const corrected = await e.api.request(`/v1/questions/${q!.id}/correction`, {
      method: 'POST',
      token,
      body: { studentAnswerText: 'pupi' },
    });
    expect(corrected.status).toBe(200);
    const [recheck] = await e.api.db.sql<{ id: string }[]>`
      select id from public.jobs where idempotency_key = ${`scan:${scan.assignmentId}:v2`}`;
    await handler(e.deps, await jobRow(e, recheck!.id));

    const [state] = await e.api.db.sql<{ shown: string; evidence: string }[]>`
      select coalesce(r.parent_override_verdict, r.verdict) as shown,
             coalesce((select o.correctness from public.attempt_overrides o
                        where o.attempt_id = a.id order by o.created_at desc limit 1), a.correctness) as evidence
        from public.question_results r
        join public.attempts a on a.question_instance_id = r.question_id and a.attempt_number = 1
       where r.question_id = ${q!.id}`;
    // What the parent and child see and what the skill model learns from must agree (spec P5:
    // override "with audit history and recomputation of affected skill evidence").
    expect(state!.evidence).toBe(state!.shown);
  });
});

describe('global AI spend ceiling (spec F4, E4 Cost controls)', () => {
  let e: Env;
  beforeAll(async () => {
    e = await env();
  });

  it('RV-lead-jobs-ai-10: once the owner’s monthly ceiling is reached no further AI stage starts', async () => {
    const scan = await queuedScan(e);
    const adminId = await seedOwnerAdmin(e.api.db);
    const [spent] = await e.api.db.sql<{ micros: string }[]>`
      select coalesce(sum(cost_micros), 0)::text as micros from public.ai_usage_events`;
    // The ceiling is one micro-dollar above what has been spent this month.
    await e.api.db.sql`
      insert into public.spend_budgets (scope, period_key, budget_micros, created_by)
      values ('global', '2026-09', ${(BigInt(spent!.micros) + 1n).toString()}::bigint, ${adminId})`;
    const incorrect = (n: number): Q => ({
      page: 1,
      number: String(n),
      prompt: `Spell word number ${n}.`,
      answer: 'wrng',
      kind: 'spelling',
      subject: 'spelling_vocabulary',
      key: `word${n}`,
      verdict: 'incorrect',
    });
    const client = scriptedModel({ questions: () => [1, 2, 3, 4].map(incorrect) });
    await scanHandler(client)(e.deps, await jobRow(e, scan.jobId));
    const [after] = await e.api.db.sql<{ micros: string }[]>`
      select coalesce(sum(cost_micros), 0)::text as micros from public.ai_usage_events`;
    // Lead update (strict ceiling, coverage pass 2026-09-24): the original line here asserted the
    // ceiling WAS crossed by the first call — the lenient rule this review called a defect. With
    // admission requiring spent + held + estimate <= budget, no stage fits one micro-dollar of
    // headroom, so the stronger form holds: recorded spend never passes the owner's cap.
    expect(BigInt(after!.micros)).toBeLessThanOrEqual(BigInt(spent!.micros) + 1n);
    // Everything after the ceiling is spend the application must refuse ("Enforce caps in the
    // application because a provider alert may lag").
    expect(client.requests.length).toBeLessThanOrEqual(1);
    expect(client.requests).toEqual([]);
  });
});

// =============================================================================================
// Inactivity retention (spec P4: explicit period, parent notice, tested deletion)
// =============================================================================================

describe('inactivity retention (spec P4)', () => {
  let e: Env;
  let enabled: JobDeps;
  beforeAll(async () => {
    e = await env();
    enabled = {
      ...e.deps,
      config: {
        ...e.api.config,
        flags: { ...e.api.config.flags, inactivityDeletionEnabled: true },
      },
    };
  });

  async function idleFamily(): Promise<SeededFamily> {
    const fam = await seedFamily(e.api.db, { childCount: 1 });
    await e.api.db
      .sql`update public.families set created_at = '2025-08-01T00:00:00Z' where id = ${fam.familyId}`;
    return fam;
  }

  async function deleted(familyId: string): Promise<boolean> {
    const [row] = await e.api.db.sql<{ deleted: boolean }[]>`
      select deleted_at is not null as deleted from public.families where id = ${familyId}`;
    return row!.deleted;
  }

  it('RV-lead-jobs-ai-11: a family is never deleted for inactivity when its notice was never delivered', async () => {
    const fam = await idleFamily();
    const start = e.api.now.value;
    const outboxBefore = e.api.providers.email.outbox.length;
    const emailDown: JobDeps = {
      ...enabled,
      providers: {
        ...e.api.providers,
        email: { ...e.api.providers.email, send: () => Promise.reject(new Error('email down')) },
      },
    };
    try {
      await inactivitySweep(emailDown); // the notice email fails
      expect(e.api.providers.email.outbox.length).toBe(outboxBefore);
      shift(e, 31 * DAY);
      await inactivitySweep(emailDown);
    } finally {
      e.api.now.value = start;
    }
    // Spec P4: "notify the parent" before inactivity deletion — a notice nobody received is not one.
    expect(await deleted(fam.familyId)).toBe(false);
  });

  it('RV-lead-jobs-ai-12: a notice answered by child activity is not reused to delete the family a year later without a new notice', async () => {
    const fam = await idleFamily();
    const start = e.api.now.value;
    try {
      await inactivitySweep(enabled); // notice #1 at T
      // The next day the child starts a homework scan (child activity: no parent request, so the
      // notice is not cleared, but the family is no longer idle).
      await e.api.db.sql`
        insert into public.assignments (family_id, child_id, idempotency_key, created_by_kind, created_at)
        values (${fam.familyId}, ${fam.children[0]!.id}, ${'rv12-' + randomUUID()}, 'child',
                ${new Date(start.getTime() + DAY)})`;
      shift(e, 31 * DAY);
      await inactivitySweep(enabled);
      expect(await deleted(fam.familyId)).toBe(false); // correctly kept: activity after the notice

      // A year after that activity the family is idle again. The first sweep of the new idle
      // period must send a fresh notice, not delete on the strength of the 13-month-old one.
      e.api.now.value = new Date(start.getTime() + DAY + 366 * DAY + 2 * DAY);
      const outboxBefore = e.api.providers.email.outbox.length;
      await inactivitySweep(enabled);
      expect(await deleted(fam.familyId)).toBe(false);
      expect(e.api.providers.email.outbox.length).toBeGreaterThan(outboxBefore);
    } finally {
      e.api.now.value = start;
    }
  });

  it('RV-lead-jobs-ai-13: a family with an active paid subscription is not deleted for inactivity', async () => {
    const fam = await idleFamily();
    const [f] = await e.api.db.sql<{ billing_ref: string }[]>`
      select billing_ref from public.families where id = ${fam.familyId}`;
    await e.api.db.sql`
      insert into public.store_product_mappings (channel, product_id, environment, paid_slots)
      values ('app_store', 'pl_family_1', 'sandbox', 1) on conflict do nothing`;
    await e.api.db.sql`
      insert into public.family_capacity (family_id, paid_slots, managing_channel)
      values (${fam.familyId}, 1, 'app_store') on conflict (family_id) do update set paid_slots = 1`;
    // Auto-renewing monthly: the parent keeps being charged $39.99 whether or not anyone opens the app.
    await e.api.db.sql`
      insert into public.family_entitlements (family_id, channel, provider_subscription_id, product_id, paid_slots, status,
        environment, period_start, period_end, provider_updated_at, fetched_at)
      values (${fam.familyId}, 'app_store', ${`rc:${f!.billing_ref}:app_store:pl_family_1`}, 'pl_family_1', 1, 'active', 'sandbox',
              '2026-09-20T00:00:00Z', '2026-12-20T00:00:00Z', '2026-09-20T00:00:00Z', ${e.api.now.value})`;
    const start = e.api.now.value;
    try {
      await inactivitySweep(enabled);
      shift(e, 31 * DAY);
      await inactivitySweep(enabled);
    } finally {
      e.api.now.value = start;
    }
    expect(await deleted(fam.familyId)).toBe(false);
  });
});

describe('inactivity sweep throughput (spec P4 documented period and notice)', () => {
  it('RV-lead-jobs-ai-14: every idle family gets its notice even when more than 50 are idle', async () => {
    const e = await env();
    const enabled: JobDeps = {
      ...e.deps,
      config: {
        ...e.api.config,
        flags: { ...e.api.config.flags, inactivityDeletionEnabled: true },
      },
    };
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) {
      const fam = await seedFamily(e.api.db, { childCount: 0 });
      ids.push(fam.familyId);
    }
    await e.api.db
      .sql`update public.families set created_at = '2025-08-01T00:00:00Z' where id = any(${ids})`;
    const start = e.api.now.value;
    try {
      for (let day = 0; day < 5; day++) {
        await inactivitySweep(enabled); // the daily 03:00 UTC sweep
        shift(e, DAY);
      }
    } finally {
      e.api.now.value = start;
    }
    const [row] = await e.api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.families
       where id = any(${ids}) and inactivity_notified_at is null`;
    // After five daily sweeps, no idle family is still waiting for its first notice.
    expect(row!.n).toBe(0);
  });
});

describe('scheduled tick isolation (spec E4 Scheduling, P4 prompt deletion)', () => {
  /** Service DB whose inactivity-delete statement runs only after `before` (a racing request). */
  function interleaved(db: Db, before: () => Promise<void>): Db {
    return {
      ...db,
      asService: (fn) =>
        db.asService((tx) =>
          fn(
            new Proxy(tx, {
              apply(target, thisArg, args: unknown[]) {
                const strings = args[0];
                if (
                  Array.isArray(strings) &&
                  strings.join('?').includes('app.inactivity_delete_family')
                ) {
                  return before().then(() => Reflect.apply(target, thisArg, args) as unknown);
                }
                return Reflect.apply(target, thisArg, args) as unknown;
              },
            }),
          ),
        ),
    };
  }

  it('RV-lead-jobs-ai-15: a parent returning during the 03:00 inactivity sweep does not abort the tick (deletion purges still run)', async () => {
    const e = await env();
    const start = e.api.now.value;
    e.api.now.value = new Date('2026-09-25T03:01:00Z'); // inside the daily sweep window
    try {
      const config = {
        ...e.api.config,
        flags: { ...e.api.config.flags, inactivityDeletionEnabled: true },
      };
      // A family whose inactivity notice went out 31 days ago ...
      const idle = await seedFamily(e.api.db, { childCount: 1 });
      await e.api.db.sql`
        update public.families set created_at = '2025-06-01T00:00:00Z',
               inactivity_notified_at = ${new Date(e.api.now.value.getTime() - 31 * DAY)}
         where id = ${idle.familyId}`;
      // ... and an unrelated family whose deletion purge is due in this same tick.
      const leaving = await seedFamily(e.api.db, { childCount: 1 });
      await grantAdultUnlock(e.api.db, leaving.ownerId);
      await e.api.db.asParent(
        leaving.ownerId,
        (tx) => tx`select public.request_deletion(${leaving.familyId}, null)`,
      );
      // The idle family's parent opens the app while the sweep runs: after the candidate query,
      // before the delete call (evening in the Americas is 03:00 UTC).
      const token = await parentToken(idle.ownerId);
      let raced = false;
      const db = interleaved(e.api.apiDb, async () => {
        if (raced) return;
        raced = true;
        const res = await e.api.request('/v1/family', { token });
        expect(res.status).toBe(200);
      });
      let tickError: unknown = null;
      try {
        await runScheduledTick({ ...e.deps, config, db });
      } catch (error) {
        tickError = error;
      }
      expect(raced).toBe(true);
      const [idleState] = await e.api.db.sql<{ deleted: boolean }[]>`
        select deleted_at is not null as deleted from public.families where id = ${idle.familyId}`;
      expect(idleState!.deleted).toBe(false); // the returning parent keeps the family
      // One family's race must not stop the job ledger for everyone else.
      expect(tickError).toBeNull();
      const [job] = await e.api.db.sql<{ status: string }[]>`
        select status from public.jobs where family_id = ${leaving.familyId} and kind = 'deletion_purge'`;
      expect(job!.status).toBe('succeeded');
    } finally {
      e.api.now.value = start;
    }
  });
});

// =============================================================================================
// Image metadata (spec P4 "Strip EXIF and location metadata")
// =============================================================================================

function crc32(bytes: number[]): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

function pngChunk(type: string, data: number[]): number[] {
  const body = [...ascii(type), ...data];
  const crc = crc32(body);
  const len = data.length;
  return [
    len >>> 24,
    (len >> 16) & 255,
    (len >> 8) & 255,
    len & 255,
    ...body,
    crc >>> 24,
    (crc >> 16) & 255,
    (crc >> 8) & 255,
    crc & 255,
  ];
}

function contains(haystack: Uint8Array, needle: string): boolean {
  const n = ascii(needle);
  outer: for (let i = 0; i + n.length <= haystack.length; i++) {
    for (let k = 0; k < n.length; k++) if (haystack[i + k] !== n[k]) continue outer;
    return true;
  }
  return false;
}

describe('PNG metadata allow-list (spec P4, BUG-013 follow-up)', () => {
  it('RV-lead-jobs-ai-16: location metadata in non-standard or provenance PNG chunks never passes through', () => {
    const png = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]),
      // Pre-standard lowercase Exif chunk still written by some tools.
      ...pngChunk('exIf', ascii('MM\0*GPSLatitude=41.8781;GPSLongitude=-87.6298')),
      // C2PA / Content Credentials manifest (JUMBF) carrying an exif location assertion.
      ...pngChunk('caBX', ascii('jumbc2pa.assertions stds.exif exif:GPSLatitude 41.8781')),
      ...pngChunk('IDAT', [1, 2, 3]),
      ...pngChunk('IEND', []),
    ]);
    const out = stripImageMetadata(png, 'image/png');
    expect(contains(out, 'IDAT')).toBe(true); // the picture survives
    expect(contains(out, 'GPSLatitude')).toBe(false);
  });
});
