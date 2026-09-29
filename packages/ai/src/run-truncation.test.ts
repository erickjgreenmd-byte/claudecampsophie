import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AI_STAGES,
  computeOperationCostMicros,
  DEFAULT_RATE_TABLE_2026_09_18,
  estimateUpperBoundCostMicros,
} from '@pencillift/domain/quotas';
import {
  createMockResponsesClient,
  type ResponsesRequest,
  type ResponsesResult,
} from './client.ts';
import { dataEnvelope, PROMPTS, type PromptDefinition } from './prompts.ts';
import {
  fullRaiseCeiling,
  PROPOSED_STAGE_COST_BUDGET_MICROS,
  PROPOSED_STAGE_LIMITS,
  STAGE_FLOOR_INPUT_TOKENS,
  STAGE_MODELS,
} from './routing.ts';
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
 * A small input keeps every raised retry inside the stage's cost BUDGET, so the loop's own budget rule
 * is what the first two cases observe (not the budget). The figure that has to fit is the SUM
 * `canAttempt` weighs on the retry, not the retry alone: the cut-off answer is metered from the usage
 * `truncated()` reports (900 input tokens at $2/M plus the whole 4,000-token budget at $12/M =
 * 49,800 micros) and the retry at 8,000 output tokens is estimated at 97,800, so these cases need a
 * stage budget of at least 147,600 — well inside extraction's 216,816.
 *
 * NOT "whatever the budget is set to" (HUNT6-D-5R): one micro-USD less, at 147,599, and the retry
 * cannot have the full 8,000 tokens. What it gets instead is the largest x with
 * 49,800 + 1,800 + 12x <= 147,599, which is x = 7,999 (12 x 7,999 = 95,988, total 147,588; 8,000
 * would need 147,600), so both cases would see [4000, 7999] and the equality the second one asserts
 * would fail. FULL_RAISE_PREMISE_MICROS computes the 147,600 from the production pricing functions
 * instead of claiming it in prose; the 7,999 above is the same arithmetic one micro lower, which no
 * assertion depends on — it is here to show the margin is one token wide, not comfortable.
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

/**
 * The premise those two cases rest on, COMPUTED from the production pricing functions instead of
 * claimed in prose (HUNT6-D-5): the cut-off answer metered from the usage `truncated()` reports, plus
 * the FULL raise estimated at OUTPUT_TRUNCATED_BUDGET_MULTIPLE x the configured budget. This is the
 * exact sum `canAttempt` weighs against the cap on the retry, so if it ever stops fitting, the two
 * cases below stop observing the branch they name.
 */
const FULL_RAISE_PREMISE_MICROS = ((): number => {
  const modelId = STAGE_MODELS.extraction;
  const inputTokens = 900;
  const budget = PROPOSED_STAGE_LIMITS.extraction.maxOutputTokens;
  const cutOff = computeOperationCostMicros(DEFAULT_RATE_TABLE_2026_09_18, {
    modelId,
    inputTokens,
    cachedInputTokens: 0,
    outputTokens: budget,
  });
  const retry = estimateUpperBoundCostMicros(DEFAULT_RATE_TABLE_2026_09_18, {
    modelId,
    inputTokens,
    maxOutputTokens: budget * OUTPUT_TRUNCATED_BUDGET_MULTIPLE,
  });
  if (!cutOff.ok || !retry.ok) throw new Error('extraction has no rate row');
  return cutOff.value.costMicros + retry.value;
})();

/**
 * The estimated input size at which extraction's stage BUDGET leaves exactly `retryMicros` for the one
 * raised retry. The first cut-off answer is metered at the usage `truncated()` reports (900 input
 * tokens and the whole 4,000-token budget: 49,800 micros at terra's 2 and 12 micros per token), and
 * a retry at x output tokens is estimated at 2E + 12x, so the headroom left for it is
 * maxStageCostMicros − 49,800 − 2E. Derived from the budget instead of hardcoded, so the two cases
 * below still exercise the branch they name if the stage's budget changes (R4-JOBS-1). It is the
 * BUDGET and not the admission cap because that is the number the retry is weighed against
 * (HUNT6-D-CAP); for extraction the owner set the two to the same 216,816.
 */
