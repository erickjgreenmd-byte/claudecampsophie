// Independent adversarial review of the quotas module (spec P11 quotas paragraph, P12 usage/cost,
// F3, F4 controls; AC_SECURITY_06, AC_FIN_04, AC_FIN_09, AC_CAPTURE_06, AC_CAPACITY_07/09).
// Tests named [RV-quotas-<n>] are regressions for confirmed defects and fail until fixed.
// Tests under "review probes" pin risky behavior that was checked and found sound.
// Synthetic child ids only.
import { describe, expect, it } from 'vitest';
import type { RandomSource } from '../shared/random.ts';
import {
  allowanceUsage,
  canAttempt,
  commit,
  computeOperationCostMicros,
  DEFAULT_ALLOWANCE_CONFIG,
  DEFAULT_RATE_TABLE_2026_09_18,
  EMPTY_ALLOWANCE_STATE,
  evaluateSpend,
  release,
  reserve,
  reserveSpend,
  type AttemptDecision,
  type ModelRate,
  type ModelRateTable,
  type SpendLedger,
  type SpendReservation,
} from './index.ts';

/** Deterministic, never-repeating test RandomSource (a counter in the low bytes). */
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

const PERIOD = 'sub_period_2026-10-03';

describe('review regressions (quotas)', () => {
  it('[RV-quotas-1] never grants paid AI to more distinct children than verified paid slots', () => {
    // A family resubscribes at 1 paid slot (or a refund/revocation lowers capacity) while four
    // profiles are still marked active; entitlements/slots.ts explicitly handles activeChildIds
    // exceeding paidSlots, so this state is reachable. AC_CAPACITY_07: "Base access never grants
    // all four profiles paid AI"; P11: stop paid AI for profiles without a paid slot.
    const random = counterRandom();
    const profiles = ['child-riley', 'child-sam', 'child-avery', 'child-jordan'];
    let state = EMPTY_ALLOWANCE_STATE;
    const granted: string[] = [];
    for (const childId of profiles) {
      const result = reserve(
        state,
        {
          childId,
          periodKey: PERIOD,
          units: 1,
          idempotencyKey: `upload-${childId}`,
          paidSlots: 1,
          activeChildIds: profiles,
        },
        DEFAULT_ALLOWANCE_CONFIG,
        random,
      );
      if (result.ok) {
        state = result.value.state;
        granted.push(childId);
      }
    }
    expect(granted.length).toBeLessThanOrEqual(1);
  });

  it('[RV-quotas-2] a denied request does not use up 50%/80% alerts that real spend has not reached', () => {
    // F4: alerts at 50%/80%/100% of the owner's budget. Spend is 10%; a single oversized request
    // is denied and never runs, so no money is spent or held. Reporting 50%/80% as crossed (and the
    // caller recording them, as spend.test.ts does) means the owner is never alerted when real
    // spend later reaches 50%. The documented decision covers only the 100% alert on denial, so
    // this test ignores 100.
    const budgetMicros = 100_000_000;
    const denied = evaluateSpend({
      budgetMicros,
      committedMicros: 10_000_000,
      inFlightReservedMicros: 0,
      requestEstimateMicros: 95_000_000,
      alreadyAlerted: [],
    });
    if (!denied.ok) throw new Error(`unexpected ${denied.error.code}`);
    expect(denied.value.allowed).toBe(false);

    const alerted = [...denied.value.newlyCrossedThresholds];
    const later = evaluateSpend({
      budgetMicros,
      committedMicros: 55_000_000,
      inFlightReservedMicros: 0,
      requestEstimateMicros: 0,
      alreadyAlerted: alerted,
    });
    if (!later.ok) throw new Error(`unexpected ${later.error.code}`);

    expect({
      belowCeilingAlertsOnDenial: denied.value.newlyCrossedThresholds.filter((t) => t < 100),
      alertsWhenSpendReaches55Percent: later.value.newlyCrossedThresholds,
    }).toEqual({ belowCeilingAlertsOnDenial: [], alertsWhenSpendReaches55Percent: [50] });
  });

  it.each([
    ['zero input rate', { inputPerMillionMicros: 0, outputPerMillionMicros: 50_000_000 }],
    ['zero output rate', { inputPerMillionMicros: 10_000_000, outputPerMillionMicros: 0 }],
  ] as const)(
    '[RV-quotas-3] refuses to price a billed model with a %s instead of charging nothing',
    (_label, partial) => {
      // AC_FIN_01: unknown rates are explicit, never silently zero. A zero row makes every call on
      // that model cost 0 micros, so stage caps and the global spend ceiling never trip (F4).
      const rate: ModelRate = { ...partial, cachedInputPerMillionMicros: null };
      const table: ModelRateTable = { version: 'misconfigured', models: { 'gpt-6-astra': rate } };
      const result = computeOperationCostMicros(table, {
        modelId: 'gpt-6-astra',
        inputTokens: 4000,
        cachedInputTokens: 0,
        outputTokens: 2000,
      });
      expect(!result.ok && result.error.code).toBe('INVALID_RATE');
    },
  );

  it('[RV-quotas-4] does not allow another billed attempt once the stage cost cap is fully spent', () => {
    // P12: "Limit original request + retry/escalation cost by stage". Any provider attempt costs
    // more than 0 micros, so a zero upper-bound estimate is a corrupt input; accepting it lets an
    // attempt start with no headroom and push the stage past its cap.
    const limits = {
      maxAttempts: 3,
      timeoutMs: 30_000,
      maxOutputTokens: 2_000,
      maxCostMicros: 60_000,
    };
    let decision: AttemptDecision | 'threw';
    try {
      decision = canAttempt(limits, {
        attemptsSoFar: 1,
        spentMicrosSoFar: 60_000,
        nextEstimateMicros: 0,
      });
    } catch {
      decision = 'threw';
    }
    expect(decision).not.toEqual({ allow: true });
  });

  const settled = (id: string, actualMicros: number | null): SpendReservation => ({
    id,
    idempotencyKey: `op-${id}`,
    stage: 'extraction',
    estimateMicros: 600_000,
    status: 'settled',
    actualMicros,
    outcome: 'failed_billed',
  });
  const corruptLedgers: readonly (readonly [string, readonly SpendReservation[]])[] = [
    ['a billed row with no recorded cost', [settled('r1', null)]],
    [
      'a negative row offset by a real billed row',
      [settled('r1', 900_000), settled('r2', -600_000)],
    ],
  ];
  it.each(corruptLedgers)(
    '[RV-quotas-5] %s cannot lower counted spend and open the ceiling',
    (_label, reservations) => {
      // F4/AC_FIN_09: the application-enforced ceiling decides from the persisted ledger, and
      // SpendReservation allows a settled row with actualMicros null. spendTotals counts it as $0
      // (`?? 0`) and never validates individual rows, so a request that must be denied
      // (real spend + $0.60 > $1.00 budget) is reserved.
      const ledger: SpendLedger = { reservations };
      let outcome: string;
      try {
        const result = reserveSpend(
          ledger,
          {
            idempotencyKey: 'op-new',
            stage: 'extraction',
            estimateMicros: 600_000,
            budgetMicros: 1_000_000,
            alreadyAlerted: [],
          },
          counterRandom(),
        );
        outcome = result.ok ? result.value.kind : result.error.code;
      } catch {
        outcome = 'threw';
      }
      expect(outcome).not.toBe('reserved');
    },
  );
});

