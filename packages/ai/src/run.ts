import type { ZdrSafeMetadata } from './zdr.ts';
import { err, ok, type Result } from '@pencillift/domain';
import {
  canAttempt,
  computeOperationCostMicros,
  DEFAULT_RATE_TABLE_2026_09_18,
  estimateUpperBoundCostMicros,
  type AiStage,
  type StageLimits,
} from '@pencillift/domain/quotas';
import type { z } from 'zod';
import type { ResponsesClient } from './client.ts';
import { checkChildDataGate, type ChildDataGateInput } from './gate.ts';
import type { InputPart, PromptDefinition } from './prompts.ts';
import {
  fullRaiseCeiling,
  OUTPUT_TRUNCATED_BUDGET_MULTIPLE,
  PROPOSED_STAGE_COST_BUDGET_MICROS,
  STAGE_MODELS,
} from './routing.ts';
import { toStrictJsonSchema } from './schemas.ts';

/**
 * Runs one AI stage with the gate, per-stage limits, bounded retries and metering (spec P12, F3/F4).
 * Every attempt — including failed or rejected ones that may still be billed — is returned so the
 * caller records it in ai_usage_events. Output is parsed and validated; nothing unvalidated escapes.
 */

export interface AttemptRecord {
  readonly stage: AiStage;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly attempt: number;
  readonly status: 'succeeded' | 'failed' | 'timeout' | 'rejected_by_validation';
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly costMicros: number;
  readonly rateTableVersion: string;
  /**
   * True when the provider never reported this attempt's usage (a client-side timeout, a network
   * failure, a 5xx) and the tokens and cost are the upper bound the attempt was admitted with: the
   * provider may still have run and billed the whole generation, so it counts in full, like the
   * domain's `failed_billed` settlement (JOBS-R1-03). Absent or false: the usage is the provider's.
   */
  readonly usageEstimated?: boolean;
}

export type RunStageErrorCode =
  | 'CHILD_DATA_GATE'
  | 'STAGE_LIMIT'
  | 'PROVIDER_FAILED'
  /** The provider refused the request itself (400/413/415/422): sending it again cannot succeed. */
  | 'PROVIDER_REJECTED'
  /**
   * The provider cut the answer off at `max_output_tokens` (JOBS-R2-02). Not an outage: the same
   * request would be cut off again, so the caller must not treat it as retryable work. The loop
   * already tried once with a raised output budget (see raisedOutputBudget) unless the stage's cost
   * BUDGET had no room for any raise at all; this code means the work does not fit this stage.
   */
  | 'OUTPUT_TRUNCATED'
  | 'OUTPUT_INVALID'
  | 'UNKNOWN_MODEL';

/**
 * Re-exported from routing.ts, where it sits next to the per-stage caps it is spent against and is
 * priced by `fullRaiseCeiling` (HUNT6-D-1). Importing it from here keeps every existing caller.
 */
export { OUTPUT_TRUNCATED_BUDGET_MULTIPLE };

