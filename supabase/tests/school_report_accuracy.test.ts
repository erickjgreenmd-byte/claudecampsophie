import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { seedFamily, seedOwnerAdmin } from './fixtures.ts';

/**
 * School report accuracy (spec P17 "The administrator can see amount owed versus actually paid";
 * AC_PROMO_10, AC_PROMO_12) and complementary suppression after the accuracy fixes (RV-donations-4,
 * RV-lead-billing-p17-9).
 *
 * - paid_cents is what the school was actually paid for the month: accruals in paid batches PLUS
 *   adjustments (reversals, reinstatements) that were netted in a later paid batch. A paid batch
 *   that was later marked `adjusted` is still paid.
 * - school_month_report_counts: a refunded or charged-back period is not an active (or paying)
 *   family; a partially refunded period still is.
 */
let db: TestDb;
let owner: string;

beforeAll(async () => {
  db = await createTestDb();
  owner = await seedOwnerAdmin(db);
});

afterAll(async () => {
  await db?.drop();
});

async function schoolWithViewer(): Promise<{ schoolId: string; viewer: string }> {
  const [school] = await db.sql<{ id: string }[]>`
    insert into public.schools (name, status, recipient_verified)
    values (${'Accuracy School ' + randomUUID().slice(0, 8)}, 'active', true) returning id`;
  const viewer = await db.createUser();
  await db.sql`insert into public.school_admins (school_id, user_id) values (${school!.id}, ${viewer})`;
  return { schoolId: school!.id, viewer };
}

interface PeriodOptions {
  readonly start?: string;
  readonly charged?: number;
  readonly discountSources?: string[];
  readonly settlement?: 'settled' | 'refunded' | 'partially_refunded' | 'chargeback';
  readonly refunded?: number;
}

async function period(familyId: string, options: PeriodOptions = {}): Promise<string> {
  const start = options.start ?? '2026-10-05T00:00:00Z';
  const charged = options.charged ?? 3999;
  const [row] = await db.sql<{ id: string }[]>`
    insert into public.billing_periods (family_id, channel, provider_period_id, kind, period_start, period_end, paid_slots,
      regular_amount_cents, charged_amount_cents, discount_cents, discount_sources, settlement, settled_at, refunded_cents)
    values (${familyId}, 'stripe', ${'in_acc_' + randomUUID()}, 'subscription_period', ${start},
            ${start}::timestamptz + interval '1 month', 1, 3999, ${charged}, ${3999 - charged},
            ${options.discountSources ?? []}, ${options.settlement ?? 'settled'}, '2026-10-06T00:00:00Z',
            ${options.refunded ?? 0})
    returning id`;
  return row!.id;
}

/** A designated family (attributed unless told otherwise); returns its family id. */
async function designatedFamily(schoolId: string, attributed = true): Promise<string> {
  const fam = await seedFamily(db, { childCount: 0 });
  if (attributed) {
    await db.sql`insert into public.family_school_attributions (family_id, school_id, source) values (${fam.familyId}, ${schoolId}, 'manual')`;
  }
  await db.sql`insert into public.family_school_designations (family_id, school_id, effective_from) values (${fam.familyId}, ${schoolId}, '2026-09-01')`;
  return fam.familyId;
}

/** A designated family with a settled full-price October period and its $1 accrual. */
async function accruedFamily(
  schoolId: string,
): Promise<{ familyId: string; accrualId: string; periodId: string }> {
  const familyId = await designatedFamily(schoolId);
  const periodId = await period(familyId);
  const [accrual] = await db.sql<{ id: string }[]>`
    insert into public.donation_accruals (family_id, school_id, donation_month, billing_period_id, eligibility_snapshot)
    values (${familyId}, ${schoolId}, '2026-10', ${periodId}, '{}') returning id`;
  return { familyId, accrualId: accrual!.id, periodId };
}

async function adjustment(accrualId: string, kind: 'reversal' | 'reinstatement'): Promise<string> {
  const key = `${accrualId}:${kind}`;
  await db.sql`
    insert into public.donation_adjustments (accrual_id, amount_cents, reason, idempotency_key)
    values (${accrualId}, ${kind === 'reversal' ? -100 : 100},
            ${kind === 'reversal' ? 'refund' : 'chargeback_reversed'}, ${key})`;
  return key;
}

