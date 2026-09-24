import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockResponsesClient } from '@pencillift/ai';
import {
  DEFAULT_HOMEWORK_UPLOAD_LIMITS,
  HOMEWORK_BUSINESS_RULES,
  HOMEWORK_IMAGE_LIMITS,
  assignmentStateResponseSchema,
  homeworkImageSizeProblem,
  uploadPagesResponseSchema,
} from '@pencillift/contracts';
import { cryptoRandom } from '@pencillift/domain';
import { seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { runJobs, type JobDeps } from '../src/jobs/dispatcher.ts';
import { createScanProcessHandler } from '../src/jobs/scan-process.ts';
import { createParentVerifier } from '../src/auth/parent.ts';
import { ApiError } from '../src/errors.ts';
import type { AppEnv } from '../src/middleware/context.ts';
import { createDbRateLimiter } from '../src/middleware/rate-limit.ts';
import { homeworkRoutes } from '../src/routes/homework.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * AC_CAPTURE_02 capture limits: "File signature, byte/page limits and image dimensions are
 * validated; malformed PDFs, decompression bombs and unexpected files fail safely."
 * - Registration refuses types the scan job cannot read yet (HEIC, PDF) instead of letting a paid
 *   scan start and fail.
 * - Finalize compares what storage measured with what the device registered (byte size, 15 MB cap).
 * - The scan job refuses an image whose header declares a decompression-bomb size before any AI call.
 * Synthetic families and bytes only; LABELED MOCK storage and AI clients.
 */

let api: TestApi;
let fam: SeededFamily;
let token: string;
let deps: JobDeps;
const SESSION = 'c4c4c4c4-4444-4444-8444-444444444444';

type Row = Record<string, unknown>;
type ErrorBody = { error: { code: string; rule?: string; message: string } };

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const key = () => randomUUID();

function page(pageNumber: number, overrides: Row = {}): Row {
  return {
    pageNumber,
    mimeType: 'image/jpeg',
    byteSize: 250_000,
    sha256: sha(`capture-page-${pageNumber}-${randomUUID()}`),
    ...overrides,
  };
}

async function errorOf(res: Response): Promise<ErrorBody['error']> {
  return (await json<ErrorBody>(res)).error;
}

async function draft(pageCount: number): Promise<string> {
  const res = await api.request('/v1/assignments', {
    method: 'POST',
    token,
    body: { childId: fam.children[0]!.id, pageCount, idempotencyKey: key() },
  });
  expect(res.status).toBe(201);
  return assignmentStateResponseSchema.parse(await json(res)).assignment.id;
}

function upload(id: string, pages: Row[]) {
  return api.request(`/v1/assignments/${id}/uploads`, { method: 'POST', token, body: { pages } });
}

function finalize(id: string) {
  return api.request(`/v1/assignments/${id}/finalize`, {
    method: 'POST',
    token,
    body: { idempotencyKey: key() },
  });
}

/** The homework routes alone, on the same database and storage, with other upload limits. */
function routesWithMaxPageBytes(maxPageBytes: number) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('deps', {
      config: api.config,
      db: api.apiDb,
      clock: () => api.now.value,
      random: cryptoRandom,
      verifyParentToken: createParentVerifier(api.config),
      rateLimiter: createDbRateLimiter(api.apiDb),
      providers: api.providers,
      log: (e) => api.logs.push(e),
    });
    c.set('requestId', 'capture-limits');
    await next();
  });
  app.onError((error, c) =>
    error instanceof ApiError
      ? c.json({ error: { code: error.code, rule: error.rule ?? null } }, error.status as 400)
      : c.json({ error: { code: 'INTERNAL', rule: null } }, 500),
  );
  app.route('/v1', homeworkRoutes({ limits: { ...DEFAULT_HOMEWORK_UPLOAD_LIMITS, maxPageBytes } }));
  return app;
}

async function storedPages(id: string) {
  return api.db.sql<{ storage_path: string; byte_size: number }[]>`
    select storage_path, byte_size from public.source_pages
     where assignment_id = ${id} order by page_number`;
}

async function sideEffects(id: string) {
  const [row] = await api.db.sql<{ status: string; reservations: number; jobs: number }[]>`
    select a.status,
           (select count(*)::int from public.usage_reservations r
             where r.idempotency_key like ${`scan-usage:${id}:%`}) as reservations,
           (select count(*)::int from public.jobs j where j.idempotency_key like ${`scan:${id}:%`}) as jobs
      from public.assignments a where a.id = ${id}`;
  return row;
}

