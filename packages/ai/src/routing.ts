import {
  AI_STAGES,
  computeOperationCostMicros,
  DEFAULT_RATE_TABLE_2026_09_18,
  defineStageLimits,
  estimateUpperBoundCostMicros,
  type AiStage,
} from '@pencillift/domain/quotas';

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
 *
 * What the raise costs the owner. On a scan that SUCCEEDS it moves the transient reservation only,
 * not the spend: holds settle to actual usage (settleSpend), so the per-scan reservation in
 * scan-process.ts's `spending()` goes 150,000 -> 216,816 for extraction and 250,000 -> 316,816 for
 * grading+verification and nothing more is billed. It does move real spend in one band, because the
 * cap is also the PRE-FLIGHT admission gate: run.ts refuses attempt 1 outright with STAGE_LIMIT and
 * ZERO provider calls when 2E + 12 x maxOutputTokens exceeds the cap. For grading that gate moves
 * from an input bound of exactly 51,000 tokens to 84,408, and inside that band no raise fits either,
 * so a worksheet there now costs exactly ONE billed generation — of the order of 7-8 cents at terra's
 * rates for a 58,000-byte envelope, since E is an upper bound in BYTES and the billed tokens are
 * fewer — where it was refused for free. The parent-facing side is better for it: that scan now ends
 * with the actionable SCAN_TOO_MANY_QUESTIONS message instead of a bare STAGE_LIMIT, which has no copy
 * of its own. Recorded in docs/Cost_Analysis.md.
 *
 * So this ONE number is deliberately both of the two the other stages keep apart (HUNT6-D-CAP): it is
 * extraction's and grading's per-request ADMISSION bound AND their whole-stage budget in
 * PROPOSED_STAGE_COST_BUDGET_MICROS below. That is the owner's recorded decision and not a number
 * borrowed for the retry — the admission band it opened was priced above and is pinned at both edges
 * by apps/api/tests/jobs-r2.review.test.ts. If the owner later wants the pre-HUNT5-C-1 admission
 * bound back, it is now one line: give these two stages `maxCostMicros: 150_000` and leave the budget
 * at 216,816, and the one raised retry still fits at ten pages.
 */
const EXTRACTION_GRADING_COST_MICROS = 216_816;

/**
 * The MOST of a stage's output budget a truncated answer is retried with (JOBS-R2-02): once, at up to
 * this multiple of the configured `maxOutputTokens`, and never past what the stage's cost cap still
 * admits — the owner's ceiling is never exceeded to fit a longer answer. It lives here, next to the
 * caps it is spent against, because `fullRaiseCeiling` below prices it; run.ts re-exports it.
 */
export const OUTPUT_TRUNCATED_BUDGET_MULTIPLE = 2;

/**
 * The floor a stage with no prompt of its own is sized against. A stage that cannot run has no
 * measurable floor, so its cap is set against a bound above the largest floor any prompt in
 * prompts.ts has today (extraction's 2,993 tokens of instructions and strict output schema): writing
 * the prompt later cannot silently put the stage below the full-raise line.
 */
const PROMPTLESS_FLOOR_INPUT_TOKENS = 3_000;

/**
 * The SMALLEST input bound each stage can send: `inputTokenUpperBound` (spend-ceiling.ts) of the
 * stage's instructions and strict output schema plus an EMPTY data envelope. MEASURED, not assumed,
 * and pinned against the production function for every stage that has a prompt by
 * apps/api/tests/jobs-r2.review.test.ts — change a prompt's instructions or schema and that case goes
 * red, because these numbers are what the caps below are derived from. Every real request is LARGER,
 * so a cap sized at this floor is the weakest honest guarantee: the full raise at the floor, and a
 * raise that shrinks as the input grows.
 */
export const STAGE_FLOOR_INPUT_TOKENS: Readonly<Record<AiStage, number>> = {
  extraction: 2_993,
  grading: 2_316,
  verification: 1_199,
  semantic_check: PROMPTLESS_FLOOR_INPUT_TOKENS,
  coaching: 1_626,
  followup: PROMPTLESS_FLOOR_INPUT_TOKENS,
  daily_set: 1_662,
  thursday_bundle: 1_680,
  escalation: PROMPTLESS_FLOOR_INPUT_TOKENS,
  adult_summary: 1_152,
};

