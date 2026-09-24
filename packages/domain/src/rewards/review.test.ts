// Independent adversarial review of the rewards module (spec P9, P16.3, P16.4, P3, P5).
// Tests named [RV-rewards-<n>] are regression tests for defects found in review: each one fails
// against the implementation as reviewed and states the spec text it enforces. The remaining tests
// probe the riskiest behavior that was verified sound.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REWARD_RULES,
  appendToLedger,
  computeAwards,
  parentAdjustment,
  reconcileLedger,
  releaseKey,
  requestRedemption,
  reserveKey,
  transitionRedemption,
  validateRewardDefinition,
  type ExistingIdempotencyKeys,
  type LearningEvent,
  type LedgerEntry,
  type ParentAdjustmentInput,
  type RedemptionRequest,
  type RequestRedemptionInput,
  type RewardOffer,
  type TransitionContext,
} from './index.ts';
import {
  RILEY,
  attemptEvent,
  errorCode,
  fundingAward,
  sumPoints,
  unwrap,
} from './test-fixtures.ts';

const BOOK: RewardOffer = { id: 'reward-book', pointCost: 8, active: true };
const PARENT: TransitionContext = { principal: 'parent', recentAdultUnlock: true };

/** Feeds events through computeAwards the way the durable job does: keys accumulate. */
function processAll(events: readonly LearningEvent[]): LedgerEntry[] {
  const ledger: LedgerEntry[] = [];
  for (const event of events) {
    const keys = new Set(ledger.map((entry) => entry.idempotencyKey));
    ledger.push(...unwrap(computeAwards(event, DEFAULT_REWARD_RULES, keys)));
  }
  return ledger;
}

function awardsForAnswer(answerText: string): readonly LedgerEntry[] {
  return unwrap(
    computeAwards(attemptEvent({ answerText, independentCorrect: true }), DEFAULT_REWARD_RULES, []),
  );
}

describe('review findings (regressions that must pass once fixed)', () => {
  // P9: "prevent rapid empty guesses from farming points"; module requirement: "blank/whitespace/
  // punctuation-only answers ... earn nothing". awards.test.ts already treats invisible characters
  // (NBSP, zero-width space) as blank, but the Hangul filler code points are general category Lo
  // (letters) that render as blank space, so they pass the \p{L} "meaningful" check.
  it.each([
    ['U+3164 HANGUL FILLER', '\u3164'],
    ['U+FFA0 HALFWIDTH HANGUL FILLER', '\uFFA0'],
    ['U+115F/U+1160 HANGUL CHOSEONG/JUNGSEONG FILLER', '\u115F\u1160'],
    ['spaced Hangul fillers', ' \u3164 \u3164 '],
  ])('[RV-rewards-1] an invisible %s answer earns no points', (_label, answerText) => {
    expect(awardsForAnswer(answerText)).toEqual([]);
  });

  // AC_REWARDS_05: "Parent adjustments carry a reason". parentAdjustment documents: "a reason must
  // contain at least one letter or number (punctuation-only is treated as blank)". A blank-looking
  // Hangul filler and symbol-only text such as "+" or "~" are accepted as the audit reason.
  it.each([
    ['invisible Hangul filler', '\u3164\u3164'],
    ['a lone plus sign', '+'],
    ['tildes', '~~~'],
    ['comparison symbols', '<>='],
  ])('[RV-rewards-2] an adjustment reason that is only %s is refused', (_label, reason) => {
    const input: ParentAdjustmentInput = {
      principal: 'parent',
      recentAdultUnlock: true,
      childId: RILEY,
      points: 5,
      reason,
      adjustmentId: 'adj-review-1',
      currentBalance: 10,
    };
    expect(errorCode(parentAdjustment(input))).toBe('REASON_REQUIRED');
  });

  // P5: "Duplicate upload/resume events do not double-charge quota or reward points." computeAwards
  // validates the event (INVALID_EVENT) and the rules (throws) but not the key set: a missing or
  // malformed key collection becomes an empty Set, so an already-awarded instance is awarded again.
  it.each([
    ['undefined (store read returned nothing)', undefined],
    ['null', null],
    ['the recorded key as a bare string', 'attempt:qi-1'],
  ])('[RV-rewards-3] computeAwards fails closed when the existing keys are %s', (_label, keys) => {
    let awarded: number | 'refused';
    try {
      const result = computeAwards(
        attemptEvent({ independentCorrect: true }),
        DEFAULT_REWARD_RULES,
        keys as unknown as ExistingIdempotencyKeys,
      );
      awarded = result.ok ? sumPoints(result.value) : 'refused';
    } catch {
      awarded = 'refused';
    }
    expect(awarded).toBe('refused');
  });

  // P3: "enforce recent reauthentication server-side for answers, exports, rewards, purchases ...";
  // "Adult area requires valid parent authentication and a private six-digit PIN/biometric
  // reauthentication." requestRedemption accepts a parent principal with no step-up evidence at all
  // and reserves (spends) the child's points; every other parent rewards action requires the unlock.
  it('[RV-rewards-4] a parent without a recent adult unlock cannot spend a child’s points', () => {
    const withoutUnlock = {
      principal: 'parent',
      recentAdultUnlock: false,
      childId: RILEY,
      requestId: 'req-review-1',
      reward: BOOK,
      currentBalance: 10,
    };
    const result = requestRedemption(withoutUnlock as RequestRedemptionInput);
    expect(result.ok).toBe(false);
  });

  // P16.3: "No affiliate URL in a push, SMS, exported child worksheet or learning reward." The link
  // filter's TLD list omits Amazon's own EU/Asia short-link hosts and several Amazon marketplaces, so
  // scheme-less affiliate links pass into child-visible reward text.
  it.each([
    ['title', 'Headphones amzn.eu/d/3xYzAbc'],
    ['title', 'Lego set amzn.asia/d/9QwErTy'],
    ['instructions', 'The one at amazon.fr/dp/B000000000?tag=owner-21'],
    ['instructions', 'Order from amazon.it/dp/B000000000?tag=owner-21'],
    ['instructions', 'See amazon.es/dp/B000000000'],
  ] as const)('[RV-rewards-5] rejects an Amazon link in the reward %s: %s', (field, text) => {
    const input = {
      id: 'reward-review',
      title: 'New headphones',
      pointCost: 40,
      active: true,
      [field]: text,
    };
    expect(errorCode(validateRewardDefinition(input))).toBe('LINK_NOT_ALLOWED');
  });

  // P9: "Decline/cancellation returns the reserved balance exactly once"; AC_REWARDS_03 "refund
  // reserved points exactly once". appendToLedger is documented as the executable specification of
  // the atomic write, yet it accepts a release that refunds more than its reserve (or refunds a
  // reserve that never happened), minting points; reconcileLedger only reports it afterwards.
  it('[RV-rewards-6] the atomic append refuses a release larger than its reserve', () => {
    const reserve: LedgerEntry = {
      idempotencyKey: reserveKey('req-1'),
      childId: RILEY,
      kind: 'redemption_reserve',
      points: -8,
      requestId: 'req-1',
      actor: 'child',
    };
    const ledger = unwrap(appendToLedger([fundingAward(10)], [reserve]));
    const overRefund: LedgerEntry = {
      idempotencyKey: releaseKey('req-1'),
      childId: RILEY,
      kind: 'redemption_release',
      points: 80,
      requestId: 'req-1',
      actor: 'parent',
    };
    expect(appendToLedger(ledger, [overRefund]).ok).toBe(false);
  });

  it('[RV-rewards-6] the atomic append refuses a release with no prior reserve', () => {
    const ghostRelease: LedgerEntry = {
      idempotencyKey: releaseKey('req-ghost'),
      childId: RILEY,
      kind: 'redemption_release',
      points: 50,
      requestId: 'req-ghost',
      actor: 'parent',
    };
    expect(appendToLedger([fundingAward(10)], [ghostRelease]).ok).toBe(false);
  });
});

