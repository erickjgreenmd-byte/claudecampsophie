import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  outboundUrlResponseSchema,
  placementClickResponseSchema,
  placementResponseSchema,
  resourcesResponseSchema,
} from '@pencillift/contracts';
import {
  grantAdultUnlock,
  seedFamily,
  seedOwnerAdmin,
  type SeededFamily,
} from '@pencillift/db/testing/fixtures';
import { issueChildAccessToken } from '../src/auth/child.ts';
import { purgeExpiredServes } from '../src/services/monetization-retention.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';
import {
  WEB_PROPERTY,
  fixtureApproval,
  fixtureCampaign,
  fixtureResource,
  nonCommercialLedgerCounts,
  setSwitches,
  type SponsorFixture,
} from './monetization-fixtures.ts';

// Parent-facing P16 routes (AC_MON_02..AC_MON_16). Synthetic families; labeled fixture approvals.
let api: TestApi;
let fam: SeededFamily;
let adminId: string;
let adminToken: string;
let childToken: string;
let campaignA: SponsorFixture;
let campaignB: SponsorFixture;
let campaignDash: SponsorFixture;
let sponsorApprovalIos: string;
let sessionSeq = 0;
const BASE_NOW = new Date('2026-09-24T15:00:00Z');

type ErrorBody = { error: { code: string; rule?: string } };

function newSessionId(): string {
  sessionSeq += 1;
  return `5e55${sessionSeq.toString(16).padStart(4, '0')}-0000-4000-8000-000000000000`;
}

async function unlocked(family: SeededFamily, sessionId = newSessionId()): Promise<string> {
  await grantAdultUnlock(api.db, family.ownerId, sessionId, 3600);
  return parentToken(family.ownerId, { sessionId });
}

const placement = (token: string, query = 'placement=resources_browse&platform=ios') =>
  api.request(`/v1/placements?${query}`, { token });

async function serve(token: string, query?: string) {
  const res = await placement(token, query);
  expect(res.status).toBe(200);
  return placementResponseSchema.parse(await res.json());
}

const post = (path: string, token: string, body?: unknown) =>
  api.request(path, { method: 'POST', token, ...(body === undefined ? {} : { body }) });

async function counter(campaignId: string, kind: string): Promise<number> {
  const [row] = await api.db.sql<{ n: number }[]>`
    select coalesce(sum(count), 0)::int as n from public.aggregate_ad_events where campaign_id = ${campaignId} and kind = ${kind}
  `;
  return row!.n;
}

beforeAll(async () => {
  api = await createTestApi();
  fam = await seedFamily(api.db, { childCount: 1 });
  adminId = await seedOwnerAdmin(api.db);
  adminToken = await parentToken(adminId, { aal: 'aal2' });
  const child = fam.children[0]!;
  childToken = (
    await issueChildAccessToken(
      api.config,
      { kind: 'child', childId: child.id, familyId: fam.familyId, sessionId: child.sessionId },
      api.now.value,
    )
  ).token;
  await setSwitches(api.db, { global: true, sponsor_direct: true });
  sponsorApprovalIos = await fixtureApproval(api.db, adminId, {
    provider: 'sponsor_direct',
    platform: 'ios',
  });
  await fixtureApproval(api.db, adminId, { provider: 'sponsor_direct', platform: 'web' });
  campaignA = await fixtureCampaign(api.db, adminId, { name: 'Maple Tutoring' });
  campaignB = await fixtureCampaign(api.db, adminId, {
    name: 'Cedar Books',
    domain: 'books.example',
  });
  campaignDash = await fixtureCampaign(api.db, adminId, {
    name: 'Birch Learning',
    domain: 'birch.example',
    placement: 'adult_dashboard',
  });
});

afterAll(async () => {
  await api?.close();
});

