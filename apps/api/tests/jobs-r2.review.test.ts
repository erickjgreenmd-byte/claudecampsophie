import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { cryptoRandom } from '@pencillift/domain';
import { DEFAULT_RATE_TABLE_2026_09_18 } from '@pencillift/domain/quotas';
import {
  createMockResponsesClient,
  dataEnvelope,
  imagePart,
  OUTPUT_TRUNCATED_BUDGET_MULTIPLE,
  PROMPTS,
  PROPOSED_STAGE_LIMITS,
  runStage,
  type InputPart,
  type PromptDefinition,
} from '@pencillift/ai';
import { DEFAULT_HOMEWORK_UPLOAD_LIMITS, PARENT_SAFETY_FLAG_COPY } from '@pencillift/contracts';
import { seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import {
  DEFAULT_HANDLERS,
  exportBuildHandler,
  JOB_LEASE_MINUTES,
  runJobs,
  type JobDeps,
  type JobHandler,
} from '../src/jobs/dispatcher.ts';
import { createExportBuildHandler, storageUploader } from '../src/jobs/export-build.ts';
import { inputTokenUpperBound } from '../src/jobs/spend-ceiling.ts';
import { stripImageMetadata } from '../src/services/image-metadata.ts';
import { createTestApi, type TestApi } from './helpers.ts';

/**
 * Round-2 hardening of the job ledger, the private exports and the scan pipeline
 * (JOBS-R2-01/05/07/08, CS-R2-05, CS-R2-06). Real Postgres, labeled mocks for storage and email.
 * Synthetic family and worksheet content only.
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

async function queueExport(
  fam: SeededFamily,
  kind: string,
  childId: string | null = null,
): Promise<string> {
  const [row] = await api.db.sql<{ id: string }[]>`
    insert into public.data_exports (family_id, requested_by, kind, child_id)
    values (${fam.familyId}, ${fam.ownerId}, ${kind}, ${childId}) returning id`;
  await api.db.sql`
    insert into public.jobs (kind, idempotency_key, family_id, payload, run_after)
    values ('export_build', ${'export:' + row!.id}, ${fam.familyId},
            ${JSON.stringify({ exportId: row!.id })}::text::jsonb,
            ${new Date(api.now.value.getTime() - 1000)})`;
  return row!.id;
}

async function exportRow(id: string) {
  const [row] = await api.db.sql<
    { status: string; storage_path: string | null; expires_at: Date | null }[]
  >`select status, storage_path, expires_at from public.data_exports where id = ${id}`;
  return row!;
}

async function jobRow(exportId: string) {
  const [row] = await api.db.sql<
    { status: string; attempts: number; last_error_code: string | null }[]
  >`select status, attempts, last_error_code from public.jobs
     where idempotency_key = ${'export:' + exportId}`;
  return row!;
}

// ---------------------------------------------------------------------------------------------
// JOBS-R2-01: an upload that landed but whose answer was lost
// ---------------------------------------------------------------------------------------------

/**
 * A fetch that emulates Supabase's signed upload with `x-upsert: false`: the FIRST PUT stores the
 * object and then the answer is lost (the Worker's own timeout aborts it), and every later PUT to
 * the same path is refused as a duplicate. This is the shape that leaves an orphan behind.
 */
function upsertFalseFetch(): typeof fetch {
  const stored = new Set<string>();
  return ((url: string, init: RequestInit) => {
    const path = decodeURIComponent(new URL(url).pathname.replace('/upload/', ''));
    if (stored.has(path)) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            statusCode: '409',
            error: 'Duplicate',
            message: 'The resource already exists',
          }),
          { status: 400 },
        ),
      );
    }
    stored.add(path);
    // Storage kept the bytes; the labeled memory mock is the store the provider reads back.
    api.providers.storage.put(path, new Uint8Array(init.body as ArrayBuffer));
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    return Promise.reject(timeout);
  }) as unknown as typeof fetch;
}

