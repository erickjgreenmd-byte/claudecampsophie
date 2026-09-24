// Pure planning glue between learning evidence and bank selection (spec P7, P8): maps recorded
// attempts onto bank skills, summarizes them per subject, and derives the skill lists that
// `composeDailySet` and `composeThursdayReview` consume. Deterministic; `now` is an input.
import {
  prioritizeSkills,
  rankWeeklyWeaknesses,
  summarizeSkills,
  type AttemptEvent,
  type EvidenceWindow,
  type SkillSummary,
} from '../learning/index.ts';
import { gradeSkills } from './generate.ts';
import { bankSkillFor, prerequisiteMap } from './skills.ts';
import { BANK_SUBJECTS, type BankSubject } from './types.ts';

const DAY_MS = 86_400_000;
/** Decision: a skill is due for spaced review once it has not been practiced for 3 days. */
export const SPACED_REVIEW_AFTER_DAYS = 3;

/**
 * Keeps events of enabled bank subjects whose skill maps onto a bank skill and rewrites `skill` to
 * that bank skill. Homework labels ("fraction addition") become bank skills by keyword; events
 * without a bank skill are dropped (they stay evidence on the dashboard, not selection input).
 */
export function mapEventsToBankSkills(
  events: readonly AttemptEvent[],
  subjects: readonly BankSubject[],
): AttemptEvent[] {
  const enabled = new Set<string>(subjects);
  const out: AttemptEvent[] = [];
  for (const event of events) {
    if (!enabled.has(event.subject)) continue;
    const skill = bankSkillFor(event.subject, event.skill);
    if (skill === null) continue;
    out.push(skill === event.skill ? event : { ...event, skill });
  }
  return out;
}

/** Summaries per subject (a skill key belongs to exactly one subject), in subject order. */
export function summarizeBySubject(
  events: readonly AttemptEvent[],
  now: Date,
  timeZone: string,
): SkillSummary[] {
  const out: SkillSummary[] = [];
  for (const subject of BANK_SUBJECTS) {
    const subjectEvents = events.filter((e) => e.subject === subject);
    if (subjectEvents.length > 0) out.push(...summarizeSkills(subjectEvents, now, { timeZone }));
  }
  return out;
}

/**
 * Interleaves per-subject skill lists (math, reading, ...) starting at `rotation`, so a short set
 * covers several subjects and the starting subject changes from day to day.
 */
export function interleaveBySubject(
  lists: ReadonlyMap<BankSubject, readonly string[]>,
  rotation: number,
): string[] {
  const subjects = BANK_SUBJECTS.filter((s) => (lists.get(s)?.length ?? 0) > 0);
  if (subjects.length === 0) return [];
  const start = ((rotation % subjects.length) + subjects.length) % subjects.length;
  const ordered = [...subjects.slice(start), ...subjects.slice(0, start)];
  const out: string[] = [];
  const seen = new Set<string>();
  const max = Math.max(...ordered.map((s) => lists.get(s)?.length ?? 0));
  for (let i = 0; i < max; i += 1) {
    for (const subject of ordered) {
      const skill = lists.get(subject)?.[i];
      if (skill !== undefined && !seen.has(skill)) {
        seen.add(skill);
        out.push(skill);
      }
    }
  }
  return out;
}

export interface DailySkillPlan {
  readonly weakSkills: string[];
  readonly prerequisiteSkills: string[];
  readonly spacedReviewSkills: string[];
  readonly confidenceSkills: string[];
  readonly currentMaterialSkills: string[];
  readonly gradeFallbackSkills: string[];
  readonly summaries: readonly SkillSummary[];
}

/**
 * Skill lists for one day's set. Weak skills come from `prioritizeSkills` (repeated independent
 * errors first, then recent study, then accuracy gap); prerequisites that only underlie a weak skill
 * are listed separately; spaced review is the least recently practiced non-weak skills; confidence is
 * strong skills (the composer prefers accessible items there); the grade fallback interleaves
 * subjects starting from a daily rotation.
 */
