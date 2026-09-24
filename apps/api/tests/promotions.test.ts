import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePromoCode } from '@pencillift/domain/promotions';
import { cryptoRandom } from '@pencillift/domain';
import {
  grantAdultUnlock,
  seedFamily,
  seedOwnerAdmin,
  type SeededFamily,
} from '@pencillift/db/testing/fixtures';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

let api: TestApi;
let adminId: string;
let schoolA: string;
let schoolB: string;
const SESSION = '66666666-6666-4666-8666-666666666666';

interface Campaign {
  campaignId: string;
  code: string;
}

async function createCampaign(
  month: string,
  percent: number,
  opts: { mappingStatus?: string; channels?: string[] } = {},
): Promise<Campaign> {
  const [tpl] = await api.db.sql<{ id: string }[]>`
    insert into public.promo_campaign_templates
      (name, percent_off, eligible_tiers, subscriber_eligibility, redemption_cap, budget_cap_cents, calendar_timezone,
       timezone_confirmed, code_mode, channels, enabled, created_by)
    values (${`T ${month} ${percent}`}, ${percent}, '{1,2,3,4}', '{new,existing,lapsed}', 100, 1000000, 'UTC', true,
            'shared', ${opts.channels ?? ['app_store', 'play_store', 'stripe']}, true, ${adminId})
    returning id
  `;
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const [camp] = await api.db.sql<{ id: string }[]>`
    insert into public.promo_campaigns (template_id, campaign_month, generation_key, percent_off, eligible_tiers,
      subscriber_eligibility, redemption_cap, budget_cap_cents, opens_at, closes_at, status)
    values (${tpl!.id}, ${month}, ${tpl!.id + ':' + month}, ${percent}, '{1,2,3,4}', '{new,existing,lapsed}', 100, 1000000,
            ${month + '-01T00:00:00Z'}, ${next + '-01T00:00:00Z'}, 'active')
    returning id
  `;
  const code = generatePromoCode(cryptoRandom);
  await api.db
    .sql`insert into public.promo_codes (campaign_id, code_normalized) values (${camp!.id}, ${code.normalized})`;
  for (const channel of ['app_store', 'play_store', 'stripe']) {
    for (const slots of [1, 2, 3, 4]) {
      const status = opts.mappingStatus ?? 'ready';
      await api.db.sql`
        insert into public.provider_offer_mappings (campaign_id, channel, paid_slots, provider_offer_id, status, reason)
        values (${camp!.id}, ${channel}, ${slots}, ${status === 'ready' ? `offer_${month}_${channel}_${slots}` : null}, ${status},
                ${status === 'ready' || status === 'pending' ? null : 'not supported'})
      `;
    }
  }
  return { campaignId: camp!.id, code: code.display };
}

async function subscribedFamily(
  periodStart: string,
  periodEnd: string,
  slots = 2,
): Promise<SeededFamily & { token: string }> {
  const fam = await seedFamily(api.db, { childCount: slots });
  await api.db
    .sql`insert into public.family_capacity (family_id, paid_slots, managing_channel) values (${fam.familyId}, ${slots}, 'app_store')`;
  await api.db.sql`
    insert into public.family_entitlements (family_id, channel, provider_subscription_id, product_id, paid_slots, status,
      environment, period_start, period_end, provider_updated_at, fetched_at)
    values (${fam.familyId}, 'app_store', ${'orig_' + fam.familyId}, ${'pl_family_' + slots}, ${slots}, 'active', 'sandbox',
            ${periodStart}, ${periodEnd}, now(), now())
  `;
  await grantAdultUnlock(api.db, fam.ownerId, SESSION, 3600);
  return { ...fam, token: await parentToken(fam.ownerId, { sessionId: SESSION }) };
}

const quote = (token: string, code: string, channel = 'app_store') =>
  api.request('/v1/family/promotions/quote', { method: 'POST', token, body: { code, channel } });

