import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cryptoRandom } from '@pencillift/domain';
import { seedOwnerAdmin } from '@pencillift/db/testing/fixtures';
import { recordSpendAlerts, type JobDeps } from '../src/jobs/dispatcher.ts';
import {
  acquireSpendHold,
  releaseSpendHold,
  SPEND_HOLD_MINUTES,
  SpendCeilingReached,
} from '../src/jobs/spend-ceiling.ts';
import { createTestApi, type TestApi } from './helpers.ts';

/**
 * The application-enforced global AI spend ceiling (spec F4 "Enforce caps in the application because
 * a provider alert may lag"; AC_FIN_09; AC_SECURITY_06) against real Postgres. A stage is admitted
 * only when recorded spend + live holds + its own upper-bound estimate stays within the owner's cap,
 * so the cap is never overshot by the stage that crosses it. Synthetic usage rows only.
 */

let api: TestApi;
let deps: JobDeps;
let adminId: string;

const NOW = new Date('2026-09-24T15:00:00Z');

beforeAll(async () => {
  api = await createTestApi();
  deps = {
    db: api.apiDb,
    config: api.config,
    clock: () => api.now.value,
    random: cryptoRandom,
    providers: api.providers,
    log: (e) => api.logs.push(e),
  };
  adminId = await seedOwnerAdmin(api.db);
});

afterEach(async () => {
  api.now.value = NOW;
  await api.db.sql`delete from private.ai_spend_holds`;
  await api.db.sql`delete from public.spend_budgets`;
});

afterAll(async () => {
  await api?.close();
});

function periodKey(): string {
  return api.now.value.toISOString().slice(0, 7);
}

/** Recorded spend this UTC month, as the ceiling counts it. */
async function spentThisMonth(): Promise<bigint> {
  const now = api.now.value;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await api.db.sql<{ micros: string }[]>`
    select coalesce(sum(cost_micros), 0)::text as micros from public.ai_usage_events
     where created_at >= ${monthStart}`;
  return BigInt(row!.micros);
}

/** A synthetic metered stage (append-only usage row) at the current clock. */
async function recordSpend(micros: number): Promise<void> {
  await api.db.sql`
    insert into public.ai_usage_events (stage, model_id, prompt_version, status, input_tokens,
      output_tokens, latency_ms, cost_micros, rate_table_version, created_at)
    values ('grading', 'gpt-5.6-terra', 'grading.v1', 'succeeded', 10, 10, 5, ${micros}, 'test',
            ${api.now.value})`;
}

async function setBudget(micros: bigint, thresholds?: number[]): Promise<string> {
  const [row] = thresholds
    ? await api.db.sql<{ id: string }[]>`
        insert into public.spend_budgets (scope, period_key, budget_micros, alert_thresholds_percent, created_by)
        values ('global', ${periodKey()}, ${micros.toString()}::bigint, ${thresholds}::smallint[], ${adminId})
        returning id`
    : await api.db.sql<{ id: string }[]>`
        insert into public.spend_budgets (scope, period_key, budget_micros, created_by)
        values ('global', ${periodKey()}, ${micros.toString()}::bigint, ${adminId})
        returning id`;
  return row!.id;
}

async function liveHeldMicros(): Promise<bigint> {
  const [row] = await api.db.sql<{ micros: string }[]>`
    select coalesce(sum(micros), 0)::text as micros from private.ai_spend_holds
     where period_key = ${periodKey()} and expires_at > ${api.now.value}`;
  return BigInt(row!.micros);
}

async function holdCount(): Promise<number> {
  const [row] = await api.db.sql<{ n: number }[]>`
    select count(*)::int as n from private.ai_spend_holds`;
  return row!.n;
}

async function ceilingAlerts(budgetId: string): Promise<unknown[]> {
  const rows = await api.db.sql<{ metadata: unknown }[]>`
    select metadata from public.audit_events
     where action = 'spend.threshold_crossed' and target_id = ${budgetId}
     order by id`;
  return rows.map((r) => r.metadata);
}

async function alerted(budgetId: string): Promise<number[]> {
  const [row] = await api.db.sql<{ alerted: number[] }[]>`
    select alerted_thresholds_percent as alerted from public.spend_budgets where id = ${budgetId}`;
  return [...row!.alerted].sort((a, b) => a - b);
}

