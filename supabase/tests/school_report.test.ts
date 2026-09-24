import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { seedFamily, seedOwnerAdmin } from './fixtures.ts';

/**
 * School-facing aggregate reports (AC_PROMO_10) with complementary suppression (RV-donations-4):
 * a school viewer can never recover a group of 1-4 families by subtracting published counts.
 */
let db: TestDb;
let schoolId: string;
let schoolViewer: string;
let owner: string;

beforeAll(async () => {
  db = await createTestDb();
  const [school] = await db.sql<{ id: string }[]>`
    insert into public.schools (name, status) values ('Aspen Elementary', 'active') returning id`;
  schoolId = school!.id;
  schoolViewer = await db.createUser();
  await db.sql`insert into public.school_admins (school_id, user_id) values (${schoolId}, ${schoolViewer})`;
  owner = await seedOwnerAdmin(db);
});

afterAll(async () => {
  await db?.drop();
});

async function family(chargedCents: number | null, month = '2026-10') {
  const fam = await seedFamily(db, { childCount: 0 });
  await db.sql`insert into public.family_school_attributions (family_id, school_id, source) values (${fam.familyId}, ${schoolId}, 'manual')`;
  await db.sql`insert into public.family_school_designations (family_id, school_id, effective_from) values (${fam.familyId}, ${schoolId}, '2026-09-01')`;
  if (chargedCents !== null) {
    await db.sql`
      insert into public.billing_periods (family_id, channel, provider_period_id, kind, period_start, period_end, paid_slots,
        regular_amount_cents, charged_amount_cents, discount_cents, discount_sources, settlement, settled_at)
      values (${fam.familyId}, 'play_store', ${'p-' + fam.familyId}, 'subscription_period', ${month + '-05T00:00:00Z'},
              ${month + '-05T00:00:00Z'}::timestamptz + interval '1 month', 1, 3999, ${chargedCents},
              ${3999 - chargedCents}, ${chargedCents < 3999 ? ['promo_code'] : []}, 'settled', now())`;
  }
}

const counts = (viewer: string, aal: 'aal1' | 'aal2') =>
  db.asParent(
    viewer,
    (tx) => tx<
      {
        active_families: string;
        positive_paying_families: string;
        fully_discounted_families: string;
      }[]
    >`
      select active_families, positive_paying_families, fully_discounted_families
        from public.school_month_report_counts(${schoolId}, '2026-10', 'UTC')`,
    { aal },
  );

describe('school report counts and suppression', () => {
  it('withholds every count from a school viewer when subtraction would reveal 1-4 families', async () => {
    for (let i = 0; i < 5; i++) await family(3999); // five full-price families
    await family(0); // one fully discounted family: active 6 - paying 5 = 1
    const [school] = await counts(schoolViewer, 'aal1');
    expect(school).toEqual({
      active_families: '<5',
      positive_paying_families: '<5',
      fully_discounted_families: '<5',
    });
    const [exact] = await counts(owner, 'aal2');
    expect(exact).toEqual({
      active_families: '6',
      positive_paying_families: '5',
      fully_discounted_families: '1',
    });
  });

  it('publishes counts once no count or difference is small', async () => {
    for (let i = 0; i < 4; i++) await family(0); // now 5 fully discounted, 5 paying, 10 active
    const [school] = await counts(schoolViewer, 'aal1');
    expect(school).toEqual({
      active_families: '10',
      positive_paying_families: '5',
      fully_discounted_families: '5',
    });
  });

  it('the signup/eligible report hides eligibility when signups minus eligible is small', async () => {
    const rows = await db.asParent(
      schoolViewer,
      (tx) => tx<
        {
          attributed_signups: string;
          donation_eligible_families: string;
          accrued_cents: string | null;
        }[]
      >`
        select attributed_signups, donation_eligible_families, accrued_cents
          from public.school_month_report(${schoolId}, '2026-10')`,
    );
    // 10 signups, 0 accruals: difference 10, nothing small -> exact values are safe to show.
    expect(rows[0]).toMatchObject({ attributed_signups: '10', donation_eligible_families: '0' });
  });

  it('a user who is not an admin of this school gets nothing', async () => {
    const stranger = await db.createUser();
    await expect(counts(stranger, 'aal2')).rejects.toThrow(/not authorized/);
  });
});
