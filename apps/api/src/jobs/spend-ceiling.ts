import {
  toStrictJsonSchema,
  type AttemptRecord,
  type InputPart,
  type PromptDefinition,
} from '@pencillift/ai';
import { evaluateSpend } from '@pencillift/domain/quotas';
import type { z } from 'zod';
import type { Environment } from '../config.ts';
import type { JobDeps } from './dispatcher.ts';

/**
 * Application-enforced global AI spend ceiling (spec F4 "Enforce caps in the application because a
 * provider alert may lag"; E4 Cost controls "atomic reservations and reconciliation").
 *
 * Before an AI stage starts, a worker takes a hold for the stage's upper-bound cost under the budget
 * row lock. A stage is admitted only when recorded spend + every live hold + its own estimate stays
 * within the owner's monthly cap (the domain rule `evaluateSpend`: reaching the cap exactly is
 * allowed), so no stage overshoots the cap and concurrent workers see each other's holds instead of
 * all passing the same stale check (RV-lead-jobs-ai-10). The hold is released in the same
 * transaction that records the stage's actual cost (`settleSpend`); when that cost cannot be
 * recorded the hold keeps counting it until the month ends, so a metering fault never switches the
 * ceiling off (LJA-F5). A hold whose worker died expires with the job lease. Every unexpired hold
 * counts, whatever month it was taken in: a stage admitted just before midnight UTC is metered in
 * the new month (LJA-F8).
 *
 * The owner's cap is never invented (docs/Owner_Actions.md). Without a budget row for the current
 * UTC month, development and test run uncapped; staging and production admit no AI stage
 * (`SpendBudgetMissing`, a `SpendCeilingReached`), so the cap cannot lapse at a month rollover
 * (LJA-F2).
 *
 * Because admission counts the estimate, the cap starts blocking work before recorded spend reaches
 * 100%. The first refusal therefore raises the 100% ceiling alert (when the owner configured it and it
 * was not sent yet), the same decision as the domain's `evaluateSpend`, so the owner hears about the
 * cap as soon as it blocks work. The 50%/80% alerts keep following recorded spend
 * (`recordSpendAlerts`); a refused estimate never uses them up early (RV-quotas-2).
 */

export class SpendCeilingReached extends Error {
  constructor() {
    super('SPEND_CEILING');
    this.name = 'SpendCeilingReached';
  }
}

/**
 * No owner budget for the current UTC month outside development and test: no AI stage runs until the
 * owner sets it. A subclass of SpendCeilingReached, so every caller pauses or falls back exactly as
 * at the ceiling.
 */
export class SpendBudgetMissing extends SpendCeilingReached {
  constructor() {
    super();
    this.name = 'SpendBudgetMissing';
    this.message = 'SPEND_BUDGET_MISSING';
  }
}

/** Environments where a month without an owner budget runs uncapped (local runs and fixtures). */
const UNCAPPED_WITHOUT_BUDGET: ReadonlySet<Environment> = new Set<Environment>([
  'development',
  'test',
]);

/** The amounts cannot be decided exactly (beyond the safe integer range): no hold, no AI call. */
export class SpendCeilingUnevaluable extends Error {
  constructor(code: string) {
    super(`SPEND_CEILING_UNEVALUABLE: ${code}`);
    this.name = 'SpendCeilingUnevaluable';
  }
}

/** Matches the job lease: a hold never outlives the worker that took it by much. */
export const SPEND_HOLD_MINUTES = 20;

/** The alert threshold that means "the cap is reached and blocking work". */
const CEILING_ALERT_PERCENT = 100;

function monthOf(now: Date): { periodKey: string; monthStart: Date } {
  return {
    periodKey: now.toISOString().slice(0, 7),
    monthStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  };
}

type Admission =
  | { readonly kind: 'no_budget' }
  | { readonly kind: 'held'; readonly holdId: string }
  | { readonly kind: 'refused'; readonly ceilingAlertRaised: boolean };

/**
 * Admits one AI stage (or a group of stages admitted together) with an upper-bound estimate.
 * Returns the hold id, or null when there is no budget for this month in development or test.
 * Throws SpendCeilingReached when recorded spend plus in-flight holds plus this estimate would exceed
 * the owner's cap, and SpendBudgetMissing when staging or production has no budget for this month.
 */
