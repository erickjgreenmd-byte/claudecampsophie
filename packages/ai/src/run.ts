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
}

export type RunStageErrorCode =
  'CHILD_DATA_GATE' | 'STAGE_LIMIT' | 'PROVIDER_FAILED' | 'OUTPUT_INVALID' | 'UNKNOWN_MODEL';

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

  for (let attempt = 1; ; attempt += 1) {
    const estimate = estimateUpperBoundCostMicros(rates, {
      modelId,
      inputTokens: options.estimatedInputTokens,
      maxOutputTokens: limits.maxOutputTokens,
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
      maxOutputTokens: limits.maxOutputTokens,
      timeoutMs: limits.timeoutMs,
      metadata: { ...options.metadata, prompt_version: prompt.version },
    });
    const usage =
      response.kind === 'error'
        ? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
        : response.usage;
    const cost = computeOperationCostMicros(rates, {
      modelId: response.kind === 'error' ? modelId : response.modelId,
      ...usage,
    });
    const costMicros = cost.ok ? cost.value.costMicros : 0;
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
    });

    if (response.kind === 'error') {
      attempts.push(record(response.timedOut ? 'timeout' : 'failed'));
      lastError = 'PROVIDER_FAILED';
      if (!response.retryable)
        return { result: err('PROVIDER_FAILED', 'Provider rejected the request'), attempts };
    } else if (response.kind === 'incomplete') {
      attempts.push(record('failed'));
      lastError = 'PROVIDER_FAILED';
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
