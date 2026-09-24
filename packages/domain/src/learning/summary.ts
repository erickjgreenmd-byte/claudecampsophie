// Transparent skill evidence summary (spec P7). This is an educational signal defined in code,
// not a validated psychometric test and never a diagnosis. AI confidence is not an input.
import { DateTime } from 'luxon';
import { assertIanaZone } from '../shared/time.ts';
import {
  compareIds,
  isValidInstant,
  normalizeEvents,
  readInstances,
  type AttemptEvent,
  type InstanceEvidence,
} from './evidence.ts';

export const SKILL_STATUSES = [
  'not_enough_evidence',
  'needs_practice',
  'developing',
  'strong',
] as const;
/** There is deliberately no "mastered" status: skills are revisited periodically (P7). */
export type SkillStatus = (typeof SKILL_STATUSES)[number];

/**
 * The published status rules (P7 "transparent initial rule"), evaluated in this order:
 * 1. `not_enough_evidence` when fewer than 5 distinct independent question instances.
 * 2. `needs_practice` when weighted independent accuracy < 0.6 AND independent errors occurred on
 *    at least 2 distinct question instances across at least 2 distinct local days.
 * 3. `strong` when weighted independent accuracy >= 0.85 AND independent correct answers occurred
 *    on at least 2 distinct local days (sessions) AND the latest independent attempt is within 30
 *    days of `now`. Decision: "practiced within 30 days" means independent practice, because
 *    hint-assisted practice is not mastery evidence and normalized weights cannot detect staleness.
 * 4. otherwise `developing`.
 */
export const SKILL_STATUS_RULES = Object.freeze({
  minDistinctIndependentQuestions: 5,
  needsPracticeAccuracyBelow: 0.6,
  needsPracticeMinErrorInstances: 2,
  needsPracticeMinErrorDays: 2,
  strongAccuracyAtLeast: 0.85,
  strongMinCorrectDays: 2,
  strongMaxDaysSinceIndependentPractice: 30,
});

/**
 * Recency weighting: each distinct question instance's first independent attempt has weight
 * `0.5 ** (ageDays / halfLifeDays)`, so evidence 14 days old counts half as much as today's.
 */
export const DEFAULT_RECENCY_HALF_LIFE_DAYS = 14;

/**
 * Decision: "distinct days" are calendar dates in `timeZone`. Callers should pass the family's
 * IANA zone; the UTC default exists only for zone-less contexts and can split one local evening
 * session across two dates.
 */
export const DEFAULT_EVIDENCE_TIME_ZONE = 'UTC';

/**
 * Decision: threshold comparisons allow 1e-9 of floating-point slack so that, for example, an
 * exact 17/20 = 0.85 is never demoted by rounding in the weighted sum.
 */
export const ACCURACY_EPSILON = 1e-9;

const DAY_MS = 86_400_000;

export interface SummaryConfig {
  readonly halfLifeDays?: number;
  readonly timeZone?: string;
}

export interface SkillSummary {
  readonly childId: string;
  readonly skill: string;
  readonly subject: string;
  /** Distinct question instances practiced (any attempt, including unresolved-only ones). */
  readonly distinctQuestions: number;
  /** Distinct instances whose first graded try was unaided: the mastery sample size. */
  readonly distinctIndependentQuestions: number;
  readonly independentCorrect: number;
  readonly independentIncorrect: number;
  /**
   * First graded tries answered correctly without help / instances with a first graded try.
   * Decision: a hint-assisted first try counts as attempted but never as an initial success.
   */
  readonly initialAccuracy: number | null;
  /** Instances eventually answered correctly (after hints/retries) / instances with any graded try. */
  readonly eventualCompletionRate: number | null;
  readonly weightedIndependentAccuracy: number | null;
  readonly distinctIndependentDays: number;
  readonly distinctIndependentCorrectDays: number;
  readonly distinctIndependentErrorDays: number;
  readonly lastPracticedAt: Date | null;
  readonly lastIndependentAt: Date | null;
  readonly lastIndependentErrorAt: Date | null;
  readonly status: SkillStatus;
}

