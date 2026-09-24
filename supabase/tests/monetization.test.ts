import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb, type Tx } from './harness.ts';
import { childClaims, seedFamily, seedOwnerAdmin, type SeededFamily } from './fixtures.ts';

/**
 * P16 monetization schema (0640): admin/API-only tables with RLS and no client grants, immutable
 * creative versions, the campaign workflow guard, append-only revenue ledgers, aggregate-only
 * counters and private serve state. Synthetic data only.
 */

let db: TestDb;
let fam: SeededFamily;
let other: SeededFamily;
let adminId: string;
let sponsorId: string;

const PUBLIC_TABLES = [
  'sponsors',
  'sponsor_creatives',
  'sponsor_campaigns',
  'placement_rules',
  'monetization_approvals',
  'monetization_switches',
  'resource_catalog',
  'family_monetization_prefs',
  'store_feature_mappings',
  'aggregate_ad_events',
  'ad_reports',
  'revenue_imports',
  'revenue_entries',
  'revenue_adjustments',
] as const;

const ADMIN_ONLY = PUBLIC_TABLES.filter((t) => t !== 'family_monetization_prefs');

let seq = 0;
const next = () => (seq += 1);

async function creative(
  status: 'draft' | 'approved' = 'approved',
  sponsor = sponsorId,
): Promise<string> {
  const [row] = await db.sql<{ id: string }[]>`
    insert into public.sponsor_creatives (sponsor_id, version, headline, body, cta_label, destination_url, created_by)
    values (${sponsor}, ${next()}, 'Reading tutoring', 'Small groups for grades 1-5.', 'Learn more',
            'https://www.tutoring.example/families', ${adminId})
    returning id
  `;
  if (status === 'approved') {
    await db.sql`update public.sponsor_creatives set review_status = 'in_review' where id = ${row!.id}`;
    await db.sql`update public.sponsor_creatives set review_status = 'approved', reviewed_by = ${adminId}, reviewed_at = now() where id = ${row!.id}`;
  }
  return row!.id;
}

async function campaign(creativeId: string): Promise<string> {
  const [row] = await db.sql<{ id: string }[]>`
    insert into public.sponsor_campaigns
      (sponsor_id, creative_id, name, placement, platforms, starts_at, ends_at, impression_cap, fee_model,
       contracted_fee_cents, created_by)
    values (${sponsorId}, ${creativeId}, 'Fall reading', 'resources_browse', '{ios,web}',
            '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', 5000, 'fixed_fee', 50000, ${adminId})
    returning id
  `;
  return row!.id;
}

async function setStatus(id: string, status: string, reason: string | null = null) {
  return db.sql`update public.sponsor_campaigns set status = ${status}, paused_reason = ${reason} where id = ${id}`;
}

async function statusOf(id: string): Promise<string> {
  const [row] = await db.sql<
    { status: string }[]
  >`select status from public.sponsor_campaigns where id = ${id}`;
  return row!.status;
}

beforeAll(async () => {
  db = await createTestDb();
  fam = await seedFamily(db, { childCount: 1 });
  other = await seedFamily(db, { childCount: 1 });
  adminId = await seedOwnerAdmin(db);
  const [s] = await db.sql<{ id: string }[]>`
    insert into public.sponsors (business_name, allowed_domains, created_by)
    values ('Maple Tutoring (synthetic)', '{tutoring.example}', ${adminId}) returning id
  `;
  sponsorId = s!.id;
  await db.sql`insert into public.family_monetization_prefs (family_id, hide_affiliate) values (${fam.familyId}, true)`;
  await db.sql`insert into public.family_monetization_prefs (family_id) values (${other.familyId})`;
});

afterAll(async () => {
  await db?.drop();
});

async function denied(fn: () => Promise<unknown>) {
  await expect(fn()).rejects.toThrow(/permission denied/);
}

