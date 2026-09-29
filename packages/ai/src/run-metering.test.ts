import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AI_STAGES,
  canAttempt,
  DEFAULT_RATE_TABLE_2026_09_18,
  estimateUpperBoundCostMicros,
  type AiStage,
} from '@pencillift/domain/quotas';
import { createMockResponsesClient, type ResponsesResult } from './client.ts';
import { dataEnvelope, PROMPTS } from './prompts.ts';
import {
  PROPOSED_STAGE_COST_BUDGET_MICROS,
  PROPOSED_STAGE_LIMITS,
  STAGE_MODELS,
} from './routing.ts';
import { runStage } from './run.ts';

/**
 * JOBS-R1-03: an attempt whose usage the provider never reported (a client-side timeout, a network
 * failure, a 5xx) may still have been run and billed in full, so it is metered at the upper bound
 * the loop admitted it with and counts against the stage's cost BUDGET; a request the provider refused
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
 * hardcoded. HUNT5-C-1 raised extraction's ceiling from 150,000 to 216,816 micros so the one truncation
 * retry is reachable at the product's ten-page limit, and that invalidated the 5,000-token /
 * 58,000-micro / "two attempts fit" arithmetic the cap case below used to carry: at 5,000 tokens
 * three attempts now fit, so `maxAttempts` — not the cost limit — would have ended the loop and the
 * case would have stopped testing what it names. Derived here, the next ceiling change re-derives the
 * input instead of silently reddening the case for the wrong reason.
 *
 * What bounds a RETRY is the stage's cost BUDGET, not its per-request admission cap (HUNT6-D-CAP), so
 * that is the number searched against — extraction's two happen to be the same 216,816 today, and this
 * keeps naming the one that really ends the loop if the owner ever parts them.
 */
