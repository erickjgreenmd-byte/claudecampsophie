import { z } from 'zod';
import {
  checkChildDataGate,
  dataEnvelope,
  imagePart,
  PROMPTS,
  PROPOSED_STAGE_LIMITS,
  runStage,
  type AgeBand,
  type AttemptRecord,
  type CoachingPacket,
  type ExtractionOutput,
  type GradingOutput,
  type InputPart,
  type PromptDefinition,
  type ResponsesClient,
  type VerificationOutput,
} from '@pencillift/ai';
import { guardChildContent, type ProtectedAnswer } from '@pencillift/domain/answer-guard';
import {
  formatRational,
  gradeObjectiveQuestion,
  parseMathAnswer,
  parseMathAnswerDetailed,
  parseQuantity,
  resolveGrading,
  type AnswerKind,
  type CaptureIssue,
  type DeterministicVerdict,
  type ModelJudgment,
  type ModelVerdict,
  type ObjectiveQuestion,
} from '@pencillift/domain/grading';
import { DEFAULT_RATE_TABLE_2026_09_18 } from '@pencillift/domain/quotas';
import type { Tx } from '../db.ts';
import type { StorageProvider } from '../providers/index.ts';
import { hasVerifiedConsent } from '../services/consent.ts';
import { ImageFormatError, stripImageMetadata } from '../services/image-metadata.ts';
import type { JobDeps, JobHandler, JobRow } from './dispatcher.ts';

/**
 * Homework scan processing (spec P5, P6, P12; AC_CAPTURE_*, AC_GRADING_*). One durable job per
 * finalized scan (or per parent transcription correction) runs:
 *
 *   extraction (images → typed questions)  → deterministic checks + private grading
 *   → independent verification → resolution → leak-guarded child coaching → usage commit.
 *
 * Every write is idempotent (upserts keyed by assignment/page/question, unique attempt keys), so a
 * crash at any point is repaired by the job retry. AI calls never run inside a DB transaction.
 * Child-facing text is released only after the answer guard passes; otherwise a reviewed template
 * is shown. Nothing here logs homework text, answers or child identifiers.
 */

export const GRADER_VERSION = 'scan.v1';
export const GUARD_VERSION = 'answer-guard.v1';

/** Advisory mapping of model-reported confidence (spec P5: never a calibrated guarantee). */
const CONFIDENCE: Readonly<Record<'low' | 'medium' | 'high', number>> = {
  low: 0.25,
  medium: 0.6,
  high: 0.9,
};

/** Page issues that mean "take the picture again" rather than guessing (spec P5). */
const RESCAN_PAGE_ISSUES = new Set(['blurry', 'glare', 'rotated', 'cut_off', 'not_homework']);

/** Reviewed fallback when a coaching packet fails validation (spec P6: never show unchecked output). */
export const TEMPLATE_FALLBACK =
  "Let's look at this one again. Read the question slowly, check each step, and try once more. If you're stuck, ask a grown-up to help.";

const payloadSchema = z.object({
  assignmentId: z.uuid(),
  mode: z.enum(['initial', 'recheck']).default('initial'),
  reservationId: z.uuid().optional(),
  questionIds: z.array(z.uuid()).max(200).optional(),
});

type RateTable = typeof DEFAULT_RATE_TABLE_2026_09_18;

export interface ScanProcessOptions {
  readonly ai: ResponsesClient;
  /** Reads a private homework object; bytes are sent inline, never as a storage URL. */
  readonly readObject: (storagePath: string) => Promise<Uint8Array>;
  readonly rates?: RateTable;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** A failure that retrying cannot fix: the scan ends in failed_final and its allowance is released. */
class PermanentFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PermanentFailure';
  }
}

/** A retryable failure with a payload-free code recorded on the assignment. */
class RetryableFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RetryableFailure';
  }
}

/** The assignment moved underneath us (deleted, cancelled): stop without writing anything. */
class Superseded extends Error {
  constructor() {
    super('superseded');
    this.name = 'Superseded';
  }
}

interface AssignmentCtx {
  readonly id: string;
  readonly familyId: string;
  readonly childId: string;
  status: string;
  readonly ageBand: AgeBand;
  readonly gradeLevel: number;
}

interface QuestionRow {
  readonly id: string;
  readonly page_number: number;
  readonly question_number: string;
  readonly prompt: string;
  readonly answer: string | null;
  readonly answer_kind: AnswerKind;
  readonly subject_key: string;
  readonly skill: string;
  readonly uncertainty: 'low' | 'medium' | 'high' | null;
  readonly corrected_by: string | null;
}