/**
 * A payout batch holding the given accruals and adjustments. `total` is the transfer amount; the
 * database does not recompute it, so tests pass the net of the lines (or any positive filler when
 * the batch also carries other schools' months that are not under test).
 */
async function batch(
  schoolId: string,
  lines: { accruals?: readonly string[]; adjustments?: readonly string[] },
  status: 'accrued' | 'approved' | 'paid',
  total = 100,
): Promise<string> {
  const paid = status === 'paid';
  const [row] = await db.sql<{ id: string }[]>`
    insert into public.donation_payout_batches (school_id, batch_key, total_cents, status, external_transfer_ref, paid_at)
    values (${schoolId}, ${'payout:' + randomUUID()}, ${total}, ${status},
            ${paid ? 'ref-' + randomUUID() : null}, ${paid ? new Date('2026-11-10T00:00:00Z') : null})
    returning id`;
  if (lines.accruals?.length) {
    await db.sql`update public.donation_accruals set payout_batch_id = ${row!.id} where id = any(${lines.accruals})`;
  }
  if (lines.adjustments?.length) {
    await db.sql`update public.donation_adjustments set payout_batch_id = ${row!.id} where idempotency_key = any(${lines.adjustments})`;
  }
  return row!.id;
}

interface ReportRow {
  attributed_signups: string;
  donation_eligible_families: string;
  accrued_cents: string | null;
  paid_cents: string | null;
}

const report = (schoolId: string, viewer: string, aal: 'aal1' | 'aal2') =>
  db
    .asParent(
      viewer,
      (tx) => tx<ReportRow[]>`
        select attributed_signups, donation_eligible_families, accrued_cents, paid_cents
          from public.school_month_report(${schoolId}, '2026-10')`,
      { aal },
    )
    .then((rows) => rows[0]!);

interface CountsRow {
  active_families: string;
  positive_paying_families: string;
  fully_discounted_families: string;
}

const counts = (schoolId: string, viewer: string, aal: 'aal1' | 'aal2') =>
  db
    .asParent(
      viewer,
      async (tx) => {
        // As the API does (0740): the program calendar zone is stated for the transaction.
        await tx`select set_config('pencillift.program_zone', 'UTC', true)`;
        return tx<CountsRow[]>`
          select active_families, positive_paying_families, fully_discounted_families
            from public.school_month_report_counts(${schoolId}, '2026-10', 'UTC')`;
      },
      { aal },
    )
    .then((rows) => rows[0]!);

const ownerReport = (schoolId: string) => report(schoolId, owner, 'aal2');

/**
 * Every family-sized group a school viewer can derive from what is published for one school-month:
 * each published count and amount (in families), and every difference between two of them.
 */
function derivableGroups(values: readonly (string | null)[], amounts: readonly (string | null)[]) {
  const published: number[] = [0];
  for (const v of values) if (v !== null && /^\d+$/.test(v)) published.push(Number(v));
  for (const a of amounts) if (a !== null) published.push(Number(a) / 100);
  const groups: number[] = [];
  for (const x of published) for (const y of published) groups.push(Math.abs(x - y));
  return groups.filter((n) => n >= 1 && n <= 4);
}