function largestInputAdmitting(attempts: number): number {
  const cap = PROPOSED_STAGE_COST_BUDGET_MICROS.extraction;
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

  it('timed-out attempts count against the stage budget: no attempt is admitted past it', async () => {
    const limits = PROPOSED_STAGE_LIMITS.extraction;
    const budget = PROPOSED_STAGE_COST_BUDGET_MICROS.extraction;
    // An input sized from the budget so THE COST LIMIT is what ends the loop: two attempts spend all
    // of it and a third would pass it, while maxAttempts still has room for that third attempt. All
    // three premises are asserted, so the case cannot quietly become a maxAttempts test — and the
    // first attempt has to be ADMITTED, which is the per-request cap and a different number
    // (HUNT6-D-CAP).
    const estimatedInputTokens = largestInputAdmitting(2);
    const bound = upperBound(estimatedInputTokens);
    expect(limits.maxAttempts).toBeGreaterThan(2);
    expect(bound).toBeLessThanOrEqual(limits.maxCostMicros);
    expect(2 * bound).toBeLessThanOrEqual(budget);
    expect(3 * bound).toBeGreaterThan(budget);
    const client = createMockResponsesClient(() => errorResult(null, true));
    const out = await runStage({ ...common, client, estimatedInputTokens });
    expect(out.attempts).toHaveLength(2);
    const recorded = out.attempts.reduce((n, a) => n + a.costMicros, 0);
    expect(recorded).toBe(2 * bound);
    expect(recorded).toBeLessThanOrEqual(budget);
    const third = canAttempt(
      { ...limits, maxCostMicros: budget },
      { attemptsSoFar: 2, spentMicrosSoFar: recorded, nextEstimateMicros: bound },
    );
    expect(third.allow).toBe(false);
    // The cost limit, not the attempt count: a MAX_ATTEMPTS denial here would mean the case had
    // drifted.
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

// ---------------------------------------------------------------------------------------------
// HUNT7-B-1: the stage BUDGET is the cumulative bound for EVERY attempt after the first
// ---------------------------------------------------------------------------------------------

/**
 * HUNT7-B-1. run.ts weighs attempt 1 against the per-request ADMISSION cap and every attempt after
 * it against the stage BUDGET (run.ts's `attempt === 1 ? limits : { ...limits, maxCostMicros:
 * maxStageCostMicros }`), whatever ended the earlier attempt — a truncated answer, a client-side
 * timeout, a 5xx or a validation rejection alike. That is the code the lead kept: a spend hold
 * reserves the budget, so the budget is what the stage may spend, and a second try after a
 * transient failure is what gets a child a real hint instead of a template.
 *
 * What it is NOT is "a reservation and not money". For the five stages whose budget is above their
 * cap there is a band of input sizes in which the second attempt is now made and billed where the
 * single pre-split number refused it, and these cases compute that band from the production tables
 * and require routing.ts to state it — so the constant's own docstring cannot go back to saying the
 * split moves no money.
 */
function largestSatisfying(predicate: (n: number) => boolean): number {
  let low = 1;
  // Ten million estimated input tokens is past every stage's admission cap at every rate row here,
  // so the answer is bracketed.
  let high = 10_000_000;
  let best = 0;
  while (low <= high) {
    const mid = low + Math.floor((high - low) / 2);
    if (predicate(mid)) {
      best = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  return best;
}

/** The upper-bound estimate of one attempt of `stage` at its configured output budget. */
function estimateAt(stage: AiStage, inputTokens: number): number {
  const estimate = estimateUpperBoundCostMicros(DEFAULT_RATE_TABLE_2026_09_18, {
    modelId: STAGE_MODELS[stage],
    inputTokens,
    maxOutputTokens: PROPOSED_STAGE_LIMITS[stage].maxOutputTokens,
  });
  if (!estimate.ok) throw new Error(`${stage} has no rate row`);
  return estimate.value;
}

/**
 * The estimated-input band in which the cap/budget split bought a stage a SECOND billed attempt
 * after a failure the provider never reported usage for. Such an attempt is metered at the full
 * upper bound it was admitted with (JOBS-R1-03), so `spent` equals its estimate exactly and the
 * loop weighs 2 x estimate: over the ADMISSION cap, still inside the stage BUDGET. Both edges are
 * searched with the production estimator, so the band moves when the owner's numbers move.
 */
function secondAttemptBand(stage: AiStage): { readonly from: number; readonly to: number } | null {
  const limits = PROPOSED_STAGE_LIMITS[stage];
  const budget = PROPOSED_STAGE_COST_BUDGET_MICROS[stage];
  if (limits.maxAttempts < 2 || budget <= limits.maxCostMicros) return null;
  // Attempt 1 has to be admitted at all: that is the cap, on this one request.
  const admitted = largestSatisfying((e) => estimateAt(stage, e) <= limits.maxCostMicros);
  // Up to here the cap alone would have admitted the second attempt too, so the split changed
  // nothing; one token past it the old single number ended the stage after one attempt.
  const capAdmitsTwo = largestSatisfying((e) => 2 * estimateAt(stage, e) <= limits.maxCostMicros);
  const budgetAdmitsTwo = largestSatisfying((e) => 2 * estimateAt(stage, e) <= budget);
  const from = capAdmitsTwo + 1;
  const to = Math.min(budgetAdmitsTwo, admitted);
  return to >= from ? { from, to } : null;
}

/** 2501 -> "2,501": the form routing.ts writes its numbers in. */
function grouped(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The docstring of PROPOSED_STAGE_COST_BUDGET_MICROS, unwrapped: comment markers stripped and
 * whitespace collapsed BEFORE matching, because a sentence the formatter split over two lines must
 * still be readable to a regex — otherwise a prose guard passes on the claim it cannot see
 * (HUNT7-B-7, the L-054 shape).
 */
function budgetTableDocstring(): string {
  const source = readFileSync(new URL('./routing.ts', import.meta.url), 'utf8');
  const from = source.indexOf(' * The budget for a STAGE AS A WHOLE');
  const to = source.indexOf('export const PROPOSED_STAGE_COST_BUDGET_MICROS');
  if (from < 0 || to < from) throw new Error('routing.ts no longer documents the budget table');
  return source
    .slice(from, to)
    .replace(/\s*\*\s*/g, ' ')
    .replace(/\s+/g, ' ');
}

const BAND_STAGES = AI_STAGES.filter((stage) => secondAttemptBand(stage) !== null);

describe('the stage budget bounds every attempt after the first (HUNT7-B-1)', () => {
  it('opens a second billed attempt for exactly the stages whose budget is above their cap', () => {
    expect(BAND_STAGES).toEqual([
      'coaching',
      'followup',
      'daily_set',
      'thursday_bundle',
      'semantic_check',
    ]);
    for (const stage of BAND_STAGES) {
      expect(PROPOSED_STAGE_COST_BUDGET_MICROS[stage], stage).toBeGreaterThan(
        PROPOSED_STAGE_LIMITS[stage].maxCostMicros,
      );
    }
    // And for no other stage: where the two numbers are equal, the split cannot have moved money.
    for (const stage of AI_STAGES.filter((s) => !BAND_STAGES.includes(s))) {
      const limits = PROPOSED_STAGE_LIMITS[stage];
      expect(
        limits.maxAttempts < 2 || PROPOSED_STAGE_COST_BUDGET_MICROS[stage] === limits.maxCostMicros,
        stage,
      ).toBe(true);
    }
  });

  it('really bills a coaching stage twice inside that band, and once one token past it', async () => {
    const band = secondAttemptBand('coaching')!;
    const limits = PROPOSED_STAGE_LIMITS.coaching;
    const budget = PROPOSED_STAGE_COST_BUDGET_MICROS.coaching;
    const run = (estimatedInputTokens: number) =>
      runStage({
        prompt: PROMPTS.coaching,
        input: [dataEnvelope({})],
        // Every attempt is a 5xx: the provider may have run and billed it, so it is metered at the
        // full upper bound it was admitted with and `spent` is exactly that estimate.
        client: createMockResponsesClient(() => errorResult(503)),
        limits,
        rates: DEFAULT_RATE_TABLE_2026_09_18,
        gate,
        metadata: { stage: 'coaching' },
        estimatedInputTokens,
        sleep: () => Promise.resolve(),
      });
    const inside = await run(band.to);
    expect(inside.attempts).toHaveLength(2);
    for (const attempt of inside.attempts) expect(attempt.usageEstimated).toBe(true);
    const spent = inside.attempts.reduce((n, a) => n + a.costMicros, 0);
    // The whole point: this stage spent MORE than the number that used to bound the whole stage,
    // and no more than the budget the caller's hold reserved.
    expect(spent).toBeGreaterThan(limits.maxCostMicros);
    expect(spent).toBeLessThanOrEqual(budget);
    // One estimated input token past the band the budget has no room either, and the stage stops
    // after the one attempt — so the band's upper edge is the budget's and not the cap's.
    const past = await run(band.to + 1);
    expect(past.attempts).toHaveLength(1);
  });

  it('routing.ts states that band instead of calling the budget a reservation only', () => {
    const doc = budgetTableDocstring();
    // The load-bearing half: what the number bounds, and that it is spend and not only a hold.
    expect(doc).toMatch(/every attempt after the first/i);
    expect(doc).toMatch(/cumulative/i);
    expect(doc).toMatch(/second billed/i);
    // And the band itself, per stage, in the figures these cases compute.
    for (const stage of BAND_STAGES) {
      const band = secondAttemptBand(stage)!;
      expect(doc, stage).toContain(`${stage} ${grouped(band.from)}..${grouped(band.to)}`);
    }
  });
});

/**
 * HUNT7-B-2. The same docstring said the budget is what learning-jobs.ts "reserves for the
 * personalization stage", singular, while `personalizeItems` takes
 * `stage: 'daily_set' | 'thursday_bundle'` and both arms are live — two holds, 483,240 and 933,600
 * micro-USD. The owner's cost record was written from that sentence and named the smaller one as the
 * largest hold in the product, understating the peak by 93%.
 */
describe('both personalization stages are named beside their holds (HUNT7-B-2)', () => {
  it('names each arm and its own budget, from the table', () => {
    const doc = budgetTableDocstring();
    for (const stage of ['daily_set', 'thursday_bundle'] as const) {
      expect(doc, stage).toContain(stage);
      expect(doc, stage).toContain(grouped(PROPOSED_STAGE_COST_BUDGET_MICROS[stage]));
    }
    // And which of the two is the peak the owner has to size a ceiling against.
    expect(PROPOSED_STAGE_COST_BUDGET_MICROS.thursday_bundle).toBeGreaterThan(
      PROPOSED_STAGE_COST_BUDGET_MICROS.daily_set,
    );
  });
});
