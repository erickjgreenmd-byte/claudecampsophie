import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedFamily, seedOwnerAdmin } from '@pencillift/db/testing/fixtures';
import { applyRefund } from '../src/services/billing-sync.ts';
import { runDonationAccrual, runGeneration } from '../src/services/p17-jobs.ts';
import { cryptoRandom } from '@pencillift/domain';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';
import { AMAZON_NO_OFFER_CODES } from '../src/services/p17-jobs.ts';

let api: TestApi;
let adminToken: string;
let adminNoMfa: string;
let parentOnly: string;

const templateInput = {
  name: 'Back to school 50%',
  schoolId: null,
  percentOff: 50,
  eligibleTiers: [1, 2, 3, 4],
  subscriberEligibility: ['new', 'existing', 'lapsed'],
  redemptionCap: 500,
  budgetCapCents: 250000,
  calendarTimezone: 'America/Chicago',
  timezoneConfirmed: false,
  windowStartDay: 1,
  windowEndDay: 'end_of_month',
  codeMode: 'shared',
  channels: ['app_store', 'play_store'],
};

beforeAll(async () => {
  api = await createTestApi({ PAYOUT_TRANSFERS_ENABLED: 'true' });
  const adminId = await seedOwnerAdmin(api.db);
  adminToken = await parentToken(adminId, { aal: 'aal2' });
  adminNoMfa = await parentToken(adminId, { aal: 'aal1' });
  const fam = await seedFamily(api.db);
  parentOnly = await parentToken(fam.ownerId, { aal: 'aal2' });
});

afterAll(async () => {
  await api?.close();
});

const adminReq = (path: string, method = 'GET', body?: unknown) =>
  api.request(`/v1/admin${path}`, {
    method,
    token: adminToken,
    ...(body === undefined ? {} : { body }),
  });

describe('owner-admin access (AC_MON_15 pattern, AC_PROMO_13)', () => {
  it('requires owner admin AND an MFA session', async () => {
    expect((await api.request('/v1/admin/promo-templates', { token: parentOnly })).status).toBe(
      403,
    );
    expect((await api.request('/v1/admin/promo-templates', { token: adminNoMfa })).status).toBe(
      403,
    );
    expect((await adminReq('/promo-templates')).status).toBe(200);
  });
});