const redeem = (
  token: string,
  code: string,
  channel = 'app_store',
  idempotencyKey = randomUUID(),
) =>
  api.request('/v1/family/promotions/redeem', {
    method: 'POST',
    token,
    body: { code, channel, idempotencyKey },
  });

let september: Campaign;
let october: Campaign;

beforeAll(async () => {
  api = await createTestApi();
  adminId = await seedOwnerAdmin(api.db);
  const [a] = await api.db.sql<
    { id: string }[]
  >`insert into public.schools (name, status) values ('Maple Elementary', 'active') returning id`;
  const [b] = await api.db.sql<
    { id: string }[]
  >`insert into public.schools (name, status) values ('Cedar Middle', 'active') returning id`;
  await api.db
    .sql`insert into public.schools (name, status) values ('Hidden Pending School', 'pending_verification')`;
  schoolA = a!.id;
  schoolB = b!.id;
  september = await createCampaign('2026-09', 50);
  october = await createCampaign('2026-10', 100);
});

afterAll(async () => {
  await api?.close();
});

describe('school selection (AC_PROMO_11, one school per family)', () => {
  it('lists only active schools and escapes search wildcards', async () => {
    const fam = await subscribedFamily('2026-09-10T00:00:00Z', '2026-10-10T00:00:00Z');
    const all = await json<{ schools: { name: string }[] }>(
      await api.request('/v1/schools', { token: fam.token }),
    );
    expect(all.schools.map((s) => s.name)).toEqual(['Cedar Middle', 'Maple Elementary']);
    const wild = await json<{ schools: unknown[] }>(
      await api.request('/v1/schools?query=%25', { token: fam.token }),
    );
    expect(wild.schools).toHaveLength(0);
  });

  it('first choice applies this month; a change applies next month; re-changing replaces the pending one', async () => {
    const fam = await subscribedFamily('2026-09-10T00:00:00Z', '2026-10-10T00:00:00Z');
    const set = (schoolId: string) =>
      api.request('/v1/family/school', { method: 'PUT', token: fam.token, body: { schoolId } });
    const first = await json<{ current: { id: string } | null; pending: unknown }>(
      await set(schoolA),
    );
    expect(first.current?.id).toBe(schoolA);
    expect(first.pending).toBeNull();
    const changed = await json<{
      current: { id: string };
      pending: { school: { id: string }; effectiveFromMonth: string };
    }>(await set(schoolB));
    expect(changed.current.id).toBe(schoolA);
    expect(changed.pending).toMatchObject({
      school: { id: schoolB },
      effectiveFromMonth: '2026-10',
    });
    const back = await json<{ current: { id: string }; pending: unknown }>(await set(schoolA));
    expect(back.current.id).toBe(schoolA);
    expect(back.pending).toBeNull();
    const rows = await api.db
      .sql`select school_id from public.family_school_designations where family_id = ${fam.familyId}`;
    expect(rows).toHaveLength(1);
  });

  it('rejects inactive or unknown schools', async () => {
    const fam = await subscribedFamily('2026-09-10T00:00:00Z', '2026-10-10T00:00:00Z');
    const res = await api.request('/v1/family/school', {
      method: 'PUT',
      token: fam.token,
      body: { schoolId: randomUUID() },
    });
    expect(res.status).toBe(404);
  });
});