describe('only a recently unlocked adult receives commercial content (AC_MON_02, AC_MON_03)', () => {
  const commercialPaths = [
    '/v1/placements?placement=resources_browse&platform=ios',
    '/v1/resources?platform=ios',
    '/v1/monetization/preferences',
  ];

  it('child tokens, unknown roles and anonymous callers get 401 and no commercial DTO', async () => {
    const unknownRole = await parentToken(fam.ownerId, { role: 'service_role' });
    const anonRole = await parentToken(fam.ownerId, { role: 'anon' });
    for (const path of commercialPaths) {
      for (const token of [childToken, unknownRole, anonRole, undefined]) {
        const res = await api.request(path, token === undefined ? {} : { token });
        expect(res.status).toBe(401);
        const body = await json<Record<string, unknown>>(res);
        expect(Object.keys(body)).toEqual(['error']);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      }
    }
    const click = await post('/v1/placements/' + 'A'.repeat(43) + '/click', childToken);
    expect(click.status).toBe(401);
  });

  it('a signed-in parent without a server-verified unlock is refused (spoofed role / direct URL)', async () => {
    const token = await parentToken(fam.ownerId, { sessionId: newSessionId() });
    for (const path of commercialPaths) {
      const res = await api.request(path, { token });
      expect(res.status).toBe(403);
      expect((await json<ErrorBody>(res)).error.code).toBe('STEP_UP_REQUIRED');
    }
  });

  it('an expired unlock fails', async () => {
    const sessionId = newSessionId();
    await api.db.sql`
      insert into private.adult_unlocks (user_id, auth_session_id, method, created_at, expires_at)
      values (${fam.ownerId}, ${sessionId}, 'pin', now() - interval '20 minutes', now() - interval '10 minutes')
    `;
    const res = await placement(await parentToken(fam.ownerId, { sessionId }));
    expect(res.status).toBe(403);
  });

  it('an unlock is bound to its auth session and relocking (switch to child mode) removes access', async () => {
    const sessionId = newSessionId();
    const token = await unlocked(fam, sessionId);
    expect((await serve(token)).card).not.toBeNull();
    // The same user's other session (another device) has no unlock.
    expect(
      (await placement(await parentToken(fam.ownerId, { sessionId: newSessionId() }))).status,
    ).toBe(403);
    expect((await post('/v1/adult/lock', token)).status).toBe(200);
    const after = await placement(token);
    expect(after.status).toBe(403);
    expect(Object.keys(await json<Record<string, unknown>>(after))).toEqual(['error']);
  });

  it('serves a labeled, disclosed card with no campaign economics or identifiers', async () => {
    const res = await placement(await unlocked(fam));
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const body = placementResponseSchema.parse(await res.json());
    expect(body.reason).toBe('served');
    // Either resources campaign may win the (deterministic, id-ordered) tie; both are disclosed.
    const expected = {
      'Sponsored by Maple Tutoring': 'www.tutoring.example',
      'Sponsored by Cedar Books': 'www.books.example',
    } as Record<string, string>;
    expect(Object.keys(expected)).toContain(body.card!.label);
    expect(body.card).toMatchObject({
      whyShown: 'Shown in the parent resource directory.',
      destinationHost: expected[body.card!.label],
      imageAssetRef: null,
    });
    const text = JSON.stringify(body);
    for (const id of [
      fam.familyId,
      fam.ownerId,
      fam.children[0]!.id,
      campaignA.campaignId,
      campaignB.campaignId,
    ]) {
      expect(text).not.toContain(id);
    }
    const dash = await serve(await unlocked(fam), 'placement=adult_dashboard&platform=ios');
    expect(dash.card).toMatchObject({
      label: 'Sponsored by Birch Learning',
      whyShown: 'Shown on the parent dashboard.',
    });
    expect(JSON.stringify(dash)).not.toContain(campaignDash.campaignId);
  });

  it('rejects unknown placements (no ads in child mode, login, homework, practice or rewards)', async () => {
    const token = await unlocked(fam);
    for (const bad of ['child_home', 'practice', 'rewards', 'login']) {
      const res = await placement(token, `placement=${bad}&platform=ios`);
      expect(res.status).toBe(400);
    }
  });
});

