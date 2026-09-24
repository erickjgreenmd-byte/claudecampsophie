import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  computeOperationCostMicros,
  DEFAULT_RATE_TABLE_2026_09_18,
  estimateUpperBoundCostMicros,
  type ModelRateTable,
} from './index.ts';

const RATES = DEFAULT_RATE_TABLE_2026_09_18;

function costOf(
  rates: ModelRateTable,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number {
  const result = computeOperationCostMicros(rates, {
    modelId,
    inputTokens,
    cachedInputTokens,
    outputTokens,
  });
  if (!result.ok) throw new Error(`unexpected ${result.error.code}`);
  return result.value.costMicros;
}

/** A synthetic table used to prove rounding/caching rules independently of published prices. */
function syntheticTable(
  inputPerMillionMicros: number,
  outputPerMillionMicros: number,
  cachedInputPerMillionMicros: number | null,
): ModelRateTable {
  return {
    version: 'test-synthetic',
    models: {
      'test-model': { inputPerMillionMicros, outputPerMillionMicros, cachedInputPerMillionMicros },
    },
  };
}

describe('P12 versioned rate table (published 2026-09-18 standard short-context prices)', () => {
  it('holds Astra $10/$50, Terra $2/$12, Luna $0.20/$1.20 per 1M tokens as integer micro-USD', () => {
    expect(RATES.version).toBe('2026-09-18');
    expect(RATES.models['gpt-6-astra']).toEqual({
      inputPerMillionMicros: 10_000_000,
      outputPerMillionMicros: 50_000_000,
      cachedInputPerMillionMicros: null,
    });
    expect(RATES.models['gpt-5.6-terra']).toEqual({
      inputPerMillionMicros: 2_000_000,
      outputPerMillionMicros: 12_000_000,
      cachedInputPerMillionMicros: null,
    });
    expect(RATES.models['gpt-5.6-luna']).toEqual({
      inputPerMillionMicros: 200_000,
      outputPerMillionMicros: 1_200_000,
      cachedInputPerMillionMicros: null,
    });
  });

  it('cannot be altered at runtime (a rate change is a new table version)', () => {
    expect(Object.isFrozen(RATES)).toBe(true);
    expect(Object.isFrozen(RATES.models)).toBe(true);
    expect(Object.isFrozen(RATES.models['gpt-5.6-terra'])).toBe(true);
  });
});

describe('F6 per-call cost examples reproduce exactly (AC_FIN_04)', () => {
  it.each([
    // stage, model, input incl. images, billed output incl. reasoning, micro-USD
    ['vision extraction', 'gpt-5.6-terra', 4000, 1200, 22_400], // $0.0224
    ['private grading', 'gpt-5.6-terra', 2500, 2000, 29_000],
    ['original explanation', 'gpt-6-astra', 1000, 1500, 85_000],
    ['follow-up coaching', 'gpt-6-astra', 1200, 500, 37_000],
    ['Thursday bundle', 'gpt-6-astra', 2500, 4000, 225_000],
    ['homework verification', 'gpt-5.6-terra', 4000, 600, 15_200],
    ['difficult-page escalation', 'gpt-6-astra', 4000, 2000, 140_000],
    ['adult weekly summary', 'gpt-5.6-luna', 4000, 1000, 2_000],
  ] as const)('%s on %s: %i in / %i out = %i micros', (_stage, model, input, output, micros) => {
    const result = computeOperationCostMicros(RATES, {
      modelId: model,
      inputTokens: input,
      cachedInputTokens: 0,
      outputTokens: output,
    });
    expect(result).toEqual({
      ok: true,
      value: { costMicros: micros, rateTableVersion: '2026-09-18', assumptions: [] },
    });
  });

  it('matches the F6 monthly line: 80 Terra extractions = $1.79 (1,792,000 micros)', () => {
    expect(80 * costOf(RATES, 'gpt-5.6-terra', 4000, 1200)).toBe(1_792_000);
  });

  it('bills image and reasoning tokens only through the totals they are already included in', () => {
    // With whole-micro-per-token rates the cost is exactly the linear formula: no per-image or
    // reasoning multiplier is ever added on top of input/output totals.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50_000_000 }),
        fc.integer({ min: 0, max: 50_000_000 }),
        (input, output) => costOf(RATES, 'gpt-6-astra', input, output) === 10 * input + 50 * output,
      ),
    );
  });
});