beforeAll(async () => {
  api = await createTestApi();
  fam = await seedFamily(api.db, { childCount: 1 });
  await api.db.sql`
    insert into public.consent_records
      (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
    values (${fam.familyId}, ${fam.ownerId}, 'development_mock', 'development_mock',
            'child_data_processing', 'v1', 'verified', true, now())`;
  await api.db.sql`
    insert into public.family_capacity (family_id, paid_slots, managing_channel)
    values (${fam.familyId}, 1, 'app_store')`;
  await api.db.sql`
    insert into public.child_slot_assignments (family_id, child_id)
    values (${fam.familyId}, ${fam.children[0]!.id})`;
  token = await parentToken(fam.ownerId, { sessionId: SESSION });
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

// ---------------------------------------------------------------------------------------------

describe('shared image dimension limits (contracts)', () => {
  it('names the limits and classifies sizes the same way for API, web and mobile', () => {
    expect(HOMEWORK_IMAGE_LIMITS).toEqual({ maxSidePx: 10_000, maxPixels: 60_000_000 });
    expect(homeworkImageSizeProblem(4032, 3024)).toBeNull();
    expect(homeworkImageSizeProblem(10_000, 6_000)).toBeNull();
    expect(homeworkImageSizeProblem(10_001, 10)).toBe('too_large');
    expect(homeworkImageSizeProblem(10, 10_001)).toBe('too_large');
    expect(homeworkImageSizeProblem(7_746, 7_746)).toBe('too_large');
    expect(homeworkImageSizeProblem(2 ** 31 - 1, 2 ** 31 - 1)).toBe('too_large');
    for (const [w, h] of [
      [0, 10],
      [10, 0],
      [-1, 10],
      [1.5, 10],
      [Number.NaN, 10],
      [Number.POSITIVE_INFINITY, 10],
    ]) {
      expect(homeworkImageSizeProblem(w!, h!), `${w}x${h}`).toBe('missing');
    }
    for (const rule of ['FORMAT_NOT_SUPPORTED_YET', 'UPLOAD_MISMATCH']) {
      expect(HOMEWORK_BUSINESS_RULES).toContain(rule);
    }
  });
});

describe('registration refuses types the scan job cannot read yet (AC_CAPTURE_02)', () => {
  it('HEIC and PDF pages are refused honestly before anything is registered or signed', async () => {
    for (const mimeType of ['image/heic', 'application/pdf']) {
      const id = await draft(2);
      const res = await upload(id, [page(1), page(2, { mimeType })]);
      expect(res.status, mimeType).toBe(422);
      const error = await errorOf(res);
      expect(error.rule).toBe('FORMAT_NOT_SUPPORTED_YET');
      expect(error.message).toMatch(/can’t be read yet/);
      expect(error.message).toMatch(/JPEG or PNG/);
      expect(await storedPages(id)).toEqual([]);
      expect(await sideEffects(id)).toEqual({ status: 'draft', reservations: 0, jobs: 0 });
    }
  });

  it('types that are never allowed keep their own rule, and its copy lists only readable types', async () => {
    const id = await draft(1);
    const res = await upload(id, [page(1, { mimeType: 'image/gif' })]);
    const error = await errorOf(res);
    expect(error.rule).toBe('UNSUPPORTED_FILE_TYPE');
    expect(error.message).not.toMatch(/HEIC|PDF/);
  });
});

describe('finalize verifies the stored objects against the registration (AC_CAPTURE_02)', () => {
  it('a stored page whose size differs from the registered size is refused, removed and can be resent', async () => {
    const id = await draft(2);
    const registered = await upload(id, [page(1), page(2)]);
    expect(registered.status).toBe(200);
    const [p1, p2] = await storedPages(id);
    const storage = api.providers.storage;
    storage.put(p1!.storage_path, new Uint8Array(p1!.byte_size)); // what was registered
    storage.put(p2!.storage_path, new Uint8Array(1_000)); // different bytes than declared
    const refused = await finalize(id);
    expect(refused.status).toBe(422);
    const error = await errorOf(refused);
    expect(error.rule).toBe('UPLOAD_MISMATCH');
    // Nothing was reserved or queued, and the unverified object is gone so a resume re-sends it.
    expect(await sideEffects(id)).toEqual({ status: 'uploading', reservations: 0, jobs: 0 });
    expect(storage.objects.has(p2!.storage_path)).toBe(false);
    expect(storage.objects.has(p1!.storage_path)).toBe(true);
    expect(api.logs.some((e) => e.event === 'homework_upload_mismatch')).toBe(true);

    const resumed = uploadPagesResponseSchema.parse(
      await json(
        await upload(
          id,
          (
            await api.db.sql<Row[]>`
              select page_number as "pageNumber", mime_type as "mimeType", byte_size as "byteSize", sha256
                from public.source_pages where assignment_id = ${id} order by page_number`
          ).map((r) => ({ ...r })),
        ),
      ),
    );
    expect(resumed.uploads.map((u) => u.alreadyUploaded)).toEqual([true, false]);
    storage.put(p2!.storage_path, new Uint8Array(p2!.byte_size));
    const sent = await finalize(id);
    expect(sent.status).toBe(200);
    expect(assignmentStateResponseSchema.parse(await json(sent)).assignment.status).toBe('queued');
    expect(await sideEffects(id)).toEqual({ status: 'queued', reservations: 1, jobs: 1 });
  });

  it('a stored object one byte over the 15 MB page limit is refused: it cannot match any registered size', async () => {
    const id = await draft(1);
    expect((await upload(id, [page(1, { byteSize: 15 * 1024 * 1024 })])).status).toBe(200);
    const [p1] = await storedPages(id);
    api.providers.storage.put(p1!.storage_path, new Uint8Array(15 * 1024 * 1024 + 1));
    const refused = await finalize(id);
    expect((await errorOf(refused)).rule).toBe('UPLOAD_MISMATCH');
    expect(await sideEffects(id)).toEqual({ status: 'uploading', reservations: 0, jobs: 0 });
    expect(api.providers.storage.objects.has(p1!.storage_path)).toBe(false);
  });

  it('finalize applies the page limit in force when it runs, even to a size that matches', async () => {
    // Registered and stored at 2 MB under the 15 MB limit; the limit is then lowered to 1 MB (a
    // configuration change between registration and finalize). The sizes match, so only the page
    // limit can refuse it.
    const id = await draft(1);
    const size = 2 * 1024 * 1024;
    expect((await upload(id, [page(1, { byteSize: size })])).status).toBe(200);
    const [p1] = await storedPages(id);
    api.providers.storage.put(p1!.storage_path, new Uint8Array(size));
    const refused = await routesWithMaxPageBytes(1024 * 1024).request(
      `/v1/assignments/${id}/finalize`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ idempotencyKey: key() }),
      },
    );
    expect(refused.status).toBe(422);
    expect((await errorOf(refused)).rule).toBe('UPLOAD_MISMATCH');
    expect(await sideEffects(id)).toEqual({ status: 'uploading', reservations: 0, jobs: 0 });
    expect(api.providers.storage.objects.has(p1!.storage_path)).toBe(false);
  });

  it('an unreadable storage answer is a provider outage, never a pass', async () => {
    const id = await draft(1);
    await upload(id, [page(1)]);
    const [p1] = await storedPages(id);
    const storage = api.providers.storage;
    storage.put(p1!.storage_path, new Uint8Array(p1!.byte_size));
    const original = storage.stat.bind(storage);
    storage.stat = () => Promise.reject(new Error('storage down'));
    try {
      const res = await finalize(id);
      expect(res.status).toBe(503);
      expect((await errorOf(res)).code).toBe('PROVIDER_UNAVAILABLE');
    } finally {
      storage.stat = original;
    }
    expect(await sideEffects(id)).toEqual({ status: 'uploading', reservations: 0, jobs: 0 });
    expect(storage.objects.has(p1!.storage_path)).toBe(true); // nothing is removed on an outage
    expect((await finalize(id)).status).toBe(200);
  });

  it('the memory mock is labeled and measures what was put, not what was declared', async () => {
    const storage = api.providers.storage;
    expect(storage.isMock).toBe(true);
    const path = `${fam.familyId}/mock-check/${randomUUID()}.jpg`;
    expect(await storage.stat(path)).toBeNull();
    await storage.createSignedUploadUrl(path, 60, { byteSize: 5, contentType: 'image/jpeg' });
    storage.put(path, new Uint8Array(7));
    expect(await storage.stat(path)).toEqual({ byteSize: 7 });
    // The `objects.add` shorthand models a device that uploaded exactly what it registered.
    const shorthand = `${fam.familyId}/mock-check/${randomUUID()}.jpg`;
    await storage.createSignedUploadUrl(shorthand, 60, { byteSize: 9, contentType: 'image/png' });
    storage.objects.add(shorthand);
    expect(await storage.stat(shorthand)).toEqual({ byteSize: 9 });
    // An object with no known size is an error, never a guess.
    const unknown = `${fam.familyId}/mock-check/${randomUUID()}.jpg`;
    storage.objects.add(unknown);
    await expect(storage.stat(unknown)).rejects.toThrow(/no size/);
    await storage.remove([path, shorthand, unknown]);
    expect(await storage.stat(path)).toBeNull();
  });
});

