import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  approvalSchema,
  campaignSchema,
  catalogItemSchema,
  creativeSchema,
  linkCheckResponseSchema,
  monetizationReportSchema,
  monetizationStatusSchema,
  revenueSummarySchema,
  sponsorSchema,
} from '@pencillift/contracts';
import {
  grantAdultUnlock,
  seedFamily,
  seedOwnerAdmin,
  type SeededFamily,
} from '@pencillift/db/testing/fixtures';
import { NON_IDENTIFYING_WORDS, evidenceQuality } from '@pencillift/domain/monetization';
import { issueChildAccessToken } from '../src/auth/child.ts';
import { familyIsAdFree } from '../src/services/monetization-data.ts';
import {
  setLinkCheckFetchForTests,
  type LinkCheckFetch,
} from '../src/services/monetization-links.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

// Owner-only P16 console (AC_MON_06, AC_MON_09, AC_MON_15..18). Synthetic data only.
let api: TestApi;
let adminId: string;
let adminToken: string;
let adminNoMfa: string;
let parentAal2: string;
let childToken: string;
let fam: SeededFamily;

type ErrorBody = { error: { code: string; rule?: string; message: string } };

const admin = (path: string, method = 'GET', body?: unknown, token = adminToken) =>
  api.request(`/v1/admin/monetization${path}`, {
    method,
    token,
    ...(body === undefined ? {} : { body }),
  });