describe('cached input is a subset of input and is never billed twice (AC_FIN_04)', () => {
  it('bills cached tokens once at the cached rate', () => {
    const table = syntheticTable(2_000_000, 12_000_000, 500_000);
    // 3000 uncached * 2 + 1000 cached * 0.5 + 1200 * 12 = 6000 + 500 + 14400
    expect(costOf(table, 'test-model', 4000, 1200, 1000)).toBe(20_900);
  });

  it('bills cached tokens at the full input rate when the cached rate is unknown, and says so', () => {
    const result = computeOperationCostMicros(RATES, {
      modelId: 'gpt-5.6-terra',
      inputTokens: 4000,
      cachedInputTokens: 1000,
      outputTokens: 1200,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        costMicros: 22_400,
        rateTableVersion: '2026-09-18',
        assumptions: ['cached_rate_unknown_billed_full'],
      },
    });
  });

  it('records no caching assumption when nothing was cached', () => {
    const result = computeOperationCostMicros(RATES, {
      modelId: 'gpt-5.6-terra',
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(result.ok && result.value.assumptions).toEqual([]);
  });

  it('property: when cached rate equals the input rate, how many tokens were cached never changes cost', () => {
    const table = syntheticTable(2_000_000, 12_000_000, 2_000_000);
    fc.assert(
      fc.property(
        fc
          .integer({ min: 0, max: 10_000_000 })
          .chain((input) =>
            fc.tuple(
              fc.constant(input),
              fc.integer({ min: 0, max: input }),
              fc.integer({ min: 0, max: 10_000_000 }),
            ),
          ),
        ([input, cached, output]) =>
          costOf(table, 'test-model', input, output, cached) ===
          costOf(table, 'test-model', input, output, 0),
      ),
    );
  });

  it('property: a cheaper cached rate never raises cost and never goes below all-cached cost', () => {
    const table = syntheticTable(2_000_000, 12_000_000, 500_000);
    fc.assert(
      fc.property(
        fc
          .integer({ min: 0, max: 10_000_000 })
          .chain((input) =>
            fc.tuple(
              fc.constant(input),
              fc.integer({ min: 0, max: input }),
              fc.integer({ min: 0, max: 10_000_000 }),
            ),
          ),
        ([input, cached, output]) => {
          const cost = costOf(table, 'test-model', input, output, cached);
          return (
            cost <= costOf(table, 'test-model', input, output, 0) &&
            cost >= costOf(table, 'test-model', input, output, input)
          );
        },
      ),
    );
  });

  it('rejects cached counts larger than total input (would imply double counting)', () => {
    const result = computeOperationCostMicros(RATES, {
      modelId: 'gpt-5.6-terra',
      inputTokens: 100,
      cachedInputTokens: 101,
      outputTokens: 0,
    });
    expect(!result.ok && result.error.code).toBe('INVALID_USAGE');
  });
});

describe('exact integer arithmetic', () => {
  it('rounds half up to a whole micro-USD once, at the end', () => {
    const half = syntheticTable(500_000, 500_000, null);
    expect(costOf(half, 'test-model', 1, 0)).toBe(1); // 0.5 -> 1
    expect(costOf(half, 'test-model', 3, 0)).toBe(2); // 1.5 -> 2
    const fifths = syntheticTable(400_000, 400_000, null);
    // 0.4 + 0.4 = 0.8 -> 1; rounding each category first would wrongly give 0.
    expect(costOf(fifths, 'test-model', 1, 1)).toBe(1);
    expect(costOf(RATES, 'gpt-5.6-luna', 2, 0)).toBe(0); // 0.4 -> 0
  });

  it('stays exact beyond 2^53 intermediate products', () => {
    // 4,503,599,627,370,497 Luna input tokens * 0.2 micros = 900,719,925,474,099.4 -> ...099
    expect(costOf(RATES, 'gpt-5.6-luna', 4_503_599_627_370_497, 0)).toBe(900_719_925_474_099);
  });

  it('refuses a cost that cannot be represented as a safe integer', () => {
    const result = computeOperationCostMicros(RATES, {
      modelId: 'gpt-6-astra',
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: Number.MAX_SAFE_INTEGER,
    });
    expect(!result.ok && result.error.code).toBe('COST_OUT_OF_RANGE');
  });
});

describe('untrusted usage and model identifiers', () => {
  it.each(['gpt-6', 'gpt-4o', '', '__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'rejects model id %j as UNKNOWN_MODEL',
    (modelId) => {
      const result = computeOperationCostMicros(RATES, {
        modelId,
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
      });
      expect(!result.ok && result.error.code).toBe('UNKNOWN_MODEL');
    },
  );

  it.each([
    { inputTokens: -1, cachedInputTokens: 0, outputTokens: 0 },
    { inputTokens: 1.5, cachedInputTokens: 0, outputTokens: 0 },
    { inputTokens: Number.NaN, cachedInputTokens: 0, outputTokens: 0 },
    { inputTokens: 10, cachedInputTokens: -1, outputTokens: 0 },
    { inputTokens: 10, cachedInputTokens: 0, outputTokens: Number.POSITIVE_INFINITY },
  ])('rejects malformed token counts %j', (usage) => {
    const result = computeOperationCostMicros(RATES, { modelId: 'gpt-5.6-terra', ...usage });
    expect(!result.ok && result.error.code).toBe('INVALID_USAGE');
  });

  it('fails closed on a malformed rate row instead of pricing at zero', () => {
    const broken: ModelRateTable = {
      version: 'broken',
      models: {
        'test-model': {
          inputPerMillionMicros: Number.NaN,
          outputPerMillionMicros: 1,
          cachedInputPerMillionMicros: null,
        },
      },
    };
    const result = computeOperationCostMicros(broken, {
      modelId: 'test-model',
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
    });
    expect(!result.ok && result.error.code).toBe('INVALID_RATE');
  });

  it.each([
    ['input', syntheticTable(0, 12_000_000, null)],
    ['output', syntheticTable(2_000_000, 0, null)],
    ['cached input (unknown must be null, not 0)', syntheticTable(2_000_000, 12_000_000, 0)],
  ])('fails closed on a zero %s rate instead of charging nothing (AC_FIN_01)', (_label, table) => {
    const result = computeOperationCostMicros(table, {
      modelId: 'test-model',
      inputTokens: 4000,
      cachedInputTokens: 1000,
      outputTokens: 1200,
    });
    expect(!result.ok && result.error.code).toBe('INVALID_RATE');
    const estimate = estimateUpperBoundCostMicros(table, {
      modelId: 'test-model',
      inputTokens: 4000,
      maxOutputTokens: 1200,
    });
    expect(!estimate.ok && estimate.error.code).toBe('INVALID_RATE');
  });
});

describe('upper-bound attempt estimate for in-flight reservations', () => {
  it('rounds a fractional micro-USD up so a hold never under-holds', () => {
    // Luna: 1 input (0.2) + 1 output (1.2) = 1.4 micros: billed cost rounds half up to 1, the
    // upper-bound hold rounds up to 2.
    expect(costOf(RATES, 'gpt-5.6-luna', 1, 1)).toBe(1);
    expect(
      estimateUpperBoundCostMicros(RATES, {
        modelId: 'gpt-5.6-luna',
        inputTokens: 1,
        maxOutputTokens: 1,
      }),
    ).toEqual({ ok: true, value: 2 });
    // The smallest positive rate still gives a positive estimate for a positive output budget,
    // which canAttempt and reserveSpend require (RV-quotas-4).
    expect(
      estimateUpperBoundCostMicros(syntheticTable(1, 1, null), {
        modelId: 'test-model',
        inputTokens: 0,
        maxOutputTokens: 1,
      }),
    ).toEqual({ ok: true, value: 1 });
  });

  it('property: the estimate is never below the billed cost of any usage within it', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-luna'),
        fc
          .nat({ max: 5_000_000 })
          .chain((input) =>
            fc.tuple(
              fc.constant(input),
              fc.nat({ max: input }),
              fc.integer({ min: 1, max: 100_000 }),
            ),
          ),
        fc.nat({ max: 100_000 }),
        (modelId, [inputTokens, cachedInputTokens, maxOutputTokens], outputShortfall) => {
          const estimate = estimateUpperBoundCostMicros(RATES, {
            modelId,
            inputTokens,
            maxOutputTokens,
          });
          if (!estimate.ok) return false;
          const outputTokens = Math.max(0, maxOutputTokens - outputShortfall);
          return (
            estimate.value >= 1 &&
            estimate.value >= costOf(RATES, modelId, inputTokens, outputTokens, cachedInputTokens)
          );
        },
      ),
    );
  });

  it('assumes no cache discount and the full output token budget', () => {
    const result = estimateUpperBoundCostMicros(RATES, {
      modelId: 'gpt-5.6-terra',
      inputTokens: 4000,
      maxOutputTokens: 1200,
    });
    expect(result).toEqual({ ok: true, value: 22_400 });
  });

  it('rejects unknown models', () => {
    const result = estimateUpperBoundCostMicros(RATES, {
      modelId: 'gpt-6',
      inputTokens: 1,
      maxOutputTokens: 1,
    });
    expect(!result.ok && result.error.code).toBe('UNKNOWN_MODEL');
  });
});
