// Thursday review composition (spec P8, AC_LEARNING_07). Scheduling, time zones, idempotent jobs
// and versioned top-ups live in the scheduling module; this module decides what goes in a review
// from Monday-to-cutoff evidence, the teacher's test scope and cumulative review needs.
import { err, ok, type Result } from '../shared/result.ts';
import {
  compareIds,
  isValidIdentifier,
  isValidInstant,
  normalizeEvents,
  readInstances,
  type AttemptEvent,
} from './evidence.ts';
import {
  countBackfills,
  normalizeCandidates,
  selectItems,
  uniqueSkills,
  type CandidateItem,
  type ItemCategory,
  type SelectionGroup,
  type SelectionStage,
} from './selection.ts';

export const DEFAULT_REVIEW_ITEMS_PER_SUBJECT = 8;
/** Decision: parent-adjustable review length is bounded to 2..20 questions per subject. */
export const MIN_REVIEW_ITEMS_PER_SUBJECT = 2;
export const MAX_REVIEW_ITEMS_PER_SUBJECT = 20;
/** Decision: the evidence window is at most one week (Monday to the cutoff). */
export const MAX_EVIDENCE_WINDOW_DAYS = 7;
/**
 * Decision: when the teacher supplied a test scope with bank material, at least this many
 * weakness questions cover it. An in-scope weekly weakness counts; otherwise a slot is kept for a
 * test-scope question even when the week has six or more other weaknesses (AC_LEARNING_07).
 */
export const MIN_TEST_SCOPE_QUESTIONS = 1;

const DAY_MS = 86_400_000;

export const REVIEW_PARTS = ['weakness', 'cumulative'] as const;
export type ReviewPart = (typeof REVIEW_PARTS)[number];

export const REVIEW_ITEM_SOURCES = [
  'weekly_weakness',
  'test_scope',
  'prerequisite',
  'current_material',
  'cumulative',
  'grade_fallback',
] as const;
export type ReviewItemSource = (typeof REVIEW_ITEM_SOURCES)[number];

export const REVIEW_BASES = [
  'weekly_evidence',
  'current_material',
  'fallback_no_evidence',
] as const;
export type ReviewBasis = (typeof REVIEW_BASES)[number];

export const THURSDAY_REVIEW_ERROR_CODES = [
  'NO_ENABLED_SUBJECTS',
  'INVALID_SUBJECT',
  'INVALID_ITEM_COUNT',
  'INVALID_EVIDENCE_WINDOW',
  'INVALID_CANDIDATE',
] as const;
export type ThursdayReviewErrorCode = (typeof THURSDAY_REVIEW_ERROR_CODES)[number];

/** Evidence counted for a review: `from <= occurredAt < cutoff` (later work goes to top-ups). */
export interface EvidenceWindow {
  readonly from: Date;
  readonly cutoff: Date;
}

export interface ReviewCandidateItem extends CandidateItem {
  readonly subject: string;
}

export interface ThursdayReviewInput {
  readonly enabledSubjects: readonly string[];
  /** Questions per subject; default 8 (6 weakness + 2 cumulative). */
  readonly perSubjectCount?: number;
  /** Cumulative/spaced questions per subject; default derived by `reviewSplit`. */
  readonly cumulativeCount?: number;
  readonly evidenceWindow: EvidenceWindow;
  /** subject -> weak skills from the window, most urgent first (see `rankWeeklyWeaknesses`). */
  readonly subjectEvidence: ReadonlyMap<string, readonly string[]>;
  /** subject -> skills in the teacher-supplied test scope. */
  readonly testScope?: ReadonlyMap<string, readonly string[]>;
  /** subject -> skills due for cumulative/spaced review. */
  readonly cumulativeSkills?: ReadonlyMap<string, readonly string[]>;
  /** subject -> grade-level skills for the parent-selected grade. */
  readonly gradeFallback: ReadonlyMap<string, readonly string[]>;
  /** skill -> prerequisite skills. */
  readonly prerequisites?: ReadonlyMap<string, readonly string[]>;
  /** subject -> current study material (what was taught, study guides, spelling lists). */
  readonly currentMaterial?: ReadonlyMap<string, readonly string[]>;
  readonly candidateItems: readonly ReviewCandidateItem[];
  readonly recentlyUsedTemplateKeys?: ReadonlySet<string>;
}

export interface ReviewItem {
  readonly templateKey: string;
  readonly skill: string;
  readonly subject: string;
  readonly category: ItemCategory;
  readonly part: ReviewPart;
  readonly source: ReviewItemSource;
  readonly reusedRecentTemplate: boolean;
}