describe('one card per screen, three new cards per session, dismiss and report (AC_MON_05)', () => {
  it('serves at most one card per request and at most three per session', async () => {
    const token = await unlocked(fam);
    const cards = [];
    for (let i = 0; i < 3; i += 1) cards.push(await serve(token));
    expect(cards.every((c) => c.card !== null && !Array.isArray(c.card))).toBe(true);
    // Unseen campaigns rotate first.
    expect(new Set(cards.slice(0, 2).map((c) => c.card!.label)).size).toBe(2);
    const fourth = await serve(token);
    expect(fourth).toEqual({ card: null, reason: 'session_cap' });
    // Dashboard shares the same per-session budget.
    expect(await serve(token, 'placement=adult_dashboard&platform=ios')).toEqual({
      card: null,
      reason: 'session_cap',
    });
    // A new session gets a fresh budget.
    expect((await serve(await unlocked(fam))).card).not.toBeNull();
  });

  it('parallel requests cannot exceed the session cap', async () => {
    const token = await unlocked(fam);
    const results = await Promise.all(Array.from({ length: 6 }, () => serve(token)));
    expect(results.filter((r) => r.card !== null)).toHaveLength(3);
  });

  it('dismiss hides the campaign for the session and never navigates', async () => {
    const token = await unlocked(fam);
    const first = await serve(token);
    const dismissed = await post(`/v1/placements/${first.card!.serveToken}/dismiss`, token);
    expect(dismissed.status).toBe(204);
    expect(dismissed.headers.get('location')).toBeNull();
    expect(await dismissed.text()).toBe('');
    const again = await post(`/v1/placements/${first.card!.serveToken}/dismiss`, token);
    expect(again.status).toBe(204);
    const second = await serve(token);
    const third = await serve(token);
    expect(second.card!.label).not.toBe(first.card!.label);
    // The dismissed sponsor is not shown again in this session even after rotation.
    expect(third.card === null || third.card.label !== first.card!.label).toBe(true);
  });

  it('report records an aggregate report once, with no family id, and returns 204', async () => {
    const token = await unlocked(fam);
    const card = (await serve(token)).card!;
    const before = await api.db.sql`select count(*)::int as n from public.ad_reports`;
    const res = await post(`/v1/placements/${card.serveToken}/report`, token, {
      category: 'misleading',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('location')).toBeNull();
    await post(`/v1/placements/${card.serveToken}/report`, token, { category: 'misleading' });
    const after = await api.db.sql`select count(*)::int as n from public.ad_reports`;
    expect(after[0]!.n - before[0]!.n).toBe(1);
    const invalid = await post(`/v1/placements/${card.serveToken}/report`, token, {
      category: 'spam',
    });
    expect(invalid.status).toBe(400);
  });

  it('a serve token from another session is useless (no replay across sessions)', async () => {
    const owner = await unlocked(fam);
    const card = (await serve(owner)).card!;
    const intruder = await unlocked(fam);
    for (const action of ['viewed', 'dismiss', 'click']) {
      const res = await post(
        `/v1/placements/${card.serveToken}/${action}`,
        intruder,
        action === 'viewed' ? { visibleMs: 1500, visibleRatio: 1 } : undefined,
      );
      expect(res.status).toBe(404);
    }
    const other = await seedFamily(api.db);
    expect(
      (await post(`/v1/placements/${card.serveToken}/click`, await unlocked(other))).status,
    ).toBe(404);
  });
});

describe('viewable impressions (AC_MON_16)', () => {
  it('counts only a card visible >= 1 s at >= 50 %, once; prefetched/replayed claims do not count', async () => {
    api.now.value = BASE_NOW;
    const token = await unlocked(fam);
    const card = (await serve(token)).card!;
    const viewed = (body: unknown) => post(`/v1/placements/${card.serveToken}/viewed`, token, body);
    const read = async (body: unknown) =>
      json<{ counted: boolean; reason: string | null }>(await viewed(body));
    // Claimed immediately after serving: the card cannot have been visible that long (prefetch).
    expect(await read({ visibleMs: 1500, visibleRatio: 1 })).toEqual({
      counted: false,
      reason: 'implausible_duration',
    });
    api.now.value = new Date(BASE_NOW.getTime() + 5000);
    expect(await read({ visibleMs: 999, visibleRatio: 1 })).toEqual({
      counted: false,
      reason: 'below_min_duration',
    });
    expect(await read({ visibleMs: 1500, visibleRatio: 0.3 })).toEqual({
      counted: false,
      reason: 'below_min_ratio',
    });
    const total = async () =>
      (
        await api.db.sql<{ n: number }[]>`
          select coalesce(sum(count), 0)::int as n from public.aggregate_ad_events where kind = 'viewable_impression'`
      )[0]!.n;
    const beforeCount = await total();
    expect(await read({ visibleMs: 1500, visibleRatio: 0.8 })).toEqual({
      counted: true,
      reason: null,
    });
    expect(await read({ visibleMs: 1500, visibleRatio: 0.8 })).toEqual({
      counted: false,
      reason: 'already_counted',
    });
    expect((await total()) - beforeCount).toBe(1);
    expect((await viewed({ visibleMs: -1, visibleRatio: 2 })).status).toBe(400);
    api.now.value = BASE_NOW;
  });

  it('a stale (hidden for a long time or replayed) serve never counts', async () => {
    api.now.value = BASE_NOW;
    const token = await unlocked(fam);
    const card = (await serve(token)).card!;
    api.now.value = new Date(BASE_NOW.getTime() + 31 * 60 * 1000);
    const res = await post(`/v1/placements/${card.serveToken}/viewed`, token, {
      visibleMs: 1500,
      visibleRatio: 1,
    });
    expect(await json(res)).toEqual({ counted: false, reason: 'stale_serve' });
    api.now.value = BASE_NOW;
  });
});

describe('sponsor click-through (AC_MON_12)', () => {
  it('returns the reviewed destination with no identifiers and counts one click per serve', async () => {
    const sessionId = newSessionId();
    const token = await unlocked(fam, sessionId);
    const card = (await serve(token)).card!;
    const res = await post(`/v1/placements/${card.serveToken}/click`, token);
    expect(res.status).toBe(200);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const { url } = placementClickResponseSchema.parse(await res.json());
    expect(url).toMatch(/^https:\/\/www\.(tutoring|books)\.example\/families$/);
    for (const secret of [
      fam.familyId,
      fam.ownerId,
      fam.children[0]!.id,
      sessionId,
      card.serveToken,
      'Riley',
    ]) {
      expect(url).not.toContain(secret);
    }
    const campaignId = url.includes('tutoring') ? campaignA.campaignId : campaignB.campaignId;
    const before = await counter(campaignId, 'click');
    await post(`/v1/placements/${card.serveToken}/click`, token);
    expect(await counter(campaignId, 'click')).toBe(before);
  });

  it('a dismissed or reported card never navigates or counts a click (RV-MON-03)', async () => {
    const dash = 'placement=adult_dashboard&platform=ios';
    for (const close of ['dismiss', 'report'] as const) {
      const token = await unlocked(fam);
      const card = (await serve(token, dash)).card!;
      const clicks = await counter(campaignDash.campaignId, 'click');
      const closed = await post(
        `/v1/placements/${card.serveToken}/${close}`,
        token,
        close === 'report' ? { category: 'irrelevant' } : undefined,
      );
      expect(closed.status).toBe(204);
      const click = await post(`/v1/placements/${card.serveToken}/click`, token);
      expect(click.status).toBe(404);
      expect(Object.keys(await json<Record<string, unknown>>(click))).toEqual(['error']);
      expect(await counter(campaignDash.campaignId, 'click')).toBe(clicks);
    }
  });
});

describe('the declared platform is not trusted on its own (RV-MON-04, AC_MON_09)', () => {
  const dash = (platform: string) =>
    `/v1/placements?placement=adult_dashboard&platform=${platform}`;

  it('a browser is always the web property, bound to the configured origin it came from', async () => {
    // Android has no sponsor approval; the web property does.
    const native = await api.request(dash('android'), { token: await unlocked(fam) });
    expect(placementResponseSchema.parse(await native.json()).reason).toBe('disabled');
    for (const headers of [
      { origin: WEB_PROPERTY },
      // Same-origin browser fetches may omit Origin but always carry fetch metadata.
      { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
    ]) {
      const browser = await api.request(dash('android'), { token: await unlocked(fam), headers });
      expect(placementResponseSchema.parse(await browser.json()).reason).toBe('served');
    }
    // A browser on an origin that is not a configured property matches no approval.
    const foreign = await api.request(dash('web'), {
      token: await unlocked(fam),
      headers: { origin: 'https://elsewhere.example' },
    });
    expect(placementResponseSchema.parse(await foreign.json()).reason).toBe('disabled');
  });

  it('a card served to a native app cannot be billed or opened from a browser', async () => {
    api.now.value = BASE_NOW;
    const token = await unlocked(fam);
    const card = (await serve(token, 'placement=adult_dashboard&platform=ios')).card!;
    api.now.value = new Date(BASE_NOW.getTime() + 5000);
    const browser = { origin: WEB_PROPERTY };
    const viewed = await api.request(`/v1/placements/${card.serveToken}/viewed`, {
      method: 'POST',
      token,
      headers: browser,
      body: { visibleMs: 1500, visibleRatio: 1 },
    });
    expect(await json(viewed)).toEqual({ counted: false, reason: 'placement_withdrawn' });
    const click = await api.request(`/v1/placements/${card.serveToken}/click`, {
      method: 'POST',
      token,
      headers: browser,
    });
    expect(click.status).toBe(404);
    api.now.value = BASE_NOW;
  });
});

describe('ad-free entitlement and parent preferences (AC_MON_04)', () => {
  async function subscribed(
    product: string,
    status = 'active',
    periodEnd = '2026-10-10T00:00:00Z',
  ) {
    const family = await seedFamily(api.db);
    await api.db.sql`
      insert into public.family_entitlements (family_id, channel, provider_subscription_id, product_id, paid_slots, status,
        environment, period_start, period_end, provider_updated_at, fetched_at)
      values (${family.familyId}, 'app_store', ${'orig_' + family.familyId}, ${product}, 1, ${status}, 'sandbox',
              '2026-09-10T00:00:00Z', ${periodEnd}, now(), now())
    `;
    return family;
  }

  it('the default (inactive) mapping makes nobody ad-free; an ACTIVE mapping suppresses cards on every device', async () => {
    const family = await subscribed('fixture.adfree.monthly');
    expect((await serve(await unlocked(family))).reason).toBe('served');
    await api.db.sql`
      insert into public.store_feature_mappings (channel, product_id, environment, feature)
      values ('app_store', 'fixture.adfree.monthly', 'sandbox', 'ad_free')
    `;
    expect((await serve(await unlocked(family))).reason).toBe('served');
    await api.db
      .sql`update public.store_feature_mappings set active = true where product_id = 'fixture.adfree.monthly'`;
    // Restored entitlement: any device/session of the family is ad-free (server-side).
    expect(await serve(await unlocked(family))).toEqual({ card: null, reason: 'ad_free' });
    expect(await serve(await unlocked(family), 'placement=adult_dashboard&platform=web')).toEqual({
      card: null,
      reason: 'ad_free',
    });
    // An expired ad-free subscription no longer suppresses.
    const lapsed = await subscribed(
      'fixture.adfree.monthly',
      'cancelled_active',
      '2026-09-20T00:00:00Z',
    );
    expect((await serve(await unlocked(lapsed))).reason).toBe('served');
    await api.db
      .sql`update public.store_feature_mappings set active = false where product_id = 'fixture.adfree.monthly'`;
  });

  it('a parent can hide sponsor cards and affiliate cards; children cannot change it', async () => {
    const family = await seedFamily(api.db);
    const token = await unlocked(family);
    const initial = await api.request('/v1/monetization/preferences', { token });
    expect(await json(initial)).toEqual({ hideAffiliate: false, hideSponsorCards: false });
    const put = await api.request('/v1/monetization/preferences', {
      method: 'PUT',
      token,
      body: { hideAffiliate: true, hideSponsorCards: true },
    });
    expect(put.status).toBe(200);
    expect(await serve(token)).toEqual({ card: null, reason: 'hidden_by_parent' });
    expect(await json(await api.request('/v1/monetization/preferences', { token }))).toEqual({
      hideAffiliate: true,
      hideSponsorCards: true,
    });
    const audit = await api.db.sql`
      select actor_kind from public.audit_events where family_id = ${family.familyId} and action = 'monetization.preferences_updated'
    `;
    expect(audit).toEqual([{ actor_kind: 'parent' }]);
    const byChild = await api.request('/v1/monetization/preferences', {
      method: 'PUT',
      token: childToken,
      body: { hideAffiliate: false, hideSponsorCards: false },
    });
    expect(byChild.status).toBe(401);
    const extra = await api.request('/v1/monetization/preferences', {
      method: 'PUT',
      token,
      body: { hideAffiliate: false, hideSponsorCards: false, familyId: fam.familyId },
    });
    expect(extra.status).toBe(400);
  });
});

describe('resource browser, merchant modes and outbound links (AC_MON_08..12)', () => {
  let workbook: string;
  let exercise: string;
  let retired: string;
  let gone: string;
  let draft: string;

  beforeAll(async () => {
    workbook = await fixtureResource(api.db, adminId, { key: 'fraction-workbook' });
    exercise = await fixtureResource(api.db, adminId, {
      key: 'kitchen-fractions',
      kind: 'parent_exercise',
      merchant: 'none',
      gradeMin: 2,
      gradeMax: 5,
    });
    retired = await fixtureResource(api.db, adminId, {
      key: 'retired-kit',
      url: 'https://www.amazon.com/dp/B000TEST02',
      status: 'retired',
    });
    gone = await fixtureResource(api.db, adminId, {
      key: 'gone-kit',
      url: 'https://www.amazon.com/dp/B000TEST03',
      availability: 'unavailable',
    });
    draft = await fixtureResource(api.db, adminId, {
      key: 'draft-kit',
      url: 'https://www.amazon.com/dp/B000TEST05',
      status: 'draft',
    });
    await fixtureResource(api.db, adminId, {
      key: 'phonics-cards',
      kind: 'flashcards',
      url: 'https://www.amazon.com/dp/B000TEST04',
      subjects: ['reading'],
      skills: ['phonics'],
      gradeMin: 1,
      gradeMax: 2,
    });
  });

  const browse = async (
    token: string,
    query = 'platform=ios&subject=math&grade=3&skill=fractions.compare',
  ) => {
    const res = await api.request(`/v1/resources?${query}`, { token });
    expect(res.status).toBe(200);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    return resourcesResponseSchema.parse(await res.json());
  };
  const outbound = (token: string, id: string, query = 'platform=ios') =>
    api.request(`/v1/resources/${id}/outbound?${query}`, { token });

  it('ranks reviewed resources by relevance; free options included; no fake prices', async () => {
    const body = await browse(await unlocked(fam));
    const keys = body.items.map((i) => i.title);
    // Skill match and grade fit dominate; the free parent exercise is included alongside.
    expect(keys).toEqual(['Resource fraction-workbook', 'Resource kitchen-fractions']);
    const book = body.items.find((i) => i.id === workbook)!;
    expect(book).toMatchObject({
      mode: 'plain_link',
      disclosure: 'External link',
      price: null,
      priceNote: 'Check current price on Amazon.',
    });
    const free = body.items.find((i) => i.id === exercise)!;
    expect(free).toMatchObject({
      mode: 'education_only',
      disclosure: null,
      priceNote: null,
      price: null,
    });
    expect(body.items.map((i) => i.id)).not.toEqual(expect.arrayContaining([retired, gone, draft]));
  });

  it('switches alone, other properties and missing tags never activate affiliate mode (AC_MON_09/10)', async () => {
    const token = await unlocked(fam);
    await setSwitches(api.db, { amazon_associates: true });
    expect((await browse(token)).mode).toBe('plain_link');
    const otherProperty = await fixtureApproval(api.db, adminId, {
      provider: 'amazon_associates',
      property: 'com.someone-else.app',
    });
    const noTag = await fixtureApproval(api.db, adminId, {
      provider: 'amazon_associates',
      tag: null,
    });
    const pending = await fixtureApproval(api.db, adminId, {
      provider: 'amazon_associates',
      status: 'pending',
    });
    const expired = await fixtureApproval(api.db, adminId, {
      provider: 'amazon_associates',
      expiresAt: '2026-09-20T00:00:00Z',
    });
    expect((await browse(token)).mode).toBe('plain_link');
    const link = await outbound(token, workbook);
    expect(outboundUrlResponseSchema.parse(await link.json())).toEqual({
      url: 'https://www.amazon.com/dp/B000TEST01',
      mode: 'plain_link',
      disclosure: 'External link',
    });
    for (const id of [otherProperty, noTag, pending, expired]) {
      await api.db
        .sql`update public.monetization_approvals set status = 'revoked' where id = ${id} and status in ('pending', 'approved')`;
    }
  });

  it('an approved property with evidence adds only the publisher tag, with the Associates disclosure', async () => {
    const token = await unlocked(fam);
    const approval = await fixtureApproval(api.db, adminId, { provider: 'amazon_associates' });
    const body = await browse(token);
    expect(body.mode).toBe('amazon_associates');
    const book = body.items.find((i) => i.id === workbook)!;
    expect(book.disclosure).toBe('As an Amazon Associate I earn from qualifying purchases.');
    expect(book.price).toBeNull();
    const res = await outbound(token, workbook);
    expect(res.status).toBe(200);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const { url, mode } = outboundUrlResponseSchema.parse(await res.json());
    expect(mode).toBe('amazon_associates');
    expect(url).toBe('https://www.amazon.com/dp/B000TEST01?tag=pencillift-20');
    for (const secret of [fam.familyId, fam.ownerId, fam.children[0]!.id, 'Riley', 'fractions']) {
      expect(url).not.toContain(secret);
    }
    // Per-platform eligibility: web has no Amazon approval.
    expect((await browse(token, 'platform=web')).mode).toBe('plain_link');
    // Revocation takes effect immediately.
    await api.db
      .sql`update public.monetization_approvals set status = 'revoked' where id = ${approval}`;
    expect((await browse(token)).mode).toBe('plain_link');
    await setSwitches(api.db, { amazon_associates: false });
  });

  it('a mobile Amazon approval without a recorded permitted linking tool keeps plain links (RV-MON-09)', async () => {
    const token = await unlocked(fam);
    await setSwitches(api.db, { amazon_associates: true });
    const noTool = await fixtureApproval(api.db, adminId, {
      provider: 'amazon_associates',
      linkingTool: null,
    });
    try {
      expect((await browse(token)).mode).toBe('plain_link');
      const link = outboundUrlResponseSchema.parse(await (await outbound(token, workbook)).json());
      expect(link).toEqual({
        url: 'https://www.amazon.com/dp/B000TEST01',
        mode: 'plain_link',
        disclosure: 'External link',
      });
    } finally {
      await api.db
        .sql`update public.monetization_approvals set status = 'revoked' where id = ${noTool}`;
      await setSwitches(api.db, { amazon_associates: false });
    }
  });

  it('free adults and cancelled subscribers keep resource and link access (AC_MON_11)', async () => {
    const free = await seedFamily(api.db);
    const cancelled = await seedFamily(api.db);
    await api.db.sql`
      insert into public.family_entitlements (family_id, channel, provider_subscription_id, product_id, paid_slots, status,
        environment, period_start, period_end, provider_updated_at, fetched_at)
      values (${cancelled.familyId}, 'app_store', ${'orig_' + cancelled.familyId}, 'pl_family_1', 1, 'expired', 'sandbox',
              '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', now(), now())
    `;
    for (const family of [free, cancelled]) {
      const token = await unlocked(family);
      expect((await browse(token)).items.length).toBeGreaterThan(0);
      expect((await outbound(token, workbook)).status).toBe(200);
    }
  });

  it('invalid, retired, unavailable and free items fail safely', async () => {
    const token = await unlocked(fam);
    for (const id of [retired, gone, draft, '00000000-0000-4000-8000-000000000000']) {
      expect((await outbound(token, id)).status).toBe(404);
    }
    expect((await outbound(token, 'not-a-uuid')).status).toBe(404);
    const freeItem = await outbound(token, exercise);
    expect(freeItem.status).toBe(422);
    expect((await json<ErrorBody>(freeItem)).error.rule).toBe('LINKS_UNAVAILABLE');
  });

  it('a locale outside the catalog marketplace falls back to educational descriptions', async () => {
    const token = await unlocked(fam);
    const body = await browse(token, 'platform=ios&locale=fr-FR');
    expect(body.mode).toBe('education_only');
    expect(body.items.every((i) => i.mode === 'education_only' && i.disclosure === null)).toBe(
      true,
    );
    expect((await outbound(token, workbook, 'platform=ios&locale=fr-FR')).status).toBe(422);
  });

  it('hiding affiliate cards removes merchant items but keeps free learning options', async () => {
    const family = await seedFamily(api.db);
    const token = await unlocked(family);
    await api.request('/v1/monetization/preferences', {
      method: 'PUT',
      token,
      body: { hideAffiliate: true, hideSponsorCards: false },
    });
    const body = await browse(token);
    expect(body.commercialHidden).toBe(true);
    expect(body.items.map((i) => i.merchant)).toEqual(['none']);
    expect((await outbound(token, workbook)).status).toBe(404);
  });

  it('records outbound clicks as aggregate counters only', async () => {
    const [row] = await api.db.sql<{ n: number }[]>`
      select coalesce(sum(count), 0)::int as n from public.aggregate_ad_events where catalog_id = ${workbook} and kind = 'click'
    `;
    expect(row!.n).toBeGreaterThan(0);
  });
});

describe('kill switches, pauses and approvals remove placements immediately (AC_MON_14)', () => {
  it('the global switch removes cards and live serves while learning routes keep working', async () => {
    const token = await unlocked(fam);
    const card = (await serve(token)).card!;
    await setSwitches(api.db, { global: false });
    expect(await serve(token)).toEqual({ card: null, reason: 'disabled' });
    expect((await post(`/v1/placements/${card.serveToken}/click`, token)).status).toBe(404);
    const view = await post(`/v1/placements/${card.serveToken}/viewed`, token, {
      visibleMs: 1500,
      visibleRatio: 1,
    });
    expect(await json(view)).toEqual({ counted: false, reason: 'placement_withdrawn' });
    // Reporting still works (safety control).
    expect(
      (await post(`/v1/placements/${card.serveToken}/report`, token, { category: 'other' })).status,
    ).toBe(204);
    expect((await api.request('/v1/family', { token })).status).toBe(200);
    expect((await api.request('/v1/rewards', { token })).status).toBe(200);
    expect((await api.request('/v1/resources?platform=ios', { token })).status).toBe(200);
    await setSwitches(api.db, { global: true });
    await setSwitches(api.db, { sponsor_direct: false });
    expect((await serve(await unlocked(fam))).reason).toBe('disabled');
    await setSwitches(api.db, { sponsor_direct: true });
  });

  it('paused, expired and over-cap campaigns stop serving', async () => {
    await api.db
      .sql`update public.sponsor_campaigns set status = 'paused', paused_reason = 'Owner pause' where id = ${campaignA.campaignId}`;
    const onlyB = await serve(await unlocked(fam));
    expect(onlyB.card!.label).toBe('Sponsored by Cedar Books');
    await api.db
      .sql`update public.sponsor_campaigns set impression_cap = 1 where id = ${campaignB.campaignId}`;
    await api.db.sql`
      insert into public.aggregate_ad_events (campaign_id, event_date, platform, placement, kind, count)
      values (${campaignB.campaignId}, '2026-09-23', 'web', 'resources_browse', 'viewable_impression', 1)
      on conflict (campaign_id, catalog_id, event_date, platform, placement, kind) do update set count = public.aggregate_ad_events.count + 1
    `;
    expect(await serve(await unlocked(fam))).toEqual({ card: null, reason: 'no_eligible' });
    // Expiry: the dashboard campaign ends on 1 Oct.
    api.now.value = new Date('2026-10-01T00:00:00Z');
    expect(await serve(await unlocked(fam), 'placement=adult_dashboard&platform=ios')).toEqual({
      card: null,
      reason: 'no_eligible',
    });
    api.now.value = BASE_NOW;
    expect(
      (await serve(await unlocked(fam), 'placement=adult_dashboard&platform=ios')).reason,
    ).toBe('served');
  });

  it('a revoked or expired provider approval removes placements for that platform only', async () => {
    await api.db
      .sql`update public.monetization_approvals set status = 'revoked' where id = ${sponsorApprovalIos}`;
    expect(await serve(await unlocked(fam), 'placement=adult_dashboard&platform=ios')).toEqual({
      card: null,
      reason: 'disabled',
    });
    expect(
      (await serve(await unlocked(fam), 'placement=adult_dashboard&platform=web')).reason,
    ).toBe('served');
    // Android never had an approval.
    expect(
      (await serve(await unlocked(fam), 'placement=adult_dashboard&platform=android')).reason,
    ).toBe('disabled');
    sponsorApprovalIos = await fixtureApproval(api.db, adminId, {
      provider: 'sponsor_direct',
      platform: 'ios',
    });
  });
});

describe('privacy of commercial state', () => {
  it('logs carry no tokens, family ids or URLs', () => {
    const logs = JSON.stringify(api.logs);
    for (const secret of [
      fam.familyId,
      fam.ownerId,
      'serveToken',
      'amazon.com',
      'tutoring.example',
    ]) {
      expect(logs).not.toContain(secret);
    }
  });

  it('serve state is keyed by a session hash (never family/user id) and purged after 7 days', async () => {
    const rows = await api.db.sql<
      { session_key_hash: string }[]
    >`select session_key_hash from private.placement_serves limit 5`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.session_key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.session_key_hash).not.toContain(fam.familyId.replace(/-/g, ''));
    }
    const kept = await purgeExpiredServes(
      api.apiDb,
      new Date(BASE_NOW.getTime() + 6 * 24 * 3600 * 1000),
    );
    expect(kept.deleted).toBe(0);
    const purged = await purgeExpiredServes(api.apiDb, new Date('2026-10-15T00:00:00Z'));
    expect(purged.deleted).toBeGreaterThan(0);
    const [left] = await api.db.sql<
      { n: number }[]
    >`select count(*)::int as n from private.placement_serves`;
    expect(left!.n).toBe(0);
  });
});

