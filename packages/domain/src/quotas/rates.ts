import { err, ok, type Result } from '../shared/result.ts';
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from './ids.ts';

/**
 * Billing rates for one model, in integer micro-USD per 1,000,000 tokens (spec P12: "Keep billing
 * rates in a versioned server table"). `cachedInputPerMillionMicros: null` means the cached-input
 * rate for the selected project configuration is unknown/unverified.
 */
export interface ModelRate {
  readonly inputPerMillionMicros: number;
  readonly outputPerMillionMicros: number;
  readonly cachedInputPerMillionMicros: number | null;
}

export interface ModelRateTable {
  /** Rate table version; stored with every metered operation so historical costs stay auditable. */
  readonly version: string;
  readonly models: Readonly<Record<string, ModelRate>>;
}

const MICROS_PER_USD = 1_000_000;
const TOKENS_PER_RATE_UNIT = 1_000_000n;

/**
 * Standard short-context OpenAI prices checked 2026-09-18 (spec F6): Astra $10/$50,
 * Terra $2/$12, Luna $0.20/$1.20 per 1M input/output tokens. Cached-input rates are left `null`
 * (unknown): the base estimate assumes no cache discount (spec P12) and cached tokens are billed at
 * the full input rate until an owner-verified rate is added in a new table version.
 */
export const DEFAULT_RATE_TABLE_2026_09_18: ModelRateTable = Object.freeze({
  version: '2026-09-18',
  models: Object.freeze({
    'gpt-6-astra': Object.freeze({
      inputPerMillionMicros: 10 * MICROS_PER_USD,
      outputPerMillionMicros: 50 * MICROS_PER_USD,
      cachedInputPerMillionMicros: null,
    }),
    'gpt-5.6-terra': Object.freeze({
      inputPerMillionMicros: 2 * MICROS_PER_USD,
      outputPerMillionMicros: 12 * MICROS_PER_USD,
      cachedInputPerMillionMicros: null,
    }),
    'gpt-5.6-luna': Object.freeze({
      inputPerMillionMicros: 200_000,
      outputPerMillionMicros: 1_200_000,
      cachedInputPerMillionMicros: null,
    }),
  }),
});

/**
 * Provider-reported usage for one billed request.
 * - `inputTokens` is the TOTAL billed input and already includes image tokens.
 * - `cachedInputTokens` is the subset of `inputTokens` served from cache (never additional).
 * - `outputTokens` is the TOTAL billed output and already includes reasoning tokens.
 */
