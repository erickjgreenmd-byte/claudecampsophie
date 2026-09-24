import { Hono, type Context } from 'hono';
import {
  STUDY_MATERIAL_MAX_CHARS,
  SUBJECT_DISPLAY_NAMES,
  createChildSubjectRequestSchema,
  createStudyMaterialRequestSchema,
  createTestDateRequestSchema,
  practiceAnswerRequestSchema,
  reviewPdfExportRequestSchema,
  updateChildSubjectRequestSchema,
  updateLearningScheduleRequestSchema,
  uuidSchema,
  type AnswerKeyResponse,
  type ChildPracticeItem,
  type ChildPracticeSet,
  type ChildPracticeToday,
  type ChildPromptDto,
  type ChildReviews,
  type ChildSubject,
  type LearningScheduleResponse,
  type ParentPracticeSet,
  type PracticeAnswerResponse,
  type SkillSummaryDto,
  type SkillsResponse,
  type TestDate,
} from '@pencillift/contracts';
import {
  BANK_SUBJECTS,
  bankCoverage,
  gradeBankAnswer,
  isBankSubject,
  keyAnswerText,
  matchSkills,
  parseSpellingList,
  skillDefinition,
  skillLabel,
} from '@pencillift/domain/bank';
import { evaluateRetry, summarizeSkills, type AttemptEvent } from '@pencillift/domain/learning';
import {
  DEFAULT_REWARD_RULES,
  computeAwards,
  validateRules,
  type LedgerEntry,
  type RewardRules,
} from '@pencillift/domain/rewards';
import {
  DAILY_PRACTICE_POINTS_POLICY,
  dailyPracticeState,
  isSchedulingZone,
  isoWeekDates,
  reviewReleases,
  reviewWeekKey,
} from '@pencillift/domain/scheduling';
import { readJson } from '../app.ts';
import type { ChildPrincipal, Tx } from '../db.ts';
import { ApiError, businessRule, pgErrorCode } from '../errors.ts';
import {
  PRACTICE_GRADER_VERSION,
  SCHEDULE_COLUMNS,
  currentAndNextWeekKeys,
  enqueueDailyJob,
  ensureLearningDefaults,
  loadChildContext,
  loadEvidence,
  nextReviewWeekKey,
  parseStoredKey,
  rescheduleReviewJobs,
  reviewScheduleFor,
  type ChildContext,
  type ScheduleRow,
} from '../jobs/learning-jobs.ts';
import {
  assertRecentUnlock,
  currentFamilyId,
  requireChild,
  requireParent,
} from '../middleware/auth.ts';
import type { AppEnv } from '../middleware/context.ts';
import { enforceRateLimit, type RateRule } from '../middleware/rate-limit.ts';

/**
 * Learning API (spec P6-P9, P13; AC_LEARNING_01..10, AC_REWARDS_01/02, AC_GRADING_06/09).
 *
 * Parents (requireParent, family ownership checked on every child/set) manage subjects, the learning
 * schedule, test dates and study material, read skill evidence and practice sets (questions only),
 * and reach answer keys only through a separate route with a recent step-up. Children
 * (requireChild) read allowlisted question fields and submit answers that are graded server-side
 * against private keys with the deterministic checks; responses never contain an answer.
 *
 * Parent reads/writes run as `authenticated` and child reads as `pl_child` (RLS + column grants are
 * a second layer). Writes children cannot make directly (attempts, retry counts, points) run as the
 * service role inside one transaction, scoped by the verified child session's ids.
 */

/** Decision: 120 answer submissions per child per 10 minutes (a 10-question set with retries is ~40). */
const CHILD_ANSWER_RULE: RateRule = { limit: 120, windowSeconds: 600 };
/** Decision: 20 review exports per family per hour. */
const REVIEW_EXPORT_RULE: RateRule = { limit: 20, windowSeconds: 3600 };
const MAX_TARGET_ATTEMPTS = 3;
/** Display order: the six supported subjects, then custom subjects. */
const SUBJECT_ORDER = [
  'math',
  'reading',
  'spelling_vocabulary',
  'grammar_writing',
  'science',
  'social_studies',
] as const;
const PARENT_SET_LIMIT = 30;

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * Child reads are evaluated at the request clock: the pl_child RLS policies show a set and its
 * questions only from release_at on (migration 0650; review finding RV-learning-db-1), using this
 * transaction-local instant (else the database clock). Call first in every pl_child transaction
 * that reads practice sets or items.
 */
async function atRequestInstant(tx: Tx, now: Date): Promise<void> {
  await tx`select set_config('pencillift.request_now', ${now.toISOString()}, true)`;
}

function paramUuid(c: Context<AppEnv>, name: string, notFound: string): string {
  const parsed = uuidSchema.safeParse(c.req.param(name));
  if (!parsed.success) throw new ApiError('NOT_FOUND', notFound);
  return parsed.data;
}

interface OwnedChild {
  readonly familyId: string;
  readonly childId: string;
  readonly gradeLevel: number;
  /** An archived profile is history only: its parents read it, nothing changes it. */
  readonly archived: boolean;
}

/**
 * `read`: a parent view of the child's history. `write`: anything that plans, stores or changes
 * something for the child (subjects, schedule, test dates, study material).
 */
type ChildAccess = 'read' | 'write';

function archivedChild(): ApiError {
  return businessRule(
    'CHILD_ARCHIVED',
    'This child’s profile is archived. Its history stays available, but nothing can be added or changed unless the profile is active again.',
  );
}

/**
 * The child must belong to the caller's live family. Cross-family and unknown ids, children of a
 * tombstoned family and a child whose data deletion is under way are all NOT_FOUND.
 *
 * Archived and downgraded (draft) profiles keep parent-readable history (spec P11 "keep history for
 * inactive profiles", AC_CAPACITY_08), so `read` admits every other profile. `write` refuses an
 * archived profile with CHILD_ARCHIVED. A draft profile stays editable, because a parent sets up the
 * plan before activation; no new practice work starts for it, since practice jobs are only created
 * for active profiles (loadChildContext).
 */
async function ownedChild(c: Context<AppEnv>, access: ChildAccess): Promise<OwnedChild> {
  const childId = paramUuid(c, 'childId', 'Child not found');
  const familyId = await currentFamilyId(c);
  const [row] = await c.var.deps.db.asParent(
    c.var.parent,
    (tx) => tx<{ grade_level: number; status: string }[]>`
      select c.grade_level, c.status from public.child_profiles c
        join public.families f on f.id = c.family_id and f.deleted_at is null
       where c.id = ${childId} and c.family_id = ${familyId}
         and not exists (
           select 1 from public.deletion_requests d
            where d.family_id = c.family_id and d.target_child_id = c.id
              and d.status in ('requested', 'processing'))`,
  );
  if (!row) throw new ApiError('NOT_FOUND', 'Child not found');
  const archived = row.status === 'archived';
  if (archived && access === 'write') throw archivedChild();
  return { familyId, childId, gradeLevel: row.grade_level, archived };
}

/**
 * A practice set of the caller's family whose child is still visible (not under a data deletion).
 * Archived children's sets stay readable and exportable (AC_CAPACITY_08: history and exports kept).
 */