export async function acquireSpendHold(
  deps: JobDeps,
  estimateMicros: number,
): Promise<string | null> {
  if (!Number.isFinite(estimateMicros) || estimateMicros < 0) {
    throw new RangeError('A spend hold needs a finite, non-negative upper-bound estimate');
  }
  const micros = Math.max(1, Math.ceil(estimateMicros));
  const now = deps.clock();
  const { periodKey, monthStart } = monthOf(now);
  const admission = await deps.db.asService(async (tx): Promise<Admission> => {
    const [budget] = await tx<
      { id: string; budget_micros: string; thresholds: number[]; alerted: number[] }[]
    >`
      select id, budget_micros::text, alert_thresholds_percent as thresholds,
             alerted_thresholds_percent as alerted
        from public.spend_budgets
       where scope = 'global' and period_key = ${periodKey}
       for update
    `;
    if (!budget) return { kind: 'no_budget' };
    const [usage] = await tx<{ spent: string; held: string }[]>`
      select coalesce((select sum(cost_micros) from public.ai_usage_events
                        where created_at >= ${monthStart}), 0)::text as spent,
             coalesce((select sum(micros) from private.ai_spend_holds
                        where expires_at > ${now}), 0)::text as held
    `;
    const evaluation = evaluateSpend({
      budgetMicros: Number(budget.budget_micros),
      committedMicros: Number(usage!.spent),
      inFlightReservedMicros: Number(usage!.held),
      requestEstimateMicros: micros,
      alreadyAlerted: [],
    });
    // Amounts beyond the safe integer range cannot be decided exactly: fail closed, no AI call.
    if (!evaluation.ok) throw new SpendCeilingUnevaluable(evaluation.error.code);
    if (!evaluation.value.allowed) {
      const raise =
        budget.thresholds.includes(CEILING_ALERT_PERCENT) &&
        !budget.alerted.includes(CEILING_ALERT_PERCENT);
      if (raise) {
        await tx`
          update public.spend_budgets
             set alerted_thresholds_percent = ${[...budget.alerted, CEILING_ALERT_PERCENT]}::smallint[]
           where id = ${budget.id}
        `;
        await tx`
          insert into public.audit_events (actor_kind, action, target_type, target_id, metadata)
          values ('system', 'spend.threshold_crossed', 'spend_budget', ${budget.id},
                  ${JSON.stringify({ periodKey, thresholdPercent: CEILING_ALERT_PERCENT, reason: 'stage_refused' })}::text::jsonb)
        `;
      }
      return { kind: 'refused', ceilingAlertRaised: raise };
    }
    const [hold] = await tx<{ id: string }[]>`
      insert into private.ai_spend_holds (period_key, micros, expires_at)
      values (${periodKey}, ${micros}, ${new Date(now.getTime() + SPEND_HOLD_MINUTES * 60_000)})
      returning id
    `;
    return { kind: 'held', holdId: hold!.id };
  });
  switch (admission.kind) {
    case 'no_budget':
      if (UNCAPPED_WITHOUT_BUDGET.has(deps.config.environment)) return null;
      deps.log({ level: 'error', event: 'spend_budget_missing', code: 'SPEND_BUDGET_MISSING' });
      throw new SpendBudgetMissing();
    case 'held':
      return admission.holdId;
    case 'refused':
      // The alert row is committed before the refusal is raised to the caller.
      if (admission.ceilingAlertRaised) {
        deps.log({
          level: 'error',
          event: 'spend_threshold_crossed',
          code: `P${CEILING_ALERT_PERCENT}`,
        });
      }
      throw new SpendCeilingReached();
  }
}

/** Releases a hold after the stage's actual cost was recorded. Never throws. */
export async function releaseSpendHold(deps: JobDeps, holdId: string | null): Promise<void> {
  if (holdId === null) return;
  try {
    await deps.db.asService((tx) => tx`delete from private.ai_spend_holds where id = ${holdId}`);
  } catch {
    // The hold expires on its own; logged so a persistent failure is visible.
    deps.log({ level: 'warn', event: 'spend_hold_release_failed', code: 'SPEND_HOLD' });
  }
}