/**
 * The output budget the one truncation retry is sent with: the largest one the stage's cost BUDGET
 * still admits, up to OUTPUT_TRUNCATED_BUDGET_MULTIPLE x the configured one. Null when not even one
 * token more fits, and the stage settles with OUTPUT_TRUNCATED at once.
 *
 * R4-JOBS-1: raising straight to the full multiple made the retry UNREACHABLE for extraction and
 * grading — 2 x 4,000 output tokens is estimated at ~102,000 micros on top of the ~53,000 the first
 * cut-off answer already cost, past their 150,000-micro cap, at every input size a real scan sends.
 * A worksheet a few hundred tokens too long was abandoned although the retry the comments promised
 * had never been made. The raise is now sized to the headroom that exists, so the single retry is
 * always really attempted when there is room for a bigger answer at all. Monotone in the budget, so
 * a binary search finds the largest admissible one.
 *
 * Whether there is room at all is set by the STAGE'S COST BUDGET, not by this function and not by the
 * per-request admission bound: a retry at x output tokens needs
 * (rateIn x E + rateOut x B) + (rateIn x E + rateOut x x) <= maxStageCostMicros, the first bracket
 * being the cut-off answer metered at the usage it reported and B the configured budget; E is
 * inputTokenUpperBound of the request the caller sends. `fullRaiseCeiling` in routing.ts is exactly
 * that sum at x = OUTPUT_TRUNCATED_BUDGET_MULTIPLE x B and at the stage's FLOOR input, and every
 * stage that can retry at all has a BUDGET at or above it (HUNT6-D-1, enforced at startup by
 * `defineStageCostBudgets`; `escalation` has one attempt and is the single named exception), so no
 * such stage is configured with a raise that is unreachable at every input size. That is a floor
 * guarantee: above the floor the admissible raise shrinks as E grows, and the numbers differ per stage
 * because the models do — terra is 2 micros an input token and 12 an output token, astra 10 and 50,
 * luna 0.2 and 1.2.
 *
 * It is the BUDGET and not `maxCostMicros` because the two are different promises (HUNT6-D-CAP):
 * `maxCostMicros` is what a single request may cost, and raising it to fit a retry admits bigger
 * requests — which is exactly how the first attempt at HUNT6-D-1 made LJA-F4 send a personalization
 * request it exists to refuse.
 *
 * Where each stage's bound bites, measured on the request the caller really sends:
 * - EXTRACTION sends the data envelope PLUS one image part per page (1,516 tokens each), so its bound
 *   is set by the PAGE count: 4,541 tokens for one page and 18,204 for the ten of
 *   DEFAULT_HOMEWORK_UPLOAD_LIMITS. At the old 150,000-micro cap no raise fitted from 7 pages up;
 *   HUNT5-C-1 raised extraction's and grading's cap to 4E + 144,000 at ten pages = 216,816 micros
 *   (EXTRACTION_GRADING_COST_MICROS), which makes the FULL 2x raise reachable at every page count the
 *   product accepts.
 * - GRADING is bounded by QUESTIONS, not pages: one data envelope, no image, so its E grows with the
 *   questions and answers extraction found. On the same cap the full raise holds to about 85 questions
 *   of average length and disappears past about 149 — the count moves with question length, since the
 *   bound is in bytes. A ten-page worksheet of dense questions can therefore still be cut off in
 *   grading with no retry; that gap is measured and named in the cases below rather than claimed to be
 *   covered.
 * - The ASTRA stages (coaching, followup, daily_set, thursday_bundle) were left behind by that round
 *   and were the worse case, because 3 x 50 x B alone was already past each of their caps: the full
 *   raise was impossible at ANY input size and daily_set got NO raise at all at an ordinary set of
 *   eight word problems. HUNT6-D-1 gave all four, and semantic_check, a stage BUDGET at their
 *   full-raise ceiling (coaching 407,520, followup 240,000, daily_set 483,240, thursday_bundle
 *   933,600, semantic_check 40,800) while their admission bounds stayed where the owner set them.
 *
 * What the cases actually cover. The parameterised cases in apps/api/tests/jobs-r2.review.test.ts call
 * `runStage` DIRECTLY, on input the case itself builds: extraction over 1..maxPages with real image
 * parts, grading over a question sweep (envelope only, no image part), and daily_set and coaching on
 * envelopes hand-written to the same `dataEnvelope` FIELDS AND SIZES learning-jobs.ts and
 * scan-process.ts send — the shape copied into the test, not the envelope those jobs produce. So they
 * pin the raise at input bounds of the right ORDER, and NOT that the production job still builds an
 * envelope that size: change what learning-jobs.ts puts in the envelope and those cases stay green.
 * The daily_set envelope IS driven through production, by `personalizeItems` itself, in
 * apps/api/tests/learning-jobs.test.ts > 'the personalization hold reserves the stage BUDGET the
 * raised retry can spend (F-HOLD)', which takes the raised retry on the real envelope and weighs the
 * whole stage against the hold. packages/ai/src/run-truncation.test.ts pins every stage's BUDGET
 * against `fullRaiseCeiling`, that its admission cap was not widened to get there, and that a caller
 * may not hand in a cap above the budget. Lower any of those numbers and they go red.
 */
