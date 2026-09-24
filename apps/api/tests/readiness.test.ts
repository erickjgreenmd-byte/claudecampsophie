import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedOwnerAdmin } from '@pencillift/db/testing/fixtures';
import {
  loadConfig,
  productionReadiness,
  type ApiConfig,
  type ReadinessItem,
} from '../src/config.ts';
import { createTestApi, json, parentToken, TEST_ENV, type TestApi } from './helpers.ts';
import { fixtureApproval, fixtureCampaign, fixtureResource } from './monetization-fixtures.ts';

/**
 * Owner readiness report (AC_DEPLOY_07, AC_RELEASE_02): it must match what the enforcing gates do
 * (RV-lead-identity-access-4) and include this month's owner-set AI spend cap (spec F4, review
 * note f). Real local Postgres; synthetic owner admin.
 */

let api: TestApi;

beforeAll(async () => {
  api = await createTestApi();
});

afterAll(async () => {
  await api?.close();
});

function config(env: Record<string, string> = {}): ApiConfig {
  const loaded = loadConfig({ ...TEST_ENV, ...env });
  if (!loaded.ok) throw new Error('config should load');
  return loaded.config;
}

const zdrStatus = (c: ApiConfig, now: Date) =>
  productionReadiness(c, { now }).find((i) => i.check === 'zdr_evidence')!.status;

describe('ZDR evidence in readiness matches the child-data gate (RV-lead-identity-access-4)', () => {
  const NOW = new Date('2026-09-24T15:00:00Z');

  it('documented evidence verified in the past is ready', () => {
    const c = config({
      ZDR_APPROVAL_EVIDENCE_REFERENCE: 'ZDR-TICKET-4471',
      ZDR_APPROVAL_VERIFIED_AT: '2026-09-01',
    });
    expect(zdrStatus(c, NOW)).toBe('ready');
  });

  it('the verification date is judged against the injected instant', () => {
    const c = config({
      ZDR_APPROVAL_EVIDENCE_REFERENCE: 'ZDR-TICKET-4471',
      ZDR_APPROVAL_VERIFIED_AT: '2026-10-01',
    });
    expect(zdrStatus(c, NOW)).toBe('blocked');
    expect(zdrStatus(c, new Date('2026-10-02T00:00:00Z'))).toBe('ready');
  });

  it('missing, short or switch-like evidence is blocked', () => {
    expect(zdrStatus(config(), NOW)).toBe('blocked');
    for (const reference of ['yes', 'TRUE', ' approved ', 'abc']) {
      const c = config({
        ZDR_APPROVAL_EVIDENCE_REFERENCE: reference,
        ZDR_APPROVAL_VERIFIED_AT: '2026-09-01',
      });
      expect({ reference, status: zdrStatus(c, NOW) }).toEqual({ reference, status: 'blocked' });
    }
  });
});

describe('this month’s AI spend cap (review note f, spec F4)', () => {
  it('readiness is blocked until the owner sets the cap for the current UTC month', async () => {
    const adminId = await seedOwnerAdmin(api.db);
    const token = await parentToken(adminId, { aal: 'aal2' });
    const budget = async () => {
      const res = await api.request('/v1/admin/readiness', { token });
      expect(res.status).toBe(200);
      const body = await json<{ checks: { check: string; status: string; detail: string }[] }>(res);
      return body.checks.find((c) => c.check === 'ai_spend_budget')!;
    };

    expect((await budget()).status).toBe('blocked');
    expect((await budget()).detail).toContain('2026-09');

    // Next month's cap alone does not cover this month.
    await api.db.sql`
      insert into public.spend_budgets (scope, period_key, budget_micros, created_by)
      values ('global', '2026-10', 50000000, ${adminId})`;
    expect((await budget()).status).toBe('blocked');

    await api.db.sql`
      insert into public.spend_budgets (scope, period_key, budget_micros, created_by)
      values ('global', '2026-09', 50000000, ${adminId})`;
    expect((await budget()).status).toBe('ready');

    // A new month without its own cap is blocked again (the owner must set it).
    api.now.value = new Date('2026-11-01T00:00:00Z');
    try {
      expect((await budget()).status).toBe('blocked');
    } finally {
      api.now.value = new Date('2026-09-24T15:00:00Z');
    }
  });

  it('without the database facts the cap is reported as blocked, never assumed', () => {
    const item = productionReadiness(config()).find((i) => i.check === 'ai_spend_budget')!;
    expect(item.status).toBe('blocked');
  });

  it('still requires an owner admin with MFA', async () => {
    const adminId = await seedOwnerAdmin(api.db);
    expect(
      (await api.request('/v1/admin/readiness', { token: await parentToken(adminId) })).status,
    ).toBe(403);
    expect((await api.request('/v1/admin/readiness')).status).toBe(401);
  });
});

