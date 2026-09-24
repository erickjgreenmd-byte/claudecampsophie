import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { childClaims, seedFamily, seedOwnerAdmin, type SeededFamily } from './fixtures.ts';

let db: TestDb;
let famA: SeededFamily;
let famB: SeededFamily;
let adminId: string;
let schoolX: string;
let schoolY: string;
let campaignSep: string;
let campaignOct: string;
let codeSep: string;
let codeOct: string;
let seq = 0;

const LIVE_KEY = (label: string) => `idem-${label}-${(seq += 1).toString().padStart(4, '0')}`;

async function insertSchool(name: string): Promise<string> {
  const [row] = await db.sql<{ id: string }[]>`
    insert into public.schools (name, status, recipient_verified) values (${name}, 'active', true) returning id
  `;
  return row!.id;
}

async function insertCampaign(
  month: string,
  percent: number,
): Promise<{ campaign: string; code: string }> {
  const [tpl] = await db.sql<{ id: string }[]>`
    insert into public.promo_campaign_templates
      (name, percent_off, eligible_tiers, subscriber_eligibility, redemption_cap, budget_cap_cents,
       calendar_timezone, timezone_confirmed, code_mode, channels, enabled, created_by)
    values (${'Template ' + month}, ${percent}, '{1,2,3,4}', '{new,existing,lapsed}', 100, 500000,
       'UTC', true, 'shared', '{stripe,app_store,play_store}', true, ${adminId})
    returning id
  `;
  const [camp] = await db.sql<{ id: string }[]>`
    insert into public.promo_campaigns
      (template_id, campaign_month, generation_key, percent_off, eligible_tiers, subscriber_eligibility,
       redemption_cap, budget_cap_cents, opens_at, closes_at, status)
    values (${tpl!.id}, ${month}, ${tpl!.id + ':' + month}, ${percent}, '{1,2,3,4}', '{new,existing,lapsed}',
       100, 500000, ${month + '-01T00:00:00Z'}, ${month + '-28T00:00:00Z'}, 'active')
    returning id
  `;
  const code = `${month.replace('-', '').slice(2)}ABCDEF`.slice(0, 10) + 'Z';
  const [c] = await db.sql<{ id: string }[]>`
    insert into public.promo_codes (campaign_id, code_normalized) values (${camp!.id}, ${code}) returning id
  `;
  return { campaign: camp!.id, code: c!.id };
}

async function reserve(
  family: SeededFamily,
  campaign: string,
  code: string,
  periodKey: string,
  state = 'reserved',
) {
  const regular = 4998;
  const charged = 2499;
  return db.sql<{ id: string }[]>`
    insert into public.promo_redemptions
      (family_id, campaign_id, code_id, channel, target_period_key, state, idempotency_key,
       paid_slots, percent_off, regular_cents, discount_cents, charged_cents, redeemed_by, confirmed_at)
    values (${family.familyId}, ${campaign}, ${code}, 'stripe', ${periodKey}, ${state}, ${LIVE_KEY('r')},
       2, 50, ${regular}, ${regular - charged}, ${charged}, ${family.ownerId},
       ${state === 'confirmed' || state === 'reconciled' ? new Date() : null})
    returning id
  `;
}

beforeAll(async () => {
  db = await createTestDb();
  famA = await seedFamily(db, { childCount: 2 });
  famB = await seedFamily(db, { childCount: 1 });
  adminId = await seedOwnerAdmin(db);
  schoolX = await insertSchool('Maple Elementary');
  schoolY = await insertSchool('Cedar Middle');
  ({ campaign: campaignSep, code: codeSep } = await insertCampaign('2026-09', 50));
  ({ campaign: campaignOct, code: codeOct } = await insertCampaign('2026-10', 100));
});

afterAll(async () => {
  await db?.drop();
});

