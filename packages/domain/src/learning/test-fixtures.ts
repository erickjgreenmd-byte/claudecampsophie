// Synthetic fixtures for learning tests (Riley and Sam are invented). Not part of the public API.
import type { Result } from '../shared/result.ts';
import type { AttemptEvent, Correctness } from './evidence.ts';

export const RILEY = 'child-riley';
export const SAM = 'child-sam';

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/** Thursday 2026-09-24 20:00 UTC (1 p.m. in America/Los_Angeles). */
export const NOW = new Date('2026-09-24T20:00:00Z');

export function daysAgo(days: number, base: Date = NOW): Date {
  return new Date(base.getTime() - days * DAY_MS);
}

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

export function errorCode(result: Result<unknown>): string {
  if (result.ok) throw new Error('expected an error result, got ok');
  return result.error.code;
}

export interface AttemptSpec extends Partial<AttemptEvent> {
  readonly questionInstanceId: string;
}

/** An attempt by Riley on a math fractions question; override any field. */
export function attempt(spec: AttemptSpec): AttemptEvent {
  const occurredAt = spec.occurredAt ?? NOW;
  const attemptNumber = spec.attemptNumber ?? 1;
  const hintsUsed = spec.hintsUsed ?? 0;
  const correctness: Correctness = spec.correctness ?? 'correct';
  return {
    id:
      spec.id ??
      `evt:${spec.questionInstanceId}:${attemptNumber}:${hintsUsed}:${correctness}:${occurredAt.toISOString()}`,
    childId: RILEY,
    skill: 'math.fractions.add',
    subject: 'math',
    graderVersion: 'grader-1',
    ...spec,
    occurredAt,
    attemptNumber,
    hintsUsed,
    correctness,
  };
}

/**
 * One independent first attempt per entry: `[correct, daysAgo]`, each on its own question
 * instance (`${prefix}-${index}`).
 */
export function independentSeries(
  results: readonly (readonly [boolean, number])[],
  overrides: Partial<AttemptEvent> = {},
  prefix = 'qi',
): AttemptEvent[] {
  return results.map(([correct, ago], index) =>
    attempt({
      ...overrides,
      questionInstanceId: `${prefix}-${index}`,
      occurredAt: daysAgo(ago),
      correctness: correct ? 'correct' : 'incorrect',
    }),
  );
}

/** Deep-freezes a list of events so a test fails if any function mutates its input. */
export function frozen(events: readonly AttemptEvent[]): readonly AttemptEvent[] {
  for (const event of events) {
    Object.freeze(event.occurredAt);
    if (event.parentOverride !== undefined) {
      Object.freeze(event.parentOverride.overriddenAt);
      Object.freeze(event.parentOverride);
    }
    Object.freeze(event);
  }
  return Object.freeze([...events]);
}
