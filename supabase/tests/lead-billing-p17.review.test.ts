import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { seedFamily, seedOwnerAdmin } from './fixtures.ts';

/**
 * RV-lead-billing-p17-9 (adversarial review): the school-facing monthly report publishes the
 * donation-eligible family count next to the accrued and paid amounts. Because every family is worth
 * exactly 100 cents, `eligible * 100 - accrued` and `eligible * 100 - paid` count small groups of
 * families (refunded/charged back, or settled late) even when every published count is >= 5.
 * Same-month arithmetic only; month-over-month differencing is out of scope.
 */
let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await seedOwnerAdmin(db);
});

afterAll(async () => {
  await db?.drop();
});

async function schoolWithViewer(): Promise<{ schoolId: string; viewer: string }> {
  const [school] = await db.sql<{ id: string }[]>`
    insert into public.schools (name, status) values (${'Review School ' + randomUUID().slice(0, 8)}, 'active') returning id`;
  const viewer = await db.createUser();
  await db.sql`insert into public.school_admins (school_id, user_id) values (${school!.id}, ${viewer})`;
  return { schoolId: school!.id, viewer };
}

/** One attributed, designated family with a settled full-price October period and its $1 accrual. */
async function accruedFamily(schoolId: string): Promise<string> {
  const fam = await seedFamily(db, { childCount: 0 });
  await db.sql`insert into public.family_school_attributions (family_id, school_id, source) values (${fam.familyId}, ${schoolId}, 'manual')`;
  await db.sql`insert into public.family_school_designations (family_id, school_id, effective_from) values (${fam.familyId}, ${schoolId}, '2026-09-01')`;
  const [period] = await db.sql<{ id: string }[]>`
    insert into public.billing_periods (family_id, channel, provider_period_id, kind, period_start, period_end, paid_slots,
      regular_amount_cents, charged_amount_cents, settlement, settled_at)
    values (${fam.familyId}, 'app_store', ${'rv9-' + fam.familyId}, 'subscription_period', '2026-10-05T00:00:00Z',
            '2026-11-05T00:00:00Z', 1, 3999, 3999, 'settled', now())
    returning id`;
  const [accrual] = await db.sql<{ id: string }[]>`
    insert into public.donation_accruals (family_id, school_id, donation_month, billing_period_id, eligibility_snapshot)
    values (${fam.familyId}, ${schoolId}, '2026-10', ${period!.id}, '{}') returning id`;
  return accrual!.id;
}

const report = (schoolId: string, viewer: string) =>
  db.asParent(
    viewer,
    (tx) => tx<
      {
        attributed_signups: string;
        donation_eligible_families: string;
        accrued_cents: string | null;
        paid_cents: string | null;
      }[]
    >`
      select attributed_signups, donation_eligible_families, accrued_cents, paid_cents
        from public.school_month_report(${schoolId}, '2026-10')`,
    { aal: 'aal1' },
  );

/** Families a school viewer can derive from one published row (100 cents per family). */
function derivableGroups(row: {
  donation_eligible_families: string;
  accrued_cents: string | null;
  paid_cents: string | null;
}): number[] {
  const eligible = Number(row.donation_eligible_families);
  if (!Number.isFinite(eligible)) return [];
  const groups: number[] = [];
  if (row.accrued_cents !== null) groups.push((eligible * 100 - Number(row.accrued_cents)) / 100);
  if (row.paid_cents !== null) groups.push((eligible * 100 - Number(row.paid_cents)) / 100);
  return groups;
}

describe('RV-lead-billing-p17-9: school report amounts must not reveal a 1-4 family group', () => {
  it('one refunded family is not recoverable as eligible*100 - accrued_cents', async () => {
    const { schoolId, viewer } = await schoolWithViewer();
    const accruals: string[] = [];
    for (let i = 0; i < 6; i++) accruals.push(await accruedFamily(schoolId));
    // One of the six families was refunded (or charged back) for October.
    await db.sql`
      insert into public.donation_adjustments (accrual_id, amount_cents, reason, idempotency_key)
      values (${accruals[0]!}, -100, 'refund', ${accruals[0]! + ':reversal'})`;
    const [row] = await report(schoolId, viewer);
    // Actual: { signups '6', eligible '6', accrued 500 } -> the viewer learns exactly one family
    // at this school got a refund/chargeback in October.
    const small = derivableGroups(row!).filter((n) => n >= 1 && n <= 4);
    expect(small).toEqual([]);
  });

  it('one late-settling family is not recoverable as eligible*100 - paid_cents', async () => {
    const { schoolId, viewer } = await schoolWithViewer();
    const accruals: string[] = [];
    for (let i = 0; i < 6; i++) accruals.push(await accruedFamily(schoolId));
    // The October batch was paid before the sixth family's (late) payment settled.
    const [batch] = await db.sql<{ id: string }[]>`
      insert into public.donation_payout_batches (school_id, batch_key, total_cents, status, external_transfer_ref, paid_at)
      values (${schoolId}, ${'payout:' + schoolId + ':2026-10'}, 500, 'paid', ${'ref-' + randomUUID()}, now()) returning id`;
    await db.sql`update public.donation_accruals set payout_batch_id = ${batch!.id} where id = any(${accruals.slice(0, 5)})`;
    const [row] = await report(schoolId, viewer);
    // Actual: { eligible '6', accrued 600, paid 500 } -> exactly one family paid late.
    const small = derivableGroups(row!).filter((n) => n >= 1 && n <= 4);
    expect(small).toEqual([]);
  });
});
