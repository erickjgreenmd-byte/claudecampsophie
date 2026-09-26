import { describe, expect, it } from 'vitest';
import {
  canAttempt,
  DEFAULT_RATE_TABLE_2026_09_18,
  estimateUpperBoundCostMicros,
} from '@pencillift/domain/quotas';
import { createMockResponsesClient, type ResponsesResult } from './client.ts';
import { dataEnvelope, PROMPTS } from './prompts.ts';
import { PROPOSED_STAGE_LIMITS, STAGE_MODELS } from './routing.ts';
import { runStage } from './run.ts';

/**
 * JOBS-R1-03: an attempt whose usage the provider never reported (a client-side timeout, a network
 * failure, a 5xx) may still have been run and billed in full, so it is metered at the upper bound
 * the loop admitted it with and counts against the stage's cost cap; a request the provider refused
 * outright (4xx, 429) never ran and is metered at zero. JOBS-R1-02: a refusal of the request itself
 * (400/413/415/422) is PROVIDER_REJECTED, so callers do not send the same body again.
 */

const gate = {
  containsChildPersonalData: true,
  ageBand: '8-10' as const,
  zdrEvidence: null,
  environment: 'test' as const,
  now: new Date('2026-09-24T12:00:00Z'),
};
const EXTRACTION_OK = JSON.stringify({ pages: [], questions: [] });
const common = {
  prompt: PROMPTS.extraction,
  input: [dataEnvelope({ pageNumbers: [1], gradeLevel: 4 })],
  limits: PROPOSED_STAGE_LIMITS.extraction,
  rates: DEFAULT_RATE_TABLE_2026_09_18,
  gate,
  metadata: { stage: 'extraction' },
  estimatedInputTokens: 5_000,
  sleep: () => Promise.resolve(),
};
const upperBound = (inputTokens: number) => {
  const r = estimateUpperBoundCostMicros(DEFAULT_RATE_TABLE_2026_09_18, {
    modelId: STAGE_MODELS.extraction,
    inputTokens,
    maxOutputTokens: PROPOSED_STAGE_LIMITS.extraction.maxOutputTokens,
  });
  if (!r.ok) throw new Error('estimate');
  return r.value;
};

/**
 * The largest estimated input at which the stage's COST CAP admits exactly `attempts` attempts and
 * refuses the next one, searched with the production estimator (monotone in inputTokens) instead of
 * hardcoded. HUNT5-C-1 raised extraction's cap from 150,000 to 216,816 micros so the one truncation
 * retry is reachable at the product's ten-page limit, and that invalidated the 5,000-token /
 * 58,000-micro / "two attempts fit" arithmetic the cap case below used to carry: at 5,000 tokens
 * three attempts now fit, so `maxAttempts` — not the cap — would have ended the loop and the case
 * would have stopped testing what it names. Derived here, the next ceiling change re-derives the
 * input instead of silently reddening the case for the wrong reason.
 */
