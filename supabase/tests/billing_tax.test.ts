import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { childClaims, seedFamily, type SeededFamily } from './fixtures.ts';

/**
 * Migration 0900 (hardening round 5, finding HUNT5-C-2) against real Postgres.
 *
 * `billing_periods.charged_amount_cents` is the PRE-TAX subscription amount and the only figure the
 * owner's revenue view books as gross (BILL-R2-4). A provider refund amount is tax-inclusive, so
 * BILL-R4-3 converts it into that unit before writing `refunded_cents` — but it divided by the whole
 * Stripe Charge, i.e. the invoice total, which on a renewal carrying a mid-cycle proration line
 * scaled a real refund down by the proration's share of the invoice (a $39.99 refund on a
 * 3999 + 1000 invoice was recorded as 3199, and the owner's net revenue kept 799 cents that had
 * been given back). The ratio may only take the TAX off, so the tax has to be stored with the period:
 * the refund webhook must not go back to the provider for the invoice it already recorded.
 *
 * This file is the database half: the column exists, it is integer cents, it defaults to 0 for every
 * row written before the migration, it cannot go negative, and it is reachable on exactly the terms
 * the rest of `billing_periods` is — a family member reads their own rows, another family reads
 * nothing, a child and `anon` read nothing at all, and no client role may write it. Synthetic data
 * only; the amounts below are the approved prices.
 */

let db: TestDb;
let fam: SeededFamily;
let other: SeededFamily;

beforeAll(async () => {
  db = await createTestDb();
  fam = await seedFamily(db, { childCount: 1 });
  other = await seedFamily(db, { childCount: 1 });
});

afterAll(async () => {
  await db?.drop();
});

/**
 * One settled Stripe renewal for `fam`: $39.99 pre-tax booked as the charge, plus whatever tax the
 * caller states. Omitting `tax` inserts NO tax column at all, which is how every period recorded
 * before migration 0900 was written.
 */
async function recordPeriod(tax?: number): Promise<string> {
  const providerPeriodId = `in_tax_${randomUUID()}`;
  if (tax === undefined) {
    const [row] = await db.sql<{ id: string }[]>`
      insert into public.billing_periods (family_id, channel, provider_period_id, kind, period_start,
        period_end, paid_slots, regular_amount_cents, charged_amount_cents, settlement, settled_at)
      values (${fam.familyId}, 'stripe', ${providerPeriodId}, 'subscription_period', now(),
        now() + interval '1 month', 1, 3999, 3999, 'settled', now())
      returning id`;
    return row!.id;
  }
  const [row] = await db.sql<{ id: string }[]>`
    insert into public.billing_periods (family_id, channel, provider_period_id, kind, period_start,
      period_end, paid_slots, regular_amount_cents, charged_amount_cents, settlement, settled_at,
      tax_amount_cents)
    values (${fam.familyId}, 'stripe', ${providerPeriodId}, 'subscription_period', now(),
      now() + interval '1 month', 1, 3999, 3999, 'settled', now(), ${tax})
    returning id`;
  return row!.id;
}

async function taxOf(id: string): Promise<number> {
  const [row] = await db.sql<{ tax_amount_cents: number }[]>`
    select tax_amount_cents from public.billing_periods where id = ${id}`;
  return row!.tax_amount_cents;
}

// ---------------------------------------------------------------------------------------------
// HUNT5-C-2: the column, its type, its default and its check
// ---------------------------------------------------------------------------------------------

