import { z } from 'zod';
import { keyAnswerText, skillLabel } from '@pencillift/domain/bank';
import { summarizeSkills, type AttemptEvent } from '@pencillift/domain/learning';
import type { Tx } from '../db.ts';
import type { StorageProvider } from '../providers/index.ts';
import { renderTextPdf, type PdfBlock } from '../services/pdf.ts';
import type { JobDeps, JobHandler, JobRow } from './dispatcher.ts';
import { DEFAULT_SUBJECT_NAMES, loadEvidence, parseStoredKey } from './learning-jobs.ts';

/**
 * Private export builder (spec P8, P10; AC_LEARNING_10, AC_SECURITY_05). One `export_build` job per
 * `data_exports` row. The row's KIND (fixed when a parent requested it, with a recent step-up) is
 * the only input that selects content: nothing in the job payload can turn a questions export into
 * an answer key. The questions renderer receives only child-safe prompts and its loader never reads
 * `private.practice_item_keys`, so a key cannot reach that file even by mistake.
 *
 * Files go to private storage at `exports/{family}/{exportId}.{ext}` through a signed upload URL;
 * the row becomes `ready` with the path, or `failed` when the build cannot succeed. Logs carry ids
 * and codes only.
 */

export const EXPORT_TTL_DAYS = 7;
const DAY_MS = 86_400_000;

export type ExportUploader = (
  path: string,
  bytes: Uint8Array,
  contentType: string,
) => Promise<void>;

/**
 * A retryable export failure with a pipeline code, so the job ledger records `UPLOAD_FAILED` or
 * `BUILD_FAILED` in `last_error_code` instead of the class name `Error` (JOBS-R2-01; the same rule
 * as JobFailure, without importing the dispatcher into the module the dispatcher imports).
 */
class RetryableExportFailure extends Error {
  constructor(
    readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(code, options);
    this.name = 'RetryableExportFailure';
  }
}

/** Supabase answers a signed upload to an existing object with 400 "Duplicate", or 409. */
async function isDuplicateObject(response: Response): Promise<boolean> {
  if (response.status === 409) return true;
  if (response.status !== 400) return false;
  const body = await response.text().catch(() => '');
  return /duplicate|already exists/i.test(body);
}

/**
 * Uploads through the storage provider's signed upload URL (no provider interface changes).
 *
 * JOBS-R2-01: Supabase signs uploads with `x-upsert: false`, so a retry after a lost answer (our own
 * 20-second timeout on a large family JSON, a connection reset, the worker killed) finds its own
 * bytes already stored and is refused as a duplicate. The path `exports/{family}/{id}.{ext}` belongs
 * to this one job, so a duplicate whose stored size matches the bytes just built IS this job's
 * earlier success and is treated as one; any other stored object at that path is replaced (remove,
 * then upload again), never left as an orphan. Storage that cannot say the size is not a match: the
 * job retries instead of guessing.
 */
export function storageUploader(
  storage: StorageProvider,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20_000,
): ExportUploader {
  const put = async (path: string, bytes: Uint8Array, contentType: string): Promise<Response> => {
    const { url } = await storage.createSignedUploadUrl(path, 300);
    return await fetchImpl(url, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      // A fresh ArrayBuffer-backed copy satisfies both the Workers and DOM `BodyInit` types.
      body: bytes.slice(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  };
  const upload = async (path: string, bytes: Uint8Array, contentType: string): Promise<void> => {
    const response = await put(path, bytes, contentType);
    if (response.ok) return;
    if (!(await isDuplicateObject(response))) {
      throw new RetryableExportFailure('UPLOAD_FAILED');
    }
    // Storage that cannot say the size rejects here, so the outer catch retries the job: an
    // unknown object is never counted as a match and never blindly overwritten.
    const stored = await storage.stat(path);
    if (stored !== null && stored.byteSize === bytes.length) return; // this job's own earlier upload
    await storage.remove([path]);
    const retry = await put(path, bytes, contentType);
    if (!retry.ok) throw new RetryableExportFailure('UPLOAD_FAILED');
  };
  return async (path, bytes, contentType) => {
    try {
      await upload(path, bytes, contentType);
    } catch (error) {
      // Every upload failure carries the pipeline code, so the ledger records UPLOAD_FAILED and not
      // the class name of a timeout or a fetch error (JOBS-R2-01; the rule of JOBS-R1-04).
      if (error instanceof RetryableExportFailure) throw error;
      throw new RetryableExportFailure('UPLOAD_FAILED', { cause: error });
    }
  };
}

export interface ExportBuildOptions {
  /** Defaults to `storageUploader(deps.providers.storage)`. */
  readonly upload?: ExportUploader;
}

const payloadSchema = z.object({ exportId: z.uuid(), setId: z.uuid().optional() });

/** A failure retrying cannot fix: the export is marked failed immediately. */
class PermanentExportFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PermanentExportFailure';
  }
}

