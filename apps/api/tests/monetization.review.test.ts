import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_DATABASE_URL } from '@pencillift/db/testing';
import {
  outboundUrlResponseSchema,
  placementResponseSchema,
  placementViewedResponseSchema,
  resourcesResponseSchema,
  revenueSummarySchema,
} from '@pencillift/contracts';
import {
  grantAdultUnlock,
  seedFamily,
  seedOwnerAdmin,
  type SeededFamily,
} from '@pencillift/db/testing/fixtures';
import { createTestApi, parentToken, type TestApi } from './helpers.ts';
import {
  WEB_PROPERTY,
  fixtureApproval,
  fixtureCampaign,
  fixtureResource,
  setSwitches,
} from './monetization-fixtures.ts';

// Adversarial review of the P16 monetization API (AC_MON_06, AC_MON_09/10, AC_MON_16..18).
// Each test reproduces one defect and is expected to FAIL until the production code is fixed.
// Synthetic families and labeled fixture approvals only.

let api: TestApi;
let fam: SeededFamily;
let adminId: string;
let adminToken: string;
let sessionSeq = 0;
const BASE_NOW = new Date('2026-09-24T15:00:00Z');

function newSessionId(): string {
  sessionSeq += 1;
  return `7e7e${sessionSeq.toString(16).padStart(4, '0')}-0000-4000-8000-000000000000`;
}

async function unlocked(family: SeededFamily = fam): Promise<string> {
  const sessionId = newSessionId();
  await grantAdultUnlock(api.db, family.ownerId, sessionId, 3600);
  return parentToken(family.ownerId, { sessionId });
}

async function serve(token: string, query: string) {
  const res = await api.request(`/v1/placements?${query}`, { token });
  expect(res.status).toBe(200);
  return placementResponseSchema.parse(await res.json());
}

const post = (path: string, token: string, body?: unknown) =>
  api.request(path, { method: 'POST', token, ...(body === undefined ? {} : { body }) });

const admin = (path: string, method = 'GET', body?: unknown) =>
  api.request(`/v1/admin/monetization${path}`, {
    method,
    token: adminToken,
    ...(body === undefined ? {} : { body }),
  });

async function summaryFor(month: string) {
  const res = await admin(`/revenue/summary?month=${month}`);
  expect(res.status).toBe(200);
  const { month: _month, ...rest } = (await res.json()) as { month: string };
  return revenueSummarySchema.parse(rest);
}

async function counter(campaignId: string, kind: string): Promise<number> {
  const [row] = await api.db.sql<{ n: number }[]>`
    select coalesce(sum(count), 0)::int as n from public.aggregate_ad_events
     where campaign_id = ${campaignId} and kind = ${kind}
  `;
  return row!.n;
}

async function pause(campaignId: string): Promise<void> {
  await api.db.sql`
    update public.sponsor_campaigns set status = 'paused', paused_reason = 'review test isolation'
     where id = ${campaignId} and status in ('scheduled', 'active')
  `;
}

beforeAll(async () => {
  api = await createTestApi();
  fam = await seedFamily(api.db, { childCount: 1 });
  adminId = await seedOwnerAdmin(api.db);
  adminToken = await parentToken(adminId, { aal: 'aal2' });
  await setSwitches(api.db, { global: true, sponsor_direct: true });
  await fixtureApproval(api.db, adminId, { provider: 'sponsor_direct', platform: 'ios' });
  await fixtureApproval(api.db, adminId, { provider: 'sponsor_direct', platform: 'web' });
});

afterAll(async () => {
  await api?.close();
});