describe('[HUNT5-C-2] public.billing_periods.tax_amount_cents', () => {
  it('exists as a not-null integer column defaulting to 0', async () => {
    const [column] = await db.sql<
      {
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }[]
    >`
      select data_type, is_nullable, column_default
        from information_schema.columns
       where table_schema = 'public' and table_name = 'billing_periods'
         and column_name = 'tax_amount_cents'`;
    // Integer cents, never a float: money in this schema is always an exact integer of cents.
    expect(column).toMatchObject({ data_type: 'integer', is_nullable: 'NO' });
    expect(column!.column_default).toMatch(/^0$/);
  });

  it('defaults to 0 for a period written without it, which makes the refund ratio a no-op', async () => {
    // Exactly the shape of every row recorded before this migration: the insert names no tax column.
    const id = await recordPeriod();
    expect(await taxOf(id)).toBe(0);
    // charged / (charged + tax) = 3999 / 3999 = 1, so such a period converts nothing and keeps the
    // provider's figure under the cap at the charge — the behaviour it already had.
    const [ratio] = await db.sql<{ numerator: number; denominator: number }[]>`
      select charged_amount_cents as numerator,
             charged_amount_cents + tax_amount_cents as denominator
        from public.billing_periods where id = ${id}`;
    expect(ratio!.numerator).toBe(ratio!.denominator);
  });

  it('stores a stated tax exactly, in integer cents', async () => {
    // $39.99 at 8.25%: the taxed renewal of the BILL-R4-3 case (Charge total 4329).
    const id = await recordPeriod(330);
    expect(await taxOf(id)).toBe(330);
  });

  it('refuses a negative tax', async () => {
    await expect(recordPeriod(-1)).rejects.toThrow(/billing_periods_tax_amount_cents_non_negative/);
  });

  it('refuses an update that would make a stored tax negative', async () => {
    const id = await recordPeriod(330);
    await expect(
      db.sql`update public.billing_periods set tax_amount_cents = -5 where id = ${id}`,
    ).rejects.toThrow(/billing_periods_tax_amount_cents_non_negative/);
    expect(await taxOf(id)).toBe(330);
  });
});

// ---------------------------------------------------------------------------------------------
// HUNT5-C-2: the column is reachable on the same terms as the rest of the table
// ---------------------------------------------------------------------------------------------

describe('[HUNT5-C-2] tax_amount_cents inherits billing_periods’ RLS and grants', () => {
  it('a family member reads the tax on their own period', async () => {
    const id = await recordPeriod(330);
    const rows = await db.asParent(
      fam.ownerId,
      (tx) => tx<{ tax_amount_cents: number }[]>`
        select tax_amount_cents from public.billing_periods where id = ${id}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tax_amount_cents).toBe(330);
  });

  it('another family reads no row, so none of its tax', async () => {
    const id = await recordPeriod(330);
    const rows = await db.asParent(
      other.ownerId,
      (tx) => tx`select tax_amount_cents from public.billing_periods where id = ${id}`,
    );
    expect(rows).toHaveLength(0);
  });

  it('a child cannot select the column at all', async () => {
    await expect(
      db.asChild(childClaims(fam), (tx) => tx`select tax_amount_cents from public.billing_periods`),
    ).rejects.toThrow(/permission denied/);
  });

  it('anon cannot select the column at all', async () => {
    await expect(
      db.asAnon((tx) => tx`select tax_amount_cents from public.billing_periods`),
    ).rejects.toThrow(/permission denied/);
  });

  it('a parent cannot write the tax: every billing write stays with the API', async () => {
    const id = await recordPeriod(330);
    await expect(
      db.asParent(
        fam.ownerId,
        (tx) => tx`update public.billing_periods set tax_amount_cents = 0 where id = ${id}`,
      ),
    ).rejects.toThrow(/permission denied/);
    // A refund must not become recordable by the family that received it.
    expect(await taxOf(id)).toBe(330);
  });

  it('the table still has row level security enabled with the member read policy', async () => {
    const [table] = await db.sql<{ relrowsecurity: boolean }[]>`
      select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'billing_periods'`;
    expect(table!.relrowsecurity).toBe(true);
    const policies = await db.sql<{ policyname: string; cmd: string }[]>`
      select policyname, cmd from pg_policies
       where schemaname = 'public' and tablename = 'billing_periods'`;
    expect(policies).toEqual([{ policyname: 'billing_periods_member_read', cmd: 'SELECT' }]);
  });
});