describe('templates and monthly generation (AC_PROMO_01)', () => {
  let templateId: string;

  it('creates a disabled draft and refuses activation until the zone is confirmed', async () => {
    const created = await adminReq('/promo-templates', 'POST', templateInput);
    expect(created.status).toBe(201);
    const t = await json<{ id: string; enabled: boolean }>(created);
    templateId = t.id;
    expect(t.enabled).toBe(false);
    const refused = await json<{ ok: boolean; problems: string[] }>(
      await adminReq(`/promo-templates/${templateId}/activate`, 'POST'),
    );
    expect(refused).toEqual({ ok: false, problems: ['TIMEZONE_NOT_CONFIRMED'] });
    await adminReq(`/promo-templates/${templateId}`, 'PATCH', { timezoneConfirmed: true });
    const ok = await json<{ ok: boolean }>(
      await adminReq(`/promo-templates/${templateId}/activate`, 'POST'),
    );
    expect(ok.ok).toBe(true);
  });

  it('changing the zone of an active template demands a fresh confirmation and disables it', async () => {
    const t = await json<{ id: string }>(
      await adminReq('/promo-templates', 'POST', {
        ...templateInput,
        name: 'Zone test',
        timezoneConfirmed: true,
      }),
    );
    await adminReq(`/promo-templates/${t.id}/activate`, 'POST');
    const patched = await json<{ enabled: boolean; timezoneConfirmed: boolean }>(
      await adminReq(`/promo-templates/${t.id}`, 'PATCH', { calendarTimezone: 'America/Denver' }),
    );
    expect(patched).toMatchObject({ enabled: false, timezoneConfirmed: false });
  });

  it('previews then generates the month exactly once, even with concurrent runs', async () => {
    const preview = await json<{
      items: { templateId: string; alreadyGenerated: boolean; opensAt: string }[];
    }>(await adminReq('/promo-generation/preview?month=2026-11'));
    const mine = preview.items.find((i) => i.templateId === templateId)!;
    expect(mine.alreadyGenerated).toBe(false);
    // Chicago is UTC-5 on 1 Nov 2026 (CDT ends at 02:00 local that day): the window opens at local midnight.
    expect(mine.opensAt).toBe('2026-11-01T05:00:00.000Z');
    const [a, b] = await Promise.all([
      runGeneration(api.apiDb, '2026-11', cryptoRandom),
      runGeneration(api.apiDb, '2026-11', cryptoRandom),
    ]);
    expect(a.created.length + b.created.length).toBe(1);
    const again = await json<{ created: unknown[]; skippedExisting: string[] }>(
      await adminReq('/promo-generation/run', 'POST', { month: '2026-11' }),
    );
    expect(again.created).toHaveLength(0);
    expect(again.skippedExisting).toContain(`${templateId}:2026-11`);
    const [count] = await api.db.sql<
      { n: number }[]
    >`select count(*)::int as n from public.promo_campaigns where template_id = ${templateId} and campaign_month = '2026-11'`;
    expect(count!.n).toBe(1);
  });

  it('new campaigns start provisioning with every channel x tier pending, and become active on the first ready mapping', async () => {
    const list = await json<{
      campaigns: {
        id: string;
        templateId: string;
        status: string;
        offerMappings: { status: string }[];
      }[];
    }>(await adminReq('/campaigns?month=2026-11'));
    const campaign = list.campaigns.find((x) => x.templateId === templateId)!;
    expect(campaign.status).toBe('provisioning');
    expect(campaign.offerMappings).toHaveLength(8);
    expect(campaign.offerMappings.every((m) => m.status === 'pending')).toBe(true);
    const bad = await adminReq(`/campaigns/${campaign.id}/offer-mappings`, 'PUT', {
      channel: 'app_store',
      paidSlots: 2,
      status: 'unsupported',
      providerOfferId: null,
      reason: null,
    });
    expect(bad.status).toBe(400);
    await adminReq(`/campaigns/${campaign.id}/offer-mappings`, 'PUT', {
      channel: 'app_store',
      paidSlots: 2,
      status: 'unsupported',
      providerOfferId: null,
      reason: '50% of $49.98 is not an App Store price point',
    });
    const ready = await adminReq(`/campaigns/${campaign.id}/offer-mappings`, 'PUT', {
      channel: 'play_store',
      paidSlots: 1,
      status: 'ready',
      providerOfferId: 'pl-2026-11-50',
      reason: null,
    });
    expect(ready.status).toBe(200);
    const after = await json<{ campaigns: { id: string; status: string }[] }>(
      await adminReq('/campaigns?month=2026-11'),
    );
    expect(after.campaigns.find((x) => x.id === campaign.id)!.status).toBe('active');
  });

  it('shows formatted codes, audits the view, and pause/resume/revoke follow the allowed transitions', async () => {
    const list = await json<{ campaigns: { id: string; templateId: string }[] }>(
      await adminReq('/campaigns?month=2026-11'),
    );
    const id = list.campaigns.find((x) => x.templateId === templateId)!.id;
    const codes = await json<{ codes: { code: string }[] }>(
      await adminReq(`/campaigns/${id}/codes`),
    );
    expect(codes.codes).toHaveLength(1);
    expect(codes.codes[0]!.code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}-.$/);
    const audits = await api.db.sql`select action from public.audit_events where target_id = ${id}`;
    expect(audits.map((a) => a.action)).toContain('promo.codes_viewed');
    expect((await adminReq(`/campaigns/${id}/action`, 'POST', { action: 'resume' })).status).toBe(
      422,
    );
    expect((await adminReq(`/campaigns/${id}/action`, 'POST', { action: 'pause' })).status).toBe(
      200,
    );
    expect((await adminReq(`/campaigns/${id}/action`, 'POST', { action: 'resume' })).status).toBe(
      200,
    );
    expect((await adminReq(`/campaigns/${id}/action`, 'POST', { action: 'revoke' })).status).toBe(
      200,
    );
    const [code] = await api.db.sql<
      { status: string }[]
    >`select status from public.promo_codes where campaign_id = ${id}`;
    expect(code!.status).toBe('revoked');
  });
});

