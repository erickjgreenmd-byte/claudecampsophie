// Parent point adjustments (spec P9): stored as new reasoned entries, never balance edits.
import { err, ok, type Result } from '../shared/result.ts';
import { adjustmentKey, isValidId } from './ids.ts';
import type { LedgerEntry, RewardsPrincipal } from './ledger.ts';
import { codePointLength, isMeaningfulText } from './text.ts';

/** Decision: one adjustment may move at most 10,000 points either way (sane cap). */
export const MAX_ADJUSTMENT_POINTS = 10_000;
/** Decision: reasons are bounded untrusted text of at most 500 code points. */
export const MAX_ADJUSTMENT_REASON_LENGTH = 500;

export const PARENT_ADJUSTMENT_ERROR_CODES = [
  'PARENT_ONLY',
  'STEP_UP_REQUIRED',
  'INVALID_REQUEST',
  'REASON_REQUIRED',
  'REASON_TOO_LONG',
  'ZERO_ADJUSTMENT',
  'INVALID_POINTS',
  'NEGATIVE_BALANCE',
] as const;
export type ParentAdjustmentErrorCode = (typeof PARENT_ADJUSTMENT_ERROR_CODES)[number];

export interface ParentAdjustmentInput {
  readonly principal: RewardsPrincipal;
  readonly recentAdultUnlock: boolean;
  readonly childId: string;
  /** Signed, non-zero integer. */
  readonly points: number;
  readonly reason: string;
  /** Client-generated id so a retried submit maps to the same unique key. */
  readonly adjustmentId: string;
  /** Balance read inside the same transaction, with the child's ledger locked. */
  readonly currentBalance: number;
}

/**
 * A parent's explicit, reasoned change to a child's points (including reversing an earlier award
 * after a grading override). Requires a parent with a recent adult unlock, a meaningful reason,
 * and may not take the balance below zero.
 *
 * Decision: a reason must contain at least one letter or number (punctuation-only is treated as
 * blank) and is stored trimmed.
 */
export function parentAdjustment(
  input: ParentAdjustmentInput,
): Result<LedgerEntry, ParentAdjustmentErrorCode> {
  if (input.principal !== 'parent') {
    return err('PARENT_ONLY', 'Only a parent can adjust points');
  }
  if (input.recentAdultUnlock !== true) {
    return err('STEP_UP_REQUIRED', 'Unlock the adult area to adjust points');
  }
  if (!isValidId(input.childId) || !isValidId(input.adjustmentId)) {
    return err('INVALID_REQUEST', 'Child and adjustment ids must be valid identifiers');
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!isMeaningfulText(reason)) {
    return err('REASON_REQUIRED', 'Explain why the points are being adjusted');
  }
  if (codePointLength(reason) > MAX_ADJUSTMENT_REASON_LENGTH) {
    return err(
      'REASON_TOO_LONG',
      `Keep the reason under ${MAX_ADJUSTMENT_REASON_LENGTH} characters`,
    );
  }
  const { points, currentBalance } = input;
  if (points === 0) return err('ZERO_ADJUSTMENT', 'An adjustment must change the balance');
  if (!Number.isInteger(points) || Math.abs(points) > MAX_ADJUSTMENT_POINTS) {
    return err(
      'INVALID_POINTS',
      `Adjust by a whole number of points up to ${MAX_ADJUSTMENT_POINTS} either way`,
    );
  }
  if (!Number.isSafeInteger(currentBalance)) {
    throw new RangeError('currentBalance must be a safe integer read from the ledger');
  }
  if (currentBalance + points < 0) {
    return err('NEGATIVE_BALANCE', 'Points cannot go below zero', {
      balance: currentBalance,
      points,
    });
  }
  return ok({
    idempotencyKey: adjustmentKey(input.adjustmentId),
    childId: input.childId,
    kind: 'adjustment',
    points,
    reason,
    actor: 'parent',
  });
}
