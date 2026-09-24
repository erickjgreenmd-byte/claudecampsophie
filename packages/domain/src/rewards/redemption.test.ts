import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  REDEMPTION_ACTIONS,
  REDEMPTION_STATES,
  appendToLedger,
  balance,
  reconcileLedger,
  requestRedemption,
  transitionRedemption,
  type LedgerEntry,
  type RedemptionAction,
  type RedemptionRequest,
  type RequestRedemptionInput,
  type RewardOffer,
  type RewardsPrincipal,
  type TransitionContext,
} from './index.ts';
import { RILEY, SAM, errorCode, fundingAward, unwrap } from './test-fixtures.ts';

const BOOK: RewardOffer = { id: 'reward-book', pointCost: 8, active: true };
const PARENT: TransitionContext = { principal: 'parent', recentAdultUnlock: true };
const PARENT_LOCKED: TransitionContext = { principal: 'parent', recentAdultUnlock: false };
const RILEY_DEVICE: TransitionContext = {
  principal: 'child',
  recentAdultUnlock: false,
  actorChildId: RILEY,
};

function pending(requestId = 'req-1', principal: RewardsPrincipal = 'child') {
  return unwrap(
    requestRedemption({ principal, childId: RILEY, requestId, reward: BOOK, currentBalance: 10 }),
  );
}

function inState(state: RedemptionRequest['state']): RedemptionRequest {
  return { ...pending().request, state };
}