describe('donation accrual and payouts (AC_PROMO_11, AC_PROMO_12)', () => {
  let schoolId: string;
  let fullFamilyId: string;

  async function paidPeriod(
    familyId: string,
    id: string,
    start: string,
    opts: { discount?: number } = {},
  ) {
    const discount = opts.discount ?? 0;
    await api.db.sql`
      insert into public.billing_periods (family_id, channel, provider_period_id, kind, period_start, period_end, paid_slots,
        regular_amount_cents, charged_amount_cents, discount_cents, discount_sources, settlement, settled_at)
      values (${familyId}, 'play_store', ${id}, 'subscription_period', ${start}, ${start}::timestamptz + interval '1 month', 1,
        3999, ${3999 - discount}, ${discount}, ${discount > 0 ? ['promo_code'] : []}, 'settled', now())
    `;
  }

  it('accrues $1 only for full-price settled months of families with a school, and reruns are harmless', async () => {
    const created = await json<{ id: string }>(
      await adminReq('/schools', 'POST', { name: 'Willow Primary', city: 'Fresno', region: 'CA' }),
    );
    schoolId = created.id;
    await api.db
      .sql`update public.schools set status = 'active', recipient_verified = true where id = ${schoolId}`;
    const full = await seedFamily(api.db);
    fullFamilyId = full.familyId;
    const discounted = await seedFamily(api.db);
    const noSchool = await seedFamily(api.db);
    for (const f of [full, discounted]) {
      await api.db
        .sql`insert into public.family_school_designations (family_id, school_id, effective_from) values (${f.familyId}, ${schoolId}, '2026-09-01')`;
    }
    await paidPeriod(full.familyId, `gp_full_${full.familyId}`, '2026-10-03T00:00:00Z');
    await paidPeriod(
      discounted.familyId,
      `gp_disc_${discounted.familyId}`,
      '2026-10-05T00:00:00Z',
      { discount: 200 },
    );
    await paidPeriod(noSchool.familyId, `gp_none_${noSchool.familyId}`, '2026-10-07T00:00:00Z');

    const first = await runDonationAccrual(api.apiDb, '2026-10', 'UTC');
    expect(first.accrued).toBe(1);
    const second = await runDonationAccrual(api.apiDb, '2026-10', 'UTC');
    expect(second.accrued).toBe(0);
    const rows = await api.db.sql<
      { family_id: string; amount_cents: number }[]
    >`select family_id, amount_cents from public.donation_accruals where school_id = ${schoolId}`;
    expect(rows).toEqual([{ family_id: full.familyId, amount_cents: 100 }]);
  });

  it('the admin report is exact for the owner', async () => {
    const report = await json<{ donationEligibleFamilies: string; accruedCents: number }>(
      await adminReq(`/schools/${schoolId}/report?month=2026-10`),
    );
    expect(report).toMatchObject({ donationEligibleFamilies: '1', accruedCents: 100 });
  });

  it('reports active, paying and fully discounted designated families for the month (AC_PROMO_10)', async () => {
    const free = await seedFamily(api.db);
    await api.db
      .sql`insert into public.family_school_designations (family_id, school_id, effective_from) values (${free.familyId}, ${schoolId}, '2026-09-01')`;
    await paidPeriod(free.familyId, `gp_free_${free.familyId}`, '2026-10-09T00:00:00Z', {
      discount: 3999,
    });
    const report = await json<Record<string, unknown>>(
      await adminReq(`/schools/${schoolId}/report?month=2026-10`),
    );
    // full price + 200-cent discount + 100% discount (the family without a school is not counted).
    expect(report).toMatchObject({
      activeFamilies: '3',
      positivePayingFamilies: '2',
      fullyDiscountedFamilies: '1',
    });
  });

  it('prepares one idempotent batch, approves it and records the external transfer once', async () => {
    const prepared = await json<{ status: string; payout: { id: string; totalCents: number } }>(
      await adminReq('/payouts/prepare', 'POST', { schoolId, throughMonth: '2026-10' }),
    );
    expect(prepared).toMatchObject({ status: 'created', payout: { totalCents: 100 } });
    const again = await json<{ payout: { id: string } }>(
      await adminReq('/payouts/prepare', 'POST', { schoolId, throughMonth: '2026-10' }),
    );
    expect(again.payout.id).toBe(prepared.payout.id);
    expect(
      (
        await adminReq(`/payouts/${prepared.payout.id}/mark-paid`, 'POST', {
          externalTransferRef: 'ach_123',
        })
      ).status,
    ).toBe(422);
    expect((await adminReq(`/payouts/${prepared.payout.id}/approve`, 'POST')).status).toBe(200);
    const paid = await json<{ status: string; externalTransferRef: string }>(
      await adminReq(`/payouts/${prepared.payout.id}/mark-paid`, 'POST', {
        externalTransferRef: 'ach_123',
      }),
    );
    expect(paid).toMatchObject({ status: 'paid', externalTransferRef: 'ach_123' });
    expect((await adminReq(`/payouts/${prepared.payout.id}/approve`, 'POST')).status).toBe(422);
  });

  it('with nothing owed, prepare reports carried_forward and creates no batch', async () => {
    const res = await json<{ status: string }>(
      await adminReq('/payouts/prepare', 'POST', { schoolId, throughMonth: '2026-12' }),
    );
    expect(res.status).toBe('carried_forward');
  });

  it('a refund after payout lowers what is owed at once and what was paid once the next batch is paid (AC_PROMO_10, AC_PROMO_12)', async () => {
    type Report = {
      accruedCents: number | null;
      paidCents: number | null;
      activeFamilies: string;
      positivePayingFamilies: string;
      fullyDiscountedFamilies: string;
    };
    const october = async () =>
      json<Report>(await adminReq(`/schools/${schoolId}/report?month=2026-10`));
    expect(await october()).toMatchObject({
      accruedCents: 100,
      paidCents: 100,
      activeFamilies: '3',
      positivePayingFamilies: '2',
    });

    // The paid October full-price month is refunded in full.
    await api.apiDb.asService((tx) =>
      applyRefund(tx, fullFamilyId, 'play_store', `gp_full_${fullFamilyId}`, 'refund', 3999),
    );
    // Owed drops at once; the school still holds the dollar until the next payout nets it.
    // A refunded period is no longer an active or paying family.
    expect(await october()).toEqual(
      expect.objectContaining({
        accruedCents: 0,
        paidCents: 100,
        activeFamilies: '2',
        positivePayingFamilies: '1',
        fullyDiscountedFamilies: '1',
      }),
    );

    // Two full-price November months; the November payout nets October's reversal (+200 - 100).
    for (const n of [1, 2]) {
      const fam = await seedFamily(api.db);
      await api.db
        .sql`insert into public.family_school_designations (family_id, school_id, effective_from) values (${fam.familyId}, ${schoolId}, '2026-09-01')`;
      await paidPeriod(fam.familyId, `gp_nov_${n}_${fam.familyId}`, '2026-11-04T00:00:00Z');
    }
    expect((await runDonationAccrual(api.apiDb, '2026-11', 'UTC')).accrued).toBe(2);
    const november = await json<{ status: string; payout: { id: string; totalCents: number } }>(
      await adminReq('/payouts/prepare', 'POST', { schoolId, throughMonth: '2026-11' }),
    );
    expect(november).toMatchObject({ status: 'created', payout: { totalCents: 100 } });
    expect((await adminReq(`/payouts/${november.payout.id}/approve`, 'POST')).status).toBe(200);
    expect(await october()).toMatchObject({ accruedCents: 0, paidCents: 100 });
    expect(
      (
        await adminReq(`/payouts/${november.payout.id}/mark-paid`, 'POST', {
          externalTransferRef: 'ach_456',
        })
      ).status,
    ).toBe(200);

    expect(await october()).toMatchObject({ accruedCents: 0, paidCents: 0 });
    expect(
      await json<Report>(await adminReq(`/schools/${schoolId}/report?month=2026-11`)),
    ).toMatchObject({ accruedCents: 200, paidCents: 200 });
  });
});