describe('Supabase Storage stat request shape (fake fetch; untested against a live service)', () => {
  const SERVICE_KEY = 'test-service-role-key-not-real-0000';
  function storageWith(respond: (url: string, init: RequestInit) => Response) {
    const seen: { url: string; method: string; headers: Record<string, string> }[] = [];
    return {
      seen,
      fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
        seen.push({
          url,
          method: init?.method ?? 'GET',
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return Promise.resolve(respond(url, init ?? {}));
      },
    };
  }

  it('reads the object info endpoint and reports the size storage measured', async () => {
    const { createSupabaseStorage } = await import('../src/providers/supabase-storage.ts');
    const { seen, fetchImpl } = storageWith((url) => {
      // storage-api renders ERRORS.NoSuchKey as HTTP 400 with statusCode "404" (older versions
      // omit `code`); a plain HTTP 404 with the same body is accepted too.
      if (url.endsWith('/missing.jpg')) {
        return Response.json(
          { statusCode: '404', error: 'not_found', message: 'Object not found' },
          { status: 400 },
        );
      }
      if (url.endsWith('/gone.jpg')) {
        return Response.json(
          { statusCode: '404', code: 'NoSuchKey', error: 'not_found', message: 'Object not found' },
          { status: 400 },
        );
      }
      if (url.endsWith('/gone404.jpg')) {
        return Response.json(
          { statusCode: '404', code: 'NoSuchKey', error: 'not_found', message: 'Object not found' },
          { status: 404 },
        );
      }
      // storage-api InfoRenderer body (src/storage/renderer/info.ts).
      return Response.json({
        id: 'b6d5c9f0-0000-4000-8000-000000000000',
        name: 'f/c/a/p.jpg',
        version: 'v1',
        bucket_id: 'homework',
        size: 250_000,
        content_type: 'image/jpeg',
        cache_control: 'max-age=3600',
        etag: '"9b2cf535f27731c974343645a3985328"',
        metadata: null,
        last_modified: '2026-09-24T15:00:00.000Z',
        created_at: '2026-09-24T15:00:00.000Z',
      });
    });
    const storage = createSupabaseStorage({
      supabaseUrl: 'https://project.supabase.co',
      serviceRoleKey: SERVICE_KEY,
      fetchImpl,
    });
    expect(await storage.stat('f/c/a/p.jpg')).toEqual({ byteSize: 250_000 });
    expect(await storage.stat('f/c/a/missing.jpg')).toBeNull();
    expect(await storage.stat('f/c/a/gone.jpg')).toBeNull();
    expect(await storage.stat('f/c/a/gone404.jpg')).toBeNull();
    expect(
      seen.map((s) => `${s.method} ${s.url.replace('https://project.supabase.co', '')}`),
    ).toEqual([
      'GET /storage/v1/object/info/homework/f/c/a/p.jpg',
      'GET /storage/v1/object/info/homework/f/c/a/missing.jpg',
      'GET /storage/v1/object/info/homework/f/c/a/gone.jpg',
      'GET /storage/v1/object/info/homework/f/c/a/gone404.jpg',
    ]);
    expect(seen[0]!.headers).toMatchObject({
      authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
    });
  });

  it('never guesses: a missing size, another 400 or a server error is an error (status only)', async () => {
    const { createSupabaseStorage, StorageRequestError } =
      await import('../src/providers/supabase-storage.ts');
    const responses: Record<string, () => Response> = {
      'nosize.jpg': () => Response.json({ name: 'f/c/a/nosize.jpg', size: null }),
      'textsize.jpg': () => Response.json({ size: '250000' }),
      'badrequest.jpg': () =>
        Response.json(
          { statusCode: '400', error: 'InvalidKey', message: 'f/c/a exploded' },
          {
            status: 400,
          },
        ),
      'down.jpg': () => new Response('{"message":"f/c/a/down.jpg exploded"}', { status: 500 }),
      // Only an answer that names a missing object means "absent". A storage version without the
      // info route (Fastify's own 404), a missing bucket or a bare 404 is an error, so finalize
      // answers PROVIDER_UNAVAILABLE instead of UPLOAD_INCOMPLETE for pages HEAD says are there.
      'noroute.jpg': () =>
        Response.json(
          {
            message: 'Route GET:/object/info/homework/f/c/a/noroute.jpg exploded',
            error: 'Not Found',
            statusCode: 404,
          },
          { status: 404 },
        ),
      'nobucket.jpg': () =>
        Response.json(
          {
            statusCode: '404',
            code: 'NoSuchBucket',
            error: 'Bucket not found',
            message: 'Bucket not found exploded',
          },
          { status: 400 },
        ),
      'bare404.jpg': () => new Response(null, { status: 404 }),
      'html404.jpg': () => new Response('<html>exploded</html>', { status: 404 }),
    };
    const { fetchImpl } = storageWith((url) => responses[url.split('/').pop()!]!());
    const storage = createSupabaseStorage({
      supabaseUrl: 'https://project.supabase.co',
      serviceRoleKey: SERVICE_KEY,
      fetchImpl,
    });
    for (const name of Object.keys(responses)) {
      const failure = await storage.stat(`f/c/a/${name}`).catch((e: unknown) => e);
      expect(failure, name).toBeInstanceOf(StorageRequestError);
      expect((failure as Error).message, name).not.toContain('exploded');
    }
    await expect(storage.stat('f/../other-family/x.jpg')).rejects.toThrow(
      /Invalid storage object path/,
    );
  });
});

// ---------------------------------------------------------------------------------------------

/** 61 bytes declaring a 50,000 × 50,000 PNG (2.5 gigapixels); IDAT is never inflated. */
function pngBomb(): Uint8Array {
  const crc32 = (bytes: number[]) => {
    let c = 0xffffffff;
    for (const b of bytes) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const chunk = (type: string, data: number[]) => {
    const body = [...Array.from(type, (c) => c.charCodeAt(0)), ...data];
    return [...u32(data.length), ...body, ...u32(crc32(body))];
  };
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', [...u32(50_000), ...u32(50_000), 1, 0, 0, 0, 0]),
    ...chunk('IDAT', [0x78, 0x9c, 0x03, 0x00]),
    ...chunk('IEND', []),
  ]);
}

