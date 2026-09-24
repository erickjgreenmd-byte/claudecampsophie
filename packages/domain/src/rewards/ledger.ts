// The append-only family points ledger (spec P9). Points are a motivational record, not money:
// there is deliberately no cash-out, transfer, sale or purchase operation anywhere in this module.
import { err, ok, type Result } from '../shared/result.ts';
import { adjustmentKey, isValidId, releaseKey, reserveKey } from './ids.ts';
import { hasLetterOrNumber, isPlainRecord, ownField } from './text.ts';

export const LEDGER_ENTRY_KINDS = [
  'award',
  'adjustment',
  'redemption_reserve',
  'redemption_release',
] as const;
export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];

export const LEDGER_ACTORS = ['system', 'parent', 'child'] as const;
export type LedgerActor = (typeof LEDGER_ACTORS)[number];

/** A verified human principal acting on rewards. The system never acts as a parent or child. */
export type RewardsPrincipal = Exclude<LedgerActor, 'system'>;

/**
 * One immutable ledger row. Corrections are new rows (adjustments/releases), never edits. The
 * store enforces `idempotencyKey` with a unique constraint per child ledger.
 */
export interface LedgerEntry {
  readonly idempotencyKey: string;
  readonly childId: string;
  readonly kind: LedgerEntryKind;
  /** Signed integer: awards >= 0, adjustments != 0, reserves < 0, releases > 0. */
  readonly points: number;
  readonly reason?: string;
  readonly requestId?: string;
  readonly actor: LedgerActor;
}

export const LEDGER_INVARIANT_CODES = [
  'DUPLICATE_IDEMPOTENCY_KEY',
  'MIXED_CHILD_LEDGER',
  'NON_INTEGER_POINTS',
] as const;
export type LedgerInvariantCode = (typeof LEDGER_INVARIANT_CODES)[number];

/** Thrown when a ledger handed to `balance` violates an invariant the database guarantees. */
export class LedgerInvariantError extends Error {
  readonly code: LedgerInvariantCode;

  constructor(code: LedgerInvariantCode, message: string) {
    super(message);
    this.name = 'LedgerInvariantError';
    this.code = code;
  }
}

/**
 * Balance of one child's ledger: the sum of its entries. A duplicate idempotency key, a second
 * child's entry or a non-integer amount means the input is corrupt, so it throws rather than
 * returning a number that could be spent.
 */
export function balance(entries: readonly LedgerEntry[]): number {
  const seen = new Set<string>();
  const childId = entries[0]?.childId;
  let sum = 0;
  for (const entry of entries) {
    if (seen.has(entry.idempotencyKey)) {
      throw new LedgerInvariantError(
        'DUPLICATE_IDEMPOTENCY_KEY',
        `Duplicate ledger idempotency key ${entry.idempotencyKey}`,
      );
    }
    seen.add(entry.idempotencyKey);
    if (entry.childId !== childId) {
      throw new LedgerInvariantError('MIXED_CHILD_LEDGER', 'A balance covers exactly one child');
    }
    if (!Number.isSafeInteger(entry.points)) {
      throw new LedgerInvariantError('NON_INTEGER_POINTS', 'Ledger points must be safe integers');
    }
    sum += entry.points;
  }
  if (!Number.isSafeInteger(sum)) {
    throw new LedgerInvariantError('NON_INTEGER_POINTS', 'Ledger balance overflowed');
  }
  return sum;
}

const AWARD_KEY_PREFIXES = ['attempt:', 'independent:', 'set:'] as const;
const MAX_KEY_LENGTH = 256;

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/**
 * Describes why a (possibly untyped) row is not a well-formed ledger entry, or returns null.
 * Shared by the atomic append and by reconciliation so both apply the same rules.
 */