describe('global AI spend ceiling admission (spec F4, AC_FIN_09)', () => {
  it('without an owner budget there is no ceiling and no hold (the cap is never invented)', async () => {
    expect(await acquireSpendHold(deps, 350_000)).toBeNull();
    expect(await holdCount()).toBe(0);
  });

  it('refuses a stage whose estimate would cross the cap, although spent + held is still below it', async () => {
    const spent = await spentThisMonth();
    await setBudget(spent + 100_000n);
    // Before the fix a stage was admitted while spent + held < cap, so this one overshot by 1 micro.
    await expect(acquireSpendHold(deps, 100_001)).rejects.toBeInstanceOf(SpendCeilingReached);
    expect(await holdCount()).toBe(0); // a refused stage leaves no hold behind

    // With a live hold of 60,000 the remaining room is exactly 40,000.
    const first = await acquireSpendHold(deps, 60_000);
    expect(first).toEqual(expect.any(String));
    await expect(acquireSpendHold(deps, 40_001)).rejects.toBeInstanceOf(SpendCeilingReached);
    expect(await liveHeldMicros()).toBe(60_000n);
  });

  it('admits a stage that fits exactly (spent + held + estimate = cap), then nothing more', async () => {
    const spent = await spentThisMonth();
    await setBudget(spent + 100_000n);
    expect(await acquireSpendHold(deps, 60_000)).toEqual(expect.any(String));
    expect(await acquireSpendHold(deps, 40_000)).toEqual(expect.any(String));
    expect(await liveHeldMicros()).toBe(100_000n);
    await expect(acquireSpendHold(deps, 1)).rejects.toBeInstanceOf(SpendCeilingReached);
  });

  it('successive admitted stages never take recorded + held spend past the cap', async () => {
    const spent = await spentThisMonth();
    const cap = spent + 1_000_000n;
    await setBudget(cap);
    let admitted = 0;
    for (let i = 0; i < 5; i += 1) {
      try {
        await acquireSpendHold(deps, 350_000);
        admitted += 1;
      } catch (error) {
        expect(error).toBeInstanceOf(SpendCeilingReached);
      }
    }
    expect(admitted).toBe(2); // 700,000 fits; a third 350,000 would reach 1,050,000
    expect(spent + (await liveHeldMicros())).toBeLessThanOrEqual(cap);
  });

  it('an estimate larger than the whole budget is refused even with nothing spent', async () => {
    api.now.value = new Date('2026-12-10T12:00:00Z'); // a month with no recorded spend
    expect(await spentThisMonth()).toBe(0n);
    await setBudget(100_000n);
    await expect(acquireSpendHold(deps, 150_000)).rejects.toBeInstanceOf(SpendCeilingReached);
    expect(await holdCount()).toBe(0);
  });

  it('fails closed (no hold, no AI call) when the amounts cannot be decided exactly', async () => {
    // A cap beyond the safe integer range (bigint allows it) must never read as "no ceiling".
    await setBudget(9_223_372_036_854_775_807n);
    await expect(acquireSpendHold(deps, 350_000)).rejects.toThrow('SPEND_CEILING_UNEVALUABLE');
    await expect(acquireSpendHold(deps, Number.NaN)).rejects.toBeInstanceOf(RangeError);
    expect(await holdCount()).toBe(0);
  });

  it('concurrent workers with room for exactly one stage: one hold, the rest refused', async () => {
    const spent = await spentThisMonth();
    const cap = spent + 350_000n;
    await setBudget(cap);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => acquireSpendHold(deps, 350_000)),
    );
    const held = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(held).toHaveLength(1);
    expect(refused).toHaveLength(5);
    for (const r of refused) {
      expect(r.reason).toBeInstanceOf(SpendCeilingReached);
    }
    expect(spent + (await liveHeldMicros())).toBe(cap);
  });

  it('a released or expired hold frees its room; the recorded cost then counts instead', async () => {
    const spent = await spentThisMonth();
    await setBudget(spent + 350_000n);
    const hold = await acquireSpendHold(deps, 350_000);
    await expect(acquireSpendHold(deps, 350_000)).rejects.toBeInstanceOf(SpendCeilingReached);

    // The stage cost 200,000; after it is metered the hold is released.
    await recordSpend(200_000);
    await releaseSpendHold(deps, hold);
    await expect(acquireSpendHold(deps, 150_001)).rejects.toBeInstanceOf(SpendCeilingReached);
    const second = await acquireSpendHold(deps, 150_000);
    expect(second).toEqual(expect.any(String));

    // A worker that died never releases; its hold stops counting once the lease-long hold expires.
    await expect(acquireSpendHold(deps, 1)).rejects.toBeInstanceOf(SpendCeilingReached);
    api.now.value = new Date(NOW.getTime() + (SPEND_HOLD_MINUTES * 60 + 1) * 1000);
    expect(await acquireSpendHold(deps, 150_000)).toEqual(expect.any(String));
  });
});