function largestInputAdmitting(attempts: number): number {
  const cap = PROPOSED_STAGE_LIMITS.extraction.maxCostMicros;
  let low = 1;
  // upperBound(cap) is already past the cap for any sane rate table, so the answer is bracketed.
  let high = cap;
  let best: number | null = null;
  while (low <= high) {
    const mid = low + Math.floor((high - low) / 2);
    if (attempts * upperBound(mid) <= cap) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (best === null) throw new Error(`no input size lets ${attempts} attempts fit the stage cap`);
  return best;
}
const okResult: ResponsesResult = {
  kind: 'ok',
  text: EXTRACTION_OK,
  usage: { inputTokens: 5_000, cachedInputTokens: 0, outputTokens: 3_000 },
  modelId: 'gpt-5.6-terra',
  latencyMs: 10,
};
const errorResult = (status: number | null, timedOut = false): ResponsesResult => ({
  kind: 'error',
  status,
  retryable: status === null || status === 429 || status >= 500,
  latencyMs: timedOut ? 45_000 : 5,
  timedOut,
});

describe('metering of attempts with unknown usage (JOBS-R1-03)', () => {
  it('a timed-out attempt carries its upper-bound cost and usage, marked as estimated', async () => {
    const answers = [errorResult(null, true), okResult];
    const client = createMockResponsesClient(() => answers.shift()!);
    const out = await runStage({ ...common, client });
    expect(out.result.ok).toBe(true);
    const bound = upperBound(5_000);
    // 5,000 input tokens at $2/M + 4,000 output tokens at $12/M.
    expect(bound).toBe(58_000);
    expect(out.attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        status: 'timeout',
        costMicros: bound,
        inputTokens: 5_000,
        cachedInputTokens: 0,
        outputTokens: 4_000,
        usageEstimated: true,
      }),
      expect.objectContaining({
        attempt: 2,
        status: 'succeeded',
        costMicros: 46_000,
        usageEstimated: false,
      }),
    ]);
  });

  it('a network failure or 5xx is metered like a timeout; 4xx and 429 never ran and cost nothing', async () => {
    for (const status of [null, 500, 502, 503]) {
      const answers = [errorResult(status), okResult];
      const client = createMockResponsesClient(() => answers.shift()!);
      const out = await runStage({ ...common, client });
      expect(out.attempts[0]).toMatchObject({
        status: 'failed',
        costMicros: upperBound(5_000),
        usageEstimated: true,
      });
    }
    for (const status of [400, 401, 413, 429]) {
      const answers = [errorResult(status), okResult];
      const client = createMockResponsesClient(() => answers.shift()!);
      const out = await runStage({ ...common, client });
      expect(out.attempts[0]).toMatchObject({
        status: 'failed',
        costMicros: 0,
        inputTokens: 0,
        outputTokens: 0,
        usageEstimated: false,
      });
    }
  });

  it('timed-out attempts count against the stage cap: no attempt is admitted past it', async () => {
    const limits = PROPOSED_STAGE_LIMITS.extraction;
    // An input sized from the cap so THE CAP is what ends the loop: two attempts spend all of it and
    // a third would pass it, while maxAttempts still has room for that third attempt. Both of those
    // premises are asserted, so the case cannot quietly become a maxAttempts test.
    const estimatedInputTokens = largestInputAdmitting(2);
    const bound = upperBound(estimatedInputTokens);
    expect(limits.maxAttempts).toBeGreaterThan(2);
    expect(2 * bound).toBeLessThanOrEqual(limits.maxCostMicros);
    expect(3 * bound).toBeGreaterThan(limits.maxCostMicros);
    const client = createMockResponsesClient(() => errorResult(null, true));
    const out = await runStage({ ...common, client, estimatedInputTokens });
    expect(out.attempts).toHaveLength(2);
    const recorded = out.attempts.reduce((n, a) => n + a.costMicros, 0);
    expect(recorded).toBe(2 * bound);
    expect(recorded).toBeLessThanOrEqual(limits.maxCostMicros);
    const third = canAttempt(limits, {
      attemptsSoFar: 2,
      spentMicrosSoFar: recorded,
      nextEstimateMicros: bound,
    });
    expect(third.allow).toBe(false);
    // The cap, not the attempt count: a MAX_ATTEMPTS denial here would mean the case had drifted.
    if (!third.allow) expect(third.deny).toBe('STAGE_COST_CAP');
    expect(out.result.ok).toBe(false);
    if (!out.result.ok) expect(out.result.error.code).toBe('PROVIDER_FAILED');
  });

  it('an incomplete answer is metered from the usage the provider reported (known usage)', async () => {
    const answers: ResponsesResult[] = [
      {
        kind: 'incomplete',
        usage: { inputTokens: 5_000, cachedInputTokens: 0, outputTokens: 4_000 },
        modelId: 'gpt-5.6-terra',
        latencyMs: 10,
        reason: 'max_output_tokens',
      },
      okResult,
    ];
    const client = createMockResponsesClient(() => answers.shift()!);
    const out = await runStage({ ...common, client });
    expect(out.attempts[0]).toMatchObject({
      status: 'failed',
      costMicros: 58_000,
      usageEstimated: false,
    });
  });
});

describe('a refused request is not sent again (JOBS-R1-02)', () => {
  it('400/413/415/422 end the stage as PROVIDER_REJECTED after one attempt', async () => {
    for (const status of [400, 413, 415, 422]) {
      const client = createMockResponsesClient(() => errorResult(status));
      const out = await runStage({ ...common, client });
      expect(client.requests).toHaveLength(1);
      expect(out.result.ok).toBe(false);
      if (!out.result.ok) {
        expect(out.result.error.code).toBe('PROVIDER_REJECTED');
        expect(out.result.error.details).toMatchObject({ status });
      }
    }
  });

  it('other non-retryable answers (401, 403, 404) stay PROVIDER_FAILED (configuration, not the body)', async () => {
    for (const status of [401, 403, 404]) {
      const client = createMockResponsesClient(() => errorResult(status));
      const out = await runStage({ ...common, client });
      expect(client.requests).toHaveLength(1);
      if (!out.result.ok) expect(out.result.error.code).toBe('PROVIDER_FAILED');
    }
  });
});
