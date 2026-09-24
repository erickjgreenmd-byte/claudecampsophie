// Synthetic, labeled fixtures for the P16 monetization API tests. Approvals use `fixture:` evidence,
// which the domain gate accepts only in development/test and reports as a mock (never "live").
import type { TestDb } from '@pencillift/db/testing';

export const IOS_PROPERTY = 'com.pencillift.app';
/** TEST_ENV CORS origin: the web property identifier in tests. */
export const WEB_PROPERTY = 'https://app.pencillift.test';

export async function setSwitches(
  db: TestDb,
  values: Partial<
    Record<'global' | 'sponsor_direct' | 'amazon_associates' | 'ad_network', boolean>
  >,
): Promise<void> {
  for (const [name, enabled] of Object.entries(values)) {
    const key = name === 'global' ? 'global' : `provider:${name}`;
    await db.sql`update public.monetization_switches set enabled = ${enabled}, reason = 'test fixture' where key = ${key}`;
  }
}

export async function fixtureApproval(
  db: TestDb,
  recordedBy: string,
  options: {
    provider: 'sponsor_direct' | 'amazon_associates' | 'ad_network';
    platform?: 'ios' | 'android' | 'web';
    property?: string;
    locale?: string;
    tag?: string | null;
    evidence?: string;
    expiresAt?: string;
    status?: 'pending' | 'approved';
  },
): Promise<string> {
  const platform = options.platform ?? 'ios';
  const [row] = await db.sql<{ id: string }[]>`
    insert into public.monetization_approvals
      (provider, platform, property_identifier, locale, intended_audience, policy_reviewed_at, evidence_ref,
       approval_scope, publisher_tag, status, expires_at, recorded_by)
    values (${options.provider}, ${platform}, ${options.property ?? (platform === 'web' ? WEB_PROPERTY : IOS_PROPERTY)},
            ${options.locale ?? 'en-US'}, 'Adults in the authenticated parent area (test fixture)', '2026-09-01T00:00:00Z',
            ${options.evidence ?? `fixture:${options.provider}-${platform}`}, 'Parent-only surfaces (test fixture)',
            ${options.tag === undefined ? (options.provider === 'amazon_associates' ? 'pencillift-20' : null) : options.tag},
            ${options.status ?? 'approved'}, ${options.expiresAt ?? '2027-03-01T00:00:00Z'}, ${recordedBy})
    returning id
  `;
  return row!.id;
}

export interface SponsorFixture {
  sponsorId: string;
  creativeId: string;
  campaignId: string;
}

let version = 0;

export async function fixtureCampaign(
  db: TestDb,
  adminId: string,
  options: {
    name?: string;
    placement?: 'adult_dashboard' | 'resources_browse';
    platforms?: string[];
    startsAt?: string;
    endsAt?: string;
    impressionCap?: number;
    status?: 'active' | 'scheduled' | 'draft';
    domain?: string;
  } = {},
): Promise<SponsorFixture> {
  const domain = options.domain ?? 'tutoring.example';
  const [sponsor] = await db.sql<{ id: string }[]>`
    insert into public.sponsors (business_name, allowed_domains, created_by)
    values (${options.name ?? 'Maple Tutoring'}, ${[domain]}, ${adminId}) returning id
  `;
  version += 1;
  const [creative] = await db.sql<{ id: string }[]>`
    insert into public.sponsor_creatives (sponsor_id, version, headline, body, cta_label, destination_url, created_by)
    values (${sponsor!.id}, ${version}, 'Small-group reading tutoring', 'Certified tutors for grades 1-5.', 'Learn more',
            ${`https://www.${domain}/families`}, ${adminId})
    returning id
  `;
  await db.sql`update public.sponsor_creatives set review_status = 'in_review' where id = ${creative!.id}`;
  await db.sql`update public.sponsor_creatives set review_status = 'approved', reviewed_by = ${adminId}, reviewed_at = now() where id = ${creative!.id}`;
  const [campaign] = await db.sql<{ id: string }[]>`
    insert into public.sponsor_campaigns
      (sponsor_id, creative_id, name, placement, platforms, starts_at, ends_at, impression_cap, fee_model,
       contracted_fee_cents, created_by)
    values (${sponsor!.id}, ${creative!.id}, 'Fall reading', ${options.placement ?? 'resources_browse'},
            ${options.platforms ?? ['ios', 'android', 'web']}, ${options.startsAt ?? '2026-09-01T00:00:00Z'},
            ${options.endsAt ?? '2026-10-01T00:00:00Z'}, ${options.impressionCap ?? 10000}, 'fixed_fee', 50000, ${adminId})
    returning id
  `;
  const target = options.status ?? 'active';
  if (target !== 'draft') {
    await db.sql`update public.sponsor_campaigns set status = 'in_review' where id = ${campaign!.id}`;
    await db.sql`update public.sponsor_campaigns set status = 'scheduled' where id = ${campaign!.id}`;
    if (target === 'active') {
      await db.sql`update public.sponsor_campaigns set status = 'active' where id = ${campaign!.id}`;
    }
  }
  return { sponsorId: sponsor!.id, creativeId: creative!.id, campaignId: campaign!.id };
}

export async function fixtureResource(
  db: TestDb,
  adminId: string,
  values: {
    key: string;
    kind?: 'workbook' | 'flashcards' | 'manipulative' | 'parent_exercise' | 'in_app_practice';
    merchant?: 'amazon' | 'none';
    url?: string | null;
    subjects?: string[];
    skills?: string[];
    gradeMin?: number;
    gradeMax?: number;
    availability?: 'available' | 'unavailable' | 'unknown';
    status?: 'draft' | 'approved' | 'retired';
  },
): Promise<string> {
  const merchant = values.merchant ?? 'amazon';
  const approved = (values.status ?? 'approved') === 'approved';
  const [row] = await db.sql<{ id: string }[]>`
    insert into public.resource_catalog
      (stable_key, title, description, skills, subjects, grade_min, grade_max, kind, merchant, merchant_url,
       availability, status, reviewed_by, reviewed_at, created_by)
    values (${values.key}, ${'Resource ' + values.key}, 'A reviewed synthetic learning resource description.',
            ${values.skills ?? ['fractions.compare']}, ${values.subjects ?? ['math']}, ${values.gradeMin ?? 3},
            ${values.gradeMax ?? 4}, ${values.kind ?? 'workbook'}, ${merchant},
            ${values.url === undefined ? (merchant === 'amazon' ? 'https://www.amazon.com/dp/B000TEST01' : null) : values.url},
            ${values.availability ?? 'available'}, ${values.status ?? 'approved'},
            ${approved ? adminId : null}, ${approved ? new Date('2026-09-10T00:00:00Z') : null}, ${adminId})
    returning id
  `;
  return row!.id;
}

/** Tables a commercial event must never write (AC_MON_13). */
export async function nonCommercialLedgerCounts(db: TestDb): Promise<Record<string, number>> {
  const [row] = await db.sql<Record<string, number>[]>`
    select (select count(*)::int from public.points_ledger) as points_ledger,
           (select count(*)::int from public.reward_redemptions) as reward_redemptions,
           (select count(*)::int from public.usage_reservations) as usage_reservations,
           (select count(*)::int from public.promo_redemptions) as promo_redemptions
  `;
  return row!;
}
