import { describe, expect, it } from 'vitest';
import {
  reconcileLedger,
  releaseKey,
  reserveKey,
  type LedgerEntry,
  type RedemptionRequest,
} from './index.ts';
import { RILEY, SAM, fundingAward } from './test-fixtures.ts';

function request(
  requestId: string,
  state: RedemptionRequest['state'],
  pointCost = 5,
): RedemptionRequest {
  return {
    requestId,
    childId: RILEY,
    rewardId: 'reward-book',
    pointCost,
    state,
    requestedBy: 'child',
  };
}

function reserve(requestId: string, cost = 5): LedgerEntry {
  return {
    idempotencyKey: reserveKey(requestId),
    childId: RILEY,
    kind: 'redemption_reserve',
    points: -cost,
    requestId,
    actor: 'child',
  };
}

function release(requestId: string, cost = 5, key = releaseKey(requestId)): LedgerEntry {
  return {
    idempotencyKey: key,
    childId: RILEY,
    kind: 'redemption_release',
    points: cost,
    requestId,
    actor: 'parent',
  };
}

const codes = (entries: readonly LedgerEntry[], requests: readonly RedemptionRequest[]) =>
  reconcileLedger(entries, requests).map((violation) => violation.code);

describe('reconcileLedger: history and reversals must reconcile (P9, AC_REWARDS_03/05)', () => {
  it('a consistent ledger has no violations', () => {
    const entries = [
      fundingAward(20),
      reserve('req-a'),
      reserve('req-b'),
      release('req-b'),
      reserve('req-c'),
      reserve('req-d'),
      release('req-d'),
    ];
    const requests = [
      request('req-a', 'fulfilled'),
      request('req-b', 'declined'),
      request('req-c', 'approved'),
      request('req-d', 'cancelled'),
    ];
    expect(reconcileLedger(entries, requests)).toEqual([]);
  });

  it('flags duplicate idempotency keys', () => {
    expect(codes([fundingAward(5, 'set:a'), fundingAward(5, 'set:a')], [])).toContain(
      'DUPLICATE_IDEMPOTENCY_KEY',
    );
  });

  it('flags a negative running balance at any prefix, even if the final total is positive', () => {
    const entries = [reserve('req-a'), fundingAward(20)];
    const violations = reconcileLedger(entries, [request('req-a', 'pending')]);
    expect(violations).toContainEqual(
      expect.objectContaining({ code: 'NEGATIVE_RUNNING_BALANCE', index: 0 }),
    );
  });

  it.each(['declined', 'cancelled'] as const)('flags a %s request without its release', (state) => {
    expect(codes([fundingAward(20), reserve('req-a')], [request('req-a', state)])).toContain(
      'RELEASE_MISSING',
    );
  });

  it('flags a declined request released twice (second release under another key)', () => {
    const entries = [
      fundingAward(20),
      reserve('req-a'),
      release('req-a'),
      release('req-a', 5, 'redeem:req-a:release-again'),
    ];
    expect(codes(entries, [request('req-a', 'declined')])).toContain('MULTIPLE_RELEASES');
  });

  it.each(['fulfilled', 'approved', 'pending'] as const)(
    'flags a %s request that has a release',
    (state) => {
      const entries = [fundingAward(20), reserve('req-a'), release('req-a')];
      expect(codes(entries, [request('req-a', state)])).toContain('UNEXPECTED_RELEASE');
    },
  );

  it('flags a request whose reserve is missing', () => {
    expect(codes([fundingAward(20)], [request('req-a', 'pending')])).toContain('RESERVE_MISSING');
  });

  it('flags a reserve or release that does not match the request cost', () => {
    const entries = [fundingAward(20), reserve('req-a', 4), release('req-a', 3)];
    const found = codes(entries, [request('req-a', 'declined', 5)]);
    expect(found).toContain('RESERVE_AMOUNT_MISMATCH');
    expect(found).toContain('RELEASE_AMOUNT_MISMATCH');
  });

  it('flags redemption entries that reference no known request', () => {
    expect(codes([fundingAward(20), reserve('req-ghost')], [])).toContain(
      'ORPHAN_REDEMPTION_ENTRY',
    );
  });

  it('flags duplicate request ids', () => {
    const entries = [fundingAward(20), reserve('req-a')];
    expect(codes(entries, [request('req-a', 'pending'), request('req-a', 'approved')])).toContain(
      'DUPLICATE_REQUEST',
    );
  });

  it('flags entries or requests belonging to another child', () => {
    expect(codes([fundingAward(5, 'set:a'), fundingAward(5, 'set:b', SAM)], [])).toContain(
      'CHILD_MISMATCH',
    );
    expect(
      codes(
        [fundingAward(20), reserve('req-a')],
        [{ ...request('req-a', 'pending'), childId: SAM }],
      ),
    ).toContain('CHILD_MISMATCH');
  });

  it('flags malformed entries (e.g. a negative award)', () => {
    expect(codes([fundingAward(10, 'set:a'), fundingAward(-2, 'set:b')], [])).toContain(
      'INVALID_ENTRY',
    );
  });
});
