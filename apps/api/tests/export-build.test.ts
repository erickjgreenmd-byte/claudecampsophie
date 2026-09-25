import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cryptoRandom } from '@pencillift/domain';
import { grantAdultUnlock, seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { DEFAULT_HANDLERS, runJobs, type JobDeps } from '../src/jobs/dispatcher.ts';
import {
  createExportBuildHandler,
  csvCell,
  storageUploader,
  type ExportUploader,
} from '../src/jobs/export-build.ts';
import { escapePdfString, renderTextPdf, toWinAnsiText } from '../src/services/pdf.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * Private exports (AC_LEARNING_10, AC_SECURITY_05): a questions PDF can never contain a key, the
 * answer key needs its own step-up request, CSV cells are formula-safe. Storage uploads go to a
 * labeled in-memory stub. Synthetic child: Riley.
 */

let api: TestApi;
let deps: JobDeps;
let fam: SeededFamily;
let token: string;
const SESSION = 'd4d4d4d4-4444-4444-8444-444444444444';
const uploads = new Map<string, { bytes: Uint8Array; contentType: string }>();
const stubUpload: ExportUploader = (path, bytes, contentType) => {
  uploads.set(path, { bytes, contentType });
  return Promise.resolve();
};

const SECRET_WORD = 'quixotical';
const SECRET_EXPLANATION = 'Parent-only explanation marker 7Q9Z';

const text = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);

let setId: string;

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
  fam = await seedFamily(api.db, { childCount: 1 });
  await grantAdultUnlock(api.db, fam.ownerId, SESSION, 3600);
  token = await parentToken(fam.ownerId, { sessionId: SESSION });
  const child = fam.children[0]!.id;
  // A review set whose private keys carry unmistakable markers.
  const [set] = await api.db.sql<{ id: string }[]>`
    insert into public.practice_sets (family_id, child_id, kind, set_key, subject_key, review_week, status, release_at)
    values (${fam.familyId}, ${child}, 'thursday_review', ${'review:' + child + ':spelling_vocabulary:2026-W39:s1'},
            'spelling_vocabulary', '2026-W39', 'ready', now())
    returning id`;
  setId = set!.id;
  const items = [
    {
      prompt: {
        text: 'Fill in the missing letters (a word that means idealistic): q u _ x _ t i c a l',
        choices: null,
        passage: null,
        responseFormat: 'word',
        unitHint: null,
      },
      key: {
        spec: { kind: 'spelling', target: SECRET_WORD, alternates: [] },
        instanceKey: 'spelling.x#00000001',
        templateKey: 'spelling.x',
        generator: 'practice.v1',
      },
    },
    {
      prompt: {
        text: 'Which word completes the sentence? (Use the chart) “We could ____ the ocean.”',
        choices: ['sea', 'see'],
        passage: null,
        responseFormat: 'choice',
        unitHint: null,
      },
      key: {
        spec: { kind: 'multiple_choice', letters: ['B'], validLetters: ['A', 'B'], alternates: [] },
        instanceKey: 'vocab.y#00000002',
        templateKey: 'vocab.y',
        generator: 'practice.v1',
      },
    },
  ];
  for (const [i, item] of items.entries()) {
    const [row] = await api.db.sql<{ id: string }[]>`
      insert into public.practice_items (set_id, family_id, child_id, position, subject_key, skill, category, prompt)
      values (${setId}, ${fam.familyId}, ${child}, ${i + 1}, 'spelling_vocabulary', 'spelling.grade_words', 'weak',
              ${JSON.stringify(item.prompt)}::text::jsonb)
      returning id`;
    await api.db.sql`
      insert into private.practice_item_keys (item_id, family_id, answer_spec, explanation)
      values (${row!.id}, ${fam.familyId}, ${JSON.stringify(item.key)}::text::jsonb, ${SECRET_EXPLANATION + ' #' + (i + 1)})`;
  }
});

afterAll(async () => {
  await api?.close();
});

async function requestExport(variant: 'questions' | 'answer_key'): Promise<string> {
  const res = await api.request('/v1/exports/review-pdf', {
    method: 'POST',
    token,
    body: { setId, variant },
  });
  expect(res.status).toBe(202);
  return (await json<{ exportId: string }>(res)).exportId;
}

