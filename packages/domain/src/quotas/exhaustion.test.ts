import { describe, expect, it } from 'vitest';
import type { RandomSource } from '../shared/random.ts';
import {
  canAttempt,
  commit,
  computeOperationCostMicros,
  DEFAULT_ALLOWANCE_CONFIG,
  DEFAULT_RATE_TABLE_2026_09_18,
  EMPTY_ALLOWANCE_STATE,
  EMPTY_SPEND_LEDGER,
  exhaustionOutcome,
  release,
  reserve,
  reserveSpend,
  settleSpend,
  spendTotals,
  allowanceUsage,
  type ExhaustionKind,
} from './index.ts';

function counterRandom(): RandomSource {
  let counter = 0;
  return (length) => {
    const bytes = new Uint8Array(length);
    let value = ++counter;
    for (let i = length - 1; i >= 0 && value > 0; i--) {
      bytes[i] = value & 0xff;
      value = Math.floor(value / 256);
    }
    return bytes;
  };
}

const KINDS: readonly ExhaustionKind[] = ['child_allowance', 'family_allowance', 'global_budget'];

describe('exhaustion preserves learning and never surprise-bills (P11, F4, AC_SECURITY_06, AC_FIN_09)', () => {
  it.each(KINDS)('%s keeps results, history, vetted practice and points', (kind) => {
    const outcome = exhaustionOutcome(kind);
    expect(outcome.preserve).toEqual([
      'existing_results',
      'learning_history',
      'vetted_offline_practice',
      'earned_points',
    ]);
    expect(outcome.surpriseOverageBilling).toBe(false);
    expect(outcome.childCanPurchase).toBe(false);
    expect(outcome.bypassCorrectnessVerification).toBe(false);
  });

  it('gives each exhaustion kind its own parent explanation', () => {
    const keys = KINDS.map((k) => exhaustionOutcome(k).parentMessageKey);
    expect(new Set(keys).size).toBe(KINDS.length);
  });

  it('allowance exhaustion resumes at the next billing period; a global budget hold resumes when restored', () => {
    expect(exhaustionOutcome('child_allowance').resumes).toBe('next_billing_period');
    expect(exhaustionOutcome('family_allowance').resumes).toBe('next_billing_period');
    expect(exhaustionOutcome('global_budget').resumes).toBe('when_budget_restored');
  });

  it('returns immutable outcomes so callers cannot flip a safety flag', () => {
    const outcome = exhaustionOutcome('global_budget');
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.preserve)).toBe(true);
  });
});

describe('scenario: an unreadable scan frees allowance while its AI cost stays counted', () => {
  it('keeps the customer allowance ledger and the AI cost ledger separate', () => {
    const random = counterRandom();
    const pages = reserve(
      EMPTY_ALLOWANCE_STATE,
      {
        childId: 'child-riley',
        periodKey: 'sub_period_2026-10-03',
        units: 1,
        idempotencyKey: 'upload-riley-1',
        paidSlots: 1,
        activeChildIds: ['child-riley'],
      },
      DEFAULT_ALLOWANCE_CONFIG,
      random,
    );
    if (!pages.ok) throw new Error(pages.error.code);

    const cost = computeOperationCostMicros(DEFAULT_RATE_TABLE_2026_09_18, {
      modelId: 'gpt-5.6-terra',
      inputTokens: 4000,
      cachedInputTokens: 0,
      outputTokens: 1200,
    });
    if (!cost.ok) throw new Error(cost.error.code);

    const hold = reserveSpend(
      EMPTY_SPEND_LEDGER,
      {
        idempotencyKey: 'extract-riley-1',
        stage: 'extraction',
        estimateMicros: cost.value.costMicros,
        budgetMicros: 50_000_000,
        alreadyAlerted: [],
      },
      random,
    );
    if (!hold.ok || hold.value.kind !== 'reserved') throw new Error('spend hold failed');

    // Extraction ran, was billed, and the page was judged permanently unreadable.
    const billed = settleSpend(hold.value.ledger, hold.value.reservation.id, {
      actualMicros: cost.value.costMicros,
      outcome: 'failed_billed',
    });
    if (!billed.ok) throw new Error(billed.error.code);
    const freed = release(pages.value.state, pages.value.reservation.id, 'unreadable');
    if (!freed.ok) throw new Error(freed.error.code);

    expect(
      allowanceUsage(freed.value.state, {
        childId: 'child-riley',
        periodKey: 'sub_period_2026-10-03',
        paidSlots: 1,
      }).childUsedUnits,
    ).toBe(0);
    expect(spendTotals(billed.value.ledger).committedMicros).toBe(22_400);
    // The billed failure still counts toward the extraction stage's retry budget.
    expect(
      canAttempt(
        { maxAttempts: 2, timeoutMs: 30_000, maxOutputTokens: 1_200, maxCostMicros: 40_000 },
        { attemptsSoFar: 1, spentMicrosSoFar: 22_400, nextEstimateMicros: 22_400 },
      ),
    ).toEqual({ allow: false, deny: 'STAGE_COST_CAP' });
    // Committing a released scan afterwards is refused rather than silently re-charging.
    const late = commit(freed.value.state, pages.value.reservation.id);
    expect(!late.ok && late.error.code).toBe('INVALID_TRANSITION');
  });
});
