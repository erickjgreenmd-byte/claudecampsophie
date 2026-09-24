import { defineStageLimits, type AiStage } from '@pencillift/domain/quotas';

/**
 * Model routing (spec P12). Model ids are configuration and must be verified against the owner's
 * account at activation; the spec forbids calling an invented endpoint. Child-facing teaching stays
 * on the flagship model (official under-18 guidance) — never silently downgraded for cost.
 */
export const MODEL_IDS = {
  astra: 'gpt-6-astra',
  terra: 'gpt-5.6-terra',
  luna: 'gpt-5.6-luna',
} as const;

export type ModelId = (typeof MODEL_IDS)[keyof typeof MODEL_IDS];

export const STAGE_MODELS: Readonly<Record<AiStage, ModelId>> = {
  extraction: MODEL_IDS.terra,
  grading: MODEL_IDS.terra,
  verification: MODEL_IDS.terra,
  semantic_check: MODEL_IDS.terra,
  coaching: MODEL_IDS.astra,
  followup: MODEL_IDS.astra,
  daily_set: MODEL_IDS.astra,
  thursday_bundle: MODEL_IDS.astra,
  escalation: MODEL_IDS.astra,
  adult_summary: MODEL_IDS.luna,
};

/** Stages whose output a child reads; they must pass the answer guard before release. */
export const CHILD_FACING_STAGES: ReadonlySet<AiStage> = new Set([
  'coaching',
  'followup',
  'daily_set',
  'thursday_bundle',
]);

/**
 * PROPOSED per-stage limits (spec F4): hypotheses to replace with measured p95 latency and token
 * counts (docs/Measured_Usage.md). Costs are integer micro-USD per operation stage.
 */
export const PROPOSED_STAGE_LIMITS = defineStageLimits({
  extraction: { maxAttempts: 3, timeoutMs: 45_000, maxOutputTokens: 4_000, maxCostMicros: 150_000 },
  grading: { maxAttempts: 3, timeoutMs: 45_000, maxOutputTokens: 4_000, maxCostMicros: 150_000 },
  verification: {
    maxAttempts: 2,
    timeoutMs: 45_000,
    maxOutputTokens: 2_000,
    maxCostMicros: 100_000,
  },
  semantic_check: {
    maxAttempts: 2,
    timeoutMs: 30_000,
    maxOutputTokens: 800,
    maxCostMicros: 40_000,
  },
  coaching: { maxAttempts: 2, timeoutMs: 45_000, maxOutputTokens: 2_500, maxCostMicros: 300_000 },
  followup: { maxAttempts: 2, timeoutMs: 30_000, maxOutputTokens: 1_200, maxCostMicros: 150_000 },
  daily_set: { maxAttempts: 2, timeoutMs: 60_000, maxOutputTokens: 3_000, maxCostMicros: 350_000 },
  thursday_bundle: {
    maxAttempts: 2,
    timeoutMs: 90_000,
    maxOutputTokens: 6_000,
    maxCostMicros: 700_000,
  },
  escalation: { maxAttempts: 1, timeoutMs: 90_000, maxOutputTokens: 4_000, maxCostMicros: 500_000 },
  adult_summary: {
    maxAttempts: 2,
    timeoutMs: 45_000,
    maxOutputTokens: 1_500,
    maxCostMicros: 20_000,
  },
});