describe('requestRedemption reserves the cost atomically (P9)', () => {
  it('a child request creates a pending request and one reserve entry of -cost', () => {
    const outcome = pending();
    expect(outcome.request).toEqual({
      requestId: 'req-1',
      childId: RILEY,
      rewardId: 'reward-book',
      pointCost: 8,
      state: 'pending',
      requestedBy: 'child',
    });
    expect(outcome.entries).toEqual([
      {
        idempotencyKey: 'redeem:req-1:reserve',
        childId: RILEY,
        kind: 'redemption_reserve',
        points: -8,
        requestId: 'req-1',
        actor: 'child',
      },
    ]);
  });

  it('a request exactly equal to the balance succeeds; one point short fails', () => {
    const input = { principal: 'child', childId: RILEY, requestId: 'req-1', reward: BOOK } as const;
    expect(requestRedemption({ ...input, currentBalance: 8 }).ok).toBe(true);
    expect(errorCode(requestRedemption({ ...input, currentBalance: 7 }))).toBe(
      'INSUFFICIENT_POINTS',
    );
  });

  it('an inactive reward cannot be requested', () => {
    expect(
      errorCode(
        requestRedemption({
          principal: 'child',
          childId: RILEY,
          requestId: 'req-1',
          reward: { ...BOOK, active: false },
          currentBalance: 100,
        }),
      ),
    ).toBe('REWARD_INACTIVE');
  });

  it.each([0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'a reward costing %s points is rejected',
    (pointCost) => {
      expect(
        errorCode(
          requestRedemption({
            principal: 'child',
            childId: RILEY,
            requestId: 'req-1',
            reward: { ...BOOK, pointCost },
            currentBalance: 100,
          }),
        ),
      ).toBe('INVALID_POINT_COST');
    },
  );

  it('a parent with a recent adult unlock may request on the child’s behalf', () => {
    const outcome = unwrap(
      requestRedemption({
        principal: 'parent',
        recentAdultUnlock: true,
        childId: RILEY,
        requestId: 'req-p',
        reward: BOOK,
        currentBalance: 10,
      }),
    );
    expect(outcome.request.requestedBy).toBe('parent');
    expect(outcome.entries.map((entry) => [entry.actor, entry.points])).toEqual([['parent', -8]]);
  });

  it.each([
    ['no unlock evidence', {}],
    ['a stale unlock', { recentAdultUnlock: false }],
    ['a truthy but non-boolean unlock flag', { recentAdultUnlock: 'yes' }],
  ])('a parent request with %s is STEP_UP_REQUIRED (P3, RV-rewards-4)', (_label, unlock) => {
    const input = {
      principal: 'parent',
      childId: RILEY,
      requestId: 'req-p',
      reward: BOOK,
      currentBalance: 10,
      ...unlock,
    } as unknown as RequestRedemptionInput;
    expect(errorCode(requestRedemption(input))).toBe('STEP_UP_REQUIRED');
  });

  it('the step-up is checked before anything else, so a locked parent learns nothing', () => {
    expect(
      errorCode(
        requestRedemption({
          principal: 'parent',
          childId: RILEY,
          requestId: 'req-p',
          reward: { ...BOOK, active: false },
          currentBalance: 0,
        }),
      ),
    ).toBe('STEP_UP_REQUIRED');
  });

  it('a child request needs no adult unlock', () => {
    expect(
      requestRedemption({
        principal: 'child',
        recentAdultUnlock: false,
        childId: RILEY,
        requestId: 'req-c',
        reward: BOOK,
        currentBalance: 10,
      }).ok,
    ).toBe(true);
  });

  it('an unrecognized principal (e.g. a system/monetization trigger) cannot request', () => {
    expect(
      errorCode(
        requestRedemption({
          principal: 'system' as unknown as RewardsPrincipal,
          childId: RILEY,
          requestId: 'req-1',
          reward: BOOK,
          currentBalance: 100,
        }),
      ),
    ).toBe('INVALID_PRINCIPAL');
  });
});

describe('two devices cannot spend the same points (AC_REWARDS_02)', () => {
  it('serialized by the row lock, the second request sees the reduced balance and fails', () => {
    let ledger: readonly LedgerEntry[] = [fundingAward(10)];
    const tablet = requestRedemption({
      principal: 'child',
      childId: RILEY,
      requestId: 'req-tablet',
      reward: BOOK,
      currentBalance: balance(ledger),
    });
    ledger = unwrap(appendToLedger(ledger, unwrap(tablet).entries));
    const phone = requestRedemption({
      principal: 'child',
      childId: RILEY,
      requestId: 'req-phone',
      reward: BOOK,
      currentBalance: balance(ledger),
    });
    expect(errorCode(phone)).toBe('INSUFFICIENT_POINTS');
    expect(balance(ledger)).toBe(2);
  });

  it('even with a stale balance read, the atomic append refuses the second spend', () => {
    const ledger: readonly LedgerEntry[] = [fundingAward(10)];
    const staleBalance = balance(ledger);
    const tablet = unwrap(
      requestRedemption({
        principal: 'child',
        childId: RILEY,
        requestId: 'req-tablet',
        reward: BOOK,
        currentBalance: staleBalance,
      }),
    );
    const phone = unwrap(
      requestRedemption({
        principal: 'child',
        childId: RILEY,
        requestId: 'req-phone',
        reward: BOOK,
        currentBalance: staleBalance,
      }),
    );
    const afterTablet = unwrap(appendToLedger(ledger, tablet.entries));
    expect(errorCode(appendToLedger(afterTablet, phone.entries))).toBe('NEGATIVE_BALANCE');
    // Had the store appended it anyway, reconciliation would flag the overspend.
    const corrupted = [...afterTablet, ...phone.entries];
    expect(
      reconcileLedger(corrupted, [tablet.request, phone.request]).map((v) => v.code),
    ).toContain('NEGATIVE_RUNNING_BALANCE');
  });

  it('a retried request with the same request id cannot reserve twice (unique key)', () => {
    const ledger: readonly LedgerEntry[] = [fundingAward(20)];
    const first = pending('req-1');
    const retry = pending('req-1');
    const afterFirst = unwrap(appendToLedger(ledger, first.entries));
    expect(errorCode(appendToLedger(afterFirst, retry.entries))).toBe('DUPLICATE_IDEMPOTENCY_KEY');
  });
});

describe('parent approval and fulfillment require a recent adult unlock (P3, P9)', () => {
  it.each(['approve', 'decline', 'fulfill'] as const)(
    'a child cannot %s, even their own request',
    (action) => {
      expect(errorCode(transitionRedemption(inState('pending'), action, RILEY_DEVICE))).toBe(
        'PARENT_ONLY',
      );
    },
  );

  it.each(['approve', 'decline', 'fulfill', 'cancel'] as const)(
    'a parent without a recent unlock cannot %s',
    (action) => {
      expect(errorCode(transitionRedemption(inState('approved'), action, PARENT_LOCKED))).toBe(
        'STEP_UP_REQUIRED',
      );
    },
  );

  it('a truthy but non-boolean unlock flag does not count as a step-up', () => {
    const context = {
      principal: 'parent',
      recentAdultUnlock: 'yes',
    } as unknown as TransitionContext;
    expect(errorCode(transitionRedemption(inState('pending'), 'approve', context))).toBe(
      'STEP_UP_REQUIRED',
    );
  });

  it('authorization is checked before idempotency: a child replaying approve is refused', () => {
    expect(errorCode(transitionRedemption(inState('approved'), 'approve', RILEY_DEVICE))).toBe(
      'PARENT_ONLY',
    );
  });
});

describe('transitions are idempotent and release reserved points exactly once (AC_REWARDS_03)', () => {
  it('approve moves pending to approved with no ledger entries; approving again is a no-op', () => {
    const approved = unwrap(transitionRedemption(inState('pending'), 'approve', PARENT));
    expect(approved.request.state).toBe('approved');
    expect(approved.entries).toEqual([]);
    const again = unwrap(transitionRedemption(approved.request, 'approve', PARENT));
    expect(again.request).toEqual(approved.request);
    expect(again.entries).toEqual([]);
  });

  it('decline from pending releases +cost once; a duplicate decline callback does nothing', () => {
    const declined = unwrap(transitionRedemption(inState('pending'), 'decline', PARENT));
    expect(declined.request.state).toBe('declined');
    expect(declined.entries).toEqual([
      {
        idempotencyKey: 'redeem:req-1:release',
        childId: RILEY,
        kind: 'redemption_release',
        points: 8,
        requestId: 'req-1',
        actor: 'parent',
      },
    ]);
    const duplicate = unwrap(transitionRedemption(declined.request, 'decline', PARENT));
    expect(duplicate.entries).toEqual([]);
    expect(duplicate.request.state).toBe('declined');
  });

  it('decline from approved also releases once', () => {
    const declined = unwrap(transitionRedemption(inState('approved'), 'decline', PARENT));
    expect(declined.entries.map((entry) => entry.points)).toEqual([8]);
  });

  it('a child may cancel their own pending request, releasing once; a double tap is a no-op', () => {
    const cancelled = unwrap(transitionRedemption(inState('pending'), 'cancel', RILEY_DEVICE));
    expect(cancelled.request.state).toBe('cancelled');
    expect(cancelled.entries).toHaveLength(1);
    expect(cancelled.entries[0]).toMatchObject({ kind: 'redemption_release', actor: 'child' });
    expect(unwrap(transitionRedemption(cancelled.request, 'cancel', RILEY_DEVICE)).entries).toEqual(
      [],
    );
  });

  it("a child cannot cancel another child's request, or one without a verified child id", () => {
    const samDevice: TransitionContext = {
      principal: 'child',
      recentAdultUnlock: false,
      actorChildId: SAM,
    };
    expect(errorCode(transitionRedemption(inState('pending'), 'cancel', samDevice))).toBe(
      'NOT_OWN_REQUEST',
    );
    const anonymousChild: TransitionContext = { principal: 'child', recentAdultUnlock: false };
    expect(errorCode(transitionRedemption(inState('pending'), 'cancel', anonymousChild))).toBe(
      'NOT_OWN_REQUEST',
    );
  });

  it('once approved, only a parent (with unlock) can cancel, and it releases once', () => {
    expect(errorCode(transitionRedemption(inState('approved'), 'cancel', RILEY_DEVICE))).toBe(
      'PARENT_ONLY',
    );
    const cancelled = unwrap(transitionRedemption(inState('approved'), 'cancel', PARENT));
    expect(cancelled.entries.map((entry) => entry.idempotencyKey)).toEqual([
      'redeem:req-1:release',
    ]);
  });

  it('fulfill records parent fulfillment of an approved request and never releases', () => {
    const fulfilled = unwrap(transitionRedemption(inState('approved'), 'fulfill', PARENT));
    expect(fulfilled.request.state).toBe('fulfilled');
    expect(fulfilled.entries).toEqual([]);
    expect(unwrap(transitionRedemption(fulfilled.request, 'fulfill', PARENT)).entries).toEqual([]);
    expect(unwrap(transitionRedemption(fulfilled.request, 'approve', PARENT)).entries).toEqual([]);
  });

  it.each([
    ['pending', 'fulfill'],
    ['fulfilled', 'decline'],
    ['fulfilled', 'cancel'],
    ['declined', 'approve'],
    ['declined', 'fulfill'],
    ['declined', 'cancel'],
    ['cancelled', 'approve'],
    ['cancelled', 'decline'],
    ['cancelled', 'fulfill'],
  ] as const)('%s -> %s is INVALID_TRANSITION', (state, action) => {
    expect(errorCode(transitionRedemption(inState(state), action, PARENT))).toBe(
      'INVALID_TRANSITION',
    );
  });

  it('an unknown action is INVALID_TRANSITION', () => {
    expect(
      errorCode(
        transitionRedemption(inState('pending'), 'refund' as unknown as RedemptionAction, PARENT),
      ),
    ).toBe('INVALID_TRANSITION');
  });

  it('property: any sequence of callbacks releases at most once, and exactly once iff declined/cancelled', () => {
    const contextArb: fc.Arbitrary<TransitionContext> = fc.oneof(
      fc.constant(PARENT),
      fc.constant(PARENT_LOCKED),
      fc.constant(RILEY_DEVICE),
      fc.constant<TransitionContext>({
        principal: 'child',
        recentAdultUnlock: true,
        actorChildId: SAM,
      }),
    );
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom(...REDEMPTION_ACTIONS), contextArb), { maxLength: 25 }),
        (steps) => {
          let request = inState('pending');
          let releases = 0;
          let releasedPoints = 0;
          for (const [action, context] of steps) {
            const result = transitionRedemption(request, action, context);
            if (!result.ok) continue;
            request = result.value.request;
            for (const entry of result.value.entries) {
              expect(entry.kind).toBe('redemption_release');
              releases += 1;
              releasedPoints += entry.points;
            }
          }
          expect(REDEMPTION_STATES).toContain(request.state);
          const releasedState = request.state === 'declined' || request.state === 'cancelled';
          expect(releases).toBe(releasedState ? 1 : 0);
          expect(releasedPoints).toBe(releasedState ? request.pointCost : 0);
        },
      ),
    );
  });
});

