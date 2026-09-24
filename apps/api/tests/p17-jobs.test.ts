import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cryptoRandom } from '@pencillift/domain';
import { seedFamily } from '@pencillift/db/testing/fixtures';
import { runScheduledTick, type JobDeps } from '../src/jobs/dispatcher.ts';
import {
  DONATION_SETTLEMENT_LOOKBACK_MONTHS,
  runDonationAccrual,
} from '../src/services/p17-jobs.ts';
import { createTestApi, type TestApi } from './helpers.ts';

/**
 * Spec P17: "Record late settlement against the original period, not as a new donation month."
 * The accrual job must still find a period whose payment settles (or reaches us) months after the
 * period started, and book its $1 against the month the period started in, once.
 */
const ZONE = 'America/Los_Angeles';
let api: TestApi;
let schoolId: string;

beforeAll(async () => {
  api = await createTestApi({ PROGRAM_TIMEZONE: ZONE });
  const [school] = await api.db.sql<{ id: string }[]>`
    insert into public.schools (name, status) values ('Late Settlement Elementary', 'active') returning id`;
  schoolId = school!.id;
});

afterAll(async () => {
  await api?.close();
});

async function designatedFamily(): Promise<string> {
  const fam = await seedFamily(api.db, { childCount: 0 });
  await api.db.sql`
    insert into public.family_school_designations (family_id, school_id, effective_from)
    values (${fam.familyId}, ${schoolId}, '2025-01-01')`;
  return fam.familyId;
}

/** A full-price, settled monthly period (the payment may settle long after the period starts). */
async function settledPeriod(familyId: string, start: string, settledAt: string): Promise<string> {
  const [row] = await api.db.sql<{ id: string }[]>`
    insert into public.billing_periods (family_id, channel, provider_period_id, kind, period_start, period_end, paid_slots,
      regular_amount_cents, charged_amount_cents, settlement, settled_at, created_at)
    values (${familyId}, 'stripe', ${'in_late_' + randomUUID()}, 'subscription_period', ${start},
            ${start}::timestamptz + interval '1 month', 1, 3999, 3999, 'settled', ${settledAt}, ${settledAt})
    returning id`;
  return row!.id;
}

const accrualsOf = (familyId: string) =>
  api.db.sql<{ donation_month: string; billing_period_id: string; amount_cents: number }[]>`
    select donation_month, billing_period_id, amount_cents from public.donation_accruals
     where family_id = ${familyId} order by donation_month`;

describe('late settlement is recorded against the original period (spec P17, AC_PROMO_12)', () => {
  it('a rerun re-evaluates no family whose settled periods have all accrued', async () => {
    // Runs first, on an otherwise empty ledger: the long lookback stays cheap on a 5-minute tick
    // because only families with a settled period still missing its month's accrual are evaluated.
    const familyId = await designatedFamily();
    await settledPeriod(familyId, '2026-09-03T17:00:00Z', '2026-09-03T17:05:00Z');
    const first = await runDonationAccrual(api.apiDb, '2026-09', ZONE);
    expect(first).toMatchObject({ familiesEvaluated: 1, accrued: 1 });
    const again = await runDonationAccrual(api.apiDb, '2026-09', ZONE);
    expect(again).toMatchObject({ familiesEvaluated: 0, accrued: 0 });
  });

  it('a payment that settles five months after its period started accrues $1 for that month', async () => {
    const familyId = await designatedFamily();
    // An April invoice that stayed open and was paid in late September.
    const periodId = await settledPeriod(familyId, '2026-04-10T17:00:00Z', '2026-09-20T18:00:00Z');
    const result = await runDonationAccrual(api.apiDb, '2026-09', ZONE);
    // Actual before the fix: the job only looked at periods starting in July-September.
    expect(result.accrued).toBe(1);
    expect(await accrualsOf(familyId)).toEqual([
      { donation_month: '2026-04', billing_period_id: periodId, amount_cents: 100 },
    ]);
  });

  it('reruns, a second late period in the same month and a later month keep one $1 per month', async () => {
    const familyId = await designatedFamily();
    const april = await settledPeriod(familyId, '2026-04-02T17:00:00Z', '2026-08-30T18:00:00Z');
    expect((await runDonationAccrual(api.apiDb, '2026-09', ZONE)).accrued).toBe(1);
    // A billing-anchor change produced a second April period; it settles even later.
    await settledPeriod(familyId, '2026-04-20T17:00:00Z', '2026-09-22T18:00:00Z');
    const may = await settledPeriod(familyId, '2026-05-02T17:00:00Z', '2026-09-22T18:00:00Z');
    const [a, b] = await Promise.all([
      runDonationAccrual(api.apiDb, '2026-09', ZONE),
      runDonationAccrual(api.apiDb, '2026-09', ZONE),
    ]);
    expect(a.accrued + b.accrued).toBe(1);
    expect((await runDonationAccrual(api.apiDb, '2026-09', ZONE)).accrued).toBe(0);
    expect(await accrualsOf(familyId)).toEqual([
      { donation_month: '2026-04', billing_period_id: april, amount_cents: 100 },
      { donation_month: '2026-05', billing_period_id: may, amount_cents: 100 },
    ]);
  });

  it(`the lookback is bounded at ${DONATION_SETTLEMENT_LOOKBACK_MONTHS} program months before the run month`, async () => {
    expect(DONATION_SETTLEMENT_LOOKBACK_MONTHS).toBe(12);
    const inside = await designatedFamily();
    const outside = await designatedFamily();
    // 2025-09-01 00:00 in Los Angeles is the first instant of the window for a 2026-09 run.
    const first = await settledPeriod(inside, '2025-09-01T07:00:00Z', '2026-09-21T00:00:00Z');
    await settledPeriod(outside, '2025-09-01T06:59:59Z', '2026-09-21T00:00:00Z');
    await runDonationAccrual(api.apiDb, '2026-09', ZONE);
    expect(await accrualsOf(inside)).toEqual([
      { donation_month: '2025-09', billing_period_id: first, amount_cents: 100 },
    ]);
    expect(await accrualsOf(outside)).toEqual([]);
  });

  it('the scheduled tick accrues a late settlement for its original month', async () => {
    const familyId = await designatedFamily();
    const march = await settledPeriod(familyId, '2026-03-15T17:00:00Z', '2026-09-23T12:00:00Z');
    const deps: JobDeps = {
      db: api.apiDb,
      config: api.config,
      clock: () => api.now.value,
      random: cryptoRandom,
      providers: api.providers,
      log: (e) => api.logs.push(e),
    };
    const report = await runScheduledTick(deps);
    expect(report.failedSteps).not.toContain('donation_accrual');
    expect(await accrualsOf(familyId)).toEqual([
      { donation_month: '2026-03', billing_period_id: march, amount_cents: 100 },
    ]);
  });
});