describe('an export whose upload landed but whose answer was lost (JOBS-R2-01)', () => {
  it('the retry finishes the export instead of failing it, and no file is orphaned', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const id = await queueExport(fam, 'family_data');
    const handlers: Record<string, JobHandler> = {
      export_build: createExportBuildHandler({
        upload: storageUploader(api.providers.storage, upsertFalseFetch()),
      }),
    };
    // First tick: the object is stored, the answer is lost, the job retries.
    await runJobs(deps, handlers);
    expect(await exportRow(id)).toMatchObject({ status: 'queued' });
    expect(await jobRow(id)).toMatchObject({ last_error_code: 'UPLOAD_FAILED' });

    // Second tick: the same deterministic path is refused as a duplicate.
    api.now.value = new Date(api.now.value.getTime() + 2 * 3_600_000);
    await runJobs(deps, handlers);
    const row = await exportRow(id);
    // Before: every retry was refused, the last attempt marked the row 'failed' with storage_path
    // null, and the whole-family JSON stayed in private storage for ever.
    expect(row.status).toBe('ready');
    expect(row.storage_path).toBe(`exports/${fam.familyId}/${id}.json`);
    expect(api.providers.storage.objects.has(row.storage_path!)).toBe(true);
  });

  it('the deletion purge removes the file of a failed export, not only of a queued one', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const id = await queueExport(fam, 'family_data');
    const path = `exports/${fam.familyId}/${id}.json`;
    // The shape JOBS-R2-01 leaves behind: the bytes are in storage, the row says 'failed'.
    api.providers.storage.put(path, new TextEncoder().encode('{"family":[]}'));
    await api.db.sql`update public.data_exports set status = 'failed' where id = ${id}`;
    await api.db.sql`delete from public.jobs where idempotency_key = ${'export:' + id}`;

    await api.db.sql`
      insert into public.deletion_requests (family_id, scope, requested_by)
      values (${fam.familyId}, 'family', ${fam.ownerId})`;
    await api.db.sql`
      insert into public.jobs (kind, idempotency_key, family_id, payload, run_after)
      values ('deletion_purge', ${'purge:' + fam.familyId}, ${fam.familyId}, '{}'::jsonb,
              ${new Date(api.now.value.getTime() - 1000)})`;
    await runJobs(deps, DEFAULT_HANDLERS);
    // Before: only `storage_path` values and the deterministic paths of QUEUED exports were removed,
    // so a COPPA family deletion left a complete copy of every child's records in storage.
    expect(api.providers.storage.objects.has(path)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// JOBS-R2-05: export_build dead letters with nothing to settle its row
// ---------------------------------------------------------------------------------------------

describe('an export whose final attempt died (JOBS-R2-05)', () => {
  it('is marked failed by the dead-letter compensation, and its file is removed', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const id = await queueExport(fam, 'progress_csv', fam.children[0]!.id);
    const path = `exports/${fam.familyId}/${id}.csv`;
    api.providers.storage.put(path, new TextEncoder().encode('child,subject\r\n'));
    // A worker killed on the final attempt: the job is running with an expired lease.
    await api.db.sql`
      update public.jobs
         set status = 'running', attempts = max_attempts,
             locked_until = ${new Date(api.now.value.getTime() - (JOB_LEASE_MINUTES + 1) * 60_000)}
       where idempotency_key = ${'export:' + id}`;
    const report = await runJobs(deps, { export_build: exportBuildHandler });
    expect(report.deadLettered).toBe(1);
    expect(await jobRow(id)).toMatchObject({
      status: 'dead_letter',
      last_error_code: 'LOCK_EXPIRED',
    });
    // Before: exportBuildHandler had no onDeadLetter, so the row stayed 'queued' for ever and the
    // parent's export list showed "preparing" with no expiry.
    expect(await exportRow(id)).toMatchObject({ status: 'failed', storage_path: null });
    expect(api.providers.storage.objects.has(path)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// CS-R2-05: "All family data" must hold the child's homework records
// ---------------------------------------------------------------------------------------------

describe('the "All family data" export (CS-R2-05)', () => {
  it('holds the child’s answers, feedback, reward requests and flags, and no answer key or category', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const child = fam.children[0]!.id;
    await api.db.sql`
      update public.child_profiles
         set curriculum_notes = 'Riley is working on regrouping.',
             accessibility = ${JSON.stringify({ largeText: true })}::text::jsonb
       where id = ${child}`;
    const [a] = await api.db.sql<{ id: string }[]>`
      insert into public.assignments (family_id, child_id, idempotency_key, created_by_kind, page_count, status)
      values (${fam.familyId}, ${child}, ${'scan-' + randomUUID()}, 'child', 1, 'draft') returning id`;
    const pageId = randomUUID();
    await api.db.sql`
      insert into public.source_pages (id, assignment_id, family_id, child_id, page_number, storage_path, mime_type, byte_size, sha256)
      values (${pageId}, ${a!.id}, ${fam.familyId}, ${child}, 1,
              ${`${fam.familyId}/${child}/${a!.id}/${pageId}.jpg`}, 'image/jpeg', 12, ${'a'.repeat(64)})`;
    const [q] = await api.db.sql<{ id: string }[]>`
      insert into public.extracted_questions
        (assignment_id, family_id, child_id, page_id, question_number, prompt_text, student_answer_text,
         answer_kind, subject_key, skill, uncertainty)
      values (${a!.id}, ${fam.familyId}, ${child}, ${pageId}, '1', '12 × 7 =', '72', 'numeric', 'math',
              'multiplication facts', 'low')
      returning id`;
    await api.db.sql`
      update public.extracted_questions
         set corrected_student_answer_text = '84', corrected_by = ${fam.ownerId}, corrected_at = now()
       where id = ${q!.id}`;
    // The parent-only key and worked solution: they must never appear in this export.
    await api.db.sql`
      insert into private.question_solutions (question_id, family_id, correct_answer, worked_solution, grader_version)
      values (${q!.id}, ${fam.familyId}, ${'KEY-MARKER-84'}, ${'SOLUTION-MARKER: 12 groups of 7'}, 'scan.v1')`;
    await api.db.sql`
      insert into public.question_results (question_id, family_id, child_id, verdict, route, grader_version)
      values (${q!.id}, ${fam.familyId}, ${child}, 'incorrect', 'agreement', 'scan.v1')`;
    const [fb] = await api.db.sql<{ id: string }[]>`
      insert into public.child_feedback (question_id, family_id, child_id, kind, body, guard_version)
      values (${q!.id}, ${fam.familyId}, ${child}, 'hint', 'Try counting by sevens.', 'answer-guard.v1')
      returning id`;
    await api.db.sql`
      insert into public.target_answer_attempts (question_instance_id, family_id, child_id, count)
      values (${q!.id}, ${fam.familyId}, ${child}, 2)`;
    const [reward] = await api.db.sql<{ id: string }[]>`
      insert into public.rewards (family_id, child_id, title, point_cost, created_by)
      values (${fam.familyId}, ${child}, 'Extra story at bedtime', 20, ${fam.ownerId}) returning id`;
    await api.db.sql`
      insert into public.points_ledger (family_id, child_id, kind, points, idempotency_key, actor_kind)
      values (${fam.familyId}, ${child}, 'award', 30, ${'award:' + randomUUID()}, 'system')`;
    await api.db.sql`
      insert into public.reward_redemptions (family_id, child_id, reward_id, point_cost, state)
      values (${fam.familyId}, ${child}, ${reward!.id}, 20, 'pending')`;
    await api.db.sql`
      insert into public.safety_reports
        (family_id, child_id, reporter_kind, category, question_id, feedback_id, status,
         transcription_at, screen_categories, screen_version, family_visible)
      values (${fam.familyId}, ${child}, 'system', 'severe_risk', ${q!.id}, ${fb!.id}, 'escalated',
              now(), ${['self_harm']}::text[], 'safety-screen.v4', true)`;

    const id = await queueExport(fam, 'family_data');
    const uploads = new Map<string, Uint8Array>();
    await runJobs(deps, {
      export_build: createExportBuildHandler({
        upload: (path, bytes) => {
          uploads.set(path, bytes);
          return Promise.resolve();
        },
      }),
    });
    const row = await exportRow(id);
    expect(row.status).toBe('ready');
    const body = new TextDecoder().decode(uploads.get(row.storage_path!));
    const data = JSON.parse(body) as Record<string, unknown[]>;
    // Before: familyData() read only families, children, subjects, schedules, test dates, study
    // materials, practice sets/items, attempts and the points ledger, so a parent exercising the
    // COPPA right to a copy got none of the child's homework answers or reward requests.
    for (const key of [
      'assignments',
      'questions',
      'questionResults',
      'childFeedback',
      'targetAnswerAttempts',
      'rewards',
      'rewardRedemptions',
      'pointBalances',
      'safetyFlags',
    ]) {
      expect(data[key], key).toHaveLength(1);
    }
    expect(body).toContain('12 × 7 =');
    expect(body).toContain('Try counting by sevens.');
    expect(body).toContain('Riley is working on regrouping.');
    expect(body).toContain('Extra story at bedtime');
    // Parent-only solutions stay out, and the flag carries no kind of concern (CS-R2-02).
    expect(body).not.toContain('KEY-MARKER-84');
    expect(body).not.toContain('SOLUTION-MARKER');
    expect(body).not.toContain('severe_risk');
    expect(body).not.toContain('self_harm');
    expect(body).not.toMatch(/PROVIDER_/);
  });
});

// ---------------------------------------------------------------------------------------------
// JOBS-R2-07: the claim budget is measured from the tick's own start
// ---------------------------------------------------------------------------------------------

describe('the tick claim budget (JOBS-R2-07)', () => {
  it('claims no scan when the invocation has less wall time left than a scan may need', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const [a] = await api.db.sql<{ id: string }[]>`
      insert into public.assignments (family_id, child_id, idempotency_key, created_by_kind, page_count, status)
      values (${fam.familyId}, ${fam.children[0]!.id}, ${'scan-' + randomUUID()}, 'child', 1, 'queued')
      returning id`;
    await api.db.sql`
      insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, run_after)
      values ('scan_process', ${'scan:' + a!.id + ':v1'}, ${fam.familyId}, ${fam.children[0]!.id},
              ${JSON.stringify({ assignmentId: a!.id, mode: 'initial' })}::text::jsonb,
              ${new Date(api.now.value.getTime() - 1000)})`;
    await api.db.sql`
      insert into public.jobs (kind, idempotency_key, family_id, payload, run_after)
      values ('deletion_purge', ${'purge-budget:' + randomUUID()}, null, '{}'::jsonb,
              ${new Date(api.now.value.getTime() - 1000)})`;
    let scans = 0;
    let purges = 0;
    const handlers: Record<string, JobHandler> = {
      scan_process: () => {
        scans += 1;
        return Promise.resolve();
      },
      deletion_purge: () => {
        purges += 1;
        return Promise.resolve();
      },
    };
    // The ledger starts nine minutes into an invocation that lives fifteen: a scan (up to two
    // 45-second coaching calls per incorrect question) cannot finish in what is left.
    const tickStart = new Date(api.now.value.getTime() - 9 * 60_000);
    await runJobs(deps, handlers, 25, tickStart);
    // Before: the budget was measured from runJobs' own start, so a job could be claimed at minute
    // 14, be killed mid-run, spend an attempt and stay invisible until its 20-minute lease expired.
    expect(scans).toBe(0);
    expect(purges).toBe(1);
    const [scanJob] = await api.db.sql<{ status: string; attempts: number }[]>`
      select status, attempts from public.jobs where idempotency_key = ${'scan:' + a!.id + ':v1'}`;
    expect(scanJob).toMatchObject({ status: 'queued', attempts: 0 });

    // A tick that starts now has the whole invocation: the scan is claimed.
    await runJobs(deps, handlers, 25, api.now.value);
    expect(scans).toBe(1);
  });

  /**
   * R4-JOBS-4: the steps AFTER the ledger (the entitlement sweep, up to 25 sequential store calls)
   * only run if the ledger leaves them wall time. A scan claimed with exactly its worst case left
   * runs to the invocation limit, so the sweep got nothing and no family's lapsed subscription was
   * noticed on that tick. The ledger must reserve the trailing slice.
   */
  it('leaves the steps that follow the ledger a reserved slice of the invocation', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const [a] = await api.db.sql<{ id: string }[]>`
      insert into public.assignments (family_id, child_id, idempotency_key, created_by_kind, page_count, status)
      values (${fam.familyId}, ${fam.children[0]!.id}, ${'scan-' + randomUUID()}, 'child', 1, 'queued')
      returning id`;
    await api.db.sql`
      insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, run_after)
      values ('scan_process', ${'scan:' + a!.id + ':v1'}, ${fam.familyId}, ${fam.children[0]!.id},
              ${JSON.stringify({ assignmentId: a!.id, mode: 'initial' })}::text::jsonb,
              ${new Date(api.now.value.getTime() - 1000)})`;
    let scans = 0;
    const handlers: Record<string, JobHandler> = {
      scan_process: () => {
        scans += 1;
        return Promise.resolve();
      },
    };
    // Seven minutes in: 15 - 7 = 8 minutes of wall time are left and a scan's worst case is 7, so
    // the old arithmetic claimed it and the trailing steps started at (or past) the wall.
    await runJobs(deps, handlers, 25, new Date(api.now.value.getTime() - 7 * 60_000));
    expect(scans).toBe(0);
    const [scanJob] = await api.db.sql<{ status: string; attempts: number }[]>`
      select status, attempts from public.jobs where idempotency_key = ${'scan:' + a!.id + ':v1'}`;
    expect(scanJob).toMatchObject({ status: 'queued', attempts: 0 });

    // Early in the invocation the scan still runs: the reserve costs the ledger the last minutes
    // only, not the work itself.
    await runJobs(deps, handlers, 25, api.now.value);
    expect(scans).toBe(1);
  });

  /**
   * HUNT5-C-5: the reserve bounds the LEDGER only. The twelve steps that run before it in
   * runScheduledTick have no wall-clock budget at all — the same file says so in
   * TICK_WALL_LIMIT_MS's docstring — so a long inactivity sweep can still leave the trailing
   * entitlement step nothing. There is no run-time assertion for a promise made in a comment: the
   * claim is the defect, so the source is what this checks. It failed on "so this step always gets a
   * slice (R4-JOBS-4)", which a reader would have trusted while looking for the wrong bug the next
   * time `entitlementsReconciled` was 0.
   */
  it('does not promise the trailing entitlement step a slice the tick cannot give it', () => {
    const source = readFileSync(new URL('../src/jobs/dispatcher.ts', import.meta.url), 'utf8');
    const ledger = source.indexOf("const jobs = await step('jobs'");
    const sweep = source.indexOf('const entitlementsReconciled = await step(');
    expect(ledger).toBeGreaterThan(-1);
    expect(sweep).toBeGreaterThan(ledger);
    const note = source.slice(ledger, sweep);
    expect(note).toMatch(/R4-JOBS-4/);
    expect(note).not.toMatch(/always gets a slice/);
    // It must point at what really bounds the step: the steps in front of it are unbounded.
    expect(note).toMatch(/unbounded/);
  });
});

// ---------------------------------------------------------------------------------------------
// R4-JOBS-1: the one raised retry after a truncated answer must be reachable
// ---------------------------------------------------------------------------------------------

/**
 * A stage whose answer the provider cuts off at `max_output_tokens` raises the output budget once
 * and tries again, while the stage's cost cap admits it (JOBS-R2-02). The estimate the cap is
 * measured against uses `inputTokenUpperBound` of the request the scan really sends, so the retry
 * has to be admissible at THAT bound — for EXTRACTION at every page count the product accepts, not
 * only at the smallest one.
 *
 * N2-GRADING-ENVELOPE: the two stages do not send the same shape and are no longer parameterised as
 * if they did. Extraction sends the envelope PLUS one image part per page, so its bound is set by the
 * page count (1,516 tokens a page) and the cases below cover 1..maxPages. Grading sends ONE data
 * envelope of question prompts and answers and NO image at all, so its bound is set by the extracted
 * questions' bytes; driving it with image parts proved a shape grading never sends. On grading's real
 * envelope the full 2x raise is admitted up to GRADING_FULL_RAISE_MAX_QUESTIONS questions of the size
 * fixed below and no further — short of the ~100 questions a ten-page worksheet hands it — so the
 * cases state that bound instead of implying coverage to ten pages. The ceiling is NOT raised here:
 * the last case records where the raise starts shrinking and where it stops altogether, for the lead.
 */
describe('the one raised retry after a truncated answer (R4-JOBS-1)', () => {
  const gate = {
    containsChildPersonalData: true,
    ageBand: '8-10' as const,
    zdrEvidence: null,
    environment: 'test' as const,
    now: new Date('2026-09-24T12:00:00Z'),
  };

  const PAGE_COUNTS = Array.from(
    { length: DEFAULT_HOMEWORK_UPLOAD_LIMITS.maxPages },
    (_, i) => i + 1,
  );

  /**
   * EXTRACTION's real input for a scan of `pages` pages: the data envelope plus one `input_image`
   * part per page (apps/api/src/jobs/scan-process.ts's extract() always sends both, and refuses a
   * scan of zero pages with NO_PAGES). inputTokenUpperBound charges IMAGE_INPUT_TOKEN_BOUND + the
   * part overhead for each image, so this is the bound the stage's cost cap is really measured
   * against — the image-free floor no caller can send is 1,500 tokens per page smaller.
   */
  function extractionInput(pages: number): InputPart[] {
    return [
      dataEnvelope({
        pageNumbers: Array.from({ length: pages }, (_, i) => i + 1),
        gradeLevel: 4,
      }),
      ...Array.from({ length: pages }, () => imagePart('image/jpeg', 'AAAA')),
    ];
  }

  /**
   * One extracted question as GRADING's envelope carries it: a short grade-4 answer, 185 bytes of
   * JSON with its `q<n>` ref. Grading's bound grows with these BYTES, so the size is stated here and
   * pinned below — the question count the cap admits is only meaningful next to it.
   */
  const GRADING_QUESTION = {
    prompt: 'Write 3/4 as a decimal and explain how you know.',
    studentAnswer: '0.75 because 3 divided by 4 is 0.75.',
    answerKind: 'open_response',
    subject: 'math',
  } as const;

  /**
   * GRADING's real input: ONE data envelope of the grade level, the pages whose source passage was
   * missing and every extracted question's prompt and answer — and NO image part. Grading never sends
   * a page image; only extraction does (apps/api/src/jobs/scan-process.ts's grade()). So grading's
   * input bound is set by the number and size of the extracted questions, and the page count reaches
   * it only through how many questions those pages carried.
   */
  function gradingInput(questions: number): InputPart[] {
    return [
      dataEnvelope({
        gradeLevel: 4,
        pagesMissingSourcePassage: [],
        questions: Array.from({ length: questions }, (_, i) => ({
          questionNumber: `q${i + 1}`,
          ...GRADING_QUESTION,
        })),
      }),
    ];
  }

  async function raisedRetry<S extends z.ZodType>(
    prompt: PromptDefinition<S>,
    input: readonly InputPart[],
  ) {
    const limits = PROPOSED_STAGE_LIMITS[prompt.stage];
    const estimatedInputTokens = inputTokenUpperBound(prompt, input);
    const client = createMockResponsesClient((request) => ({
      kind: 'incomplete' as const,
      usage: {
        inputTokens: estimatedInputTokens,
        cachedInputTokens: 0,
        outputTokens: request.maxOutputTokens,
      },
      modelId: 'gpt-5.6-terra',
      latencyMs: 10,
      reason: 'max_output_tokens' as const,
    }));
    const out = await runStage({
      prompt,
      input,
      client,
      limits,
      rates: DEFAULT_RATE_TABLE_2026_09_18,
      gate,
      metadata: { stage: prompt.stage },
      estimatedInputTokens,
      sleep: () => Promise.resolve(),
    });
    return {
      limits,
      out,
      estimatedInputTokens,
      budgets: client.requests.map((r) => r.maxOutputTokens),
    };
  }

  /** What the one raised retry must look like, whichever stage was cut off at whatever size. */
  function expectRaisedRetry({
    limits,
    out,
    estimatedInputTokens,
    budgets,
  }: Awaited<ReturnType<typeof raisedRetry>>): void {
    // Before: extraction's raise to 2 x 4,000 output tokens was estimated at 101,956 micros on top
    // of the ~53,000 micros the first cut-off answer had already cost — past the 150,000 stage cap —
    // so canAttempt refused it at every real input size. One call, then SCAN_TOO_MANY_QUESTIONS,
    // although the comments promised a raised attempt had happened. R4-JOBS-1 sized the raise to the
    // headroom that exists, which leaves the retry unreachable from 7 pages (extraction) up unless the
    // stage's cost cap has room for it.
    expect(budgets, `input bound ${estimatedInputTokens} tokens`).toHaveLength(2);
    // HUNT5-C-1: the retry gets the FULL multiple, not a token more than the configured budget. A
    // retry that may add one token cannot fit an answer that overran by a paragraph, so the cheapest
    // ceiling that merely makes `raisedOutputBudget` non-null is not the fix — the lead refused it.
    // This is what makes 216,816 micros the smallest ceiling that passes: at 214,108 the ten-page
    // extraction case goes red, and at the old 150,000 the 7-10 page extraction cases all do. The
    // same 18,204-token bound is what limits grading, whose input carries questions instead of pages
    // (N2-GRADING-ENVELOPE, and the last case in this describe).
    expect(budgets[1]!, `input bound ${estimatedInputTokens} tokens`).toBe(
      limits.maxOutputTokens * OUTPUT_TRUNCATED_BUDGET_MULTIPLE,
    );
    // The raise never spends more than the stage cap allows.
    expect(out.attempts.reduce((n, at) => n + at.costMicros, 0)).toBeLessThanOrEqual(
      limits.maxCostMicros,
    );
    // Two cut-off answers end the stage with its own code; the caller turns that into a
    // parent-facing outcome.
    expect(out.result.ok).toBe(false);
    if (!out.result.ok) expect(out.result.error.code).toBe('OUTPUT_TRUNCATED');
  }

  it.each(PAGE_COUNTS)(
    'is admitted for extraction at the input bound a %i-page scan really sends',
    async (pages) => {
      expectRaisedRetry(await raisedRetry(PROMPTS.extraction, extractionInput(pages)));
    },
  );

  /** A worksheet page of a K-8 assignment carries about ten numbered questions. */
  const QUESTIONS_PER_PAGE = 10;

  /**
   * MEASURED, not assumed: the most extracted questions of GRADING_QUESTION's size (185 bytes of
   * envelope JSON each) at which grading's cost cap still admits the FULL 2x raise. At 85 the input
   * bound is 18,176 tokens and the two attempts cost 216,704 of the 216,816-micro cap; one question
   * more takes the bound past the 18,204 the cap allows ((216,816 − 12 x 4,000 − 12 x 8,000) / 4) and
   * the raise starts shrinking. Change GRADING_QUESTION and this number moves with it.
   */
  const GRADING_FULL_RAISE_MAX_QUESTIONS = 85;

  /** The last count at which ANY raise is still admitted; past it a cut-off answer gets one attempt. */
  const GRADING_ANY_RAISE_MAX_QUESTIONS = 149;

  const GRADING_QUESTION_COUNTS = [
    1,
    QUESTIONS_PER_PAGE,
    2 * QUESTIONS_PER_PAGE,
    4 * QUESTIONS_PER_PAGE,
    6 * QUESTIONS_PER_PAGE,
    8 * QUESTIONS_PER_PAGE,
    GRADING_FULL_RAISE_MAX_QUESTIONS,
  ];

  it.each(GRADING_QUESTION_COUNTS)(
    'is admitted for grading at the input bound %i extracted questions really send (one envelope, no image)',
    async (questions) => {
      const input = gradingInput(questions);
      // The shape itself, so the image-part stand-in cannot come back: grade() sends one text part.
      expect(input).toHaveLength(1);
      expect(input[0]!.type).toBe('input_text');
      expectRaisedRetry(await raisedRetry(PROMPTS.grading, input));
    },
  );

  it(`grading's full raise stops above ${GRADING_FULL_RAISE_MAX_QUESTIONS} extracted questions and any raise above ${GRADING_ANY_RAISE_MAX_QUESTIONS}, so a ten-page worksheet is NOT covered (lead decision, no ceiling raised here)`, async () => {
    const limits = PROPOSED_STAGE_LIMITS.grading;
    const full = limits.maxOutputTokens * OUTPUT_TRUNCATED_BUDGET_MULTIPLE;
    // The bound is bytes, so the size the counts above are stated for is pinned here.
    const oneQuestion = { questionNumber: 'q10', ...GRADING_QUESTION };
    expect(new TextEncoder().encode(JSON.stringify(oneQuestion)).length).toBe(185);

    // One question past the sweep: the retry still happens, but NOT at the full multiple. The stage
    // keeps its promise (a raised attempt is made) and loses part of the raise, which is why this is
    // the lead's call and not a ceiling to bump here.
    const over = await raisedRetry(
      PROMPTS.grading,
      gradingInput(GRADING_FULL_RAISE_MAX_QUESTIONS + 1),
    );
    expect(over.budgets).toHaveLength(2);
    expect(over.budgets[1]!).toBeGreaterThan(limits.maxOutputTokens);
    expect(over.budgets[1]!).toBeLessThan(full);
    expect(over.out.attempts.reduce((n, at) => n + at.costMicros, 0)).toBeLessThanOrEqual(
      limits.maxCostMicros,
    );

    // A ten-page worksheet of ten questions a page is inside the product's own page limit
    // (DEFAULT_HOMEWORK_UPLOAD_LIMITS.maxPages, and the extraction cases above admit it): grading
    // gives it a raise, but a shrunken one.
    const tenPages = await raisedRetry(
      PROMPTS.grading,
      gradingInput(DEFAULT_HOMEWORK_UPLOAD_LIMITS.maxPages * QUESTIONS_PER_PAGE),
    );
    expect(tenPages.budgets).toHaveLength(2);
    expect(tenPages.budgets[1]!).toBeLessThan(full);

    // And where the raise runs out altogether: at the last count it is still made, one more and the
    // cut-off answer gets a single attempt and OUTPUT_TRUNCATED at once (SCAN_TOO_MANY_QUESTIONS to
    // the parent). Fifteen pages of ten questions would be needed to reach that; the page limit is 10.
    const last = await raisedRetry(PROMPTS.grading, gradingInput(GRADING_ANY_RAISE_MAX_QUESTIONS));
    expect(last.budgets).toHaveLength(2);
    expect(last.budgets[1]!).toBeGreaterThan(limits.maxOutputTokens);
    const none = await raisedRetry(
      PROMPTS.grading,
      gradingInput(GRADING_ANY_RAISE_MAX_QUESTIONS + 1),
    );
    expect(none.budgets).toHaveLength(1);
    expect(none.out.result.ok).toBe(false);
    if (!none.out.result.ok) expect(none.out.result.error.code).toBe('OUTPUT_TRUNCATED');
  });
});

// ---------------------------------------------------------------------------------------------
// JOBS-R2-08: the EXIF orientation survives metadata stripping
// ---------------------------------------------------------------------------------------------

const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));
const u16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

/**
 * A real big-endian Exif APP1 payload: IFD0 with Orientation and a GPS IFD pointer, and a GPS IFD
 * whose value carries a marker so the test can see that the location data is gone.
 */
function exifPayload(orientation: number): number[] {
  const gpsIfdOffset = 38;
  const gpsValueOffset = 56;
  return [
    ...ascii('Exif\0\0'),
    ...ascii('MM'),
    ...u16(42),
    ...u32(8),
    ...u16(2), // IFD0: two entries
    ...u16(0x0112),
    ...u16(3),
    ...u32(1),
    ...u16(orientation),
    ...u16(0), // Orientation (SHORT)
    ...u16(0x8825),
    ...u16(4),
    ...u32(1),
    ...u32(gpsIfdOffset), // GPSInfo pointer (LONG)
    ...u32(0), // no IFD1
    ...u16(1), // GPS IFD: one entry
    ...u16(0x0001),
    ...u16(2),
    ...u32(10),
    ...u32(gpsValueOffset), // GPSLatitudeRef (ASCII)
    ...u32(0),
    ...ascii('GPSSECRET\0'),
  ];
}

function jpegWithApp1(app1Payload: number[]): Uint8Array {
  const seg = (marker: number, payload: number[]) => [
    0xff,
    marker,
    ...u16(payload.length + 2),
    ...payload,
  ];
  return new Uint8Array([
    0xff,
    0xd8,
    ...seg(0xe0, ascii('JFIF\0')),
    ...seg(0xe1, app1Payload),
    ...seg(0xdb, [0, ...new Array<number>(64).fill(1)]),
    ...seg(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
    ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
    0x12,
    0x34,
    0xff,
    0xd9,
  ]);
}

/** The APP1 segments of a JPEG, as payload byte arrays. */
function app1Segments(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1]!;
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (marker === 0xe1) out.push(bytes.subarray(i + 4, i + 2 + length));
    if (marker === 0xda) break; // scan data: no more headers
    i = i + 2 + length;
  }
  return out;
}

describe('the JPEG EXIF orientation (JOBS-R2-08)', () => {
  it('is kept as a minimal APP1 while every other Exif field, including GPS, is dropped', () => {
    const original = jpegWithApp1(exifPayload(6));
    expect(new TextDecoder('latin1').decode(original)).toContain('GPSSECRET');
    const clean = stripImageMetadata(original, 'image/jpeg');
    const text = new TextDecoder('latin1').decode(clean);
    // Before: every APP1 was dropped, including Orientation, and nothing rotated the pixels or told
    // the model, so a photo that relied on it reached extraction sideways and came back as
    // "rotated" — a retake on the same device failed the same way.
    const app1 = app1Segments(clean);
    expect(app1).toHaveLength(1);
    const payload = app1[0]!;
    // Exif header, big-endian TIFF, exactly one IFD0 entry: Orientation = 6.
    expect(new TextDecoder('latin1').decode(payload.subarray(0, 6))).toBe('Exif\0\0');
    expect((payload[14]! << 8) | payload[15]!).toBe(1); // one entry
    expect((payload[16]! << 8) | payload[17]!).toBe(0x0112);
    expect((payload[24]! << 8) | payload[25]!).toBe(6);
    expect(text).not.toContain('GPSSECRET');
    expect(clean.length).toBeLessThan(original.length);
    // Stripping the cleaned image again changes nothing.
    expect([...stripImageMetadata(clean, 'image/jpeg')]).toEqual([...clean]);
  });

  it('writes no APP1 for the default orientation or for an APP1 that is not valid Exif', () => {
    expect(app1Segments(stripImageMetadata(jpegWithApp1(exifPayload(1)), 'image/jpeg'))).toEqual(
      [],
    );
    const notExif = jpegWithApp1(ascii('Exif\0\0GPSLatitude=51.5'));
    const clean = stripImageMetadata(notExif, 'image/jpeg');
    expect(app1Segments(clean)).toEqual([]);
    expect(new TextDecoder('latin1').decode(clean)).not.toContain('Exif');
  });
});

// ---------------------------------------------------------------------------------------------
// CS-R2-06: the flag's email line says what actually happened
// ---------------------------------------------------------------------------------------------

describe('the parent-facing flag email copy (CS-R2-06)', () => {
  it('does not claim every guardian was emailed, nor that it happened when the flag was filed', () => {
    const copy = PARENT_SAFETY_FLAG_COPY.emailSent;
    // Before: "PencilLift emailed the guardians on this account about this flag when it was filed",
    // although 'sent' is recorded once ONE verified address accepted it — an owner whose address
    // bounced, and an unverified co-guardian, were both told they had been emailed.
    expect(copy).not.toMatch(/emailed the guardians/);
    expect(copy).not.toContain('when it was filed');
    expect(copy).toMatch(/at least one/i);
    // It still promises nothing about the content of the email.
    expect(copy).toContain('no kind of concern');
  });
});