function raisedOutputBudget(args: {
  readonly limits: StageLimits;
  /** The budget for the stage as a whole (routing.ts), which is what the retry is weighed against. */
  readonly maxStageCostMicros: number;
  readonly rates: Parameters<typeof computeOperationCostMicros>[0];
  readonly modelId: string;
  readonly inputTokens: number;
  readonly attemptsSoFar: number;
  readonly spentMicros: number;
}): number | null {
  const admits = (maxOutputTokens: number): boolean => {
    const estimate = estimateUpperBoundCostMicros(args.rates, {
      modelId: args.modelId,
      inputTokens: args.inputTokens,
      maxOutputTokens,
    });
    if (!estimate.ok) return false;
    // The same check the loop makes on the next attempt, so a raise this returns is never then
    // refused at the top of the loop: attempts and cumulative cost against the STAGE BUDGET.
    return canAttempt(
      { ...args.limits, maxCostMicros: args.maxStageCostMicros },
      {
        attemptsSoFar: args.attemptsSoFar,
        spentMicrosSoFar: args.spentMicros,
        nextEstimateMicros: estimate.value,
      },
    ).allow;
  };
  let low = args.limits.maxOutputTokens + 1;
  let high = args.limits.maxOutputTokens * OUTPUT_TRUNCATED_BUDGET_MULTIPLE;
  let best: number | null = null;
  while (low <= high) {
    const mid = low + Math.floor((high - low) / 2);
    if (admits(mid)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/** Statuses by which the provider refuses the request body itself (size, image, schema). */
const REJECTED_REQUEST_STATUSES: ReadonlySet<number> = new Set([400, 413, 415, 422]);

/**
 * Whether an error answer may have been billed without its usage being reported (JOBS-R1-03): no
 * HTTP answer at all (our timeout aborted it, or the connection failed after the request was sent)
 * or a server error. A 4xx (including 429) is refused before the model runs and is never billed.
 */
function usageUnknown(status: number | null): boolean {
  return status === null || status >= 500;
}

export interface RunStageInput<S extends z.ZodType> {
  readonly prompt: PromptDefinition<S>;
  readonly input: readonly InputPart[];
  readonly client: ResponsesClient;
  readonly limits: StageLimits;
  /**
   * The budget for the stage AS A WHOLE, in integer micro-USD (HUNT6-D-CAP): the cumulative metered
   * cost of every attempt, including the one raised retry. Defaults to the stage's recorded budget,
   * `PROPOSED_STAGE_COST_BUDGET_MICROS[prompt.stage]`, which is what every production caller wants;
   * pass it only to weigh the stage against a different budget (the cases that sweep it). It NEVER
   * widens admission: `limits.maxCostMicros` alone decides whether the first request is sent.
   *
   * It may never be BELOW `limits.maxCostMicros` either, however it was resolved: a stage whose
   * single admitted request may cost more than the stage as a whole is a contradiction, and runStage
   * throws a RangeError for it instead of quietly weighing the retry against the smaller of the two.
   */
  readonly maxStageCostMicros?: number;
  readonly rates: Parameters<typeof computeOperationCostMicros>[0];
  readonly gate: Omit<ChildDataGateInput, 'providerIsMock'>;
  /** Closed to `ZdrSafeMetadata` (zdr.ts): request metadata names the software, never a person. */
  readonly metadata: ZdrSafeMetadata;
  /** Estimated input tokens for the pre-flight cost check (upper bound). */
  readonly estimatedInputTokens: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RunStageOutput<T> {
  readonly result: Result<T, RunStageErrorCode>;
  readonly attempts: readonly AttemptRecord[];
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runStage<S extends z.ZodType>(
  options: RunStageInput<S>,
): Promise<RunStageOutput<z.infer<S>>> {
  const { prompt, client, limits, rates } = options;
  const attempts: AttemptRecord[] = [];
  // The admission cap and the stage budget are resolved from two independent places (the caller's
  // `limits`, the budget table or the caller's override), so nothing but this check stops a caller
  // handing in a `limits.maxCostMicros` ABOVE the budget the retry is weighed against: attempt 1
  // would be admitted at a price the stage as a whole may not pay, and every later attempt then
  // silently weighed against the smaller number — the caller getting neither bound it asked for. That
  // pair is a configuration error, so it is LOUD, in the same fail-closed style as
  // `defineStageLimits` and `defineStageCostBudgets` in routing.ts, and it is raised before the gate,
  // the provider and any spend. `PROPOSED_STAGE_COST_BUDGET_MICROS` is validated at import to sit at
  // or above every stage's cap, so no production caller can reach it.
  const maxStageCostMicros =
    options.maxStageCostMicros ?? PROPOSED_STAGE_COST_BUDGET_MICROS[prompt.stage];
  if (limits.maxCostMicros > maxStageCostMicros) {
    throw new RangeError(
      `${prompt.stage}: per-request admission cap ${limits.maxCostMicros} is above the stage budget ${maxStageCostMicros}`,
    );
  }
  // HUNT7-B-5: `defineStageCostBudgets` proved at import that every recorded budget affords the ONE
  // full raise — priced at DEFAULT_RATE_TABLE_2026_09_18, the object it prices against and the object
  // every production caller passes (`options.rates ?? DEFAULT_RATE_TABLE_2026_09_18` in
  // scan-process.ts and learning-jobs.ts). A caller handing in ANY other table would be spending at
  // prices that check never saw, which is the one input to the invariant it is blind to, so the
  // ceiling is re-derived here at the rates this call will really be billed at and a budget below it
  // is refused instead of promising a raise the stage cannot pay for (BUG-260/BUG-309). A table equal
  // to the default by value is re-derived too and passes, so only a real price change is refused.
  if (rates !== DEFAULT_RATE_TABLE_2026_09_18 && limits.maxAttempts >= 2) {
    // A table that cannot price this stage's model at all is answered by the loop's own UNKNOWN_MODEL
    // result below — a code the caller already handles, with no spend — and not by this check.
    const priceable = estimateUpperBoundCostMicros(rates, {
      modelId: STAGE_MODELS[prompt.stage],
      inputTokens: 1,
      maxOutputTokens: 1,
    }).ok;
    const ceiling = priceable
      ? fullRaiseCeiling(prompt.stage, limits.maxOutputTokens, rates)
      : maxStageCostMicros;
    if (maxStageCostMicros < ceiling) {
      throw new RangeError(
        `${prompt.stage}: stage budget ${maxStageCostMicros} is below its full-raise ceiling ${ceiling} at rate table ${rates.version}`,
      );
    }
  }
  const gate = checkChildDataGate({ ...options.gate, providerIsMock: client.isMock });
  if (!gate.ok)
    return {
      result: err('CHILD_DATA_GATE', gate.error.message, { gate: gate.error.code }),
      attempts,
    };

  const modelId = STAGE_MODELS[prompt.stage];
  const jsonSchema = toStrictJsonSchema(prompt.outputSchema);
  const sleep = options.sleep ?? defaultSleep;
  let spent = 0;
  let lastError: RunStageErrorCode = 'PROVIDER_FAILED';
  // JOBS-R2-02: the output budget this attempt is sent with. A `max_output_tokens` incomplete raises
  // it once (never twice, and never past what the stage's cost BUDGET admits, R4-JOBS-1), so the
  // identical request is never sent again.
  let maxOutputTokens = limits.maxOutputTokens;
  let budgetRaised = false;

  for (let attempt = 1; ; attempt += 1) {
    const estimate = estimateUpperBoundCostMicros(rates, {
      modelId,
      inputTokens: options.estimatedInputTokens,
      maxOutputTokens,
    });
    if (!estimate.ok) return { result: err('UNKNOWN_MODEL', estimate.error.message), attempts };
    // Two numbers, two jobs (HUNT6-D-CAP). ATTEMPT 1 is weighed against `limits.maxCostMicros`, the
    // per-request ADMISSION bound: a request whose upper bound exceeds it is refused with STAGE_LIMIT
    // and zero provider calls, which is the oversize guard LJA-F4 pins. Every LATER attempt is
    // weighed against the budget for the stage as a whole, which is what the one raised retry has to
    // fit and what the caller's spend hold reserved. `spent` is 0 on attempt 1, so the first check is
    // exactly the per-request bound and nothing else.
    const decision = canAttempt(
      attempt === 1 ? limits : { ...limits, maxCostMicros: maxStageCostMicros },
      {
        attemptsSoFar: attempt - 1,
        spentMicrosSoFar: spent,
        nextEstimateMicros: estimate.value,
      },
    );
    if (!decision.allow) {
      return {
        result: err(attempt === 1 ? 'STAGE_LIMIT' : lastError, `Stage stopped: ${decision.deny}`, {
          deny: decision.deny,
        }),
        attempts,
      };
    }
    const response = await client.create({
      model: modelId,
      instructions: prompt.instructions,
      input: options.input,
      outputName: prompt.outputName,
      jsonSchema,
      maxOutputTokens,
      timeoutMs: limits.timeoutMs,
      metadata: { ...options.metadata, prompt_version: prompt.version },
    });
    // JOBS-R1-03: an attempt whose usage is unknown is metered at the upper bound it was admitted
    // with (every estimated input token and the whole output budget), so the stage's cap, the
    // owner's ceiling and the ledger never count a possibly billed generation as free.
    const estimated = response.kind === 'error' && usageUnknown(response.status);
    const usage =
      response.kind !== 'error'
        ? response.usage
        : estimated
          ? {
              inputTokens: options.estimatedInputTokens,
              cachedInputTokens: 0,
              outputTokens: maxOutputTokens,
            }
          : { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    let costMicros: number;
    if (estimated) {
      costMicros = estimate.value;
    } else {
      const cost = computeOperationCostMicros(rates, {
        modelId: response.kind === 'error' ? modelId : response.modelId,
        ...usage,
      });
      costMicros = cost.ok ? cost.value.costMicros : 0;
    }
    spent += costMicros;
    const record = (status: AttemptRecord['status']): AttemptRecord => ({
      stage: prompt.stage,
      modelId,
      promptVersion: prompt.version,
      attempt,
      status,
      ...usage,
      latencyMs: response.latencyMs,
      costMicros,
      rateTableVersion: rates.version,
      usageEstimated: estimated,
    });

    if (response.kind === 'error') {
      attempts.push(record(response.timedOut ? 'timeout' : 'failed'));
      lastError = 'PROVIDER_FAILED';
      if (!response.retryable) {
        const rejected = response.status !== null && REJECTED_REQUEST_STATUSES.has(response.status);
        return {
          result: err(
            rejected ? 'PROVIDER_REJECTED' : 'PROVIDER_FAILED',
            'Provider rejected the request',
            response.status === null ? undefined : { status: response.status },
          ),
          attempts,
        };
      }
    } else if (response.kind === 'incomplete') {
      attempts.push(record('failed'));
      if (response.reason === 'max_output_tokens') {
        // JOBS-R2-02: the answer did not fit the budget. Re-sending the identical request would be
        // cut off at the same place, so the stage raises the budget once — as far as the stage's
        // cost BUDGET has room for (R4-JOBS-1) — and, if that answer is cut off too (or there is no
        // room for any raise), ends with its own code. The caller turns that into a parent-facing
        // outcome instead of spending every job attempt on truncated answers.
        lastError = 'OUTPUT_TRUNCATED';
        const raised = budgetRaised
          ? null
          : raisedOutputBudget({
              limits,
              maxStageCostMicros,
              rates,
              modelId,
              inputTokens: options.estimatedInputTokens,
              attemptsSoFar: attempt,
              spentMicros: spent,
            });
        if (raised === null) {
          return {
            result: err(
              'OUTPUT_TRUNCATED',
              'The provider cut the answer off at its output budget',
              {
                maxOutputTokens,
              },
            ),
            attempts,
          };
        }
        budgetRaised = true;
        maxOutputTokens = raised;
      } else {
        lastError = 'PROVIDER_FAILED';
      }
    } else {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(response.text);
      } catch {
        parsedJson = undefined;
      }
      const parsed = prompt.outputSchema.safeParse(parsedJson);
      if (parsed.success) {
        attempts.push(record('succeeded'));
        return { result: ok(parsed.data), attempts };
      }
      attempts.push(record('rejected_by_validation'));
      lastError = 'OUTPUT_INVALID';
    }
    await sleep(Math.min(8_000, 500 * 2 ** (attempt - 1)));
  }
}