describe('review probes: risky behavior verified sound', () => {
  it('two parent devices deciding a stale pending request produce the same release key, so only one refund lands', () => {
    const pending: RedemptionRequest = unwrap(
      requestRedemption({
        principal: 'child',
        childId: RILEY,
        requestId: 'req-1',
        reward: BOOK,
        currentBalance: 10,
      }),
    ).request;
    const funded = unwrap(
      appendToLedger(
        [fundingAward(10)],
        [
          {
            idempotencyKey: reserveKey('req-1'),
            childId: RILEY,
            kind: 'redemption_reserve',
            points: -8,
            requestId: 'req-1',
            actor: 'child',
          },
        ],
      ),
    );
    const decline = unwrap(transitionRedemption(pending, 'decline', PARENT));
    const cancel = unwrap(transitionRedemption(pending, 'cancel', PARENT));
    const afterDecline = unwrap(appendToLedger(funded, decline.entries));
    expect(errorCode(appendToLedger(afterDecline, cancel.entries))).toBe(
      'DUPLICATE_IDEMPOTENCY_KEY',
    );
    expect(sumPoints(afterDecline)).toBe(10);
  });

  it('a slow retry after a wrong meaningful attempt cannot collect the independent bonus', () => {
    const ledger = processAll([
      attemptEvent({ answerText: '11', responseTimeMs: 3_000, independentCorrect: false }),
      attemptEvent({ answerText: '12', responseTimeMs: 3_000, independentCorrect: true }),
    ]);
    expect(sumPoints(ledger)).toBe(DEFAULT_REWARD_RULES.attemptPoints);
  });

  it('a negative-zero adjustment is treated as zero, and -0 point costs are refused', () => {
    expect(
      errorCode(
        parentAdjustment({
          principal: 'parent',
          recentAdultUnlock: true,
          childId: RILEY,
          points: -0,
          reason: 'Typo',
          adjustmentId: 'adj-z',
          currentBalance: 5,
        }),
      ),
    ).toBe('ZERO_ADJUSTMENT');
    expect(
      errorCode(
        requestRedemption({
          principal: 'child',
          childId: RILEY,
          requestId: 'req-z',
          reward: { ...BOOK, pointCost: -0 },
          currentBalance: 5,
        }),
      ),
    ).toBe('INVALID_POINT_COST');
  });

  it('reconciliation does flag the over-refund that the atomic append lets through (context for RV-6)', () => {
    const entries: LedgerEntry[] = [
      fundingAward(10),
      {
        idempotencyKey: reserveKey('req-1'),
        childId: RILEY,
        kind: 'redemption_reserve',
        points: -8,
        requestId: 'req-1',
        actor: 'child',
      },
      {
        idempotencyKey: releaseKey('req-1'),
        childId: RILEY,
        kind: 'redemption_release',
        points: 80,
        requestId: 'req-1',
        actor: 'parent',
      },
    ];
    const declined: RedemptionRequest = {
      requestId: 'req-1',
      childId: RILEY,
      rewardId: 'reward-book',
      pointCost: 8,
      state: 'declined',
      requestedBy: 'child',
    };
    expect(reconcileLedger(entries, [declined]).map((v) => v.code)).toEqual([
      'RELEASE_AMOUNT_MISMATCH',
    ]);
  });
});
