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
 * The cost ceiling extraction and grading share (HUNT5-C-1). It is the smallest ceiling that admits
 * the ONE raised retry a truncated answer gets (JOBS-R2-02 / R4-JOBS-1) at the largest scan the
 * product accepts — ten pages, DEFAULT_HOMEWORK_UPLOAD_LIMITS.maxPages — and at the FULL
 * OUTPUT_TRUNCATED_BUDGET_MULTIPLE, not at a raise of one token that could not fit a longer answer
 * anyway. At terra's 2 micros per input token and 12 per output token a stage needs
 * (2E + 12B) + (2E + 12 x 2B) = 4E + 144,000 micros, E being inputTokenUpperBound of the request the
 * caller really sends. For EXTRACTION that is the data envelope plus one 1,516-token image part per
 * page: 4 x 18,204 + 144,000 = 216,816 at the product's ten-page limit, so extraction's full retry is
 * reachable at every page count the product accepts. At the previous 150,000 it was unreachable from
 * 7 pages up, so a scan inside that limit was cut off and failed final with SCAN_TOO_MANY_QUESTIONS
 * although the retry the comments promised never happened.
 *
 * GRADING sends no image (scan-process.ts's grade() builds ONE data envelope of the questions and the
 * child's answers), so its bound is measured in QUESTIONS, not pages, and the earlier 17,527 figure
 * here was derived from an image-part stand-in that grading never sends. On the same ceiling the full
 * 2x raise is reachable up to about 85 questions of average length and no raise at all past about 149;
 * the exact count moves with question length, because the bound is in bytes
 * (apps/api/tests/jobs-r2.review.test.ts states the measured numbers and names the limit in the case
 * that pins it). So a worksheet of ten dense pages can still be cut off in grading with no retry, and
 * that is a KNOWN, recorded gap rather than something these comments claim is covered: closing it
 * needs a further ceiling raise, which is the owner's cost decision, not a code change.
 * Holds settle to actual usage (settleSpend), so this moves the transient reservation, not the spend:
 * the per-scan reservation in scan-process.ts's `spending()` goes 150,000 -> 216,816 for extraction
 * and 250,000 -> 316,816 for grading+verification (docs/Cost_Analysis.md).
 */
const EXTRACTION_GRADING_COST_MICROS = 216_816;

/**
 * PROPOSED per-stage limits (spec F4): hypotheses to replace with measured p95 latency and token
 * counts (docs/Measured_Usage.md). Costs are integer micro-USD per operation stage.
 */
export const PROPOSED_STAGE_LIMITS = defineStageLimits({
  extraction: {
    maxAttempts: 3,
    timeoutMs: 45_000,
    maxOutputTokens: 4_000,
    maxCostMicros: EXTRACTION_GRADING_COST_MICROS,
  },
  grading: {
    maxAttempts: 3,
    timeoutMs: 45_000,
    maxOutputTokens: 4_000,
    maxCostMicros: EXTRACTION_GRADING_COST_MICROS,
  },
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