export interface OperationUsage {
  readonly modelId: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

export type CostAssumption = 'cached_rate_unknown_billed_full';

export interface OperationCost {
  readonly costMicros: number;
  readonly rateTableVersion: string;
  readonly assumptions: readonly CostAssumption[];
}

export const COST_ERROR_CODES = [
  'UNKNOWN_MODEL',
  'INVALID_USAGE',
  'INVALID_RATE',
  'COST_OUT_OF_RANGE',
] as const;
export type CostErrorCode = (typeof COST_ERROR_CODES)[number];

function lookupRate(rates: ModelRateTable, modelId: string): ModelRate | undefined {
  // Model ids arrive from provider payloads/config: only own keys count, so '__proto__',
  // 'constructor' etc. can never resolve to an inherited object.
  if (typeof modelId !== 'string' || !Object.hasOwn(rates.models, modelId)) return undefined;
  return rates.models[modelId];
}

/**
 * Decision (RV-quotas-3): every known rate must be a POSITIVE integer. The table only holds billed
 * models, so a 0 rate is a misconfiguration that would price calls at $0 and keep stage caps and
 * the spend ceiling from ever tripping (AC_FIN_01: unknown rates are explicit, never silently
 * zero). An unknown cached rate is expressed as `null`, never as 0.
 */
function isValidRate(rate: ModelRate): boolean {
  return (
    isPositiveSafeInteger(rate.inputPerMillionMicros) &&
    isPositiveSafeInteger(rate.outputPerMillionMicros) &&
    (rate.cachedInputPerMillionMicros === null ||
      isPositiveSafeInteger(rate.cachedInputPerMillionMicros))
  );
}

/**
 * Cost of one billed request in integer micro-USD (spec P12, F3, AC_FIN_04).
 *
 * Billing categories are mutually exclusive: uncached input, cached input and output. Cached tokens
 * are carved out of `inputTokens` and billed exactly once. Image and reasoning tokens are already
 * inside the input/output totals, so no extra multiplier is ever applied.
 *
 * Decision: the exact product is accumulated with BigInt and rounded half-up to a whole micro-USD
 * once at the end. `divideRoundHalfUp` (shared/money.ts) is not reused here because token × rate
 * products routinely exceed 2^53 and that helper requires safe-integer numerators; the rounding rule
 * is the same (ROUND_HALF_UP).
 */
export function computeOperationCostMicros(
  rates: ModelRateTable,
  usage: OperationUsage,
): Result<OperationCost, CostErrorCode> {
  return priceUsage(rates, usage, 'half_up');
}

/** `half_up` for billed cost (spec rule); `up` for upper-bound holds, which must never under-hold. */
type MicroRounding = 'half_up' | 'up';

function priceUsage(
  rates: ModelRateTable,
  usage: OperationUsage,
  rounding: MicroRounding,
): Result<OperationCost, CostErrorCode> {
  const rate = lookupRate(rates, usage.modelId);
  if (rate === undefined) {
    return err('UNKNOWN_MODEL', 'Model is not in the billing rate table', {
      rateTableVersion: rates.version,
    });
  }
  if (!isValidRate(rate)) {
    return err('INVALID_RATE', 'Billing rate row is malformed; refusing to price at a guess', {
      rateTableVersion: rates.version,
    });
  }
  const { inputTokens, cachedInputTokens, outputTokens } = usage;
  if (
    !isNonNegativeSafeInteger(inputTokens) ||
    !isNonNegativeSafeInteger(cachedInputTokens) ||
    !isNonNegativeSafeInteger(outputTokens) ||
    cachedInputTokens > inputTokens
  ) {
    return err(
      'INVALID_USAGE',
      'Token counts must be non-negative integers with cached input a subset of total input',
    );
  }

  const assumptions: CostAssumption[] = [];
  let cachedRate = rate.cachedInputPerMillionMicros;
  if (cachedRate === null) {
    // Decision: an unknown cached rate is billed at the full input rate (never a guessed discount).
    cachedRate = rate.inputPerMillionMicros;
    if (cachedInputTokens > 0) assumptions.push('cached_rate_unknown_billed_full');
  }

  const numerator =
    BigInt(inputTokens - cachedInputTokens) * BigInt(rate.inputPerMillionMicros) +
    BigInt(cachedInputTokens) * BigInt(cachedRate) +
    BigInt(outputTokens) * BigInt(rate.outputPerMillionMicros);
  const rounded =
    rounding === 'up'
      ? (numerator + TOKENS_PER_RATE_UNIT - 1n) / TOKENS_PER_RATE_UNIT
      : (numerator * 2n + TOKENS_PER_RATE_UNIT) / (TOKENS_PER_RATE_UNIT * 2n);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    return err('COST_OUT_OF_RANGE', 'Operation cost exceeds the representable micro-USD range');
  }
  return ok({
    costMicros: Number(rounded),
    rateTableVersion: rates.version,
    assumptions,
  });
}

export interface UpperBoundEstimateInput {
  readonly modelId: string;
  /** Planned input tokens including images. */
  readonly inputTokens: number;
  /** The stage's output token budget (billed output incl. reasoning can reach it). */
  readonly maxOutputTokens: number;
}

/**
 * Worst-case cost of one attempt, used for in-flight spend reservations and stage cost caps.
 * Decision: no cache discount is assumed (spec P12 base estimate) and the exact product is rounded
 * UP to a whole micro-USD, so the reservation can only over-hold, never under-hold; settlement
 * reconciles to the actual billed usage. With the positive rates isValidRate requires, a positive
 * output budget therefore always gives an estimate of at least 1 micro-USD, which canAttempt and
 * reserveSpend require (RV-quotas-4).
 */
export function estimateUpperBoundCostMicros(
  rates: ModelRateTable,
  input: UpperBoundEstimateInput,
): Result<number, CostErrorCode> {
  const cost = priceUsage(
    rates,
    {
      modelId: input.modelId,
      inputTokens: input.inputTokens,
      cachedInputTokens: 0,
      outputTokens: input.maxOutputTokens,
    },
    'up',
  );
  return cost.ok ? ok(cost.value.costMicros) : cost;
}