describe('transfers disabled by default', () => {
  it('prepare and mark-paid are blocked when payout transfers are not enabled', async () => {
    const plain = await createTestApi();
    try {
      const adminId = await seedOwnerAdmin(plain.db);
      const token = await parentToken(adminId, { aal: 'aal2' });
      const [school] = await plain.db.sql<
        { id: string }[]
      >`insert into public.schools (name, status, recipient_verified) values ('Oak', 'active', true) returning id`;
      const fam = await seedFamily(plain.db);
      await plain.db
        .sql`insert into public.family_school_designations (family_id, school_id, effective_from) values (${fam.familyId}, ${school!.id}, '2026-09-01')`;
      await plain.db.sql`
        insert into public.billing_periods (family_id, channel, provider_period_id, kind, period_start, period_end, paid_slots,
          regular_amount_cents, charged_amount_cents, settlement, settled_at)
        values (${fam.familyId}, 'app_store', 'tx_oak_1', 'subscription_period', '2026-10-02T00:00:00Z', '2026-11-02T00:00:00Z', 1, 3999, 3999, 'settled', now())
      `;
      await runDonationAccrual(plain.apiDb, '2026-10', 'UTC');
      const res = await plain.request('/v1/admin/payouts/prepare', {
        method: 'POST',
        token,
        body: { schoolId: school!.id, throughMonth: '2026-10' },
      });
      expect(res.status).toBe(503);
      expect((await json<{ error: { rule: string } }>(res)).error.rule).toBe('TRANSFERS_DISABLED');
    } finally {
      await plain.close();
    }
  });
});

