import { z } from 'zod';
import {
  checkChildDataGate,
  dataEnvelope,
  PROMPTS,
  PROPOSED_STAGE_LIMITS,
  runStage,
  type AgeBand,
  type AttemptRecord,
  type PracticePersonalization,
  type ResponsesClient,
} from '@pencillift/ai';
import { findForbiddenFields, guardChildContent } from '@pencillift/domain/answer-guard';
import {
  BANK_SUBJECTS,
  bankGrade,
  generateCandidates,
  isBankSubject,
  matchSkills,
  planDailySkills,
  planReviewSkills,
  prerequisiteMap,
  protectedAnswersFor,
  rethemeWordProblem,
  skillLabel,
  validateBankItem,
  validateIntro,
  type AnswerSpec,
  type BankItem,
  type BankSubject,
  type FamilyMaterial,
} from '@pencillift/domain/bank';
import {
  composeDailySet,
  composeThursdayReview,
  validateAttemptEvent,
  type AttemptEvent,
  type DailySetNote,
  type ReviewNote,
} from '@pencillift/domain/learning';
import { DEFAULT_RATE_TABLE_2026_09_18 } from '@pencillift/domain/quotas';
import { screenModelOutput, type SafetyScreen } from '@pencillift/domain/safety';
import {
  addCalendarDays,
  dailyPracticeState,
  dailySetKey,
  isSchedulingZone,
  isoWeekDates,
  localDateOf,
  localDateTimeToUtc,
  planReviewJob,
  planReviewReschedule,
  planTopUp,
  reviewIdempotencyKey,
  reviewReleases,
  reviewWeekKey,
  startOfLocalDay,
  topUpIdempotencyKey,
  weekKeyOfDate,
  type ReviewJobStatus,
  type ReviewRelease,
  type ReviewSchedule,
} from '@pencillift/domain/scheduling';
import type { Tx } from '../db.ts';
import { hasVerifiedConsent } from '../services/consent.ts';
import type { JobDeps, JobHandler, JobRow } from './dispatcher.ts';
import {
  acquireSpendHold,
  releaseSpendHold,
  SpendCeilingReached,
  SpendCeilingUnevaluable,
} from './spend-ceiling.ts';

/**
 * Daily practice, Thursday reviews and late-scan top-ups (spec P7, P8, P9, P12; AC_LEARNING_03..09).
 *
 * Generation is bank-first: candidates come from the validated original bank (plus the family's own
 * spelling lists and passages), selection uses the transparent learning rules, and the set is saved
 * once per idempotency key in ONE transaction (set + child-safe items + private keys). A retried job
 * finds the saved set and does nothing; started or completed sets are never overwritten.
 *
 * Optional AI personalization (one bounded request per set) runs only with a client, a verified
 * consent and the child-data (ZDR) gate. The model never sees answers: it may re-theme word problems
 * (re-rendered by the bank with the same numbers and re-validated) and write one intro line that
 * must pass the leak guard. Anything that fails keeps the bank item unchanged. Every AI attempt is
 * metered. Without a client the bank-only path is the full, honest behavior.
 *
 * Moderation after generation (spec P4; AC_SECURITY_02): every re-themed story and the intro also
 * pass the child-safety screen for model output. A story is grounded in its own bank prompt and an
 * intro in nothing, so a story or intro that brings in any sensitive topic, a companion persona,
 * secrecy or contact request is refused and the reviewed bank item (or no intro) is used. Only a
 * code is logged.
 *
 * Logs carry ids and codes only: never questions, answers, child names or tokens.
 */

export const PRACTICE_GENERATOR_VERSION = 'practice.v1';
export const PRACTICE_GRADER_VERSION = 'practice-grader.v1';
/** Daily sets are generated this long before the parent-selected release time. */
export const DAILY_GENERATION_LEAD_MS = 2 * 3_600_000;
/** Evidence history read for selection (skill summaries use recency weighting). */
export const EVIDENCE_LOOKBACK_DAYS = 90;
/** Instances used in this window are avoided (spec P8 "avoid exact repeats"). */
export const RECENT_ITEM_DAYS = 14;
/** A past release older than this is not generated retroactively. */
export const STALE_RELEASE_MS = 3 * 86_400_000;
/** Decision: an optional top-up is half a review section (at least 4 questions). */
export const TOP_UP_MIN_QUESTIONS = 4;

const DAY_MS = 86_400_000;
const FALLBACK_ZONE = 'America/New_York';

