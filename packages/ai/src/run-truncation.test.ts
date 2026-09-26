import { describe, expect, it } from 'vitest';
import { DEFAULT_RATE_TABLE_2026_09_18 } from '@pencillift/domain/quotas';
import {
  createMockResponsesClient,
  type ResponsesRequest,
  type ResponsesResult,
} from './client.ts';
import { dataEnvelope, PROMPTS } from './prompts.ts';
import { PROPOSED_STAGE_LIMITS } from './routing.ts';
import { OUTPUT_TRUNCATED_BUDGET_MULTIPLE, runStage } from './run.ts';

/**
 * JOBS-R2-02: an answer the provider cut off at `max_output_tokens` is not a transient outage. The
 * identical request would be cut off again, so it must never be re-sent unchanged: the stage raises
 * the output budget once (only while the stage's cost cap still admits it) and then ends with its
 * own code OUTPUT_TRUNCATED, which the caller turns into a parent-facing outcome instead of five
 * job attempts that each pay for a truncated generation.
 *
 * Labeled mock provider (no live API from the build environment; docs/Connections.md).
 */

const gate = {
  containsChildPersonalData: true,
  ageBand: '8-10' as const,
  zdrEvidence: null,
  environment: 'test' as const,
  now: new Date('2026-09-24T12:00:00Z'),
};

const truncated = (outputTokens: number): ResponsesResult => ({
  kind: 'incomplete',
  usage: { inputTokens: 900, cachedInputTokens: 0, outputTokens },
  modelId: 'gpt-5.6-terra',
  latencyMs: 10,
  reason: 'max_output_tokens',
});

/** An incomplete for any other reason stays a transient provider failure. */
const otherIncomplete: ResponsesResult = {
  kind: 'incomplete',
  usage: { inputTokens: 900, cachedInputTokens: 0, outputTokens: 40 },
  modelId: 'gpt-5.6-terra',
  latencyMs: 10,
  reason: 'content_filter',
};

const okResult: ResponsesResult = {
  kind: 'ok',
  text: JSON.stringify({ pages: [], questions: [] }),
  usage: { inputTokens: 900, cachedInputTokens: 0, outputTokens: 120 },
  modelId: 'gpt-5.6-terra',
  latencyMs: 10,
};

/**
 * A small input keeps every raised retry inside the stage's cost cap, so the loop's own budget rule
 * is what this test observes (not the cap). 900 input tokens at $2/M plus 8,000 output tokens at
 * $12/M is 97,800 micros against the extraction cap of 150,000.
 */
const common = {
  prompt: PROMPTS.extraction,
  input: [dataEnvelope({ pageNumbers: [1], gradeLevel: 4 })],
  limits: PROPOSED_STAGE_LIMITS.extraction,
  rates: DEFAULT_RATE_TABLE_2026_09_18,
  gate,
  metadata: { stage: 'extraction' },
  estimatedInputTokens: 900,
  sleep: () => Promise.resolve(),
};

function recordingClient(answers: readonly ResponsesResult[]) {
  const queue = [...answers];
  const requests: ResponsesRequest[] = [];
  const client = createMockResponsesClient((request) => {
    requests.push(request);
    return queue.shift() ?? queue[queue.length - 1]!;
  });
  return { client, requests };
}