describe('school_month_report paid_cents is the amount actually paid for the month', () => {
  it('a reversal netted in a later paid batch lowers the month; an unpaid batch does not', async () => {
    const { schoolId } = await schoolWithViewer();
    const families = [];
    for (let i = 0; i < 6; i++) families.push(await accruedFamily(schoolId));
    await batch(schoolId, { accruals: families.map((f) => f.accrualId) }, 'paid', 600);
    expect(await ownerReport(schoolId)).toMatchObject({ accrued_cents: '600', paid_cents: '600' });

    // One family is refunded after the October payout: owed drops at once, paid is still $6.
    const reversal = await adjustment(families[0]!.accrualId, 'reversal');
    expect(await ownerReport(schoolId)).toMatchObject({ accrued_cents: '500', paid_cents: '600' });

    // The reversal is netted in the next batch; until that batch is paid nothing was paid back.
    const next = await batch(schoolId, { adjustments: [reversal] }, 'approved');
    expect(await ownerReport(schoolId)).toMatchObject({ paid_cents: '600' });

    await db.sql`
      update public.donation_payout_batches
         set status = 'paid', external_transfer_ref = ${'ref-' + randomUUID()}, paid_at = '2026-12-10T00:00:00Z'
       where id = ${next}`;
    // Actual before the fix: paid_cents stayed 600 because adjustments were never counted as paid.
    expect(await ownerReport(schoolId)).toMatchObject({ accrued_cents: '500', paid_cents: '500' });
  });

  it('a reinstatement (won dispute) netted in a later paid batch restores the month', async () => {
    const { schoolId } = await schoolWithViewer();
    const families = [];
    for (let i = 0; i < 5; i++) families.push(await accruedFamily(schoolId));
    await batch(schoolId, { accruals: families.map((f) => f.accrualId) }, 'paid', 500);
    const reversal = await adjustment(families[1]!.accrualId, 'reversal');
    await batch(schoolId, { adjustments: [reversal] }, 'paid');
    expect(await ownerReport(schoolId)).toMatchObject({ accrued_cents: '400', paid_cents: '400' });
    const reinstatement = await adjustment(families[1]!.accrualId, 'reinstatement');
    expect(await ownerReport(schoolId)).toMatchObject({ accrued_cents: '500', paid_cents: '400' });
    await batch(schoolId, { adjustments: [reinstatement] }, 'paid');
    expect(await ownerReport(schoolId)).toMatchObject({ accrued_cents: '500', paid_cents: '500' });
  });

  it('a paid batch later marked adjusted still counts as paid', async () => {
    const { schoolId } = await schoolWithViewer();
    const families = [];
    for (let i = 0; i < 5; i++) families.push(await accruedFamily(schoolId));
    const paid = await batch(schoolId, { accruals: families.map((f) => f.accrualId) }, 'paid', 500);
    // paid --adjust--> adjusted (packages/domain/src/donations/payouts.ts): the transfer happened.
    await db.sql`update public.donation_payout_batches set status = 'adjusted' where id = ${paid}`;
    // Actual before the fix: paid_cents fell to 0 because only status 'paid' was counted.
    expect(await ownerReport(schoolId)).toMatchObject({ accrued_cents: '500', paid_cents: '500' });
  });

  it('a school viewer cannot derive a 1-4 family group from the corrected amounts', async () => {
    const { schoolId, viewer } = await schoolWithViewer();
    const families = [];
    for (let i = 0; i < 12; i++) families.push(await accruedFamily(schoolId));
    await batch(schoolId, { accruals: families.map((f) => f.accrualId) }, 'paid', 1200);
    const reversals = [];
    for (const f of families.slice(0, 6)) reversals.push(await adjustment(f.accrualId, 'reversal'));
    // Five of the six reversals were netted in a paid batch; one is still waiting.
    await batch(schoolId, { adjustments: reversals.slice(0, 5) }, 'paid');
    // Exact figures: 12 signups, 12 eligible, accrued 600, paid 700. Each is >= 5 families from
    // the others except accrued vs paid, which differ by exactly one family.
    expect(await ownerReport(schoolId)).toEqual({
      attributed_signups: '12',
      donation_eligible_families: '12',
      accrued_cents: '600',
      paid_cents: '700',
    });
    const row = await report(schoolId, viewer, 'aal1');
    expect(
      derivableGroups(
        [row.attributed_signups, row.donation_eligible_families],
        [row.accrued_cents, row.paid_cents],
      ),
    ).toEqual([]);
    expect(row).toMatchObject({
      donation_eligible_families: '<5',
      accrued_cents: null,
      paid_cents: null,
    });
  });
});