export type ReviewNote =
  | {
      readonly code: 'FILLED';
      readonly part: ReviewPart;
      readonly source: ReviewItemSource;
      readonly count: number;
    }
  | { readonly code: 'INSUFFICIENT_CANDIDATES'; readonly part: ReviewPart; readonly count: number }
  | {
      /** `count` is the number of distinct weekly weak skills for the first three codes. */
      readonly code:
        | 'FEWER_DISTINCT_WEAKNESSES'
        | 'NO_WEEKLY_WEAKNESSES'
        | 'FALLBACK_NO_EVIDENCE'
        | 'RECENT_TEMPLATE_REUSED';
      readonly count: number;
    };

/** A short subject section that can be completed separately (P8). */
export interface ReviewSection {
  readonly subject: string;
  readonly basis: ReviewBasis;
  /** Weakness items first, then cumulative items. */
  readonly items: readonly ReviewItem[];
  readonly notes: readonly ReviewNote[];
}

export interface ThursdayReview {
  readonly evidenceWindow: EvidenceWindow;
  readonly sections: readonly ReviewSection[];
  readonly totalItems: number;
}

/**
 * Splits a subject's review length into weakness and cumulative questions, keeping the default
 * 6:2 proportion: cumulative = round-half-up(count / 4), weakness = the rest (8 -> 6/2, 4 -> 3/1).
 */
export function reviewSplit(perSubjectCount: number): { weakness: number; cumulative: number } {
  if (
    !Number.isInteger(perSubjectCount) ||
    perSubjectCount < MIN_REVIEW_ITEMS_PER_SUBJECT ||
    perSubjectCount > MAX_REVIEW_ITEMS_PER_SUBJECT
  ) {
    throw new RangeError('Review length must be an integer within the allowed range');
  }
  const cumulative = Math.floor((perSubjectCount + 2) / 4);
  return { weakness: perSubjectCount - cumulative, cumulative };
}

export function validateEvidenceWindow(
  window: EvidenceWindow,
): Result<EvidenceWindow, 'INVALID_EVIDENCE_WINDOW'> {
  if (!isValidInstant(window.from) || !isValidInstant(window.cutoff)) {
    return err('INVALID_EVIDENCE_WINDOW', 'Evidence window needs valid from and cutoff instants');
  }
  const span = window.cutoff.getTime() - window.from.getTime();
  if (span <= 0 || span > MAX_EVIDENCE_WINDOW_DAYS * DAY_MS) {
    return err(
      'INVALID_EVIDENCE_WINDOW',
      `Evidence window must end after it starts and span at most ${MAX_EVIDENCE_WINDOW_DAYS} days`,
    );
  }
  return ok({ from: new Date(window.from.getTime()), cutoff: new Date(window.cutoff.getTime()) });
}

/**
 * The week's weaker concepts per subject, from one child's events inside the window.
 *
 * A skill's weekly weakness is the number of distinct question instances with at least one
 * incorrect answer (initial or retry; resubmissions of one instance count once; unresolved never
 * counts). Decision: parent overrides count only if recorded before the cutoff, so a retried review job
 * computes the same review. Skills are ranked by that count, then by skill id; subjects are in id
 * order.
 */
export function rankWeeklyWeaknesses(
  events: readonly AttemptEvent[],
  window: EvidenceWindow,
): ReadonlyMap<string, readonly string[]> {
  const valid = validateEvidenceWindow(window);
  if (!valid.ok) throw new RangeError(valid.error.message);
  const { from, cutoff } = valid.value;
  const normalized = normalizeEvents(events);
  const childIds = new Set(normalized.map((e) => e.childId));
  if (childIds.size > 1) throw new RangeError('rankWeeklyWeaknesses requires a single child');
  const inWindow = normalized.filter(
    (e) => e.occurredAt.getTime() >= from.getTime() && e.occurredAt.getTime() < cutoff.getTime(),
  );
  const overridesAsOf = new Date(cutoff.getTime() - 1);
  const bySubjectSkill = new Map<string, Map<string, AttemptEvent[]>>();
  for (const event of inWindow) {
    const skills = bySubjectSkill.get(event.subject) ?? new Map<string, AttemptEvent[]>();
    const list = skills.get(event.skill) ?? [];
    list.push(event);
    skills.set(event.skill, list);
    bySubjectSkill.set(event.subject, skills);
  }
  const result = new Map<string, readonly string[]>();
  for (const subject of [...bySubjectSkill.keys()].sort(compareIds)) {
    const skills = bySubjectSkill.get(subject) ?? new Map<string, AttemptEvent[]>();
    const scored = [...skills.entries()]
      .map(([skill, list]) => ({
        skill,
        errors: readInstances(list, overridesAsOf).filter((i) => i.anyIncorrect).length,
      }))
      .filter((s) => s.errors > 0)
      .sort((a, b) => b.errors - a.errors || compareIds(a.skill, b.skill));
    if (scored.length > 0)
      result.set(
        subject,
        scored.map((s) => s.skill),
      );
  }
  return result;
}