async function ownedSet(
  c: Context<AppEnv>,
  familyId: string,
  setId: string,
): Promise<{ id: string; child_id: string } | undefined> {
  const [row] = await c.var.deps.db.asParent(
    c.var.parent,
    (tx) => tx<{ id: string; child_id: string }[]>`
      select s.id, s.child_id from public.practice_sets s
       where s.id = ${setId} and s.family_id = ${familyId}
         and not exists (
           select 1 from public.deletion_requests d
            where d.family_id = s.family_id and d.target_child_id = s.child_id
              and d.status in ('requested', 'processing'))`,
  );
  return row;
}

/** Service-role child context for scheduling side effects after a parent change. */
async function reschedule(c: Context<AppEnv>, owned: OwnedChild): Promise<void> {
  const { deps } = c.var;
  try {
    await deps.db.asService(async (tx) => {
      const ctx = await loadChildContext(tx, owned.familyId, owned.childId);
      if (ctx) await rescheduleReviewJobs(tx, ctx, deps.clock());
    });
  } catch {
    // The change itself is committed; the next scheduled tick reconciles the jobs.
    deps.log({ level: 'warn', event: 'learning_reschedule_deferred', requestId: c.var.requestId });
  }
}

// ---------------------------------------------------------------------------------------------
// DTO mappers (explicit fields only)
// ---------------------------------------------------------------------------------------------

interface SubjectRow {
  id: string;
  subject_key: string;
  display_name: string;
  enabled: boolean;
}

function toSubject(row: SubjectRow): ChildSubject {
  return {
    id: row.id,
    subjectKey: row.subject_key as ChildSubject['subjectKey'],
    displayName: row.display_name,
    enabled: row.enabled,
    generatedPractice: isBankSubject(row.subject_key),
  };
}

const RESPONSE_FORMATS = new Set(['number', 'division', 'choice', 'word', 'text']);

/** Rebuilds the child prompt from explicit fields only (unknown keys in storage are dropped). */
export function toChildPrompt(raw: unknown): ChildPromptDto {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const passage = r.passage as { title?: unknown; text?: unknown } | null | undefined;
  const choices = Array.isArray(r.choices)
    ? r.choices.filter((x): x is string => typeof x === 'string')
    : null;
  return {
    text: typeof r.text === 'string' ? r.text : '',
    choices,
    passage:
      passage && typeof passage.title === 'string' && typeof passage.text === 'string'
        ? { title: passage.title, text: passage.text }
        : null,
    responseFormat: (typeof r.responseFormat === 'string' && RESPONSE_FORMATS.has(r.responseFormat)
      ? r.responseFormat
      : 'text') as ChildPromptDto['responseFormat'],
    unitHint: typeof r.unitHint === 'string' ? r.unitHint : null,
  };
}

interface ProgressRow {
  question_instance_id: string;
  attempts: number;
  correct: boolean;
  first_try: 'correct' | 'incorrect' | null;
}

function itemStatus(
  progress: ProgressRow | undefined,
  targetCount: number,
): ChildPracticeItem['progress']['status'] {
  if (progress?.correct) return 'correct';
  if (targetCount >= MAX_TARGET_ATTEMPTS) return 'help_offered';
  if ((progress?.attempts ?? 0) > 0) return 'try_again';
  return 'not_started';
}

async function loadProgress(
  tx: Tx,
  childId: string,
  itemIds: readonly string[],
): Promise<{ progress: Map<string, ProgressRow>; targets: Map<string, number> }> {
  if (itemIds.length === 0) return { progress: new Map(), targets: new Map() };
  const rows = await tx<ProgressRow[]>`
    select question_instance_id, count(*)::int as attempts, bool_or(correctness = 'correct') as correct,
           (array_agg(correctness order by attempt_number))[1] as first_try
      from public.attempts
     where child_id = ${childId} and question_instance_id = any(${[...itemIds]}::uuid[])
       and correctness in ('correct', 'incorrect')
     group by question_instance_id`;
  const targets = await tx<{ question_instance_id: string; count: number }[]>`
    select question_instance_id, count from public.target_answer_attempts
     where child_id = ${childId} and question_instance_id = any(${[...itemIds]}::uuid[])`;
  return {
    progress: new Map(rows.map((r) => [r.question_instance_id, r])),
    targets: new Map(targets.map((t) => [t.question_instance_id, t.count])),
  };
}

interface ChildSetRow {
  id: string;
  kind: 'daily' | 'thursday_review' | 'top_up';
  subject_key: string | null;
  local_date: string | null;
  review_week: string | null;
  version: number;
  status: 'ready' | 'in_progress' | 'completed';
  release_at: Date | null;
  child_intro: string | null;
}

interface ChildItemRow {
  id: string;
  set_id: string;
  position: number;
  subject_key: string;
  skill: string;
  prompt: unknown;
}

/** Child sets (allowlisted columns, pl_child) with progress read by child id via the service role. */
async function childSets(
  c: Context<AppEnv>,
  child: ChildPrincipal,
  filter: { kind: 'daily'; localDate: string } | { kind: 'review'; weekKeys: readonly string[] },
): Promise<ChildPracticeSet[]> {
  const { deps } = c.var;
  const now = deps.clock();
  const { sets, items } = await deps.db.asChild(child, async (tx) => {
    await atRequestInstant(tx, now);
    const sets =
      filter.kind === 'daily'
        ? await tx<ChildSetRow[]>`
            select id, kind, subject_key, local_date::text as local_date, review_week, version, status, release_at, child_intro
              from public.practice_sets
             where child_id = ${child.childId} and kind = 'daily' and local_date = ${filter.localDate}::date
             order by version`
        : await tx<ChildSetRow[]>`
            select id, kind, subject_key, local_date::text as local_date, review_week, version, status, release_at, child_intro
              from public.practice_sets
             where child_id = ${child.childId} and kind in ('thursday_review', 'top_up')
               and review_week = any(${[...filter.weekKeys]}::text[])
             order by subject_key, review_week, version`;
    const released = sets.filter(
      (s) => s.release_at === null || s.release_at.getTime() <= now.getTime(),
    );
    const items =
      released.length === 0
        ? []
        : await tx<ChildItemRow[]>`
            select id, set_id, position, subject_key, skill, prompt from public.practice_items
             where child_id = ${child.childId} and set_id = any(${released.map((s) => s.id)}::uuid[])
             order by set_id, position`;
    return { sets: released, items };
  });
  const { progress, targets } = await deps.db.asService((tx) =>
    loadProgress(
      tx,
      child.childId,
      items.map((i) => i.id),
    ),
  );
  return sets.map((s) => ({
    id: s.id,
    kind: s.kind,
    status: s.status,
    subjectKey: s.subject_key,
    localDate: s.local_date,
    reviewWeek: s.review_week,
    version: s.version,
    optional: s.kind === 'top_up',
    intro: s.child_intro,
    items: items
      .filter((i) => i.set_id === s.id)
      .map((i) => ({
        id: i.id,
        position: i.position,
        subjectKey: i.subject_key,
        topic: skillLabel(i.skill),
        prompt: toChildPrompt(i.prompt),
        progress: {
          status: itemStatus(progress.get(i.id), targets.get(i.id) ?? 0),
          attempts: progress.get(i.id)?.attempts ?? 0,
        },
      })),
  }));
}

function scheduleDto(row: ScheduleRow): LearningScheduleResponse['schedule'] {
  return {
    reviewWeekday: row.review_weekday,
    reviewLocalTime: row.review_local_time,
    reviewQuestionsPerSubject: row.review_questions_per_subject,
    scheduleVersion: row.schedule_version,
    dailyLocalTime: row.daily_local_time,
    dailyQuestionCount: row.daily_question_count,
    pause: row.paused_from && row.paused_to ? { from: row.paused_from, to: row.paused_to } : null,
    quietHours:
      row.quiet_hours_start && row.quiet_hours_end
        ? { start: row.quiet_hours_start, end: row.quiet_hours_end }
        : null,
    childRemindersPermitted: row.child_reminders_permitted,
  };
}

