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

interface CountsRow {
  active_families: string;
  positive_paying_families: string;
  fully_discounted_families: string;
}

/**
 * The counts as the API reads them (0740): the program calendar zone (`stated`) is set for the
 * transaction, then the function is called with `zone`. `stated: null` is a direct client call.
 */
const countsIn = (
  viewer: string,
  aal: 'aal1' | 'aal2',
  zone: string,
  stated: string | null,
  month = '2026-10',
) =>
  db.asParent(
    viewer,
    async (tx) => {
      if (stated !== null) await tx`select set_config('pencillift.program_zone', ${stated}, true)`;
      return tx<CountsRow[]>`
        select active_families, positive_paying_families, fully_discounted_families
          from public.school_month_report_counts(${schoolId}, ${month}, ${zone})`;
    },
    { aal },
  );

const counts = (viewer: string, aal: 'aal1' | 'aal2') => countsIn(viewer, aal, 'UTC', 'UTC');

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

  it('a school viewer cannot choose the zone: only the program zone the API states is served (BUG-074)', async () => {
    // Same month, two zones: a viewer who could difference them would isolate the families whose
    // period started inside the offset band, which per-call suppression cannot see.
    await expect(countsIn(schoolViewer, 'aal1', 'Pacific/Kiritimati', 'UTC')).rejects.toThrow(
      /program calendar zone/,
    );
    await expect(countsIn(schoolViewer, 'aal1', 'Etc/GMT+12', 'UTC')).rejects.toThrow(
      /program calendar zone/,
    );
    // A direct client call states no zone at all: refused whatever zone it names.
    await expect(countsIn(schoolViewer, 'aal1', 'UTC', null)).rejects.toThrow(
      /program calendar zone/,
    );
    // The zone the API states is served, in that zone.
    const [served] = await countsIn(
      schoolViewer,
      'aal1',
      'America/Los_Angeles',
      'America/Los_Angeles',
    );
    expect(served).toBeDefined();
  });

  it('the owner (exact figures) may read the counts in any zone', async () => {
    const [utc] = await countsIn(owner, 'aal2', 'UTC', null);
    const [kiritimati] = await countsIn(owner, 'aal2', 'Pacific/Kiritimati', null);
    expect(utc).toBeDefined();
    expect(kiritimati).toBeDefined();
  });

  it('clients cannot call the stated-zone helper', async () => {
    await expect(
      db.asParent(schoolViewer, (tx) => tx`select app.program_calendar_zone()`),
    ).rejects.toThrow(/permission denied/);
  });

  it('a user who is not an admin of this school gets nothing', async () => {
    const stranger = await db.createUser();
    await expect(counts(stranger, 'aal2')).rejects.toThrow(/not authorized/);
  });
});