export interface LearningHandlerOptions {
  /** Optional AI client for personalization; omitted = bank-only generation. */
  readonly ai?: ResponsesClient;
  readonly rates?: typeof DEFAULT_RATE_TABLE_2026_09_18;
  readonly sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Shared data access (also used by routes/learning.ts)
// ---------------------------------------------------------------------------------------------

export interface ScheduleRow {
  review_weekday: number;
  review_local_time: string;
  review_questions_per_subject: number;
  schedule_version: number;
  daily_local_time: string;
  daily_question_count: number;
  paused_from: string | null;
  paused_to: string | null;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  child_reminders_permitted: boolean;
}

export const SCHEDULE_COLUMNS = `review_weekday, to_char(review_local_time, 'HH24:MI') as review_local_time,
  review_questions_per_subject, schedule_version, to_char(daily_local_time, 'HH24:MI') as daily_local_time,
  daily_question_count, paused_from::text as paused_from, paused_to::text as paused_to,
  to_char(quiet_hours_start, 'HH24:MI') as quiet_hours_start, to_char(quiet_hours_end, 'HH24:MI') as quiet_hours_end,
  child_reminders_permitted`;

export const DEFAULT_SUBJECT_NAMES: Readonly<Record<BankSubject, string>> = {
  math: 'Math',
  reading: 'Reading',
  spelling_vocabulary: 'Spelling & Vocabulary',
  grammar_writing: 'Grammar & Writing',
  science: 'Science',
  social_studies: 'Social Studies',
};

/**
 * Lazily creates the default schedule and, for a child with no subject rows yet, the six supported
 * subjects (enabled). Works as `authenticated` (RLS member policies) or as the service role.
 */
export async function ensureLearningDefaults(
  tx: Tx,
  familyId: string,
  childId: string,
): Promise<void> {
  await tx`
    insert into public.learning_schedules (child_id, family_id)
    values (${childId}, ${familyId})
    on conflict (child_id) do nothing`;
  const [row] = await tx<{ n: number }[]>`
    select count(*)::int as n from public.child_subjects where child_id = ${childId} and family_id = ${familyId}`;
  if ((row?.n ?? 0) > 0) return;
  for (const subject of BANK_SUBJECTS) {
    await tx`
      insert into public.child_subjects (family_id, child_id, subject_key, display_name, enabled)
      values (${familyId}, ${childId}, ${subject}, ${DEFAULT_SUBJECT_NAMES[subject]}, true)
      on conflict do nothing`;
  }
}

export interface ChildContext {
  readonly familyId: string;
  readonly childId: string;
  readonly grade: number;
  readonly ageBand: AgeBand;
  readonly zone: string;
  readonly schedule: ScheduleRow;
  /** Enabled supported subjects (custom subjects get no generated practice). */
  readonly subjects: readonly BankSubject[];
  readonly subjectIds: ReadonlyMap<string, BankSubject>;
}

/** Loads an ACTIVE child of a non-deleted family (creating learning defaults lazily); else null. */
export async function loadChildContext(
  tx: Tx,
  familyId: string,
  childId: string,
  options: { readonly requireActive?: boolean } = {},
): Promise<ChildContext | null> {
  const [child] = await tx<
    { grade_level: number; age_band: AgeBand; timezone: string; status: string }[]
  >`
    select c.grade_level, c.age_band, f.timezone, c.status
      from public.child_profiles c
      join public.families f on f.id = c.family_id and f.deleted_at is null
     where c.id = ${childId} and c.family_id = ${familyId}`;
  if (!child) return null;
  if (child.status === 'archived') return null;
  if ((options.requireActive ?? true) && child.status !== 'active') return null;
  await ensureLearningDefaults(tx, familyId, childId);
  const [schedule] = await tx.unsafe<ScheduleRow[]>(
    `select ${SCHEDULE_COLUMNS} from public.learning_schedules where child_id = $1 and family_id = $2`,
    [childId, familyId],
  );
  if (!schedule) return null;
  const subjectRows = await tx<{ id: string; subject_key: string; enabled: boolean }[]>`
    select id, subject_key, enabled from public.child_subjects
     where child_id = ${childId} and family_id = ${familyId}
     order by created_at, id`;
  const subjects: BankSubject[] = [];
  const subjectIds = new Map<string, BankSubject>();
  for (const row of subjectRows) {
    if (!isBankSubject(row.subject_key)) continue;
    subjectIds.set(row.id, row.subject_key);
    if (row.enabled && !subjects.includes(row.subject_key)) subjects.push(row.subject_key);
  }
  return {
    familyId,
    childId,
    grade: bankGrade(child.grade_level),
    ageBand: child.age_band,
    zone: isSchedulingZone(child.timezone) ? child.timezone : FALLBACK_ZONE,
    schedule,
    subjects: BANK_SUBJECTS.filter((s) => subjects.includes(s)),
    subjectIds,
  };
}

/** At most this many attempts are read per evidence query (the NEWEST ones in the window). */
export const EVIDENCE_EVENT_LIMIT = 5000;

/**
 * Attempts (+ latest parent override) as validated learning events, oldest first.
 *
 * - The newest `EVIDENCE_EVENT_LIMIT` attempts in the window are kept (review finding
 *   RV-learning-api-2: an ascending sort with a limit dropped this week's evidence for a busy child).
 * - A practice attempt is keyed by its bank question (`evidence_key`, a digest of the private
 *   instance key), so the same question served again in a later set is ONE distinct question, not a
 *   new one (spec P7 "avoid repeatedly counting resubmissions of the same question as new
 *   evidence"; RV-learning-api-1). Homework attempts keep their extracted-question id.
 */
export async function loadEvidence(
  tx: Tx,
  ctx: { familyId: string; childId: string },
  since: Date,
): Promise<AttemptEvent[]> {
  const rows = await tx<
    {
      id: string;
      question_instance_id: string;
      subject_key: string;
      skill: string;
      attempt_number: number;
      hints_used: number;
      correctness: string;
      grader_version: string;
      occurred_at: Date;
      override_correctness: string | null;
      overridden_at: Date | null;
    }[]
  >`
    select recent.* from (
      select a.id, coalesce(a.evidence_key, a.question_instance_id::text) as question_instance_id,
             a.subject_key, a.skill, a.attempt_number, a.hints_used,
             a.correctness, a.grader_version, a.occurred_at,
             o.correctness as override_correctness, o.created_at as overridden_at
        from public.attempts a
        left join lateral (
          select correctness, created_at from public.attempt_overrides
           where attempt_id = a.id order by created_at desc limit 1
        ) o on true
       where a.child_id = ${ctx.childId} and a.family_id = ${ctx.familyId} and a.occurred_at >= ${since}
       order by a.occurred_at desc, a.id desc
       limit ${EVIDENCE_EVENT_LIMIT}
    ) recent
    order by recent.occurred_at, recent.id`;
  const events: AttemptEvent[] = [];
  for (const row of rows) {
    const parsed = validateAttemptEvent({
      id: row.id,
      childId: ctx.childId,
      questionInstanceId: row.question_instance_id,
      skill: row.skill,
      subject: row.subject_key,
      occurredAt: row.occurred_at,
      attemptNumber: row.attempt_number,
      hintsUsed: row.hints_used,
      correctness: row.correctness,
      graderVersion: row.grader_version,
      ...(row.override_correctness !== null && row.overridden_at !== null
        ? {
            parentOverride: {
              correctness: row.override_correctness,
              // The override is recorded by the database clock; never before the attempt itself.
              overriddenAt: new Date(
                Math.max(row.overridden_at.getTime(), row.occurred_at.getTime()),
              ),
            },
          }
        : {}),
    });
    if (parsed.ok) events.push(parsed.value);
  }
  return events;
}

interface MaterialContext {
  readonly material: FamilyMaterial;
  /** subject -> bank skills from current study material (taught notes, lists, passages). */
  readonly currentSkills: ReadonlyMap<BankSubject, readonly string[]>;
}

/** Recent family study material (last 21 days) for selection. */
async function loadMaterial(tx: Tx, ctx: ChildContext, now: Date): Promise<MaterialContext> {
  const since = new Date(now.getTime() - 21 * DAY_MS);
  const rows = await tx<
    { id: string; kind: string; subject_key: string | null; content_text: string }[]
  >`
    select m.id, m.kind, s.subject_key, m.content_text
      from public.study_materials m
      left join public.child_subjects s on s.id = m.subject_id
     where m.child_id = ${ctx.childId} and m.family_id = ${ctx.familyId}
       and m.content_text is not null and m.created_at >= ${since}
     order by m.created_at desc, m.id
     limit 20`;
  const spellingLists = rows
    .filter((r) => r.kind === 'spelling_list')
    .map((r) => ({ id: r.id, text: r.content_text }));
  const readingPassages = rows
    .filter((r) => r.kind === 'reading_passage')
    .map((r) => ({ id: r.id, text: r.content_text }));
  const current = new Map<BankSubject, string[]>();
  const add = (subject: BankSubject, skills: readonly string[]) => {
    if (!ctx.subjects.includes(subject)) return;
    const list = current.get(subject) ?? [];
    for (const s of skills) if (!list.includes(s)) list.push(s);
    current.set(subject, list);
  };
  if (spellingLists.length > 0) add('spelling_vocabulary', ['spelling.teacher_list']);
  if (readingPassages.length > 0) add('reading', ['reading.sequence', 'reading.literal_detail']);
  for (const row of rows) {
    if (row.kind !== 'taught_notes' && row.kind !== 'study_guide') continue;
    const subjects =
      row.subject_key !== null && isBankSubject(row.subject_key) ? [row.subject_key] : ctx.subjects;
    for (const subject of subjects) add(subject, matchSkills(subject, row.content_text));
  }
  return { material: { spellingLists, readingPassages }, currentSkills: current };
}

/** Test dates (with scope notes) per subject within [from, to] (inclusive local dates). */
async function loadTestDates(
  tx: Tx,
  ctx: ChildContext,
  from: string,
  to: string,
): Promise<{ subject: BankSubject; testDate: string; scopeNotes: string | null }[]> {
  const rows = await tx<{ subject_key: string; test_date: string; scope_notes: string | null }[]>`
    select s.subject_key, t.test_date::text as test_date, t.scope_notes
      from public.test_dates t
      join public.child_subjects s on s.id = t.subject_id
     where t.child_id = ${ctx.childId} and t.family_id = ${ctx.familyId}
       and t.test_date between ${from}::date and ${to}::date
     order by t.test_date, t.id`;
  return rows.flatMap((r) =>
    isBankSubject(r.subject_key)
      ? [{ subject: r.subject_key, testDate: r.test_date, scopeNotes: r.scope_notes }]
      : [],
  );
}

async function recentInstanceKeys(
  tx: Tx,
  ctx: { familyId: string; childId: string },
  since: Date,
): Promise<Set<string>> {
  const rows = await tx<{ key: string | null }[]>`
    select k.answer_spec->>'instanceKey' as key
      from public.practice_items i
      join private.practice_item_keys k on k.item_id = i.id
     where i.child_id = ${ctx.childId} and i.family_id = ${ctx.familyId} and i.created_at >= ${since}`;
  return new Set(rows.flatMap((r) => (r.key === null ? [] : [r.key])));
}

// ---------------------------------------------------------------------------------------------
// Private key record (private.practice_item_keys.answer_spec)
// ---------------------------------------------------------------------------------------------

const answerSpecSchema: z.ZodType<AnswerSpec> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('numeric'),
    value: z.string().min(1).max(200),
    unit: z.string().max(20).nullable(),
    alternates: z.array(z.string().max(200)).max(10),
  }),
  z.object({
    kind: z.literal('division_remainder'),
    quotient: z.number().int().min(0),
    remainder: z.number().int().min(0),
    divisor: z.number().int().min(1),
    alternates: z.array(z.string().max(200)).max(10),
  }),
  z.object({
    kind: z.literal('multiple_choice'),
    letters: z.array(z.string().regex(/^[A-E]$/)).length(1),
    validLetters: z
      .array(z.string().regex(/^[A-E]$/))
      .min(2)
      .max(5),
    alternates: z.array(z.string().max(200)).max(10),
  }),
  z.object({
    kind: z.literal('spelling'),
    target: z.string().min(1).max(60),
    alternates: z.array(z.string().max(60)).max(10),
  }),
  z.object({
    kind: z.literal('exact_text'),
    accepted: z.array(z.string().min(1).max(200)).min(1).max(10),
    alternates: z.array(z.string().max(200)).max(10),
  }),
]);