interface ExportRow {
  id: string;
  family_id: string;
  kind:
    | 'family_data'
    | 'progress_pdf'
    | 'progress_csv'
    | 'review_questions_pdf'
    | 'review_answer_key_pdf';
  child_id: string | null;
  status: string;
}

interface Built {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly ext: string;
}

// ---------------------------------------------------------------------------------------------
// Review sets
// ---------------------------------------------------------------------------------------------

interface SetHeader {
  id: string;
  kind: string;
  subject_key: string | null;
  local_date: string | null;
  review_week: string | null;
  version: number;
}

/** The requested set (must belong to the export's family and child) or the latest review week's sets. */
async function reviewSets(tx: Tx, row: ExportRow, setId: string | undefined): Promise<SetHeader[]> {
  if (row.child_id === null) throw new PermanentExportFailure('EXPORT_NEEDS_CHILD');
  if (setId !== undefined) {
    const sets = await tx<SetHeader[]>`
      select id, kind, subject_key, local_date::text as local_date, review_week, version
        from public.practice_sets
       where id = ${setId} and family_id = ${row.family_id} and child_id = ${row.child_id}
         and status in ('ready', 'in_progress', 'completed')`;
    if (sets.length === 0) throw new PermanentExportFailure('SET_NOT_FOUND');
    return sets;
  }
  const sets = await tx<SetHeader[]>`
    select id, kind, subject_key, local_date::text as local_date, review_week, version
      from public.practice_sets
     where family_id = ${row.family_id} and child_id = ${row.child_id}
       and kind in ('thursday_review', 'top_up') and status in ('ready', 'in_progress', 'completed')
       and review_week = (
         select max(review_week) from public.practice_sets
          where family_id = ${row.family_id} and child_id = ${row.child_id} and kind = 'thursday_review')
     order by subject_key, version`;
  if (sets.length === 0) throw new PermanentExportFailure('NO_REVIEW');
  return sets;
}

function setHeading(set: SetHeader): string {
  const subject =
    set.subject_key !== null && Object.hasOwn(DEFAULT_SUBJECT_NAMES, set.subject_key)
      ? DEFAULT_SUBJECT_NAMES[set.subject_key as keyof typeof DEFAULT_SUBJECT_NAMES]
      : 'Practice';
  if (set.kind === 'daily') return `Daily practice ${set.local_date ?? ''}`.trim();
  if (set.kind === 'top_up')
    return `${subject}: optional extra practice (${set.review_week ?? ''})`;
  return `${subject} review (${set.review_week ?? ''})`;
}

/** Child-safe question content only. */
interface QuestionItem {
  readonly setId: string;
  readonly position: number;
  readonly text: string;
  readonly choices: readonly string[];
  readonly passage: { readonly title: string; readonly text: string } | null;
}

function promptFields(raw: unknown): Omit<QuestionItem, 'setId' | 'position'> {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const p = r.passage as { title?: unknown; text?: unknown } | null | undefined;
  return {
    text: typeof r.text === 'string' ? r.text : '',
    choices: Array.isArray(r.choices)
      ? r.choices.filter((c): c is string => typeof c === 'string')
      : [],
    passage:
      p && typeof p.title === 'string' && typeof p.text === 'string'
        ? { title: p.title, text: p.text }
        : null,
  };
}

