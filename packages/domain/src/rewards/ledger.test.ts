import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  LedgerInvariantError,
  appendToLedger,
  balance,
  releaseKey,
  reserveKey,
  type LedgerEntry,
} from './index.ts';
import { RILEY, SAM, errorCode, fundingAward, unwrap } from './test-fixtures.ts';

const reserve = (requestId: string, cost: number): LedgerEntry => ({
  idempotencyKey: reserveKey(requestId),
  childId: RILEY,
  kind: 'redemption_reserve',
  points: -cost,
  requestId,
  actor: 'child',
});

const release = (requestId: string, points: number): LedgerEntry => ({
  idempotencyKey: releaseKey(requestId),
  childId: RILEY,
  kind: 'redemption_release',
  points,
  requestId,
  actor: 'parent',
});

describe('balance is the sum of an append-only ledger (P9)', () => {
  it('sums signed entries', () => {
    expect(balance([])).toBe(0);
    expect(balance([fundingAward(10), reserve('req-1', 4)])).toBe(6);
  });

  it('property: balance equals the sum of points for any ledger with unique keys', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -50, max: 50 }), { maxLength: 30 }), (amounts) => {
        const entries = amounts.map((points, i) => fundingAward(points, `set:s-${i}`));
        expect(balance(entries)).toBe(amounts.reduce((a, b) => a + b, 0));
      }),
    );
  });

  it('duplicate idempotency keys are an invariant violation, not a double count', () => {
    expect(() => balance([fundingAward(5, 'set:a'), fundingAward(5, 'set:a')])).toThrow(
      LedgerInvariantError,
    );
    try {
      balance([fundingAward(5, 'set:a'), fundingAward(5, 'set:a')]);
    } catch (error) {
      expect((error as LedgerInvariantError).code).toBe('DUPLICATE_IDEMPOTENCY_KEY');
    }
  });

  it('refuses to mix two children in one balance', () => {
    expect(() => balance([fundingAward(5, 'set:a'), fundingAward(5, 'set:b', SAM)])).toThrow(
      LedgerInvariantError,
    );
  });

  it('refuses non-integer points', () => {
    expect(() => balance([fundingAward(0.5)])).toThrow(LedgerInvariantError);
  });
});

describe('appendToLedger models the atomic transaction: unique keys + balance check (AC_REWARDS_02)', () => {
  it('appends valid entries without mutating the input ledger', () => {
    const ledger: readonly LedgerEntry[] = Object.freeze([fundingAward(10)]);
    const next = unwrap(appendToLedger(ledger, [reserve('req-1', 4)]));
    expect(next).toHaveLength(2);
    expect(ledger).toHaveLength(1);
  });

  it('rejects an entry whose idempotency key already exists (unique constraint)', () => {
    const ledger = [fundingAward(10, 'set:a')];
    expect(errorCode(appendToLedger(ledger, [fundingAward(10, 'set:a')]))).toBe(
      'DUPLICATE_IDEMPOTENCY_KEY',
    );
    expect(
      errorCode(appendToLedger([], [fundingAward(1, 'set:b'), fundingAward(1, 'set:b')])),
    ).toBe('DUPLICATE_IDEMPOTENCY_KEY');
  });

  it('rejects a batch that would take the balance below zero, all-or-nothing', () => {
    const ledger = [fundingAward(5)];
    const result = appendToLedger(ledger, [reserve('req-1', 3), reserve('req-2', 3)]);
    expect(errorCode(result)).toBe('NEGATIVE_BALANCE');
  });

  it("rejects entries for another child's ledger", () => {
    expect(errorCode(appendToLedger([fundingAward(5)], [fundingAward(5, 'set:b', SAM)]))).toBe(
      'CHILD_MISMATCH',
    );
  });

  it.each([
    ['a negative award', fundingAward(-3, 'set:neg')],
    ['a positive reserve', { ...reserve('req-1', 3), points: 3 }],
    [
      'a release with a non-canonical key',
      { ...reserve('req-1', 3), kind: 'redemption_release', points: 3 },
    ],
    ['a reserve without a request id', { ...reserve('req-1', 3), requestId: undefined }],
    [
      'an adjustment by the system',
      {
        idempotencyKey: 'adjust:a-1',
        childId: RILEY,
        kind: 'adjustment',
        points: 3,
        reason: 'Bonus',
        actor: 'system',
      },
    ],
    [
      'an adjustment without a reason',
      {
        idempotencyKey: 'adjust:a-1',
        childId: RILEY,
        kind: 'adjustment',
        points: 3,
        actor: 'parent',
      },
    ],
    ['an unknown kind', { ...fundingAward(3), kind: 'cashback' }],
    ['an unknown actor', { ...fundingAward(3), actor: 'advertiser' }],
  ])('rejects %s as INVALID_ENTRY', (_label, entry) => {
    expect(errorCode(appendToLedger([fundingAward(10)], [entry as unknown as LedgerEntry]))).toBe(
      'INVALID_ENTRY',
    );
  });
});

describe('a release returns exactly its own reserve, once (P9, AC_REWARDS_03, RV-rewards-6)', () => {
  const reserved = unwrap(appendToLedger([fundingAward(10)], [reserve('req-1', 8)]));

  it('accepts a release equal to the earlier reserve and restores the balance', () => {
    const next = unwrap(appendToLedger(reserved, [release('req-1', 8)]));
    expect(balance(next)).toBe(10);
  });

  it('accepts a reserve and its release in the same batch, in that order', () => {
    expect(
      balance(
        unwrap(appendToLedger([fundingAward(10)], [reserve('req-1', 8), release('req-1', 8)])),
      ),
    ).toBe(10);
  });

  it.each([
    ['larger than the reserve (mints points)', 80],
    ['smaller than the reserve', 3],
  ])('refuses a release %s', (_label, points) => {
    expect(errorCode(appendToLedger(reserved, [release('req-1', points)]))).toBe(
      'RELEASE_AMOUNT_MISMATCH',
    );
  });

  it("refuses a release of another request's reserve", () => {
    expect(errorCode(appendToLedger(reserved, [release('req-2', 8)]))).toBe(
      'RELEASE_WITHOUT_RESERVE',
    );
  });

  it('refuses a release placed before its reserve in the same batch', () => {
    expect(
      errorCode(appendToLedger([fundingAward(10)], [release('req-1', 8), reserve('req-1', 8)])),
    ).toBe('RELEASE_WITHOUT_RESERVE');
  });

  it('refuses a second release of the same reserve (unique key)', () => {
    const released = unwrap(appendToLedger(reserved, [release('req-1', 8)]));
    expect(errorCode(appendToLedger(released, [release('req-1', 8)]))).toBe(
      'DUPLICATE_IDEMPOTENCY_KEY',
    );
  });
});

describe('the atomic append applies the adjustment reason rule (AC_REWARDS_05, RV-rewards-2)', () => {
  it.each(['+', '~~~', '<>=', '\u3164\u3164'])(
    'refuses an adjustment whose reason is only %j',
    (reason) => {
      const entry: LedgerEntry = {
        idempotencyKey: 'adjust:a-1',
        childId: RILEY,
        kind: 'adjustment',
        points: 3,
        reason,
        actor: 'parent',
      };
      expect(errorCode(appendToLedger([fundingAward(10)], [entry]))).toBe('INVALID_ENTRY');
    },
  );
});
