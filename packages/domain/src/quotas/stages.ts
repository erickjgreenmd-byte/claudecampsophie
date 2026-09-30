import { isNonNegativeSafeInteger, isPositiveSafeInteger } from './ids.ts';

/** Metered AI stages (spec F3), each with its own attempt/time/token/cost limits (spec P12, F4). */
export const AI_STAGES = [
  'extraction',
  'grading',
  'verification',
  'coaching',
  'followup',
  'daily_set',
  'thursday_bundle',
  'semantic_check',
  'escalation',
  'adult_summary',
  /**
   * The adult ID check (migration 0980): reading a government photo ID to establish adulthood. Its own
   * stage rather than a reuse of `extraction` because it is an ADULT's document rather than a child's
   * homework, and conflating the two would put identity spend in the family's homework metering and
   * the homework ceiling on the identity check.
   */
  'identity_document',
  /**
   * The face comparison half of the same check, metered separately because it is a DIFFERENT question
   * with a different answer available to different providers: OpenAI's policies forbid biometric
   * comparison and its models decline, while an identity vendor answers it. Separate stages keep the
   * spend of the half that may be bought from a vendor visible on its own, and keep one prompt per
   * stage — `STAGE_FLOOR_INPUT_TOKENS` is per stage and the two prompts do not share a floor.
   */
  'identity_face_compare',
] as const;
export type AiStage = (typeof AI_STAGES)[number];

export function isAiStage(value: unknown): value is AiStage {
  return typeof value === 'string' && (AI_STAGES as readonly string[]).includes(value);
}

/**
 * Limits for the original request plus retries/escalation of one stage of one operation.
 * `timeoutMs` and `maxOutputTokens` are enforced by the AI adapter; `canAttempt` enforces the
 * attempt count and cumulative cost.
 */
export interface StageLimits {
  /** Original request + retries. */
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  /** Cumulative billed cost cap for the stage, including failed billed attempts. */
  readonly maxCostMicros: number;
}

export type StageLimitsTable = Readonly<Record<AiStage, StageLimits>>;

export type StageDenyReason = 'MAX_ATTEMPTS' | 'STAGE_COST_CAP';

export type AttemptDecision =
  { readonly allow: true } | { readonly allow: false; readonly deny: StageDenyReason };

export interface AttemptUsage {
  /** Attempts already started for this stage, including failed and timed-out ones. */
  readonly attemptsSoFar: number;
  /** Billed micro-USD so far for this stage, INCLUDING failed attempts that cost money (spec F3). */
  readonly spentMicrosSoFar: number;
  /**
   * Upper-bound estimate for the next attempt (see estimateUpperBoundCostMicros); must be positive
   * because every provider attempt is billed more than 0 micros.
   */
  readonly nextEstimateMicros: number;
}

function assertStageLimits(limits: StageLimits, label: string): void {
  for (const key of ['maxAttempts', 'timeoutMs', 'maxOutputTokens', 'maxCostMicros'] as const) {
    if (!isPositiveSafeInteger(limits[key])) {
      throw new RangeError(`${label}.${key} must be a positive integer`);
    }
  }
}

/**
 * Validates and freezes a complete per-stage limit table.
 * Decision: no default limits are shipped. Numbers must come from the owner-approved benchmark
 * (spec P12/F3), and a missing or non-positive limit is a configuration error that throws so the
 * worker fails closed at startup instead of running a stage without a cap.
 */
export function defineStageLimits(table: Readonly<Record<AiStage, StageLimits>>): StageLimitsTable {
  const out = {} as Record<AiStage, StageLimits>;
  for (const stage of AI_STAGES) {
    if (!Object.hasOwn(table, stage)) throw new RangeError(`Missing limits for stage ${stage}`);
    const limits = table[stage];
    assertStageLimits(limits, stage);
    out[stage] = Object.freeze({
      maxAttempts: limits.maxAttempts,
      timeoutMs: limits.timeoutMs,
      maxOutputTokens: limits.maxOutputTokens,
      maxCostMicros: limits.maxCostMicros,
    });
  }
  return Object.freeze(out);
}

/**
 * Whether another attempt (original request or retry) may start for a stage.
 *
 * Decision: corrupt counters (negative, fractional, NaN) throw rather than return a decision,
 * because `NaN` comparisons are always false and would otherwise silently allow unbounded spend.
 * A zero `nextEstimateMicros` is corrupt too (RV-quotas-4): no billed attempt costs 0, and a 0
 * upper bound would let an attempt start with no cost headroom left (spent === cap) and push the
 * stage past its cap. This matches reserveSpend, which also requires a positive estimate.
 */
export function canAttempt(limits: StageLimits, usage: AttemptUsage): AttemptDecision {
  assertStageLimits(limits, 'limits');
  const { attemptsSoFar, spentMicrosSoFar, nextEstimateMicros } = usage;
  if (!isNonNegativeSafeInteger(attemptsSoFar) || !isNonNegativeSafeInteger(spentMicrosSoFar)) {
    throw new RangeError('Attempt usage must be non-negative integers');
  }
  if (!isPositiveSafeInteger(nextEstimateMicros)) {
    throw new RangeError('nextEstimateMicros must be a positive integer upper bound');
  }
  if (attemptsSoFar >= limits.maxAttempts) return { allow: false, deny: 'MAX_ATTEMPTS' };
  if (spentMicrosSoFar + nextEstimateMicros > limits.maxCostMicros) {
    return { allow: false, deny: 'STAGE_COST_CAP' };
  }
  return { allow: true };
}