async function exportRow(id: string) {
  const [row] = await api.db.sql<{ status: string; storage_path: string | null; kind: string }[]>`
    select status, storage_path, kind from public.data_exports where id = ${id}`;
  return row!;
}

describe('text PDF writer', () => {
  it('escapes string delimiters and cannot be broken out of', () => {
    expect(escapePdfString('a (b) \\ c')).toBe('a \\(b\\) \\\\ c');
    const bytes = renderTextPdf({
      title: 'Test',
      blocks: [{ kind: 'paragraph', text: ') Tj ET /JavaScript (alert) /OpenAction << >> (' }],
    });
    const pdf = text(bytes);
    expect(pdf).toContain('\\) Tj ET /JavaScript \\(alert\\) /OpenAction << >> \\(');
    // Only our own dictionaries appear outside strings: no actions, scripts, links or embeds.
    const outsideStrings = pdf.replace(/\((?:\\.|[^\\)])*\)/g, '()');
    for (const bad of [
      '/JavaScript',
      '/JS',
      '/OpenAction',
      '/AA',
      '/URI',
      '/Launch',
      '/EmbeddedFile',
      '/AcroForm',
    ]) {
      expect(outsideStrings).not.toContain(bad);
    }
  });

  it('writes a structurally valid file with correct xref offsets and pagination', () => {
    const long = Array.from({ length: 400 }, (_, i) => ({
      kind: 'paragraph' as const,
      text: `Question ${i + 1}: ${'word '.repeat(30)}`,
    }));
    const bytes = renderTextPdf({ title: 'Long', blocks: long });
    const pdf = text(bytes);
    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    const startxref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(startxref, startxref + 4)).toBe('xref');
    const entries = [...pdf.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
      Number(m[1]),
    );
    entries.forEach((offset, i) =>
      expect(pdf.slice(offset).startsWith(`${i + 1} 0 obj`)).toBe(true),
    );
    const pages = Number(/\/Count (\d+)/.exec(pdf)![1]);
    expect(pages).toBeGreaterThan(5);
    // Unicode outside the standard font becomes a safe replacement; typographic quotes survive.
    expect(toWinAnsiText('3 × 4 − 1 “ok” 🙂')).toBe('3 × 4 - 1 “ok” ?');
  });
});

describe('CSV cells are formula-safe', () => {
  it('prefixes formula starters and quotes separators', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(7)).toBe('7');
  });
});

describe('review PDF exports (AC_LEARNING_10)', () => {
  it('the questions PDF never contains a key, even if the job payload asks for one', async () => {
    const exportId = await requestExport('questions');
    // Tamper with the queued job: the builder must ignore everything but the export row's kind.
    await api.db.sql`
      update public.jobs set payload = ${JSON.stringify({ exportId, setId, variant: 'answer_key', includeKey: true })}::text::jsonb
       where idempotency_key = ${'export:' + exportId}`;
    const report = await runJobs(deps, {
      export_build: createExportBuildHandler({ upload: stubUpload }),
    });
    expect(report.succeeded).toBeGreaterThanOrEqual(1);
    const row = await exportRow(exportId);
    expect(row).toMatchObject({
      status: 'ready',
      kind: 'review_questions_pdf',
      storage_path: `exports/${fam.familyId}/${exportId}.pdf`,
    });
    const pdf = text(uploads.get(row.storage_path!)!.bytes);
    expect(pdf).toContain('Fill in the missing letters');
    expect(pdf).toContain('A. sea');
    expect(pdf.toLowerCase()).not.toContain(SECRET_WORD);
    expect(pdf).not.toContain('7Q9Z');
    expect(pdf).not.toMatch(/Answer key/i);
  });

  it('the answer key export (step-up route) contains the key and explanations', async () => {
    const exportId = await requestExport('answer_key');
    await runJobs(deps, { export_build: createExportBuildHandler({ upload: stubUpload }) });
    const row = await exportRow(exportId);
    expect(row.status).toBe('ready');
    const pdf = text(uploads.get(row.storage_path!)!.bytes);
    expect(pdf).toContain(SECRET_WORD);
    expect(pdf).toContain('B: see');
    expect(pdf).toContain(SECRET_EXPLANATION);
  });

  it('a child cannot request any export', async () => {
    const code = await api.request(`/v1/children/${fam.children[0]!.id}/pairing-code`, {
      method: 'POST',
      token,
    });
    const paired = await api.request('/v1/child/pair', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '198.51.100.77' },
      body: {
        code: (await json<{ code: string }>(code)).code,
        deviceLabel: 'Tablet',
        platform: 'ios',
      },
    });
    const child = (await json<{ accessToken: string }>(paired)).accessToken;
    for (const [path, body] of [
      ['/v1/exports/review-pdf', { setId, variant: 'questions' }],
      ['/v1/exports/review-pdf', { setId, variant: 'answer_key' }],
      ['/v1/exports', { kind: 'review_questions_pdf', childId: fam.children[0]!.id }],
      ['/v1/exports/answer-key', { childId: fam.children[0]!.id }],
    ] as const) {
      const res = await api.request(path, { method: 'POST', token: child, body });
      expect(res.status).toBe(401);
    }
  });
});