const storedKeySchema = z.object({
  spec: answerSpecSchema,
  instanceKey: z.string().min(1).max(200),
  templateKey: z.string().min(1).max(200),
  generator: z.string().max(40),
});
export type StoredKey = z.infer<typeof storedKeySchema>;

/** Parses a stored private key; null for anything malformed (grading then fails closed). */
export function parseStoredKey(value: unknown): StoredKey | null {
  const parsed = storedKeySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------------------------
// Saving a set: one transaction, idempotent on set_key, never over a deleted family
// ---------------------------------------------------------------------------------------------

export type ItemCategoryColumn =
  'weak' | 'spaced' | 'confidence' | 'cumulative' | 'fallback' | 'prerequisite';

interface NewSet {
  readonly kind: 'daily' | 'thursday_review' | 'top_up';
  readonly setKey: string;
  readonly subjectKey: string | null;
  readonly localDate: string | null;
  readonly reviewWeek: string | null;
  readonly version: number;
  readonly mix: Record<string, number>;
  readonly notes: readonly { code: string; message: string }[];
  readonly releaseAt: Date;
  readonly evidenceCutoffAt: Date;
  readonly intro: string | null;
  readonly items: readonly { readonly item: BankItem; readonly category: ItemCategoryColumn }[];
}

/**
 * Inserts the set, items and private keys atomically. Returns the new id, or null if it existed.
 * "Existed" covers the set key AND the one-base-review-per-child/subject/week index (migration
 * 0650), so two workers holding jobs of different schedule versions for the same week save one
 * review between them (review finding RV-learning-api-8).
 */
async function saveSet(deps: JobDeps, ctx: ChildContext, set: NewSet): Promise<string | null> {
  for (const { item } of set.items) {
    // Defense in depth: re-validate right before storage (AC_LEARNING_06, AC_GRADING_06).
    if (!validateBankItem(item).ok || findForbiddenFields(item.prompt).length > 0) {
      throw new Error('INVALID_ITEM_AT_SAVE');
    }
  }
  return deps.db.asService(async (tx) => {
    // FOR SHARE blocks a concurrent tombstone until we commit, and refuses a deleted family, so a
    // job can never resurrect data after a deletion request (spec P4, AC_ACCESS_10).
    const [family] = await tx<{ id: string }[]>`
      select id from public.families where id = ${ctx.familyId} and deleted_at is null for share`;
    if (!family) return null;
    const [child] = await tx<{ id: string }[]>`
      select id from public.child_profiles
       where id = ${ctx.childId} and family_id = ${ctx.familyId} and status = 'active' for share`;
    if (!child) return null;
    const [created] = await tx<{ id: string }[]>`
      insert into public.practice_sets
        (family_id, child_id, kind, set_key, subject_key, local_date, review_week, version, status, mix,
         notes, ready_at, release_at, evidence_cutoff_at, child_intro)
      values (${ctx.familyId}, ${ctx.childId}, ${set.kind}, ${set.setKey}, ${set.subjectKey},
              ${set.localDate}::date, ${set.reviewWeek}, ${set.version}, 'ready',
              ${JSON.stringify(set.mix)}::text::jsonb, ${JSON.stringify(set.notes)}::text::jsonb,
              ${deps.clock()}, ${set.releaseAt}, ${set.evidenceCutoffAt}, ${set.intro})
      on conflict do nothing
      returning id`;
    if (!created) return null;
    let position = 0;
    for (const { item, category } of set.items) {
      position += 1;
      const [row] = await tx<{ id: string }[]>`
        insert into public.practice_items (set_id, family_id, child_id, position, subject_key, skill, category, prompt)
        values (${created.id}, ${ctx.familyId}, ${ctx.childId}, ${position}, ${item.subject}, ${item.skill},
                ${category}, ${JSON.stringify(item.prompt)}::text::jsonb)
        returning id`;
      const key: StoredKey = {
        spec: item.answerSpec,
        instanceKey: item.instanceKey,
        templateKey: item.templateKey,
        generator: PRACTICE_GENERATOR_VERSION,
      };
      await tx`
        insert into private.practice_item_keys (item_id, family_id, answer_spec, explanation)
        values (${row!.id}, ${ctx.familyId}, ${JSON.stringify(key)}::text::jsonb, ${item.explanation})`;
    }
    return created.id;
  });
}

// ---------------------------------------------------------------------------------------------
// AI personalization (optional) and metering
// ---------------------------------------------------------------------------------------------

interface Personalized {
  readonly items: BankItem[];
  readonly intro: string | null;
  readonly rethemed: number;
}

async function recordUsage(
  deps: JobDeps,
  ctx: ChildContext,
  usage: readonly AttemptRecord[],
): Promise<void> {
  if (usage.length === 0) return;
  const rows = usage.map((a) => ({
    family_id: ctx.familyId,
    child_id: ctx.childId,
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
  try {
    await deps.db.asService((tx) => tx`insert into public.ai_usage_events ${tx(rows)}`);
  } catch {
    deps.log({ level: 'error', event: 'ai_usage_record_failed', code: 'METERING' });
  }
}

/** Payload-free log line for model output the safety screen refused (never the text). */
function logSafetyBlock(deps: JobDeps, screen: SafetyScreen): void {
  deps.log({
    level: 'warn',
    event: 'practice_ai_blocked_by_safety',
    code: `SAFETY_${(screen.categories[0] ?? 'unknown').toUpperCase()}`,
  });
}

/**
 * One bounded request that may re-theme word problems and add an intro line. Fails closed to the
 * unchanged bank items on no client, no consent, the ZDR gate, the spend ceiling, any provider or
 * validation failure. Exported for tests.
 */
export async function personalizeItems(
  deps: JobDeps,
  options: LearningHandlerOptions,
  ctx: ChildContext,
  items: readonly BankItem[],
  stage: 'daily_set' | 'thursday_bundle',
  focusSkills: readonly string[],
): Promise<Personalized> {
  const unchanged: Personalized = { items: [...items], intro: null, rethemed: 0 };
  const ai = options.ai;
  if (ai === undefined || items.length === 0) return unchanged;
  const consent = await deps.db.asService((tx) =>
    hasVerifiedConsent(tx, ctx.familyId, {
      allowTestProvider: deps.config.environment !== 'production',
    }),
  );
  if (!consent) {
    deps.log({ level: 'info', event: 'practice_ai_skipped', code: 'CONSENT_REQUIRED' });
    return unchanged;
  }
  const gate = {
    containsChildPersonalData: true,
    ageBand: ctx.ageBand,
    zdrEvidence: deps.config.zdrEvidence,
    environment: deps.config.environment,
    now: deps.clock(),
  } as const;
  if (!checkChildDataGate({ ...gate, providerIsMock: ai.isMock }).ok) {
    deps.log({ level: 'info', event: 'practice_ai_skipped', code: 'AI_NOT_AVAILABLE' });
    return unchanged;
  }
  // Admitted only when recorded spend + every live hold (scans included) + this stage's upper-bound
  // estimate stays within the owner's cap (RV-lead-jobs-ai-10). A refused or undecidable budget keeps
  // the reviewed bank items: the set is still delivered, without an AI call.
  let hold: string | null;
  try {
    hold = await acquireSpendHold(deps, PROPOSED_STAGE_LIMITS[stage].maxCostMicros);
  } catch (error) {
    if (error instanceof SpendCeilingReached) {
      deps.log({ level: 'warn', event: 'practice_ai_skipped', code: 'SPEND_CEILING' });
      return unchanged;
    }
    if (error instanceof SpendCeilingUnevaluable) {
      deps.log({ level: 'error', event: 'practice_ai_skipped', code: 'SPEND_UNEVALUABLE' });
      return unchanged;
    }
    throw error;
  }
  const refs = new Map<string, number>();
  const wordProblems: { ref: string; template: string; context: unknown }[] = [];
  items.forEach((item, index) => {
    if (item.wordProblem === undefined) return;
    const ref = `w${wordProblems.length + 1}`;
    refs.set(ref, index);
    wordProblems.push({
      ref,
      template: item.wordProblem.template,
      context: item.wordProblem.context,
    });
  });
  const prompt = stage === 'daily_set' ? PROMPTS.daily_set : PROMPTS.thursday_bundle;
  let out: Awaited<ReturnType<typeof runStage<typeof prompt.outputSchema>>>;
  try {
    out = await runStage<typeof prompt.outputSchema>({
      prompt,
      input: [
        dataEnvelope({
          gradeLevel: ctx.grade,
          ageBand: ctx.ageBand,
          // Skill labels only: no names, homework text, answers or scores.
          focusSkills: focusSkills.slice(0, 6).map(skillLabel),
          wordProblems,
        }),
      ],
      client: ai,
      limits: PROPOSED_STAGE_LIMITS[stage],
      rates: options.rates ?? DEFAULT_RATE_TABLE_2026_09_18,
      gate,
      metadata: { stage },
      estimatedInputTokens: 700 + 80 * wordProblems.length,
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
    await recordUsage(deps, ctx, out.attempts);
  } finally {
    await releaseSpendHold(deps, hold); // after the stage's actual cost is recorded
  }
  if (!out.result.ok) {
    deps.log({ level: 'warn', event: 'practice_ai_failed', code: out.result.error.code });
    return unchanged;
  }
  const result: PracticePersonalization = out.result.value;
  const next = [...items];
  const seen = new Set<string>();
  let rethemed = 0;
  let rejected = 0;
  for (const proposal of result.items) {
    const index = refs.get(proposal.ref);
    if (index === undefined || seen.has(proposal.ref) || proposal.context === null) continue;
    seen.add(proposal.ref);
    const original = items[index];
    if (original === undefined) continue;
    const themed = rethemeWordProblem(original, proposal.context);
    if (themed === null) {
      rejected += 1;
      continue;
    }
    const safety = screenModelOutput([themed.prompt.text], {
      ageBand: ctx.ageBand,
      context: { prompt: original.prompt.text, subject: original.subject },
    });
    if (safety.level === 'severe') {
      logSafetyBlock(deps, safety);
      rejected += 1;
      continue;
    }
    next[index] = themed;
    rethemed += 1;
  }
  // Content check first (charset + denylist: no credentials, grown-up roles, answers, contact
  // details or money; review finding RV-learning-api-7), then the child-safety screen (an intro has
  // no question, so any sensitive topic is off-task), then the answer-leak guard.
  let intro: string | null = validateIntro(result.intro);
  if (intro !== null) {
    const safety = screenModelOutput([intro], { ageBand: ctx.ageBand, context: {} });
    if (safety.level === 'severe') {
      logSafetyBlock(deps, safety);
      intro = null;
    }
  }
  // The guard takes at most 32 protected answers per call: check the intro against every batch.
  const answers = items.flatMap((item) => protectedAnswersFor(item.answerSpec));
  const batches: (typeof answers)[] = [];
  for (let i = 0; i < answers.length; i += 32) batches.push(answers.slice(i, i + 32));
  if (
    intro === null ||
    batches.some(
      (batch) =>
        guardChildContent({
          packet: { intro },
          answers: batch,
          options: { evaluateExpressions: true },
        }).decision !== 'release',
    )
  ) {
    intro = null;
    rejected += 1;
  }
  if (rejected > 0)
    deps.log({ level: 'warn', event: 'practice_ai_output_rejected', code: 'FELL_BACK_TO_BANK' });
  return { items: next, intro, rethemed };
}

// ---------------------------------------------------------------------------------------------
// Notes for parents (how a set was composed)
// ---------------------------------------------------------------------------------------------

const SOURCE_TEXT: Readonly<Record<string, string>> = {
  weak: 'recent practice areas',
  prerequisite: 'building-block skills',
  current_material: 'current study material',
  spaced_review: 'spaced review',
  confidence: 'confidence practice',
  grade_fallback: 'grade-level practice',
  weekly_weakness: "this week's weaker concepts",
  test_scope: 'the teacher’s test scope',
  cumulative: 'cumulative review',
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function dailyNoteMessages(
  notes: readonly DailySetNote[],
): { code: string; message: string }[] {
  return notes.map((note) => {
    switch (note.code) {
      case 'BACKFILLED':
        return {
          code: note.code,
          message: `${plural(note.count, 'question')} for ${SOURCE_TEXT[note.slot === 'spaced' ? 'spaced_review' : note.slot] ?? note.slot} came from ${SOURCE_TEXT[note.source] ?? note.source} instead.`,
        };
      case 'NO_HISTORY_GRADE_DIAGNOSTIC':
        return {
          code: note.code,
          message:
            'There is no practice history yet, so this is a short grade-level check-in across subjects.',
        };
      case 'RECENT_TEMPLATE_REUSED':
        return {
          code: note.code,
          message: `${plural(note.count, 'question')} repeat recent practice (no fresh question was available).`,
        };
      case 'INSUFFICIENT_CANDIDATES':
        return {
          code: note.code,
          message: `The set is ${plural(note.count, 'question')} short: the question bank has no more suitable items right now.`,
        };
    }
  });
}

export function reviewNoteMessages(
  notes: readonly ReviewNote[],
): { code: string; message: string }[] {
  return notes.map((note) => {
    switch (note.code) {
      case 'FILLED':
        return {
          code: note.code,
          message: `${plural(note.count, 'question')} in the ${note.part} part came from ${SOURCE_TEXT[note.source] ?? note.source}.`,
        };
      case 'INSUFFICIENT_CANDIDATES':
        return {
          code: note.code,
          message: `The ${note.part} part is ${plural(note.count, 'question')} short: the question bank has no more suitable items.`,
        };
      case 'FEWER_DISTINCT_WEAKNESSES':
        return {
          code: note.code,
          message: `Only ${plural(note.count, 'weaker concept')} showed up this week, so the rest is building-block skills and current material.`,
        };
      case 'NO_WEEKLY_WEAKNESSES':
        return {
          code: note.code,
          message:
            'No weaker concepts showed up this week; the review uses the current study material.',
        };
      case 'FALLBACK_NO_EVIDENCE':
        return {
          code: note.code,
          message:
            'There was no work in this subject this week, so this is grade-level practice. It does not predict the teacher’s test.',
        };
      case 'RECENT_TEMPLATE_REUSED':
        return {
          code: note.code,
          message: `${plural(note.count, 'question')} repeat recent practice (no fresh question was available).`,
        };
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------

const dailyPayloadSchema = z.object({ childId: z.uuid(), localDate: z.iso.date() });
const reviewPayloadSchema = z.object({
  childId: z.uuid(),
  subject: z.enum(BANK_SUBJECTS),
  weekKey: z.string().regex(/^\d{4}-W\d{2}$/),
  scheduleVersion: z.number().int().min(1),
});
const topUpPayloadSchema = z.object({
  childId: z.uuid(),
  subject: z.enum(BANK_SUBJECTS),
  weekKey: z.string().regex(/^\d{4}-W\d{2}$/),
});

const DAILY_CATEGORY: Readonly<Record<string, ItemCategoryColumn>> = {
  weak: 'weak',
  prerequisite: 'prerequisite',
  current_material: 'weak',
  spaced_review: 'spaced',
  confidence: 'confidence',
  grade_fallback: 'fallback',
};

const REVIEW_CATEGORY: Readonly<Record<string, ItemCategoryColumn>> = {
  weekly_weakness: 'weak',
  test_scope: 'weak',
  prerequisite: 'prerequisite',
  current_material: 'weak',
  cumulative: 'cumulative',
  grade_fallback: 'fallback',
};

function candidateInputs(items: readonly BankItem[]) {
  return items.map((c) => ({
    templateKey: c.instanceKey,
    skill: c.skill,
    category: c.category,
    subject: c.subject,
  }));
}

function dayNumber(localDate: string): number {
  return Math.floor(Date.parse(`${localDate}T00:00:00Z`) / DAY_MS);
}

function isPaused(schedule: ScheduleRow, localDate: string): boolean {
  return (
    schedule.paused_from !== null &&
    schedule.paused_to !== null &&
    schedule.paused_from <= localDate &&
    localDate <= schedule.paused_to
  );
}

function invalidJob(deps: JobDeps, kind: string): void {
  deps.log({ level: 'error', event: 'learning_invalid_job', code: kind });
}

async function generateDailySet(
  deps: JobDeps,
  options: LearningHandlerOptions,
  job: JobRow,
): Promise<void> {
  const parsed = dailyPayloadSchema.safeParse(job.payload);
  if (!parsed.success || !job.family_id) return invalidJob(deps, 'daily_set_generate');
  const { childId, localDate } = parsed.data;
  const familyId = job.family_id;
  const setKey = dailySetKey(childId, localDate);
  const now = deps.clock();
  const loaded = await deps.db.asService(async (tx) => {
    const ctx = await loadChildContext(tx, familyId, childId);
    if (!ctx) return null;
    const [existing] = await tx<
      { id: string }[]
    >`select id from public.practice_sets where set_key = ${setKey}`;
    if (existing) return null; // saved once, reused on retries/reopening (spec P7)
    if (isPaused(ctx.schedule, localDate) || ctx.subjects.length === 0) return null;
    return {
      ctx,
      events: await loadEvidence(
        tx,
        ctx,
        new Date(now.getTime() - EVIDENCE_LOOKBACK_DAYS * DAY_MS),
      ),
      material: await loadMaterial(tx, ctx, now),
      recent: await recentInstanceKeys(
        tx,
        ctx,
        new Date(now.getTime() - RECENT_ITEM_DAYS * DAY_MS),
      ),
      tests: await loadTestDates(tx, ctx, localDate, addCalendarDays(localDate, 14)),
    };
  });
  if (!loaded) return;
  const { ctx, events, material, recent, tests } = loaded;
  const current = [
    ...ctx.subjects.flatMap((s) => material.currentSkills.get(s) ?? []),
    ...tests.flatMap((t) => (t.scopeNotes ? matchSkills(t.subject, t.scopeNotes) : [])),
  ];
  const plan = planDailySkills({
    events,
    subjects: ctx.subjects,
    grade: ctx.grade,
    now,
    timeZone: ctx.zone,
    currentMaterialSkills: current,
    rotation: dayNumber(localDate),
  });
  const candidates = generateCandidates({
    subjects: ctx.subjects,
    grade: ctx.grade,
    seed: setKey,
    material: material.material,
  });
  const composed = composeDailySet({
    count: ctx.schedule.daily_question_count,
    localDate,
    weakSkills: plan.weakSkills,
    spacedReviewSkills: plan.spacedReviewSkills,
    confidenceSkills: plan.confidenceSkills,
    gradeFallbackSkills: plan.gradeFallbackSkills,
    prerequisiteSkills: plan.prerequisiteSkills,
    currentMaterialSkills: plan.currentMaterialSkills,
    recentlyUsedTemplateKeys: recent,
    candidateItems: candidateInputs(candidates),
  });
  if (!composed.ok) {
    deps.log({ level: 'warn', event: 'daily_set_not_composed', code: composed.error.code });
    return;
  }
  const byKey = new Map(candidates.map((c) => [c.instanceKey, c]));
  const picked = composed.value.items.map((i) => ({
    item: byKey.get(i.templateKey)!,
    source: i.source,
  }));
  const personalized = await personalizeItems(
    deps,
    options,
    ctx,
    picked.map((p) => p.item),
    'daily_set',
    plan.weakSkills,
  );
  const notes = dailyNoteMessages(composed.value.notes);
  if (personalized.rethemed > 0) {
    notes.push({
      code: 'AI_RETHEMED',
      message: `${plural(personalized.rethemed, 'word problem')} got a new story from AI; the numbers and answers are unchanged and checked by code.`,
    });
  }
  const releaseAt = localDateTimeToUtc(ctx.zone, localDate, ctx.schedule.daily_local_time);
  const id = await saveSet(deps, ctx, {
    kind: 'daily',
    setKey,
    subjectKey: null,
    localDate,
    reviewWeek: null,
    version: 1,
    mix: {
      weak: composed.value.mix.weak,
      spaced: composed.value.mix.spaced,
      confidence: composed.value.mix.confidence,
      diagnostic: composed.value.mix.diagnostic,
      requested: composed.value.count,
    },
    notes,
    releaseAt,
    evidenceCutoffAt: now,
    intro: personalized.intro,
    items: picked.map((p, i) => ({
      item: personalized.items[i] ?? p.item,
      category: DAILY_CATEGORY[p.source] ?? 'fallback',
    })),
  });
  deps.log({ level: 'info', event: id ? 'daily_set_ready' : 'daily_set_exists' });
}

/** The review release for one subject/week under the child's CURRENT schedule and test dates. */
async function currentRelease(
  tx: Tx,
  ctx: ChildContext,
  subject: BankSubject,
  weekKey: string,
): Promise<ReviewRelease | null> {
  const { monday, sunday } = isoWeekDates(weekKey);
  const tests = await loadTestDates(tx, ctx, monday, sunday);
  const schedule = reviewScheduleFor(ctx, tests);
  const releases = reviewReleases({ schedule, zone: ctx.zone, subjects: [subject], weekKey });
  return releases.ok ? (releases.value[0] ?? null) : null;
}

export function reviewScheduleFor(
  ctx: Pick<ChildContext, 'schedule'>,
  tests: readonly { subject: string; testDate: string }[],
): ReviewSchedule {
  const overrides: Record<string, { testDates: string[] }> = {};
  for (const t of tests) {
    const entry = overrides[t.subject] ?? { testDates: [] };
    entry.testDates.push(t.testDate);
    overrides[t.subject] = entry;
  }
  return {
    weekday: ctx.schedule.review_weekday,
    localTime: ctx.schedule.review_local_time,
    scheduleVersion: ctx.schedule.schedule_version,
    subjectOverrides: overrides,
  };
}

/** Evidence window: Monday 00:00 local to the cutoff, at most 7 days. */
function evidenceWindow(zone: string, weekKey: string, cutoff: Date): { from: Date; cutoff: Date } {
  let from = startOfLocalDay(zone, isoWeekDates(weekKey).monday);
  if (cutoff.getTime() - from.getTime() <= 0 || cutoff.getTime() - from.getTime() > 7 * DAY_MS) {
    from = new Date(cutoff.getTime() - 7 * DAY_MS);
  }
  return { from, cutoff };
}

interface ReviewBuild {
  readonly ctx: ChildContext;
  readonly subject: BankSubject;
  readonly weekKey: string;
  readonly window: { from: Date; cutoff: Date };
  readonly perSubjectCount: number;
  readonly seed: string;
  readonly exclude: ReadonlySet<string>;
}

async function composeReviewItems(
  deps: JobDeps,
  options: LearningHandlerOptions,
  build: ReviewBuild,
) {
  const { ctx, subject, weekKey, window } = build;
  const loaded = await deps.db.asService(async (tx) => {
    const { monday, sunday } = isoWeekDates(weekKey);
    return {
      events: await loadEvidence(
        tx,
        ctx,
        new Date(window.from.getTime() - EVIDENCE_LOOKBACK_DAYS * DAY_MS),
      ),
      material: await loadMaterial(tx, ctx, window.cutoff),
      recent: await recentInstanceKeys(
        tx,
        ctx,
        new Date(window.cutoff.getTime() - RECENT_ITEM_DAYS * DAY_MS),
      ),
      tests: await loadTestDates(tx, ctx, monday, addCalendarDays(sunday, 7)),
    };
  });
  const plan = planReviewSkills({
    events: loaded.events,
    subject,
    grade: ctx.grade,
    window,
    timeZone: ctx.zone,
  });
  const scope = loaded.tests
    .filter((t) => t.subject === subject && t.scopeNotes)
    .flatMap((t) => matchSkills(subject, t.scopeNotes ?? ''));
  const candidates = generateCandidates({
    subjects: [subject],
    grade: ctx.grade,
    seed: build.seed,
    material: loaded.material.material,
  });
  const recent = new Set([...loaded.recent, ...build.exclude]);
  const composed = composeThursdayReview({
    enabledSubjects: [subject],
    perSubjectCount: build.perSubjectCount,
    evidenceWindow: window,
    subjectEvidence: new Map([[subject, plan.weeklyWeaknesses]]),
    testScope: new Map([[subject, [...new Set(scope)]]]),
    cumulativeSkills: new Map([[subject, plan.cumulativeSkills]]),
    gradeFallback: new Map([[subject, plan.gradeFallback]]),
    prerequisites: prerequisiteMap(),
    currentMaterial: new Map([[subject, loaded.material.currentSkills.get(subject) ?? []]]),
    candidateItems: candidateInputs(candidates).filter((c) => !build.exclude.has(c.templateKey)),
    recentlyUsedTemplateKeys: recent,
  });
  if (!composed.ok) {
    deps.log({ level: 'warn', event: 'review_not_composed', code: composed.error.code });
    return null;
  }
  const section = composed.value.sections[0];
  if (!section || section.items.length === 0) {
    deps.log({ level: 'warn', event: 'review_not_composed', code: 'NO_ITEMS' });
    return null;
  }
  const byKey = new Map(candidates.map((c) => [c.instanceKey, c]));
  const picked = section.items.map((i) => ({
    item: byKey.get(i.templateKey)!,
    source: i.source,
    part: i.part,
  }));
  const personalized = await personalizeItems(
    deps,
    options,
    ctx,
    picked.map((p) => p.item),
    'thursday_bundle',
    plan.weeklyWeaknesses,
  );
  const notes = reviewNoteMessages(section.notes);
  if (personalized.rethemed > 0) {
    notes.push({
      code: 'AI_RETHEMED',
      message: `${plural(personalized.rethemed, 'word problem')} got a new story from AI; the numbers and answers are unchanged and checked by code.`,
    });
  }
  return {
    items: picked.map((p, i) => ({
      item: personalized.items[i] ?? p.item,
      category: REVIEW_CATEGORY[p.source] ?? 'fallback',
    })),
    mix: {
      weakness: picked.filter((p) => p.part === 'weakness').length,
      cumulative: picked.filter((p) => p.part === 'cumulative').length,
      requested: build.perSubjectCount,
    },
    notes,
    intro: personalized.intro,
  };
}

const ACTIVE_SET_STATUSES = ['generating', 'ready', 'in_progress', 'completed'] as const;

async function generateThursdayReview(
  deps: JobDeps,
  options: LearningHandlerOptions,
  job: JobRow,
): Promise<void> {
  const parsed = reviewPayloadSchema.safeParse(job.payload);
  if (!parsed.success || !job.family_id) return invalidJob(deps, 'thursday_review_generate');
  const { childId, subject, weekKey, scheduleVersion } = parsed.data;
  const familyId = job.family_id;
  const now = deps.clock();
  const setKey = reviewIdempotencyKey(childId, subject, weekKey, scheduleVersion);
  const prepared = await deps.db.asService(async (tx) => {
    const ctx = await loadChildContext(tx, familyId, childId);
    if (!ctx || !ctx.subjects.includes(subject)) return null;
    // Never a second base review for the same child/subject/week, whatever the schedule version.
    const [existing] = await tx<{ id: string }[]>`
      select id from public.practice_sets
       where child_id = ${childId} and family_id = ${familyId} and kind = 'thursday_review'
         and subject_key = ${subject} and review_week = ${weekKey}
         and status = any(${[...ACTIVE_SET_STATUSES]})
       limit 1`;
    if (existing) return null;
    const release = await currentRelease(tx, ctx, subject, weekKey);
    if (!release?.releaseAt || !release.localDate) return null; // skipped week
    return { ctx, releaseAt: release.releaseAt, localDate: release.localDate };
  });
  if (!prepared) return;
  const { ctx, releaseAt, localDate } = prepared;
  // Evidence after the release (or after this run started) is top-up material.
  const cutoff = new Date(Math.min(now.getTime(), releaseAt.getTime()));
  const window = evidenceWindow(ctx.zone, weekKey, cutoff);
  const composed = await composeReviewItems(deps, options, {
    ctx,
    subject,
    weekKey,
    window,
    perSubjectCount: ctx.schedule.review_questions_per_subject,
    seed: setKey,
    exclude: new Set(),
  });
  if (!composed) return;
  const id = await saveSet(deps, ctx, {
    kind: 'thursday_review',
    setKey,
    subjectKey: subject,
    localDate,
    reviewWeek: weekKey,
    version: 1,
    mix: composed.mix,
    notes: composed.notes,
    releaseAt,
    evidenceCutoffAt: window.cutoff,
    intro: composed.intro,
    items: composed.items,
  });
  deps.log({ level: 'info', event: id ? 'review_ready' : 'review_exists' });
}

async function generateTopUp(
  deps: JobDeps,
  options: LearningHandlerOptions,
  job: JobRow,
): Promise<void> {
  const parsed = topUpPayloadSchema.safeParse(job.payload);
  if (!parsed.success || !job.family_id) return invalidJob(deps, 'review_top_up');
  const { childId, subject, weekKey } = parsed.data;
  const familyId = job.family_id;
  const now = deps.clock();
  const prepared = await deps.db.asService(async (tx) => {
    const ctx = await loadChildContext(tx, familyId, childId);
    if (!ctx || !ctx.subjects.includes(subject)) return null;
    const versions = await tx<
      {
        id: string;
        kind: string;
        version: number;
        status: 'ready' | 'in_progress' | 'completed';
        set_key: string;
        evidence_cutoff_at: Date | null;
        release_at: Date | null;
      }[]
    >`
      select id, kind, version, status, set_key, evidence_cutoff_at, release_at from public.practice_sets
       where child_id = ${childId} and family_id = ${familyId} and kind in ('thursday_review', 'top_up')
         and subject_key = ${subject} and review_week = ${weekKey}
         and status in ('ready', 'in_progress', 'completed')
       order by version`;
    const base = versions.find((v) => v.kind === 'thursday_review' && v.version === 1);
    if (!base) return null;
    const lastCutoff = new Date(
      Math.max(...versions.map((v) => (v.evidence_cutoff_at ?? v.release_at ?? now).getTime())),
    );
    const [late] = await tx<{ n: number }[]>`
      select count(distinct question_instance_id)::int as n from public.attempts
       where child_id = ${childId} and family_id = ${familyId} and source = 'homework'
         and subject_key = ${subject} and occurred_at > ${lastCutoff} and occurred_at <= ${now}`;
    const decision = planTopUp({
      existingVersions: versions.map((v) => ({ version: v.version, status: v.status })),
      lateEvidenceCount: late?.n ?? 0,
    });
    if (!decision.ok || !decision.value.create) return null;
    const exclude = await tx<{ key: string | null }[]>`
      select k.answer_spec->>'instanceKey' as key from public.practice_items i
        join private.practice_item_keys k on k.item_id = i.id
       where i.set_id = any(${versions.map((v) => v.id)}::uuid[])`;
    return {
      ctx,
      version: decision.value.version,
      base,
      lastCutoff,
      exclude: new Set(exclude.flatMap((e) => (e.key === null ? [] : [e.key]))),
    };
  });
  if (!prepared) return;
  const { ctx, version, base, lastCutoff, exclude } = prepared;
  const setKey = topUpIdempotencyKey(base.set_key, version);
  const window = {
    from: new Date(Math.max(lastCutoff.getTime(), now.getTime() - 7 * DAY_MS)),
    cutoff: now,
  };
  if (window.cutoff.getTime() <= window.from.getTime()) return;
  const composed = await composeReviewItems(deps, options, {
    ctx,
    subject,
    weekKey,
    window,
    perSubjectCount: Math.max(
      TOP_UP_MIN_QUESTIONS,
      Math.round(ctx.schedule.review_questions_per_subject / 2),
    ),
    seed: setKey,
    exclude,
  });
  if (!composed) return;
  const id = await saveSet(deps, ctx, {
    kind: 'top_up',
    setKey,
    subjectKey: subject,
    localDate: localDateOf(now, ctx.zone),
    reviewWeek: weekKey,
    version,
    mix: composed.mix,
    notes: [
      {
        code: 'OPTIONAL_TOP_UP',
        message: 'Optional extra practice from work scanned after the review was prepared.',
      },
      ...composed.notes,
    ],
    releaseAt: new Date(Math.max(now.getTime(), (base.release_at ?? now).getTime())),
    evidenceCutoffAt: now,
    intro: composed.intro,
    items: composed.items,
  });
  deps.log({ level: 'info', event: id ? 'top_up_ready' : 'top_up_exists' });
}

/**
 * Job handlers for the dispatcher. Wire as
 * `runJobs(deps, { ...DEFAULT_HANDLERS, ...createLearningHandlers({ ai }) })`.
 */
export function createLearningHandlers(options: LearningHandlerOptions = {}): {
  daily_set_generate: JobHandler;
  thursday_review_generate: JobHandler;
  review_top_up: JobHandler;
} {
  return {
    daily_set_generate: (deps, job) => generateDailySet(deps, options, job),
    thursday_review_generate: (deps, job) => generateThursdayReview(deps, options, job),
    review_top_up: (deps, job) => generateTopUp(deps, options, job),
  };
}

// ---------------------------------------------------------------------------------------------
// Scheduling: durable jobs enqueued ahead of time (AC_LEARNING_03/08/09)
// ---------------------------------------------------------------------------------------------

export interface LearningEnqueueReport {
  children: number;
  dailyJobs: number;
  reviewJobs: number;
  cancelledReviewJobs: number;
  topUpJobs: number;
}

function reviewJobStatus(status: string): ReviewJobStatus {
  switch (status) {
    case 'queued':
    case 'failed_retryable':
      return 'scheduled';
    case 'running':
      return 'processing';
    case 'succeeded':
      return 'ready';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'failed';
  }
}

/** Enqueues today's daily set when it is due (or within the generation lead). Returns true if new. */
export async function enqueueDailyJob(
  tx: Tx,
  ctx: ChildContext,
  now: Date,
  force = false,
): Promise<boolean> {
  const state = dailyPracticeState({
    zone: ctx.zone,
    now,
    settings: {
      localTime: ctx.schedule.daily_local_time,
      paused:
        ctx.schedule.paused_from !== null && ctx.schedule.paused_to !== null
          ? { from: ctx.schedule.paused_from, to: ctx.schedule.paused_to }
          : null,
      vacationDates: [],
      excludedSubjects: [],
    },
  });
  if (!state.ok || ctx.subjects.length === 0) return false;
  const s = state.value;
  const due =
    s.available ||
    (s.reason === 'not_yet_released' &&
      (force || now.getTime() >= s.releaseAt.getTime() - DAILY_GENERATION_LEAD_MS));
  if (!due) return false;
  const rows = await tx`
    insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, run_after)
    values ('daily_set_generate', ${dailySetKey(ctx.childId, s.localDate)}, ${ctx.familyId}, ${ctx.childId},
            ${JSON.stringify({ childId: ctx.childId, localDate: s.localDate })}::text::jsonb, ${now})
    on conflict (idempotency_key) do nothing
    returning id`;
  return rows.length > 0;
}

/**
 * The ISO week key one calendar week after `now` in the family zone. Calendar arithmetic, not
 * `now + 7 × 24 h`: the day before a DST spring-forward that would land in the week after next
 * (review finding RV-learning-api-5).
 */
export function nextReviewWeekKey(now: Date, zone: string): string {
  return weekKeyOfDate(addCalendarDays(localDateOf(now, zone), 7));
}

/** The current and next ISO week (family zone, calendar weeks). */
export function currentAndNextWeekKeys(now: Date, zone: string): string[] {
  return [...new Set([reviewWeekKey(now, zone), nextReviewWeekKey(now, zone)])];
}

/**
 * Re-reads the schedule version and zone under a FOR SHARE lock on the schedule row. A context
 * loaded before a parent change committed is stale: planning with it cancelled the parent's new job
 * and left the week with none (review finding RV-learning-api-6). A stale context is reloaded; the
 * lock keeps a schedule update from committing until this plan is written (the updater's own
 * reschedule then sees these jobs).
 */
async function freshScheduleContext(tx: Tx, ctx: ChildContext): Promise<ChildContext | null> {
  const [current] = await tx<{ schedule_version: number; timezone: string }[]>`
    select s.schedule_version, f.timezone
      from public.learning_schedules s
      join public.families f on f.id = s.family_id
     where s.child_id = ${ctx.childId} and s.family_id = ${ctx.familyId}
       for share of s`;
  if (!current) return null;
  const zone = isSchedulingZone(current.timezone) ? current.timezone : FALLBACK_ZONE;
  if (current.schedule_version === ctx.schedule.schedule_version && zone === ctx.zone) return ctx;
  return loadChildContext(tx, ctx.familyId, ctx.childId);
}

/**
 * Plans review jobs for the current and next ISO week (family zone, DST-aware). A job starts at
 * `release - lead` so the review is ready before the release instant with the app closed. Keys are
 * `reviewIdempotencyKey(child, subject, week, schedule_version)`; a not-started job whose release
 * moved (new review day/time or test date) is replaced; started work is never touched.
 *
 * Decision: a cancelled job is terminal (jobs_guard), so a key must never be cancelled while it is
 * still the current one: plans use the schedule as committed (stale contexts are reloaded under a
 * lock), a job whose key is unchanged is moved rather than cancelled (time zone change), and a
 * replacement is inserted only when the old job was actually cancelled, never next to a job a
 * worker claimed in between (RV-learning-api-6, RV-learning-api-8).
 */
export async function rescheduleReviewJobs(
  tx: Tx,
  loadedCtx: ChildContext,
  now: Date,
): Promise<{ created: number; cancelled: number }> {
  let created = 0;
  let cancelled = 0;
  const ctx = await freshScheduleContext(tx, loadedCtx);
  if (!ctx) return { created, cancelled };
  // Decision: a disabled subject keeps its queued job; the handler skips it at run time. Cancelling
  // here would dead-end a same-version re-enable (a cancelled key can never be queued again).
  for (const weekKey of currentAndNextWeekKeys(now, ctx.zone)) {
    const { monday, sunday } = isoWeekDates(weekKey);
    const tests = await loadTestDates(tx, ctx, monday, sunday);
    const releases = reviewReleases({
      schedule: reviewScheduleFor(ctx, tests),
      zone: ctx.zone,
      subjects: [...ctx.subjects],
      weekKey,
    });
    if (!releases.ok) continue;
    for (const release of releases.value) {
      const subject = release.subject;
      const [set] = await tx<{ id: string }[]>`
        select id from public.practice_sets
         where child_id = ${ctx.childId} and family_id = ${ctx.familyId} and kind = 'thursday_review'
           and subject_key = ${subject} and review_week = ${weekKey}
           and status = any(${[...ACTIVE_SET_STATUSES]})
         limit 1`;
      if (set) continue; // generated work is kept (late changes use top-ups)
      const [job] = await tx<
        { id: string; status: string; idempotency_key: string; release_at: string | null }[]
      >`
        select id, status, idempotency_key, payload->>'releaseAt' as release_at from public.jobs
         where kind = 'thursday_review_generate' and child_id = ${ctx.childId} and family_id = ${ctx.familyId}
           and payload->>'subject' = ${subject} and payload->>'weekKey' = ${weekKey}
           and status <> 'cancelled'
         order by created_at desc
         limit 1`;
      const existingRelease = job?.release_at ? new Date(job.release_at) : null;
      const decision = planReviewReschedule({
        existing:
          job && existingRelease && !Number.isNaN(existingRelease.getTime())
            ? { releaseAt: existingRelease, status: reviewJobStatus(job.status) }
            : null,
        next: release,
      });
      if (!decision.ok) continue;
      const action = decision.value;
      if (action.action === 'none' || action.action === 'keep') continue;
      const key = reviewIdempotencyKey(
        ctx.childId,
        subject,
        weekKey,
        ctx.schedule.schedule_version,
      );
      // Same key, new release instant (e.g. the family changed time zone): the job is moved below,
      // never cancelled (a cancelled key could not be queued again).
      const sameKey = job !== undefined && job.idempotency_key === key;
      if ((action.action === 'cancel' || action.action === 'replace') && job && !sameKey) {
        const rows = await tx`
          update public.jobs set status = 'cancelled', last_error_code = 'RESCHEDULED'
           where id = ${job.id} and status in ('queued', 'failed_retryable')
          returning id`;
        cancelled += rows.length;
        if (rows.length === 0 && action.action === 'replace') {
          // A worker claimed the old job between our read and the cancel: it generates this week's
          // review with the current release (the handler reads the schedule), so no second job.
          const [after] = await tx<{ status: string }[]>`
            select status from public.jobs where id = ${job.id}`;
          if (after?.status !== 'cancelled') continue;
        }
      }
      if (action.action === 'cancel') continue;
      const releaseAt = action.releaseAt;
      if (releaseAt.getTime() < now.getTime() - STALE_RELEASE_MS) continue;
      const plan = planReviewJob({
        releaseAt,
        measuredP95ProcessingMs: null,
        queueLagP95Ms: null,
        now,
      });
      if (!plan.ok) continue;
      const payload = {
        childId: ctx.childId,
        subject,
        weekKey,
        scheduleVersion: ctx.schedule.schedule_version,
        releaseAt: releaseAt.toISOString(),
      };
      const inserted = await tx`
        insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, run_after)
        values ('thursday_review_generate', ${key}, ${ctx.familyId}, ${ctx.childId},
                ${JSON.stringify(payload)}::text::jsonb, ${plan.value.jobStartAt})
        on conflict (idempotency_key) do nothing
        returning id`;
      if (inserted.length > 0) {
        created += 1;
      } else {
        // Same key, new release instant: move the queued job.
        await tx`
          update public.jobs set run_after = ${plan.value.jobStartAt}, payload = ${JSON.stringify(payload)}::text::jsonb
           where idempotency_key = ${key} and status in ('queued', 'failed_retryable')`;
      }
    }
  }
  return { created, cancelled };
}

/** Enqueues optional top-ups for this week's reviews that have late homework evidence. */
async function enqueueTopUps(tx: Tx, ctx: ChildContext, now: Date): Promise<number> {
  const weekKey = reviewWeekKey(now, ctx.zone);
  const sets = await tx<
    {
      subject_key: string;
      set_key: string;
      version: number;
      kind: string;
      status: string;
      cutoff: Date | null;
    }[]
  >`
    select subject_key, set_key, version, kind, status, coalesce(evidence_cutoff_at, release_at) as cutoff
      from public.practice_sets
     where child_id = ${ctx.childId} and family_id = ${ctx.familyId} and review_week = ${weekKey}
       and kind in ('thursday_review', 'top_up') and status in ('ready', 'in_progress', 'completed')
     order by subject_key, version`;
  let created = 0;
  for (const subject of new Set(sets.map((s) => s.subject_key))) {
    if (!isBankSubject(subject) || !ctx.subjects.includes(subject)) continue;
    const versions = sets.filter((s) => s.subject_key === subject);
    const base = versions.find((v) => v.kind === 'thursday_review' && v.version === 1);
    if (!base) continue;
    const lastCutoff = new Date(Math.max(...versions.map((v) => (v.cutoff ?? now).getTime())));
    const [late] = await tx<{ n: number }[]>`
      select count(distinct question_instance_id)::int as n from public.attempts
       where child_id = ${ctx.childId} and family_id = ${ctx.familyId} and source = 'homework'
         and subject_key = ${subject} and occurred_at > ${lastCutoff} and occurred_at <= ${now}`;
    const decision = planTopUp({
      existingVersions: versions.map((v) => ({
        version: v.version,
        status: v.status as 'ready' | 'in_progress' | 'completed',
      })),
      lateEvidenceCount: late?.n ?? 0,
    });
    if (!decision.ok || !decision.value.create) continue;
    const rows = await tx`
      insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, run_after)
      values ('review_top_up', ${topUpIdempotencyKey(base.set_key, decision.value.version)}, ${ctx.familyId}, ${ctx.childId},
              ${JSON.stringify({ childId: ctx.childId, subject, weekKey })}::text::jsonb, ${now})
      on conflict (idempotency_key) do nothing
      returning id`;
    created += rows.length;
  }
  return created;
}

/**
 * Scheduled-tick entry point: for every active child of a non-deleted family (learning defaults
 * created lazily), enqueue today's daily set when due, plan Thursday review jobs ahead of release
 * and enqueue optional top-ups. Idempotent: every insert is `on conflict do nothing`.
 */
export async function enqueueDueLearningJobs(
  deps: JobDeps,
  now: Date,
  limit = 2000,
): Promise<LearningEnqueueReport> {
  const report: LearningEnqueueReport = {
    children: 0,
    dailyJobs: 0,
    reviewJobs: 0,
    cancelledReviewJobs: 0,
    topUpJobs: 0,
  };
  const children = await deps.db.asService(
    (tx) => tx<{ id: string; family_id: string }[]>`
      select c.id, c.family_id from public.child_profiles c
        join public.families f on f.id = c.family_id and f.deleted_at is null
       where c.status = 'active'
         and not exists (
           select 1 from public.deletion_requests d
            where d.family_id = c.family_id and d.target_child_id = c.id and d.status in ('requested', 'processing'))
       order by c.id
       limit ${limit}`,
  );
  for (const child of children) {
    try {
      await deps.db.asService(async (tx) => {
        const ctx = await loadChildContext(tx, child.family_id, child.id);
        if (!ctx) return;
        report.children += 1;
        if (await enqueueDailyJob(tx, ctx, now)) report.dailyJobs += 1;
        const reviews = await rescheduleReviewJobs(tx, ctx, now);
        report.reviewJobs += reviews.created;
        report.cancelledReviewJobs += reviews.cancelled;
        report.topUpJobs += await enqueueTopUps(tx, ctx, now);
      });
    } catch {
      // One child's failure never blocks the others; ids/codes only.
      deps.log({ level: 'error', event: 'learning_enqueue_failed', code: 'CHILD_SKIPPED' });
    }
  }
  return report;
}
