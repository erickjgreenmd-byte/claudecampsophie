import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildRequestBody,
  createMockModerationClient,
  createMockResponsesClient,
  encodeRequestBody,
  type ResponsesClient,
  type ResponsesRequest,
  type ResponsesResult,
} from '@pencillift/ai';
import { HOMEWORK_SCAN_MAX_TOTAL_BYTES } from '@pencillift/contracts';
import { cryptoRandom } from '@pencillift/domain';
import {
  grantAdultUnlock,
  seedFamily,
  seedOwnerAdmin,
  type SeededFamily,
} from '@pencillift/db/testing/fixtures';
import {
  accountCloseHandler,
  DEAD_LETTER_SUCCESSOR_DELAY_MS,
  deletionPurgeHandler,
  runJobs,
  type JobDeps,
  type JobHandler,
} from '../src/jobs/dispatcher.ts';
import { createScanProcessHandler } from '../src/jobs/scan-process.ts';
import { createRefusingAuthAdmin } from '../src/providers/auth-admin.ts';
import { createTestApi, type TestApi } from './helpers.ts';

/**
 * Hardening round 2b, durable jobs and the AI pipeline (JOBS-R1-01..04), against real local
 * Postgres. Providers are the LABELED mocks and doubles of createTestApi (memory storage, local auth
 * admin double, mock Responses and moderation clients). Synthetic families and pages only.
 */

let api: TestApi;
let deps: JobDeps;
const START = new Date('2026-09-24T15:00:00Z');

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

beforeEach(() => {
  api.logs.length = 0;
});

afterEach(() => {
  api.now.value = START;
});

afterAll(async () => {
  await api?.close();
});

function advance(ms: number): void {
  api.now.value = new Date(api.now.value.getTime() + ms);
}

/** Storage whose removals fail (an outage of the storage API); reads and the rest stay healthy. */
function storageDown(): JobDeps {
  const storage = {
    ...api.providers.storage,
    remove: () => Promise.reject(new Error('storage down')),
  };
  return { ...deps, providers: { ...api.providers, storage } };
}

/** One assignment with one stored page for the family's first child. */
async function storedPage(fam: SeededFamily): Promise<string> {
  const childId = fam.children[0]!.id;
  const [a] = await api.db.sql<{ id: string }[]>`
    insert into public.assignments (family_id, child_id, idempotency_key, created_by_kind)
    values (${fam.familyId}, ${childId}, ${'k-' + randomUUID()}, 'child') returning id`;
  const pageId = randomUUID();
  const path = `${fam.familyId}/${childId}/${a!.id}/${pageId}.jpg`;
  await api.db.sql`
    insert into public.source_pages (id, assignment_id, family_id, child_id, page_number, storage_path, mime_type, byte_size, sha256, created_at)
    values (${pageId}, ${a!.id}, ${fam.familyId}, ${childId}, 1, ${path}, 'image/jpeg', 10, ${'d'.repeat(64)}, ${api.now.value})`;
  api.providers.storage.objects.add(path);
  return path;
}

interface LedgerRow {
  id: string;
  kind: string;
  idempotency_key: string;
  status: string;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  last_error_code: string | null;
  payload: Record<string, unknown>;
  family_id: string | null;
  child_id: string | null;
}

async function ledger(where: { family?: string; user?: string }): Promise<LedgerRow[]> {
  return api.db.sql<LedgerRow[]>`
    select id, kind, idempotency_key, status, attempts, max_attempts, run_after, last_error_code,
           payload, family_id, child_id
      from public.jobs
     where (${where.family ?? null}::uuid is not null and family_id = ${where.family ?? null}::uuid)
        or (${where.user ?? null}::text is not null and payload->>'userId' = ${where.user ?? null}::text)
     order by created_at, idempotency_key`;
}

async function isClosed(userId: string): Promise<boolean> {
  const [row] = await api.db.sql<{ closed: boolean }[]>`
    select app.auth_user_closed(${userId}::uuid) as closed`;
  return row!.closed;
}