describe('the scan job refuses a decompression bomb before any AI request (AC_CAPTURE_02)', () => {
  it('a page whose header declares 2.5 gigapixels asks for a retake and gives the page back', async () => {
    const childId = fam.children[0]!.id;
    const [a] = await api.db.sql<{ id: string }[]>`
      insert into public.assignments (family_id, child_id, idempotency_key, created_by_kind, page_count, status)
      values (${fam.familyId}, ${childId}, ${'bomb-' + randomUUID()}, 'parent', 1, 'queued') returning id`;
    const pageId = randomUUID();
    await api.db.sql`
      insert into public.source_pages (id, assignment_id, family_id, child_id, page_number, storage_path, mime_type, byte_size, sha256)
      values (${pageId}, ${a!.id}, ${fam.familyId}, ${childId}, 1,
              ${`${fam.familyId}/${childId}/${a!.id}/${pageId}.png`}, 'image/png', 61, ${'b'.repeat(64)})`;
    const [r] = await api.db.sql<{ id: string }[]>`
      insert into public.usage_reservations (family_id, child_id, period_key, units, idempotency_key)
      values (${fam.familyId}, ${childId}, 'pages:2026-09', 1, ${`scan-usage:${a!.id}:v1`}) returning id`;
    await api.db.sql`
      insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, max_attempts, run_after)
      values ('scan_process', ${`scan:${a!.id}:v1`}, ${fam.familyId}, ${childId},
              ${JSON.stringify({ assignmentId: a!.id, mode: 'initial', reservationId: r!.id })}::text::jsonb,
              5, ${new Date(api.now.value.getTime() - 1000)})`;

    // LABELED MOCK AI client: any request at all would be a failure of this test.
    const client = createMockResponsesClient(() => ({
      kind: 'error',
      status: 500,
      retryable: false,
      latencyMs: 1,
      timedOut: false,
    }));
    const bomb = pngBomb();
    expect(bomb.length).toBe(61);
    await runJobs(deps, {
      scan_process: createScanProcessHandler({
        ai: client,
        readObject: () => Promise.resolve(bomb),
        sleep: () => Promise.resolve(),
      }),
    });
    expect(client.requests).toHaveLength(0);
    const [state] = await api.db.sql<{ status: string; error_code: string | null }[]>`
      select status, error_code from public.assignments where id = ${a!.id}`;
    expect(state).toEqual({ status: 'needs_rescan', error_code: 'IMAGE_UNREADABLE' });
    const [reservation] = await api.db.sql<{ status: string }[]>`
      select status from public.usage_reservations where id = ${r!.id}`;
    expect(reservation!.status).toBe('released');
  });
});