/** What the schedule view needs: the saved plan, the family zone and the enabled subjects. */
type PlanContext = Pick<ChildContext, 'familyId' | 'childId' | 'zone' | 'schedule' | 'subjects'>;

/**
 * Migration 0100's `learning_schedules` column defaults: the plan a profile has before anything is
 * saved. tests/archived-history.test.ts pins this to the database defaults.
 */
const DEFAULT_SCHEDULE: ScheduleRow = {
  review_weekday: 4,
  review_local_time: '16:00',
  review_questions_per_subject: 8,
  schedule_version: 1,
  daily_local_time: '15:30',
  daily_question_count: 5,
  paused_from: null,
  paused_to: null,
  quiet_hours_start: null,
  quiet_hours_end: null,
  child_reminders_permitted: false,
};
/** Same fallback as loadChildContext (jobs/learning-jobs.ts) for a zone the scheduler can't use. */
const FALLBACK_ZONE = 'America/New_York';

/**
 * The saved plan of an archived profile, read as stored (history only). Unlike loadChildContext it
 * never creates defaults; a profile archived before anything was saved shows the defaults every new
 * profile starts with.
 */
async function storedPlan(tx: Tx, owned: OwnedChild): Promise<PlanContext> {
  const [family] = await tx<{ timezone: string }[]>`
    select timezone from public.families where id = ${owned.familyId}`;
  const [schedule] = await tx.unsafe<ScheduleRow[]>(
    `select ${SCHEDULE_COLUMNS} from public.learning_schedules where child_id = $1 and family_id = $2`,
    [owned.childId, owned.familyId],
  );
  const rows = await tx<{ subject_key: string }[]>`
    select subject_key from public.child_subjects
     where child_id = ${owned.childId} and family_id = ${owned.familyId} and enabled`;
  const enabled = new Set(rows.map((row) => row.subject_key));
  return {
    familyId: owned.familyId,
    childId: owned.childId,
    zone: family && isSchedulingZone(family.timezone) ? family.timezone : FALLBACK_ZONE,
    schedule: schedule ?? DEFAULT_SCHEDULE,
    subjects: BANK_SUBJECTS.filter((subject) => enabled.has(subject)),
  };
}

async function scheduleResponse(
  tx: Tx,
  ctx: PlanContext,
  now: Date,
): Promise<LearningScheduleResponse> {
  const nextReviewReleases: LearningScheduleResponse['nextReviewReleases'] = [];
  for (const weekKey of currentAndNextWeekKeys(now, ctx.zone)) {
    const { monday, sunday } = isoWeekDates(weekKey);
    const tests = await tx<{ subject_key: string; test_date: string }[]>`
      select s.subject_key, t.test_date::text as test_date from public.test_dates t
        join public.child_subjects s on s.id = t.subject_id
       where t.child_id = ${ctx.childId} and t.family_id = ${ctx.familyId}
         and t.test_date between ${monday}::date and ${sunday}::date`;
    const releases = reviewReleases({
      schedule: reviewScheduleFor(
        ctx,
        tests.map((t) => ({ subject: t.subject_key, testDate: t.test_date })),
      ),
      zone: ctx.zone,
      subjects: [...ctx.subjects],
      weekKey,
    });
    if (!releases.ok) continue;
    for (const r of releases.value) {
      if (r.releaseAt !== null && r.releaseAt.getTime() < now.getTime()) continue;
      if (!isBankSubject(r.subject)) continue;
      nextReviewReleases.push({
        subjectKey: r.subject,
        weekKey: r.weekKey,
        releaseAt: isoOrNull(r.releaseAt),
        reason: r.reason,
        testDate: r.testDate,
      });
    }
  }
  const daily = dailyPracticeState({
    zone: ctx.zone,
    now,
    settings: {
      localTime: ctx.schedule.daily_local_time,
      paused:
        ctx.schedule.paused_from && ctx.schedule.paused_to
          ? { from: ctx.schedule.paused_from, to: ctx.schedule.paused_to }
          : null,
      vacationDates: [],
      excludedSubjects: [],
    },
  });
  if (!daily.ok) throw new ApiError('INTERNAL', 'Schedule could not be computed');
  return {
    schedule: scheduleDto(ctx.schedule),
    timezone: ctx.zone,
    nextReviewReleases,
    dailyPractice: {
      localDate: daily.value.localDate,
      state: daily.value.reason,
      releaseAt: iso(daily.value.releaseAt),
    },
    pointsPolicy: {
      expireEarnedPoints: DAILY_PRACTICE_POINTS_POLICY.expireEarnedPoints,
      penalizeMissedDays: DAILY_PRACTICE_POINTS_POLICY.penalizeMissedDays,
    },
  };
}

/** Parent-scoped child context: the same loader, run as the parent (RLS member policies). */
async function parentContext(c: Context<AppEnv>, owned: OwnedChild): Promise<ChildContext> {
  const ctx = await c.var.deps.db.asParent(c.var.parent, (tx) =>
    loadChildContext(tx, owned.familyId, owned.childId, { requireActive: false }),
  );
  if (!ctx) throw new ApiError('NOT_FOUND', 'Child not found');
  return ctx;
}

const STATUS_LABELS: Readonly<Record<SkillSummaryDto['status'], string>> = {
  not_enough_evidence: 'Not enough evidence',
  needs_practice: 'Needs practice',
  developing: 'Developing',
  strong: 'Strong (still reviewed from time to time)',
};

const EVIDENCE_RULE =
  'Skills are summarized from first, unaided tries on different questions. Fewer than five such questions shows “Not enough evidence”. “Needs practice” means recent accuracy under 60% with mistakes on at least two questions and two days; “Strong” means at least 85% on two different days in the last 30 days. Answers after hints or retries count toward completion, not toward independent success. This is an educational signal, not a diagnosis or a test score.';

function mapRewardsRules(
  row:
    | {
        attempt_points: number;
        independent_correct_bonus: number;
        set_completion_points: number;
        min_meaningful_response_ms: number;
      }
    | undefined,
): RewardRules {
  if (!row) return DEFAULT_REWARD_RULES;
  const parsed = validateRules({
    attemptPoints: row.attempt_points,
    independentCorrectBonus: row.independent_correct_bonus,
    setCompletionPoints: row.set_completion_points,
    minMeaningfulResponseMs: Math.max(500, row.min_meaningful_response_ms),
    maxAwardsPerQuestionInstance: 1,
  });
  return parsed.ok ? parsed.value : DEFAULT_REWARD_RULES;
}

