// Immutable learning evidence (spec P7, E4 Correctness). An attempt event is never edited; a parent
// override is carried alongside the grader's correctness and replaces it only for evidence
// computations, so the original judgment stays auditable (AC_GRADING_10).
import { err, ok, type Result } from '../shared/result.ts';

export const CORRECTNESS_VALUES = ['correct', 'incorrect', 'unresolved'] as const;
/** `unresolved` is neither right nor wrong (E4): it is excluded from accuracy, never counted wrong. */
export type Correctness = (typeof CORRECTNESS_VALUES)[number];

export interface ParentOverride {
  readonly correctness: Correctness;
  readonly overriddenAt: Date;
}

export interface AttemptEvent {
  readonly id: string;
  readonly childId: string;
  readonly questionInstanceId: string;
  readonly skill: string;
  readonly subject: string;
  readonly occurredAt: Date;
  /** 1 = the initial attempt on this question instance; retries are 2, 3, ... (server-assigned). */
  readonly attemptNumber: number;
  readonly hintsUsed: number;
  /** The grader's judgment at the time. Never rewritten; see `parentOverride`. */
  readonly correctness: Correctness;
  readonly sourceAssignmentId?: string;
  readonly graderVersion: string;
  readonly parentOverride?: ParentOverride;
}

export const ATTEMPT_EVENT_ERROR_CODES = [
  'INVALID_EVENT',
  'INVALID_IDENTIFIER',
  'INVALID_OCCURRED_AT',
  'INVALID_ATTEMPT_NUMBER',
  'INVALID_HINTS_USED',
  'INVALID_CORRECTNESS',
  'INVALID_OVERRIDE',
] as const;
export type AttemptEventErrorCode = (typeof ATTEMPT_EVENT_ERROR_CODES)[number];

/** Decision: identifiers (ids, skill and subject keys, grader version) are 1..200 characters. */
export const MAX_IDENTIFIER_LENGTH = 200;

const IDENTIFIER_FIELDS = [
  'id',
  'childId',
  'questionInstanceId',
  'skill',
  'subject',
  'graderVersion',
] as const;

export function isCorrectness(value: unknown): value is Correctness {
  return typeof value === 'string' && (CORRECTNESS_VALUES as readonly string[]).includes(value);
}

export function isValidIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    !hasControlCharacter(value)
  );
}

/** Identifiers are keys, not free text: control characters are rejected. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function isValidInstant(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * Validates an untrusted attempt event (e.g. an offline-queued submission or a mapped database
 * row) and returns a frozen, normalized copy containing only the known fields. Unknown fields such
 * as an AI confidence score are dropped: confidence is never learning evidence (P7).
 */