const PURGE_AND_CLOSE: Record<string, JobHandler> = {
  deletion_purge: deletionPurgeHandler,
  account_close: accountCloseHandler,
};

// ---------------------------------------------------------------------------------------------
// JOBS-R1-01: a deletion purge and the owner's closure behind it never stop for good
// ---------------------------------------------------------------------------------------------

describe('JOBS-R1-01: a dead-lettered deletion purge is followed by a successor', () => {
  it('five storage failures dead-letter the first purge; a later healthy tick completes the purge, the request and the closure', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    const path = await storedPage(fam);
    await grantAdultUnlock(api.db, fam.ownerId);
    const [req] = await api.db.asParent(
      fam.ownerId,
      (tx) => tx<{ id: string }[]>`select (public.request_deletion(${fam.familyId}, null)).id`,
    );
    // The owner's closure, queued as POST /v1/account/close does it (no family on the job).
    await api.db.sql`
      insert into public.jobs (kind, idempotency_key, payload, run_after)
      values ('account_close', ${'account_close:' + fam.ownerId},
              ${JSON.stringify({ userId: fam.ownerId })}::text::jsonb, ${api.now.value})`;

    const down = storageDown();
    const reports = [];
    for (let i = 0; i < 5; i += 1) {
      reports.push(await runJobs(down, PURGE_AND_CLOSE));
      advance(10 * 60_000);
    }
    // Four retries, then the dead letter; the closure defers every tick (never spends an attempt).
    expect(reports.map((r) => r.deadLettered)).toEqual([0, 0, 0, 0, 1]);

    const purges = (await ledger({ family: fam.familyId })).filter(
      (j) => j.kind === 'deletion_purge',
    );
    expect(purges).toHaveLength(2);
    const [first, successor] = purges;
    expect(first).toMatchObject({
      idempotency_key: `deletion:${req!.id}`,
      status: 'dead_letter',
      attempts: 5,
      // JOBS-R1-04: the pipeline code, not the exception class.
      last_error_code: 'STORAGE_REMOVE_FAILED',
    });
    expect(successor).toMatchObject({
      idempotency_key: `deletion:${req!.id}:retry1`,
      status: 'queued',
      attempts: 0,
      max_attempts: first!.max_attempts,
      family_id: fam.familyId,
      child_id: null,
      payload: first!.payload,
    });
    // Due a long while later (a storage incident usually needs more than minutes).
    const deadAt = api.now.value.getTime() - 10 * 60_000;
    expect(successor!.run_after.getTime()).toBe(deadAt + DEAD_LETTER_SUCCESSOR_DELAY_MS);
    expect(DEAD_LETTER_SUCCESSOR_DELAY_MS).toBe(6 * 3600_000);

    // An ops signal with a code, and an audit row with no personal data.
    expect(
      api.logs.some(
        (l) =>
          l.level === 'error' &&
          l.event === 'job_dead_letter_requeued' &&
          l.code === 'DELETION_PURGE_DEAD_LETTER',
      ),
    ).toBe(true);
    const audits = await api.db.sql<
      { family_id: string | null; target_type: string; target_id: string; metadata: unknown }[]
    >`
      select family_id, target_type, target_id, metadata from public.audit_events
       where action = 'job.dead_letter_requeued' and target_id = ${first!.id}`;
    expect(audits).toEqual([
      {
        family_id: fam.familyId,
        target_type: 'job',
        target_id: first!.id,
        metadata: {
          kind: 'deletion_purge',
          code: 'DELETION_PURGE_DEAD_LETTER',
          reason: 'ATTEMPTS_EXHAUSTED',
          attempts: 5,
          lastErrorCode: 'STORAGE_REMOVE_FAILED',
          successorJobId: successor!.id,
          retry: 1,
        },
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain(fam.ownerId);

    // Meanwhile nothing was purged, the request stays open and the owner's sign-in is not closed.
    const state = async () => {
      const [row] = await api.db.sql<{ children: number; pages: number; req: string }[]>`
        select (select count(*)::int from public.child_profiles where family_id = ${fam.familyId}) as children,
               (select count(*)::int from public.source_pages where family_id = ${fam.familyId}) as pages,
               (select status from public.deletion_requests where id = ${req!.id}) as req`;
      return row!;
    };
    expect(await state()).toEqual({ children: 1, pages: 1, req: 'requested' });
    expect(api.providers.storage.objects.has(path)).toBe(true);

    // Healthy ticks before the successor is due change nothing; the closure keeps deferring.
    expect(await runJobs(deps, PURGE_AND_CLOSE)).toMatchObject({ succeeded: 0, deadLettered: 0 });
    expect(await isClosed(fam.ownerId)).toBe(false);

    advance(DEAD_LETTER_SUCCESSOR_DELAY_MS);
    await runJobs(deps, PURGE_AND_CLOSE);
    expect(await state()).toEqual({ children: 0, pages: 0, req: 'completed' });
    expect(api.providers.storage.objects.has(path)).toBe(false);
    const after = (await ledger({ family: fam.familyId })).find(
      (j) => j.idempotency_key === `deletion:${req!.id}:retry1`,
    );
    expect(after?.status).toBe('succeeded');

    // The closure runs once the purge completed (its deferral is due within the recheck window).
    advance(10 * 60_000);
    await runJobs(deps, PURGE_AND_CLOSE);
    expect(await isClosed(fam.ownerId)).toBe(true);
  });

  it('a dead successor queues the next version (retry2), never a key of keys', async () => {
    const fam = await seedFamily(api.db, { childCount: 2 });
    await storedPage(fam);
    await grantAdultUnlock(api.db, fam.ownerId);
    const childId = fam.children[0]!.id;
    const [req] = await api.db.asParent(
      fam.ownerId,
      (tx) =>
        tx<{ id: string }[]>`select (public.request_deletion(${fam.familyId}, ${childId})).id`,
    );
    // Stand-in for a first successor that is about to fail its last attempt.
    await api.db.sql`
      update public.jobs set idempotency_key = ${`deletion:${req!.id}:retry1`}, max_attempts = 1
       where idempotency_key = ${`deletion:${req!.id}`}`;
    expect((await runJobs(storageDown(), PURGE_AND_CLOSE)).deadLettered).toBe(1);
    const keys = (await ledger({ family: fam.familyId }))
      .filter((j) => j.kind === 'deletion_purge')
      .map((j) => [j.idempotency_key, j.status, j.child_id]);
    expect(keys).toEqual([
      [`deletion:${req!.id}:retry1`, 'dead_letter', childId],
      [`deletion:${req!.id}:retry2`, 'queued', childId],
    ]);

    // A worker that died on the final attempt (lease expired) is compensated the same way, once.
    advance(DEAD_LETTER_SUCCESSOR_DELAY_MS);
    const [claimed] = await api.db.sql<{ id: string }[]>`
      update public.jobs set status = 'running', attempts = max_attempts,
             locked_until = ${new Date(api.now.value.getTime() - 1000)}
       where idempotency_key = ${`deletion:${req!.id}:retry2`} returning id`;
    expect(claimed).toBeDefined();
    const report = await runJobs(deps, PURGE_AND_CLOSE);
    expect(report.deadLettered).toBe(1);
    const again = (await ledger({ family: fam.familyId })).filter(
      (j) => j.kind === 'deletion_purge',
    );
    expect(again.map((j) => [j.idempotency_key, j.status])).toEqual([
      [`deletion:${req!.id}:retry1`, 'dead_letter'],
      [`deletion:${req!.id}:retry2`, 'dead_letter'],
      [`deletion:${req!.id}:retry3`, 'queued'],
    ]);
  });

  it('no successor once the deletion request is no longer open (nothing left to purge)', async () => {
    const fam = await seedFamily(api.db, { childCount: 1 });
    await storedPage(fam);
    await grantAdultUnlock(api.db, fam.ownerId);
    const [req] = await api.db.asParent(
      fam.ownerId,
      (tx) => tx<{ id: string }[]>`select (public.request_deletion(${fam.familyId}, null)).id`,
    );
    const [job] = await api.db.sql<{ id: string }[]>`
      update public.jobs set max_attempts = 1 where idempotency_key = ${`deletion:${req!.id}`}
      returning id`;
    // The request was completed some other way (e.g. by an operator) while this job was failing.
    await api.db.sql`
      update public.deletion_requests set status = 'completed', completed_at = now() where id = ${req!.id}`;
    expect((await runJobs(storageDown(), PURGE_AND_CLOSE)).deadLettered).toBe(1);
    const purges = (await ledger({ family: fam.familyId })).filter(
      (j) => j.kind === 'deletion_purge',
    );
    expect(purges.map((j) => [j.id, j.status])).toEqual([[job!.id, 'dead_letter']]);
  });
});

describe('JOBS-R1-01: a dead-lettered account closure is followed by a successor', () => {
  it('an auth-service outage dead-letters the closure; its successor closes the sign-in later', async () => {
    const userId = await api.db.createUser();
    await api.db.sql`
      insert into public.jobs (kind, idempotency_key, payload, max_attempts, run_after)
      values ('account_close', ${'account_close:' + userId}, ${JSON.stringify({ userId })}::text::jsonb,
              2, ${api.now.value})`;
    const refusing: JobDeps = {
      ...deps,
      providers: { ...api.providers, authAdmin: createRefusingAuthAdmin() },
    };
    expect((await runJobs(refusing, PURGE_AND_CLOSE)).retried).toBe(1);
    advance(5 * 60_000);
    expect((await runJobs(refusing, PURGE_AND_CLOSE)).deadLettered).toBe(1);
    const jobs = await ledger({ user: userId });
    expect(jobs.map((j) => [j.idempotency_key, j.status, j.max_attempts])).toEqual([
      [`account_close:${userId}`, 'dead_letter', 2],
      [`account_close:${userId}:retry1`, 'queued', 2],
    ]);
    expect(jobs[1]!.payload).toEqual({ userId });
    expect(
      api.logs.some(
        (l) => l.event === 'job_dead_letter_requeued' && l.code === 'ACCOUNT_CLOSE_DEAD_LETTER',
      ),
    ).toBe(true);
    const [audit] = await api.db.sql<{ family_id: string | null; metadata: unknown }[]>`
      select family_id, metadata from public.audit_events
       where action = 'job.dead_letter_requeued' and target_id = ${jobs[0]!.id}`;
    expect(audit).toMatchObject({ family_id: null, metadata: { kind: 'account_close' } });
    expect(JSON.stringify(audit)).not.toContain(userId);

    advance(DEAD_LETTER_SUCCESSOR_DELAY_MS);
    await runJobs(deps, PURGE_AND_CLOSE);
    expect(await isClosed(userId)).toBe(true);
  });

  it('a closure refused because the user holds a live family again is not re-queued', async () => {
    const fam = await seedFamily(api.db);
    await api.db.sql`
      insert into public.jobs (kind, idempotency_key, payload, max_attempts, run_after)
      values ('account_close', ${'account_close:' + fam.ownerId}, ${JSON.stringify({ userId: fam.ownerId })}::text::jsonb,
              1, ${api.now.value})`;
    expect((await runJobs(deps, PURGE_AND_CLOSE)).deadLettered).toBe(1);
    const jobs = await ledger({ user: fam.ownerId });
    expect(jobs.map((j) => [j.status, j.last_error_code])).toEqual([
      ['dead_letter', 'FAMILY_ACTIVE'],
    ]);
    expect(await isClosed(fam.ownerId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// JOBS-R1-04: the ledger records the pipeline code
// ---------------------------------------------------------------------------------------------

describe('JOBS-R1-04: last_error_code holds the pipeline code', () => {
  async function queueExport(): Promise<string> {
    const [row] = await api.db.sql<{ id: string }[]>`
      insert into public.jobs (kind, idempotency_key, payload, max_attempts, run_after)
      values ('export_build', ${'r1-04-' + randomUUID()}, '{}'::jsonb, 5, ${api.now.value})
      returning id`;
    return row!.id;
  }
  async function code(id: string): Promise<string | null> {
    const [row] = await api.db.sql<{ c: string | null }[]>`
      select last_error_code as c from public.jobs where id = ${id}`;
    return row!.c;
  }
  const failWith = (error: unknown): Record<string, JobHandler> => ({
    // Deliberately any thrown value, including a non-Error (the ledger must still record a code).
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    export_build: () => Promise.reject(error),
  });

  it('a coded failure stores its code; anything else stores the class name, never a message', async () => {
    const coded = await queueExport();
    await runJobs(deps, failWith(Object.assign(new Error('x'), { code: 'EMAIL_SEND_FAILED' })));
    expect(await code(coded)).toBe('EMAIL_SEND_FAILED');

    // Not a pipeline code (lower case, free text, a number): the class name.
    for (const bad of ['storage down for family 123', 'lower_case', 42, '']) {
      const id = await queueExport();
      await runJobs(deps, failWith(Object.assign(new RangeError('boom'), { code: bad })));
      expect(await code(id)).toBe('RangeError');
    }
    const plain = await queueExport();
    await runJobs(deps, failWith(new TypeError('boom')));
    expect(await code(plain)).toBe('TypeError');
    const thrownString = await queueExport();
    await runJobs(deps, failWith('not an error'));
    expect(await code(thrownString)).toBe('Error');
  });
});

// ---------------------------------------------------------------------------------------------
// Scan helpers (JOBS-R1-02, -03)
// ---------------------------------------------------------------------------------------------

/** Structurally valid synthetic JPEG whose entropy-coded scan is `scanBytes` long. */
function syntheticJpeg(scanBytes = 2): Uint8Array {
  const seg = (marker: number, payload: number[]) => [
    0xff,
    marker,
    (payload.length + 2) >> 8,
    (payload.length + 2) & 0xff,
    ...payload,
  ];
  const text = (t: string) => Array.from(t, (ch) => ch.charCodeAt(0));
  const head = new Uint8Array([
    0xff,
    0xd8,
    ...seg(0xe0, text('JFIF\0')),
    ...seg(0xe1, text('Exif\0\0GPSLatitude')),
    ...seg(0xdb, [0, ...new Array<number>(64).fill(1)]),
    ...seg(0xc0, [8, 0x07, 0xd0, 0x05, 0xdc, 1, 1, 0x11, 0]),
    ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
  ]);
  const out = new Uint8Array(head.length + scanBytes + 2);
  out.set(head, 0);
  // Scan data never contains 0xFF (no stuffing needed): a deterministic byte pattern.
  for (let i = 0; i < scanBytes; i += 1) out[head.length + i] = (i * 131 + 7) % 255;
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9;
  return out;
}

async function consent(fam: SeededFamily): Promise<void> {
  await api.db.sql`
    insert into public.consent_records (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
    values (${fam.familyId}, ${fam.ownerId}, 'mock', 'mock', 'child_learning_data', 'v1', 'verified', true, now())`;
}

interface Scan {
  fam: SeededFamily;
  assignmentId: string;
  reservationId: string;
  jobId: string;
}

async function queuedScan(pageBytes: readonly Uint8Array[], maxAttempts = 5): Promise<Scan> {
  const fam = await seedFamily(api.db, { childCount: 1 });
  await consent(fam);
  const childId = fam.children[0]!.id;
  const [a] = await api.db.sql<{ id: string }[]>`
    insert into public.assignments (family_id, child_id, idempotency_key, created_by_kind, page_count, status)
    values (${fam.familyId}, ${childId}, ${'scan-' + randomUUID()}, 'child', ${pageBytes.length}, 'queued') returning id`;
  for (const [i, bytes] of pageBytes.entries()) {
    const pageId = randomUUID();
    await api.db.sql`
      insert into public.source_pages (id, assignment_id, family_id, child_id, page_number, storage_path, mime_type, byte_size, sha256)
      values (${pageId}, ${a!.id}, ${fam.familyId}, ${childId}, ${i + 1}, ${`${fam.familyId}/${childId}/${a!.id}/${i + 1}.jpg`},
              'image/jpeg', ${bytes.length}, ${createHash('sha256').update(bytes).digest('hex')})`;
  }
  const [r] = await api.db.sql<{ id: string }[]>`
    insert into public.usage_reservations (family_id, child_id, period_key, units, idempotency_key)
    values (${fam.familyId}, ${childId}, '2026-09', ${pageBytes.length}, ${`scan-usage:${a!.id}:v1`}) returning id`;
  const [j] = await api.db.sql<{ id: string }[]>`
    insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, max_attempts, run_after)
    values ('scan_process', ${`scan:${a!.id}:v1`}, ${fam.familyId}, ${childId},
            ${JSON.stringify({ assignmentId: a!.id, mode: 'initial', reservationId: r!.id })}::text::jsonb,
            ${maxAttempts}, ${new Date(api.now.value.getTime() - 1000)})
    returning id`;
  return { fam, assignmentId: a!.id, reservationId: r!.id, jobId: j!.id };
}

function scanHandlers(
  client: ResponsesClient,
  pages: ReadonlyMap<string, Uint8Array>,
): Record<string, JobHandler> {
  return {
    scan_process: createScanProcessHandler({
      ai: client,
      moderation: createMockModerationClient(),
      readObject: (path) => {
        const n = path.slice(path.lastIndexOf('/') + 1, -'.jpg'.length);
        const bytes = pages.get(n);
        return bytes ? Promise.resolve(bytes) : Promise.reject(new Error('missing'));
      },
      sleep: () => Promise.resolve(),
    }),
  };
}

function extractionOk(request: ResponsesRequest): ResponsesResult {
  const part = request.input.find((p) => p.type === 'input_text');
  const data =
    part && part.type === 'input_text'
      ? (JSON.parse(part.text.replace(/^DATA:\n/, '')) as { data: { pageNumbers: number[] } }).data
      : { pageNumbers: [] };
  return {
    kind: 'ok',
    text: JSON.stringify({
      pages: data.pageNumbers.map((n) => ({ pageNumber: n, readable: true, issues: [] })),
      // No questions: the scan goes to a grown-up (NO_QUESTIONS_FOUND) right after extraction.
      questions: [],
    }),
    usage: { inputTokens: 1200, cachedInputTokens: 0, outputTokens: 300 },
    modelId: 'gpt-5.6-terra',
    latencyMs: 25,
  };
}

async function assignment(id: string) {
  const [row] = await api.db.sql<{ status: string; error_code: string | null }[]>`
    select status, error_code from public.assignments where id = ${id}`;
  return row!;
}

async function jobRow(id: string) {
  const [row] = await api.db.sql<
    { status: string; attempts: number; last_error_code: string | null }[]
  >`
    select status, attempts, last_error_code from public.jobs where id = ${id}`;
  return row!;
}

// ---------------------------------------------------------------------------------------------
// JOBS-R1-02: bounded extraction requests; a refused request is not retried five times
// ---------------------------------------------------------------------------------------------

describe('JOBS-R1-02: one scan makes one bounded extraction request', () => {
  it('four realistic pages at the 15 MiB bound: the request body stays under 4/3 of the bound plus the prompt', async () => {
    expect(HOMEWORK_SCAN_MAX_TOTAL_BYTES).toBe(15 * 1024 * 1024);
    const pageBytes = [0, 1, 2, 3].map((i) =>
      syntheticJpeg(HOMEWORK_SCAN_MAX_TOTAL_BYTES / 4 - 200 - i),
    );
    const total = pageBytes.reduce((n, b) => n + b.length, 0);
    expect(total).toBeLessThanOrEqual(HOMEWORK_SCAN_MAX_TOTAL_BYTES);
    const scan = await queuedScan(pageBytes);
    const client = createMockResponsesClient((request) => extractionOk(request));
    const byName = new Map(pageBytes.map((b, i) => [String(i + 1), b]));
    await runJobs(deps, scanHandlers(client, byName));
    expect(await assignment(scan.assignmentId)).toMatchObject({ status: 'needs_parent_review' });
    expect(client.requests).toHaveLength(1);
    const [extraction] = client.requests;
    expect(extraction!.input.filter((p) => p.type === 'input_image')).toHaveLength(4);
    const body = encodeRequestBody(extraction!);
    expect(body.length).toBeLessThanOrEqual(
      Math.ceil((HOMEWORK_SCAN_MAX_TOTAL_BYTES * 4) / 3) + 64 * 1024,
    );
    // The wire bytes are exactly the JSON of the request (nothing lost by the memory-saving path).
    expect(body.length).toBe(
      new TextEncoder().encode(JSON.stringify(buildRequestBody(extraction!))).length,
    );
  });

  it('a scan registered over the bound (before it existed) ends failed_final without reading a page or calling AI', async () => {
    const MiB = 1024 * 1024;
    const small = syntheticJpeg(64);
    const scan = await queuedScan([small, small]);
    // Registered before the bound: the recorded sizes add up to more than one scan can hold.
    await api.db.sql`
      update public.source_pages set byte_size = ${8 * MiB} where assignment_id = ${scan.assignmentId}`;
    let reads = 0;
    const client = createMockResponsesClient((request) => extractionOk(request));
    const handlers = {
      scan_process: createScanProcessHandler({
        ai: client,
        moderation: createMockModerationClient(),
        readObject: () => {
          reads += 1;
          return Promise.resolve(small);
        },
        sleep: () => Promise.resolve(),
      }),
    };
    await runJobs(deps, handlers);
    expect(reads).toBe(0);
    expect(client.requests).toHaveLength(0);
    expect(await assignment(scan.assignmentId)).toEqual({
      status: 'failed_final',
      error_code: 'SCAN_TOO_LARGE',
    });
  });
});

describe('JOBS-R1-02: provider refusals of the request itself are permanent', () => {
  it('a 413 answer ends the scan failed_final after one attempt and releases the allowance', async () => {
    const page = syntheticJpeg(64);
    const scan = await queuedScan([page]);
    const client = createMockResponsesClient(() => ({
      kind: 'error',
      status: 413,
      retryable: false,
      latencyMs: 5,
      timedOut: false,
    }));
    const report = await runJobs(deps, scanHandlers(client, new Map([['1', page]])));
    expect(report).toMatchObject({ retried: 0 });
    expect(client.requests).toHaveLength(1);
    expect(await assignment(scan.assignmentId)).toEqual({
      status: 'failed_final',
      error_code: 'EXTRACTION_REQUEST_REJECTED',
    });
    const [res] = await api.db.sql<{ status: string; release_reason: string | null }[]>`
      select status, release_reason from public.usage_reservations where id = ${scan.reservationId}`;
    expect(res).toEqual({ status: 'released', release_reason: 'failed_final' });
    // A refused request was never run by the model: metered at zero.
    const usage = await api.db.sql<{ status: string; cost_micros: string }[]>`
      select status, cost_micros::text from public.ai_usage_events where family_id = ${scan.fam.familyId}`;
    expect(usage).toEqual([{ status: 'failed', cost_micros: '0' }]);
  });

  it('a 5xx outage still retries (only a refusal of the request itself is permanent)', async () => {
    const page = syntheticJpeg(64);
    const scan = await queuedScan([page], 2);
    const client = createMockResponsesClient(() => ({
      kind: 'error',
      status: 503,
      retryable: true,
      latencyMs: 5,
      timedOut: false,
    }));
    const report = await runJobs(deps, scanHandlers(client, new Map([['1', page]])));
    expect(report.retried).toBe(1);
    expect(await assignment(scan.assignmentId)).toEqual({
      status: 'failed_retryable',
      error_code: 'EXTRACTION_PROVIDER_FAILED',
    });
    // JOBS-R1-04 on the scan path: the ledger names the pipeline code, not RetryableFailure.
    expect(await jobRow(scan.jobId)).toMatchObject({
      status: 'failed_retryable',
      last_error_code: 'EXTRACTION_PROVIDER_FAILED',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// JOBS-R1-03: a timed-out attempt is metered at its upper bound
// ---------------------------------------------------------------------------------------------

describe('JOBS-R1-03: timed-out attempts count against the ceiling', () => {
  it('a scan whose first extraction attempt timed out records that attempt at its upper-bound cost', async () => {
    const page = syntheticJpeg(64);
    const scan = await queuedScan([page]);
    let n = 0;
    const client = createMockResponsesClient((request) => {
      n += 1;
      if (n === 1) {
        return { kind: 'error', status: null, retryable: true, latencyMs: 45_000, timedOut: true };
      }
      return extractionOk(request);
    });
    await runJobs(deps, scanHandlers(client, new Map([['1', page]])));
    expect(await assignment(scan.assignmentId)).toMatchObject({ status: 'needs_parent_review' });
    const rows = await api.db.sql<
      {
        attempt: number;
        status: string;
        cost_micros: string;
        input_tokens: number;
        output_tokens: number;
      }[]
    >`
      select attempt, status, cost_micros::text, input_tokens, output_tokens from public.ai_usage_events
       where family_id = ${scan.fam.familyId} and stage = 'extraction' order by attempt`;
    expect(rows.map((r) => [r.attempt, r.status])).toEqual([
      [1, 'timeout'],
      [2, 'succeeded'],
    ]);
    const [timeout, success] = rows;
    // Billed as if the provider finished the generation: the full output budget of the stage.
    expect(timeout!.output_tokens).toBe(4_000);
    expect(timeout!.input_tokens).toBeGreaterThan(1_500);
    expect(BigInt(timeout!.cost_micros)).toBeGreaterThan(BigInt(success!.cost_micros));
    // No hold is left behind once the stage is settled (the recorded rows count instead).
    const [holds] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from private.ai_spend_holds`;
    expect(holds!.n).toBe(0);
  });
});

describe('JOBS-R1-03: a stage whose timed-out cost cannot be recorded keeps its hold', () => {
  /** `deps` whose service transactions refuse every ai_usage_events insert (a metering fault). */
  function meteringDown(): JobDeps {
    return {
      ...deps,
      db: {
        ...deps.db,
        asService: (fn) =>
          deps.db.asService((tx) =>
            fn(
              new Proxy(tx, {
                apply(target, self, args: unknown[]) {
                  const strings = args[0];
                  if (
                    Array.isArray(strings) &&
                    'raw' in strings &&
                    strings.join(' ').includes('insert into public.ai_usage_events')
                  ) {
                    return Promise.reject(new Error('metering down'));
                  }
                  return Reflect.apply(target, self, args) as unknown;
                },
              }),
            ),
          ),
      },
    };
  }

  it('the hold keeps counting the upper bound of the timed-out attempts until the month ends', async () => {
    const adminId = await seedOwnerAdmin(api.db);
    await api.db.sql`
      insert into public.spend_budgets (scope, period_key, budget_micros, created_by)
      values ('global', '2026-09', 1000000000, ${adminId})`;
    try {
      const page = syntheticJpeg(64);
      const scan = await queuedScan([page]);
      const client = createMockResponsesClient(() => ({
        kind: 'error',
        status: null,
        retryable: true,
        latencyMs: 45_000,
        timedOut: true,
      }));
      await runJobs(meteringDown(), scanHandlers(client, new Map([['1', page]])));
      expect(client.requests.length).toBeGreaterThanOrEqual(1);
      expect(await assignment(scan.assignmentId)).toMatchObject({
        status: 'failed_retryable',
        error_code: 'EXTRACTION_PROVIDER_FAILED',
      });
      const holds = await api.db.sql<{ micros: string; expires_at: Date }[]>`
        select micros::text, expires_at from private.ai_spend_holds`;
      expect(holds).toHaveLength(1);
      // Each timed-out attempt at its upper bound (> 0), kept past the lease until the month ends.
      expect(BigInt(holds[0]!.micros)).toBeGreaterThan(0n);
      expect(holds[0]!.expires_at.getTime()).toBeGreaterThanOrEqual(Date.UTC(2026, 9, 1));
    } finally {
      await api.db.sql`delete from private.ai_spend_holds`;
      await api.db.sql`delete from public.spend_budgets`;
    }
  });
});
