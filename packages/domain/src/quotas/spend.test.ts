import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RandomSource } from '../shared/random.ts';
import {
  DEFAULT_ALERT_THRESHOLDS_PERCENT,
  EMPTY_SPEND_LEDGER,
  evaluateSpend,
  reserveSpend,
  settleSpend,
  spendTotals,
  type SpendCheckInput,
  type SpendLedger,
  type SpendOutcome,
  type SpendReservation,
  type SpendReserveRequest,
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

function check(overrides: Partial<SpendCheckInput> = {}): SpendCheckInput {
  return {
    budgetMicros: 100_000_000, // an owner-chosen $100 test budget, not a product default
    committedMicros: 0,
    inFlightReservedMicros: 0,
    requestEstimateMicros: 0,
    alreadyAlerted: [],
    ...overrides,
  };
}

function mustEvaluate(input: SpendCheckInput) {
  const result = evaluateSpend(input);
  if (!result.ok) throw new Error(`unexpected ${result.error.code}`);
  return result.value;
}

describe('F4: no budget is invented', () => {
  it.each([null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses to evaluate spend when the budget is %s',
    (budgetMicros) => {
      const result = evaluateSpend(check({ budgetMicros }));
      expect(!result.ok && result.error.code).toBe('BUDGET_NOT_CONFIGURED');
    },
  );

  it('proposes 50/80/100 percent alert thresholds', () => {
    expect(DEFAULT_ALERT_THRESHOLDS_PERCENT).toEqual([50, 80, 100]);
  });

  it.each([
    { committedMicros: -1 },
    { inFlightReservedMicros: 1.5 },
    { requestEstimateMicros: Number.NaN },
    { alertThresholdsPercent: [0] },
    { alertThresholdsPercent: [50.5] },
    { alreadyAlerted: [Number.NaN] },
  ])('rejects malformed spend input %j', (overrides) => {
    const result = evaluateSpend(check(overrides));
    expect(!result.ok && result.error.code).toBe('INVALID_SPEND_INPUT');
  });
});

describe('spend ceiling counts in-flight reservations (AC_SECURITY_06, AC_FIN_09)', () => {
  it('denies a request that fits committed spend but not committed + in-flight', () => {
    const withoutInFlight = mustEvaluate(
      check({ committedMicros: 50_000_000, requestEstimateMicros: 20_000_000 }),
    );
    expect(withoutInFlight.allowed).toBe(true);

    const withInFlight = mustEvaluate(
      check({
        committedMicros: 50_000_000,
        inFlightReservedMicros: 40_000_000,
        requestEstimateMicros: 20_000_000,
      }),
    );
    expect(withInFlight).toMatchObject({ allowed: false, projectedMicros: 110_000_000 });
  });

  it('allows reaching the budget exactly and denies one micro-USD more', () => {
    expect(
      mustEvaluate(check({ committedMicros: 99_000_000, requestEstimateMicros: 1_000_000 })),
    ).toMatchObject({ allowed: true, projectedMicros: 100_000_000 });
    expect(
      mustEvaluate(check({ committedMicros: 99_000_000, requestEstimateMicros: 1_000_001 }))
        .allowed,
    ).toBe(false);
  });
});

describe('alert thresholds fire once each', () => {
  it('reports each newly crossed threshold, in ascending order, and never repeats one', () => {
    const first = mustEvaluate(
      check({ committedMicros: 49_000_000, requestEstimateMicros: 1_000_000 }),
    );
    expect(first.newlyCrossedThresholds).toEqual([50]);

    const second = mustEvaluate(
      check({
        committedMicros: 50_000_000,
        requestEstimateMicros: 1_000_000,
        alreadyAlerted: [50],
      }),
    );
    expect(second.newlyCrossedThresholds).toEqual([]);

    const jump = mustEvaluate(
      check({
        committedMicros: 60_000_000,
        requestEstimateMicros: 40_000_000,
        alreadyAlerted: [50],
      }),
    );
    expect(jump.newlyCrossedThresholds).toEqual([80, 100]);
  });

  it('alerts the owner when a request is denied at the ceiling even though spend stays below it', () => {
    const denied = mustEvaluate(
      check({
        committedMicros: 99_990_000,
        requestEstimateMicros: 50_000,
        alreadyAlerted: [50, 80],
      }),
    );
    expect(denied).toMatchObject({ allowed: false, newlyCrossedThresholds: [100] });
  });

  it('a denied estimate raises only the ceiling alert plus thresholds real spend has reached', () => {
    // Counted spend 10%: the denied $95 request reaches 105% only on paper.
    expect(
      mustEvaluate(check({ committedMicros: 10_000_000, requestEstimateMicros: 95_000_000 }))
        .newlyCrossedThresholds,
    ).toEqual([100]);
    // Counted spend (committed + in-flight) 60%: 50 is real, 80 is not.
    expect(
      mustEvaluate(
        check({
          committedMicros: 40_000_000,
          inFlightReservedMicros: 20_000_000,
          requestEstimateMicros: 50_000_000,
        }),
      ).newlyCrossedThresholds,
    ).toEqual([50, 100]);
  });

  it('a denial never raises a configured above-ceiling threshold that real spend has not reached', () => {
    const thresholds = { alertThresholdsPercent: [50, 80, 120] };
    expect(
      mustEvaluate(
        check({ ...thresholds, committedMicros: 10_000_000, requestEstimateMicros: 120_000_000 }),
      ),
    ).toMatchObject({ allowed: false, newlyCrossedThresholds: [] });
    // Settlements above their estimates can take real spend past the budget; then it is reported.
    expect(mustEvaluate(check({ ...thresholds, committedMicros: 125_000_000 }))).toMatchObject({
      allowed: false,
      newlyCrossedThresholds: [50, 80, 120],
    });
  });

  it('property: every reported threshold below 100% was reached by counted spend', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000_000 }),
        fc.nat({ max: 1_000_000_000 }),
        fc.nat({ max: 1_000_000_000 }),
        fc.nat({ max: 2_000_000_000 }),
        (budgetMicros, committedMicros, inFlightReservedMicros, requestEstimateMicros) => {
          const result = mustEvaluate(
            check({ budgetMicros, committedMicros, inFlightReservedMicros, requestEstimateMicros }),
          );
          const counted =
            committedMicros + inFlightReservedMicros + (result.allowed ? requestEstimateMicros : 0);
          return result.newlyCrossedThresholds
            .filter((t) => t !== 100)
            .every((t) => counted * 100 >= t * budgetMicros);
        },
      ),
    );
  });

  it('property: along any spending path each configured threshold is reported at most once', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000_000 }),
        fc.array(fc.integer({ min: 0, max: 400_000_000 }), { maxLength: 40 }),
        (budgetMicros, requests) => {
          const alerted: number[] = [];
          let committed = 0;
          for (const estimate of requests) {
            const result = mustEvaluate(
              check({
                budgetMicros,
                committedMicros: committed,
                requestEstimateMicros: estimate,
                alreadyAlerted: alerted,
              }),
            );
            for (const t of result.newlyCrossedThresholds) {
              if (alerted.includes(t)) return false;
              alerted.push(t);
            }
            if (result.allowed) committed += estimate;
            if (committed > budgetMicros) return false;
          }
          return true;
        },
      ),
    );
  });
});

