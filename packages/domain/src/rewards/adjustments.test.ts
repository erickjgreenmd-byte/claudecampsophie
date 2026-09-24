import { describe, expect, it } from 'vitest';
import {
  MAX_ADJUSTMENT_POINTS,
  MAX_ADJUSTMENT_REASON_LENGTH,
  appendToLedger,
  balance,
  parentAdjustment,
  reconcileLedger,
  type LedgerEntry,
  type ParentAdjustmentInput,
  type RewardsPrincipal,
} from './index.ts';
import { RILEY, errorCode, fundingAward, unwrap } from './test-fixtures.ts';

const BASE: ParentAdjustmentInput = {
  principal: 'parent',
  recentAdultUnlock: true,
  childId: RILEY,
  points: 4,
  reason: 'Helped Sam with reading practice',
  adjustmentId: 'adj-1',
  currentBalance: 10,
};

describe('parent adjustments carry a reason and are new ledger rows (AC_REWARDS_05)', () => {
  it('creates an append-only adjustment entry with the trimmed reason', () => {
    expect(unwrap(parentAdjustment({ ...BASE, reason: '  Extra effort on fractions  ' }))).toEqual({
      idempotencyKey: 'adjust:adj-1',
      childId: RILEY,
      kind: 'adjustment',
      points: 4,
      reason: 'Extra effort on fractions',
      actor: 'parent',
    });
  });

  it.each(['', '    ', '\n\t', '...', '?!'])(
    'a blank or punctuation-only reason %j is refused',
    (reason) => {
      expect(errorCode(parentAdjustment({ ...BASE, reason }))).toBe('REASON_REQUIRED');
    },
  );

  it('a non-string reason from untrusted input is refused', () => {
    const input = { ...BASE, reason: undefined } as unknown as ParentAdjustmentInput;
    expect(errorCode(parentAdjustment(input))).toBe('REASON_REQUIRED');
  });

  it('an unbounded reason is refused', () => {
    const reason = 'a'.repeat(MAX_ADJUSTMENT_REASON_LENGTH + 1);
    expect(errorCode(parentAdjustment({ ...BASE, reason }))).toBe('REASON_TOO_LONG');
  });

  it('only a parent with a recent adult unlock may adjust points', () => {
    expect(errorCode(parentAdjustment({ ...BASE, principal: 'child' }))).toBe('PARENT_ONLY');
    expect(
      errorCode(parentAdjustment({ ...BASE, principal: 'system' as unknown as RewardsPrincipal })),
    ).toBe('PARENT_ONLY');
    expect(errorCode(parentAdjustment({ ...BASE, recentAdultUnlock: false }))).toBe(
      'STEP_UP_REQUIRED',
    );
  });

  it('may not drive the balance negative; taking it exactly to zero is allowed', () => {
    expect(errorCode(parentAdjustment({ ...BASE, points: -11 }))).toBe('NEGATIVE_BALANCE');
    expect(unwrap(parentAdjustment({ ...BASE, points: -10 })).points).toBe(-10);
  });

  it('a zero-point adjustment is rejected', () => {
    expect(errorCode(parentAdjustment({ ...BASE, points: 0 }))).toBe('ZERO_ADJUSTMENT');
  });

  it.each([1.5, Number.NaN, MAX_ADJUSTMENT_POINTS + 1, -(MAX_ADJUSTMENT_POINTS + 1)])(
    'points %s are rejected as INVALID_POINTS',
    (points) => {
      expect(errorCode(parentAdjustment({ ...BASE, points, currentBalance: 50_000 }))).toBe(
        'INVALID_POINTS',
      );
    },
  );

  it('an adjustment id that cannot form a safe key is rejected', () => {
    expect(errorCode(parentAdjustment({ ...BASE, adjustmentId: 'adj:1' }))).toBe('INVALID_REQUEST');
  });

  it('totals reconcile after a reversal: history is kept, nothing is edited', () => {
    let ledger: readonly LedgerEntry[] = [fundingAward(10)];
    const grant = unwrap(
      parentAdjustment({
        ...BASE,
        adjustmentId: 'adj-grant',
        points: 6,
        currentBalance: balance(ledger),
      }),
    );
    ledger = unwrap(appendToLedger(ledger, [grant]));
    const reversal = unwrap(
      parentAdjustment({
        ...BASE,
        adjustmentId: 'adj-reversal',
        points: -6,
        reason: 'Reverse duplicate bonus from Tuesday',
        currentBalance: balance(ledger),
      }),
    );
    ledger = unwrap(appendToLedger(ledger, [reversal]));
    expect(balance(ledger)).toBe(10);
    expect(ledger).toHaveLength(3);
    expect(reconcileLedger(ledger, [])).toEqual([]);
  });
});