export function planDailySkills(input: {
  readonly events: readonly AttemptEvent[];
  readonly subjects: readonly BankSubject[];
  readonly grade: number;
  readonly now: Date;
  readonly timeZone: string;
  /** Bank skills from current study material (test scope, taught notes, spelling list). */
  readonly currentMaterialSkills: readonly string[];
  readonly rotation: number;
}): DailySkillPlan {
  const mapped = mapEventsToBankSkills(input.events, input.subjects);
  const summaries = summarizeBySubject(mapped, input.now, input.timeZone);
  const bySkill = new Map(summaries.map((s) => [s.skill, s]));
  const current = [...new Set(input.currentMaterialSkills)];
  const ranked = prioritizeSkills(summaries, {
    recentStudySkills: new Set(current),
    prerequisites: prerequisiteMap(),
    now: input.now,
  });
  const weak: string[] = [];
  const prerequisites: string[] = [];
  for (const r of ranked) {
    const summary = bySkill.get(r.skill);
    const struggling =
      r.reasons.includes('REPEATED_INDEPENDENT_ERRORS') ||
      summary?.status === 'needs_practice' ||
      (summary !== undefined &&
        (summary.independentIncorrect > 0 || (summary.eventualCompletionRate ?? 1) < 1));
    if (struggling) weak.push(r.skill);
    else if (r.reasons.includes('UNRESOLVED_PREREQUISITE')) prerequisites.push(r.skill);
  }
  const weakSet = new Set(weak);
  const cutoff = input.now.getTime() - SPACED_REVIEW_AFTER_DAYS * DAY_MS;
  const spaced = summaries
    .filter(
      (s) =>
        !weakSet.has(s.skill) &&
        s.lastPracticedAt !== null &&
        s.lastPracticedAt.getTime() <= cutoff,
    )
    .sort(
      (a, b) =>
        (a.lastPracticedAt?.getTime() ?? 0) - (b.lastPracticedAt?.getTime() ?? 0) ||
        (a.skill < b.skill ? -1 : 1),
    )
    .map((s) => s.skill);
  const confidence = summaries
    .filter((s) => s.status === 'strong')
    .sort(
      (a, b) =>
        (b.weightedIndependentAccuracy ?? 0) - (a.weightedIndependentAccuracy ?? 0) ||
        (a.skill < b.skill ? -1 : 1),
    )
    .map((s) => s.skill);
  const fallback = interleaveBySubject(
    new Map(input.subjects.map((subject) => [subject, gradeSkills(subject, input.grade)])),
    input.rotation,
  );
  return {
    weakSkills: weak,
    prerequisiteSkills: prerequisites,
    spacedReviewSkills: spaced,
    confidenceSkills: confidence,
    currentMaterialSkills: current,
    gradeFallbackSkills: fallback,
    summaries,
  };
}

export interface ReviewSkillPlan {
  readonly weeklyWeaknesses: readonly string[];
  readonly cumulativeSkills: readonly string[];
  readonly gradeFallback: readonly string[];
}

/**
 * Skill lists for one subject's Thursday review: the week's weaker concepts from evidence inside
 * `window` (see `rankWeeklyWeaknesses`), cumulative review from skills practiced before the window
 * (least recent first) and the grade-level fallback.
 */
export function planReviewSkills(input: {
  readonly events: readonly AttemptEvent[];
  readonly subject: BankSubject;
  readonly grade: number;
  readonly window: EvidenceWindow;
  readonly timeZone: string;
}): ReviewSkillPlan {
  const mapped = mapEventsToBankSkills(input.events, [input.subject]);
  const weekly =
    mapped.length > 0
      ? rankWeeklyWeaknesses(mapped, input.window)
      : new Map<string, readonly string[]>();
  const before = mapped.filter((e) => e.occurredAt.getTime() < input.window.from.getTime());
  const summaries =
    before.length > 0
      ? summarizeSkills(before, input.window.from, { timeZone: input.timeZone })
      : [];
  const cumulative = [...summaries]
    .sort(
      (a, b) =>
        (a.lastPracticedAt?.getTime() ?? 0) - (b.lastPracticedAt?.getTime() ?? 0) ||
        (a.skill < b.skill ? -1 : 1),
    )
    .map((s) => s.skill);
  return {
    weeklyWeaknesses: weekly.get(input.subject) ?? [],
    cumulativeSkills: cumulative,
    gradeFallback: gradeSkills(input.subject, input.grade),
  };
}
