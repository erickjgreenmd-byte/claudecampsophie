import type { JobDeps } from './dispatcher.ts';

/**
 * Application-enforced global AI spend ceiling (spec F4 "Enforce caps in the application because a
 * provider alert may lag"; E4 Cost controls "atomic reservations and reconciliation").
 *
 * Before an AI stage starts, a worker takes a hold for the stage's upper-bound cost under the budget
 * row lock. A stage is admitted only while recorded spend plus every live hold is still below the
 * owner's monthly cap, so at most the stage that crosses the cap runs — concurrent workers see each
 * other's holds instead of all passing the same stale check (RV-lead-jobs-ai-10). The hold is
 * released after the stage's actual cost is recorded; a hold whose worker died expires with the job
 * lease. No budget row means no ceiling: the owner's cap is never invented (docs/Owner_Actions.md).
 */

export class SpendCeilingReached extends Error {
  constructor() {
    super('SPEND_CEILING');
    this.name = 'SpendCeilingReached';
  }
}

/** Matches the job lease: a hold never outlives the worker that took it by much. */
export const SPEND_HOLD_MINUTES = 20;

function monthOf(now: Date): { periodKey: string; monthStart: Date } {
  return {
    periodKey: now.toISOString().slice(0, 7),
    monthStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  };
}

/**
 * Admits one AI stage (or a group of stages admitted together) with an upper-bound estimate.
 * Returns the hold id, or null when there is no budget for this month. Throws SpendCeilingReached
 * when the ceiling is already reached by recorded spend plus in-flight holds.
 */
export async function acquireSpendHold(
  deps: JobDeps,
  estimateMicros: number,
): Promise<string | null> {
  const now = deps.clock();
  const { periodKey, monthStart } = monthOf(now);
  return deps.db.asService(async (tx) => {
    const [budget] = await tx<{ budget_micros: string }[]>`
      select budget_micros::text from public.spend_budgets
       where scope = 'global' and period_key = ${periodKey}
       for update
    `;
    if (!budget) return null;
    const [usage] = await tx<{ spent: string; held: string }[]>`
      select coalesce((select sum(cost_micros) from public.ai_usage_events
                        where created_at >= ${monthStart}), 0)::text as spent,
             coalesce((select sum(micros) from private.ai_spend_holds
                        where period_key = ${periodKey} and expires_at > ${now}), 0)::text as held
    `;
    if (BigInt(usage!.spent) + BigInt(usage!.held) >= BigInt(budget.budget_micros)) {
      throw new SpendCeilingReached();
    }
    const [hold] = await tx<{ id: string }[]>`
      insert into private.ai_spend_holds (period_key, micros, expires_at)
      values (${periodKey}, ${Math.max(1, Math.ceil(estimateMicros))},
              ${new Date(now.getTime() + SPEND_HOLD_MINUTES * 60_000)})
      returning id
    `;
    return hold!.id;
  });
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
