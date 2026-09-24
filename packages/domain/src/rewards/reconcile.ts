// Ledger reconciliation (spec P9: "History and reversals must reconcile").
import { describeEntryProblem, type LedgerEntry } from './ledger.ts';
import { REDEMPTION_STATES, type RedemptionRequest } from './redemption.ts';

export const LEDGER_VIOLATION_CODES = [
  'INVALID_ENTRY',
  'DUPLICATE_IDEMPOTENCY_KEY',
  'CHILD_MISMATCH',
  'NEGATIVE_RUNNING_BALANCE',
  'INVALID_REQUEST',
  'DUPLICATE_REQUEST',
  'RESERVE_MISSING',
  'MULTIPLE_RESERVES',
  'RESERVE_AMOUNT_MISMATCH',
  'RELEASE_MISSING',
  'MULTIPLE_RELEASES',
  'RELEASE_AMOUNT_MISMATCH',
  'RELEASE_BEFORE_RESERVE',
  'UNEXPECTED_RELEASE',
  'ORPHAN_REDEMPTION_ENTRY',
] as const;
export type LedgerViolationCode = (typeof LEDGER_VIOLATION_CODES)[number];

export interface LedgerViolation {
  readonly code: LedgerViolationCode;
  readonly message: string;
  /** Position in the ledger (append order), when the violation concerns one entry. */
  readonly index?: number;
  readonly idempotencyKey?: string;
  readonly requestId?: string;
}

interface Located {
  readonly entry: LedgerEntry;
  readonly index: number;
}

function group(map: Map<string, Located[]>, requestId: string, located: Located): void {
  const list = map.get(requestId);
  if (list === undefined) map.set(requestId, [located]);
  else list.push(located);
}

/**
 * Checks one child's ledger (in append order) against that child's redemption requests and
 * returns every violation found; an empty array means the history reconciles. Intended for
 * scheduled integrity checks and tests — it reports rather than throws, so a corrupt ledger can be
 * inspected.
 */
export function reconcileLedger(
  entries: readonly LedgerEntry[],
  requests: readonly RedemptionRequest[],
): LedgerViolation[] {
  const violations: LedgerViolation[] = [];
  const childId = entries[0]?.childId ?? requests[0]?.childId;
  const seenKeys = new Set<string>();
  const reserves = new Map<string, Located[]>();
  const releases = new Map<string, Located[]>();
  let running = 0;

  entries.forEach((entry, index) => {
    const idempotencyKey = entry.idempotencyKey;
    const problem = describeEntryProblem(entry);
    if (problem !== null) {
      violations.push({ code: 'INVALID_ENTRY', message: problem, index, idempotencyKey });
    }
    if (entry.childId !== childId) {
      violations.push({
        code: 'CHILD_MISMATCH',
        message: 'Entry belongs to another child',
        index,
        idempotencyKey,
      });
    }
    if (seenKeys.has(idempotencyKey)) {
      violations.push({
        code: 'DUPLICATE_IDEMPOTENCY_KEY',
        message: 'Idempotency key recorded more than once',
        index,
        idempotencyKey,
      });
    }
    seenKeys.add(idempotencyKey);
    if (Number.isSafeInteger(entry.points)) {
      const before = running;
      running += entry.points;
      if (running < 0 && before >= 0) {
        violations.push({
          code: 'NEGATIVE_RUNNING_BALANCE',
          message: 'Balance went below zero at this entry',
          index,
          idempotencyKey,
        });
      }
    }
    if (typeof entry.requestId === 'string') {
      if (entry.kind === 'redemption_reserve') group(reserves, entry.requestId, { entry, index });
      if (entry.kind === 'redemption_release') group(releases, entry.requestId, { entry, index });
    }
  });

  const knownRequests = new Set<string>();
  for (const request of requests) {
    const { requestId } = request;
    if (knownRequests.has(requestId)) {
      violations.push({ code: 'DUPLICATE_REQUEST', message: 'Request id repeated', requestId });
      continue;
    }
    knownRequests.add(requestId);
    if (request.childId !== childId) {
      violations.push({
        code: 'CHILD_MISMATCH',
        message: 'Request belongs to another child',
        requestId,
      });
    }
    if (!(REDEMPTION_STATES as readonly string[]).includes(request.state)) {
      violations.push({ code: 'INVALID_REQUEST', message: 'Unknown request state', requestId });
      continue;
    }
    const reserved = reserves.get(requestId) ?? [];
    const released = releases.get(requestId) ?? [];
    if (reserved.length === 0) {
      violations.push({ code: 'RESERVE_MISSING', message: 'Request has no reserve', requestId });
    } else if (reserved.length > 1) {
      violations.push({ code: 'MULTIPLE_RESERVES', message: 'Request reserved twice', requestId });
    }
    for (const { entry, index } of reserved) {
      if (entry.points !== -request.pointCost) {
        violations.push({
          code: 'RESERVE_AMOUNT_MISMATCH',
          message: 'Reserve does not equal the request cost',
          index,
          requestId,
        });
      }
    }
    const mustRelease = request.state === 'declined' || request.state === 'cancelled';
    if (mustRelease && released.length === 0) {
      violations.push({
        code: 'RELEASE_MISSING',
        message: `A ${request.state} request must return its points`,
        requestId,
      });
    } else if (mustRelease && released.length > 1) {
      violations.push({
        code: 'MULTIPLE_RELEASES',
        message: 'Points were returned more than once',
        requestId,
      });
    } else if (!mustRelease && released.length > 0) {
      violations.push({
        code: 'UNEXPECTED_RELEASE',
        message: `A ${request.state} request must not return its points`,
        requestId,
      });
    }
    const firstReserveIndex = reserved[0]?.index;
    for (const { entry, index } of released) {
      if (entry.points !== request.pointCost) {
        violations.push({
          code: 'RELEASE_AMOUNT_MISMATCH',
          message: 'Release does not equal the request cost',
          index,
          requestId,
        });
      }
      if (firstReserveIndex !== undefined && index < firstReserveIndex) {
        violations.push({
          code: 'RELEASE_BEFORE_RESERVE',
          message: 'Points were returned before they were reserved',
          index,
          requestId,
        });
      }
    }
  }

  for (const requestId of new Set([...reserves.keys(), ...releases.keys()])) {
    if (!knownRequests.has(requestId)) {
      violations.push({
        code: 'ORPHAN_REDEMPTION_ENTRY',
        message: 'Redemption entry has no matching request',
        requestId,
      });
    }
  }
  return violations;
}