interface ResolvedConfig {
  readonly halfLifeDays: number;
  readonly timeZone: string;
}

function resolveConfig(config: SummaryConfig | undefined): ResolvedConfig {
  const halfLifeDays = config?.halfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    throw new RangeError('halfLifeDays must be a positive finite number');
  }
  const timeZone = assertIanaZone(config?.timeZone ?? DEFAULT_EVIDENCE_TIME_ZONE);
  return { halfLifeDays, timeZone };
}

export function assertValidNow(now: Date, name = 'now'): void {
  if (!isValidInstant(now)) throw new RangeError(`${name} must be a valid Date`);
}

/** Recency weight of evidence from `occurredAt` as of `now` (future evidence is weighted as now). */
export function recencyWeight(
  occurredAt: Date,
  now: Date,
  halfLifeDays: number = DEFAULT_RECENCY_HALF_LIFE_DAYS,
): number {
  const ageDays = Math.max(0, now.getTime() - occurredAt.getTime()) / DAY_MS;
  return 0.5 ** (ageDays / halfLifeDays);
}

function localDay(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toFormat('yyyy-MM-dd');
}

function latest(dates: readonly Date[]): Date | null {
  let best: number | null = null;
  for (const date of dates) {
    const ms = date.getTime();
    if (best === null || ms > best) best = ms;
  }
  return best === null ? null : new Date(best);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * Weighted accuracy over each instance's first independent attempt. Weights are taken relative to
 * the newest sample (the common factor `0.5 ** (newestAge / halfLife)` cancels in the ratio), which
 * gives the same value as weighting by age at `now` without underflow for very old evidence.
 */
function weightedAccuracy(
  samples: readonly { readonly at: Date; readonly correct: boolean }[],
  halfLifeDays: number,
): number | null {
  const newest = latest(samples.map((s) => s.at));
  if (newest === null) return null;
  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    const weight = recencyWeight(sample.at, newest, halfLifeDays);
    denominator += weight;
    if (sample.correct) numerator += weight;
  }
  return numerator / denominator;
}

function statusFor(
  fields: Omit<SkillSummary, 'status' | 'childId' | 'skill' | 'subject'>,
  now: Date,
): SkillStatus {
  const rules = SKILL_STATUS_RULES;
  const accuracy = fields.weightedIndependentAccuracy;
  if (
    fields.distinctIndependentQuestions < rules.minDistinctIndependentQuestions ||
    accuracy === null
  ) {
    return 'not_enough_evidence';
  }
  if (
    accuracy < rules.needsPracticeAccuracyBelow - ACCURACY_EPSILON &&
    fields.independentIncorrect >= rules.needsPracticeMinErrorInstances &&
    fields.distinctIndependentErrorDays >= rules.needsPracticeMinErrorDays
  ) {
    return 'needs_practice';
  }
  const last = fields.lastIndependentAt;
  if (
    accuracy >= rules.strongAccuracyAtLeast - ACCURACY_EPSILON &&
    fields.distinctIndependentCorrectDays >= rules.strongMinCorrectDays &&
    last !== null &&
    now.getTime() - last.getTime() <= rules.strongMaxDaysSinceIndependentPractice * DAY_MS
  ) {
    return 'strong';
  }
  return 'developing';
}

function singleValue(
  events: readonly AttemptEvent[],
  field: 'childId' | 'skill' | 'subject',
): string {
  const first = events[0];
  if (first === undefined) throw new RangeError('At least one attempt event is required');
  for (const event of events) {
    if (event[field] !== first[field]) {
      throw new RangeError(
        `summarizeSkill requires a single ${field}; got ${first[field]} and ${event[field]}`,
      );
    }
  }
  return first[field];
}