async function ok<T>(res: Response, status = 200): Promise<T> {
  if (res.status !== status)
    throw new Error(`expected ${status}, got ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function rule(res: Response): Promise<string | undefined> {
  return (await json<ErrorBody>(res)).error.rule;
}

const sponsorInput = {
  businessName: 'Maple Tutoring',
  contactRef: 'CRM-0001',
  allowedDomains: ['tutoring.example'],
};

const creativeInput = {
  headline: 'Small-group reading tutoring',
  body: 'Certified tutors for grades 1-5. First session free for new families.',
  ctaLabel: 'Learn more',
  destinationUrl: 'https://www.tutoring.example/families',
  imageAssetRef: null,
  imageLicenseRef: null,
};

beforeAll(async () => {
  api = await createTestApi();
  adminId = await seedOwnerAdmin(api.db);
  adminToken = await parentToken(adminId, { aal: 'aal2' });
  adminNoMfa = await parentToken(adminId, { aal: 'aal1' });
  fam = await seedFamily(api.db, { childCount: 1 });
  parentAal2 = await parentToken(fam.ownerId, {
    aal: 'aal2',
    sessionId: 'feedface-0000-4000-8000-000000000001',
  });
  await grantAdultUnlock(api.db, fam.ownerId, 'feedface-0000-4000-8000-000000000001', 3600);
  const child = fam.children[0]!;
  childToken = (
    await issueChildAccessToken(
      api.config,
      { kind: 'child', childId: child.id, familyId: fam.familyId, sessionId: child.sessionId },
      api.now.value,
    )
  ).token;
});

afterAll(async () => {
  setLinkCheckFetchForTests(null);
  await api?.close();
});

describe('owner-admin isolation (AC_MON_15)', () => {
  const routes: [string, string, unknown?][] = [
    ['GET', '/status'],
    ['GET', '/switches'],
    ['GET', '/sponsors'],
    ['POST', '/sponsors', sponsorInput],
    ['GET', '/campaigns'],
    ['GET', '/approvals'],
    ['PUT', '/switches/global', { enabled: true, reason: 'attempt' }],
    ['GET', '/catalog'],
    ['GET', '/report?month=2026-09'],
    ['GET', '/revenue/summary?month=2026-09'],
    ['GET', '/ad-reports'],
  ];

  it('a family adult (even unlocked with MFA) and an admin without MFA get 403; children and anonymous get 401', async () => {
    for (const [method, path, body] of routes) {
      for (const token of [parentAal2, adminNoMfa]) {
        const res = await admin(path, method, body, token);
        expect(res.status).toBe(403);
        expect(Object.keys(await json<Record<string, unknown>>(res))).toEqual(['error']);
      }
      expect((await admin(path, method, body, childToken)).status).toBe(401);
      expect((await api.request(`/v1/admin/monetization${path}`, { method })).status).toBe(401);
    }
    const [switchRow] = await api.db.sql<
      { enabled: boolean }[]
    >`select enabled from public.monetization_switches where key = 'global'`;
    expect(switchRow!.enabled).toBe(false);
    expect(await api.db.sql`select id from public.sponsors`).toHaveLength(0);
  });

  it('a revoked admin loses access', async () => {
    const revoked = await seedOwnerAdmin(api.db);
    await api.db.sql`update public.admin_users set revoked_at = now() where user_id = ${revoked}`;
    expect(
      (await admin('/status', 'GET', undefined, await parentToken(revoked, { aal: 'aal2' })))
        .status,
    ).toBe(403);
  });

  it('no consumer route offers advertiser self-service purchase', async () => {
    for (const path of [
      '/v1/advertisers',
      '/v1/campaigns/purchase',
      '/v1/sponsors',
      '/v1/placements/buy',
    ]) {
      expect(
        (await api.request(path, { method: 'POST', token: parentAal2, body: {} })).status,
      ).toBe(404);
    }
  });
});

describe('status, switches and approvals (AC_MON_09, AC_MON_10, AC_MON_19)', () => {
  it('everything is blocked by default and reported candidly', async () => {
    const status = monetizationStatusSchema.parse(await ok(await admin('/status')));
    expect(status.switches.every((s) => !s.enabled)).toBe(true);
    expect(status.providers.every((p) => !p.enabled)).toBe(true);
    const network = status.providers.find(
      (p) => p.provider === 'ad_network' && p.platform === 'ios',
    )!;
    expect(network.reasons).toContain('NO_NETWORK_ADAPTER');
  });

  it('switches change with a reason and an audit trail, but cannot activate a provider alone', async () => {
    for (const key of ['global', 'provider:amazon_associates', 'provider:sponsor_direct']) {
      await ok(
        await admin(`/switches/${key}`, 'PUT', { enabled: true, reason: 'Owner test enablement' }),
      );
    }
    expect(
      (await admin('/switches/provider:unknown', 'PUT', { enabled: true, reason: 'x y z' })).status,
    ).toBe(404);
    expect((await admin('/switches/global', 'PUT', { enabled: true })).status).toBe(400);
    const switches = await ok<{ switches: { key: string; enabled: boolean }[] }>(
      await admin('/switches'),
    );
    expect(switches.switches.filter((x) => x.enabled).map((x) => x.key)).toEqual([
      'global',
      'provider:amazon_associates',
      'provider:sponsor_direct',
    ]);
    const status = monetizationStatusSchema.parse(await ok(await admin('/status')));
    const amazonIos = status.providers.find(
      (p) => p.provider === 'amazon_associates' && p.platform === 'ios',
    )!;
    expect(amazonIos.enabled).toBe(false);
    expect(amazonIos.reasons).toContain('NO_APPROVAL');
    const audit = await api.db
      .sql`select count(*)::int as n from public.audit_events where action = 'monetization.switch_changed' and actor_user_id = ${adminId}`;
    expect(audit[0]!.n).toBe(3);
  });

  const approvalInput = {
    provider: 'amazon_associates',
    platform: 'ios',
    propertyIdentifier: 'com.pencillift.app',
    locale: 'en-US',
    intendedAudience: 'Adults in the authenticated parent area',
    vendorSdkVersion: null,
    policyReviewedAt: '2026-09-01T00:00:00Z',
    evidenceRef: 'fixture:amazon-ios-eligibility',
    approvalScope: 'Parent resource browser links',
    publisherTag: 'pencillift-20',
    linkingToolRef: 'fixture:amazon-ios-linking-tool',
    status: 'approved',
    expiresAt: '2027-03-01T00:00:00Z',
  };

  it('booleans, placeholders and API keys are not evidence; an approved Amazon record needs its tag', async () => {
    for (const evidenceRef of [
      'approved',
      'enabled',
      ['sk', 'live', 'abcdefghijklmnop1234'].join(
        '_',
      ) /* built at runtime: fake, keeps the secret scan meaningful */,
      '1234567',
      // RV-MON-08: serialized booleans, flags, punctuated placeholders, the tag, client ids.
      '{"approved":true}',
      'amazon_associates=true',
      'Approved.',
      'pencillift-20',
      'amzn1.application-oa2-client.0123456789abcdef0123456789abcdef',
    ]) {
      const res = await admin('/approvals', 'POST', { ...approvalInput, evidenceRef });
      expect(res.status).toBe(422);
      expect(await rule(res)).toBe('EVIDENCE_INVALID');
    }
    const noTag = await admin('/approvals', 'POST', { ...approvalInput, publisherTag: null });
    expect(await rule(noTag)).toBe('TAG_REQUIRED');
    const badTag = await admin('/approvals', 'POST', {
      ...approvalInput,
      publisherTag: 'anything',
    });
    expect(await rule(badTag)).toBe('TAG_INVALID');
    const future = await admin('/approvals', 'POST', {
      ...approvalInput,
      policyReviewedAt: '2026-12-01T00:00:00Z',
    });
    expect(future.status).toBe(400);
    const sponsorTag = await admin('/approvals', 'POST', {
      ...approvalInput,
      provider: 'sponsor_direct',
    });
    expect(sponsorTag.status).toBe(400);
  });

  it('an approved Amazon mobile record needs a real permitted linking tool (RV-MON-09, AC_MON_10)', async () => {
    for (const platform of ['ios', 'android']) {
      const missing = await admin('/approvals', 'POST', {
        ...approvalInput,
        platform,
        linkingToolRef: null,
      });
      expect(missing.status).toBe(422);
      expect(await rule(missing)).toBe('LINKING_TOOL_REQUIRED');
    }
    for (const linkingToolRef of ['Approved.', 'amazon_associates=true', 'pencillift-20']) {
      const placeholder = await admin('/approvals', 'POST', { ...approvalInput, linkingToolRef });
      expect(await rule(placeholder)).toBe('LINKING_TOOL_INVALID');
    }
    const notAmazon = await admin('/approvals', 'POST', {
      ...approvalInput,
      provider: 'sponsor_direct',
      publisherTag: null,
    });
    expect(notAmazon.status).toBe(400);
    // The web property uses Amazon's standard text links: no mobile linking-tool record needed.
    const { linkingToolRef: _omitted, ...webInput } = approvalInput;
    const web = approvalSchema.parse(
      await ok(
        await admin('/approvals', 'POST', {
          ...webInput,
          platform: 'web',
          propertyIdentifier: 'https://app.pencillift.test',
          status: 'pending',
        }),
        201,
      ),
    );
    expect(web.linkingToolRef).toBeNull();
    // A pending mobile record without the tool cannot be approved later either.
    const pending = approvalSchema.parse(
      await ok(
        await admin('/approvals', 'POST', {
          ...approvalInput,
          status: 'pending',
          linkingToolRef: null,
        }),
        201,
      ),
    );
    const refused = await admin(`/approvals/${pending.id}/approve`, 'POST', {
      reason: 'Approved by Amazon',
    });
    expect(await rule(refused)).toBe('LINKING_TOOL_REQUIRED');
    for (const id of [web.id, pending.id]) {
      await ok(await admin(`/approvals/${id}/revoke`, 'POST', { reason: 'Test cleanup' }));
    }
  });

  it('the database word list mirrors the domain evidence vocabulary (RV-MON-08)', async () => {
    const migration = await readFile(
      new URL('../../../supabase/migrations/0640_monetization.sql', import.meta.url),
      'utf8',
    );
    const body = migration.slice(migration.indexOf('app.monetization_reference_ok'));
    const list = body.slice(body.indexOf('<@ array['), body.indexOf(']::text[]'));
    const sqlWords = [...list.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect(new Set(sqlWords)).toEqual(new Set(NON_IDENTIFYING_WORDS));
    expect(sqlWords).toHaveLength(NON_IDENTIFYING_WORDS.size);
    // And the live function agrees with the domain on status phrases vs references.
    for (const word of NON_IDENTIFYING_WORDS) {
      const phrase = Array.from({ length: 6 }, () => word).join(' ');
      const [row] = await api.db.sql<{ ok: boolean }[]>`
        select app.monetization_reference_ok(${phrase}, null) as ok
      `;
      expect(row!.ok, phrase).toBe(false);
      expect(evidenceQuality(phrase)).toBe('invalid');
    }
    const [real] = await api.db.sql<{ ok: boolean }[]>`
      select app.monetization_reference_ok('OWNER-DOC/amazon-2026-09#pencillift-20', 'pencillift-20') as ok
    `;
    expect(real!.ok).toBe(true);
  });

  it('records a labeled fixture approval (reported as a mock), then revokes it', async () => {
    const created = approvalSchema.parse(
      await ok(await admin('/approvals', 'POST', approvalInput), 201),
    );
    expect(created.evidenceQuality).toBe('fixture');
    let status = monetizationStatusSchema.parse(await ok(await admin('/status')));
    const live = status.providers.find(
      (p) => p.provider === 'amazon_associates' && p.platform === 'ios',
    )!;
    expect(live).toMatchObject({ enabled: true, fixture: true });
    const revoked = approvalSchema.parse(
      await ok(
        await admin(`/approvals/${created.id}/revoke`, 'POST', {
          reason: 'Owner pause for review',
        }),
      ),
    );
    expect(revoked.status).toBe('revoked');
    expect(
      (await admin(`/approvals/${created.id}/approve`, 'POST', { reason: 'Try again' })).status,
    ).toBe(422);
    status = monetizationStatusSchema.parse(await ok(await admin('/status')));
    expect(
      status.providers.find((p) => p.provider === 'amazon_associates' && p.platform === 'ios')!
        .enabled,
    ).toBe(false);
    const audit = await api.db
      .sql`select action from public.audit_events where target_id = ${created.id} order by id`;
    expect(audit.map((a) => a.action)).toEqual([
      'monetization.approval_recorded',
      'monetization.approval_revoke',
    ]);
  });

  it('a pending approval can be approved later only with evidence and a tag', async () => {
    const pending = approvalSchema.parse(
      await ok(
        await admin('/approvals', 'POST', {
          ...approvalInput,
          status: 'pending',
          publisherTag: null,
        }),
        201,
      ),
    );
    const refused = await admin(`/approvals/${pending.id}/approve`, 'POST', {
      reason: 'Approved by Amazon',
    });
    expect(await rule(refused)).toBe('TAG_REQUIRED');
  });
});

describe('sponsors, creative review and re-review (AC_MON_06)', () => {
  let sponsorId: string;

  it('creates a sponsor with a domain allowlist and audits it', async () => {
    const sponsor = sponsorSchema.parse(
      await ok(await admin('/sponsors', 'POST', sponsorInput), 201),
    );
    sponsorId = sponsor.id;
    expect(
      (await admin('/sponsors', 'POST', { ...sponsorInput, allowedDomains: ['Not A Domain'] }))
        .status,
    ).toBe(400);
    expect((await admin('/sponsors', 'POST', { ...sponsorInput, allowedDomains: [] })).status).toBe(
      400,
    );
    const audit = await api.db
      .sql`select actor_kind from public.audit_events where action = 'monetization.sponsor_created' and target_id = ${sponsorId}`;
    expect(audit).toEqual([{ actor_kind: 'admin' }]);
  });

  it('rejects scripts, markup, pixels, remote images and unapproved destinations', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ headline: '<script>alert(1)</script>' }, 'MARKUP_NOT_ALLOWED'],
      [{ body: 'Great tutors <img src=x onerror=alert(1)>' }, 'MARKUP_NOT_ALLOWED'],
      [{ body: 'Track https://ads.example/pixel.gif' }, 'TRACKING_PIXEL'],
      [
        { imageAssetRef: 'https://ads.example/1x1.gif', imageLicenseRef: 'LIC-000001' },
        'TRACKING_PIXEL',
      ],
      [{ imageAssetRef: 'sponsors/maple/logo.png' }, 'IMAGE_LICENSE_REQUIRED'],
      [{ destinationUrl: 'https://unapproved.example/offer' }, 'DESTINATION_NOT_ALLOWLISTED'],
      [{ destinationUrl: 'http://www.tutoring.example/' }, 'DESTINATION_NOT_HTTPS'],
      [{ destinationUrl: 'javascript:alert(1)' }, 'DESTINATION_NOT_HTTPS'],
    ];
    for (const [overrides, code] of cases) {
      const res = await admin(`/sponsors/${sponsorId}/creatives`, 'POST', {
        ...creativeInput,
        ...overrides,
      });
      expect(res.status).toBe(422);
      const body = await json<ErrorBody>(res);
      expect(body.error.rule).toBe('CREATIVE_INVALID');
      expect(body.error.message).toContain(code);
    }
    expect(await api.db.sql`select id from public.sponsor_creatives`).toHaveLength(0);
  });

  let creativeV1: string;
  let campaignId: string;

  it('a sole owner may self-review (recorded); with two owners a second reviewer is required', async () => {
    const v1 = creativeSchema.parse(
      await ok(await admin(`/sponsors/${sponsorId}/creatives`, 'POST', creativeInput), 201),
    );
    creativeV1 = v1.id;
    expect(v1).toMatchObject({ version: 1, reviewStatus: 'draft' });
    // Approval straight from draft is refused: human review first.
    expect((await admin(`/creatives/${v1.id}/approve`, 'POST', {})).status).toBe(422);
    await ok(await admin(`/creatives/${v1.id}/submit`, 'POST'));
    const approved = creativeSchema.parse(
      await ok(await admin(`/creatives/${v1.id}/approve`, 'POST', { note: 'Checked' })),
    );
    expect(approved).toMatchObject({ reviewStatus: 'approved', selfReviewed: true });
    const [audit] = await api.db.sql<{ metadata: { selfReview: boolean } }[]>`
      select metadata from public.audit_events where action = 'monetization.creative_approved' and target_id = ${v1.id}`;
    expect(audit!.metadata.selfReview).toBe(true);

    const secondAdmin = await seedOwnerAdmin(api.db);
    const secondToken = await parentToken(secondAdmin, { aal: 'aal2' });
    const v2 = creativeSchema.parse(
      await ok(
        await admin(`/sponsors/${sponsorId}/creatives`, 'POST', {
          ...creativeInput,
          ctaLabel: 'Book a session',
        }),
        201,
      ),
    );
    expect(v2.version).toBe(2);
    await ok(await admin(`/creatives/${v2.id}/submit`, 'POST'));
    const self = await admin(`/creatives/${v2.id}/approve`, 'POST', {});
    expect(await rule(self)).toBe('SELF_REVIEW_NOT_ALLOWED');
    const other = creativeSchema.parse(
      await ok(await admin(`/creatives/${v2.id}/approve`, 'POST', {}, secondToken)),
    );
    expect(other).toMatchObject({ reviewStatus: 'approved', selfReviewed: false });
    await api.db
      .sql`update public.admin_users set revoked_at = now() where user_id = ${secondAdmin}`;
  });

  it('schedules, activates, pauses (with reason) and reports servability', async () => {
    const created = campaignSchema.parse(
      await ok(
        await admin('/campaigns', 'POST', {
          sponsorId,
          creativeId: creativeV1,
          name: 'Fall reading',
          placement: 'resources_browse',
          platforms: ['ios', 'web'],
          startsAt: '2026-09-25T00:00:00Z',
          endsAt: '2026-10-25T00:00:00Z',
          impressionCap: 5000,
          feeModel: 'fixed_fee',
          contractedFeeCents: 50000,
        }),
        201,
      ),
    );
    campaignId = created.id;
    expect(created).toMatchObject({ status: 'draft', servableNow: false });
    expect(
      await rule(
        await admin(`/campaigns/${campaignId}/transition`, 'POST', { action: 'activate' }),
      ),
    ).toBe('INVALID_TRANSITION');
    await ok(await admin(`/campaigns/${campaignId}/transition`, 'POST', { action: 'submit' }));
    const scheduled = campaignSchema.parse(
      await ok(await admin(`/campaigns/${campaignId}/transition`, 'POST', { action: 'approve' })),
    );
    // Scheduled for tomorrow: not yet servable.
    expect(scheduled).toMatchObject({
      status: 'scheduled',
      servableNow: false,
      notServableReason: 'NOT_STARTED',
    });
    api.now.value = new Date('2026-09-26T12:00:00Z');
    const active = campaignSchema.parse(
      await ok(await admin(`/campaigns/${campaignId}/transition`, 'POST', { action: 'activate' })),
    );
    expect(active).toMatchObject({ status: 'active', servableNow: true });
    expect(
      (await admin(`/campaigns/${campaignId}/transition`, 'POST', { action: 'pause' })).status,
    ).toBe(400);
    const paused = campaignSchema.parse(
      await ok(
        await admin(`/campaigns/${campaignId}/transition`, 'POST', {
          action: 'pause',
          reason: 'Parent report review',
        }),
      ),
    );
    expect(paused).toMatchObject({
      status: 'paused',
      pausedReason: 'Parent report review',
      servableNow: false,
    });
    await ok(await admin(`/campaigns/${campaignId}/transition`, 'POST', { action: 'resume' }));
    // Expiry.
    api.now.value = new Date('2026-10-26T00:00:00Z');
    const [expired] = (
      await ok<{ campaigns: { id: string; notServableReason: string | null }[] }>(
        await admin('/campaigns'),
      )
    ).campaigns.filter((x) => x.id === campaignId);
    expect(expired!.notServableReason).toBe('EXPIRED');
    expect(
      await rule(await admin(`/campaigns/${campaignId}/transition`, 'POST', { action: 'resume' })),
    ).toBe('INVALID_TRANSITION');
    api.now.value = new Date('2026-09-26T12:00:00Z');
  });

  it('editing the creative creates a new version and sends the campaign back to review', async () => {
    const v3 = creativeSchema.parse(
      await ok(
        await admin(`/sponsors/${sponsorId}/creatives`, 'POST', {
          ...creativeInput,
          headline: 'New fall schedule',
        }),
        201,
      ),
    );
    const patched = campaignSchema.parse(
      await ok(await admin(`/campaigns/${campaignId}`, 'PATCH', { creativeId: v3.id })),
    );
    expect(patched).toMatchObject({ status: 'in_review', creativeId: v3.id, servableNow: false });
    const blocked = await admin(`/campaigns/${campaignId}/transition`, 'POST', {
      action: 'approve',
    });
    expect(await rule(blocked)).toBe('CREATIVE_NOT_APPROVED');
    await ok(await admin(`/creatives/${v3.id}/submit`, 'POST'));
    await ok(await admin(`/creatives/${v3.id}/approve`, 'POST', {}));
    await ok(await admin(`/campaigns/${campaignId}/transition`, 'POST', { action: 'approve' }));
    const reactivated = campaignSchema.parse(
      await ok(await admin(`/campaigns/${campaignId}/transition`, 'POST', { action: 'activate' })),
    );
    expect(reactivated.status).toBe('active');
    // Dates/caps edits do not need re-review; an approved creative version stays immutable.
    const capped = campaignSchema.parse(
      await ok(await admin(`/campaigns/${campaignId}`, 'PATCH', { impressionCap: 10 })),
    );
    expect(capped).toMatchObject({ status: 'active', impressionCap: 10 });
    await expect(
      api.db.sql`update public.sponsor_creatives set headline = 'Sneaky edit' where id = ${v3.id}`,
    ).rejects.toThrow(/create a new version/);
    // A foreign sponsor's creative can never be attached.
    const other = sponsorSchema.parse(
      await ok(
        await admin('/sponsors', 'POST', {
          ...sponsorInput,
          businessName: 'Cedar Books',
          allowedDomains: ['books.example'],
        }),
        201,
      ),
    );
    const foreign = creativeSchema.parse(
      await ok(
        await admin(`/sponsors/${other.id}/creatives`, 'POST', {
          ...creativeInput,
          destinationUrl: 'https://books.example/',
        }),
        201,
      ),
    );
    expect(
      (await admin(`/campaigns/${campaignId}`, 'PATCH', { creativeId: foreign.id })).status,
    ).toBe(404);
  });

  it('a sponsor rename never relabels a reviewed version; only a new reviewed version carries it (RV-MON-05)', async () => {
    const oak = sponsorSchema.parse(
      await ok(
        await admin('/sponsors', 'POST', {
          ...sponsorInput,
          businessName: 'Oak Tutoring',
          allowedDomains: ['oak.example'],
        }),
        201,
      ),
    );
    const v1 = creativeSchema.parse(
      await ok(
        await admin(`/sponsors/${oak.id}/creatives`, 'POST', {
          ...creativeInput,
          destinationUrl: 'https://www.oak.example/families',
        }),
        201,
      ),
    );
    expect(v1.sponsorName).toBe('Oak Tutoring');
    await ok(await admin(`/sponsors/${oak.id}`, 'PATCH', { businessName: 'Oak Tutoring Group' }));
    const listed = await ok<{ creatives: unknown[] }>(await admin(`/sponsors/${oak.id}/creatives`));
    const versions = listed.creatives.map((c) => creativeSchema.parse(c));
    expect(versions.map((c) => c.sponsorName)).toEqual(['Oak Tutoring']);
    const v2 = creativeSchema.parse(
      await ok(
        await admin(`/sponsors/${oak.id}/creatives`, 'POST', {
          ...creativeInput,
          destinationUrl: 'https://www.oak.example/families',
        }),
        201,
      ),
    );
    expect(v2).toMatchObject({ sponsorName: 'Oak Tutoring Group', reviewStatus: 'draft' });
  });

  it('suspending a sponsor stops serving', async () => {
    await ok(await admin(`/sponsors/${sponsorId}`, 'PATCH', { status: 'suspended' }));
    const list = await ok<{ campaigns: { id: string; notServableReason: string | null }[] }>(
      await admin('/campaigns'),
    );
    expect(list.campaigns.find((x) => x.id === campaignId)!.notServableReason).toBe(
      'SPONSOR_SUSPENDED',
    );
    await ok(await admin(`/sponsors/${sponsorId}`, 'PATCH', { status: 'active' }));
  });
});

describe('placement rules', () => {
  it('can lower but never raise the per-session cap or allow two cards per screen', async () => {
    await ok(
      await admin('/placement-rules/resources_browse', 'PUT', {
        maxCardsPerScreen: 1,
        maxNewCardsPerSession: 2,
        minVisibleMs: 1000,
        minVisibleRatio: 0.5,
        enabled: true,
      }),
    );
    for (const bad of [
      { maxNewCardsPerSession: 4 },
      { maxCardsPerScreen: 2 },
      { minVisibleRatio: 0.2 },
      { minVisibleMs: 100 },
    ]) {
      const res = await admin('/placement-rules/resources_browse', 'PUT', {
        maxCardsPerScreen: 1,
        maxNewCardsPerSession: 3,
        minVisibleMs: 1000,
        minVisibleRatio: 0.5,
        enabled: true,
        ...bad,
      });
      expect(res.status).toBe(400);
    }
    const rules = await ok<{ rules: { placement: string; maxNewCardsPerSession: number }[] }>(
      await admin('/placement-rules'),
    );
    expect(rules.rules.find((x) => x.placement === 'resources_browse')!.maxNewCardsPerSession).toBe(
      2,
    );
  });
});

describe('reviewed catalog and link checks (spec P10, AC_MON_12)', () => {
  const resourceInput = {
    stableKey: 'fraction-strips',
    title: 'Fraction strips',
    description: 'Colored strips for comparing fractions by length.',
    skills: ['fractions.compare'],
    subjects: ['math'],
    gradeMin: 3,
    gradeMax: 5,
    kind: 'manipulative',
    merchant: 'amazon',
    merchantUrl: 'https://www.amazon.com/Fraction-Strips-Classroom-Set/dp/B000TEST01?th=1',
    imageAssetRef: null,
    imageLicenseRef: null,
  };
  let itemId: string;
  let calls: { url: string; method: string }[];

  beforeEach(() => {
    calls = [];
  });

  const stub =
    (status: number): LinkCheckFetch =>
    (url, init) => {
      calls.push({ url, method: init.method });
      return Promise.resolve({ status });
    };

  it('canonicalizes Amazon product URLs and refuses pasted affiliate tags or other hosts', async () => {
    const item = catalogItemSchema.parse(
      await ok(await admin('/catalog', 'POST', resourceInput), 201),
    );
    itemId = item.id;
    expect(item).toMatchObject({
      merchantUrl: 'https://www.amazon.com/dp/B000TEST01',
      status: 'draft',
    });
    const tagged = await admin('/catalog', 'POST', {
      ...resourceInput,
      stableKey: 'tagged-link',
      merchantUrl: 'https://www.amazon.com/dp/B000TEST02?tag=someone-20',
    });
    expect(await rule(tagged)).toBe('AFFILIATE_PARAMS_PRESENT');
    const otherHost = await admin('/catalog', 'POST', {
      ...resourceInput,
      stableKey: 'other-host',
      merchant: 'other',
      merchantUrl: 'https://shop.example/fractions',
    });
    expect(await rule(otherHost)).toBe('HOST_NOT_ALLOWLISTED');
    const freeWithLink = await admin('/catalog', 'POST', {
      ...resourceInput,
      stableKey: 'free-link',
      kind: 'parent_exercise',
    });
    expect(freeWithLink.status).toBe(400);
    const markup = await admin('/catalog', 'POST', {
      ...resourceInput,
      stableKey: 'markup',
      title: '<b>Buy now</b>',
    });
    expect(markup.status).toBe(400);
  });

  it('approval records the reviewer; any later edit needs a fresh review', async () => {
    const approved = catalogItemSchema.parse(
      await ok(await admin(`/catalog/${itemId}/approve`, 'POST')),
    );
    expect(approved.status).toBe('approved');
    expect(approved.reviewedAt).not.toBeNull();
    const edited = catalogItemSchema.parse(
      await ok(
        await admin(`/catalog/${itemId}`, 'PATCH', {
          description: 'Updated factual description of the strips.',
        }),
      ),
    );
    expect(edited).toMatchObject({ status: 'draft', reviewedAt: null });
    await ok(await admin(`/catalog/${itemId}/approve`, 'POST'));
  });

  it('never makes a live request in tests: without a stub the check is skipped', async () => {
    const result = linkCheckResponseSchema.parse(
      await ok(await admin(`/catalog/${itemId}/link-check`, 'POST')),
    );
    expect(result.status).toBe('skipped');
  });

  it('checks the untagged canonical URL with HEAD and marks broken products unavailable', async () => {
    setLinkCheckFetchForTests(stub(404));
    const broken = linkCheckResponseSchema.parse(
      await ok(await admin(`/catalog/${itemId}/link-check`, 'POST')),
    );
    expect(broken).toMatchObject({
      status: 'broken',
      availability: 'unavailable',
      httpStatus: 404,
    });
    expect(calls).toEqual([{ url: 'https://www.amazon.com/dp/B000TEST01', method: 'HEAD' }]);
    setLinkCheckFetchForTests(stub(200));
    const fine = linkCheckResponseSchema.parse(
      await ok(await admin(`/catalog/${itemId}/link-check`, 'POST')),
    );
    expect(fine).toMatchObject({ status: 'ok', availability: 'available' });
    setLinkCheckFetchForTests(() => Promise.reject(new Error('timeout')));
    const failed = linkCheckResponseSchema.parse(
      await ok(await admin(`/catalog/${itemId}/link-check`, 'POST')),
    );
    expect(failed).toMatchObject({ status: 'error', availability: 'unknown' });
    setLinkCheckFetchForTests(null);
    const audit = await api.db
      .sql`select count(*)::int as n from public.audit_events where action = 'monetization.catalog_link_checked' and target_id = ${itemId}`;
    expect(audit[0]!.n).toBe(4);
  });
});

describe('revenue imports, adjustments and reporting (AC_MON_16..18)', () => {
  const importBody = {
    source: 'sponsor_invoice',
    periodMonth: '2026-09',
    note: 'September sponsor invoices',
    rows: [
      {
        externalRef: 'INV-2026-0901',
        category: 'contracted',
        provider: 'sponsor_direct',
        campaignId: null,
        placement: 'resources_browse',
        amountCents: 50000,
      },
      {
        externalRef: 'INV-2026-0901',
        category: 'recognized',
        provider: 'sponsor_direct',
        campaignId: null,
        placement: 'resources_browse',
        amountCents: 50000,
      },
      {
        externalRef: 'INV-2026-0901',
        category: 'received',
        provider: 'sponsor_direct',
        campaignId: null,
        placement: 'resources_browse',
        amountCents: 20000,
      },
      {
        externalRef: 'FORECAST-2026-09',
        category: 'projected',
        provider: 'sponsor_direct',
        campaignId: null,
        placement: 'adult_dashboard',
        amountCents: 900000,
      },
    ],
  };

  let recognizedEntry: string;

  it('imports once; a re-upload is DUPLICATE_IMPORT; a repeated row is DUPLICATE_ENTRY', async () => {
    const first = await ok<{ importId: string; rowCount: number }>(
      await admin('/revenue/imports', 'POST', importBody),
      201,
    );
    expect(first.rowCount).toBe(4);
    const again = await admin('/revenue/imports', 'POST', importBody);
    expect(again.status).toBe(409);
    expect(await rule(again)).toBe('DUPLICATE_IMPORT');
    const overlapping = await admin('/revenue/imports', 'POST', {
      ...importBody,
      note: 'Resent with a new note',
      rows: importBody.rows.slice(0, 1),
    });
    expect(overlapping.status).toBe(409);
    expect(await rule(overlapping)).toBe('DUPLICATE_ENTRY');
    const [imports] = await api.db.sql<
      { n: number }[]
    >`select count(*)::int as n from public.revenue_imports`;
    expect(imports!.n).toBe(1);
    const [entry] = await api.db.sql<
      { id: string }[]
    >`select id from public.revenue_entries where category = 'recognized'`;
    recognizedEntry = entry!.id;
  });

  it('validates provider/source consistency and placement for sponsor/network rows', async () => {
    const wrongProvider = await admin('/revenue/imports', 'POST', {
      ...importBody,
      source: 'amazon_report',
      rows: [{ ...importBody.rows[0], externalRef: 'X-1' }],
    });
    expect(wrongProvider.status).toBe(400);
    const noPlacement = await admin('/revenue/imports', 'POST', {
      ...importBody,
      rows: [{ ...importBody.rows[0], externalRef: 'X-2', placement: null }],
    });
    expect(noPlacement.status).toBe(400);
    const unknownCampaign = await admin('/revenue/imports', 'POST', {
      ...importBody,
      rows: [
        {
          ...importBody.rows[0],
          externalRef: 'X-3',
          campaignId: '00000000-0000-4000-8000-000000000000',
        },
      ],
    });
    expect(unknownCampaign.status).toBe(400);
  });

  it('reversals are separate, idempotent adjustments that can never take an entry below zero', async () => {
    const body = {
      entryId: recognizedEntry,
      kind: 'reversal',
      amountCents: -10000,
      reason: 'Partial credit note',
      idempotencyKey: 'rev-2026-09-0001',
    };
    const created = await ok<{ id: string; replayed: boolean }>(
      await admin('/revenue/adjustments', 'POST', body),
      201,
    );
    const replay = await ok<{ id: string; replayed: boolean }>(
      await admin('/revenue/adjustments', 'POST', body),
    );
    expect(replay).toEqual({ id: created.id, replayed: true });
    const conflict = await admin('/revenue/adjustments', 'POST', { ...body, amountCents: -1 });
    expect(conflict.status).toBe(409);
    const tooMuch = await admin('/revenue/adjustments', 'POST', {
      ...body,
      amountCents: -40001,
      idempotencyKey: 'rev-2026-09-0002',
    });
    expect(await rule(tooMuch)).toBe('ADJUSTMENT_EXCEEDS_ENTRY');
    const positiveRefund = await admin('/revenue/adjustments', 'POST', {
      ...body,
      kind: 'refund',
      amountCents: 100,
      idempotencyKey: 'rev-2026-09-0003',
    });
    expect(positiveRefund.status).toBe(400);
  });

  it('keeps projected/contracted/recognized/received separate and never double counts network revenue', async () => {
    await ok(
      await admin('/revenue/imports', 'POST', {
        source: 'manual',
        periodMonth: '2026-09',
        note: 'Hypothetical network totals for the same inventory',
        rows: [
          {
            externalRef: 'NET-2026-09',
            category: 'recognized',
            provider: 'ad_network',
            campaignId: null,
            placement: 'resources_browse',
            amountCents: 7000,
          },
        ],
      }),
      201,
    );
    // Three families (two from other tests' fixtures may exist) — all active families count.
    const extra: SeededFamily[] = [];
    for (let i = 0; i < 2; i += 1) extra.push(await seedFamily(api.db));
    const [families] = await api.db.sql<
      { n: number }[]
    >`select count(*)::int as n from public.families where deleted_at is null`;
    const [adults] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.family_memberships m join public.families f on f.id = m.family_id
       where m.status = 'active' and f.deleted_at is null`;
    const summary = revenueSummarySchema.parse(
      (({ month: _month, ...rest }) => rest)(
        await ok<{ month: string }>(await admin('/revenue/summary?month=2026-09')),
      ),
    );
    expect(summary).toMatchObject({
      projectedCents: 900000,
      contractedCents: 50000,
      recognizedCents: 40000,
      receivedCents: 20000,
      excludedDoubleCountCents: 7000,
      activeFamilies: families!.n,
      adEligibleAdults: adults!.n,
    });
    expect(summary.conflicts).toEqual([
      {
        category: 'recognized',
        placement: 'resources_browse',
        periodMonth: '2026-09',
        excludedNetworkCents: 7000,
      },
    ]);
    expect(summary.recognizedPerActiveFamilyCents).toBe(Math.round(40000 / families!.n));
    // Hiding sponsor cards removes an adult from the ad-eligible cohort but not from "all families".
    await api.db
      .sql`insert into public.family_monetization_prefs (family_id, hide_sponsor_cards) values (${extra[0]!.familyId}, true)`;
    const after = await ok<{ activeFamilies: number; adEligibleAdults: number }>(
      await admin('/revenue/summary?month=2026-09'),
    );
    expect(after.activeFamilies).toBe(families!.n);
    expect(after.adEligibleAdults).toBe(adults!.n - 1);
  });

  it('the ad-eligible cohort uses the serving ad-free rule: this billing environment, current access only', async () => {
    const eligible = async () =>
      (await ok<{ adEligibleAdults: number }>(await admin('/revenue/summary?month=2026-09')))
        .adEligibleAdults;
    const productionOnly = await seedFamily(api.db);
    const sandboxAdFree = await seedFamily(api.db);
    const lapsed = await seedFamily(api.db);
    const before = await eligible();
    await api.db.sql`
      insert into public.store_feature_mappings (channel, product_id, environment, feature, active) values
        ('app_store', 'fixture.cohort.adfree', 'sandbox', 'ad_free', true),
        ('app_store', 'fixture.cohort.adfree', 'production', 'ad_free', true)
    `;
    for (const [family, environment, periodEnd] of [
      // A production purchase never makes a family ad-free in this sandbox runtime.
      [productionOnly, 'production', '2026-10-10T00:00:00Z'],
      [sandboxAdFree, 'sandbox', '2026-10-10T00:00:00Z'],
      // An 'active' row whose period ended months ago (a lost expiry webhook) no longer grants.
      [lapsed, 'sandbox', '2026-06-01T00:00:00Z'],
    ] as const) {
      await api.db.sql`
        insert into public.family_entitlements (family_id, channel, provider_subscription_id, product_id, paid_slots, status,
          environment, period_start, period_end, provider_updated_at, fetched_at)
        values (${family.familyId}, 'app_store', ${`cohort_${family.familyId}`}, 'fixture.cohort.adfree', 0, 'active',
                ${environment}, '2026-05-01T00:00:00Z', ${periodEnd}, now(), now())
      `;
    }
    const [removed] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.family_memberships
       where family_id = ${sandboxAdFree.familyId} and status = 'active'`;
    expect(removed!.n).toBeGreaterThan(0);
    // Only the family that serving treats as ad-free leaves the reporting cohort, in both reports.
    expect(await eligible()).toBe(before - removed!.n);
    const report = await ok<{ revenue: { adEligibleAdults: number } }>(
      await admin('/report?month=2026-09'),
    );
    expect(report.revenue.adEligibleAdults).toBe(before - removed!.n);
    const served = await api.apiDb.asService(async (tx) =>
      Promise.all(
        [productionOnly, sandboxAdFree, lapsed].map((f) =>
          familyIsAdFree(tx, f.familyId, api.config.billingEnvironment, api.now.value),
        ),
      ),
    );
    expect(served).toEqual([false, true, false]);
  });

  it('aggregate report: totals only, small cells suppressed, no family/user/child ids, clicks are not sales', async () => {
    const [campaign] = await api.db.sql<
      { id: string }[]
    >`select id from public.sponsor_campaigns limit 1`;
    await api.db.sql`
      insert into public.aggregate_ad_events (campaign_id, event_date, platform, placement, kind, count) values
        (${campaign!.id}, '2026-09-20', 'ios', 'resources_browse', 'served', 40),
        (${campaign!.id}, '2026-09-21', 'ios', 'resources_browse', 'served', 2),
        (${campaign!.id}, '2026-09-20', 'ios', 'resources_browse', 'click', 3),
        (${campaign!.id}, '2026-09-20', 'web', 'resources_browse', 'viewable_impression', 12)
    `;
    const res = await admin('/report?month=2026-09');
    const report = monetizationReportSchema.parse(await ok(res));
    expect(report.minCohort).toBe(10);
    const cell = (platform: string, kind: string) =>
      report.events.find(
        (e) => e.campaignId === campaign!.id && e.platform === platform && e.kind === kind,
      )!;
    expect(cell('ios', 'served')).toMatchObject({ count: 42, suppressed: false });
    expect(cell('ios', 'click')).toMatchObject({ count: null, suppressed: true });
    expect(cell('web', 'viewable_impression')).toMatchObject({ count: 12, suppressed: false });
    // Clicks never become revenue: recognized revenue is unchanged by the click counters.
    expect(report.revenue.recognizedCents).toBe(40000);
    expect(report.revenueFromImportsOnly).toBe(true);
    const text = JSON.stringify(report);
    for (const id of [fam.familyId, fam.ownerId, fam.children[0]!.id, adminId])
      expect(text).not.toContain(id);
    expect(text).not.toMatch(/familyId|childId|userId|nickname|sessionId/i);
  });
});

describe('inappropriate-ad reports', () => {
  it('lists aggregate reports without reporter identity and records the review', async () => {
    const [campaign] = await api.db.sql<
      { id: string }[]
    >`select id from public.sponsor_campaigns limit 1`;
    const [report] = await api.db.sql<{ id: string }[]>`
      insert into public.ad_reports (campaign_id, category, platform, placement, created_date)
      values (${campaign!.id}, 'inappropriate', 'ios', 'resources_browse', '2026-09-24') returning id
    `;
    const list = await ok<{ reports: Record<string, unknown>[] }>(await admin('/ad-reports'));
    const row = list.reports.find((r) => r.id === report!.id)!;
    expect(Object.keys(row).sort()).toEqual(
      [
        'campaignId',
        'catalogId',
        'category',
        'createdDate',
        'id',
        'placement',
        'platform',
        'status',
      ].sort(),
    );
    await ok(await admin(`/ad-reports/${report!.id}/review`, 'POST'));
    expect((await admin(`/ad-reports/${report!.id}/review`, 'POST')).status).toBe(404);
  });
});