describe('rewards are parent-fulfilled records, never payments (AC_REWARDS_04, AC_MON_13)', () => {
  it('fulfilling a cash-style reward only records state: no payment, no money fields', () => {
    const cash: RewardOffer = {
      id: 'reward-five-dollars-paid-by-parent',
      pointCost: 8,
      active: true,
    };
    const request = unwrap(
      requestRedemption({
        principal: 'child',
        childId: RILEY,
        requestId: 'req-1',
        reward: cash,
        currentBalance: 8,
      }),
    ).request;
    const approved = unwrap(transitionRedemption(request, 'approve', PARENT)).request;
    const fulfilled = unwrap(transitionRedemption(approved, 'fulfill', PARENT));
    expect(fulfilled.entries).toEqual([]);
    expect(Object.keys(fulfilled.request).sort()).toEqual(
      ['childId', 'pointCost', 'requestId', 'requestedBy', 'rewardId', 'state'].sort(),
    );
  });

  it.each(['system', 'advertiser', 'affiliate_webhook', undefined])(
    'a non-parent trigger (%s) cannot approve or fulfill a reward',
    (principal) => {
      const context = { principal, recentAdultUnlock: true } as unknown as TransitionContext;
      expect(errorCode(transitionRedemption(inState('approved'), 'fulfill', context))).toBe(
        'PARENT_ONLY',
      );
      expect(errorCode(transitionRedemption(inState('pending'), 'approve', context))).toBe(
        'PARENT_ONLY',
      );
    },
  );
});