/** QUESTIONS ONLY: reads public.practice_items; never touches private.practice_item_keys. */
async function loadQuestions(
  tx: Tx,
  row: ExportRow,
  sets: readonly SetHeader[],
): Promise<QuestionItem[]> {
  const rows = await tx<{ set_id: string; position: number; prompt: unknown }[]>`
    select set_id, position, prompt from public.practice_items
     where family_id = ${row.family_id} and set_id = any(${sets.map((s) => s.id)}::uuid[])
     order by set_id, position`;
  return rows.map((r) => ({ setId: r.set_id, position: r.position, ...promptFields(r.prompt) }));
}

const LETTERS = ['A', 'B', 'C', 'D', 'E'];

function questionBlocks(sets: readonly SetHeader[], items: readonly QuestionItem[]): PdfBlock[] {
  const blocks: PdfBlock[] = [];
  for (const set of sets) {
    blocks.push({ kind: 'heading', text: setHeading(set) });
    let lastPassage: string | null = null;
    for (const item of items.filter((i) => i.setId === set.id)) {
      if (item.passage && item.passage.text !== lastPassage) {
        blocks.push({ kind: 'paragraph', text: `Read: ${item.passage.title}` });
        blocks.push({ kind: 'paragraph', text: item.passage.text, indent: 1 });
        lastPassage = item.passage.text;
      }
      blocks.push({ kind: 'paragraph', text: `${item.position}. ${item.text}` });
      item.choices.forEach((choice, i) => {
        blocks.push({ kind: 'paragraph', text: `${LETTERS[i] ?? '?'}. ${choice}`, indent: 1 });
      });
      if (item.choices.length === 0)
        blocks.push({ kind: 'paragraph', text: 'Answer: ________________', indent: 1 });
      blocks.push({ kind: 'spacer' });
    }
  }
  return blocks;
}

/** Renders the child's printable questions. Its input type has no field that can hold a key. */
export function renderQuestionsPdf(
  sets: readonly SetHeader[],
  items: readonly QuestionItem[],
): Uint8Array {
  return renderTextPdf({
    title: 'PencilLift practice questions',
    blocks: [
      { kind: 'title', text: 'Practice questions' },
      {
        kind: 'paragraph',
        text: 'Take your time. Show your work on a separate sheet if you like.',
      },
      { kind: 'spacer' },
      ...questionBlocks(sets, items),
    ],
  });
}

/** PARENT ANSWER KEY: separate loader that joins the private keys (export kind requires step-up). */
async function loadAnswerKey(
  tx: Tx,
  row: ExportRow,
  sets: readonly SetHeader[],
): Promise<{ setId: string; position: number; answer: string; explanation: string | null }[]> {
  const rows = await tx<
    {
      set_id: string;
      position: number;
      prompt: unknown;
      answer_spec: unknown;
      explanation: string | null;
    }[]
  >`
    select i.set_id, i.position, i.prompt, k.answer_spec, k.explanation
      from public.practice_items i
      join private.practice_item_keys k on k.item_id = i.id and k.family_id = i.family_id
     where i.family_id = ${row.family_id} and i.set_id = any(${sets.map((s) => s.id)}::uuid[])
     order by i.set_id, i.position`;
  return rows.map((r) => {
    const key = parseStoredKey(r.answer_spec);
    let answer = key ? keyAnswerText(key.spec) : 'Unavailable';
    const choices = promptFields(r.prompt).choices;
    if (key?.spec.kind === 'multiple_choice') {
      const text = choices[key.spec.validLetters.indexOf(key.spec.letters[0] ?? '')];
      if (text !== undefined) answer = `${answer}: ${text}`;
    }
    return { setId: r.set_id, position: r.position, answer, explanation: r.explanation };
  });
}

function renderAnswerKeyPdf(
  sets: readonly SetHeader[],
  keys: readonly { setId: string; position: number; answer: string; explanation: string | null }[],
): Uint8Array {
  const blocks: PdfBlock[] = [
    { kind: 'title', text: 'Answer key (for grown-ups)' },
    { kind: 'paragraph', text: 'Keep this page away from the practice questions.' },
    { kind: 'spacer' },
  ];
  for (const set of sets) {
    blocks.push({ kind: 'heading', text: setHeading(set) });
    for (const k of keys.filter((x) => x.setId === set.id)) {
      blocks.push({ kind: 'paragraph', text: `${k.position}. ${k.answer}` });
      if (k.explanation) blocks.push({ kind: 'paragraph', text: k.explanation, indent: 1 });
    }
    blocks.push({ kind: 'spacer' });
  }
  return renderTextPdf({ title: 'PencilLift answer key', blocks });
}

