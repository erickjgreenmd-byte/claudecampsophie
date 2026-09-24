import { evaluateSpend } from '@pencillift/domain/quotas';
import type { JobDeps } from './dispatcher.ts';

/**
 * Application-enforced global AI spend ceiling (spec F4 "Enforce caps in the application because a
 * provider alert may lag"; E4 Cost controls "atomic reservations and reconciliation").
 *
 * Before an AI stage starts, a worker takes a hold for the stage's upper-bound cost under the budget
 * row lock. A stage is admitted only when recorded spend + every live hold + its own estimate stays
 * within the owner's monthly cap (the domain rule `evaluateSpend`: reaching the cap exactly is
 * allowed), so no stage overshoots the cap and concurrent workers see each other's holds instead of
 * all passing the same stale check (RV-lead-jobs-ai-10). The hold is released after the stage's
 * actual cost is recorded; a hold whose worker died expires with the job lease. No budget row means
 * no ceiling: the owner's cap is never invented (docs/Owner_Actions.md).
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
 * Returns the hold id, or null when there is no budget for this month. Throws SpendCeilingReached
 * when recorded spend plus in-flight holds plus this estimate would exceed the owner's cap.
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
                        where period_key = ${periodKey} and expires_at > ${now}), 0)::text as held
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
      return null;
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