describe('client roles cannot read or write monetization tables', () => {
  it('select * as a parent, an MFA owner admin, a child or anon is refused on admin tables', async () => {
    for (const table of ADMIN_ONLY) {
      await denied(() =>
        db.asParent(fam.ownerId, (tx) => tx.unsafe(`select * from public.${table}`)),
      );
      await denied(() =>
        db.asParent(adminId, (tx) => tx.unsafe(`select * from public.${table}`), { aal: 'aal2' }),
      );
      await denied(() =>
        db.asChild(childClaims(fam), (tx) => tx.unsafe(`select * from public.${table}`)),
      );
      await denied(() => db.asAnon((tx) => tx.unsafe(`select * from public.${table}`)));
    }
  });

  it('no client role holds any privilege on the admin tables (catalog check)', async () => {
    const rows = await db.sql<{ grantee: string; table_name: string; privilege_type: string }[]>`
      select grantee, table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = any(${[...ADMIN_ONLY]})
         and grantee in ('anon', 'authenticated', 'pl_child', 'PUBLIC')
    `;
    expect(rows).toEqual([]);
  });

  it('family prefs: members read only their own row (granted columns); nobody writes directly', async () => {
    const own = await db.asParent(
      fam.ownerId,
      (tx) => tx`select family_id, hide_affiliate from public.family_monetization_prefs`,
    );
    expect(own).toEqual([{ family_id: fam.familyId, hide_affiliate: true }]);
    await denied(() =>
      db.asParent(fam.ownerId, (tx) => tx`select * from public.family_monetization_prefs`),
    );
    await denied(() =>
      db.asParent(
        fam.ownerId,
        (tx) =>
          tx`update public.family_monetization_prefs set hide_sponsor_cards = true where family_id = ${fam.familyId}`,
      ),
    );
    await denied(() =>
      db.asParent(
        other.ownerId,
        (tx) =>
          tx`insert into public.family_monetization_prefs (family_id) values (${fam.familyId})`,
      ),
    );
    await denied(() =>
      db.asChild(
        childClaims(fam),
        (tx) => tx`select family_id from public.family_monetization_prefs`,
      ),
    );
    await denied(() =>
      db.asAnon((tx) => tx`select family_id from public.family_monetization_prefs`),
    );
  });

  it('writes are refused for every client role', async () => {
    const attempts: ((tx: Tx) => Promise<unknown>)[] = [
      (tx) =>
        tx`insert into public.sponsors (business_name, allowed_domains, created_by) values ('X Co', '{x.example}', ${fam.ownerId})`,
      (tx) => tx`update public.monetization_switches set enabled = true where key = 'global'`,
      (tx) => tx`delete from public.placement_rules`,
      (tx) =>
        tx`insert into public.aggregate_ad_events (event_date, platform, placement, kind, count) values ('2026-09-24', 'ios', 'adult_dashboard', 'click', 99)`,
      (tx) =>
        tx`insert into public.ad_reports (catalog_id, category, platform, placement, created_date) values (gen_random_uuid(), 'other', 'ios', 'adult_dashboard', '2026-09-24')`,
      (tx) => tx`update public.store_feature_mappings set active = true`,
    ];
    for (const attempt of attempts) {
      await denied(() => db.asParent(fam.ownerId, attempt));
      await denied(() => db.asParent(adminId, attempt, { aal: 'aal2' }));
      await denied(() => db.asChild(childClaims(fam), attempt));
      await denied(() => db.asAnon(attempt));
    }
  });

  it('private.placement_serves is not reachable by any client role', async () => {
    await denied(() =>
      db.asParent(fam.ownerId, (tx) => tx`select * from private.placement_serves`),
    );
    await denied(() =>
      db.asChild(childClaims(fam), (tx) => tx`select * from private.placement_serves`),
    );
    await denied(() => db.asAnon((tx) => tx`select * from private.placement_serves`));
    const rows = await db.asService(
      (tx) => tx`select count(*)::int as n from private.placement_serves`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('counters, reports and revenue tables carry no family, user, child or session column', async () => {
    const rows = await db.sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
       where table_schema in ('public', 'private')
         and table_name in ('aggregate_ad_events', 'ad_reports', 'placement_serves', 'revenue_entries', 'revenue_imports')
         and (column_name ~ '(family|child|user|nickname|grade|session_id|ip)' )
    `;
    expect(rows).toEqual([]);
  });
});

describe('defaults', () => {
  it('monetization is off by default: every switch disabled', async () => {
    const rows = await db.sql<
      { key: string; enabled: boolean }[]
    >`select key, enabled from public.monetization_switches order by key`;
    expect(rows).toEqual([
      { key: 'global', enabled: false },
      { key: 'provider:ad_network', enabled: false },
      { key: 'provider:amazon_associates', enabled: false },
      { key: 'provider:sponsor_direct', enabled: false },
    ]);
  });

  it('placement rules default to one card per screen, three per session, 1s at 50%', async () => {
    const rows =
      await db.sql`select placement, max_cards_per_screen, max_new_cards_per_session, min_visible_ms, min_visible_ratio::text as ratio, enabled from public.placement_rules order by placement`;
    expect(rows).toEqual([
      {
        placement: 'adult_dashboard',
        max_cards_per_screen: 1,
        max_new_cards_per_session: 3,
        min_visible_ms: 1000,
        ratio: '0.50',
        enabled: true,
      },
      {
        placement: 'resources_browse',
        max_cards_per_screen: 1,
        max_new_cards_per_session: 3,
        min_visible_ms: 1000,
        ratio: '0.50',
        enabled: true,
      },
    ]);
    await expect(
      db.sql`update public.placement_rules set max_cards_per_screen = 2`,
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.sql`update public.placement_rules set max_new_cards_per_session = 4`,
    ).rejects.toThrow(/check constraint/);
  });

  it('no ad-free store mapping is seeded and new mappings are inactive', async () => {
    expect(await db.sql`select * from public.store_feature_mappings`).toHaveLength(0);
    const [row] = await db.sql<{ active: boolean }[]>`
      insert into public.store_feature_mappings (channel, product_id, environment, feature)
      values ('app_store', 'fixture.adfree.monthly', 'sandbox', 'ad_free') returning active
    `;
    expect(row!.active).toBe(false);
  });
});

describe('creative versions are immutable once reviewed (AC_MON_06)', () => {
  it('rejects markup, remote images and unlicensed images at the database layer too', async () => {
    const base = { sponsor: sponsorId, by: adminId };
    await expect(db.sql`
      insert into public.sponsor_creatives (sponsor_id, version, headline, body, cta_label, destination_url, created_by)
      values (${base.sponsor}, ${next()}, '<script>x</script>', 'Body text here', 'Go', 'https://www.tutoring.example/', ${base.by})
    `).rejects.toThrow(/check constraint/);
    await expect(db.sql`
      insert into public.sponsor_creatives (sponsor_id, version, headline, body, cta_label, destination_url, created_by)
      values (${base.sponsor}, ${next()}, 'Tutoring', 'Body text here', 'Go', 'http://www.tutoring.example/', ${base.by})
    `).rejects.toThrow(/check constraint/);
    await expect(db.sql`
      insert into public.sponsor_creatives (sponsor_id, version, headline, body, cta_label, destination_url, image_asset_ref, image_license_ref, created_by)
      values (${base.sponsor}, ${next()}, 'Tutoring', 'Body text here', 'Go', 'https://www.tutoring.example/', 'https://ads.example/p.gif', 'LIC-123456', ${base.by})
    `).rejects.toThrow(/check constraint/);
    await expect(db.sql`
      insert into public.sponsor_creatives (sponsor_id, version, headline, body, cta_label, destination_url, image_asset_ref, created_by)
      values (${base.sponsor}, ${next()}, 'Tutoring', 'Body text here', 'Go', 'https://www.tutoring.example/', 'sponsors/logo.png', ${base.by})
    `).rejects.toThrow(/check constraint/);
  });

  it('new versions start as drafts; content never changes; approved rows are frozen', async () => {
    await expect(db.sql`
      insert into public.sponsor_creatives (sponsor_id, version, headline, body, cta_label, destination_url, review_status, created_by)
      values (${sponsorId}, ${next()}, 'Tutoring', 'Body text here', 'Go', 'https://www.tutoring.example/', 'approved', ${adminId})
    `).rejects.toThrow(/starts as a draft/);
    const draft = await creative('draft');
    await expect(
      db.sql`update public.sponsor_creatives set headline = 'Edited' where id = ${draft}`,
    ).rejects.toThrow(/immutable/);
    const approved = await creative('approved');
    await expect(
      db.sql`update public.sponsor_creatives set headline = 'Edited' where id = ${approved}`,
    ).rejects.toThrow(/create a new version/);
    await expect(
      db.sql`update public.sponsor_creatives set review_status = 'draft', reviewed_by = null, reviewed_at = null where id = ${approved}`,
    ).rejects.toThrow(/create a new version/);
    await expect(
      db.sql`delete from public.sponsor_creatives where id = ${approved}`,
    ).rejects.toThrow(/never deleted/);
  });

  it('approval requires a recorded reviewer', async () => {
    const draft = await creative('draft');
    await db.sql`update public.sponsor_creatives set review_status = 'in_review' where id = ${draft}`;
    await expect(
      db.sql`update public.sponsor_creatives set review_status = 'approved' where id = ${draft}`,
    ).rejects.toThrow(/check constraint/);
  });
});

describe('campaign workflow guard (AC_MON_06)', () => {
  it('campaigns start as drafts and follow draft -> review -> scheduled -> active', async () => {
    const id = await campaign(await creative('approved'));
    await expect(setStatus(id, 'active')).rejects.toThrow(/invalid campaign transition/);
    await setStatus(id, 'in_review');
    await setStatus(id, 'scheduled');
    await setStatus(id, 'active');
    await expect(setStatus(id, 'paused')).rejects.toThrow(/check constraint/);
    await setStatus(id, 'paused', 'Owner review of a report');
    await setStatus(id, 'active');
    expect(await statusOf(id)).toBe('active');
  });

  it('an unapproved creative can never be scheduled or active', async () => {
    const id = await campaign(await creative('draft'));
    await setStatus(id, 'in_review');
    await expect(setStatus(id, 'scheduled')).rejects.toThrow(/approved creative/);
  });

  it('a creative change sends a live campaign back to review', async () => {
    const id = await campaign(await creative('approved'));
    await setStatus(id, 'in_review');
    await setStatus(id, 'scheduled');
    await setStatus(id, 'active');
    const newVersion = await creative('draft');
    await db.sql`update public.sponsor_campaigns set creative_id = ${newVersion} where id = ${id}`;
    expect(await statusOf(id)).toBe('in_review');
    await expect(
      db.sql`update public.sponsor_campaigns set creative_id = ${await creative('approved')}, status = 'active' where id = ${id}`,
    ).rejects.toThrow(/invalid campaign transition/);
  });

  it('a campaign cannot use another sponsor’s creative', async () => {
    const [s2] = await db.sql<{ id: string }[]>`
      insert into public.sponsors (business_name, allowed_domains, created_by)
      values ('Cedar Books (synthetic)', '{books.example}', ${adminId}) returning id
    `;
    const foreign = await creative('approved', s2!.id);
    await expect(campaign(foreign)).rejects.toThrow(/foreign key/);
  });

  it('ended campaigns are frozen except invoice bookkeeping; campaigns are never deleted', async () => {
    const id = await campaign(await creative('approved'));
    await setStatus(id, 'in_review');
    await setStatus(id, 'scheduled');
    await setStatus(id, 'ended');
    await db.sql`update public.sponsor_campaigns set invoice_status = 'paid' where id = ${id}`;
    await expect(setStatus(id, 'active')).rejects.toThrow(/ended/);
    await expect(
      db.sql`update public.sponsor_campaigns set impression_cap = 99999 where id = ${id}`,
    ).rejects.toThrow(/ended/);
    await expect(db.sql`delete from public.sponsor_campaigns where id = ${id}`).rejects.toThrow(
      /never deleted/,
    );
  });

  it('a suspended sponsor cannot have scheduled/active campaigns', async () => {
    const [s3] = await db.sql<{ id: string }[]>`
      insert into public.sponsors (business_name, allowed_domains, created_by, status)
      values ('Birch Learning (synthetic)', '{birch.example}', ${adminId}, 'suspended') returning id
    `;
    const cr = await creative('approved', s3!.id);
    const [row] = await db.sql<{ id: string }[]>`
      insert into public.sponsor_campaigns (sponsor_id, creative_id, name, placement, platforms, starts_at, ends_at, impression_cap, fee_model, created_by)
      values (${s3!.id}, ${cr}, 'Suspended', 'adult_dashboard', '{web}', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', 10, 'none', ${adminId})
      returning id
    `;
    await setStatus(row!.id, 'in_review');
    await expect(setStatus(row!.id, 'scheduled')).rejects.toThrow(/suspended/);
  });
});

describe('approvals: evidence is required and immutable (AC_MON_09)', () => {
  async function insertApproval(
    overrides: { evidence?: string; provider?: string; tag?: string | null } = {},
  ) {
    const [row] = await db.sql<{ id: string }[]>`
      insert into public.monetization_approvals
        (provider, platform, property_identifier, locale, intended_audience, policy_reviewed_at, evidence_ref,
         approval_scope, publisher_tag, expires_at, recorded_by)
      values (${overrides.provider ?? 'amazon_associates'}, 'ios', 'com.pencillift.app', 'en-US',
              'Adults in the authenticated parent area', '2026-09-01T00:00:00Z',
              ${overrides.evidence ?? 'OWNER-DOC/eligibility-2026-09#1'}, 'Parent resource browser links',
              ${overrides.tag === undefined ? 'pencillift-20' : overrides.tag}, '2027-03-01T00:00:00Z', ${adminId})
      returning id
    `;
    return row!.id;
  }

  it('placeholder evidence and tags on non-Amazon providers are refused', async () => {
    await expect(insertApproval({ evidence: 'approved' })).rejects.toThrow(/check constraint/);
    await expect(insertApproval({ evidence: 'true' })).rejects.toThrow(/check constraint/);
    await expect(insertApproval({ provider: 'sponsor_direct' })).rejects.toThrow(
      /check constraint/,
    );
    await expect(insertApproval({ tag: 'not a tag' })).rejects.toThrow(/check constraint/);
  });

  it('only status moves; evidence changes need a new record; revoked is final', async () => {
    const id = await insertApproval();
    await expect(
      db.sql`update public.monetization_approvals set evidence_ref = 'OTHER-DOC/2026' where id = ${id}`,
    ).rejects.toThrow(/immutable/);
    await db.sql`update public.monetization_approvals set status = 'approved' where id = ${id}`;
    await db.sql`update public.monetization_approvals set status = 'revoked', status_reason = 'Owner pause' where id = ${id}`;
    await expect(
      db.sql`update public.monetization_approvals set status = 'approved' where id = ${id}`,
    ).rejects.toThrow(/invalid approval transition/);
    await expect(
      db.sql`delete from public.monetization_approvals where id = ${id}`,
    ).rejects.toThrow(/never deleted/);
  });
});

describe('resource catalog constraints (spec P10, P16.3)', () => {
  async function insertResource(values: {
    merchant: string;
    url: string | null;
    kind?: string;
    key?: string;
  }) {
    return db.sql`
      insert into public.resource_catalog (stable_key, title, description, skills, subjects, grade_min, grade_max, kind, merchant, merchant_url, created_by)
      values (${values.key ?? `res-${next()}`}, 'Fraction strips', 'Colored strips for comparing fractions by length.',
              '{fractions.compare}', '{math}', 3, 5, ${values.kind ?? 'manipulative'}, ${values.merchant}, ${values.url}, ${adminId})
    `;
  }

  it('accepts only canonical amazon.com product URLs with no query or tag', async () => {
    await insertResource({ merchant: 'amazon', url: 'https://www.amazon.com/dp/B000TEST01' });
    for (const url of [
      'https://www.amazon.com/dp/B000TEST01?tag=someone-20',
      'https://www.amazon.co.uk/dp/B000TEST01',
      'http://www.amazon.com/dp/B000TEST01',
      'https://www.amazon.com/s?k=fractions',
    ]) {
      await expect(insertResource({ merchant: 'amazon', url })).rejects.toThrow(/check constraint/);
    }
  });

  it('free learning options never carry a merchant link; approval needs a reviewer', async () => {
    await expect(
      insertResource({
        merchant: 'amazon',
        url: 'https://www.amazon.com/dp/B000TEST02',
        kind: 'parent_exercise',
      }),
    ).rejects.toThrow(/check constraint/);
    await insertResource({
      merchant: 'none',
      url: null,
      kind: 'parent_exercise',
      key: 'kitchen-fractions',
    });
    await expect(
      db.sql`update public.resource_catalog set status = 'approved' where stable_key = 'kitchen-fractions'`,
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.sql`delete from public.resource_catalog where stable_key = 'kitchen-fractions'`,
    ).rejects.toThrow(/never deleted/);
  });
});

describe('aggregate counters and revenue ledgers', () => {
  it('counters are unique per cell (nulls not distinct) and only increase', async () => {
    await db.sql`insert into public.aggregate_ad_events (event_date, platform, placement, kind, count) values ('2026-09-24', 'ios', 'adult_dashboard', 'opportunity', 1)`;
    await expect(
      db.sql`insert into public.aggregate_ad_events (event_date, platform, placement, kind, count) values ('2026-09-24', 'ios', 'adult_dashboard', 'opportunity', 1)`,
    ).rejects.toThrow(/aggregate_ad_events_cell/);
    await db.sql`update public.aggregate_ad_events set count = count + 1 where kind = 'opportunity'`;
    await expect(
      db.sql`update public.aggregate_ad_events set count = 0 where kind = 'opportunity'`,
    ).rejects.toThrow(/only increase/);
    await expect(db.sql`delete from public.aggregate_ad_events`).rejects.toThrow(/never deleted/);
  });

  it('imports deduplicate by file hash and entry key; the ledger is append-only', async () => {
    const hash = 'a'.repeat(64);
    const [imp] = await db.sql<{ id: string }[]>`
      insert into public.revenue_imports (source, file_sha256, period_month, imported_by, row_count)
      values ('sponsor_invoice', ${hash}, '2026-09', ${adminId}, 1) returning id
    `;
    await expect(db.sql`
      insert into public.revenue_imports (source, file_sha256, period_month, imported_by, row_count)
      values ('sponsor_invoice', ${hash}, '2026-09', ${adminId}, 1)
    `).rejects.toThrow(/file_sha256/);
    const [entry] = await db.sql<{ id: string }[]>`
      insert into public.revenue_entries (import_id, source, external_ref, category, provider, placement, amount_cents, period_month)
      values (${imp!.id}, 'sponsor_invoice', 'INV-1001', 'recognized', 'sponsor_direct', 'resources_browse', 50000, '2026-09')
      returning id
    `;
    await expect(db.sql`
      insert into public.revenue_entries (import_id, source, external_ref, category, provider, placement, amount_cents, period_month)
      values (${imp!.id}, 'sponsor_invoice', 'INV-1001', 'recognized', 'sponsor_direct', 'resources_browse', 50000, '2026-09')
    `).rejects.toThrow(/revenue_entries_source_external_ref_category_key/);
    await expect(db.sql`
      insert into public.revenue_entries (import_id, source, external_ref, category, provider, placement, amount_cents, period_month)
      values (${imp!.id}, 'amazon_report', 'X-1', 'recognized', 'sponsor_direct', 'resources_browse', 1, '2026-09')
    `).rejects.toThrow(/foreign key/);
    await expect(
      db.sql`update public.revenue_entries set amount_cents = 1 where id = ${entry!.id}`,
    ).rejects.toThrow(/append-only/);
    await expect(db.sql`delete from public.revenue_imports where id = ${imp!.id}`).rejects.toThrow(
      /append-only/,
    );

    await db.sql`
      insert into public.revenue_adjustments (entry_id, kind, amount_cents, reason, idempotency_key, created_by)
      values (${entry!.id}, 'reversal', -30000, 'Partial credit note', 'adj-key-0001', ${adminId})
    `;
    await expect(db.sql`
      insert into public.revenue_adjustments (entry_id, kind, amount_cents, reason, idempotency_key, created_by)
      values (${entry!.id}, 'refund', -20001, 'Too much', 'adj-key-0002', ${adminId})
    `).rejects.toThrow(/below zero/);
    await expect(db.sql`
      insert into public.revenue_adjustments (entry_id, kind, amount_cents, reason, idempotency_key, created_by)
      values (${entry!.id}, 'refund', 500, 'Positive refund', 'adj-key-0003', ${adminId})
    `).rejects.toThrow(/check constraint/);
    await expect(db.sql`delete from public.revenue_adjustments`).rejects.toThrow(/append-only/);
  });

  it('sponsor/network revenue must name its placement (same-inventory double-count guard)', async () => {
    const [imp] = await db.sql<{ id: string }[]>`
      insert into public.revenue_imports (source, file_sha256, period_month, imported_by, row_count)
      values ('ad_network', ${'b'.repeat(64)}, '2026-09', ${adminId}, 1) returning id
    `;
    await expect(db.sql`
      insert into public.revenue_entries (import_id, source, external_ref, category, provider, amount_cents, period_month)
      values (${imp!.id}, 'ad_network', 'NET-1', 'recognized', 'ad_network', 700, '2026-09')
    `).rejects.toThrow(/check constraint/);
  });
});
