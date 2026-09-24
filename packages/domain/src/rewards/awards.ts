// Points are earned only from learning events (spec P9, P5, P16.4).
import { err, ok, type Result } from '../shared/result.ts';
import { attemptKey, independentKey, isValidId, setKey } from './ids.ts';
import type { LedgerEntry } from './ledger.ts';
import { assertValidRules, type RewardRules } from './rules.ts';
import { isMeaningfulText, isPlainRecord, ownField } from './text.ts';

export interface PracticeAttemptEvent {
  readonly kind: 'practice_attempt';
  readonly childId: string;
  readonly questionInstanceId: string;
  /** Inspected only to detect empty guesses; never copied into the ledger. */
  readonly answerText: string;
  readonly responseTimeMs: number;
  readonly independentCorrect: boolean;
}

export interface SetCompletedEvent {
  readonly kind: 'set_completed';
  readonly childId: string;
  readonly setId: string;
}

/**
 * The only events that may ever award points. Ad impressions, sponsor/affiliate clicks, purchases,
 * referrals and any other commercial activity are deliberately not representable here (P16.4).
 */
export type LearningEvent = PracticeAttemptEvent | SetCompletedEvent;

export const LEARNING_EVENT_KINDS = ['practice_attempt', 'set_completed'] as const;

export const AWARD_ERROR_CODES = ['MONETIZATION_EVENT_CANNOT_AWARD', 'INVALID_EVENT'] as const;
export type AwardErrorCode = (typeof AWARD_ERROR_CODES)[number];

/** Keys already recorded in the child's ledger (from the store, inside the award transaction). */
export type ExistingIdempotencyKeys = ReadonlySet<string> | readonly string[];

/**
 * Normalizes the recorded keys, failing closed. `new Set(undefined)`/`new Set(null)` is empty and
 * `new Set('attempt:qi-1')` is a set of characters, so accepting a missing or malformed collection
 * would re-award an instance that was already paid (review finding RV-rewards-3). Anything other
 * than a Set or array of strings means the store read was wired wrongly: a programmer error, so it
 * throws instead of awarding. (The store's unique key constraint remains the last line of defense.)
 */
function toKeySet(keys: ExistingIdempotencyKeys): ReadonlySet<string> {
  const collection: unknown = keys;
  if (!(collection instanceof Set) && !Array.isArray(collection)) {
    throw new TypeError('existingIdempotencyKeys must be a Set or array of recorded keys');
  }
  for (const key of collection as Iterable<unknown>) {
    if (typeof key !== 'string') {
      throw new TypeError('existingIdempotencyKeys must contain only string keys');
    }
  }
  return collection instanceof Set ? (collection as ReadonlySet<string>) : new Set(keys);
}

/**
 * Validates an untrusted event (queue message, client sync) against the learning-event allowlist.
 *
 * Decision: the check is an allowlist. Any string `kind` other than the two learning kinds —
 * named monetization events or anything unknown — is refused with MONETIZATION_EVENT_CANNOT_AWARD,
 * so a new commercial event type can never award by omission. A missing/non-string kind or
 * malformed learning fields are INVALID_EVENT. Only own properties are read.
 */
export function parseLearningEvent(input: unknown): Result<LearningEvent, AwardErrorCode> {
  if (!isPlainRecord(input)) return err('INVALID_EVENT', 'A learning event must be an object');
  const kind = ownField(input, 'kind');
  if (typeof kind !== 'string') return err('INVALID_EVENT', 'A learning event needs a kind');
  if (kind !== 'practice_attempt' && kind !== 'set_completed') {
    return err(
      'MONETIZATION_EVENT_CANNOT_AWARD',
      'Only practice attempts and completed sets can award points',
    );
  }
  const childId = ownField(input, 'childId');
  if (!isValidId(childId)) return err('INVALID_EVENT', 'childId is not a valid identifier');
  if (kind === 'set_completed') {
    const setId = ownField(input, 'setId');
    if (!isValidId(setId)) return err('INVALID_EVENT', 'setId is not a valid identifier');
    return ok({ kind, childId, setId });
  }
  const questionInstanceId = ownField(input, 'questionInstanceId');
  const answerText = ownField(input, 'answerText');
  const responseTimeMs = ownField(input, 'responseTimeMs');
  const independentCorrect = ownField(input, 'independentCorrect');
  if (!isValidId(questionInstanceId)) {
    return err('INVALID_EVENT', 'questionInstanceId is not a valid identifier');
  }
  if (typeof answerText !== 'string') return err('INVALID_EVENT', 'answerText must be a string');
  // NaN would compare false against the threshold and slip through, so require a finite value.
  if (
    typeof responseTimeMs !== 'number' ||
    !Number.isFinite(responseTimeMs) ||
    responseTimeMs < 0
  ) {
    return err('INVALID_EVENT', 'responseTimeMs must be a finite non-negative number');
  }
  if (typeof independentCorrect !== 'boolean') {
    return err('INVALID_EVENT', 'independentCorrect must be a boolean');
  }
  return ok({ kind, childId, questionInstanceId, answerText, responseTimeMs, independentCorrect });
}