describe('progress and family data exports', () => {
  async function queue(kind: string): Promise<string> {
    const [row] = await api.db.sql<{ id: string }[]>`
      insert into public.data_exports (family_id, requested_by, kind, child_id)
      values (${fam.familyId}, ${fam.ownerId}, ${kind}, ${kind === 'family_data' ? null : fam.children[0]!.id}) returning id`;
    await api.db.sql`
      insert into public.jobs (kind, idempotency_key, family_id, payload, run_after)
      values ('export_build', ${'export:' + row!.id}, ${fam.familyId}, ${JSON.stringify({ exportId: row!.id })}::text::jsonb, ${api.now.value})`;
    return row!.id;
  }

  it('builds a formula-safe progress CSV from the child’s evidence', async () => {
    const child = fam.children[0]!.id;
    for (let i = 0; i < 2; i += 1) {
      const q = randomUUID();
      await api.db.sql`
        insert into public.attempts (family_id, child_id, question_instance_id, source, subject_key, skill, attempt_number,
                                     correctness, grader_version, idempotency_key, occurred_at)
        values (${fam.familyId}, ${child}, ${q}, 'homework', 'math', '=HYPERLINK("http://evil.test")', 1, 'correct', 't',
                ${'h:' + q}, now() - interval '1 day')`;
    }
    const id = await queue('progress_csv');
    await runJobs(deps, { export_build: createExportBuildHandler({ upload: stubUpload }) });
    const row = await exportRow(id);
    expect(row.status).toBe('ready');
    const upload = uploads.get(row.storage_path!)!;
    expect(upload.contentType).toBe('text/csv');
    const csv = new TextDecoder().decode(upload.bytes);
    expect(csv.split('\r\n')[0]).toBe(
      'child,subject,skill,status,distinct_independent_questions,initial_accuracy,eventual_completion,last_practiced_at',
    );
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.test"")"`);
    expect(csv).toContain('not_enough_evidence');
    expect(csv).not.toMatch(/(^|,)=/m);
  });

  it('family data JSON holds the family’s own records and no answer keys', async () => {
    const id = await queue('family_data');
    await runJobs(deps, { export_build: createExportBuildHandler({ upload: stubUpload }) });
    const row = await exportRow(id);
    expect(row.status).toBe('ready');
    const body = new TextDecoder().decode(uploads.get(row.storage_path!)!.bytes);
    const data = JSON.parse(body) as Record<string, unknown[]>;
    expect(data.practiceItems).toHaveLength(2);
    expect(body).not.toContain(SECRET_WORD);
    expect(body).not.toContain('7Q9Z');
  });

  it('marks the export failed when the set is gone, and retries uploads until the last attempt', async () => {
    const [missing] = await api.db.sql<{ id: string }[]>`
      insert into public.data_exports (family_id, requested_by, kind, child_id)
      values (${fam.familyId}, ${fam.ownerId}, 'review_questions_pdf', ${fam.children[0]!.id}) returning id`;
    await api.db.sql`
      insert into public.jobs (kind, idempotency_key, family_id, payload, run_after)
      values ('export_build', ${'export:' + missing!.id}, ${fam.familyId},
              ${JSON.stringify({ exportId: missing!.id, setId: randomUUID() })}::text::jsonb, ${api.now.value})`;
    await runJobs(deps, { export_build: createExportBuildHandler({ upload: stubUpload }) });
    expect((await exportRow(missing!.id)).status).toBe('failed');

    const id = await queue('progress_pdf');
    await api.db
      .sql`update public.jobs set max_attempts = 2 where idempotency_key = ${'export:' + id}`;
    const failing: ExportUploader = () => Promise.reject(new Error('storage down'));
    const first = await runJobs(deps, {
      export_build: createExportBuildHandler({ upload: failing }),
    });
    expect(first.retried).toBe(1);
    expect((await exportRow(id)).status).toBe('queued');
    await api.db
      .sql`update public.jobs set run_after = ${new Date(api.now.value.getTime() - 60_000)} where idempotency_key = ${'export:' + id}`;
    api.now.value = new Date(Date.now() + 3_600_000);
    await runJobs(deps, { export_build: createExportBuildHandler({ upload: failing }) });
    expect((await exportRow(id)).status).toBe('failed');
  });

  it('never builds a child’s export once that child’s deletion was requested (spec P4)', async () => {
    const other = await seedFamily(api.db, { childCount: 2 });
    const [sam] = [other.children[1]!.id];
    const exports: string[] = [];
    for (const [kind, childId] of [
      ['progress_csv', sam],
      ['family_data', null],
    ] as const) {
      const [row] = await api.db.sql<{ id: string }[]>`
        insert into public.data_exports (family_id, requested_by, kind, child_id)
        values (${other.familyId}, ${other.ownerId}, ${kind}, ${childId}) returning id`;
      await api.db.sql`
        insert into public.jobs (kind, idempotency_key, family_id, payload, run_after)
        values ('export_build', ${'export:' + row!.id}, ${other.familyId}, ${JSON.stringify({ exportId: row!.id })}::text::jsonb, ${api.now.value})`;
      exports.push(row!.id);
    }
    await api.db.sql`
      insert into public.deletion_requests (family_id, scope, child_id, target_child_id, requested_by)
      values (${other.familyId}, 'child', ${sam}, ${sam}, ${other.ownerId})`;
    await runJobs(deps, { export_build: createExportBuildHandler({ upload: stubUpload }) });
    expect((await exportRow(exports[0]!)).status).toBe('failed');
    const family = await exportRow(exports[1]!);
    expect(family.status).toBe('ready');
    const body = new TextDecoder().decode(uploads.get(family.storage_path!)!.bytes);
    expect(body).toContain(other.children[0]!.id);
    expect(body).not.toContain(sam);
  });

  it('the default uploader PUTs bytes to a signed URL from the storage provider', async () => {
    const calls: { url: string; method: string; type: string | null }[] = [];
    const fakeFetch = ((url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        type: new Headers(init.headers).get('content-type'),
      });
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    await storageUploader(api.providers.storage, fakeFetch)(
      'exports/f/e.pdf',
      new Uint8Array([1]),
      'application/pdf',
    );
    expect(calls).toEqual([
      {
        url: 'https://storage.mock.invalid/upload/exports%2Ff%2Fe.pdf',
        method: 'PUT',
        type: 'application/pdf',
      },
    ]);
  });
});