describe('school verification (P17 onboarding)', () => {
  it('a new school is hidden from parents until the owner verifies it; changes are audited', async () => {
    const created = await json<{ id: string; status: string }>(
      await adminReq('/schools', 'POST', { name: 'Birch Academy', city: null, region: null }),
    );
    expect(created.status).toBe('pending_verification');
    const listed = async () =>
      (
        await json<{ schools: { id: string }[] }>(
          await api.request('/v1/schools?query=Birch', { token: parentOnly }),
        )
      ).schools.map((s) => s.id);
    expect(await listed()).not.toContain(created.id);

    expect(
      (
        await api.request(`/v1/admin/schools/${created.id}`, {
          method: 'PATCH',
          token: adminNoMfa,
          body: { status: 'active', verificationNote: 'district listing checked' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await adminReq(`/schools/${created.id}`, 'PATCH', { verificationNote: 'nothing' })).status,
    ).toBe(400);
    const updated = await adminReq(`/schools/${created.id}`, 'PATCH', {
      status: 'active',
      recipientVerified: true,
      verificationNote: 'district listing and W-9 checked (owner files)',
    });
    expect(updated.status).toBe(200);
    expect(await json(updated)).toMatchObject({ status: 'active', recipientVerified: true });
    expect(await listed()).toContain(created.id);
    const [audit] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events where action = 'school.updated' and target_id = ${created.id}`;
    expect(audit!.n).toBe(1);
  });
});

describe('Amazon Appstore campaigns (Fire tablets; the store has no offer codes)', () => {
  it('generates Amazon mappings as unsupported with the reason, while the other stores start pending', async () => {
    const t = await json<{ id: string }>(
      await adminReq('/promo-templates', 'POST', {
        ...templateInput,
        name: 'Amazon test',
        timezoneConfirmed: true,
        channels: ['app_store', 'amazon_appstore'],
      }),
    );
    expect(
      (await json<{ ok: boolean }>(await adminReq(`/promo-templates/${t.id}/activate`, 'POST'))).ok,
    ).toBe(true);
    await runGeneration(api.apiDb, '2026-12', cryptoRandom);
    const list = await json<{
      campaigns: {
        templateId: string;
        offerMappings: { channel: string; status: string; reason: string | null }[];
      }[];
    }>(await adminReq('/campaigns?month=2026-12'));
    const campaign = list.campaigns.find((x) => x.templateId === t.id)!;
    const amazon = campaign.offerMappings.filter((m) => m.channel === 'amazon_appstore');
    const appStore = campaign.offerMappings.filter((m) => m.channel === 'app_store');
    expect(amazon.length).toBeGreaterThan(0);
    expect(
      amazon.every((m) => m.status === 'unsupported' && m.reason === AMAZON_NO_OFFER_CODES),
    ).toBe(true);
    expect(appStore.every((m) => m.status === 'pending' && m.reason === null)).toBe(true);
  });
});
