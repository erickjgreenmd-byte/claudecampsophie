import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cryptoRandom } from '@pencillift/domain';
import { PARENT_SAFETY_FLAG_COPY } from '@pencillift/contracts';
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