export function validateAttemptEvent(input: unknown): Result<AttemptEvent, AttemptEventErrorCode> {
  if (!isPlainRecord(input)) return err('INVALID_EVENT', 'Attempt event must be an object');
  for (const field of IDENTIFIER_FIELDS) {
    if (!isValidIdentifier(own(input, field))) {
      return err('INVALID_IDENTIFIER', `${field} must be a non-empty identifier`, { field });
    }
  }
  const sourceAssignmentId = own(input, 'sourceAssignmentId');
  if (sourceAssignmentId !== undefined && !isValidIdentifier(sourceAssignmentId)) {
    return err('INVALID_IDENTIFIER', 'sourceAssignmentId must be a non-empty identifier', {
      field: 'sourceAssignmentId',
    });
  }
  const occurredAt = own(input, 'occurredAt');
  if (!isValidInstant(occurredAt)) {
    return err('INVALID_OCCURRED_AT', 'occurredAt must be a valid Date');
  }
  const attemptNumber = own(input, 'attemptNumber');
  if (
    typeof attemptNumber !== 'number' ||
    !Number.isSafeInteger(attemptNumber) ||
    attemptNumber < 1
  ) {
    return err('INVALID_ATTEMPT_NUMBER', 'attemptNumber must be an integer >= 1');
  }
  const hintsUsed = own(input, 'hintsUsed');
  if (typeof hintsUsed !== 'number' || !Number.isSafeInteger(hintsUsed) || hintsUsed < 0) {
    return err('INVALID_HINTS_USED', 'hintsUsed must be an integer >= 0');
  }
  const correctness = own(input, 'correctness');
  if (!isCorrectness(correctness)) {
    return err('INVALID_CORRECTNESS', 'correctness must be correct, incorrect or unresolved');
  }
  const rawOverride = own(input, 'parentOverride');
  let parentOverride: ParentOverride | undefined;
  if (rawOverride !== undefined) {
    if (!isPlainRecord(rawOverride)) {
      return err('INVALID_OVERRIDE', 'parentOverride must be an object');
    }
    const overrideCorrectness = own(rawOverride, 'correctness');
    const overriddenAt = own(rawOverride, 'overriddenAt');
    if (!isCorrectness(overrideCorrectness) || !isValidInstant(overriddenAt)) {
      return err('INVALID_OVERRIDE', 'parentOverride needs a valid correctness and overriddenAt');
    }
    if (overriddenAt.getTime() < occurredAt.getTime()) {
      return err('INVALID_OVERRIDE', 'A parent override cannot precede the attempt it overrides');
    }
    parentOverride = Object.freeze({
      correctness: overrideCorrectness,
      overriddenAt: new Date(overriddenAt.getTime()),
    });
  }
  const event: AttemptEvent = {
    id: own(input, 'id') as string,
    childId: own(input, 'childId') as string,
    questionInstanceId: own(input, 'questionInstanceId') as string,
    skill: own(input, 'skill') as string,
    subject: own(input, 'subject') as string,
    occurredAt: new Date(occurredAt.getTime()),
    attemptNumber,
    hintsUsed,
    correctness,
    graderVersion: own(input, 'graderVersion') as string,
    ...(sourceAssignmentId === undefined ? {} : { sourceAssignmentId }),
    ...(parentOverride === undefined ? {} : { parentOverride }),
  };
  return ok(Object.freeze(event));
}

/** Throws for events that bypassed ingest validation (a programmer error, not a business outcome). */
export function assertValidAttemptEvent(event: AttemptEvent): void {
  const result = validateAttemptEvent(
    // Typed input may carry extra fields (ignored); validation reads only known own properties.
    { ...event },
  );
  if (!result.ok) {
    throw new RangeError(`Invalid attempt event ${String(event.id)}: ${result.error.message}`);
  }
}

/** Independent evidence: the initial attempt, answered with no hints (P7). */
export function isIndependentAttempt(event: AttemptEvent): boolean {
  return event.attemptNumber === 1 && event.hintsUsed === 0;
}

/**
 * Correctness of record for evidence: the parent override when one is in effect at `asOf`
 * (default: any recorded override), otherwise the grader's judgment.
 */
export function effectiveCorrectness(event: AttemptEvent, asOf?: Date): Correctness {
  const override = event.parentOverride;
  if (override === undefined) return event.correctness;
  if (asOf !== undefined && override.overriddenAt.getTime() > asOf.getTime()) {
    return event.correctness;
  }
  return override.correctness;
}

/** Chronological order; same-instant ties go to the lower attempt number, then the id. */
export function compareEvents(a: AttemptEvent, b: AttemptEvent): number {
  const byTime = a.occurredAt.getTime() - b.occurredAt.getTime();
  if (byTime !== 0) return byTime;
  return a.attemptNumber - b.attemptNumber || compareIds(a.id, b.id);
}