/**
 * The smallest `maxCostMicros` at which a stage can still afford the ONE FULL raised retry after an
 * answer cut off at `max_output_tokens` (HUNT6-D-1, the invariant BUG-260 was filed for).
 *
 * It is the exact sum run.ts weighs against the stage BUDGET on that retry (never against the
 * admission bound, which is a per-request number and is not raised to fit a retry — HUNT6-D-CAP),
 * built from the same two
 * production functions rather than re-derived: `computeOperationCostMicros` of the cut-off answer
 * (metered at the stage's floor input and the WHOLE configured output budget, which is what a
 * `max_output_tokens` incomplete reports) plus `estimateUpperBoundCostMicros` of the retry at
 * OUTPUT_TRUNCATED_BUDGET_MULTIPLE x that budget. Below this number `raisedOutputBudget` returns
 * null or a shrunken budget at EVERY input size, so the retry the comments promise cannot happen —
 * which is what four astra stages did until this round: astra costs 10 micros an input token and 50
 * an output token, five times terra, so 3 x 50 x maxOutputTokens alone was already past coaching's,
 * followup's, daily_set's and thursday_bundle's caps. It is priced at the stage's own model and
 * floor input, and it is the floor for PROPOSED_STAGE_COST_BUDGET_MICROS, not for `maxCostMicros`.
 *
 * It is a FLOOR guarantee, not a promise at every input size: above the floor the admissible raise
 * shrinks with the input, and a stage can still end OUTPUT_TRUNCATED with a partial raise on a large
 * request (grading past about 85 questions, below).
 */
export function fullRaiseCeiling(stage: AiStage, maxOutputTokens: number): number {
  const modelId = STAGE_MODELS[stage];
  const inputTokens = STAGE_FLOOR_INPUT_TOKENS[stage];
  const cutOff = computeOperationCostMicros(DEFAULT_RATE_TABLE_2026_09_18, {
    modelId,
    inputTokens,
    cachedInputTokens: 0,
    outputTokens: maxOutputTokens,
  });
  const retry = estimateUpperBoundCostMicros(DEFAULT_RATE_TABLE_2026_09_18, {
    modelId,
    inputTokens,
    maxOutputTokens: maxOutputTokens * OUTPUT_TRUNCATED_BUDGET_MULTIPLE,
  });
  // A stage routed to a model with no rate row cannot be priced at a guess (AC_FIN_01).
  if (!cutOff.ok) throw new RangeError(`fullRaiseCeiling: ${stage}: ${cutOff.error.code}`);
  if (!retry.ok) throw new RangeError(`fullRaiseCeiling: ${stage}: ${retry.error.code}`);
  return cutOff.value.costMicros + retry.value;
}

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
  // Every `maxCostMicros` here is an ADMISSION bound and nothing else: the largest single request
  // the stage may send (see PROPOSED_STAGE_COST_BUDGET_MICROS below, which is what the one raised
  // retry is weighed against). HUNT6-D-1 raised five of them to their full-raise ceiling and that
  // widened admission with them, which admitted an oversized personalization request LJA-F4 exists
  // to prove is refused; they are back at the owner's recorded numbers.
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

/**
 * Validates the per-stage cost BUDGETS against the admission caps they sit beside and the ceiling
 * they exist for, so a new stage, a raised `maxOutputTokens` or a lowered number fails the worker at
 * startup instead of promising a retry it cannot pay for (the same fail-closed rule as
 * `defineStageLimits`). The stages excused from the ceiling are named HERE, in the check itself, so
 * the invariant this file states holds for every stage the check does not name (HUNT6-D-ESCALATION:
 * the comment it replaces claimed every stage while `escalation` sat 160,000 micros below its own
 * ceiling, silently excused).
 */
