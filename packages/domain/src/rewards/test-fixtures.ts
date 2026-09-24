// Synthetic fixtures for rewards tests. Not exported from the module's public API.
import type { Result } from '../shared/result.ts';
import type { LedgerEntry } from './ledger.ts';
import type { PracticeAttemptEvent } from './awards.ts';

export const RILEY = 'child-riley';
export const SAM = 'child-sam';

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

/** A meaningful practice attempt by Riley; override any field. */
export function attemptEvent(overrides: Partial<PracticeAttemptEvent> = {}): PracticeAttemptEvent {
  return {
    kind: 'practice_attempt',
    childId: RILEY,
    questionInstanceId: 'qi-1',
    answerText: '42',
    responseTimeMs: 4_000,
    independentCorrect: false,
    ...overrides,
  };
}

/** A system award entry with an arbitrary amount, used to fund a synthetic ledger. */
export function fundingAward(points: number, key = 'set:funding', childId = RILEY): LedgerEntry {
  return {
    idempotencyKey: key,
    childId,
    kind: 'award',
    points,
    reason: 'set_completed',
    actor: 'system',
  };
}

export function sumPoints(entries: readonly LedgerEntry[]): number {
  return entries.reduce((total, entry) => total + entry.points, 0);
}