describe('the export builder is a registered job (APL-20)', () => {
  it('DEFAULT_HANDLERS carries export_build, and with the labeled memory mock the file lands where the download route signs it', async () => {
    // Before: export-build.ts existed but DEFAULT_HANDLERS had no export_build, so a tick built
    // nothing and the apps said exports were "not switched on".
    expect(Object.keys(DEFAULT_HANDLERS)).toContain('export_build');
    const res = await api.request('/v1/exports', {
      method: 'POST',
      token,
      body: { kind: 'progress_csv' },
    });
    expect(res.status).toBe(202);
    const { export: created } = await json<{ export: { id: string } }>(res);
    const report = await runJobs(deps, DEFAULT_HANDLERS);
    expect(report.succeeded).toBeGreaterThanOrEqual(1);
    const [row] = await api.db.sql<{ status: string; storage_path: string | null }[]>`
      select status, storage_path from public.data_exports where id = ${created.id}`;
    expect(row).toEqual({
      status: 'ready',
      storage_path: `exports/${fam.familyId}/${created.id}.csv`,
    });
    // The bytes are in the mock store (measured, so a stat answers), not behind a dead signed URL.
    expect(await api.providers.storage.stat(row!.storage_path!)).toMatchObject({
      byteSize: expect.any(Number) as number,
    });
    const download = await api.request(`/v1/exports/${created.id}/download`, { token });
    expect(download.status).toBe(200);
  });
});