function defineStageCostBudgets(
  table: Readonly<Record<AiStage, number>>,
): Readonly<Record<AiStage, number>> {
  const excused: AiStage[] = [];
  for (const stage of AI_STAGES) {
    const limits = PROPOSED_STAGE_LIMITS[stage];
    const budget = table[stage];
    // A budget below the admission bound would let a request be admitted and then denied on cost.
    // run.ts's `runStage` makes the same comparison on the pair it is HANDED, so a caller's own
    // `limits` or `maxStageCostMicros` cannot reintroduce that ordering for one call.
    if (!Number.isSafeInteger(budget) || budget < limits.maxCostMicros) {
      throw new RangeError(
        `${stage}: stage budget ${budget} is below its admission cap ${limits.maxCostMicros}`,
      );
    }
    // A stage with one attempt never retries, so no budget makes a raise reachable for it.
    if (limits.maxAttempts < 2) {
      excused.push(stage);
      continue;
    }
    const ceiling = fullRaiseCeiling(stage, limits.maxOutputTokens);
    if (budget < ceiling) {
      throw new RangeError(
        `${stage}: stage budget ${budget} is below its full-raise ceiling ${ceiling}`,
      );
    }
  }
  // `escalation` is the ONE stage excused, by name and for a stated reason. Give it a second attempt
  // and this throws at startup until the owner sets both of its numbers.
  if (excused.join(',') !== 'escalation') {
    throw new RangeError(
      `unexpected stages excused from the full-raise ceiling: ${excused.join(', ')}`,
    );
  }
  return Object.freeze({ ...table });
}

/**
 * The budget for a STAGE AS A WHOLE, in integer micro-USD: the cumulative metered cost of every
 * attempt it may make, including the ONE raised retry a truncated answer gets (JOBS-R2-02), and the
 * worst case the spend HOLD reserves: apps/api/src/jobs/scan-process.ts's `spending()` sums it over
 * the stages of a group, and apps/api/src/jobs/learning-jobs.ts reserves it for the personalization
 * stage. Both are this table and not the caps below (F-HOLD: the personalization hold still reserved
 * `PROPOSED_STAGE_LIMITS[stage].maxCostMicros` after the split, so a stage that took its raised retry
 * could spend past the hold taken for it, and the hold bounded nothing).
 *
 * WHY THIS IS A SECOND NUMBER (HUNT6-D-CAP). `maxCostMicros` above was doing two jobs: the
 * per-request ADMISSION bound, and the budget for the stage as a whole. run.ts refuses attempt 1
 * outright, with ZERO provider calls, when the upper-bound estimate of the request the caller built
 * exceeds `maxCostMicros` — the oversize guard apps/api/tests/learning-jobs.test.ts > 'a
 * personalization request larger than its stage budget is not sent (LJA-F4)' pins. HUNT6-D-1 raised
 * five caps so the one retry became affordable, and because the same number gates admission that
 * raise also admitted the oversized request LJA-F4 refuses: it sent one provider request where the
 * case requires zero. The two jobs are now two numbers, and neither is weakened to serve the other —
 * raising this one cannot admit a bigger request, and the caps above went back to the owner's
 * recorded values.
 *
 * Written as the owner's recorded NUMBERS rather than as calls to `fullRaiseCeiling`, so lowering one
 * is visible in the diff; `defineStageCostBudgets` above re-derives the ceiling and throws if a
 * number is below it, and packages/ai/src/run-truncation.test.ts pins the same invariant plus a real
 * run at each stage's floor input.
 *
 * These are HOLDS, not spend: settleSpend replaces each with the actual usage, so a call that
 * succeeds costs no more than before and the exposure is a family near their monthly ceiling waiting
 * a tick longer.
 *
 * - extraction, grading: EXTRACTION_GRADING_COST_MICROS, which is ABOVE `fullRaiseCeiling` (155,972
 *   and 153,264) because it is sized for the full raise at the largest scan the product accepts, not
 *   only at the stage's floor input (HUNT5-C-1).
 * - verification, adult_summary: the cap itself — both already sit above their ceilings (76,796 and
 *   5,861), so the stage needs no more than it is admitted with.
 * - semantic_check, coaching, followup, daily_set, thursday_bundle: `fullRaiseCeiling` exactly, the
 *   five numbers HUNT6-D-1 computed, now held here instead of in the admission bound.
 * - escalation: the cap, because maxAttempts is 1 and it never retries. Its ceiling WOULD be 660,000
 *   against the owner's 500,000; the exception is named in `defineStageCostBudgets`.
 */
export const PROPOSED_STAGE_COST_BUDGET_MICROS: Readonly<Record<AiStage, number>> =
  defineStageCostBudgets({
    extraction: EXTRACTION_GRADING_COST_MICROS,
    grading: EXTRACTION_GRADING_COST_MICROS,
    verification: 100_000,
    semantic_check: 40_800,
    coaching: 407_520,
    followup: 240_000,
    daily_set: 483_240,
    thursday_bundle: 933_600,
    escalation: 500_000,
    adult_summary: 20_000,
  });