function inputTokensLeaving(retryMicros: number): number {
  return Math.floor((PROPOSED_STAGE_COST_BUDGET_MICROS.extraction - 49_800 - retryMicros) / 2);
}

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
    // The number the docstring above names, and the cap that has to carry it.
    expect(FULL_RAISE_PREMISE_MICROS).toBe(147_600);
    expect(FULL_RAISE_PREMISE_MICROS).toBeLessThanOrEqual(
      PROPOSED_STAGE_COST_BUDGET_MICROS.extraction,
    );
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
    expect(FULL_RAISE_PREMISE_MICROS).toBeLessThanOrEqual(
      PROPOSED_STAGE_COST_BUDGET_MICROS.extraction,
    );
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
  it('raises only as far as the stage cost budget has room for, and still retries once', async () => {
    // An input sized so the BUDGET leaves room for a 6,000-token answer and no more: a real raise over
    // the configured 4,000, short of the full 8,000. At extraction's 216,816-micro budget that is
    // 47,508 estimated input tokens (49,800 micros for the cut-off answer, 95,016 for the input,
    // 72,000 left for the retry) — the helper re-derives it if the budget moves.
    const { client, requests } = recordingClient([truncated(4_000), okResult]);
    const out = await runStage({
      ...common,
      client,
      estimatedInputTokens: inputTokensLeaving(12 * 6_000),
    });
    expect(requests).toHaveLength(2);
    const raised = requests[1]!.maxOutputTokens;
    expect(raised).toBeGreaterThan(PROPOSED_STAGE_LIMITS.extraction.maxOutputTokens);
    expect(raised).toBeLessThan(
      PROPOSED_STAGE_LIMITS.extraction.maxOutputTokens * OUTPUT_TRUNCATED_BUDGET_MULTIPLE,
    );
    expect(out.result.ok).toBe(true);
    // The whole stage still fits the BUDGET it was weighed against.
    expect(out.attempts.reduce((n, a) => n + a.costMicros, 0)).toBeLessThanOrEqual(
      PROPOSED_STAGE_COST_BUDGET_MICROS.extraction,
    );
  });

  it('makes no second call when the stage budget has no room for a bigger answer at all', async () => {
    // One input token more than the largest input at which a retry at 4,001 output tokens still fits:
    // the first attempt is admitted and costs 49,800 micros, but even one output token more than the
    // configured budget is estimated 2 micros past what the BUDGET has left. The stage settles with
    // the truncation code at once, never STAGE_LIMIT, so the caller still ends the scan with a
    // parent-facing outcome. At extraction's 216,816-micro budget that input is 59,503 tokens.
    const { client, requests } = recordingClient([truncated(4_000), okResult]);
    const out = await runStage({
      ...common,
      client,
      estimatedInputTokens: inputTokensLeaving(12 * 4_001) + 1,
    });
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

// ---------------------------------------------------------------------------------------------
// HUNT6-D-1: no stage may be configured below the cap its own full raise needs
// ---------------------------------------------------------------------------------------------

/**
 * BUG-260 was closed for extraction and grading only, and the four astra stages kept their old caps.
 * astra costs 10 micros an input token and 50 an output token (five times terra), so
 * 3 x 50 x maxOutputTokens alone was already past coaching's 300,000, followup's 150,000,
 * daily_set's 350,000 and thursday_bundle's 700,000: the FULL raise was impossible at every input
 * size, and at an ordinary daily set daily_set got no raise at all. `fullRaiseCeiling` states the
 * invariant and these cases enforce it for EVERY stage, so a new stage cannot be added below the line.
 *
 * HUNT6-D-CAP: the first fix for that raised `maxCostMicros`, which is ALSO the per-request admission
 * bound, and the raise admitted an oversized request apps/api/tests/learning-jobs.test.ts > 'a
 * personalization request larger than its stage budget is not sent (LJA-F4)' exists to prove is
 * refused. The affordability of the retry is now a SECOND number,
 * PROPOSED_STAGE_COST_BUDGET_MICROS, and these cases pin BOTH halves: every stage that can retry has
 * a budget at or above its ceiling, AND its admission bound was not widened to get there.
 */
describe('every stage that can retry affords the ONE full raise (HUNT6-D-1)', () => {
  it('no stage has a cost BUDGET below its own full-raise ceiling', () => {
    const below: string[] = [];
    for (const stage of AI_STAGES) {
      const limits = PROPOSED_STAGE_LIMITS[stage];
      // A stage with one attempt cannot retry at all, so no budget makes a raise reachable for it; the
      // case below pins which stages that excuses, so raising maxAttempts brings them back in here.
      if (limits.maxAttempts < 2) continue;
      const ceiling = fullRaiseCeiling(stage, limits.maxOutputTokens);
      const budget = PROPOSED_STAGE_COST_BUDGET_MICROS[stage];
      if (budget < ceiling) {
        below.push(`${stage}: budget ${budget} < full-raise ceiling ${ceiling}`);
      }
    }
    expect(below).toEqual([]);
  });

  it('excuses only the stages that cannot retry at all', () => {
    const oneAttempt = AI_STAGES.filter((s) => PROPOSED_STAGE_LIMITS[s].maxAttempts < 2);
    expect(oneAttempt).toEqual(['escalation']);
    // And the excused stage is excused for that reason and no other: `escalation` sits below its own
    // ceiling (500,000 against 660,000) and is named in `defineStageCostBudgets`, which is why the
    // case above may skip it. A second attempt for it, and routing.ts throws at import.
    expect(PROPOSED_STAGE_COST_BUDGET_MICROS.escalation).toBe(
      PROPOSED_STAGE_LIMITS.escalation.maxCostMicros,
    );
    expect(PROPOSED_STAGE_COST_BUDGET_MICROS.escalation).toBeLessThan(
      fullRaiseCeiling('escalation', PROPOSED_STAGE_LIMITS.escalation.maxOutputTokens),
    );
  });

  /**
   * The other half of HUNT6-D-CAP, and the one the round got wrong: a stage's cost BUDGET must never
   * be the number that admits a request. For every stage whose budget is above its cap, a request
   * whose upper bound is one step past the CAP must be refused with STAGE_LIMIT and ZERO provider
   * calls, even though the same request fits the budget comfortably. This is LJA-F4's property for
   * every stage, in the package that owns the check, so the next affordability raise cannot widen
   * admission again without turning this red.
   */
  it.each(['coaching', 'daily_set', 'thursday_bundle'] as const)(
    'refuses a %s request over its ADMISSION cap even though the stage budget would fit it',
    async (stage) => {
      const limits = PROPOSED_STAGE_LIMITS[stage];
      const budget = PROPOSED_STAGE_COST_BUDGET_MICROS[stage];
      expect(budget).toBeGreaterThan(limits.maxCostMicros);
      // The smallest input bound whose FIRST request is over the cap, from the production estimator.
      const estimateAt = (inputTokens: number): number => {
        const estimate = estimateUpperBoundCostMicros(DEFAULT_RATE_TABLE_2026_09_18, {
          modelId: STAGE_MODELS[stage],
          inputTokens,
          maxOutputTokens: limits.maxOutputTokens,
        });
        if (!estimate.ok) throw new Error(`${stage} has no rate row`);
        return estimate.value;
      };
      let low = 0;
      let high = 1_000_000;
      let admitted = 0;
      while (low <= high) {
        const mid = low + Math.floor((high - low) / 2);
        if (estimateAt(mid) <= limits.maxCostMicros) {
          admitted = mid;
          low = mid + 1;
        } else high = mid - 1;
      }
      const oversized = admitted + 1;
      // The premise that makes this case about the TWO numbers and not about arithmetic in general:
      // this request is over the admission cap and inside the stage budget.
      expect(estimateAt(oversized)).toBeGreaterThan(limits.maxCostMicros);
      expect(estimateAt(oversized)).toBeLessThanOrEqual(budget);

      const { client, requests } = recordingClient([okResult]);
      const prompt: PromptDefinition<z.ZodType> = PROMPTS[stage];
      const out = await runStage({
        prompt,
        input: [dataEnvelope({})],
        client,
        limits,
        rates: DEFAULT_RATE_TABLE_2026_09_18,
        gate,
        metadata: { stage },
        estimatedInputTokens: oversized,
        sleep: () => Promise.resolve(),
      });
      expect(requests).toEqual([]);
      expect(out.attempts).toEqual([]);
      expect(out.result.ok).toBe(false);
      if (!out.result.ok) expect(out.result.error.code).toBe('STAGE_LIMIT');
    },
  );

  /**
   * The invariant is about a real run, not only arithmetic: at its floor input every stage with a
   * prompt must make exactly TWO calls, the second at the full multiple. Red for coaching, daily_set
   * and thursday_bundle before the caps were raised (one call, OUTPUT_TRUNCATED at once).
   */
  const PROMPTED_STAGES = Object.keys(PROMPTS) as (keyof typeof PROMPTS)[];

  it.each(PROMPTED_STAGES)(
    '%s really retries a cut-off answer at the FULL raised budget at its floor input',
    async (stage) => {
      const prompt: PromptDefinition<z.ZodType> = PROMPTS[stage];
      const limits = PROPOSED_STAGE_LIMITS[prompt.stage];
      const floor = STAGE_FLOOR_INPUT_TOKENS[prompt.stage];
      const requests: ResponsesRequest[] = [];
      const client = createMockResponsesClient((request) => {
        requests.push(request);
        return {
          kind: 'incomplete' as const,
          usage: {
            inputTokens: floor,
            cachedInputTokens: 0,
            outputTokens: request.maxOutputTokens,
          },
          // The stage's OWN model: pricing a coaching retry at terra's rates would hide the defect.
          modelId: STAGE_MODELS[prompt.stage],
          latencyMs: 10,
          reason: 'max_output_tokens' as const,
        };
      });
      const out = await runStage({
        prompt,
        input: [dataEnvelope({})],
        client,
        limits,
        rates: DEFAULT_RATE_TABLE_2026_09_18,
        gate,
        metadata: { stage: prompt.stage },
        estimatedInputTokens: floor,
        sleep: () => Promise.resolve(),
      });
      expect(requests.map((r) => r.maxOutputTokens)).toEqual([
        limits.maxOutputTokens,
        limits.maxOutputTokens * OUTPUT_TRUNCATED_BUDGET_MULTIPLE,
      ]);
      // The whole stage fits the BUDGET, and the FIRST request fitted the ADMISSION cap: the raise is
      // paid for out of the stage budget, never by admitting a request the cap refuses (HUNT6-D-CAP).
      expect(out.attempts.reduce((n, a) => n + a.costMicros, 0)).toBeLessThanOrEqual(
        PROPOSED_STAGE_COST_BUDGET_MICROS[prompt.stage],
      );
      expect(out.attempts[0]!.costMicros).toBeLessThanOrEqual(limits.maxCostMicros);
      expect(out.result.ok).toBe(false);
      if (!out.result.ok) expect(out.result.error.code).toBe('OUTPUT_TRUNCATED');
    },
  );
});

// ---------------------------------------------------------------------------------------------
// HUNT6-D-CAP residual: the pair runStage is HANDED is checked, never silently narrowed
// ---------------------------------------------------------------------------------------------

/**
 * The split left the two numbers resolved from two independent places: `limits.maxCostMicros` comes
 * from the caller, the stage budget from PROPOSED_STAGE_COST_BUDGET_MICROS or from the caller's own
 * override. Nothing compared them, so a caller handing in a cap ABOVE the budget got the SMALLER
 * number without being told: its first request admitted at a price the stage as a whole may not pay,
 * and every later attempt weighed against a bound it never asked for. `defineStageCostBudgets` refuses
 * that ordering for the recorded table at import; these cases pin that runStage refuses it for the
 * pair it is handed, before the gate, the provider and any spend.
 */
describe('a cap above the stage budget is refused, not silently narrowed (HUNT6-D-CAP)', () => {
  it('throws when the caller-supplied limits admit more than the stage budget allows', async () => {
    const { client, requests } = recordingClient([okResult]);
    const out = runStage({
      ...common,
      client,
      limits: {
        ...PROPOSED_STAGE_LIMITS.extraction,
        maxCostMicros: PROPOSED_STAGE_COST_BUDGET_MICROS.extraction + 1,
      },
    });
    await expect(out).rejects.toThrow(RangeError);
    await expect(out).rejects.toThrow(/above the stage budget/);
    // Loud, and before anything is sent or spent.
    expect(requests).toEqual([]);
  });

  it('throws when a budget override is below the cap the first request is admitted with', async () => {
    const { client, requests } = recordingClient([okResult]);
    await expect(
      runStage({
        ...common,
        client,
        maxStageCostMicros: PROPOSED_STAGE_LIMITS.extraction.maxCostMicros - 1,
      }),
    ).rejects.toThrow(RangeError);
    expect(requests).toEqual([]);
  });

  it('never fires for a production caller: every recorded budget is at or above its own cap', async () => {
    for (const stage of AI_STAGES) {
      expect(PROPOSED_STAGE_COST_BUDGET_MICROS[stage], stage).toBeGreaterThanOrEqual(
        PROPOSED_STAGE_LIMITS[stage].maxCostMicros,
      );
    }
    // And the equal pair extraction is configured with runs, so the check is an ordering and not an
    // inequality that would refuse the stages whose two numbers are the same.
    expect(PROPOSED_STAGE_COST_BUDGET_MICROS.extraction).toBe(
      PROPOSED_STAGE_LIMITS.extraction.maxCostMicros,
    );
    const { client } = recordingClient([okResult]);
    const out = await runStage({ ...common, client });
    expect(out.result.ok).toBe(true);
  });
});