describe('no commercial event can grant points, rewards, allowances or discounts (AC_MON_13)', () => {
  it('exercises every monetization endpoint and writes nothing to non-commercial ledgers', async () => {
    const before = await nonCommercialLedgerCounts(api.db);
    const token = await unlocked(fam);
    const card = (await serve(token, 'placement=adult_dashboard&platform=ios')).card!;
    api.now.value = new Date(BASE_NOW.getTime() + 5000);
    await post(`/v1/placements/${card.serveToken}/viewed`, token, {
      visibleMs: 2000,
      visibleRatio: 1,
    });
    await post(`/v1/placements/${card.serveToken}/click`, token);
    await post(`/v1/placements/${card.serveToken}/dismiss`, token);
    await post(`/v1/placements/${card.serveToken}/report`, token, { category: 'irrelevant' });
    api.now.value = BASE_NOW;
    const resources = await api.request('/v1/resources?platform=ios', { token });
    const items = resourcesResponseSchema.parse(await resources.json()).items;
    for (const item of items)
      await api.request(`/v1/resources/${item.id}/outbound?platform=ios`, { token });
    await api.request('/v1/monetization/preferences', { token });
    await api.request('/v1/monetization/preferences', {
      method: 'PUT',
      token,
      body: { hideAffiliate: false, hideSponsorCards: false },
    });
    const admin = (path: string, method = 'GET', body?: unknown) =>
      api.request(`/v1/admin/monetization${path}`, {
        method,
        token: adminToken,
        ...(body === undefined ? {} : { body }),
      });
    for (const path of [
      '/status',
      '/sponsors',
      '/campaigns',
      '/approvals',
      '/catalog',
      '/placement-rules',
      '/ad-reports',
      '/report?month=2026-09',
      '/revenue/summary?month=2026-09',
    ]) {
      expect((await admin(path)).status).toBe(200);
    }
    const imported = await admin('/revenue/imports', 'POST', {
      source: 'amazon_report',
      periodMonth: '2026-09',
      note: null,
      rows: [
        {
          externalRef: 'AMZ-2026-09-TOTAL',
          category: 'affiliate_reported',
          provider: 'amazon_associates',
          campaignId: null,
          placement: null,
          amountCents: 1234,
        },
      ],
    });
    expect(imported.status).toBe(201);
    const after = await nonCommercialLedgerCounts(api.db);
    expect(after).toEqual(before);
    expect(after).toEqual({
      points_ledger: 0,
      reward_redemptions: 0,
      usage_reservations: 0,
      promo_redemptions: 0,
    });
  });
});