describe('spend ledger reserves and reconciles concurrent AI spend (AC_FIN_09)', () => {
  const BUDGET = 1_000_000; // $1 synthetic test budget

  function spendRequest(overrides: Partial<SpendReserveRequest> = {}): SpendReserveRequest {
    return {
      idempotencyKey: 'op-1',
      stage: 'extraction',
      estimateMicros: 600_000,
      budgetMicros: BUDGET,
      alreadyAlerted: [],
      ...overrides,
    };
  }

  function mustReserveSpend(ledger: SpendLedger, req: SpendReserveRequest, random: RandomSource) {
    const result = reserveSpend(ledger, req, random);
    if (!result.ok) throw new Error(`unexpected ${result.error.code}`);
    return result.value;
  }

  it('denies a second concurrent operation while the first is still in flight', () => {
    const random = counterRandom();
    const first = mustReserveSpend(EMPTY_SPEND_LEDGER, spendRequest(), random);
    expect(first.kind).toBe('reserved');
    expect(spendTotals(first.ledger)).toEqual({
      committedMicros: 0,
      inFlightReservedMicros: 600_000,
    });

    const second = mustReserveSpend(first.ledger, spendRequest({ idempotencyKey: 'op-2' }), random);
    expect(second.kind).toBe('denied');
    expect(second.ledger).toBe(first.ledger);
  });

  it('replays a duplicate reservation without reserving twice', () => {
    const random = counterRandom();
    const first = mustReserveSpend(EMPTY_SPEND_LEDGER, spendRequest(), random);
    const again = mustReserveSpend(first.ledger, spendRequest(), random);
    expect(again.kind).toBe('replayed');
    expect(again.ledger).toBe(first.ledger);
    expect(spendTotals(again.ledger).inFlightReservedMicros).toBe(600_000);
  });

  it('refuses to reuse an idempotency key for a different operation', () => {
    const random = counterRandom();
    const first = mustReserveSpend(EMPTY_SPEND_LEDGER, spendRequest(), random);
    const result = reserveSpend(first.ledger, spendRequest({ stage: 'grading' }), random);
    expect(!result.ok && result.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  it('counts a failed but billed attempt as committed spend', () => {
    const random = counterRandom();
    const first = mustReserveSpend(EMPTY_SPEND_LEDGER, spendRequest(), random);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    const settled = settleSpend(first.ledger, first.reservation.id, {
      actualMicros: 22_400,
      outcome: 'failed_billed',
    });
    if (!settled.ok) throw new Error('settle failed');
    expect(spendTotals(settled.value.ledger)).toEqual({
      committedMicros: 22_400,
      inFlightReservedMicros: 0,
    });
  });

  it('reconciles to actual usage even when it exceeds the estimate', () => {
    const random = counterRandom();
    const first = mustReserveSpend(EMPTY_SPEND_LEDGER, spendRequest(), random);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    const settled = settleSpend(first.ledger, first.reservation.id, {
      actualMicros: 700_000,
      outcome: 'succeeded',
    });
    if (!settled.ok) throw new Error('settle failed');
    expect(spendTotals(settled.value.ledger).committedMicros).toBe(700_000);
    // Nothing further fits under the $1 budget once the true cost is known.
    const next = mustReserveSpend(
      settled.value.ledger,
      spendRequest({ idempotencyKey: 'op-2', estimateMicros: 300_001 }),
      random,
    );
    expect(next.kind).toBe('denied');
  });

  it('releases the in-flight hold when an operation was cancelled before any billing', () => {
    const random = counterRandom();
    const first = mustReserveSpend(EMPTY_SPEND_LEDGER, spendRequest(), random);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    const settled = settleSpend(first.ledger, first.reservation.id, {
      actualMicros: 0,
      outcome: 'cancelled_unbilled',
    });
    if (!settled.ok) throw new Error('settle failed');
    expect(spendTotals(settled.value.ledger)).toEqual({
      committedMicros: 0,
      inFlightReservedMicros: 0,
    });
  });

  it('rejects an "unbilled" settlement that carries a cost', () => {
    const random = counterRandom();
    const first = mustReserveSpend(EMPTY_SPEND_LEDGER, spendRequest(), random);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    const settled = settleSpend(first.ledger, first.reservation.id, {
      actualMicros: 5,
      outcome: 'cancelled_unbilled',
    });
    expect(!settled.ok && settled.error.code).toBe('INVALID_SPEND_INPUT');
  });

  it('is idempotent for an identical settlement and rejects a conflicting one', () => {
    const random = counterRandom();
    const first = mustReserveSpend(EMPTY_SPEND_LEDGER, spendRequest(), random);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    const once = settleSpend(first.ledger, first.reservation.id, {
      actualMicros: 10,
      outcome: 'succeeded',
    });
    if (!once.ok) throw new Error('settle failed');
    const same = settleSpend(once.value.ledger, first.reservation.id, {
      actualMicros: 10,
      outcome: 'succeeded',
    });
    expect(same.ok && same.value.changed).toBe(false);
    expect(same.ok && same.value.ledger).toBe(once.value.ledger);
    const conflict = settleSpend(once.value.ledger, first.reservation.id, {
      actualMicros: 11,
      outcome: 'succeeded',
    });
    expect(!conflict.ok && conflict.error.code).toBe('INVALID_TRANSITION');
    const missing = settleSpend(once.value.ledger, 'nope', {
      actualMicros: 1,
      outcome: 'succeeded',
    });
    expect(!missing.ok && missing.error.code).toBe('RESERVATION_NOT_FOUND');
  });

  it('refuses to reserve when no budget has been configured', () => {
    const result = reserveSpend(
      EMPTY_SPEND_LEDGER,
      spendRequest({ budgetMicros: null }),
      counterRandom(),
    );
    expect(!result.ok && result.error.code).toBe('BUDGET_NOT_CONFIGURED');
  });

  describe('a corrupt persisted ledger fails closed instead of counting low (RV-quotas-5)', () => {
    const row = (overrides: Partial<SpendReservation>): SpendReservation => ({
      id: 'r1',
      idempotencyKey: 'op-r1',
      stage: 'extraction',
      estimateMicros: 600_000,
      status: 'settled',
      actualMicros: 400_000,
      outcome: 'succeeded',
      ...overrides,
    });
    it.each<[string, Partial<SpendReservation>]>([
      ['settled with no recorded cost', { actualMicros: null }],
      ['settled with a negative cost', { actualMicros: -1 }],
      ['settled with a fractional cost', { actualMicros: 0.5 }],
      ['settled with no outcome', { outcome: null }],
      ['settled with an unknown outcome', { outcome: 'refunded' as SpendOutcome }],
      ['unbilled but carrying a cost', { outcome: 'cancelled_unbilled', actualMicros: 5 }],
      ['in flight with a negative hold', { status: 'in_flight', estimateMicros: -600_000 }],
      ['in flight with a zero hold', { status: 'in_flight', estimateMicros: 0 }],
      [
        'in flight but already carrying a settlement',
        { status: 'in_flight', actualMicros: 0, outcome: 'cancelled_unbilled' },
      ],
      ['with an unknown status', { status: 'void' as SpendReservation['status'] }],
    ])('rejects a row %s', (_label, overrides) => {
      const ledger: SpendLedger = { reservations: [row({}), row({ id: 'r2', ...overrides })] };
      expect(() => spendTotals(ledger)).toThrow(RangeError);
      expect(() =>
        reserveSpend(ledger, spendRequest({ idempotencyKey: 'op-new' }), counterRandom()),
      ).toThrow(RangeError);
    });

    it('still counts well-formed settled and in-flight rows exactly', () => {
      const ledger: SpendLedger = {
        reservations: [
          row({}),
          row({ id: 'r2', outcome: 'failed_billed', actualMicros: 22_400 }),
          row({ id: 'r3', outcome: 'cancelled_unbilled', actualMicros: 0 }),
          row({ id: 'r4', status: 'in_flight', actualMicros: null, outcome: null }),
        ],
      };
      expect(spendTotals(ledger)).toEqual({
        committedMicros: 422_400,
        inFlightReservedMicros: 600_000,
      });
    });
  });

  it('property: committed spend never exceeds the budget while actuals stay within estimates', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            estimate: fc.integer({ min: 1, max: 400_000 }),
            actualFraction: fc.integer({ min: 0, max: 100 }),
            settle: fc.boolean(),
            billed: fc.boolean(),
          }),
          { maxLength: 40 },
        ),
        (ops) => {
          const random = counterRandom();
          let ledger = EMPTY_SPEND_LEDGER;
          let alerted: readonly number[] = [];
          ops.forEach((o, i) => {
            const reserved = mustReserveSpend(
              ledger,
              spendRequest({
                idempotencyKey: `op-${i}`,
                estimateMicros: o.estimate,
                alreadyAlerted: alerted,
              }),
              random,
            );
            ledger = reserved.ledger;
            if (reserved.kind === 'replayed') return;
            alerted = [...alerted, ...reserved.evaluation.newlyCrossedThresholds];
            if (reserved.kind === 'reserved' && o.settle) {
              const actual = o.billed ? Math.floor((o.estimate * o.actualFraction) / 100) : 0;
              const settled = settleSpend(ledger, reserved.reservation.id, {
                actualMicros: actual,
                outcome: o.billed ? 'failed_billed' : 'cancelled_unbilled',
              });
              if (!settled.ok) throw new Error(settled.error.code);
              ledger = settled.value.ledger;
            }
          });
          const totals = spendTotals(ledger);
          return (
            totals.committedMicros + totals.inFlightReservedMicros <= BUDGET &&
            new Set(alerted).size === alerted.length
          );
        },
      ),
    );
  });
});