const STANDARD_FIRST: readonly ItemCategory[] = ['standard', 'accessible', 'diagnostic'];

const PRIMARY_SOURCE: Readonly<Record<ReviewPart, ReviewItemSource>> = {
  weakness: 'weekly_weakness',
  cumulative: 'cumulative',
};

function listFor(
  map: ReadonlyMap<string, readonly string[]> | undefined,
  key: string,
): readonly string[] {
  return uniqueSkills(map?.get(key) ?? []);
}

function without(skills: readonly string[], exclude: ReadonlySet<string>): readonly string[] {
  return skills.filter((s) => !exclude.has(s));
}

/**
 * Composes a Thursday review: one section per enabled subject (every enabled subject gets one).
 *
 * Weakness part, per subject: one question per distinct weekly weakness, those in the test scope
 * first, keeping `MIN_TEST_SCOPE_QUESTIONS` slot(s) for the test scope when no in-scope weakness
 * covers it; then, one each, the rest of the test scope, prerequisites of the weak skills and other
 * current material (P8: "where six distinct weakness questions are not possible, fill with
 * prerequisites/current material"); only then second questions on the same lists, weekly
 * weaknesses first; then grade-level fallback. Cumulative part: cumulative skills, then the same
 * chain. Decision: test-scope material fills before prerequisites because the scope is the
 * teacher's own statement of what the upcoming test covers.
 * A subject with no weekly weaknesses and no current material uses the grade-level fallback and is
 * flagged `fallback_no_evidence`. Every fill and shortfall is explained in the section notes; a
 * template is never used twice in one review, and recently used templates only when unavoidable.
 */