export function describeEntryProblem(entry: unknown): string | null {
  if (!isPlainRecord(entry)) return 'entry must be an object';
  const key = ownField(entry, 'idempotencyKey');
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    return 'idempotencyKey must be a non-empty bounded string';
  }
  if (!isValidId(ownField(entry, 'childId'))) return 'childId is not a valid identifier';
  const points = ownField(entry, 'points');
  if (typeof points !== 'number' || !Number.isSafeInteger(points)) {
    return 'points must be a safe integer';
  }
  const actor = ownField(entry, 'actor');
  if (!isOneOf(LEDGER_ACTORS, actor)) return 'actor is not a known ledger actor';
  const kind = ownField(entry, 'kind');
  if (!isOneOf(LEDGER_ENTRY_KINDS, kind)) return 'kind is not a known ledger entry kind';
  const requestId = ownField(entry, 'requestId');
  switch (kind) {
    case 'award':
      if (points < 0) return 'awards cannot be negative';
      if (actor !== 'system') return 'awards are system entries';
      if (!AWARD_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        return 'award key must be an attempt, independent or set key';
      }
      return null;
    case 'adjustment': {
      if (points === 0) return 'adjustments must be non-zero';
      if (actor !== 'parent') return 'adjustments are parent entries';
      const reason = ownField(entry, 'reason');
      // Same rule as parentAdjustment, so append and reconciliation refuse what it refuses.
      if (typeof reason !== 'string' || !hasLetterOrNumber(reason)) {
        return 'adjustments require a reason with a letter or number';
      }
      if (!key.startsWith(adjustmentKey(''))) return 'adjustment key must start with adjust:';
      return null;
    }
    case 'redemption_reserve':
      if (!isValidId(requestId)) return 'reserve requires a valid requestId';
      if (key !== reserveKey(requestId)) return 'reserve key must be redeem:<requestId>:reserve';
      if (points >= 0) return 'reserve must be negative';
      if (actor === 'system') return 'reserves are made by a child or parent';
      return null;
    case 'redemption_release':
      if (!isValidId(requestId)) return 'release requires a valid requestId';
      if (key !== releaseKey(requestId)) return 'release key must be redeem:<requestId>:release';
      if (points <= 0) return 'release must be positive';
      if (actor === 'system') return 'releases are made by a child or parent';
      return null;
  }
}

export const APPEND_ERROR_CODES = [
  'INVALID_ENTRY',
  'CHILD_MISMATCH',
  'DUPLICATE_IDEMPOTENCY_KEY',
  'NEGATIVE_BALANCE',
  'RELEASE_WITHOUT_RESERVE',
  'RELEASE_AMOUNT_MISMATCH',
] as const;
export type AppendErrorCode = (typeof APPEND_ERROR_CODES)[number];

/**
 * Pure model of the atomic ledger write: within one transaction (child ledger row locked) the
 * store checks well-formedness, the unique idempotency constraint, that every redemption release
 * returns exactly the points of an earlier reserve for the same request, and that the running
 * balance never drops below zero, then appends everything or nothing. The API's SQL
 * implementation must enforce the same rules with a unique index, a release amount taken from the
 * reserved request and a locked balance check; this function is the executable specification
 * used by tests.
 *
 * Decision: a release with no earlier reserve for its request (in the ledger or earlier in the same
 * batch) is RELEASE_WITHOUT_RESERVE, and one whose points differ from that reserve's cost is
 * RELEASE_AMOUNT_MISMATCH, so a refund can never mint points (review finding RV-rewards-6). A
 * second release for the same request is already a DUPLICATE_IDEMPOTENCY_KEY.
 */
export function appendToLedger(
  ledger: readonly LedgerEntry[],
  entries: readonly LedgerEntry[],
): Result<readonly LedgerEntry[], AppendErrorCode> {
  let running = balance(ledger);
  const keys = new Set(ledger.map((entry) => entry.idempotencyKey));
  /** Reserved cost (positive) by request id, from the ledger and earlier entries in this batch. */
  const reserved = new Map<string, number>();
  for (const entry of ledger) {
    if (entry.kind === 'redemption_reserve' && entry.requestId !== undefined) {
      reserved.set(entry.requestId, -entry.points);
    }
  }
  const childId = ledger[0]?.childId ?? entries[0]?.childId;
  for (const [index, entry] of entries.entries()) {
    const problem = describeEntryProblem(entry);
    if (problem !== null) return err('INVALID_ENTRY', problem, { index });
    if (entry.childId !== childId) {
      return err('CHILD_MISMATCH', 'Entries must belong to the ledger child', { index });
    }
    if (keys.has(entry.idempotencyKey)) {
      return err('DUPLICATE_IDEMPOTENCY_KEY', 'Idempotency key already recorded', {
        idempotencyKey: entry.idempotencyKey,
      });
    }
    // describeEntryProblem guarantees a valid requestId on reserve and release entries.
    const requestId = entry.requestId ?? '';
    if (entry.kind === 'redemption_release') {
      const cost = reserved.get(requestId);
      if (cost === undefined) {
        return err('RELEASE_WITHOUT_RESERVE', 'Only reserved points can be returned', {
          index,
          requestId,
        });
      }
      if (entry.points !== cost) {
        return err('RELEASE_AMOUNT_MISMATCH', 'A release must return exactly the reserved points', {
          index,
          requestId,
          reserved: cost,
          points: entry.points,
        });
      }
    }
    if (entry.kind === 'redemption_reserve') reserved.set(requestId, -entry.points);
    keys.add(entry.idempotencyKey);
    running += entry.points;
    if (running < 0) {
      return err('NEGATIVE_BALANCE', 'The write would make the points balance negative', {
        index,
      });
    }
  }
  return ok([...ledger, ...entries]);
}