describe('review probes (verified sound)', () => {
  it('prices the largest safe token counts exactly and refuses unrepresentable totals', () => {
    const luna = computeOperationCostMicros(DEFAULT_RATE_TABLE_2026_09_18, {
      modelId: 'gpt-5.6-luna',
      inputTokens: Number.MAX_SAFE_INTEGER,
      cachedInputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 0,
    });
    // 9,007,199,254,740,991 * 0.2 = 1,801,439,850,948,198.2 -> ...198, cached billed at full rate.
    expect(luna).toEqual({
      ok: true,
      value: {
        costMicros: 1_801_439_850_948_198,
        rateTableVersion: '2026-09-18',
        assumptions: ['cached_rate_unknown_billed_full'],
      },
    });
    const terra = computeOperationCostMicros(DEFAULT_RATE_TABLE_2026_09_18, {
      modelId: 'gpt-5.6-terra',
      inputTokens: Number.MAX_SAFE_INTEGER,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(!terra.ok && terra.error.code).toBe('COST_OUT_OF_RANGE');
  });

  it('an archived child in-flight reservation still counts against the family after reassignment', () => {
    const random = counterRandom();
    const riley = reserve(
      EMPTY_ALLOWANCE_STATE,
      {
        childId: 'child-riley',
        periodKey: PERIOD,
        units: 40,
        idempotencyKey: 'riley-1',
        paidSlots: 1,
        activeChildIds: ['child-riley'],
      },
      DEFAULT_ALLOWANCE_CONFIG,
      random,
    );
    if (!riley.ok) throw new Error(riley.error.code);
    // Still in flight (neither committed nor released) when the slot moves to Sam.
    const sam = reserve(
      riley.value.state,
      {
        childId: 'child-sam',
        periodKey: PERIOD,
        units: 1,
        idempotencyKey: 'sam-1',
        paidSlots: 1,
        activeChildIds: ['child-sam'],
      },
      DEFAULT_ALLOWANCE_CONFIG,
      random,
    );
    expect(!sam.ok && sam.error.details?.['scope']).toBe('family');
    // A release of Riley's in-flight scan returns the pages to the family ceiling.
    const freed = release(riley.value.state, riley.value.reservation.id, 'unreadable');
    if (!freed.ok) throw new Error(freed.error.code);
    expect(
      allowanceUsage(freed.value.state, {
        childId: 'child-sam',
        periodKey: PERIOD,
        paidSlots: 1,
      }).availableUnits,
    ).toBe(40);
  });

  it('a replayed upload event after the child lost entitlement returns the original charge only', () => {
    const random = counterRandom();
    const first = reserve(
      EMPTY_ALLOWANCE_STATE,
      {
        childId: 'child-riley',
        periodKey: PERIOD,
        units: 3,
        idempotencyKey: 'upload-9',
        paidSlots: 1,
        activeChildIds: ['child-riley'],
      },
      DEFAULT_ALLOWANCE_CONFIG,
      random,
    );
    if (!first.ok) throw new Error(first.error.code);
    const committed = commit(first.value.state, first.value.reservation.id);
    if (!committed.ok) throw new Error(committed.error.code);
    const replay = reserve(
      committed.value.state,
      {
        childId: 'child-riley',
        periodKey: PERIOD,
        units: 3,
        idempotencyKey: 'upload-9',
        paidSlots: 0,
        activeChildIds: [],
      },
      DEFAULT_ALLOWANCE_CONFIG,
      random,
    );
    expect(replay.ok && replay.value.changed).toBe(false);
    expect(replay.ok && replay.value.state).toBe(committed.value.state);
  });

  it('alerts exactly at a threshold boundary and never below it', () => {
    const at = evaluateSpend({
      budgetMicros: 3,
      committedMicros: 0,
      inFlightReservedMicros: 0,
      // 1 of 3 micros is 33.3%: exact integer math crosses 33 but not 34 or 50.
      requestEstimateMicros: 1,
      alertThresholdsPercent: [33, 34, 50],
      alreadyAlerted: [],
    });
    expect(at.ok && at.value.newlyCrossedThresholds).toEqual([33]);
  });

  it('opaque identifiers such as "__proto__" are compared as data only', () => {
    const random = counterRandom();
    const result = reserve(
      EMPTY_ALLOWANCE_STATE,
      {
        childId: '__proto__',
        periodKey: 'constructor',
        units: 1,
        idempotencyKey: 'toString',
        paidSlots: 1,
        activeChildIds: ['__proto__'],
      },
      DEFAULT_ALLOWANCE_CONFIG,
      random,
    );
    expect(result.ok && result.value.reservation.status).toBe('reserved');
    expect(({} as Record<string, unknown>)['units']).toBeUndefined();
  });
});