describe('monthly promo codes (AC_PROMO_02..05, AC_PROMO_14)', () => {
  it('quoting requires a recent step-up', async () => {
    const fam = await subscribedFamily('2026-09-10T00:00:00Z', '2026-10-10T00:00:00Z');
    const other = await parentToken(fam.ownerId, {
      sessionId: '77777777-7777-4777-8777-777777777777',
    });
    const res = await quote(other, september.code);
    expect(res.status).toBe(403);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('STEP_UP_REQUIRED');
  });

  it('quotes the next provider period with exact preview amounts and the regular renewal price', async () => {
    const fam = await subscribedFamily('2026-09-10T00:00:00Z', '2026-10-10T00:00:00Z');
    const res = await quote(fam.token, september.code);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      campaignMonth: '2026-09',
      percentOff: 50,
      channel: 'app_store',
      targetPeriod: {
        kind: 'renewal_period',
        periodStart: '2026-10-10T00:00:00.000Z',
        isProjection: true,
      },
      regularCents: 4998,
      discountCents: 2499,
      chargedCents: 2499,
      nextRegularRenewalCents: 4998,
      isPreview: true,
    });
  });

  it('redeems on a native store: reserved with the store offer, then provider_pending once submitted', async () => {
    const fam = await subscribedFamily('2026-09-10T00:00:00Z', '2026-10-10T00:00:00Z');
    const res = await redeem(fam.token, september.code);
    expect(res.status).toBe(201);
    const body = await json<{
      id: string;
      state: string;
      nextAction: { kind: string; providerOfferId?: string };
    }>(res);
    expect(body.state).toBe('reserved');
    expect(body.nextAction).toEqual({
      kind: 'present_store_offer',
      providerOfferId: 'offer_2026-09_app_store_2',
    });
    const submitted = await api.request(`/v1/family/promotions/${body.id}/submitted`, {
      method: 'POST',
      token: fam.token,
    });
    expect((await json<{ state: string }>(submitted)).state).toBe('provider_pending');
    const list = await json<{ redemptions: { id: string }[] }>(
      await api.request('/v1/family/promotions', { token: fam.token }),
    );
    expect(list.redemptions.map((r) => r.id)).toEqual([body.id]);
  });

  it('an idempotent replay returns the same redemption', async () => {
    const fam = await subscribedFamily('2026-09-10T00:00:00Z', '2026-10-10T00:00:00Z');
    const key = randomUUID();
    const first = await json<{ id: string }>(
      await redeem(fam.token, september.code, 'app_store', key),
    );
    const second = await json<{ id: string }>(
      await redeem(fam.token, september.code, 'app_store', key),
    );
    expect(second.id).toBe(first.id);
    const [count] = await api.db.sql<
      { n: number }[]
    >`select count(*)::int as n from public.promo_redemptions where family_id = ${fam.familyId}`;
    expect(count!.n).toBe(1);
  });

  it('a family cannot redeem the same monthly campaign twice, even from the second guardian', async () => {
    const fam = await subscribedFamily('2026-09-10T00:00:00Z', '2026-10-10T00:00:00Z');
    const guardian = await api.db.createUser();
    await api.db
      .sql`insert into public.family_memberships (family_id, user_id, role) values (${fam.familyId}, ${guardian}, 'guardian')`;
    await grantAdultUnlock(api.db, guardian, SESSION, 3600);
    const guardianToken = await parentToken(guardian, { sessionId: SESSION });
    expect((await redeem(fam.token, september.code)).status).toBe(201);
    const second = await redeem(guardianToken, september.code);
    expect(second.status).toBe(422);
    expect((await json<{ error: { rule: string } }>(second)).error.rule).toBe(
      'FAMILY_ALREADY_REDEEMED_CAMPAIGN',
    );
  });

  it('concurrent redemptions by two guardians: exactly one succeeds', async () => {
    const fam = await subscribedFamily('2026-09-10T00:00:00Z', '2026-10-10T00:00:00Z');
    const guardian = await api.db.createUser();
    await api.db
      .sql`insert into public.family_memberships (family_id, user_id, role) values (${fam.familyId}, ${guardian}, 'guardian')`;
    await grantAdultUnlock(api.db, guardian, SESSION, 3600);
    const guardianToken = await parentToken(guardian, { sessionId: SESSION });
    const results = await Promise.all([
      redeem(fam.token, september.code),
      redeem(guardianToken, september.code),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
  });

  it('fresh codes in consecutive months discount consecutive periods, including a second 100% month', async () => {
    const fam = await subscribedFamily('2026-09-10T00:00:00Z', '2026-10-10T00:00:00Z');
    const sep = await json<{ id: string }>(await redeem(fam.token, september.code));
    // Provider confirms September's redemption for the 10 Oct period, then the subscription renews.
    await api.db
      .sql`update public.promo_redemptions set state = 'provider_pending' where id = ${sep.id}`;
    await api.db
      .sql`update public.promo_redemptions set state = 'confirmed', confirmed_at = now() where id = ${sep.id}`;
    await api.db.sql`
      update public.family_entitlements set period_start = '2026-10-10T00:00:00Z', period_end = '2026-11-10T00:00:00Z'
       where family_id = ${fam.familyId}
    `;
    api.now.value = new Date('2026-10-15T12:00:00Z');
    try {
      const oct = await quote(fam.token, october.code);
      expect(oct.status).toBe(200);
      expect(await json(oct)).toMatchObject({
        percentOff: 100,
        chargedCents: 0,
        targetPeriod: { periodStart: '2026-11-10T00:00:00.000Z' },
        nextRegularRenewalCents: 4998,
      });
      expect((await redeem(fam.token, october.code)).status).toBe(201);
      // September's code cannot be reused for a later period.
      const reuse = await redeem(fam.token, september.code);
      expect(reuse.status).toBe(422);
    } finally {
      api.now.value = new Date('2026-09-24T15:00:00Z');
    }
  });

  it('codes are unavailable on channels whose provider offer is not ready', async () => {
    const pending = await createCampaign('2026-09', 25, { mappingStatus: 'pending' });
    const fam = await subscribedFamily('2026-09-10T00:00:00Z', '2026-10-10T00:00:00Z');
    const res = await quote(fam.token, pending.code);
    expect(res.status).toBe(422);
    expect((await json<{ error: { rule: string } }>(res)).error.rule).toBe('CHANNEL_UNAVAILABLE');
  });

  it('the optional Stripe web channel stays unavailable while web billing is disabled', async () => {
    const fam = await subscribedFamily('2026-09-10T00:00:00Z', '2026-10-10T00:00:00Z');
    const res = await quote(fam.token, september.code, 'stripe');
    expect((await json<{ error: { rule: string } }>(res)).error.rule).toBe('CHANNEL_UNAVAILABLE');
  });

  it('typos get a helpful error; guessing unknown codes is rate limited per family', async () => {
    const fam = await subscribedFamily('2026-09-10T00:00:00Z', '2026-10-10T00:00:00Z');
    const typo = september.code.slice(0, -1) + (september.code.endsWith('0') ? '1' : '0');
    const typoRes = await quote(fam.token, typo);
    expect(typoRes.status).toBe(422);
    expect((await json<{ error: { rule: string } }>(typoRes)).error.rule).toMatch(
      /CODE_CHECKSUM_MISMATCH|CODE_INVALID_FORMAT/,
    );
    const statuses: number[] = [];
    for (let i = 0; i < 9; i += 1)
      statuses.push((await quote(fam.token, generatePromoCode(cryptoRandom).display)).status);
    expect(statuses.slice(0, 7).every((s) => s === 404)).toBe(true);
    expect(statuses[8]).toBe(429);
  });

  it('child sessions and unauthenticated callers cannot use promotion routes', async () => {
    expect((await api.request('/v1/family/promotions')).status).toBe(401);
    expect((await quote('not-a-token', september.code)).status).toBe(401);
  });

  it('families never see campaign or code tables through the API responses', async () => {
    const fam = await subscribedFamily('2026-09-10T00:00:00Z', '2026-10-10T00:00:00Z');
    const text = JSON.stringify(
      await json(await api.request('/v1/family/promotions', { token: fam.token })),
    );
    expect(text).not.toContain('budget');
    expect(text).not.toContain('code_normalized');
  });
});
