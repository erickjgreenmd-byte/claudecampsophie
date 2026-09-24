// Model-based property test: any interleaving of valid rewards operations, applied the way the API
// applies them (one atomic transaction per operation), keeps the balance >= 0 and reconciles.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REWARD_RULES,
  REDEMPTION_ACTIONS,
  appendToLedger,
  balance,
  computeAwards,
  overrideAwards,
  parentAdjustment,
  reconcileLedger,
  requestRedemption,
  transitionRedemption,
  type LearningEvent,
  type LedgerEntry,
  type RedemptionAction,
  type RedemptionRequest,
  type RewardOffer,
  type RewardsPrincipal,
} from './index.ts';
import { RILEY, SAM } from './test-fixtures.ts';

const REWARDS: readonly RewardOffer[] = [
  { id: 'reward-book', pointCost: 5, active: true },
  { id: 'reward-outing', pointCost: 12, active: true },
  { id: 'reward-retired', pointCost: 1, active: false },
];

type Op =
  | { t: 'event'; event: LearningEvent }
  | { t: 'override'; q: string; correct: boolean }
  | { t: 'request'; requestId: string; reward: number; principal: RewardsPrincipal }
  | {
      t: 'transition';
      requestId: string;
      action: RedemptionAction;
      principal: RewardsPrincipal;
      unlock: boolean;
      own: boolean;
    }
  | { t: 'adjust'; adjustmentId: string; points: number; reason: string; unlock: boolean };

const questionIds = ['qi-1', 'qi-2', 'qi-3', 'qi-4'] as const;
const requestIds = ['req-1', 'req-2', 'req-3', 'req-4'] as const;
const principalArb = fc.constantFrom<RewardsPrincipal>('child', 'parent');

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    t: fc.constant('event' as const),
    event: fc.oneof(
      fc.record({
        kind: fc.constant('practice_attempt' as const),
        childId: fc.constant(RILEY),
        questionInstanceId: fc.constantFrom(...questionIds),
        answerText: fc.constantFrom('', '  ', '?', '7', 'seven', '3/4'),
        responseTimeMs: fc.integer({ min: 0, max: 6_000 }),
        independentCorrect: fc.boolean(),
      }),
      fc.record({
        kind: fc.constant('set_completed' as const),
        childId: fc.constant(RILEY),
        setId: fc.constantFrom('set-mon', 'set-tue'),
      }),
    ),
  }),
  fc.record({
    t: fc.constant('override' as const),
    q: fc.constantFrom(...questionIds),
    correct: fc.boolean(),
  }),
  fc.record({
    t: fc.constant('request' as const),
    requestId: fc.constantFrom(...requestIds),
    reward: fc.integer({ min: 0, max: REWARDS.length - 1 }),
    principal: principalArb,
  }),
  fc.record({
    t: fc.constant('transition' as const),
    requestId: fc.constantFrom(...requestIds),
    action: fc.constantFrom(...REDEMPTION_ACTIONS),
    principal: principalArb,
    unlock: fc.boolean(),
    own: fc.boolean(),
  }),
  fc.record({
    t: fc.constant('adjust' as const),
    adjustmentId: fc.constantFrom('adj-1', 'adj-2', 'adj-3'),
    points: fc.integer({ min: -15, max: 15 }),
    reason: fc.constantFrom('Great focus this week', '', 'Undo extra bonus'),
    unlock: fc.boolean(),
  }),
);

interface Store {
  ledger: readonly LedgerEntry[];
  readonly requests: Map<string, RedemptionRequest>;
}

/** Applies domain output through the atomic append; the append must accept what the domain produced. */
function commit(store: Store, entries: readonly LedgerEntry[], mayCollide: boolean): boolean {
  const appended = appendToLedger(store.ledger, entries);
  if (!appended.ok) {
    // The only legitimate refusal is the unique-key constraint for a reused client id.
    expect(mayCollide).toBe(true);
    expect(appended.error.code).toBe('DUPLICATE_IDEMPOTENCY_KEY');
    return false;
  }
  store.ledger = appended.value;
  return true;
}

function apply(store: Store, op: Op): void {
  const keys = new Set(store.ledger.map((entry) => entry.idempotencyKey));
  switch (op.t) {
    case 'event': {
      const result = computeAwards(op.event, DEFAULT_REWARD_RULES, keys);
      expect(result.ok).toBe(true);
      if (result.ok) commit(store, result.value, false);
      return;
    }
    case 'override': {
      const entries = overrideAwards(
        { childId: RILEY, questionInstanceId: op.q, independentCorrect: op.correct },
        DEFAULT_REWARD_RULES,
        keys,
      );
      commit(store, entries, false);
      return;
    }
    case 'request': {
      const reward = REWARDS[op.reward];
      if (reward === undefined) throw new Error('bad reward index');
      const result = requestRedemption({
        principal: op.principal,
        childId: RILEY,
        requestId: op.requestId,
        reward,
        currentBalance: balance(store.ledger),
      });
      if (!result.ok) return;
      if (commit(store, result.value.entries, store.requests.has(op.requestId))) {
        store.requests.set(op.requestId, result.value.request);
      }
      return;
    }
    case 'transition': {
      const current = store.requests.get(op.requestId);
      if (current === undefined) return;
      const result = transitionRedemption(current, op.action, {
        principal: op.principal,
        recentAdultUnlock: op.unlock,
        actorChildId: op.own ? RILEY : SAM,
      });
      if (!result.ok) return;
      if (commit(store, result.value.entries, false)) {
        store.requests.set(op.requestId, result.value.request);
      }
      return;
    }
    case 'adjust': {
      const result = parentAdjustment({
        principal: 'parent',
        recentAdultUnlock: op.unlock,
        childId: RILEY,
        points: op.points,
        reason: op.reason,
        adjustmentId: op.adjustmentId,
        currentBalance: balance(store.ledger),
      });
      if (!result.ok) return;
      commit(store, [result.value], keys.has(result.value.idempotencyKey));
      return;
    }
  }
}

/** Independent expectation: earned + adjusted points minus the cost of every live redemption. */
function expectedBalance(store: Store): number {
  const earned = store.ledger
    .filter((entry) => entry.kind === 'award' || entry.kind === 'adjustment')
    .reduce((total, entry) => total + entry.points, 0);
  const held = [...store.requests.values()]
    .filter((r) => r.state === 'pending' || r.state === 'approved' || r.state === 'fulfilled')
    .reduce((total, r) => total + r.pointCost, 0);
  return earned - held;
}

describe('interleaved rewards operations (AC_REWARDS_02, AC_REWARDS_03, AC_REWARDS_05)', () => {
  it('property: balance never goes negative and the ledger always reconciles', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 60 }), (ops) => {
        const store: Store = { ledger: [], requests: new Map() };
        for (const op of ops) {
          apply(store, op);
          expect(balance(store.ledger)).toBeGreaterThanOrEqual(0);
          expect(reconcileLedger(store.ledger, [...store.requests.values()])).toEqual([]);
          expect(balance(store.ledger)).toBe(expectedBalance(store));
        }
        // Question awards stay within one award per instance whatever the interleaving.
        for (const q of questionIds) {
          const perQuestion = store.ledger
            .filter((entry) => entry.idempotencyKey.endsWith(`:${q}`))
            .reduce((total, entry) => total + entry.points, 0);
          expect(perQuestion).toBeLessThanOrEqual(
            DEFAULT_REWARD_RULES.attemptPoints + DEFAULT_REWARD_RULES.independentCorrectBonus,
          );
        }
      }),
      { numRuns: 300 },
    );
  });
});