describe('spend alerts with the strict ceiling (spec F4 50/80/100%)', () => {
  it('50/80% follow recorded spend; the first refusal raises the 100% ceiling alert once', async () => {
    api.now.value = new Date('2026-10-15T12:00:00Z'); // a fresh month: recorded spend starts at 0
    expect(await spentThisMonth()).toBe(0n);
    const budgetId = await setBudget(1_000_000n);

    await recordSpend(600_000);
    expect(await recordSpendAlerts(deps)).toEqual([50]);

    // 600,000 + 350,000 fits; the stage is metered at 250,000.
    const hold = await acquireSpendHold(deps, 350_000);
    await recordSpend(250_000);
    await releaseSpendHold(deps, hold);
    expect(await recordSpendAlerts(deps)).toEqual([80]);
    expect(await alerted(budgetId)).toEqual([50, 80]);

    // 850,000 + 350,000 would cross the cap: refused although recorded spend is only 85%. The owner
    // hears that the cap is now blocking AI work (the 100% alert), exactly once.
    api.logs.length = 0;
    await expect(acquireSpendHold(deps, 350_000)).rejects.toBeInstanceOf(SpendCeilingReached);
    expect(await alerted(budgetId)).toEqual([50, 80, 100]);
    expect(
      api.logs.filter((l) => l.event === 'spend_threshold_crossed' && l.code === 'P100'),
    ).toEqual([{ level: 'error', event: 'spend_threshold_crossed', code: 'P100' }]);
    await expect(acquireSpendHold(deps, 350_000)).rejects.toBeInstanceOf(SpendCeilingReached);
    expect(await recordSpendAlerts(deps)).toEqual([]); // never a duplicate from the periodic check
    const alerts = await ceilingAlerts(budgetId);
    expect(alerts).toHaveLength(3);
    expect(alerts[2]).toEqual({
      periodKey: '2026-10',
      thresholdPercent: 100,
      reason: 'stage_refused',
    });
    expect(
      api.logs.filter((l) => l.event === 'spend_threshold_crossed' && l.code === 'P100'),
    ).toHaveLength(1);
    expect(await holdCount()).toBe(0);

    // A stage that still fits is admitted after the alert (the cap itself decides, not the alert).
    expect(await acquireSpendHold(deps, 150_000)).toEqual(expect.any(String));
  });

  it('a refused oversized stage does not use up the 50%/80% alerts early', async () => {
    api.now.value = new Date('2026-11-15T12:00:00Z');
    expect(await spentThisMonth()).toBe(0n);
    const budgetId = await setBudget(1_000_000n);
    await recordSpend(100_000);
    await expect(acquireSpendHold(deps, 1_000_000)).rejects.toBeInstanceOf(SpendCeilingReached);
    expect(await alerted(budgetId)).toEqual([100]);
    // Recorded spend later reaches 50% and 80%: those alerts still fire.
    await recordSpend(750_000);
    expect(await recordSpendAlerts(deps)).toEqual([50, 80]);
  });

  it('no ceiling alert when the owner did not configure a 100% threshold', async () => {
    api.now.value = new Date('2027-01-15T12:00:00Z');
    expect(await spentThisMonth()).toBe(0n);
    const budgetId = await setBudget(100_000n, [50, 80]);
    await expect(acquireSpendHold(deps, 150_000)).rejects.toBeInstanceOf(SpendCeilingReached);
    expect(await alerted(budgetId)).toEqual([]);
    expect(await ceilingAlerts(budgetId)).toEqual([]);
  });
});