describe('internal figure helpers', () => {
  it('a school viewer cannot read the unsuppressed figures directly', async () => {
    const { schoolId, viewer } = await schoolWithViewer();
    await expect(
      db.asParent(
        viewer,
        (tx) => tx`select * from app.school_month_donation_figures(${schoolId}, '2026-10')`,
        { aal: 'aal2' },
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asAnon((tx) => tx`select app.reveals_small_group(array[100]::bigint[])`),
    ).rejects.toThrow(/permission denied/);
  });

  it('no client role, including the child role, may execute them', async () => {
    const rows = await db.sql<{ role: string; fn: string; allowed: boolean }[]>`
      select r.role, f.fn, has_function_privilege(r.role, f.fn, 'EXECUTE') as allowed
        from (values ('anon'), ('authenticated'), ('pl_child')) as r(role),
             (values ('app.school_month_donation_figures(uuid, text)'),
                     ('app.reveals_small_group(bigint[])')) as f(fn)`;
    expect(rows.filter((row) => row.allowed)).toEqual([]);
  });
});

describe('school_month_report_counts: refunded and charged-back periods are not active', () => {
  it('counts only periods whose payment stands (partial refunds still count)', async () => {
    const { schoolId } = await schoolWithViewer();
    for (let i = 0; i < 5; i++) await period(await designatedFamily(schoolId));
    // Fully refunded and charged back: the family neither was active nor paid this month.
    await period(await designatedFamily(schoolId), { settlement: 'refunded', refunded: 3999 });
    await period(await designatedFamily(schoolId), { settlement: 'chargeback', refunded: 3999 });
    // Partially refunded: the family kept its subscription and still paid something.
    await period(await designatedFamily(schoolId), {
      settlement: 'partially_refunded',
      refunded: 1000,
    });
    // Fully discounted by a promo code.
    await period(await designatedFamily(schoolId), { charged: 0, discountSources: ['promo_code'] });
    // An anchor change: a refunded period and a later standing period in the same month.
    const both = await designatedFamily(schoolId);
    await period(both, { start: '2026-10-02T00:00:00Z', settlement: 'refunded', refunded: 3999 });
    await period(both, { start: '2026-10-20T00:00:00Z' });

    // Actual before the fix: active 10, paying 9 (refunded and charged-back periods counted).
    expect(await counts(schoolId, owner, 'aal2')).toEqual({
      active_families: '8',
      positive_paying_families: '7',
      fully_discounted_families: '1',
    });
  });

  it('a school viewer cannot derive a 1-4 family group across the counts and the amounts', async () => {
    const { schoolId, viewer } = await schoolWithViewer();
    const families = [];
    for (let i = 0; i < 15; i++) families.push(await accruedFamily(schoolId));
    // Six of the fifteen donating families are refunded: their periods no longer count as active.
    for (const f of families.slice(0, 6)) {
      await db.sql`update public.billing_periods set settlement = 'refunded', refunded_cents = 3999 where id = ${f.periodId}`;
      await adjustment(f.accrualId, 'reversal');
    }
    // One designated (not attributed) family paid a discounted price: active, but not donating.
    await period(await designatedFamily(schoolId, false), {
      charged: 1999,
      discountSources: ['promo_code'],
    });
    // Exact: signups 15, eligible 15, accrued 900, paid 0; active 10, paying 10, discounted 0.
    expect(await ownerReport(schoolId)).toEqual({
      attributed_signups: '15',
      donation_eligible_families: '15',
      accrued_cents: '900',
      paid_cents: '0',
    });
    expect(await counts(schoolId, owner, 'aal2')).toEqual({
      active_families: '10',
      positive_paying_families: '10',
      fully_discounted_families: '0',
    });
    // Every pair inside each result is 0 or >= 5 families apart, but active (10) minus the accrued
    // families (9) is one: the one active, non-donating family.
    const row = await report(schoolId, viewer, 'aal1');
    const c = await counts(schoolId, viewer, 'aal1');
    expect(
      derivableGroups(
        [
          row.attributed_signups,
          row.donation_eligible_families,
          c.active_families,
          c.positive_paying_families,
          c.fully_discounted_families,
        ],
        [row.accrued_cents, row.paid_cents],
      ),
    ).toEqual([]);
  });
});