/** Locale-independent string order, so ties break identically on every runtime. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameEvent(a: AttemptEvent, b: AttemptEvent): boolean {
  return (
    a.childId === b.childId &&
    a.questionInstanceId === b.questionInstanceId &&
    a.skill === b.skill &&
    a.subject === b.subject &&
    a.occurredAt.getTime() === b.occurredAt.getTime() &&
    a.attemptNumber === b.attemptNumber &&
    a.hintsUsed === b.hintsUsed &&
    a.correctness === b.correctness &&
    a.graderVersion === b.graderVersion &&
    a.sourceAssignmentId === b.sourceAssignmentId &&
    a.parentOverride?.correctness === b.parentOverride?.correctness &&
    a.parentOverride?.overriddenAt.getTime() === b.parentOverride?.overriddenAt.getTime()
  );
}

/**
 * Validates, de-duplicates (an offline replay of the same event id counts once, E4 Offline) and
 * sorts events chronologically. Conflicting events sharing an id are a data-integrity error.
 */
export function normalizeEvents(events: readonly AttemptEvent[]): readonly AttemptEvent[] {
  const byId = new Map<string, AttemptEvent>();
  for (const event of events) {
    assertValidAttemptEvent(event);
    const existing = byId.get(event.id);
    if (existing === undefined) {
      byId.set(event.id, event);
    } else if (!sameEvent(existing, event)) {
      throw new RangeError(`Conflicting attempt events share id ${event.id}`);
    }
  }
  return [...byId.values()].sort(compareEvents);
}

/** Per-question-instance reading of the evidence (P7: one sample per distinct instance). */
export interface InstanceEvidence {
  readonly questionInstanceId: string;
  /**
   * The first graded try: the earliest attempt-1 event with a resolved correctness, found before
   * any retry. Undefined when the instance has no such event.
   */
  readonly initial: AttemptEvent | undefined;
  readonly initialCorrectness: 'correct' | 'incorrect' | undefined;
  /** The initial try was unaided: no hint was used on it or on any earlier unresolved try. */
  readonly independent: boolean;
  readonly anyResolved: boolean;
  readonly eventuallyCorrect: boolean;
  readonly anyIncorrect: boolean;
  readonly lastEventAt: Date;
}

/**
 * Groups chronologically sorted events of one skill by question instance.
 *
 * Decision: the initial try is found by walking the instance's events in time order. Leading
 * unresolved attempt-1 events (an unreadable photo, no correctness feedback) are skipped, so a
 * clearer resubmission is the first graded try; but once any retry (attemptNumber > 1) has
 * happened, a later event that re-sends attemptNumber 1 (a client reset) can never become the
 * initial try, and a hint used on any earlier unresolved try makes the instance non-independent.
 */
export function readInstances(
  sortedEvents: readonly AttemptEvent[],
  asOf: Date,
): readonly InstanceEvidence[] {
  const groups = new Map<string, AttemptEvent[]>();
  for (const event of sortedEvents) {
    const group = groups.get(event.questionInstanceId);
    if (group === undefined) groups.set(event.questionInstanceId, [event]);
    else group.push(event);
  }
  const instances: InstanceEvidence[] = [];
  for (const [questionInstanceId, group] of groups) {
    let initial: AttemptEvent | undefined;
    let initialCorrectness: 'correct' | 'incorrect' | undefined;
    let hintSeen = false;
    let searching = true;
    let anyResolved = false;
    let eventuallyCorrect = false;
    let anyIncorrect = false;
    for (const event of group) {
      const correctness = effectiveCorrectness(event, asOf);
      if (correctness !== 'unresolved') anyResolved = true;
      if (correctness === 'correct') eventuallyCorrect = true;
      if (correctness === 'incorrect') anyIncorrect = true;
      if (!searching) continue;
      if (event.attemptNumber !== 1) {
        searching = false;
        continue;
      }
      if (correctness === 'unresolved') {
        if (event.hintsUsed > 0) hintSeen = true;
        continue;
      }
      initial = event;
      initialCorrectness = correctness;
      if (event.hintsUsed > 0) hintSeen = true;
      searching = false;
    }
    const last = group[group.length - 1];
    if (last === undefined) continue;
    instances.push({
      questionInstanceId,
      initial,
      initialCorrectness,
      independent: initial !== undefined && !hintSeen,
      anyResolved,
      eventuallyCorrect,
      anyIncorrect,
      lastEventAt: last.occurredAt,
    });
  }
  return instances;
}