/** One ai_usage_events row (append-only owner cost record; no homework text). */
export interface UsageRow {
  readonly family_id: string | null;
  readonly child_id: string | null;
  readonly stage: AttemptRecord['stage'];
  readonly model_id: string;
  readonly prompt_version: string;
  readonly attempt: number;
  readonly status: AttemptRecord['status'];
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly output_tokens: number;
  readonly latency_ms: number;
  readonly cost_micros: number;
  readonly rate_table_version: string;
}

export function usageRows(
  attempts: readonly AttemptRecord[],
  familyId: string | null,
  childId: string | null,
): UsageRow[] {
  return attempts.map((a) => ({
    family_id: familyId,
    child_id: childId,
    stage: a.stage,
    model_id: a.modelId,
    prompt_version: a.promptVersion,
    attempt: a.attempt,
    status: a.status,
    input_tokens: a.inputTokens,
    cached_input_tokens: a.cachedInputTokens,
    output_tokens: a.outputTokens,
    latency_ms: a.latencyMs,
    cost_micros: a.costMicros,
    rate_table_version: a.rateTableVersion,
  }));
}

/**
 * Records a stage's metered attempts and releases its hold in ONE transaction, so the hold stops
 * counting only when the actual cost counts instead (LJA-F5). If the cost cannot be recorded, the
 * hold is not released: it is kept for the billed cost until the end of the UTC month, so the
 * ceiling still sees money the provider already charged. Never throws; returns whether the usage
 * was recorded.
 */
export async function settleSpend(
  deps: JobDeps,
  holdId: string | null,
  rows: readonly UsageRow[],
): Promise<boolean> {
  if (rows.length === 0 && holdId === null) return true;
  try {
    await deps.db.asService(async (tx) => {
      if (rows.length > 0) await tx`insert into public.ai_usage_events ${tx(rows as UsageRow[])}`;
      if (holdId !== null) await tx`delete from private.ai_spend_holds where id = ${holdId}`;
    });
    return true;
  } catch {
    if (rows.length === 0) {
      await releaseSpendHold(deps, holdId); // nothing to meter: only the release failed; retry it
      return true;
    }
    deps.log({ level: 'error', event: 'ai_usage_record_failed', code: 'METERING' });
  }
  const billed = rows.reduce((n, r) => n + r.cost_micros, 0);
  if (billed <= 0) {
    await releaseSpendHold(deps, holdId); // nothing was charged: the hold has nothing to keep
    return false;
  }
  if (holdId === null) return false; // uncapped (development/test without a budget)
  const now = deps.clock();
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  try {
    await deps.db.asService(
      (tx) => tx`
        update private.ai_spend_holds
           set micros = ${Math.ceil(billed)}, expires_at = greatest(expires_at, ${nextMonth})
         where id = ${holdId}`,
    );
  } catch {
    // The hold still counts its full estimate until it expires with the job lease.
    deps.log({ level: 'error', event: 'spend_hold_keep_failed', code: 'SPEND_HOLD' });
  }
  return false;
}

/** Tokens a single image may add to a request (provider accounting; owner-verified at activation). */
export const IMAGE_INPUT_TOKEN_BOUND = 1_500;
/** Message framing and part separators the provider adds around the text. */
const REQUEST_OVERHEAD_TOKENS = 64;
const PART_OVERHEAD_TOKENS = 16;

/**
 * An upper bound on the input tokens of the request actually sent (LJA-F4): the instructions, the
 * strict output schema and every text part, at one token per UTF-8 byte (a byte-level tokenizer
 * never produces more tokens than bytes), plus IMAGE_INPUT_TOKEN_BOUND per image and framing.
 * runStage refuses an attempt whose bound does not fit the stage's cost cap (STAGE_LIMIT), so an
 * oversized request is refused before it is sent instead of overshooting the owner's cap.
 */
export function inputTokenUpperBound<S extends z.ZodType>(
  prompt: PromptDefinition<S>,
  input: readonly InputPart[],
): number {
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  let tokens =
    REQUEST_OVERHEAD_TOKENS +
    bytes(prompt.instructions) +
    bytes(prompt.outputName) +
    bytes(JSON.stringify(toStrictJsonSchema(prompt.outputSchema)));
  for (const part of input) {
    tokens += PART_OVERHEAD_TOKENS;
    tokens += part.type === 'input_text' ? bytes(part.text) : IMAGE_INPUT_TOKEN_BOUND;
  }
  return tokens;
}