/**
 * Fake catalog data (AC_DEPLOY_07; spec: "Production must reject mocked billing, consent, AI grading
 * and fake catalog data"). A live catalog row is fake when it carries the labeled-fixture convention
 * (0640 'fixture:' evidence, 'fixture.'/'fixture-' ids and keys), points at a host reserved for
 * documentation and testing, or claims availability the catalog's own link check never confirmed.
 * Sponsor cards count through their sponsor (allowed domains) and creative (destination, image
 * licence). Readiness reports them through the owner route, and a database marked production
 * refuses them (migration 0770). The mark is an owner step: until it is made, nothing but the
 * blocked `database_environment` check stands between a production Worker and a fake row it would
 * serve (docs/Deployment_Runbook.md §3.1).
 */
describe('fixture and fake catalog data (AC_DEPLOY_07)', () => {
  let cat: TestApi;
  let adminId: string;
  let token: string;

  beforeAll(async () => {
    cat = await createTestApi();
    adminId = await seedOwnerAdmin(cat.db);
    token = await parentToken(adminId, { aal: 'aal2' });
  });
  afterAll(async () => {
    await cat?.close();
  });

  async function checks(): Promise<Record<string, ReadinessItem>> {
    const res = await cat.request('/v1/admin/readiness', { token });
    expect(res.status).toBe(200);
    const body = await json<{ checks: ReadinessItem[] }>(res);
    return Object.fromEntries(body.checks.map((c) => [c.check, c]));
  }

  const otherResource = (key: string, url: string) => cat.db.sql`
    insert into public.resource_catalog
      (stable_key, title, description, subjects, grade_min, grade_max, kind, merchant, merchant_url, created_by)
    values (${key}, 'Fraction strips', 'A reviewed synthetic learning resource description.', '{math}', 3, 4,
            'manipulative', 'other', ${url}, ${adminId})`;

  /** A sponsor, one approved creative version and a campaign taken to `status`. */
  async function sponsorCampaign(
    domain: string,
    options: { licence?: string; status?: 'draft' | 'active' } = {},
  ): Promise<{ sponsorId: string; campaignId: string }> {
    const [sponsor] = await cat.db.sql<{ id: string }[]>`
      insert into public.sponsors (business_name, allowed_domains, created_by)
      values ('Cedar Reading Club', ${[domain]}, ${adminId}) returning id`;
    const [creative] = await cat.db.sql<{ id: string }[]>`
      insert into public.sponsor_creatives
        (sponsor_id, version, headline, body, cta_label, destination_url, image_asset_ref, image_license_ref,
         created_by)
      values (${sponsor!.id}, 1, 'Weekly reading club', 'Small groups for grades 2-4.', 'Learn more',
              ${`https://www.${domain}/club`}, ${options.licence ? 'sponsors/cedar/club.png' : null},
              ${options.licence ?? null}, ${adminId})
      returning id`;
    await cat.db
      .sql`update public.sponsor_creatives set review_status = 'in_review' where id = ${creative!.id}`;
    await cat.db.sql`
      update public.sponsor_creatives set review_status = 'approved', reviewed_by = ${adminId}, reviewed_at = now()
       where id = ${creative!.id}`;
    const [campaign] = await cat.db.sql<{ id: string }[]>`
      insert into public.sponsor_campaigns
        (sponsor_id, creative_id, name, placement, platforms, starts_at, ends_at, impression_cap, fee_model,
         contracted_fee_cents, created_by)
      values (${sponsor!.id}, ${creative!.id}, 'Reading club', 'resources_browse', ${['ios', 'android', 'web']},
              '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', 10000, 'fixed_fee', 50000, ${adminId})
      returning id`;
    if ((options.status ?? 'active') === 'active') {
      for (const status of ['in_review', 'scheduled', 'active']) {
        await cat.db
          .sql`update public.sponsor_campaigns set status = ${status} where id = ${campaign!.id}`;
      }
    }
    return { sponsorId: sponsor!.id, campaignId: campaign!.id };
  }

  async function offerMapping(offerId: string): Promise<void> {
    const [tpl] = await cat.db.sql<{ id: string }[]>`
      insert into public.promo_campaign_templates
        (name, percent_off, eligible_tiers, subscriber_eligibility, redemption_cap, budget_cap_cents, calendar_timezone,
         timezone_confirmed, code_mode, channels, enabled, created_by)
      values (${'Catalog ' + offerId}, 20, '{1,2,3,4}', '{new,existing,lapsed}', 100, 1000000, 'UTC', true,
              'shared', '{stripe}', true, ${adminId})
      returning id`;
    const [camp] = await cat.db.sql<{ id: string }[]>`
      insert into public.promo_campaigns (template_id, campaign_month, generation_key, percent_off, eligible_tiers,
        subscriber_eligibility, redemption_cap, budget_cap_cents, opens_at, closes_at, status)
      values (${tpl!.id}, '2026-10', ${tpl!.id + ':2026-10'}, 20, '{1,2,3,4}', '{new,existing,lapsed}', 100, 1000000,
              '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', 'active')
      returning id`;
    await cat.db.sql`
      insert into public.provider_offer_mappings (campaign_id, channel, paid_slots, provider_offer_id, status)
      values (${camp!.id}, 'stripe', 2, ${offerId}, 'ready')`;
  }

  it('readiness is blocked while any live catalog row is a labeled fixture or fake', async () => {
    const clean = await checks();
    expect(clean.catalog_data?.status).toBe('ready');

    // Reviewed, real-looking rows never block: a link-checked product, a free option, a documented
    // approval, a store product and a provider offer without the fixture label.
    await fixtureResource(cat.db, adminId, { key: 'checked-workbook', availability: 'unknown' });
    await cat.db.sql`
      update public.resource_catalog set availability = 'available', last_link_check_status = 'ok',
             last_link_check_at = now() where stable_key = 'checked-workbook'`;
    await fixtureResource(cat.db, adminId, {
      key: 'kitchen-measuring',
      kind: 'parent_exercise',
      merchant: 'none',
      availability: 'unknown',
    });
    await otherResource('strips-shop', 'https://shop.learningtools.org/strips');
    await fixtureApproval(cat.db, adminId, {
      provider: 'sponsor_direct',
      platform: 'web',
      evidence: 'Contract SD-2026-114 signed 2026-09-01',
    });
    await cat.db.sql`
      insert into public.store_product_mappings (channel, product_id, environment, paid_slots)
      values ('app_store', 'pl_family_2', 'production', 2)`;
    await offerMapping('coupon_oct_20');
    await sponsorCampaign('maple-tutoring.com');
    expect((await checks()).catalog_data?.status).toBe('ready');

    // One or more fakes of every kind.
    await fixtureResource(cat.db, adminId, {
      key: 'fixture-fraction-strips',
      kind: 'parent_exercise',
      merchant: 'none',
      availability: 'unknown',
    });
    await otherResource('strips-example', 'https://www.strips.example/buy');
    await otherResource('strips-test', 'https://shop.example.com/strips');
    // Availability claimed without a passing link check (how the API test fixtures are seeded).
    await fixtureResource(cat.db, adminId, { key: 'kitchen-fractions' });
    await fixtureApproval(cat.db, adminId, { provider: 'sponsor_direct', platform: 'ios' });
    await cat.db.sql`
      insert into public.store_product_mappings (channel, product_id, environment, paid_slots)
      values ('app_store', 'fixture.family.2', 'production', 2)`;
    await cat.db.sql`
      insert into public.store_feature_mappings (channel, product_id, environment, feature, active)
      values ('app_store', 'fixture.adfree.monthly', 'production', 'ad_free', true)`;
    await offerMapping('fixture:coupon-oct-20');
    // Sponsor cards: the API fixture campaign (sponsor and destination on a reserved host) and a
    // real-looking sponsor whose creative carries a fixture image licence.
    const fixtureSponsor = await fixtureCampaign(cat.db, adminId);
    const fixtureLicence = await sponsorCampaign('cedar-reading.com', {
      licence: 'fixture:stock-photo-licence',
    });

    const blocked = (await checks()).catalog_data!;
    expect(blocked.status).toBe('blocked');
    for (const count of [
      'resource_catalog 4',
      'monetization_approvals 1',
      'store_product_mappings 1',
      'store_feature_mappings 1',
      'provider_offer_mappings 1',
      'sponsors 1',
      'sponsor_campaigns 2',
    ]) {
      expect(blocked.detail).toContain(count);
    }

    // Rows are never deleted (audit trail): retiring, revoking and deactivating clears readiness.
    await cat.db.sql`
      update public.resource_catalog set status = 'retired'
       where stable_key in ('fixture-fraction-strips', 'strips-example', 'strips-test', 'kitchen-fractions')`;
    await cat.db.sql`
      update public.monetization_approvals set status = 'revoked', status_reason = 'test fixture'
       where evidence_ref like 'fixture:%'`;
    await cat.db
      .sql`update public.store_product_mappings set active = false where product_id like 'fixture%'`;
    await cat.db
      .sql`update public.store_feature_mappings set active = false where product_id like 'fixture%'`;
    await cat.db.sql`
      update public.provider_offer_mappings set status = 'failed', reason = 'test fixture'
       where provider_offer_id like 'fixture%'`;
    await cat.db.sql`
      update public.sponsor_campaigns set status = 'ended'
       where id in (${fixtureSponsor.campaignId}, ${fixtureLicence.campaignId})`;
    expect((await checks()).catalog_data?.detail).toContain('sponsors 1');
    await cat.db
      .sql`update public.sponsors set status = 'suspended' where id = ${fixtureSponsor.sponsorId}`;
    expect((await checks()).catalog_data?.status).toBe('ready');
  });

  it('without the database facts the catalog is reported as blocked, never assumed clean', () => {
    const items = productionReadiness(config());
    expect(items.find((i) => i.check === 'catalog_data')?.status).toBe('blocked');
    expect(items.find((i) => i.check === 'database_environment')?.status).toBe('blocked');
  });

  it('a database marked production refuses fixture and fake catalog rows', async () => {
    expect((await checks()).database_environment?.status).toBe('blocked');
    const mark = (environment: string) =>
      cat.db.sql`
        insert into private.deployment (environment) values (${environment})
        on conflict (singleton) do update set environment = excluded.environment`;

    // It cannot be marked production over live fake rows.
    await fixtureResource(cat.db, adminId, { key: 'fixture-late-arrival', status: 'draft' });
    await expect(mark('production')).rejects.toThrow(/fixture or fake catalog/);
    await cat.db
      .sql`update public.resource_catalog set status = 'retired' where stable_key = 'fixture-late-arrival'`;
    await mark('production');
    expect((await checks()).database_environment?.status).toBe('ready');
    expect((await checks()).catalog_data?.status).toBe('ready');

    // A creative or draft campaign is not live, so a fake one can be stored; it cannot go to review.
    const fixtureDraft = await sponsorCampaign('birch-books.com', {
      licence: 'fixture:stock-photo-licence',
      status: 'draft',
    });

    // The API's service role reads the mark but can never change it.
    await expect(
      cat.db.asService((tx) => tx`update private.deployment set environment = 'test'`),
    ).rejects.toThrow(/permission denied/);

    const refused = [
      () =>
        fixtureResource(cat.db, adminId, {
          key: 'fixture-new-strips',
          kind: 'parent_exercise',
          merchant: 'none',
          availability: 'unknown',
          status: 'draft',
        }),
      () => otherResource('reserved-host', 'https://strips.test/buy'),
      () => fixtureResource(cat.db, adminId, { key: 'unchecked-workbook' }),
      () =>
        cat.db
          .sql`update public.resource_catalog set status = 'draft', reviewed_by = null, reviewed_at = null
                    where stable_key = 'fixture-late-arrival'`,
      () =>
        cat.db.sql`update public.resource_catalog set availability = 'available'
                    where stable_key = 'strips-shop'`,
      () => fixtureApproval(cat.db, adminId, { provider: 'ad_network', platform: 'web' }),
      () =>
        cat.db.sql`
          insert into public.store_product_mappings (channel, product_id, environment, paid_slots)
          values ('play_store', 'fixture.family.3', 'production', 3)`,
      () =>
        cat.db
          .sql`update public.store_feature_mappings set active = true where product_id like 'fixture%'`,
      () => offerMapping('fixture:coupon-nov-20'),
      () =>
        cat.db.sql`
          insert into public.sponsors (business_name, allowed_domains, created_by)
          values ('Lab Sponsor', ${['tutoring.test']}, ${adminId})`,
      () =>
        cat.db.sql`
          update public.sponsors set allowed_domains = ${['maple-tutoring.com', 'maple.example']}
           where allowed_domains = ${['maple-tutoring.com']}`,
      () =>
        cat.db.sql`
          update public.sponsor_campaigns set status = 'in_review' where id = ${fixtureDraft.campaignId}`,
    ];
    for (const [i, attempt] of refused.entries()) {
      const outcome = await attempt().then(
        () => 'accepted',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect({ i, outcome }).toEqual({
        i,
        outcome: expect.stringMatching(/fixture or fake catalog/),
      });
    }

    // Reviewed data still flows: a new free option, a link check that confirms a product, a
    // documented approval and a real store product.
    await fixtureResource(cat.db, adminId, {
      key: 'dice-games',
      kind: 'parent_exercise',
      merchant: 'none',
      availability: 'unknown',
    });
    await cat.db.sql`
      update public.resource_catalog set availability = 'available', last_link_check_status = 'ok',
             last_link_check_at = now() where stable_key = 'strips-shop'`;
    await fixtureApproval(cat.db, adminId, {
      provider: 'ad_network',
      platform: 'web',
      evidence: 'Network agreement AN-2026-07 countersigned',
    });
    await cat.db.sql`
      insert into public.store_product_mappings (channel, product_id, environment, paid_slots)
      values ('play_store', 'pl_family_3', 'production', 3)`;
    await sponsorCampaign('oak-tutors.com');
    expect((await checks()).catalog_data?.status).toBe('ready');

    // Marked back to staging, the guard steps aside (fixtures are for development and tests).
    await mark('staging');
    expect((await checks()).database_environment?.status).toBe('blocked');
  });
});