function summarizeNormalized(
  normalized: readonly AttemptEvent[],
  now: Date,
  config: ResolvedConfig,
): SkillSummary {
  const childId = singleValue(normalized, 'childId');
  const skill = singleValue(normalized, 'skill');
  const subject = singleValue(normalized, 'subject');
  // Decision: this is an as-of summary; evidence and overrides after `now` are not yet known, so a
  // recomputation for a past instant is reproducible (clock-skewed future events wait until `now`).
  const known = normalized.filter((e) => e.occurredAt.getTime() <= now.getTime());
  const instances = readInstances(known, now);

  const withInitial = instances.filter((i) => i.initial !== undefined);
  const independent = instances.filter(
    (i): i is InstanceEvidence & { initial: AttemptEvent } =>
      i.independent && i.initial !== undefined,
  );
  const independentCorrect = independent.filter((i) => i.initialCorrectness === 'correct');
  const independentIncorrect = independent.filter((i) => i.initialCorrectness === 'incorrect');
  const resolved = instances.filter((i) => i.anyResolved);
  const days = (list: readonly (InstanceEvidence & { initial: AttemptEvent })[]): number =>
    new Set(list.map((i) => localDay(i.initial.occurredAt, config.timeZone))).size;

  const fields = {
    distinctQuestions: instances.length,
    distinctIndependentQuestions: independent.length,
    independentCorrect: independentCorrect.length,
    independentIncorrect: independentIncorrect.length,
    initialAccuracy: ratio(
      withInitial.filter((i) => i.independent && i.initialCorrectness === 'correct').length,
      withInitial.length,
    ),
    eventualCompletionRate: ratio(
      resolved.filter((i) => i.eventuallyCorrect).length,
      resolved.length,
    ),
    weightedIndependentAccuracy: weightedAccuracy(
      independent.map((i) => ({
        at: i.initial.occurredAt,
        correct: i.initialCorrectness === 'correct',
      })),
      config.halfLifeDays,
    ),
    distinctIndependentDays: days(independent),
    distinctIndependentCorrectDays: days(independentCorrect),
    distinctIndependentErrorDays: days(independentIncorrect),
    lastPracticedAt: latest(known.map((e) => e.occurredAt)),
    lastIndependentAt: latest(independent.map((i) => i.initial.occurredAt)),
    lastIndependentErrorAt: latest(independentIncorrect.map((i) => i.initial.occurredAt)),
  };
  return { childId, skill, subject, ...fields, status: statusFor(fields, now) };
}

/**
 * Summarizes one child's evidence for one skill as of `now`.
 *
 * Programmer errors (thrown): empty input, events for more than one child/skill/subject, invalid
 * events (validate at ingest with `validateAttemptEvent`), conflicting duplicate ids, invalid
 * `now` or config.
 */
export function summarizeSkill(
  events: readonly AttemptEvent[],
  now: Date,
  config?: SummaryConfig,
): SkillSummary {
  assertValidNow(now);
  const resolved = resolveConfig(config);
  if (events.length === 0) throw new RangeError('summarizeSkill requires at least one event');
  return summarizeNormalized(normalizeEvents(events), now, resolved);
}

/** Summarizes every skill in one child's events, ordered by skill id. */
export function summarizeSkills(
  events: readonly AttemptEvent[],
  now: Date,
  config?: SummaryConfig,
): readonly SkillSummary[] {
  assertValidNow(now);
  const resolved = resolveConfig(config);
  const normalized = normalizeEvents(events);
  if (normalized.length === 0) return [];
  singleValue(normalized, 'childId');
  const bySkill = new Map<string, AttemptEvent[]>();
  for (const event of normalized) {
    const list = bySkill.get(event.skill);
    if (list === undefined) bySkill.set(event.skill, [event]);
    else list.push(event);
  }
  return [...bySkill.keys()]
    .sort(compareIds)
    .map((skill) => summarizeNormalized(bySkill.get(skill) ?? [], now, resolved));
}