function award(
  childId: string,
  idempotencyKey: string,
  points: number,
  reason: string,
): LedgerEntry {
  return { idempotencyKey, childId, kind: 'award', points, reason, actor: 'system' };
}

/**
 * Ledger entries a learning event earns, given the keys already in the child's ledger.
 *
 * - A practice attempt earns effort points even when wrong, plus the independent-correct bonus.
 * - Blank/whitespace/punctuation-only answers and responses faster than `minMeaningfulResponseMs`
 *   earn nothing and do not use up the question instance.
 * - One award per question instance: once either key for the instance exists, retries (and
 *   duplicate deliveries, P5) earn nothing, even a correct retry.
 * - One award per set.
 *
 * Decision: the first meaningful attempt always writes its `attempt:` entry, even when the family
 * set `attemptPoints` to 0, so the instance is consumed and a later correct retry cannot collect
 * the bonus. Zero-point bonus/set entries are not written.
 */
export function computeAwards(
  event: LearningEvent,
  rules: RewardRules,
  existingIdempotencyKeys: ExistingIdempotencyKeys,
): Result<readonly LedgerEntry[], AwardErrorCode> {
  assertValidRules(rules);
  const existing = toKeySet(existingIdempotencyKeys);
  const parsed = parseLearningEvent(event);
  if (!parsed.ok) return parsed;
  const learning = parsed.value;

  if (learning.kind === 'set_completed') {
    const key = setKey(learning.setId);
    if (existing.has(key) || rules.setCompletionPoints === 0) return ok([]);
    return ok([award(learning.childId, key, rules.setCompletionPoints, 'set_completed')]);
  }

  const meaningful =
    isMeaningfulText(learning.answerText) &&
    learning.responseTimeMs >= rules.minMeaningfulResponseMs;
  if (!meaningful) return ok([]);

  const effortKey = attemptKey(learning.questionInstanceId);
  const bonusKey = independentKey(learning.questionInstanceId);
  if (existing.has(effortKey) || existing.has(bonusKey)) return ok([]);

  const entries = [award(learning.childId, effortKey, rules.attemptPoints, 'practice_attempt')];
  if (learning.independentCorrect && rules.independentCorrectBonus > 0) {
    entries.push(
      award(learning.childId, bonusKey, rules.independentCorrectBonus, 'independent_correct'),
    );
  }
  return ok(entries);
}

/** A parent/reviewer correction of whether a graded attempt was independently correct. */
export interface GradingOverride {
  readonly childId: string;
  readonly questionInstanceId: string;
  readonly independentCorrect: boolean;
}

/**
 * Reward consequences of a grading override (P5, AC_GRADING_10).
 *
 * An override never claws back points: this function never returns a negative entry. Changing a
 * result to incorrect returns nothing — earned points stay, and a parent who wants to change the
 * balance does so with an explicit, reasoned `parentAdjustment`.
 *
 * Decision: changing a result to independently correct grants the missing bonus once (same
 * `independent:` key), but only if the original attempt was meaningful and awarded (its
 * `attempt:` key exists); an override cannot turn an empty or rapid guess into points.
 */
export function overrideAwards(
  override: GradingOverride,
  rules: RewardRules,
  existingIdempotencyKeys: ExistingIdempotencyKeys,
): readonly LedgerEntry[] {
  assertValidRules(rules);
  const existing = toKeySet(existingIdempotencyKeys);
  if (!isValidId(override.childId) || !isValidId(override.questionInstanceId)) {
    throw new RangeError('Grading override requires valid child and question instance ids');
  }
  if (override.independentCorrect !== true || rules.independentCorrectBonus === 0) return [];
  const bonusKey = independentKey(override.questionInstanceId);
  if (!existing.has(attemptKey(override.questionInstanceId)) || existing.has(bonusKey)) return [];
  return [award(override.childId, bonusKey, rules.independentCorrectBonus, 'grading_override')];
}