export function composeThursdayReview(
  input: ThursdayReviewInput,
): Result<ThursdayReview, ThursdayReviewErrorCode> {
  if (input.enabledSubjects.some((s) => !isValidIdentifier(s))) {
    return err('INVALID_SUBJECT', 'Enabled subjects must be identifiers');
  }
  const subjects = uniqueSkills(input.enabledSubjects);
  if (subjects.length === 0) {
    return err('NO_ENABLED_SUBJECTS', 'A review needs at least one enabled subject');
  }
  const perSubjectCount = input.perSubjectCount ?? DEFAULT_REVIEW_ITEMS_PER_SUBJECT;
  if (
    !Number.isInteger(perSubjectCount) ||
    perSubjectCount < MIN_REVIEW_ITEMS_PER_SUBJECT ||
    perSubjectCount > MAX_REVIEW_ITEMS_PER_SUBJECT
  ) {
    return err(
      'INVALID_ITEM_COUNT',
      `Questions per subject must be an integer from ${MIN_REVIEW_ITEMS_PER_SUBJECT} to ${MAX_REVIEW_ITEMS_PER_SUBJECT}`,
    );
  }
  const split =
    input.cumulativeCount === undefined
      ? reviewSplit(perSubjectCount)
      : { weakness: perSubjectCount - input.cumulativeCount, cumulative: input.cumulativeCount };
  if (
    !Number.isInteger(split.cumulative) ||
    split.cumulative < 0 ||
    split.cumulative > perSubjectCount
  ) {
    return err(
      'INVALID_ITEM_COUNT',
      'cumulativeCount must be an integer from 0 to the review length',
    );
  }
  const window = validateEvidenceWindow(input.evidenceWindow);
  if (!window.ok) return window;
  const candidates = normalizeCandidates(input.candidateItems, ['subject']);
  if (!candidates.ok) return candidates;

  const recent = input.recentlyUsedTemplateKeys ?? new Set<string>();
  const used = new Set<string>();
  const all = (
    source: ReviewItemSource,
    skills: readonly string[],
  ): SelectionStage<ReviewItemSource> => ({
    source,
    skills,
    cap: Number.POSITIVE_INFINITY,
  });
  const capped = (
    source: ReviewItemSource,
    skills: readonly string[],
    cap: number,
  ): SelectionStage<ReviewItemSource> => ({ source, skills, cap });

  const sections: ReviewSection[] = [];
  for (const subject of subjects) {
    const scopeList = listFor(input.testScope, subject);
    const scope = new Set(scopeList);
    const weakRanked = listFor(input.subjectEvidence, subject);
    const inScopeWeak = weakRanked.filter((s) => scope.has(s));
    const weak = [...inScopeWeak, ...weakRanked.filter((s) => !scope.has(s))];
    const weakSet = new Set(weak);
    const scopeFill = without(scopeList, weakSet);
    const covered = new Set([...weak, ...scopeFill]);
    const prerequisites = without(
      uniqueSkills(weak.flatMap((skill) => input.prerequisites?.get(skill) ?? [])),
      covered,
    );
    for (const p of prerequisites) covered.add(p);
    const current = without(listFor(input.currentMaterial, subject), covered);
    const cumulative = listFor(input.cumulativeSkills, subject);
    const grade = listFor(input.gradeFallback, subject);

    const basis: ReviewBasis =
      weak.length > 0
        ? 'weekly_evidence'
        : scopeFill.length + current.length > 0
          ? 'current_material'
          : 'fallback_no_evidence';

    const groups: SelectionGroup<ReviewPart, ReviewItemSource>[] = [
      {
        key: 'weakness',
        need: split.weakness,
        primary: [
          capped('weekly_weakness', inScopeWeak, 1),
          {
            ...capped('weekly_weakness', weak, 1),
            // Leave room for the test scope; a scope with no usable item frees the slot below.
            ...(scopeFill.length > 0
              ? { reserve: { count: MIN_TEST_SCOPE_QUESTIONS, skills: scope } }
              : {}),
          },
          capped('test_scope', scopeFill, 1),
          capped('weekly_weakness', weak, 1),
          capped('prerequisite', prerequisites, 1),
          capped('current_material', current, 1),
          all('weekly_weakness', weak),
          all('test_scope', scopeFill),
          all('prerequisite', prerequisites),
          all('current_material', current),
          all('grade_fallback', grade),
        ],
        extended: [all('cumulative', cumulative)],
        categoryPreference: STANDARD_FIRST,
      },
      {
        key: 'cumulative',
        need: split.cumulative,
        primary: [
          capped('cumulative', cumulative, 1),
          all('cumulative', cumulative),
          all('weekly_weakness', weak),
          all('test_scope', scopeFill),
          all('prerequisite', prerequisites),
          all('current_material', current),
          all('grade_fallback', grade),
        ],
        extended: [],
        categoryPreference: STANDARD_FIRST,
      },
    ];
    const subjectCandidates = candidates.value.filter((c) => c.subject === subject);
    const picks = selectItems(groups, subjectCandidates, recent, used);
    const ordered = groups.flatMap((g) => picks.get(g.key) ?? []);
    const items: ReviewItem[] = ordered.map((pick) => ({
      templateKey: pick.item.templateKey,
      skill: pick.item.skill,
      subject,
      category: pick.item.category,
      part: pick.group,
      source: pick.source,
      reusedRecentTemplate: pick.reusedRecentTemplate,
    }));

    const notes: ReviewNote[] = [];
    if (basis === 'fallback_no_evidence') {
      notes.push({ code: 'FALLBACK_NO_EVIDENCE', count: 0 });
    } else if (weak.length === 0) {
      notes.push({ code: 'NO_WEEKLY_WEAKNESSES', count: 0 });
    } else if (weak.length < split.weakness) {
      notes.push({ code: 'FEWER_DISTINCT_WEAKNESSES', count: weak.length });
    }
    for (const b of countBackfills(ordered, (part) => PRIMARY_SOURCE[part])) {
      notes.push({ code: 'FILLED', part: b.group, source: b.source, count: b.count });
    }
    const reused = items.filter((i) => i.reusedRecentTemplate).length;
    if (reused > 0) notes.push({ code: 'RECENT_TEMPLATE_REUSED', count: reused });
    for (const group of groups) {
      const shortfall = group.need - (picks.get(group.key)?.length ?? 0);
      if (shortfall > 0) {
        notes.push({ code: 'INSUFFICIENT_CANDIDATES', part: group.key, count: shortfall });
      }
    }
    sections.push({ subject, basis, items, notes });
  }
  return ok({
    evidenceWindow: window.value,
    sections,
    totalItems: sections.reduce((sum, s) => sum + s.items.length, 0),
  });
}