describe('billable impressions (AC_MON_06 caps, AC_MON_16)', () => {
  it('RV-MON-01: concurrent viewable beacons cannot push a campaign past its impression cap', async () => {
    api.now.value = BASE_NOW;
    const capped = await fixtureCampaign(api.db, adminId, {
      name: 'Cap Race Tutoring',
      domain: 'caprace.example',
      placement: 'adult_dashboard',
      impressionCap: 1,
    });
    // Eight different parent sessions each legitimately receive the card while 0 of 1 is delivered.
    const served: { token: string; serveToken: string }[] = [];
    for (let i = 0; i < 8; i += 1) {
      const token = await unlocked();
      const body = await serve(token, 'placement=adult_dashboard&platform=ios');
      expect(body.card?.label).toBe('Sponsored by Cap Race Tutoring');
      served.push({ token, serveToken: body.card!.serveToken });
    }
    api.now.value = new Date(BASE_NOW.getTime() + 5000);
    // Make the interleaving deterministic instead of relying on scheduler luck: the (committed,
    // zero) counter cell for today's beacons is row-locked by an unrelated connection for a moment,
    // exactly as a slow concurrent writer would. Beacons that pass the cap check queue on it; the
    // lock is released once two of them are waiting (or after 5 s). A correct implementation
    // serializes the cap check itself, so at most one beacon can ever be waiting here.
    await api.db.sql`
      insert into public.aggregate_ad_events (campaign_id, event_date, platform, placement, kind, count)
      values (${capped.campaignId}, '2026-09-24', 'ios', 'adult_dashboard', 'viewable_impression', 0)
    `;
    const url = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
    url.pathname = `/${api.db.name}`;
    const other = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    let lockHeld!: () => void;
    const held = new Promise<void>((resolve) => (lockHeld = resolve));
    const holder = other.begin(async (tx) => {
      await tx`
        select 1 from public.aggregate_ad_events
         where campaign_id = ${capped.campaignId} and kind = 'viewable_impression' for update
      `;
      lockHeld();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        // Beacons already queued behind the lock: they hold a lock on the counter table (their
        // insert/update started) and are still waiting for a row/tuple/transaction lock.
        const [row] = await tx<{ n: number }[]>`
          select count(distinct w.pid)::int as n from pg_locks w
           where not w.granted and w.pid <> pg_backend_pid()
             and exists (
               select 1 from pg_locks r
                where r.pid = w.pid and r.granted
                  and r.database = (select oid from pg_database where datname = current_database())
                  and r.relation = 'public.aggregate_ad_events'::regclass)
        `;
        if (row!.n >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    });
    let results: { counted: boolean; reason: string | null }[];
    try {
      await held;
      results = await Promise.all(
        served.map(async ({ token, serveToken }) =>
          placementViewedResponseSchema.parse(
            await (
              await post(`/v1/placements/${serveToken}/viewed`, token, {
                visibleMs: 1500,
                visibleRatio: 1,
              })
            ).json(),
          ),
        ),
      );
      await holder;
    } finally {
      await other.end();
      api.now.value = BASE_NOW;
    }
    await pause(capped.campaignId);
    // The contracted cap is 1 viewable impression; parallel beacons must not all be billed.
    expect(results.filter((r) => r.counted)).toHaveLength(1);
    expect(await counter(capped.campaignId, 'viewable_impression')).toBeLessThanOrEqual(1);
  });

  it('RV-MON-02: a beacon sent the instant a card is served (prefetch) is not a billable impression', async () => {
    api.now.value = BASE_NOW;
    const campaign = await fixtureCampaign(api.db, adminId, {
      name: 'Prefetch Books',
      domain: 'prefetch.example',
      placement: 'adult_dashboard',
    });
    const token = await unlocked();
    const card = (await serve(token, 'placement=adult_dashboard&platform=ios')).card!;
    expect(card.label).toBe('Sponsored by Prefetch Books');
    // Same server instant as the serve: the card cannot have been on screen for 1000 ms.
    const res = await post(`/v1/placements/${card.serveToken}/viewed`, token, {
      visibleMs: 1000,
      visibleRatio: 1,
    });
    const body = placementViewedResponseSchema.parse(await res.json());
    const billed = await counter(campaign.campaignId, 'viewable_impression');
    await pause(campaign.campaignId);
    expect(body.counted).toBe(false);
    expect(billed).toBe(0);
  });

  it('RV-MON-03: a card dismissed before it was ever viewable cannot be billed by a later beacon', async () => {
    api.now.value = BASE_NOW;
    const campaign = await fixtureCampaign(api.db, adminId, {
      name: 'Dismissed Early Learning',
      domain: 'dismissed.example',
      placement: 'adult_dashboard',
    });
    const token = await unlocked();
    const card = (await serve(token, 'placement=adult_dashboard&platform=ios')).card!;
    expect(card.label).toBe('Sponsored by Dismissed Early Learning');
    // The adult dismisses the card 300 ms after it was served: it was never visible for 1 s.
    api.now.value = new Date(BASE_NOW.getTime() + 300);
    expect((await post(`/v1/placements/${card.serveToken}/dismiss`, token)).status).toBe(204);
    // A delayed/replayed beacon then claims 1.5 s of visibility.
    api.now.value = new Date(BASE_NOW.getTime() + 5000);
    const res = await post(`/v1/placements/${card.serveToken}/viewed`, token, {
      visibleMs: 1500,
      visibleRatio: 1,
    });
    const body = placementViewedResponseSchema.parse(await res.json());
    api.now.value = BASE_NOW;
    const billed = await counter(campaign.campaignId, 'viewable_impression');
    await pause(campaign.campaignId);
    expect(body.counted).toBe(false);
    expect(billed).toBe(0);
  });
});

describe('per-property eligibility (AC_MON_09, AC_MON_10)', () => {
  it('RV-MON-04: a browser on the unapproved web property cannot obtain affiliate-tagged links by claiming platform=ios', async () => {
    const workbook = await fixtureResource(api.db, adminId, { key: 'spoof-workbook' });
    const iosOnly = await fixtureApproval(api.db, adminId, {
      provider: 'amazon_associates',
      platform: 'ios',
    });
    await setSwitches(api.db, { amazon_associates: true });
    const token = await unlocked();
    // Every browser request from the web app carries the web property's Origin; native apps do not.
    const browser = { origin: WEB_PROPERTY };
    try {
      const list = await api.request('/v1/resources?platform=ios', { token, headers: browser });
      // Refusing the mismatched platform (4xx) or serving it as the web property are both fixes.
      expect([200, 400, 403, 422]).toContain(list.status);
      const body = list.status === 200 ? resourcesResponseSchema.parse(await list.json()) : null;
      const outbound = await api.request(`/v1/resources/${workbook}/outbound?platform=ios`, {
        token,
        headers: browser,
      });
      const link =
        outbound.status === 200 ? outboundUrlResponseSchema.parse(await outbound.json()) : null;
      // Web has no Amazon approval: no affiliate mode and no tag for this request.
      expect(body?.mode ?? null).not.toBe('amazon_associates');
      expect(link?.mode ?? null).not.toBe('amazon_associates');
      expect(link?.url ?? '').not.toContain('tag=');
    } finally {
      await api.db
        .sql`update public.monetization_approvals set status = 'revoked' where id = ${iosOnly}`;
      await setSwitches(api.db, { amazon_associates: false });
    }
  });
});

describe('creative re-review (AC_MON_06)', () => {
  it('RV-MON-05: renaming a sponsor does not change the "Sponsored by" text of a live card without review', async () => {
    const campaign = await fixtureCampaign(api.db, adminId, {
      name: 'Willow Reading',
      domain: 'willow.example',
      placement: 'resources_browse',
    });
    const before = await serve(await unlocked(), 'placement=resources_browse&platform=ios');
    expect(before.card?.label).toBe('Sponsored by Willow Reading');
    const renamed = await admin(`/sponsors/${campaign.sponsorId}`, 'PATCH', {
      businessName: 'Guaranteed Straight A Academy',
    });
    expect(renamed.status).toBe(200);
    const after = await serve(await unlocked(), 'placement=resources_browse&platform=ios');
    await pause(campaign.campaignId);
    // The unreviewed advertiser text must not reach parents until a human re-reviews it.
    expect(after.card?.label).not.toBe('Sponsored by Guaranteed Straight A Academy');
  });
});

describe('revenue ledger (AC_MON_17, AC_MON_18)', () => {
  it('RV-MON-06: the same provider report rows cannot be imported twice under a different source', async () => {
    const rows = [
      {
        externalRef: 'AMZ-REVIEW-2026-08-TOTAL',
        category: 'affiliate_reported',
        provider: 'amazon_associates',
        campaignId: null,
        placement: null,
        amountCents: 5000,
      },
    ];
    const first = await admin('/revenue/imports', 'POST', {
      source: 'amazon_report',
      periodMonth: '2026-08',
      note: null,
      rows,
    });
    expect(first.status).toBe(201);
    const second = await admin('/revenue/imports', 'POST', {
      source: 'manual',
      periodMonth: '2026-08',
      note: null,
      rows,
    });
    const summary = await summaryFor('2026-08');
    expect(second.status).toBe(409);
    expect(summary.affiliateReportedCents).toBe(5000);
  });

  it('RV-MON-07: a sponsor fee row cannot dodge the same-inventory guard by naming a placement its campaign never ran on', async () => {
    const dashboard = await fixtureCampaign(api.db, adminId, {
      name: 'Aspen Tutors',
      domain: 'aspen.example',
      placement: 'adult_dashboard',
      status: 'draft',
    });
    const sponsorFee = await admin('/revenue/imports', 'POST', {
      source: 'sponsor_invoice',
      periodMonth: '2026-07',
      note: null,
      rows: [
        {
          externalRef: 'INV-REVIEW-2026-07',
          category: 'recognized',
          provider: 'sponsor_direct',
          campaignId: dashboard.campaignId,
          placement: 'resources_browse',
          amountCents: 50000,
        },
      ],
    });
    if (sponsorFee.status !== 201) {
      // Refusing the inconsistent row is an acceptable fix.
      expect([400, 422]).toContain(sponsorFee.status);
      return;
    }
    const network = await admin('/revenue/imports', 'POST', {
      source: 'ad_network',
      periodMonth: '2026-07',
      note: null,
      rows: [
        {
          externalRef: 'NET-REVIEW-2026-07',
          category: 'recognized',
          provider: 'ad_network',
          campaignId: null,
          placement: 'adult_dashboard',
          amountCents: 1000,
        },
      ],
    });
    expect(network.status).toBe(201);
    const summary = await summaryFor('2026-07');
    // The fixed fee already paid for the July dashboard inventory: network revenue on it is excluded.
    expect(summary.recognizedCents).toBe(50000);
    expect(summary.excludedDoubleCountCents).toBe(1000);
  });
});