describe('an answer cut off at max_output_tokens (JOBS-R2-02)', () => {
  it('is never re-sent with the same output budget, and ends as OUTPUT_TRUNCATED', async () => {
    const budget = PROPOSED_STAGE_LIMITS.extraction.maxOutputTokens;
    const { client, requests } = recordingClient([
      truncated(budget),
      truncated(budget * OUTPUT_TRUNCATED_BUDGET_MULTIPLE),
      truncated(budget * OUTPUT_TRUNCATED_BUDGET_MULTIPLE),
    ]);
    const out = await runStage({ ...common, client });
    expect(out.result.ok).toBe(false);
    if (!out.result.ok) expect(out.result.error.code).toBe('OUTPUT_TRUNCATED');
    // Exactly two calls: the first at the configured budget, the retry at the raised one. No third.
    expect(requests.map((r) => r.maxOutputTokens)).toEqual([
      budget,
      budget * OUTPUT_TRUNCATED_BUDGET_MULTIPLE,
    ]);
    expect(out.attempts).toHaveLength(2);
  });

  it('succeeds on the raised retry when the fuller answer fits', async () => {
    const budget = PROPOSED_STAGE_LIMITS.extraction.maxOutputTokens;
    const { client, requests } = recordingClient([truncated(budget), okResult]);
    const out = await runStage({ ...common, client });
    expect(out.result.ok).toBe(true);
    expect(requests.map((r) => r.maxOutputTokens)).toEqual([
      budget,
      budget * OUTPUT_TRUNCATED_BUDGET_MULTIPLE,
    ]);
  });

  /**
   * R4-JOBS-1: this test used to assert that a cap which cannot admit the FULL 2x raise makes no
   * second call at all (`expect(requests).toHaveLength(1)`). That assertion was wrong: it described
   * the unreachable branch it was meant to guard — for extraction and grading the full raise never
   * fitted at any real input size, so the promised retry never happened for either stage. The raise
   * is now sized to the headroom the cap leaves, and this asserts the partial raise is really sent.
   */
  it('raises only as far as the stage cost cap has room for, and still retries once', async () => {
    // 5,000 estimated input tokens: the first cut-off answer costs 49,800 micros, leaving 100,200 of
    // the 150,000 cap; 10,000 of that pays for the estimated input, so 7,516 output tokens fit — a
    // real raise over 4,000, but short of 8,000.
    const { client, requests } = recordingClient([truncated(4_000), okResult]);
    const out = await runStage({ ...common, client, estimatedInputTokens: 5_000 });
    expect(requests).toHaveLength(2);
    const raised = requests[1]!.maxOutputTokens;
    expect(raised).toBeGreaterThan(PROPOSED_STAGE_LIMITS.extraction.maxOutputTokens);
    expect(raised).toBeLessThan(
      PROPOSED_STAGE_LIMITS.extraction.maxOutputTokens * OUTPUT_TRUNCATED_BUDGET_MULTIPLE,
    );
    expect(out.result.ok).toBe(true);
    // The whole stage still fits the cap it is admitted against.
    expect(out.attempts.reduce((n, a) => n + a.costMicros, 0)).toBeLessThanOrEqual(
      PROPOSED_STAGE_LIMITS.extraction.maxCostMicros,
    );
  });

  it('makes no second call when the cost cap has no room for a bigger answer at all', async () => {
    // 30,000 estimated input tokens (60,000 micros): the first attempt is admitted at 108,000 and
    // costs 49,800, but even one output token more than the configured budget would be estimated at
    // 108,012 against the 100,200 micros left. The stage settles with the truncation code at once,
    // never STAGE_LIMIT, so the caller still ends the scan with a parent-facing outcome.
    const { client, requests } = recordingClient([truncated(4_000), okResult]);
    const out = await runStage({ ...common, client, estimatedInputTokens: 30_000 });
    expect(requests).toHaveLength(1);
    expect(out.result.ok).toBe(false);
    if (!out.result.ok) expect(out.result.error.code).toBe('OUTPUT_TRUNCATED');
  });

  it('an incomplete for another reason stays a retryable provider failure at the same budget', async () => {
    const budget = PROPOSED_STAGE_LIMITS.extraction.maxOutputTokens;
    const { client, requests } = recordingClient([otherIncomplete, okResult]);
    const out = await runStage({ ...common, client });
    expect(out.result.ok).toBe(true);
    expect(requests.map((r) => r.maxOutputTokens)).toEqual([budget, budget]);
  });
});
