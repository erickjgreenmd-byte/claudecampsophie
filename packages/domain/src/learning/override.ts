// Parent grading override (spec P5/P7, AC_GRADING_10). The attempt event is immutable: an override
// produces a new copy carrying `parentOverride`, an audit record of the change, and recomputed
// summaries for the affected skill only. Reward consequences are decided by the rewards module
// (`overrideAwards`), which never claws back points.
import { err, ok, type Result } from '../shared/result.ts';
import {
  effectiveCorrectness,
  isCorrectness,
  isValidInstant,
  normalizeEvents,
  type AttemptEvent,
  type Correctness,
} from './evidence.ts';
import {
  assertValidNow,
  summarizeSkill,
  type SkillSummary,
  type SummaryConfig,
} from './summary.ts';

export const OVERRIDE_ERROR_CODES = [
  'INVALID_OVERRIDE',
  'EVENT_NOT_FOUND',
  'OVERRIDE_BEFORE_ATTEMPT',
  'OVERRIDE_IN_FUTURE',
  'STALE_OVERRIDE',
] as const;
export type OverrideErrorCode = (typeof OVERRIDE_ERROR_CODES)[number];

export interface OverrideRequest {
  readonly eventId: string;
  readonly correctness: Correctness;
  readonly overriddenAt: Date;
}

export interface OverrideAudit {
  readonly eventId: string;
  readonly childId: string;
  readonly questionInstanceId: string;
  readonly skill: string;
  /** The grader's original judgment (unchanged on the event). */
  readonly graderCorrectness: Correctness;
  /** Correctness of record before this override (the grader's, or an earlier override). */
  readonly previousCorrectness: Correctness;
  readonly newCorrectness: Correctness;
  readonly overriddenAt: Date;
}

export interface OverrideRecomputation {
  /** The input events with the overridden event replaced by its new copy (input is not mutated). */
  readonly events: readonly AttemptEvent[];
  readonly overriddenEvent: AttemptEvent;
  readonly audit: OverrideAudit;
  /** Summaries for the affected skill only (one child, one skill). */
  readonly summaries: readonly SkillSummary[];
}

/**
 * Applies a parent override as of `now` and recomputes the affected skill's evidence.
 *
 * Decision: a newer override supersedes an older one; an override timestamped at or before the
 * existing override is rejected as STALE_OVERRIDE so concurrent edits cannot silently regress.
 * Authorization (recent adult unlock) and persistence of the audit row are the API's job.
 */
export function recomputeAfterOverride(
  events: readonly AttemptEvent[],
  override: OverrideRequest,
  now: Date,
  config?: SummaryConfig,
): Result<OverrideRecomputation, OverrideErrorCode> {
  assertValidNow(now);
  if (!isCorrectness(override.correctness) || !isValidInstant(override.overriddenAt)) {
    return err('INVALID_OVERRIDE', 'An override needs a valid correctness and timestamp');
  }
  const normalized = normalizeEvents(events);
  const target = normalized.find((e) => e.id === override.eventId);
  if (target === undefined) {
    return err('EVENT_NOT_FOUND', 'No attempt event with that id', { eventId: override.eventId });
  }
  const at = override.overriddenAt.getTime();
  if (at < target.occurredAt.getTime()) {
    return err('OVERRIDE_BEFORE_ATTEMPT', 'An override cannot precede the attempt');
  }
  if (at > now.getTime()) {
    return err('OVERRIDE_IN_FUTURE', 'An override cannot be recorded in the future');
  }
  if (target.parentOverride !== undefined && at <= target.parentOverride.overriddenAt.getTime()) {
    return err('STALE_OVERRIDE', 'A newer override for this attempt already exists');
  }
  const overriddenEvent: AttemptEvent = Object.freeze({
    ...target,
    parentOverride: Object.freeze({
      correctness: override.correctness,
      overriddenAt: new Date(at),
    }),
  });
  const updated = events.map((e) => (e.id === target.id ? overriddenEvent : e));
  const affected = updated.filter((e) => e.childId === target.childId && e.skill === target.skill);
  return ok({
    events: updated,
    overriddenEvent,
    audit: {
      eventId: target.id,
      childId: target.childId,
      questionInstanceId: target.questionInstanceId,
      skill: target.skill,
      graderCorrectness: target.correctness,
      previousCorrectness: effectiveCorrectness(target, now),
      newCorrectness: override.correctness,
      overriddenAt: new Date(at),
    },
    summaries: [summarizeSkill(affected, now, config)],
  });
}