describe('one school per family (AC_PROMO_11)', () => {
  it('rejects overlapping designations for one family', async () => {
    await db.sql`
      insert into public.family_school_designations (family_id, school_id, effective_from)
      values (${famA.familyId}, ${schoolX}, '2026-09-01')
    `;
    await expect(
      db.sql`
        insert into public.family_school_designations (family_id, school_id, effective_from)
        values (${famA.familyId}, ${schoolY}, '2026-10-01')
      `,
    ).rejects.toThrow(/family_school_designations_no_overlap/);
  });

  it('allows a change that starts exactly when the previous designation ends', async () => {
    const fam = await seedFamily(db);
    await db.sql`
      insert into public.family_school_designations (family_id, school_id, effective_from, effective_to)
      values (${fam.familyId}, ${schoolX}, '2026-09-01', '2026-10-01')
    `;
    await db.sql`
      insert into public.family_school_designations (family_id, school_id, effective_from)
      values (${fam.familyId}, ${schoolY}, '2026-10-01')
    `;
    const rows =
      await db.sql`select school_id from public.family_school_designations where family_id = ${fam.familyId}`;
    expect(rows).toHaveLength(2);
  });

  it('requires designations to start on the first day of a month', async () => {
    const fam = await seedFamily(db);
    await expect(
      db.sql`
        insert into public.family_school_designations (family_id, school_id, effective_from)
        values (${fam.familyId}, ${schoolX}, '2026-09-15')
      `,
    ).rejects.toThrow(/check constraint/);
  });

  it('parents read their own designation but cannot write one directly', async () => {
    const rows = await db.asParent(
      famA.ownerId,
      (tx) => tx`select school_id from public.family_school_designations`,
    );
    expect(rows.map((r) => r.school_id)).toEqual([schoolX]);
    await expect(
      db.asParent(
        famA.ownerId,
        (tx) => tx`
          insert into public.family_school_designations (family_id, school_id, effective_from)
          values (${famA.familyId}, ${schoolY}, '2027-01-01')
        `,
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('redemption uniqueness (AC_PROMO_03, AC_PROMO_05)', () => {
  it('allows fresh codes in consecutive months for consecutive periods', async () => {
    const fam = await seedFamily(db);
    const [sep] = await reserve(fam, campaignSep, codeSep, '2026-09-05T00:00:00.000Z');
    await db.sql`update public.promo_redemptions set state = 'provider_pending' where id = ${sep!.id}`;
    await db.sql`update public.promo_redemptions set state = 'confirmed', confirmed_at = now() where id = ${sep!.id}`;
    const [oct] = await reserve(fam, campaignOct, codeOct, '2026-10-05T00:00:00.000Z');
    expect(oct!.id).toBeTruthy();
  });

  it('rejects a second live redemption of the same campaign by the same family', async () => {
    const fam = await seedFamily(db);
    await reserve(fam, campaignSep, codeSep, '2026-09-10T00:00:00.000Z', 'confirmed');
    await expect(reserve(fam, campaignSep, codeSep, '2026-10-10T00:00:00.000Z')).rejects.toThrow(
      /promo_redemptions_once_per_campaign/,
    );
  });

  it('rejects stacking two campaigns on one billing period', async () => {
    const fam = await seedFamily(db);
    await reserve(fam, campaignSep, codeSep, '2026-11-01T00:00:00.000Z', 'confirmed');
    await expect(reserve(fam, campaignOct, codeOct, '2026-11-01T00:00:00.000Z')).rejects.toThrow(
      /promo_redemptions_one_per_period/,
    );
  });

  it('allows retrying a campaign after the provider rejected the first attempt', async () => {
    const fam = await seedFamily(db);
    const [first] = await reserve(fam, campaignSep, codeSep, '2026-12-01T00:00:00.000Z');
    await db.sql`update public.promo_redemptions set state = 'provider_pending' where id = ${first!.id}`;
    await db.sql`update public.promo_redemptions set state = 'rejected' where id = ${first!.id}`;
    const [second] = await reserve(fam, campaignSep, codeSep, '2026-12-01T00:00:00.000Z');
    expect(second!.id).not.toBe(first!.id);
  });

  it('two concurrent reservations for the same period: exactly one wins', async () => {
    const fam = await seedFamily(db);
    const attempts = await Promise.allSettled([
      reserve(fam, campaignSep, codeSep, '2027-01-01T00:00:00.000Z'),
      reserve(fam, campaignOct, codeOct, '2027-01-01T00:00:00.000Z'),
    ]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((a) => a.status === 'rejected')).toHaveLength(1);
  });

  it('a second guardian of the same family cannot redeem the campaign again', async () => {
    const fam = await seedFamily(db);
    const guardian = await db.createUser();
    await db.sql`insert into public.family_memberships (family_id, user_id, role) values (${fam.familyId}, ${guardian}, 'guardian')`;
    await reserve(fam, campaignOct, codeOct, '2027-02-01T00:00:00.000Z', 'confirmed');
    await expect(
      db.sql`
        insert into public.promo_redemptions
          (family_id, campaign_id, code_id, channel, target_period_key, idempotency_key,
           paid_slots, percent_off, regular_cents, discount_cents, charged_cents, redeemed_by)
        values (${fam.familyId}, ${campaignOct}, ${codeOct}, 'app_store', '2027-03-01T00:00:00.000Z',
           ${LIVE_KEY('g')}, 2, 100, 4998, 4998, 0, ${guardian})
      `,
    ).rejects.toThrow(/promo_redemptions_once_per_campaign/);
  });

  it('allows only one in-flight redemption per family', async () => {
    const fam = await seedFamily(db);
    await reserve(fam, campaignSep, codeSep, '2027-04-01T00:00:00.000Z');
    await expect(reserve(fam, campaignOct, codeOct, '2027-05-01T00:00:00.000Z')).rejects.toThrow(
      /promo_redemptions_one_in_flight/,
    );
  });

  it('keeps amounts consistent: discount + charged = regular', async () => {
    const fam = await seedFamily(db);
    await expect(
      db.sql`
        insert into public.promo_redemptions
          (family_id, campaign_id, code_id, channel, target_period_key, idempotency_key,
           paid_slots, percent_off, regular_cents, discount_cents, charged_cents, redeemed_by)
        values (${fam.familyId}, ${campaignSep}, ${codeSep}, 'stripe', 'first:stripe', ${LIVE_KEY('m')},
           2, 50, 4998, 2499, 2000, ${fam.ownerId})
      `,
    ).rejects.toThrow(/check constraint/);
  });
});

describe('redemption state machine guard', () => {
  it('provider_pending can never expire (ambiguous work waits for reconciliation)', async () => {
    const fam = await seedFamily(db);
    const [r] = await reserve(fam, campaignSep, codeSep, '2027-06-01T00:00:00.000Z');
    await db.sql`update public.promo_redemptions set state = 'provider_pending' where id = ${r!.id}`;
    await expect(
      db.sql`update public.promo_redemptions set state = 'expired' where id = ${r!.id}`,
    ).rejects.toThrow(/invalid redemption transition provider_pending -> expired/);
  });

  it('confirmed amounts and identity are immutable; rows are never deleted', async () => {
    const fam = await seedFamily(db);
    const [r] = await reserve(fam, campaignSep, codeSep, '2027-07-01T00:00:00.000Z', 'confirmed');
    await expect(
      db.sql`update public.promo_redemptions set discount_cents = 0, charged_cents = 4998 where id = ${r!.id}`,
    ).rejects.toThrow(/immutable/);
    await expect(
      db.sql`update public.promo_redemptions set target_period_key = 'x' where id = ${r!.id}`,
    ).rejects.toThrow(/immutable/);
    await expect(db.sql`delete from public.promo_redemptions where id = ${r!.id}`).rejects.toThrow(
      /never deleted/,
    );
  });
});

describe('P17 access control (AC_PROMO_13)', () => {
  it('families cannot list codes, campaigns or templates (no enumeration)', async () => {
    for (const table of [
      'promo_codes',
      'promo_campaigns',
      'promo_campaign_templates',
      'provider_offer_mappings',
    ]) {
      const rows = await db.asParent(famA.ownerId, (tx) =>
        tx.unsafe(`select * from public.${table}`),
      );
      expect(rows).toHaveLength(0);
    }
  });

  it('owner admin with MFA can list campaigns; without MFA cannot', async () => {
    const withMfa = await db.asParent(adminId, (tx) => tx`select id from public.promo_campaigns`, {
      aal: 'aal2',
    });
    const withoutMfa = await db.asParent(
      adminId,
      (tx) => tx`select id from public.promo_campaigns`,
    );
    expect(withMfa.length).toBeGreaterThanOrEqual(2);
    expect(withoutMfa).toHaveLength(0);
  });

  it('a parent sees only their own family redemptions', async () => {
    await reserve(famB, campaignSep, codeSep, '2027-08-01T00:00:00.000Z', 'confirmed');
    const rows = await db.asParent(
      famA.ownerId,
      (tx) => tx`select family_id from public.promo_redemptions`,
    );
    expect(rows.every((r) => r.family_id === famA.familyId)).toBe(true);
  });

  it('parents cannot insert or modify redemptions directly', async () => {
    await expect(
      db.asParent(
        famA.ownerId,
        (tx) => tx`
          insert into public.promo_redemptions
            (family_id, campaign_id, code_id, channel, target_period_key, idempotency_key,
             paid_slots, percent_off, regular_cents, discount_cents, charged_cents, redeemed_by)
          values (${famA.familyId}, ${campaignSep}, ${codeSep}, 'stripe', 'first:stripe', 'idem-parent-direct',
             2, 50, 4998, 2499, 2499, ${famA.ownerId})
        `,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('child sessions cannot read any promotion, school or donation table', async () => {
    for (const table of [
      'promo_redemptions',
      'promo_codes',
      'schools',
      'family_school_designations',
      'donation_accruals',
      'donation_payout_batches',
    ]) {
      await expect(
        db.asChild(childClaims(famA), (tx) => tx.unsafe(`select * from public.${table}`)),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('anonymous callers cannot read schools or campaigns', async () => {
    await expect(db.asAnon((tx) => tx`select * from public.schools`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.asAnon((tx) => tx`select * from public.promo_codes`)).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('donation ledger (AC_PROMO_11, AC_PROMO_12)', () => {
  async function period(fam: SeededFamily, id: string, start: string) {
    const [row] = await db.sql<{ id: string }[]>`
      insert into public.billing_periods
        (family_id, channel, provider_period_id, kind, period_start, period_end, paid_slots,
         regular_amount_cents, charged_amount_cents, settlement, settled_at)
      values (${fam.familyId}, 'stripe', ${id}, 'subscription_period', ${start},
         ${start}::timestamptz + interval '1 month', 2, 4998, 4998, 'settled', now())
      returning id
    `;
    return row!.id;
  }

  async function accrue(fam: SeededFamily, school: string, month: string, billingPeriodId: string) {
    return db.sql<{ id: string }[]>`
      insert into public.donation_accruals (family_id, school_id, donation_month, billing_period_id, eligibility_snapshot)
      values (${fam.familyId}, ${school}, ${month}, ${billingPeriodId}, '{"rule":"full_price_settled"}')
      returning id
    `;
  }

  it('accrues exactly 100 cents and at most once per family per month, even across schools', async () => {
    const fam = await seedFamily(db);
    const p1 = await period(fam, `inv_${fam.familyId}_1`, '2026-09-01T00:00:00Z');
    const p2 = await period(fam, `inv_${fam.familyId}_2`, '2026-09-20T00:00:00Z');
    await accrue(fam, schoolX, '2026-09', p1);
    await expect(accrue(fam, schoolY, '2026-09', p2)).rejects.toThrow(
      /donation_accruals_family_id_donation_month_key/,
    );
    await expect(
      db.sql`
        insert into public.donation_accruals (family_id, school_id, donation_month, amount_cents, billing_period_id, eligibility_snapshot)
        values (${fam.familyId}, ${schoolX}, '2026-10', 200, ${p2}, '{}')
      `,
    ).rejects.toThrow(/check constraint/);
  });

  it('never accrues twice for the same billing period (webhook replay)', async () => {
    const fam = await seedFamily(db);
    const p = await period(fam, `inv_${fam.familyId}_r`, '2026-10-01T00:00:00Z');
    await accrue(fam, schoolX, '2026-10', p);
    await expect(accrue(fam, schoolX, '2026-11', p)).rejects.toThrow(/billing_period_id_key/);
  });

  it('accrual facts are immutable and never deleted; adjustments are recorded instead', async () => {
    const fam = await seedFamily(db);
    const p = await period(fam, `inv_${fam.familyId}_i`, '2026-11-01T00:00:00Z');
    const [acc] = await accrue(fam, schoolX, '2026-11', p);
    await expect(
      db.sql`update public.donation_accruals set school_id = ${schoolY} where id = ${acc!.id}`,
    ).rejects.toThrow(/immutable/);
    await expect(
      db.sql`delete from public.donation_accruals where id = ${acc!.id}`,
    ).rejects.toThrow(/never deleted/);
    await db.sql`
      insert into public.donation_adjustments (accrual_id, amount_cents, reason, idempotency_key)
      values (${acc!.id}, -100, 'refund', ${acc!.id + ':reversal'})
    `;
    await expect(
      db.sql`
        insert into public.donation_adjustments (accrual_id, amount_cents, reason, idempotency_key)
        values (${acc!.id}, -100, 'refund', ${acc!.id + ':reversal'})
      `,
    ).rejects.toThrow(/idempotency_key/);
  });

  it('a payout batch key and transfer reference can never be used twice', async () => {
    await db.sql`
      insert into public.donation_payout_batches (school_id, batch_key, total_cents, status, external_transfer_ref, paid_at)
      values (${schoolX}, 'batch-maple-2026-09', 500, 'paid', 'tr_test_1', now())
    `;
    await expect(
      db.sql`
        insert into public.donation_payout_batches (school_id, batch_key, total_cents)
        values (${schoolX}, 'batch-maple-2026-09', 500)
      `,
    ).rejects.toThrow(/batch_key/);
    await expect(
      db.sql`
        insert into public.donation_payout_batches (school_id, batch_key, total_cents, status, external_transfer_ref, paid_at)
        values (${schoolY}, 'batch-cedar-2026-09', 300, 'paid', 'tr_test_1', now())
      `,
    ).rejects.toThrow(/external_transfer_ref/);
  });

  it('a paid batch requires an external transfer reference', async () => {
    await expect(
      db.sql`
        insert into public.donation_payout_batches (school_id, batch_key, total_cents, status, paid_at)
        values (${schoolX}, 'batch-maple-missing-ref', 500, 'paid', now())
      `,
    ).rejects.toThrow(/check constraint/);
  });
});

describe('school-facing report (AC_PROMO_10, AC_PROMO_13)', () => {
  it('suppresses small cohorts for school admins, exact for owner admin, denied for others', async () => {
    const school = await insertSchool('Birch Academy');
    const schoolAdmin = await db.createUser();
    await db.sql`insert into public.school_admins (school_id, user_id) values (${school}, ${schoolAdmin})`;
    for (let i = 0; i < 2; i += 1) {
      const fam = await seedFamily(db);
      await db.sql`insert into public.family_school_attributions (family_id, school_id, source) values (${fam.familyId}, ${school}, 'school_code')`;
      const [bp] = await db.sql<{ id: string }[]>`
        insert into public.billing_periods (family_id, channel, provider_period_id, kind, period_start, period_end,
          paid_slots, regular_amount_cents, charged_amount_cents, settlement, settled_at)
        values (${fam.familyId}, 'stripe', ${'inv_birch_' + i}, 'subscription_period', '2026-09-03T00:00:00Z',
          '2026-10-03T00:00:00Z', 1, 3999, 3999, 'settled', now())
        returning id
      `;
      await db.sql`
        insert into public.donation_accruals (family_id, school_id, donation_month, billing_period_id, eligibility_snapshot)
        values (${fam.familyId}, ${school}, '2026-09', ${bp!.id}, '{}')
      `;
    }

    const schoolView = await db.asParent(
      schoolAdmin,
      (tx) => tx`select * from public.school_month_report(${school}, '2026-09')`,
    );
    expect(schoolView[0]).toMatchObject({
      attributed_signups: '<5',
      donation_eligible_families: '<5',
      accrued_cents: null,
    });
    expect(Object.keys(schoolView[0]!)).not.toContain('family_id');

    const ownerView = await db.asParent(
      adminId,
      (tx) => tx`select * from public.school_month_report(${school}, '2026-09')`,
      { aal: 'aal2' },
    );
    expect(ownerView[0]).toMatchObject({
      attributed_signups: '2',
      donation_eligible_families: '2',
    });
    expect(Number(ownerView[0]!.accrued_cents)).toBe(200);

    await expect(
      db.asParent(
        famA.ownerId,
        (tx) => tx`select * from public.school_month_report(${school}, '2026-09')`,
      ),
    ).rejects.toThrow(/not authorized/);
  });
});