interface Graded {
  readonly question: QuestionRow;
  readonly final:
    'correct' | 'incorrect' | 'unresolved' | 'unanswered' | 'rubric' | 'needs_parent_review';
  readonly route: 'deterministic' | 'agreement' | 'escalated' | 'parent_review';
  readonly disagreement: boolean;
  readonly private: GradingOutput['results'][number] | null;
  readonly provenance: Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------------------------

/**
 * An answer key computed WITHOUT any model: a printed prompt that is a bare arithmetic expression
 * ("3/4 + 1/8 =", "12 × 7 = ___") is evaluated with the safe rational parser. Anything else
 * (words, variables, ambiguous notation) returns null and grading falls back to model agreement.
 */
export function computePromptKey(prompt: string): string | null {
  let text = prompt.trim();
  text = text.replace(/^\(?[0-9]{1,3}[.)]\s+/, ''); // leading "4." / "4)" numbering
  text = text.replace(/\s*=\s*(?:\?|_+|□|\.{2,})?\s*$/u, '').replace(/\?\s*$/, '');
  if (text.length === 0 || text.length > 120) return null;
  if (!/^[0-9\s+\-−–×x*÷/:().,^²³]+$/u.test(text)) return null;
  if (!/[0-9]\s*[+\-−–×x*÷/:^]\s*[0-9(]/u.test(text) && !/[²³]/u.test(text)) return null;
  const parsed = parseMathAnswerDetailed(text.replace(/:/g, '÷'));
  if (!parsed.ok || parsed.value.form.kind !== 'expression') return null;
  return formatRational(parsed.value.value);
}

function isBlank(answer: string | null): boolean {
  return answer === null || answer.trim().length === 0;
}

/** Builds a deterministic question from a key; null when the key cannot be represented safely. */
export function objectiveQuestion(
  kind: AnswerKind,
  studentAnswer: string,
  key: string,
  captureIssues: readonly CaptureIssue[],
): ObjectiveQuestion | null {
  const base = { studentAnswer, captureIssues };
  switch (kind) {
    case 'numeric':
      return parseMathAnswer(key).ok ? { ...base, kind, expected: { value: key } } : null;
    case 'quantity': {
      const q = parseQuantity(key);
      if (!q.ok) return null;
      const value = formatRational(q.value.value);
      // A unitless key is compared as a plain number.
      return q.value.unit === null
        ? { ...base, kind: 'numeric', expected: { value } }
        : { ...base, kind, expected: { value, unit: q.value.unit } };
    }
    case 'multiple_choice': {
      const letter = key.trim().replace(/^\(?([A-Za-z])[).:]?$/, '$1');
      return /^[A-Za-z]$/.test(letter)
        ? { ...base, kind, expected: { letters: [letter.toUpperCase()] } }
        : null;
    }
    case 'spelling':
      return key.trim().length > 0 ? { ...base, kind, expected: { target: key.trim() } } : null;
    case 'division_remainder':
    case 'exact_text':
    case 'open_response':
    case 'writing':
      // Division keys need a structured quotient/remainder; text answers need semantic judgment.
      // These stay with model agreement.
      return null;
  }
}

function decisive(verdict: string): verdict is 'correct' | 'incorrect' {
  return verdict === 'correct' || verdict === 'incorrect';
}

function modelVerdict(verdict: string): ModelVerdict {
  return decisive(verdict) ? verdict : 'unresolved';
}

/** Protected answers for the leak guard; always at least the literal key as text. */
export function protectedAnswers(kind: AnswerKind, key: string): ProtectedAnswer[] {
  const trimmed = key.trim();
  if (trimmed.length === 0) return [];
  const answers: ProtectedAnswer[] = [{ kind: 'text', value: trimmed.slice(0, 200) }];
  const numeric = parseMathAnswer(trimmed);
  const quantity = numeric.ok ? null : parseQuantity(trimmed);
  const value = numeric.ok ? numeric.value : quantity?.ok ? quantity.value.value : null;
  if (value !== null) answers.push({ kind: 'numeric', value: formatRational(value) });
  if (kind === 'division_remainder') {
    const quotient = /^\s*(\d+)/.exec(trimmed)?.[1];
    if (quotient !== undefined) answers.push({ kind: 'numeric', value: quotient });
  }
  if (kind === 'multiple_choice') {
    const letter = trimmed.replace(/^\(?([A-Za-z])[).:]?$/, '$1');
    if (/^[A-Za-z]$/.test(letter))
      answers.push({ kind: 'multiple_choice', value: letter.toUpperCase() });
  }
  if (kind === 'spelling' && /^[\p{L}'-]+$/u.test(trimmed))
    answers.push({ kind: 'spelling', value: trimmed });
  return answers;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const FEEDBACK_KIND: Readonly<
  Record<
    CoachingPacket['steps'][number]['kind'],
    'hint' | 'method_step' | 'analogous_example' | 'encouragement'
  >
> = {
  concept: 'method_step',
  next_step_question: 'method_step',
  hint: 'hint',
  analogous_example: 'analogous_example',
  encouragement: 'encouragement',
};

/** Reads a private object through a short-lived signed URL (Supabase Storage in production). */
export function storageReader(
  storage: StorageProvider,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20_000,
): (path: string) => Promise<Uint8Array> {
  return async (path) => {
    const { url } = await storage.createSignedReadUrl(path, 60);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`storage read failed with HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };
}

// ---------------------------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------------------------

export function createScanProcessHandler(options: ScanProcessOptions): JobHandler {
  const rates = options.rates ?? DEFAULT_RATE_TABLE_2026_09_18;

  return async (deps, job) => {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success || !job.family_id) {
      deps.log({ level: 'error', event: 'scan_invalid_job', code: 'INVALID_JOB' });
      return; // a malformed job can never succeed; do not burn retries on it
    }
    const payload = parsed.data;
    const ctx = await loadAssignment(deps, job.family_id, payload.assignmentId);
    if (!ctx) return; // deleted/purged family or assignment: nothing to do

    const run = new ScanRun(
      deps,
      options,
      rates,
      job,
      ctx,
      payload.mode,
      payload.reservationId ?? null,
    );
    try {
      if (payload.mode === 'recheck') await run.recheck(payload.questionIds ?? []);
      else await run.initial();
    } catch (error) {
      if (error instanceof Superseded) return;
      await run.fail(error);
    } finally {
      await run.recordUsage();
    }
  };
}

async function loadAssignment(
  deps: JobDeps,
  familyId: string,
  assignmentId: string,
): Promise<AssignmentCtx | null> {
  const [row] = await deps.db.asService(
    (tx) => tx<
      {
        id: string;
        family_id: string;
        child_id: string;
        status: string;
        age_band: AgeBand;
        grade_level: number;
      }[]
    >`
      select a.id, a.family_id, a.child_id, a.status, c.age_band, c.grade_level
        from public.assignments a
        join public.child_profiles c on c.id = a.child_id and c.family_id = a.family_id
        join public.families f on f.id = a.family_id and f.deleted_at is null
       where a.id = ${assignmentId} and a.family_id = ${familyId}
    `,
  );
  return row
    ? {
        id: row.id,
        familyId: row.family_id,
        childId: row.child_id,
        status: row.status,
        ageBand: row.age_band,
        gradeLevel: row.grade_level,
      }
    : null;
}

class ScanRun {
  private readonly usage: AttemptRecord[] = [];

  constructor(
    private readonly deps: JobDeps,
    private readonly options: ScanProcessOptions,
    private readonly rates: RateTable,
    private readonly job: JobRow,
    private readonly ctx: AssignmentCtx,
    private readonly mode: 'initial' | 'recheck',
    private readonly reservationId: string | null,
  ) {}

  // ---- state ---------------------------------------------------------------------------------

  /** Compare-and-set transition; a concurrent change (deletion, cancel) stops the run. */
  private async transition(to: string, errorCode: string | null = null): Promise<void> {
    const from = this.ctx.status;
    const rows = await this.deps.db.asService(
      (tx) => tx`
        update public.assignments
           set status = ${to}, error_code = ${errorCode},
               processing_attempts = processing_attempts + ${to === 'extracting' ? 1 : 0}
         where id = ${this.ctx.id} and family_id = ${this.ctx.familyId} and status = ${from}
        returning id
      `,
    );
    if (rows.length === 0) throw new Superseded();
    this.ctx.status = to;
  }

  private async settleReservation(
    outcome: 'committed' | 'unreadable' | 'failed_final',
  ): Promise<void> {
    if (!this.reservationId) return;
    await this.deps.db.asService(
      (tx) => tx`
        update public.usage_reservations
           set status = ${outcome === 'committed' ? 'committed' : 'released'},
               release_reason = ${outcome === 'committed' ? null : outcome}
         where id = ${this.reservationId} and family_id = ${this.ctx.familyId} and status = 'reserved'
      `,
    );
  }

  /** Brings a new, retried or crashed initial run to `extracting`. */
  private async enterExtracting(): Promise<boolean> {
    const s = this.ctx.status;
    if (s === 'extracting' || s === 'checking' || s === 'verifying') {
      // A previous worker died mid-run; restart cleanly (all writes below are idempotent).
      await this.transition('failed_retryable', 'RESTARTED');
    }
    if (this.ctx.status === 'failed_retryable') await this.transition('queued');
    if (this.ctx.status !== 'queued') return false; // ready, cancelled, deleted, ... : done
    await this.transition('extracting');
    return true;
  }

  async fail(error: unknown): Promise<void> {
    const permanent = error instanceof PermanentFailure;
    const code = permanent || error instanceof RetryableFailure ? error.code : 'PROCESSING_ERROR';
    const final = permanent || this.job.attempts >= this.job.max_attempts;
    const active = () => ['extracting', 'checking', 'verifying'].includes(this.ctx.status);
    try {
      if (final && this.mode === 'recheck') {
        // A failed recheck keeps the earlier results; a grown-up reviews instead of losing them.
        if (this.ctx.status === 'checking' || this.ctx.status === 'verifying')
          await this.transition('needs_parent_review', code);
      } else if (final) {
        if (this.ctx.status === 'queued') await this.transition('extracting');
        if (active()) await this.transition('failed_final', code);
        await this.settleReservation('failed_final');
      } else if (this.mode === 'initial' && active()) {
        await this.transition('failed_retryable', code);
      }
    } catch (transitionError) {
      if (!(transitionError instanceof Superseded)) throw transitionError;
    }
    if (final) {
      this.deps.log({ level: 'error', event: 'scan_failed_final', code });
      return; // nothing left to retry
    }
    this.deps.log({ level: 'warn', event: 'scan_retry', code });
    throw error instanceof Error ? error : new Error(code);
  }

  async recordUsage(): Promise<void> {
    if (this.usage.length === 0) return;
    const rows = this.usage.map((a) => ({
      family_id: this.ctx.familyId,
      child_id: this.ctx.childId,
      stage: a.stage,
      model_id: a.modelId,
      prompt_version: a.promptVersion,
      attempt: a.attempt,
      status: a.status,
      input_tokens: a.inputTokens,
      cached_input_tokens: a.cachedInputTokens,
      output_tokens: a.outputTokens,
      latency_ms: a.latencyMs,
      cost_micros: a.costMicros,
      rate_table_version: a.rateTableVersion,
    }));
    this.usage.length = 0;
    try {
      await this.deps.db.asService((tx) => tx`insert into public.ai_usage_events ${tx(rows)}`);
    } catch {
      // Metering must never hide the processing outcome; the gap is visible in the logs.
      this.deps.log({ level: 'error', event: 'ai_usage_record_failed', code: 'METERING' });
    }
  }

  // ---- gates ---------------------------------------------------------------------------------

  private async assertMayProcess(): Promise<void> {
    const { config } = this.deps;
    const consent = await this.deps.db.asService((tx) =>
      hasVerifiedConsent(tx, this.ctx.familyId, {
        allowTestProvider: config.environment !== 'production',
      }),
    );
    if (!consent) throw new PermanentFailure('CONSENT_REQUIRED');
    const gate = checkChildDataGate({
      containsChildPersonalData: true,
      ageBand: this.ctx.ageBand,
      zdrEvidence: config.zdrEvidence,
      environment: config.environment,
      providerIsMock: this.options.ai.isMock,
      now: this.deps.clock(),
    });
    if (!gate.ok) throw new PermanentFailure('AI_NOT_AVAILABLE');
    const month = this.deps.clock().toISOString().slice(0, 7);
    const [budget] = await this.deps.db.asService(
      (tx) => tx<{ budget_micros: string; spent: string }[]>`
        select b.budget_micros::text,
               coalesce((select sum(cost_micros) from public.ai_usage_events
                          where created_at >= date_trunc('month', ${this.deps.clock()}::timestamptz)), 0)::text as spent
          from public.spend_budgets b where b.scope = 'global' and b.period_key = ${month}
      `,
    );
    // Application-enforced ceiling (spec F4): provider alerts lag, so stop before spending.
    if (budget && BigInt(budget.spent) >= BigInt(budget.budget_micros)) {
      throw new RetryableFailure('SPEND_CEILING');
    }
  }

  private async stage<S extends z.ZodType>(
    prompt: PromptDefinition<S>,
    input: readonly InputPart[],
    estimatedInputTokens: number,
  ): Promise<z.infer<S>> {
    const out = await runStage<S>({
      prompt,
      input,
      client: this.options.ai,
      limits: PROPOSED_STAGE_LIMITS[prompt.stage],
      rates: this.rates,
      gate: {
        containsChildPersonalData: true,
        ageBand: this.ctx.ageBand,
        zdrEvidence: this.deps.config.zdrEvidence,
        environment: this.deps.config.environment,
        now: this.deps.clock(),
      },
      metadata: { stage: prompt.stage },
      estimatedInputTokens,
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
    });
    this.usage.push(...out.attempts);
    if (out.result.ok) return out.result.value;
    const code = out.result.error.code;
    if (code === 'CHILD_DATA_GATE') throw new PermanentFailure('AI_NOT_AVAILABLE');
    if (code === 'STAGE_LIMIT' || code === 'UNKNOWN_MODEL') throw new PermanentFailure(code);
    throw new RetryableFailure(`${prompt.stage.toUpperCase()}_${code}`);
  }

  // ---- initial run ---------------------------------------------------------------------------

  async initial(): Promise<void> {
    if (!(await this.enterExtracting())) return;
    await this.assertMayProcess();

    const pages = await this.deps.db.asService(
      (tx) => tx<{ id: string; page_number: number; storage_path: string; mime_type: string }[]>`
        select id, page_number, storage_path, mime_type from public.source_pages
         where assignment_id = ${this.ctx.id} and family_id = ${this.ctx.familyId} and deleted_at is null
         order by page_number
      `,
    );
    if (pages.length === 0) throw new PermanentFailure('NO_PAGES');
    // HEIC and PDF need the isolated converter (spec P5), which is not deployed yet.
    if (pages.some((p) => p.mime_type !== 'image/jpeg' && p.mime_type !== 'image/png')) {
      throw new PermanentFailure('FORMAT_NEEDS_CONVERSION');
    }
    const images: InputPart[] = [];
    for (const page of pages) {
      let bytes: Uint8Array;
      try {
        bytes = await this.options.readObject(page.storage_path);
      } catch {
        throw new RetryableFailure('STORAGE_READ_FAILED');
      }
      let clean: Uint8Array;
      try {
        // Location/camera metadata never leaves our systems (spec P4); content that is not the
        // declared image type is never forwarded "as is".
        clean = stripImageMetadata(bytes, page.mime_type);
      } catch (error) {
        if (!(error instanceof ImageFormatError)) throw error;
        await this.transition('needs_rescan', 'IMAGE_UNREADABLE');
        await this.settleReservation('unreadable');
        return;
      }
      images.push(imagePart(page.mime_type as 'image/jpeg' | 'image/png', toBase64(clean)));
    }

    const extraction = await this.stage<typeof PROMPTS.extraction.outputSchema>(
      PROMPTS.extraction,
      [
        dataEnvelope({
          pageNumbers: pages.map((p) => p.page_number),
          gradeLevel: this.ctx.gradeLevel,
        }),
        ...images,
      ],
      1_500 * pages.length + 800,
    );

    if (this.needsRescan(extraction, pages.length)) {
      await this.transition('needs_rescan', 'RETAKE_REQUESTED');
      // An unreadable scan never permanently consumes allowance (spec P11).
      await this.settleReservation('unreadable');
      return;
    }
    const pageIds = new Map(pages.map((p) => [p.page_number, p.id]));
    const missingPassage = new Set(
      extraction.pages.filter((p) => p.issues.includes('missing_passage')).map((p) => p.pageNumber),
    );
    await this.storeQuestions(extraction, pageIds);
    const questions = await this.loadQuestions();
    if (questions.length === 0) {
      await this.transition('needs_parent_review', 'NO_QUESTIONS_FOUND');
      await this.settleReservation('committed');
      return;
    }
    await this.transition('checking');
    const graded = await this.grade(questions, missingPassage);
    await this.finish(graded);
    await this.settleReservation('committed');
  }

  private needsRescan(extraction: ExtractionOutput, pageCount: number): boolean {
    const reported = new Set(extraction.pages.map((p) => p.pageNumber));
    if (reported.size < pageCount) return true; // a page the model could not account for
    return extraction.pages.some(
      (p) => !p.readable || p.issues.some((issue) => RESCAN_PAGE_ISSUES.has(issue)),
    );
  }

  private async storeQuestions(
    extraction: ExtractionOutput,
    pageIds: ReadonlyMap<number, string>,
  ): Promise<void> {
    const seen = new Set<string>();
    await this.deps.db.asService(async (tx) => {
      for (const q of extraction.questions) {
        const pageId = pageIds.get(q.pageNumber);
        const key = `${q.pageNumber}:${q.questionNumber}`;
        if (!pageId || seen.has(key)) continue; // unknown page or duplicate label: keep the first
        seen.add(key);
        await tx`
          insert into public.extracted_questions
            (assignment_id, family_id, child_id, page_id, question_number, bounding_box, prompt_text,
             student_answer_text, answer_kind, subject_key, skill, grade_estimate, uncertainty)
          values (${this.ctx.id}, ${this.ctx.familyId}, ${this.ctx.childId}, ${pageId}, ${q.questionNumber},
                  ${q.boundingBox ? JSON.stringify(q.boundingBox) : null}::text::jsonb, ${q.promptText},
                  ${q.studentAnswerText}, ${q.answerKind}, ${q.subject}, ${q.skill}, ${q.gradeEstimate},
                  ${q.uncertainty})
          on conflict (assignment_id, page_id, question_number) do update
            set prompt_text = excluded.prompt_text, student_answer_text = excluded.student_answer_text,
                answer_kind = excluded.answer_kind, subject_key = excluded.subject_key,
                skill = excluded.skill, grade_estimate = excluded.grade_estimate,
                uncertainty = excluded.uncertainty, bounding_box = excluded.bounding_box
            where public.extracted_questions.corrected_at is null
        `;
      }
    });
  }

  private async loadQuestions(ids?: readonly string[]): Promise<QuestionRow[]> {
    return this.deps.db.asService(
      (tx: Tx) => tx<QuestionRow[]>`
        select q.id, p.page_number, q.question_number,
               coalesce(q.corrected_prompt_text, q.prompt_text) as prompt,
               coalesce(q.corrected_student_answer_text, q.student_answer_text) as answer,
               q.answer_kind, q.subject_key, q.skill, q.uncertainty, q.corrected_by
          from public.extracted_questions q
          join public.source_pages p on p.id = q.page_id
         where q.assignment_id = ${this.ctx.id} and q.family_id = ${this.ctx.familyId}
           and (${ids === undefined}::boolean or q.id = any(${ids ? [...ids] : []}::uuid[]))
         order by p.page_number, q.created_at, q.question_number
      `,
    );
  }

  // ---- grading -------------------------------------------------------------------------------

  private async grade(
    questions: readonly QuestionRow[],
    missingPassage: ReadonlySet<number>,
  ): Promise<Graded[]> {
    // Synthetic refs: printed numbers repeat across pages, so the model never keys on them.
    const refs = questions.map((q, i) => ({ ref: `q${i + 1}`, q }));
    const grading = await this.stage<typeof PROMPTS.grading.outputSchema>(
      PROMPTS.grading,
      [
        dataEnvelope({
          gradeLevel: this.ctx.gradeLevel,
          pagesMissingSourcePassage: [...missingPassage],
          questions: refs.map(({ ref, q }) => ({
            questionNumber: ref,
            prompt: q.prompt,
            studentAnswer: q.answer,
            answerKind: q.answer_kind,
            subject: q.subject_key,
          })),
        }),
      ],
      300 * questions.length + 600,
    );
    const primaryByRef = new Map(grading.results.map((r) => [r.questionNumber, r]));
    if (this.ctx.status === 'checking') await this.transition('verifying');

    const pending: { ref: string; q: QuestionRow; primary: GradingOutput['results'][number] }[] =
      [];
    const early: Graded[] = [];
    for (const { ref, q } of refs) {
      const primary = primaryByRef.get(ref) ?? null;
      if (isBlank(q.answer)) {
        early.push(
          this.graded(q, 'unanswered', 'deterministic', false, primary, { reason: 'BLANK' }),
        );
      } else if (q.answer_kind === 'writing') {
        // Writing gets rubric feedback only; it is never forced into right/wrong (spec P5).
        early.push(
          this.graded(q, 'rubric', 'deterministic', false, primary, {
            reason: 'RUBRIC_FEEDBACK_ONLY',
          }),
        );
      } else if (primary === null) {
        early.push(
          this.graded(q, 'needs_parent_review', 'parent_review', false, null, {
            reason: 'NO_MODEL_RESULT',
          }),
        );
      } else {
        pending.push({ ref, q, primary });
      }
    }

    let verification: VerificationOutput | null = null;
    if (pending.length > 0) {
      try {
        verification = await this.stage<typeof PROMPTS.verification.outputSchema>(
          PROMPTS.verification,
          [
            dataEnvelope({
              gradeLevel: this.ctx.gradeLevel,
              questions: pending.map(({ ref, q, primary }) => ({
                questionNumber: ref,
                prompt: q.prompt,
                studentAnswer: q.answer,
                answerKind: q.answer_kind,
                proposedVerdict: primary.verdict,
              })),
            }),
          ],
          250 * pending.length + 500,
        );
      } catch (error) {
        // Without an independent check nothing is accepted: those items go to a grown-up.
        if (!(error instanceof RetryableFailure)) throw error;
        verification = null;
      }
    }
    const verifierByRef = new Map((verification?.results ?? []).map((r) => [r.questionNumber, r]));

    const resolved = pending.map(({ ref, q, primary }) => {
      const capture: CaptureIssue[] = missingPassage.has(q.page_number)
        ? ['missing_passage']
        : q.uncertainty === 'high'
          ? ['answer_source_uncertain']
          : [];
      // Model-free key (bare arithmetic prompt): decisive evidence on its own (AC_GRADING_04).
      const promptKey = q.answer_kind === 'numeric' ? computePromptKey(q.prompt) : null;
      let deterministic: DeterministicVerdict | undefined;
      let deterministicReason: string | null = null;
      if (promptKey !== null) {
        const outcome = gradeObjectiveQuestion({
          kind: 'numeric',
          studentAnswer: q.answer ?? '',
          expected: { value: promptKey },
          captureIssues: capture,
        });
        deterministicReason = outcome.reason;
        if (decisive(outcome.verdict)) deterministic = outcome.verdict;
      }
      // The model's key compared with exact arithmetic (equivalent fractions, units, spelling
      // variants): replaces the model's own comparison, but is still model evidence, not proof.
      const keyed = objectiveQuestion(
        q.answer_kind,
        q.answer ?? '',
        primary.correctAnswer,
        capture,
      );
      const keyedOutcome = keyed ? gradeObjectiveQuestion(keyed) : null;
      const primaryVerdict: ModelVerdict =
        keyedOutcome && decisive(keyedOutcome.verdict)
          ? keyedOutcome.verdict
          : modelVerdict(primary.verdict);
      const primaryJudgment: ModelJudgment = {
        verdict: capture.length > 0 ? 'unresolved' : primaryVerdict,
        confidence: CONFIDENCE[primary.confidence],
      };
      const v = verifierByRef.get(ref);
      const verifier: ModelJudgment | undefined = v
        ? {
            verdict: capture.length > 0 ? 'unresolved' : modelVerdict(v.verdict),
            confidence: CONFIDENCE[v.confidence],
          }
        : undefined;
      const resolution = resolveGrading({
        ...(deterministic ? { deterministic } : {}),
        primary: primaryJudgment,
        ...(verifier ? { verifier } : {}),
        // Escalation to a stronger model is not wired yet; unsettled items go to parent review.
        escalationBudgetRemaining: 0,
      });
      return this.graded(q, resolution.final, resolution.route, resolution.disagreement, primary, {
        deterministic: deterministic ?? null,
        deterministicReason,
        modelKeyCheck: keyedOutcome?.reason ?? null,
        // The model's own verdict is kept for audit; exact comparison against its key replaces it.
        modelVerdict: primary.verdict,
        primary: primaryJudgment.verdict,
        verifier: verifier?.verdict ?? null,
        verifierAvailable: verification !== null,
        capture,
      });
    });
    return [...early, ...resolved];
  }

  private graded(
    question: QuestionRow,
    final: Graded['final'],
    route: Graded['route'],
    disagreement: boolean,
    primary: GradingOutput['results'][number] | null,
    detail: Record<string, unknown>,
  ): Graded {
    return {
      question,
      final,
      route,
      disagreement,
      private: primary,
      provenance: {
        graderVersion: GRADER_VERSION,
        prompts: [
          PROMPTS.extraction.version,
          PROMPTS.grading.version,
          PROMPTS.verification.version,
        ],
        ...detail,
      },
    };
  }

  // ---- results, feedback, evidence ------------------------------------------------------------

  private async finish(graded: readonly Graded[], unsettledElsewhere = false): Promise<void> {
    await this.deps.db.asService(async (tx) => {
      for (const g of graded) {
        if (g.private) {
          await tx`
            insert into private.question_solutions
              (question_id, family_id, correct_answer, worked_solution, rubric, misconception, evidence,
               grading_provenance, grader_version)
            values (${g.question.id}, ${this.ctx.familyId}, ${g.private.correctAnswer}, ${g.private.workedSolution},
                    ${g.private.rubric ? JSON.stringify(g.private.rubric) : null}::text::jsonb, ${g.private.misconception},
                    ${JSON.stringify({ summary: g.private.evidence })}::text::jsonb,
                    ${JSON.stringify(g.provenance)}::text::jsonb, ${GRADER_VERSION})
            on conflict (question_id) do update
              set correct_answer = excluded.correct_answer, worked_solution = excluded.worked_solution,
                  rubric = excluded.rubric, misconception = excluded.misconception, evidence = excluded.evidence,
                  grading_provenance = excluded.grading_provenance, grader_version = excluded.grader_version,
                  updated_at = now()
          `;
        }
        await tx`
          insert into public.question_results (question_id, family_id, child_id, verdict, route, disagreement, grader_version)
          values (${g.question.id}, ${this.ctx.familyId}, ${this.ctx.childId}, ${g.final}, ${g.route}, ${g.disagreement}, ${GRADER_VERSION})
          on conflict (question_id) do update
            set verdict = excluded.verdict, route = excluded.route, disagreement = excluded.disagreement,
                grader_version = excluded.grader_version, graded_at = now()
        `;
        await this.recordAttempt(tx, g);
      }
    });

    for (const g of graded) {
      if (g.final === 'incorrect' && g.private) await this.coach(g);
    }

    const needsReview =
      unsettledElsewhere ||
      graded.some((g) => g.final === 'needs_parent_review' || g.final === 'unresolved');
    await this.transition(needsReview ? 'needs_parent_review' : 'ready');
  }

  /** First-attempt evidence (spec P7); a regrade after a correction is an override, never a rewrite. */
  private async recordAttempt(tx: Tx, g: Graded): Promise<void> {
    const correctness =
      g.final === 'correct' || g.final === 'incorrect'
        ? g.final
        : g.final === 'needs_parent_review' || g.final === 'unresolved'
          ? 'unresolved'
          : null;
    if (correctness === null) return; // blank or rubric-only work is not skill evidence
    const [existing] = await tx<{ id: string; correctness: string }[]>`
      select id, correctness from public.attempts
       where question_instance_id = ${g.question.id} and attempt_number = 1
    `;
    if (!existing) {
      await tx`
        insert into public.attempts (family_id, child_id, question_instance_id, source, subject_key, skill,
                                     attempt_number, correctness, grader_version, idempotency_key, occurred_at)
        values (${this.ctx.familyId}, ${this.ctx.childId}, ${g.question.id}, 'homework', ${g.question.subject_key},
                ${g.question.skill}, 1, ${correctness}, ${GRADER_VERSION}, ${`homework:${g.question.id}:1`}, ${this.deps.clock()})
        on conflict (idempotency_key) do nothing
      `;
      return;
    }
    const [latest] = await tx<{ correctness: string }[]>`
      select correctness from public.attempt_overrides where attempt_id = ${existing.id}
       order by created_at desc limit 1
    `;
    const current = latest?.correctness ?? existing.correctness;
    if (current !== correctness && g.question.corrected_by) {
      await tx`
        insert into public.attempt_overrides (attempt_id, family_id, correctness, reason, overridden_by)
        values (${existing.id}, ${this.ctx.familyId}, ${correctness}, 'Regraded after a parent transcription correction',
                ${g.question.corrected_by})
      `;
    }
  }

  private async coach(g: Graded): Promise<void> {
    const key = g.private?.correctAnswer ?? '';
    const answers = protectedAnswers(g.question.answer_kind, key);
    const [existing] = await this.deps.db.asService(
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from public.child_feedback f
          join public.extracted_questions q on q.id = f.question_id
         where f.question_id = ${g.question.id} and f.created_at >= coalesce(q.corrected_at, '-infinity'::timestamptz)
      `,
    );
    if ((existing?.n ?? 0) > 0) return; // already coached for this transcription (crash replay)

    let rows: { kind: string; body: string }[] | null = null;
    if (answers.length > 0) {
      try {
        const packet = await this.stage<typeof PROMPTS.coaching.outputSchema>(
          PROMPTS.coaching,
          [
            dataEnvelope({
              gradeLevel: this.ctx.gradeLevel,
              ageBand: this.ctx.ageBand,
              skill: g.question.skill,
              question: g.question.prompt,
              studentAnswer: g.question.answer,
              likelyMisconception: g.private?.misconception ?? null,
              // Given so hints are accurate; the guard below blocks any leak of it.
              answerForTutorOnly: key,
            }),
          ],
          900,
        );
        const decision = guardChildContent({ packet, answers });
        if (decision.decision === 'release') {
          rows = [
            ...packet.steps.map((s) => ({ kind: FEEDBACK_KIND[s.kind], body: s.text })),
            { kind: 'encouragement', body: packet.retryPrompt },
          ];
        } else {
          this.deps.log({
            level: 'warn',
            event: 'coaching_blocked_by_guard',
            code: decision.reasons[0]?.code ?? 'BLOCKED',
          });
        }
      } catch (error) {
        if (!(error instanceof RetryableFailure) && !(error instanceof PermanentFailure))
          throw error;
      }
    }
    // Never unchecked output: a blocked, failed or unguardable packet becomes the reviewed template.
    rows ??= [{ kind: 'template_fallback', body: TEMPLATE_FALLBACK }];
    await this.deps.db.asService(async (tx) => {
      for (const row of rows) {
        await tx`
          insert into public.child_feedback (question_id, family_id, child_id, kind, body, guard_version)
          values (${g.question.id}, ${this.ctx.familyId}, ${this.ctx.childId}, ${row.kind}, ${row.body}, ${GUARD_VERSION})
        `;
      }
    });
  }

  // ---- recheck after a parent correction ------------------------------------------------------

  async recheck(questionIds: readonly string[]): Promise<void> {
    // `verifying` means a previous worker died after grading started; grading is idempotent.
    if (this.ctx.status !== 'checking' && this.ctx.status !== 'verifying') return;
    await this.assertMayProcess();
    const questions = await this.loadQuestions(questionIds.length > 0 ? questionIds : undefined);
    if (questions.length === 0) {
      await this.transition('needs_parent_review', 'NO_QUESTIONS_FOUND');
      return;
    }
    const graded = await this.grade(questions, new Set());
    // Other questions keep their results; the assignment state reflects all of them.
    const ids = new Set(graded.map((g) => g.question.id));
    const others = await this.deps.db.asService(
      (tx) => tx<
        { question_id: string; verdict: string; parent_override_verdict: string | null }[]
      >`
        select r.question_id, r.verdict, r.parent_override_verdict from public.question_results r
          join public.extracted_questions q on q.id = r.question_id
         where q.assignment_id = ${this.ctx.id} and q.family_id = ${this.ctx.familyId}
      `,
    );
    const unsettledElsewhere = others.some(
      (r) =>
        !ids.has(r.question_id) &&
        r.parent_override_verdict === null &&
        (r.verdict === 'needs_parent_review' || r.verdict === 'unresolved'),
    );
    await this.finish(graded, unsettledElsewhere);
  }
}