// ---------------------------------------------------------------------------------------------
// Progress summaries (CSV / PDF) and the family's own learning data (JSON)
// ---------------------------------------------------------------------------------------------

/** Neutralizes spreadsheet formulas: cells starting with = + - @ (or tab/CR) get a leading apostrophe. */
export function csvCell(value: string | number | null): string {
  let text = value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

interface ProgressRow {
  child: string;
  subject: string;
  skill: string;
  status: string;
  independentQuestions: number;
  initialAccuracy: number | null;
  eventualCompletion: number | null;
  lastPracticed: string | null;
}

async function progressRows(tx: Tx, row: ExportRow, now: Date): Promise<ProgressRow[]> {
  const excluded = await childrenBeingDeleted(tx, row.family_id);
  const children = await tx<{ id: string; nickname: string }[]>`
    select id, nickname from public.child_profiles
     where family_id = ${row.family_id} and (${row.child_id}::uuid is null or id = ${row.child_id}::uuid)
       and not (id = any(${excluded}::uuid[]))
     order by created_at, id`;
  const [family] = await tx<
    { timezone: string }[]
  >`select timezone from public.families where id = ${row.family_id}`;
  const out: ProgressRow[] = [];
  for (const child of children) {
    const events = await loadEvidence(
      tx,
      { familyId: row.family_id, childId: child.id },
      new Date(now.getTime() - 365 * DAY_MS),
    );
    const bySubject = new Map<string, AttemptEvent[]>();
    for (const e of events) bySubject.set(e.subject, [...(bySubject.get(e.subject) ?? []), e]);
    for (const [subject, list] of bySubject) {
      let summaries;
      try {
        summaries = summarizeSkills(list, now, { timeZone: family?.timezone ?? 'UTC' });
      } catch {
        summaries = summarizeSkills(list, now);
      }
      for (const s of summaries) {
        out.push({
          child: child.nickname,
          subject,
          skill: skillLabel(s.skill) === 'Practice' ? s.skill : skillLabel(s.skill),
          status: s.status,
          independentQuestions: s.distinctIndependentQuestions,
          initialAccuracy: s.initialAccuracy,
          eventualCompletion: s.eventualCompletionRate,
          lastPracticed: s.lastPracticedAt?.toISOString() ?? null,
        });
      }
    }
  }
  return out;
}

const pct = (v: number | null) => (v === null ? '' : `${Math.round(v * 100)}%`);

function renderProgressCsv(rows: readonly ProgressRow[]): Uint8Array {
  const header = [
    'child',
    'subject',
    'skill',
    'status',
    'distinct_independent_questions',
    'initial_accuracy',
    'eventual_completion',
    'last_practiced_at',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.child,
        r.subject,
        r.skill,
        r.status,
        r.independentQuestions,
        pct(r.initialAccuracy),
        pct(r.eventualCompletion),
        r.lastPracticed,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return new TextEncoder().encode(`${lines.join('\r\n')}\r\n`);
}

function renderProgressPdf(rows: readonly ProgressRow[]): Uint8Array {
  const blocks: PdfBlock[] = [
    { kind: 'title', text: 'Learning progress summary' },
    {
      kind: 'paragraph',
      text: 'Built from first, unaided tries on different questions. Fewer than five shows "not enough evidence". An educational signal, not a diagnosis.',
    },
    { kind: 'spacer' },
  ];
  for (const r of rows) {
    blocks.push({
      kind: 'paragraph',
      text: `${r.child} / ${r.subject} / ${r.skill}: ${r.status.replace(/_/g, ' ')}; ${r.independentQuestions} independent questions; first-try accuracy ${pct(r.initialAccuracy) || 'n/a'}; eventual completion ${pct(r.eventualCompletion) || 'n/a'}`,
    });
  }
  if (rows.length === 0) blocks.push({ kind: 'paragraph', text: 'No practice recorded yet.' });
  return renderTextPdf({ title: 'PencilLift progress summary', blocks });
}

/** The family's own learning records (no answer keys, no other family's data). */
/**
 * The family's own learning records (no answer keys, no other family's data). Decision: a child with
 * a pending deletion request is left out of every section (spec P4: deletion stops processing
 * immediately), so a family-wide export never carries data that is about to be purged.
 */
async function familyData(tx: Tx, row: ExportRow, now: Date): Promise<Uint8Array> {
  const fam = row.family_id;
  const skip = await childrenBeingDeleted(tx, fam);
  const data = {
    exportedAt: now.toISOString(),
    family:
      await tx`select id, display_name, timezone, created_at from public.families where id = ${fam}`,
    children: await tx`
      select id, nickname, grade_level, age_band, status, accessibility, curriculum_notes, created_at
        from public.child_profiles
       where family_id = ${fam} and not (id = any(${skip}::uuid[]))`,
    subjects: await tx`
      select id, child_id, subject_key, display_name, enabled from public.child_subjects
       where family_id = ${fam} and not (child_id = any(${skip}::uuid[]))`,
    schedules: await tx`
      select child_id, review_weekday, review_local_time::text as review_local_time,
             review_questions_per_subject, schedule_version, daily_local_time::text as daily_local_time,
             daily_question_count, paused_from::text as paused_from, paused_to::text as paused_to,
             quiet_hours_start::text as quiet_hours_start, quiet_hours_end::text as quiet_hours_end,
             child_reminders_permitted, updated_at
        from public.learning_schedules
       where family_id = ${fam} and not (child_id = any(${skip}::uuid[]))`,
    testDates: await tx`
      select id, child_id, subject_id, test_date::text as test_date, scope_notes from public.test_dates
       where family_id = ${fam} and not (child_id = any(${skip}::uuid[]))`,
    studyMaterials: await tx`
      select id, child_id, subject_id, kind, content_text, created_at from public.study_materials
       where family_id = ${fam} and not (child_id = any(${skip}::uuid[]))`,
    practiceSets: await tx`
      select id, child_id, kind, subject_key, local_date::text as local_date, review_week, version, status, created_at
        from public.practice_sets
       where family_id = ${fam} and not (child_id = any(${skip}::uuid[]))`,
    practiceItems: await tx`
      select id, set_id, child_id, position, subject_key, skill, prompt from public.practice_items
       where family_id = ${fam} and not (child_id = any(${skip}::uuid[]))`,
    attempts: await tx`
      select id, child_id, question_instance_id, source, subject_key, skill, attempt_number, hints_used,
             correctness, occurred_at
        from public.attempts
       where family_id = ${fam} and not (child_id = any(${skip}::uuid[]))`,
    pointsLedger: await tx`
      select id, child_id, kind, points, reason, created_at from public.points_ledger
       where family_id = ${fam} and not (child_id = any(${skip}::uuid[]))`,
    // CS-R2-05: the homework records this export used to leave out, although the portal calls it
    // "All family data" and the policy promises "the answers your child submits" and "reward
    // requests". Parent-only content stays out: no row here reads private.question_solutions or
    // private.practice_item_keys, and no raw homework image bytes or storage paths are exported.
    assignments: await tx`
      select id, child_id, subject_id, status, page_count, error_code, created_at, updated_at
        from public.assignments
       where family_id = ${fam} and not (child_id = any(${skip}::uuid[]))`,
    questions: await tx`
      select q.id, q.assignment_id, q.child_id, p.page_number, q.question_number, q.prompt_text,
             q.student_answer_text, q.corrected_prompt_text, q.corrected_student_answer_text,
             q.corrected_at, q.answer_kind, q.subject_key, q.skill, q.subskill, q.grade_estimate,
             q.uncertainty, q.transcription_version, q.created_at
        from public.extracted_questions q
        join public.source_pages p on p.id = q.page_id
       where q.family_id = ${fam} and not (q.child_id = any(${skip}::uuid[]))`,
    questionResults: await tx`
      select question_id, child_id, verdict, route, disagreement, graded_at,
             parent_override_verdict, overridden_at, override_reason
        from public.question_results
       where family_id = ${fam} and not (child_id = any(${skip}::uuid[]))`,
    childFeedback: await tx`
      select id, question_id, child_id, kind, body, created_at from public.child_feedback
       where family_id = ${fam} and not (child_id = any(${skip}::uuid[]))`,
    targetAnswerAttempts: await tx`
      select question_instance_id, child_id, count, updated_at from public.target_answer_attempts
       where family_id = ${fam} and not (child_id = any(${skip}::uuid[]))`,
    rewards: await tx`
      select id, child_id, title, point_cost, instructions, active, created_at, updated_at
        from public.rewards
       where family_id = ${fam} and not (child_id = any(${skip}::uuid[]))`,
    rewardRedemptions: await tx`
      select id, child_id, reward_id, point_cost, state, requested_at, decided_at, fulfilled_at,
             cancelled_by
        from public.reward_redemptions
       where family_id = ${fam} and not (child_id = any(${skip}::uuid[]))`,
    pointBalances: await tx`
      select child_id, balance, updated_at from public.point_balances
       where family_id = ${fam} and not (child_id = any(${skip}::uuid[]))`,
    // The flags the family can already see in its report list, WITHOUT the reviewer-only columns:
    // no category, no screen_categories, no screen_version and no provider codes, so the export
    // cannot say which kind of concern was flagged (CS-R2-02).
    safetyFlags: await tx`
      select id, child_id, reporter_kind, question_id, feedback_id, note, status, resolution,
             created_at, triaged_at, resolved_at, transcription_at, parent_email_status,
             parent_emailed_at
        from public.safety_reports
       where family_id = ${fam} and family_visible
         and not (child_id = any(${skip}::uuid[]))`,
  };
  return new TextEncoder().encode(JSON.stringify(data, null, 2));
}

/** Children of the family with an open deletion request (their data is never exported). */
async function childrenBeingDeleted(tx: Tx, familyId: string): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    select target_child_id as id from public.deletion_requests
     where family_id = ${familyId} and target_child_id is not null
       and status in ('requested', 'processing')`;
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------------------------

async function build(tx: Tx, row: ExportRow, setId: string | undefined, now: Date): Promise<Built> {
  // A child-specific export is never built once that child's deletion was requested (spec P4).
  if (
    row.child_id !== null &&
    (await childrenBeingDeleted(tx, row.family_id)).includes(row.child_id)
  ) {
    throw new PermanentExportFailure('CHILD_DELETION_PENDING');
  }
  switch (row.kind) {
    case 'review_questions_pdf': {
      const sets = await reviewSets(tx, row, setId);
      return {
        bytes: renderQuestionsPdf(sets, await loadQuestions(tx, row, sets)),
        contentType: 'application/pdf',
        ext: 'pdf',
      };
    }
    case 'review_answer_key_pdf': {
      const sets = await reviewSets(tx, row, setId);
      return {
        bytes: renderAnswerKeyPdf(sets, await loadAnswerKey(tx, row, sets)),
        contentType: 'application/pdf',
        ext: 'pdf',
      };
    }
    case 'progress_csv':
      return {
        bytes: renderProgressCsv(await progressRows(tx, row, now)),
        contentType: 'text/csv',
        ext: 'csv',
      };
    case 'progress_pdf':
      return {
        bytes: renderProgressPdf(await progressRows(tx, row, now)),
        contentType: 'application/pdf',
        ext: 'pdf',
      };
    case 'family_data':
      return {
        bytes: await familyData(tx, row, now),
        contentType: 'application/json',
        ext: 'json',
      };
  }
}

/** Where an export's file goes: deterministic, so a lost answer can always find it again. */
export function exportPath(familyId: string, exportId: string, ext: string): string {
  return `exports/${familyId}/${exportId}.${ext}`;
}

/** Every extension an export kind can produce (the row does not say which until it is built). */
export const EXPORT_EXTENSIONS = ['json', 'pdf', 'csv'] as const;

/**
 * Removes whatever an export may have left in storage at its deterministic paths (JOBS-R2-01): the
 * row's own `storage_path` is not enough, because an attempt whose answer was lost stored bytes
 * without ever recording the path. Never throws: it runs where the outcome is already settled.
 */
export async function removeExportObjects(
  deps: JobDeps,
  familyId: string,
  exportId: string,
): Promise<void> {
  try {
    await deps.providers.storage.remove(
      EXPORT_EXTENSIONS.map((ext) => exportPath(familyId, exportId, ext)),
    );
  } catch {
    deps.log({
      level: 'warn',
      event: 'export_orphan_remove_failed',
      code: 'STORAGE_REMOVE_FAILED',
    });
  }
}

/**
 * JOBS-R2-05: compensation for an `export_build` job that dead-lettered without its handler settling
 * the row (the worker died on the final attempt, so the lease expired, or `markFailed` itself threw).
 * Without it the row stayed `queued` for ever — `purgeExpiredExports` only reads `ready` rows — and
 * the parent's export list said "preparing" indefinitely. Idempotent; a built or expired row is left
 * alone.
 */
export async function settleDeadLetteredExport(deps: JobDeps, job: JobRow): Promise<void> {
  const parsed = payloadSchema.safeParse(job.payload);
  if (!parsed.success || !job.family_id) return;
  const familyId = job.family_id;
  const rows = await deps.db.asService(
    (tx) => tx<{ id: string }[]>`
      update public.data_exports set status = 'failed'
       where id = ${parsed.data.exportId} and family_id = ${familyId} and status = 'queued'
      returning id`,
  );
  if (rows.length === 0) return;
  deps.log({ level: 'error', event: 'export_failed', code: 'DEAD_LETTER' });
  await removeExportObjects(deps, familyId, parsed.data.exportId);
}

/** Marks a still-queued export failed. Returns false when the row moved on (another worker built it). */
async function markFailed(deps: JobDeps, row: ExportRow, code: string): Promise<boolean> {
  const rows = await deps.db.asService(
    (tx) => tx<{ id: string }[]>`
      update public.data_exports set status = 'failed'
       where id = ${row.id} and family_id = ${row.family_id} and status = 'queued'
      returning id`,
  );
  if (rows.length === 0) return false;
  deps.log({ level: 'error', event: 'export_failed', code });
  return true;
}

export function createExportBuildHandler(options: ExportBuildOptions = {}): JobHandler {
  return async (deps: JobDeps, job: JobRow) => {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success || !job.family_id) {
      deps.log({ level: 'error', event: 'export_invalid_job', code: 'INVALID_JOB' });
      return;
    }
    const { exportId, setId } = parsed.data;
    const [row] = await deps.db.asService(
      (tx) => tx<ExportRow[]>`
        select e.id, e.family_id, e.kind, e.child_id, e.status from public.data_exports e
          join public.families f on f.id = e.family_id and f.deleted_at is null
         where e.id = ${exportId} and e.family_id = ${job.family_id}`,
    );
    if (!row || row.status !== 'queued') return; // built already, expired, or the family is gone
    const now = deps.clock();
    let built: Built;
    try {
      built = await deps.db.asService((tx) => build(tx, row, setId, now));
    } catch (error) {
      if (error instanceof PermanentExportFailure) {
        await markFailed(deps, row, error.code);
        return;
      }
      if (job.attempts >= job.max_attempts) {
        await markFailed(deps, row, 'BUILD_FAILED');
        return;
      }
      throw new RetryableExportFailure('BUILD_FAILED', { cause: error });
    }
    const path = exportPath(row.family_id, row.id, built.ext);
    const upload = options.upload ?? storageUploader(deps.providers.storage);
    try {
      await upload(path, built.bytes, built.contentType);
    } catch (error) {
      if (job.attempts >= job.max_attempts) {
        // Only when this call is the one that failed the row: a row another worker built meanwhile
        // is 'ready' and its file must stay.
        if (await markFailed(deps, row, 'UPLOAD_FAILED')) {
          // The bytes may be in storage from an attempt whose answer was lost: no orphan is left
          // behind for a row that will never be downloaded (JOBS-R2-01).
          await removeExportObjects(deps, row.family_id, row.id);
        }
        return;
      }
      throw error instanceof Error ? error : new RetryableExportFailure('UPLOAD_FAILED');
    }
    await deps.db.asService(
      (tx) => tx`
        update public.data_exports
           set status = 'ready', storage_path = ${path}, expires_at = ${new Date(now.getTime() + EXPORT_TTL_DAYS * DAY_MS)}
         where id = ${row.id} and family_id = ${row.family_id} and status = 'queued'`,
    );
    deps.log({ level: 'info', event: 'export_ready', code: row.kind });
  };
}