async function insertAwards(
  tx: Tx,
  familyId: string,
  childId: string,
  entries: readonly LedgerEntry[],
): Promise<number> {
  let total = 0;
  for (const entry of entries) {
    if (entry.points <= 0) continue; // a zero rule awards nothing (the ledger forbids 0-point rows)
    const rows = await tx<{ points: number }[]>`
      insert into public.points_ledger (family_id, child_id, kind, points, idempotency_key, reason, actor_kind)
      values (${familyId}, ${childId}, 'award', ${entry.points}, ${entry.idempotencyKey}, ${entry.reason ?? null}, 'system')
      on conflict (child_id, idempotency_key) do nothing
      returning points`;
    total += rows[0]?.points ?? 0;
  }
  return total;
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

export function learningRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  // Middleware is attached per route (never `use('*')`): this router shares the /v1 prefix.

  // ----- Subjects --------------------------------------------------------------------------------

  r.get('/children/:childId/subjects', requireParent, async (c) => {
    const owned = await ownedChild(c, 'read');
    const rows = await c.var.deps.db.asParent(c.var.parent, async (tx) => {
      // An archived profile's subjects are read as stored; defaults are created only for a live one.
      if (!owned.archived) await ensureLearningDefaults(tx, owned.familyId, owned.childId);
      return tx<SubjectRow[]>`
        select id, subject_key, display_name, enabled from public.child_subjects
         where child_id = ${owned.childId} and family_id = ${owned.familyId}
         order by coalesce(array_position(${[...SUBJECT_ORDER]}::text[], subject_key), 99),
                  created_at, lower(display_name), id`;
    });
    return c.json({ subjects: rows.map(toSubject) });
  });

  r.post('/children/:childId/subjects', requireParent, async (c) => {
    const owned = await ownedChild(c, 'write');
    const body = await readJson(c, createChildSubjectRequestSchema);
    const displayName =
      body.displayName ??
      (body.subjectKey === 'custom' ? 'Custom' : SUBJECT_DISPLAY_NAMES[body.subjectKey]);
    let row: SubjectRow | undefined;
    try {
      [row] = await c.var.deps.db.asParent(c.var.parent, async (tx) => {
        await ensureLearningDefaults(tx, owned.familyId, owned.childId);
        return tx<SubjectRow[]>`
          insert into public.child_subjects (family_id, child_id, subject_key, display_name, enabled)
          values (${owned.familyId}, ${owned.childId}, ${body.subjectKey}, ${displayName}, ${body.enabled ?? true})
          returning id, subject_key, display_name, enabled`;
      });
    } catch (error) {
      if (pgErrorCode(error) === '23505')
        throw new ApiError('CONFLICT', 'That subject already exists');
      throw error;
    }
    await reschedule(c, owned);
    return c.json({ subject: toSubject(row!) }, 201);
  });

  r.patch('/children/:childId/subjects', requireParent, async (c) => {
    const owned = await ownedChild(c, 'write');
    const body = await readJson(c, updateChildSubjectRequestSchema);
    let row: SubjectRow | undefined;
    try {
      [row] = await c.var.deps.db.asParent(
        c.var.parent,
        (tx) => tx<SubjectRow[]>`
          update public.child_subjects
             set enabled = coalesce(${body.enabled ?? null}::boolean, enabled),
                 display_name = coalesce(${body.displayName ?? null}::text, display_name)
           where id = ${body.subjectId} and child_id = ${owned.childId} and family_id = ${owned.familyId}
          returning id, subject_key, display_name, enabled`,
      );
    } catch (error) {
      if (pgErrorCode(error) === '23505')
        throw new ApiError('CONFLICT', 'That name is already used');
      throw error;
    }
    if (!row) throw new ApiError('NOT_FOUND', 'Subject not found');
    await reschedule(c, owned);
    return c.json({ subject: toSubject(row) });
  });

  // ----- Learning schedule -----------------------------------------------------------------------

  r.get('/children/:childId/learning-schedule', requireParent, async (c) => {
    const owned = await ownedChild(c, 'read');
    if (owned.archived) {
      const body = await c.var.deps.db.asParent(c.var.parent, async (tx) =>
        scheduleResponse(tx, await storedPlan(tx, owned), c.var.deps.clock()),
      );
      return c.json(body);
    }
    const ctx = await parentContext(c, owned);
    const body = await c.var.deps.db.asParent(c.var.parent, (tx) =>
      scheduleResponse(tx, ctx, c.var.deps.clock()),
    );
    return c.json(body);
  });

  r.put('/children/:childId/learning-schedule', requireParent, async (c) => {
    const owned = await ownedChild(c, 'write');
    const body = await readJson(c, updateLearningScheduleRequestSchema);
    await parentContext(c, owned); // creates defaults
    await c.var.deps.db.asParent(
      c.var.parent,
      (tx) => tx`
        update public.learning_schedules
           set review_weekday = ${body.reviewWeekday},
               review_local_time = ${body.reviewLocalTime}::time,
               review_questions_per_subject = ${body.reviewQuestionsPerSubject},
               daily_local_time = ${body.dailyLocalTime}::time,
               daily_question_count = ${body.dailyQuestionCount},
               paused_from = ${body.pause?.from ?? null}::date,
               paused_to = ${body.pause?.to ?? null}::date,
               quiet_hours_start = ${body.quietHours?.start ?? null}::time,
               quiet_hours_end = ${body.quietHours?.end ?? null}::time,
               child_reminders_permitted = ${body.childRemindersPermitted}
         where child_id = ${owned.childId} and family_id = ${owned.familyId}`,
    );
    await reschedule(c, owned);
    const ctx = await parentContext(c, owned);
    const response = await c.var.deps.db.asParent(c.var.parent, (tx) =>
      scheduleResponse(tx, ctx, c.var.deps.clock()),
    );
    return c.json(response);
  });

  // ----- Test dates ------------------------------------------------------------------------------

  const toTestDate = (row: {
    id: string;
    subject_id: string;
    subject_key: string;
    test_date: string;
    scope_notes: string | null;
  }): TestDate => ({
    id: row.id,
    subjectId: row.subject_id,
    subjectKey: row.subject_key as TestDate['subjectKey'],
    testDate: row.test_date,
    scopeNotes: row.scope_notes,
    matchedSkills:
      row.scope_notes && isBankSubject(row.subject_key)
        ? matchSkills(row.subject_key, row.scope_notes).map((skill) => ({
            skill,
            label: skillLabel(skill),
          }))
        : [],
  });

  r.get('/children/:childId/test-dates', requireParent, async (c) => {
    const owned = await ownedChild(c, 'read');
    const rows = await c.var.deps.db.asParent(
      c.var.parent,
      (tx) => tx<
        {
          id: string;
          subject_id: string;
          subject_key: string;
          test_date: string;
          scope_notes: string | null;
        }[]
      >`
        select t.id, t.subject_id, s.subject_key, t.test_date::text as test_date, t.scope_notes
          from public.test_dates t join public.child_subjects s on s.id = t.subject_id
         where t.child_id = ${owned.childId} and t.family_id = ${owned.familyId}
         order by t.test_date, t.id`,
    );
    return c.json({ testDates: rows.map(toTestDate) });
  });

  r.post('/children/:childId/test-dates', requireParent, async (c) => {
    const owned = await ownedChild(c, 'write');
    const body = await readJson(c, createTestDateRequestSchema);
    const scope =
      body.scopeNotes !== undefined && body.scopeNotes.length > 0 ? body.scopeNotes : null;
    let created;
    try {
      created = await c.var.deps.db.asParent(c.var.parent, async (tx) => {
        const [subject] = await tx<{ subject_key: string }[]>`
          select subject_key from public.child_subjects
           where id = ${body.subjectId} and child_id = ${owned.childId} and family_id = ${owned.familyId}`;
        if (!subject) return null;
        // The insert bumps the schedule version (migration 0650), so that subject's review is replanned.
        const [row] = await tx<{ id: string; test_date: string }[]>`
          insert into public.test_dates (family_id, child_id, subject_id, test_date, scope_notes)
          values (${owned.familyId}, ${owned.childId}, ${body.subjectId}, ${body.testDate}::date, ${scope})
          returning id, test_date::text as test_date`;
        return { ...row!, subject_key: subject.subject_key };
      });
    } catch (error) {
      if (pgErrorCode(error) === '23505')
        throw new ApiError('CONFLICT', 'That test date is already saved');
      throw error;
    }
    if (!created) throw new ApiError('NOT_FOUND', 'Subject not found');
    await reschedule(c, owned);
    return c.json(
      {
        testDate: toTestDate({
          id: created.id,
          subject_id: body.subjectId,
          subject_key: created.subject_key,
          test_date: created.test_date,
          scope_notes: scope,
        }),
      },
      201,
    );
  });

  r.delete('/children/:childId/test-dates/:testDateId', requireParent, async (c) => {
    const owned = await ownedChild(c, 'write');
    const testDateId = paramUuid(c, 'testDateId', 'Test date not found');
    const rows = await c.var.deps.db.asParent(
      c.var.parent,
      (tx) => tx`
        delete from public.test_dates
         where id = ${testDateId} and child_id = ${owned.childId} and family_id = ${owned.familyId}
        returning id`,
    );
    if (rows.length === 0) throw new ApiError('NOT_FOUND', 'Test date not found');
    await reschedule(c, owned);
    return c.body(null, 204);
  });

  // ----- Study material (text only, size-limited) ------------------------------------------------

  r.post('/children/:childId/study-materials', requireParent, async (c) => {
    const owned = await ownedChild(c, 'write');
    const body = await readJson(c, createStudyMaterialRequestSchema);
    if (body.text.length > STUDY_MATERIAL_MAX_CHARS[body.kind]) {
      throw new ApiError('PAYLOAD_TOO_LARGE', 'That is too long for this kind of material');
    }
    const words = body.kind === 'spelling_list' ? parseSpellingList(body.text) : null;
    if (words !== null && words.length === 0) {
      throw new ApiError('VALIDATION_FAILED', 'List at least one spelling word');
    }
    const result = await c.var.deps.db.asParent(c.var.parent, async (tx) => {
      let subjectKey: string | null = null;
      if (body.subjectId !== undefined) {
        const [subject] = await tx<{ subject_key: string }[]>`
          select subject_key from public.child_subjects
           where id = ${body.subjectId} and child_id = ${owned.childId} and family_id = ${owned.familyId}`;
        if (!subject) return null;
        subjectKey = subject.subject_key;
      }
      const [row] = await tx<{ id: string; created_at: Date }[]>`
        insert into public.study_materials (family_id, child_id, subject_id, kind, content_text)
        values (${owned.familyId}, ${owned.childId}, ${body.subjectId ?? null}, ${body.kind}, ${body.text})
        returning id, created_at`;
      return { row: row!, subjectKey };
    });
    if (!result) throw new ApiError('NOT_FOUND', 'Subject not found');
    const matchSubjects =
      result.subjectKey !== null
        ? isBankSubject(result.subjectKey)
          ? [result.subjectKey]
          : []
        : ([
            'math',
            'reading',
            'spelling_vocabulary',
            'grammar_writing',
            'science',
            'social_studies',
          ] as const);
    const matched =
      body.kind === 'taught_notes'
        ? [...new Set(matchSubjects.flatMap((s) => matchSkills(s, body.text)))]
        : body.kind === 'spelling_list'
          ? ['spelling.teacher_list']
          : ['reading.sequence', 'reading.literal_detail'];
    return c.json(
      {
        material: {
          id: result.row.id,
          kind: body.kind,
          subjectId: body.subjectId ?? null,
          createdAt: iso(result.row.created_at),
          spellingWords: words === null ? null : words.length,
          matchedSkills: matched.map((skill) => ({ skill, label: skillLabel(skill) })),
        },
      },
      201,
    );
  });

  // ----- Skill evidence (AC_LEARNING_01/02) ------------------------------------------------------

  r.get('/children/:childId/skills', requireParent, async (c) => {
    const owned = await ownedChild(c, 'read');
    const now = c.var.deps.clock();
    const { events, zone } = await c.var.deps.db.asParent(c.var.parent, async (tx) => {
      const [family] = await tx<
        { timezone: string }[]
      >`select timezone from public.families where id = ${owned.familyId}`;
      return {
        events: await loadEvidence(tx, owned, new Date(now.getTime() - 365 * 86_400_000)),
        zone: family?.timezone ?? 'UTC',
      };
    });
    const bySubject = new Map<string, AttemptEvent[]>();
    for (const e of events) bySubject.set(e.subject, [...(bySubject.get(e.subject) ?? []), e]);
    const skills: SkillSummaryDto[] = [];
    for (const [subject, list] of [...bySubject.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      let summaries;
      try {
        summaries = summarizeSkills(list, now, { timeZone: zone });
      } catch {
        continue; // an unreadable zone or event set never breaks the dashboard
      }
      for (const s of summaries) {
        skills.push({
          subjectKey: subject,
          skill: s.skill,
          label: skillDefinition(s.skill)?.label ?? s.skill,
          status: s.status,
          statusLabel: STATUS_LABELS[s.status],
          distinctQuestions: s.distinctQuestions,
          distinctIndependentQuestions: s.distinctIndependentQuestions,
          initialAccuracy: s.initialAccuracy,
          eventualCompletionRate: s.eventualCompletionRate,
          lastPracticedAt: isoOrNull(s.lastPracticedAt),
        });
      }
    }
    const coverage = bankCoverage(owned.gradeLevel);
    const body: SkillsResponse = {
      childId: owned.childId,
      skills,
      evidenceRule: EVIDENCE_RULE,
      coverage: {
        subjects: coverage.subjects.map((s) => ({
          subjectKey: s.subject,
          supportedSkills: s.skills.map((k) => ({ skill: k.skill, label: k.label })),
          unsupported: [...s.unsupported],
        })),
        general: [...coverage.general],
      },
    };
    return c.json(body);
  });

  // ----- Parent practice sets (questions only) ---------------------------------------------------

  r.get('/children/:childId/practice-sets', requireParent, async (c) => {
    const owned = await ownedChild(c, 'read');
    const kind = c.req.query('kind');
    const week = c.req.query('week');
    if (kind !== undefined && !['daily', 'thursday_review', 'top_up'].includes(kind)) {
      throw new ApiError('VALIDATION_FAILED', 'Unknown set kind');
    }
    if (week !== undefined && !/^\d{4}-W\d{2}$/.test(week)) {
      throw new ApiError('VALIDATION_FAILED', 'Week must be YYYY-Www');
    }
    const data = await c.var.deps.db.asParent(c.var.parent, async (tx) => {
      const sets = await tx<
        {
          id: string;
          kind: ParentPracticeSet['kind'];
          status: ParentPracticeSet['status'];
          subject_key: string | null;
          local_date: string | null;
          review_week: string | null;
          version: number;
          ready_at: Date | null;
          release_at: Date | null;
          mix: Record<string, unknown>;
          notes: unknown;
        }[]
      >`
        select id, kind, status, subject_key, local_date::text as local_date, review_week, version, ready_at,
               release_at, mix, notes
          from public.practice_sets
         where child_id = ${owned.childId} and family_id = ${owned.familyId}
           and (${kind ?? null}::text is null or kind = ${kind ?? null}::text)
           and (${week ?? null}::text is null or review_week = ${week ?? null}::text)
         order by created_at desc, id
         limit ${PARENT_SET_LIMIT}`;
      const items =
        sets.length === 0
          ? []
          : await tx<(ChildItemRow & { category: string })[]>`
              select id, set_id, position, subject_key, skill, category, prompt from public.practice_items
               where family_id = ${owned.familyId} and set_id = any(${sets.map((s) => s.id)}::uuid[])
               order by set_id, position`;
      const progress = await loadProgress(
        tx,
        owned.childId,
        items.map((i) => i.id),
      );
      return { sets, items, progress };
    });
    const sets: ParentPracticeSet[] = data.sets.map((s) => ({
      id: s.id,
      kind: s.kind,
      status: s.status,
      subjectKey: s.subject_key,
      localDate: s.local_date,
      reviewWeek: s.review_week,
      version: s.version,
      optional: s.kind === 'top_up',
      readyAt: isoOrNull(s.ready_at),
      releaseAt: isoOrNull(s.release_at),
      mix: Object.fromEntries(
        Object.entries(s.mix ?? {}).filter((e): e is [string, number] => typeof e[1] === 'number'),
      ),
      notes: Array.isArray(s.notes)
        ? s.notes.flatMap((n: unknown) => {
            const note = n as { code?: unknown; message?: unknown };
            return typeof note.code === 'string' && typeof note.message === 'string'
              ? [{ code: note.code, message: note.message }]
              : [];
          })
        : [],
      items: data.items
        .filter((i) => i.set_id === s.id)
        .map((i) => {
          const p = data.progress.progress.get(i.id);
          return {
            id: i.id,
            position: i.position,
            subjectKey: i.subject_key,
            skill: i.skill,
            topic: skillLabel(i.skill),
            category: i.category,
            prompt: toChildPrompt(i.prompt),
            progress: {
              status: itemStatus(p, data.progress.targets.get(i.id) ?? 0),
              attempts: p?.attempts ?? 0,
              firstTry: p?.first_try ?? null,
            },
          };
        }),
    }));
    return c.json({ sets });
  });

  // ----- Protected answer key (separate route, recent step-up; spec P8) ---------------------------

  r.get('/practice-sets/:id/answer-key', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const setId = paramUuid(c, 'id', 'Practice set not found');
    const familyId = await currentFamilyId(c);
    const owned = await ownedSet(c, familyId, setId);
    if (!owned) throw new ApiError('NOT_FOUND', 'Practice set not found');
    await assertRecentUnlock(c);
    const rows = await deps.db.asService(
      (tx) => tx<
        {
          id: string;
          position: number;
          prompt: unknown;
          answer_spec: unknown;
          explanation: string | null;
        }[]
      >`
        select i.id, i.position, i.prompt, k.answer_spec, k.explanation
          from public.practice_items i
          join private.practice_item_keys k on k.item_id = i.id and k.family_id = i.family_id
         where i.set_id = ${setId} and i.family_id = ${familyId}
         order by i.position`,
    );
    try {
      await deps.db.asService(
        (tx) => tx`
          insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id)
          values (${familyId}, ${parent.userId}, 'parent', 'practice.answer_key_viewed', 'practice_set', ${setId})`,
      );
    } catch {
      deps.log({ level: 'error', event: 'audit_write_failed', requestId: c.var.requestId });
    }
    const body: AnswerKeyResponse = {
      setId,
      items: rows.map((row) => {
        const key = parseStoredKey(row.answer_spec);
        const prompt = toChildPrompt(row.prompt);
        let answer = key ? keyAnswerText(key.spec) : 'Unavailable';
        if (key?.spec.kind === 'multiple_choice' && prompt.choices) {
          const index = key.spec.validLetters.indexOf(key.spec.letters[0] ?? '');
          const text = prompt.choices[index];
          if (text !== undefined) answer = `${answer}: ${text}`;
        }
        return { itemId: row.id, position: row.position, answer, explanation: row.explanation };
      }),
    };
    return c.json(body);
  });

  // ----- Review PDF export request (questions | answer key) --------------------------------------

  r.post('/exports/review-pdf', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const body = await readJson(c, reviewPdfExportRequestSchema);
    const familyId = await currentFamilyId(c);
    const set = await ownedSet(c, familyId, body.setId);
    if (!set) throw new ApiError('NOT_FOUND', 'Practice set not found');
    // Every export holds private family data; the answer key especially (spec P8). The database RPC
    // re-checks membership and the step-up.
    await assertRecentUnlock(c);
    await enforceRateLimit(
      deps.rateLimiter,
      `review-export:${familyId}`,
      REVIEW_EXPORT_RULE,
      deps.clock(),
    );
    const kind = body.variant === 'answer_key' ? 'review_answer_key_pdf' : 'review_questions_pdf';
    let exportId: string;
    try {
      const [created] = await deps.db.asParent(
        parent,
        (tx) =>
          tx<
            { id: string }[]
          >`select public.request_export(${familyId}, ${kind}, ${set.child_id}::uuid) as id`,
      );
      exportId = created!.id;
    } catch (error) {
      if (pgErrorCode(error) === '42501')
        throw new ApiError('STEP_UP_REQUIRED', 'Enter your parent PIN to continue');
      throw error;
    }
    try {
      await deps.db.asService(
        (tx) => tx`
          insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, run_after)
          values ('export_build', ${'export:' + exportId}, ${familyId}, ${set.child_id},
                  ${JSON.stringify({ exportId, setId: set.id })}::text::jsonb, ${deps.clock()})
          on conflict (idempotency_key) do nothing`,
      );
    } catch (error) {
      await deps.db.asService(
        (tx) =>
          tx`update public.data_exports set status = 'failed' where id = ${exportId} and family_id = ${familyId}`,
      );
      throw error;
    }
    return c.json({ exportId, kind, status: 'queued' as const }, 202);
  });

  // ----- Child: today's practice and this week's review ------------------------------------------

  r.get('/child/practice/today', requireChild, async (c) => {
    const { deps, child } = c.var;
    const now = deps.clock();
    const ctx = await deps.db.asService((tx) =>
      loadChildContext(tx, child.familyId, child.childId),
    );
    if (!ctx) {
      const body: ChildPracticeToday = {
        state: 'not_scheduled',
        localDate: now.toISOString().slice(0, 10),
        releaseAt: null,
        set: null,
      };
      return c.json(body);
    }
    const state = dailyPracticeState({
      zone: ctx.zone,
      now,
      settings: {
        localTime: ctx.schedule.daily_local_time,
        paused:
          ctx.schedule.paused_from && ctx.schedule.paused_to
            ? { from: ctx.schedule.paused_from, to: ctx.schedule.paused_to }
            : null,
        vacationDates: [],
        excludedSubjects: [],
      },
    });
    if (!state.ok) throw new ApiError('INTERNAL', 'Schedule could not be computed');
    const { localDate, releaseAt, reason } = state.value;
    const [set] = await childSets(c, child, { kind: 'daily', localDate });
    let body: ChildPracticeToday;
    if (set) {
      body = { state: 'available', localDate, releaseAt: iso(releaseAt), set };
    } else if (reason === 'paused' || reason === 'vacation') {
      body = { state: 'paused', localDate, releaseAt: iso(releaseAt), set: null };
    } else if (reason === 'not_yet_released' || ctx.subjects.length === 0) {
      body = { state: 'not_scheduled', localDate, releaseAt: iso(releaseAt), set: null };
    } else {
      // Released but not generated yet (e.g. a new child): make sure the durable job exists.
      const job = await deps.db.asService(async (tx) => {
        await enqueueDailyJob(tx, ctx, now, true);
        const [row] = await tx<{ status: string }[]>`
          select status from public.jobs where kind = 'daily_set_generate'
             and child_id = ${child.childId} and family_id = ${child.familyId} and payload->>'localDate' = ${localDate}
           order by created_at desc limit 1`;
        return row;
      });
      const finished =
        job !== undefined &&
        ['succeeded', 'failed_final', 'dead_letter', 'cancelled'].includes(job.status);
      body = {
        state: finished ? 'not_scheduled' : 'preparing',
        localDate,
        releaseAt: iso(releaseAt),
        set: null,
      };
    }
    return c.json(body);
  });

  r.get('/child/reviews/current', requireChild, async (c) => {
    const { deps, child } = c.var;
    const now = deps.clock();
    const ctx = await deps.db.asService((tx) =>
      loadChildContext(tx, child.familyId, child.childId),
    );
    const zone = ctx?.zone ?? 'UTC';
    const weekKey = reviewWeekKey(now, zone);
    if (!ctx) {
      const body: ChildReviews = { weekKey, state: 'not_scheduled', sections: [] };
      return c.json(body);
    }
    // A Monday test releases its review on Sunday but is keyed to the test's week, so released
    // sets of next week are included too. Calendar week, not now + 168 h (DST; RV-learning-api-5).
    const nextWeek = nextReviewWeekKey(now, zone);
    const sets = await childSets(c, child, { kind: 'review', weekKeys: [weekKey, nextWeek] });
    const names = await deps.db.asChild(
      child,
      (tx) => tx<{ subject_key: string; display_name: string }[]>`
        select subject_key, display_name from public.child_subjects
         where child_id = ${child.childId} order by id`,
    );
    const nameOf = (key: string) => names.find((n) => n.subject_key === key)?.display_name ?? key;
    const subjects = [...new Set(sets.map((s) => s.subjectKey ?? ''))].filter((s) => s.length > 0);
    let state: ChildReviews['state'] = sets.length > 0 ? 'available' : 'not_scheduled';
    if (sets.length === 0) {
      const [pending] = await deps.db.asService(
        (tx) => tx<{ id: string }[]>`
          select id from public.jobs
           where kind = 'thursday_review_generate' and child_id = ${child.childId} and family_id = ${child.familyId}
             and payload->>'weekKey' = any(${[weekKey, nextWeek]}::text[]) and status in ('queued', 'running', 'failed_retryable')
             and (payload->>'releaseAt')::timestamptz <= ${now}
           limit 1`,
      );
      if (pending) state = 'preparing';
    }
    const body: ChildReviews = {
      weekKey,
      state,
      sections: subjects.map((subjectKey) => ({
        subjectKey,
        displayName: nameOf(subjectKey),
        sets: sets.filter((s) => s.subjectKey === subjectKey),
      })),
    };
    return c.json(body);
  });

  // ----- Child: answer a practice question (graded server-side) ----------------------------------

  r.post('/child/practice/items/:itemId/answer', requireChild, async (c) => {
    const { deps, child } = c.var;
    const itemId = paramUuid(c, 'itemId', 'Question not found');
    await enforceRateLimit(
      deps.rateLimiter,
      `practice-answer:${child.childId}`,
      CHILD_ANSWER_RULE,
      deps.clock(),
    );
    const body = await readJson(c, practiceAnswerRequestSchema);
    const now = deps.clock();
    // First layer: the child's own session must be able to see the item (RLS + column grants,
    // including the release instant).
    const [visible] = await deps.db.asChild(child, async (tx) => {
      await atRequestInstant(tx, now);
      return tx<{ id: string; set_id: string; release_at: Date | null }[]>`
        select i.id, i.set_id, s.release_at from public.practice_items i
          join public.practice_sets s on s.id = i.set_id
         where i.id = ${itemId} and i.child_id = ${child.childId}`;
    });
    if (!visible || (visible.release_at !== null && visible.release_at.getTime() > now.getTime())) {
      throw new ApiError('NOT_FOUND', 'Question not found');
    }
    const attemptKey = `practice:${itemId}:${body.idempotencyKey}`;
    const result = await deps.db.asService(async (tx): Promise<PracticeAnswerResponse | null> => {
      const [item] = await tx<
        {
          set_id: string;
          subject_key: string;
          skill: string;
          kind: 'daily' | 'thursday_review' | 'top_up';
          set_status: string;
          release_at: Date | null;
          ready_at: Date | null;
        }[]
      >`
        select i.set_id, i.subject_key, i.skill, s.kind, s.status as set_status, s.release_at, s.ready_at
          from public.practice_items i
          join public.practice_sets s on s.id = i.set_id and s.family_id = i.family_id
          join public.families f on f.id = i.family_id and f.deleted_at is null
         where i.id = ${itemId} and i.child_id = ${child.childId} and i.family_id = ${child.familyId}
           and s.status in ('ready', 'in_progress', 'completed')`;
      if (!item) return null;
      // Serialize every submission within the SET first (lock order: set, then question). Two
      // devices finishing the last two open questions at once otherwise each counted the other's
      // question as still open and nobody completed the set (review finding RV-learning-api-4).
      // The status is re-read under the lock: another answer may have completed the set.
      const [locked] = await tx<{ status: string }[]>`
        select status from public.practice_sets
         where id = ${item.set_id} and family_id = ${child.familyId}
           and status in ('ready', 'in_progress', 'completed')
           for no key update`;
      if (!locked) return null;
      const setStatus = locked.status;
      // Serialize every submission for this question (duplicates, double taps, two devices).
      await tx`
        insert into public.target_answer_attempts (question_instance_id, family_id, child_id, count)
        values (${itemId}, ${child.familyId}, ${child.childId}, 0)
        on conflict (question_instance_id) do nothing`;
      const [target] = await tx<{ count: number; child_id: string }[]>`
        select count, child_id from public.target_answer_attempts where question_instance_id = ${itemId} for update`;
      if (!target || target.child_id !== child.childId) return null;
      const history = await tx<
        { attempt_number: number; correctness: string; idempotency_key: string }[]
      >`
        select attempt_number, correctness, idempotency_key from public.attempts
         where question_instance_id = ${itemId} and child_id = ${child.childId}
         order by attempt_number`;
      const graded = history.filter(
        (h) => h.correctness === 'correct' || h.correctness === 'incorrect',
      );
      const solved = graded.some((h) => h.correctness === 'correct');
      const unsuccessful = target.count;
      const status = (count: number, correct: boolean): PracticeAnswerResponse['itemStatus'] =>
        correct
          ? 'correct'
          : count >= MAX_TARGET_ATTEMPTS
            ? 'help_offered'
            : count > 0
              ? 'try_again'
              : 'not_started';

      // Idempotent replay: the same submission returns its recorded outcome and awards nothing new.
      const replay = history.find((h) => h.idempotency_key === attemptKey);
      if (replay) {
        const setDone = setStatus === 'completed';
        return {
          result: replay.correctness === 'correct' ? 'correct' : 'try_again',
          attemptNumber: graded.length,
          offerHelp: !solved && unsuccessful >= MAX_TARGET_ATTEMPTS,
          itemStatus: status(unsuccessful, solved),
          pointsAwarded: 0,
          setCompleted: setDone,
        };
      }
      // After three unsuccessful tries: no more grading of this question (no answer enumeration),
      // but no lockout either: method practice / a grown-up's help is offered (spec P6).
      if (
        !solved &&
        evaluateRetry({
          targetAnswerAttempts: unsuccessful,
          maxTargetAttempts: MAX_TARGET_ATTEMPTS,
        }) !== 'allow_retry'
      ) {
        return {
          result: 'unresolved',
          attemptNumber: graded.length,
          offerHelp: true,
          itemStatus: 'help_offered',
          pointsAwarded: 0,
          setCompleted: setStatus === 'completed',
        };
      }
      const [keyRow] = await tx<{ answer_spec: unknown }[]>`
        select answer_spec from private.practice_item_keys where item_id = ${itemId} and family_id = ${child.familyId}`;
      const key = parseStoredKey(keyRow?.answer_spec);
      if (!key) {
        deps.log({ level: 'error', event: 'practice_key_invalid', code: 'KEY_UNAVAILABLE' });
        return {
          result: 'unresolved',
          attemptNumber: graded.length,
          offerHelp: false,
          itemStatus: status(unsuccessful, solved),
          pointsAwarded: 0,
          setCompleted: setStatus === 'completed',
        };
      }
      const verdict = gradeBankAnswer(key.spec, body.answer).verdict;
      if (verdict !== 'correct' && verdict !== 'incorrect') {
        // Unreadable/blank input is neither right nor wrong: nothing is recorded or awarded.
        return {
          result: 'unresolved',
          attemptNumber: graded.length,
          offerHelp: false,
          itemStatus: status(unsuccessful, solved),
          pointsAwarded: 0,
          setCompleted: setStatus === 'completed',
        };
      }
      if (solved) {
        // Practicing an already-solved question again: feedback only, no new evidence or points.
        return {
          result: verdict === 'correct' ? 'correct' : 'try_again',
          attemptNumber: graded.length,
          offerHelp: false,
          itemStatus: 'correct',
          pointsAwarded: 0,
          setCompleted: setStatus === 'completed',
        };
      }
      const attemptNumber = (history.at(-1)?.attempt_number ?? 0) + 1;
      const [previous] = await tx<{ at: Date | null }[]>`
        select max(a.occurred_at) as at from public.attempts a
          join public.practice_items i on i.id = a.question_instance_id
         where i.set_id = ${item.set_id} and a.child_id = ${child.childId}`;

      // Points (spec P9): effort + independent-correct bonus once per question, completion once per set.
      const [rulesRow] = await tx<
        {
          attempt_points: number;
          independent_correct_bonus: number;
          set_completion_points: number;
          min_meaningful_response_ms: number;
        }[]
      >`
        select attempt_points, independent_correct_bonus, set_completion_points, min_meaningful_response_ms
          from public.reward_rules where family_id = ${child.familyId}`;
      const rules = mapRewardsRules(rulesRow);
      const since = previous?.at ?? item.release_at ?? item.ready_at ?? now;
      const attemptEvent = {
        kind: 'practice_attempt',
        childId: child.childId,
        questionInstanceId: itemId,
        answerText: body.answer,
        responseTimeMs: Math.max(0, now.getTime() - since.getTime()),
        independentCorrect: verdict === 'correct' && attemptNumber === 1,
      } as const;
      // Meaningful = the attempt meets the earning rule (non-empty answer, not faster than the
      // family's minimum response time): exactly when a fresh question would earn its effort award.
      const fresh = computeAwards(attemptEvent, rules, []);
      const meaningful = fresh.ok && fresh.value.length > 0;

      // evidence_key: a digest of the private instance key, so the same bank question served again
      // in a later set is one distinct question in the evidence (spec P7; RV-learning-api-1).
      await tx`
        insert into public.attempts (family_id, child_id, question_instance_id, source, subject_key, skill,
                                     attempt_number, hints_used, correctness, grader_version, idempotency_key,
                                     occurred_at, evidence_key, meaningful)
        values (${child.familyId}, ${child.childId}, ${itemId}, ${item.kind === 'daily' ? 'daily' : 'review'},
                ${item.subject_key}, ${item.skill}, ${attemptNumber}, 0, ${verdict}, ${PRACTICE_GRADER_VERSION},
                ${attemptKey}, ${now}, 'bank:' || encode(sha256(convert_to(${key.instanceKey}::text, 'UTF8')), 'hex'),
                ${meaningful})`;
      let count = unsuccessful;
      if (verdict === 'incorrect') {
        const [updated] = await tx<{ count: number }[]>`
          update public.target_answer_attempts set count = count + 1, updated_at = now()
           where question_instance_id = ${itemId} returning count`;
        count = updated?.count ?? unsuccessful + 1;
      }

      const keys = [`attempt:${itemId}`, `independent:${itemId}`, `set:${item.set_id}`];
      const existing = await tx<{ idempotency_key: string }[]>`
        select idempotency_key from public.points_ledger
         where child_id = ${child.childId} and idempotency_key = any(${keys})`;
      const awards = computeAwards(
        attemptEvent,
        rules,
        existing.map((e) => e.idempotency_key),
      );
      let points = awards.ok
        ? await insertAwards(tx, child.familyId, child.childId, awards.value)
        : 0;

      // Set progress: ready -> in_progress -> completed (every question solved or help offered).
      await tx`
        update public.practice_sets set status = 'in_progress'
         where id = ${item.set_id} and family_id = ${child.familyId} and status = 'ready'`;
      const [remaining] = await tx<{ n: number }[]>`
        select count(*)::int as n from public.practice_items i
         where i.set_id = ${item.set_id}
           and not exists (select 1 from public.attempts a
                            where a.question_instance_id = i.id and a.correctness = 'correct')
           and coalesce((select t.count from public.target_answer_attempts t
                          where t.question_instance_id = i.id), 0) < ${MAX_TARGET_ATTEMPTS}`;
      let setCompleted = setStatus === 'completed';
      if ((remaining?.n ?? 1) === 0) {
        const done = await tx`
          update public.practice_sets set status = 'completed'
           where id = ${item.set_id} and family_id = ${child.familyId} and status in ('ready', 'in_progress')
          returning id`;
        setCompleted = true;
        // Completion points for daily sets and weekly reviews; optional top-ups earn per-question
        // points only, so late-scan versions can never multiply completion awards (AC_LEARNING_09).
        // Decision: the award also needs meaningful work on EVERY question (at least one attempt
        // meeting the earning rule); a set finished only by rapid guesses completes but earns no
        // completion points (spec P9 anti-farming; review finding RV-learning-api-3).
        const [unearned] = await tx<{ n: number }[]>`
          select count(*)::int as n from public.practice_items i
           where i.set_id = ${item.set_id}
             and not exists (select 1 from public.attempts a
                              where a.question_instance_id = i.id and a.child_id = ${child.childId}
                                and a.meaningful)`;
        if (done.length > 0 && item.kind !== 'top_up' && (unearned?.n ?? 1) === 0) {
          const completion = computeAwards(
            { kind: 'set_completed', childId: child.childId, setId: item.set_id },
            rules,
            existing.map((e) => e.idempotency_key),
          );
          if (completion.ok)
            points += await insertAwards(tx, child.familyId, child.childId, completion.value);
        }
      }
      const correct = verdict === 'correct';
      return {
        result: correct ? 'correct' : 'try_again',
        attemptNumber: graded.length + 1,
        offerHelp: !correct && count >= MAX_TARGET_ATTEMPTS,
        itemStatus: status(count, correct),
        pointsAwarded: points,
        setCompleted,
      };
    });
    if (!result) throw new ApiError('NOT_FOUND', 'Question not found');
    return c.json(result);
  });

  return r;
}
