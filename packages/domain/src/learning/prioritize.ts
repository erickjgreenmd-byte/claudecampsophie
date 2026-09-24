// Practice prioritization (spec P7): repeated independent errors first, then unresolved
// prerequisites, with a boost for recent study relevance. Deterministic and explainable.
import { compareIds } from './evidence.ts';
import { SKILL_STATUS_RULES, assertValidNow, type SkillSummary } from './summary.ts';

export const PRIORITY_REASONS = [
  'REPEATED_INDEPENDENT_ERRORS',
  'UNRESOLVED_PREREQUISITE',
  'RECENT_STUDY',
  'NOT_YET_STRONG',
  'NO_EVIDENCE',
] as const;
export type PriorityReason = (typeof PRIORITY_REASONS)[number];

/**
 * Score = tier points + accuracy gap. Tier points are powers of ten so a higher tier always
 * outranks any combination of lower ones; the accuracy gap (0..9) orders skills within a tier.
 */
export const PRIORITY_POINTS = Object.freeze({
  REPEATED_INDEPENDENT_ERRORS: 1000,
  UNRESOLVED_PREREQUISITE: 100,
  RECENT_STUDY: 10,
});

/**
 * Decision: independent errors count as "repeated" for prioritization only while the most recent
 * one is within 30 days of `now`; older error patterns stop outranking current needs (the skill
 * still appears as NOT_YET_STRONG until it is strong).
 */
export const REPEATED_ERROR_RECENCY_DAYS = 30;

const DAY_MS = 86_400_000;

export interface RankedSkill {
  readonly skill: string;
  readonly score: number;
  /** Stable reason codes in PRIORITY_REASONS order, for parent-facing explanations. */
  readonly reasons: readonly PriorityReason[];
}

export interface PrioritizeOptions {
  /** Skills from recent uploads, study guides or teacher lists. */
  readonly recentStudySkills: ReadonlySet<string>;
  /** skill -> its prerequisite skills (one level; not followed transitively). */
  readonly prerequisites: ReadonlyMap<string, readonly string[]>;
  readonly now: Date;
}

function hasRepeatedErrors(summary: SkillSummary, now: Date): boolean {
  const last = summary.lastIndependentErrorAt;
  return (
    summary.independentIncorrect >= SKILL_STATUS_RULES.needsPracticeMinErrorInstances &&
    summary.distinctIndependentErrorDays >= SKILL_STATUS_RULES.needsPracticeMinErrorDays &&
    last !== null &&
    now.getTime() - last.getTime() <= REPEATED_ERROR_RECENCY_DAYS * DAY_MS
  );
}

function accuracyGap(summary: SkillSummary | undefined): number {
  const accuracy = summary?.weightedIndependentAccuracy ?? null;
  if (accuracy === null) return 0;
  return Math.min(9, Math.max(0, Math.floor((1 - accuracy) * 10 + 1e-9)));
}

/**
 * Ranks the skills a child should practice, most urgent first. Decision: a skill is "settled" when
 * it is strong and shows no current repeated independent errors; settled skills are never returned
 * (they belong to spaced review and confidence practice). A strong skill with repeated recent
 * independent errors is still ranked for them (P7 puts repeated independent errors first, and
 * older successes can keep the weighted accuracy of a skill at "strong" while it is slipping).
 * A prerequisite is "unresolved" when it is not settled (including when there is no evidence for
 * it) and it underlies a focus skill: one with repeated independent errors, a needs-practice
 * status, or recent study relevance. Ties are broken by skill id so the result never depends on
 * input order.
 */
export function prioritizeSkills(
  summaries: readonly SkillSummary[],
  options: PrioritizeOptions,
): readonly RankedSkill[] {
  assertValidNow(options.now);
  const bySkill = new Map<string, SkillSummary>();
  for (const summary of summaries) {
    if (bySkill.has(summary.skill)) {
      throw new RangeError(`Duplicate summary for skill ${summary.skill}`);
    }
    bySkill.set(summary.skill, summary);
  }
  const isSettled = (skill: string): boolean => {
    const summary = bySkill.get(skill);
    return summary?.status === 'strong' && !hasRepeatedErrors(summary, options.now);
  };
  const reasons = new Map<string, Set<PriorityReason>>();
  const add = (skill: string, reason: PriorityReason): void => {
    const set = reasons.get(skill) ?? new Set<PriorityReason>();
    set.add(reason);
    reasons.set(skill, set);
  };

  const focus = new Set<string>();
  for (const summary of [...bySkill.values()].sort((a, b) => compareIds(a.skill, b.skill))) {
    if (isSettled(summary.skill)) continue;
    if (summary.status !== 'strong') add(summary.skill, 'NOT_YET_STRONG');
    if (hasRepeatedErrors(summary, options.now)) {
      add(summary.skill, 'REPEATED_INDEPENDENT_ERRORS');
      focus.add(summary.skill);
    }
    if (summary.status === 'needs_practice') focus.add(summary.skill);
  }
  for (const skill of [...options.recentStudySkills].sort(compareIds)) {
    if (isSettled(skill)) continue;
    add(skill, 'RECENT_STUDY');
    if (!bySkill.has(skill)) add(skill, 'NO_EVIDENCE');
    focus.add(skill);
  }
  for (const skill of [...focus].sort(compareIds)) {
    for (const prerequisite of options.prerequisites.get(skill) ?? []) {
      if (prerequisite === skill || isSettled(prerequisite)) continue;
      add(prerequisite, 'UNRESOLVED_PREREQUISITE');
      if (!bySkill.has(prerequisite)) add(prerequisite, 'NO_EVIDENCE');
    }
  }

  const ranked: RankedSkill[] = [];
  for (const [skill, set] of reasons) {
    let score = accuracyGap(bySkill.get(skill));
    if (set.has('REPEATED_INDEPENDENT_ERRORS'))
      score += PRIORITY_POINTS.REPEATED_INDEPENDENT_ERRORS;
    if (set.has('UNRESOLVED_PREREQUISITE')) score += PRIORITY_POINTS.UNRESOLVED_PREREQUISITE;
    if (set.has('RECENT_STUDY')) score += PRIORITY_POINTS.RECENT_STUDY;
    ranked.push({ skill, score, reasons: PRIORITY_REASONS.filter((r) => set.has(r)) });
  }
  return ranked.sort((a, b) => b.score - a.score || compareIds(a.skill, b.skill));
}
