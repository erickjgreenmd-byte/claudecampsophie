import { err, ok, type Result } from '@pencillift/domain';
import {
  canAttempt,
  computeOperationCostMicros,
  estimateUpperBoundCostMicros,
  type AiStage,
  type StageLimits,
} from '@pencillift/domain/quotas';
import type { z } from 'zod';
import type { ResponsesClient } from './client.ts';
import { checkChildDataGate, type ChildDataGateInput } from './gate.ts';
import type { InputPart, PromptDefinition } from './prompts.ts';
import { STAGE_MODELS } from './routing.ts';
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
   * already tried once with a raised output budget (see OUTPUT_TRUNCATED_BUDGET_MULTIPLE) where the
   * stage's cost cap admitted it; this code means the work does not fit this stage at all.
   */
  | 'OUTPUT_TRUNCATED'
  | 'OUTPUT_INVALID'
  | 'UNKNOWN_MODEL';

/**
 * How much of the stage's output budget a truncated answer is retried with (JOBS-R2-02): once, at
 * this multiple of the configured `maxOutputTokens`, and only while the stage's cost cap still
 * admits the raised estimate — the owner's ceiling is never exceeded to fit a longer answer.
 */
export const OUTPUT_TRUNCATED_BUDGET_MULTIPLE = 2;

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
  readonly rates: Parameters<typeof computeOperationCostMicros>[0];
  readonly gate: Omit<ChildDataGateInput, 'providerIsMock'>;
  readonly metadata: Readonly<Record<string, string>>;
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
  // it once (never twice, and never past the stage's cost cap), so the identical request is never
  // sent again.
  let maxOutputTokens = limits.maxOutputTokens;
  let budgetRaised = false;

  for (let attempt = 1; ; attempt += 1) {
    const estimate = estimateUpperBoundCostMicros(rates, {
      modelId,
      inputTokens: options.estimatedInputTokens,
      maxOutputTokens,
    });
    if (!estimate.ok) return { result: err('UNKNOWN_MODEL', estimate.error.message), attempts };
    const decision = canAttempt(limits, {
      attemptsSoFar: attempt - 1,
      spentMicrosSoFar: spent,
      nextEstimateMicros: estimate.value,
    });
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
        // cut off at the same place, so the stage raises the budget once and, if that answer is cut
        // off too (or the cost cap refuses the raise), ends with its own code. The caller turns that
        // into a parent-facing outcome instead of spending every job attempt on truncated answers.
        lastError = 'OUTPUT_TRUNCATED';
        if (budgetRaised) {
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
        maxOutputTokens = limits.maxOutputTokens * OUTPUT_TRUNCATED_BUDGET_MULTIPLE;
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
