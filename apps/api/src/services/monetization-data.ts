import { grantsAccess, type EntitlementStatus } from '@pencillift/domain/entitlements';
import {
  AMAZON_ASSOCIATES_DISCLOSURE,
  PLAIN_LINK_DISCLOSURE,
  type CampaignState,
  type MerchantMode,
  type MonetizationApproval,
  type MonetizationPlatform,
  type MonetizationProperty,
  type MonetizationSwitches,
  type Placement,
  type PlacementRule,
  type ServableCampaignFacts,
  type SwitchKey,
} from '@pencillift/domain/monetization';
import type { ApiConfig } from '../config.ts';
import type { Tx } from '../db.ts';
import { hmacSha256, sha256Hex, toHex } from '../security/crypto.ts';

/**
 * Database loaders shared by the parent monetization routes and the owner console (spec P16).
 * Every query here runs inside a service-role transaction opened by a handler that has already
 * verified the caller; nothing returned here carries a child identifier or learning data.
 */

/**
 * The deployed properties a request can be served from. Mobile identifiers are the PROPOSED bundle
 * id / package name in apps/mobile/app.config.ts (owner must confirm before store registration);
 * the web property is the configured web app origin. An approval must name the same identifier.
 */
export const MOBILE_PROPERTY_IDENTIFIERS: Readonly<Record<'ios' | 'android', string>> = {
  ios: 'com.pencillift.app',
  android: 'com.pencillift.app',
};

/** Locales whose marketplace matches the catalog's amazon.com links (plain links permitted). */
export const LINK_LOCALES: ReadonlySet<string> = new Set(['en-US']);
export const DEFAULT_LOCALE = 'en-US';

export function propertyFor(
  config: ApiConfig,
  platform: MonetizationPlatform,
  locale: string,
): MonetizationProperty {
  const identifier =
    platform === 'web'
      ? (config.corsOrigins[0] ?? 'web:unconfigured')
      : MOBILE_PROPERTY_IDENTIFIERS[platform];
  return { platform, identifier, locale };
}

export function disclosureFor(mode: MerchantMode): string | null {
  if (mode === 'amazon_associates') return AMAZON_ASSOCIATES_DISCLOSURE;
  if (mode === 'plain_link') return PLAIN_LINK_DISCLOSURE;
  return null;
}

export const WHY_SHOWN: Readonly<Record<Placement, string>> = {
  resources_browse: 'Shown in the parent resource directory.',
  adult_dashboard: 'Shown on the parent dashboard.',
};

/** UTC calendar date used for aggregate counters. */
export function eventDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Pseudonymous key for per-session frequency state: a peppered HMAC of the Supabase auth session
 * id, so the serve table holds no family/user id and a dump cannot be joined back without the pepper.
 */
export async function sessionKeyHash(config: ApiConfig, sessionId: string): Promise<string> {
  return toHex(await hmacSha256(config.hashPepper, `placement-session:${sessionId}`));
}

export function serveTokenHash(token: string): Promise<string> {
  return sha256Hex(`placement-serve:${token}`);
}

export async function loadSwitches(tx: Tx): Promise<MonetizationSwitches> {
  const rows = await tx<{ key: SwitchKey; enabled: boolean }[]>`
    select key, enabled from public.monetization_switches
  `;
  const out: Partial<Record<SwitchKey, boolean>> = {};
  for (const row of rows) out[row.key] = row.enabled;
  return out;
}

interface ApprovalRow {
  id: string;
  provider: MonetizationApproval['provider'];
  platform: MonetizationPlatform;
  property_identifier: string;
  locale: string;
  status: MonetizationApproval['status'];
  policy_reviewed_at: Date;
  expires_at: Date;
  evidence_ref: string;
  publisher_tag: string | null;
}

export async function loadApprovals(tx: Tx): Promise<MonetizationApproval[]> {
  const rows = await tx<ApprovalRow[]>`
    select id, provider, platform, property_identifier, locale, status, policy_reviewed_at, expires_at,
           evidence_ref, publisher_tag
      from public.monetization_approvals
     where status = 'approved'
  `;
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    platform: r.platform,
    propertyIdentifier: r.property_identifier,
    locale: r.locale,
    status: r.status,
    policyReviewedAt: r.policy_reviewed_at,
    expiresAt: r.expires_at,
    evidenceRef: r.evidence_ref,
    publisherTag: r.publisher_tag,
  }));
}

export async function loadPlacementRule(tx: Tx, placement: Placement): Promise<PlacementRule> {
  const [row] = await tx<
    {
      enabled: boolean;
      max_new_cards_per_session: number;
      min_visible_ms: number;
      min_visible_ratio: string;
    }[]
  >`
    select enabled, max_new_cards_per_session, min_visible_ms, min_visible_ratio::text as min_visible_ratio
      from public.placement_rules where placement = ${placement}
  `;
  // A missing rule row fails closed (placement disabled).
  if (!row) {
    return {
      enabled: false,
      maxCardsPerScreen: 1,
      maxNewCardsPerSession: 0,
      minVisibleMs: 1000,
      minVisibleRatio: 1,
    };
  }
  return {
    enabled: row.enabled,
    maxCardsPerScreen: 1,
    maxNewCardsPerSession: row.max_new_cards_per_session,
    minVisibleMs: row.min_visible_ms,
    minVisibleRatio: Number(row.min_visible_ratio),
  };
}

export interface FamilyPrefs {
  readonly hideAffiliate: boolean;
  readonly hideSponsorCards: boolean;
}

export async function loadPrefs(tx: Tx, familyId: string): Promise<FamilyPrefs> {
  const [row] = await tx<{ hide_affiliate: boolean; hide_sponsor_cards: boolean }[]>`
    select hide_affiliate, hide_sponsor_cards from public.family_monetization_prefs where family_id = ${familyId}
  `;
  return {
    hideAffiliate: row?.hide_affiliate ?? false,
    hideSponsorCards: row?.hide_sponsor_cards ?? false,
  };
}

/**
 * Server-side ad-free check (AC_MON_04): the family holds an entitlement that currently grants
 * access and whose verified store product maps to an ACTIVE `ad_free` feature row. Default: none.
 */
export async function familyIsAdFree(
  tx: Tx,
  familyId: string,
  environment: 'sandbox' | 'production',
  now: Date,
): Promise<boolean> {
  const rows = await tx<{ status: EntitlementStatus; period_end: Date | null }[]>`
    select e.status, e.period_end
      from public.family_entitlements e
      join public.store_feature_mappings m
        on m.channel = e.channel and m.product_id = e.product_id and m.environment = e.environment
       and m.feature = 'ad_free' and m.active
     where e.family_id = ${familyId} and e.environment = ${environment}
  `;
  return rows.some((r) => grantsAccess(r.status, r.period_end ?? new Date(0), now));
}

export interface CampaignCandidate extends ServableCampaignFacts {
  readonly sponsorName: string;
  readonly sponsorAllowedDomains: readonly string[];
  readonly creativeId: string;
  readonly headline: string;
  readonly body: string;
  readonly ctaLabel: string;
  readonly destinationUrl: string;
  readonly imageAssetRef: string | null;
  readonly imageLicenseRef: string | null;
}

interface CampaignRow {
  id: string;
  status: CampaignState;
  sponsor_status: 'active' | 'suspended';
  sponsor_name: string;
  allowed_domains: string[];
  creative_id: string;
  review_status: string;
  placement: Placement;
  platforms: MonetizationPlatform[];
  starts_at: Date;
  ends_at: Date;
  impression_cap: number;
  viewable: number;
  headline: string;
  body: string;
  cta_label: string;
  destination_url: string;
  image_asset_ref: string | null;
  image_license_ref: string | null;
}

function toCandidate(r: CampaignRow): CampaignCandidate {
  return {
    id: r.id,
    status: r.status,
    sponsorActive: r.sponsor_status === 'active',
    creativeApproved: r.review_status === 'approved',
    placement: r.placement,
    platforms: r.platforms,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    impressionCap: r.impression_cap,
    viewableImpressions: r.viewable,
    sponsorName: r.sponsor_name,
    sponsorAllowedDomains: r.allowed_domains,
    creativeId: r.creative_id,
    headline: r.headline,
    body: r.body,
    ctaLabel: r.cta_label,
    destinationUrl: r.destination_url,
    imageAssetRef: r.image_asset_ref,
    imageLicenseRef: r.image_license_ref,
  };
}

/** Campaigns with their creative, sponsor and delivered viewable impressions (all time). */
export async function loadCampaignCandidates(
  tx: Tx,
  filter: { placement?: Placement; campaignId?: string; servingOnly?: boolean } = {},
): Promise<CampaignCandidate[]> {
  const rows = await tx<CampaignRow[]>`
    select c.id, c.status, s.status as sponsor_status, s.business_name as sponsor_name, s.allowed_domains,
           c.creative_id, cr.review_status, c.placement, c.platforms, c.starts_at, c.ends_at, c.impression_cap,
           coalesce((select sum(e.count) from public.aggregate_ad_events e
                      where e.campaign_id = c.id and e.kind = 'viewable_impression'), 0)::int as viewable,
           cr.headline, cr.body, cr.cta_label, cr.destination_url, cr.image_asset_ref, cr.image_license_ref
      from public.sponsor_campaigns c
      join public.sponsors s on s.id = c.sponsor_id
      join public.sponsor_creatives cr on cr.id = c.creative_id
     where (${filter.placement ?? null}::text is null or c.placement = ${filter.placement ?? null})
       and (${filter.campaignId ?? null}::uuid is null or c.id = ${filter.campaignId ?? null})
       and (${filter.servingOnly ?? false} = false or c.status in ('scheduled', 'active'))
     order by c.id
  `;
  return rows.map(toCandidate);
}

/** Adds to one aggregate counter cell (no family/user/child/session identifier is stored). */
export async function bumpCounter(
  tx: Tx,
  cell: {
    campaignId?: string | null;
    catalogId?: string | null;
    now: Date;
    platform: MonetizationPlatform;
    placement: Placement;
    kind: 'opportunity' | 'served' | 'viewable_impression' | 'click' | 'dismiss' | 'report';
  },
): Promise<void> {
  await tx`
    insert into public.aggregate_ad_events (campaign_id, catalog_id, event_date, platform, placement, kind, count)
    values (${cell.campaignId ?? null}, ${cell.catalogId ?? null}, ${eventDate(cell.now)}, ${cell.platform},
            ${cell.placement}, ${cell.kind}, 1)
    on conflict (campaign_id, catalog_id, event_date, platform, placement, kind)
    do update set count = public.aggregate_ad_events.count + 1
  `;
}

export interface CatalogRow {
  id: string;
  stable_key: string;
  title: string;
  description: string;
  skills: string[];
  subjects: (
    'math' | 'reading' | 'spelling_vocabulary' | 'grammar_writing' | 'science' | 'social_studies'
  )[];
  grade_min: number;
  grade_max: number;
  kind: 'workbook' | 'flashcards' | 'manipulative' | 'parent_exercise' | 'in_app_practice';
  merchant: 'amazon' | 'other' | 'none';
  merchant_url: string | null;
  image_asset_ref: string | null;
  image_license_ref: string | null;
  availability: 'available' | 'unavailable' | 'unknown';
  last_link_check_at: Date | null;
  last_link_check_status: 'ok' | 'broken' | 'error' | 'skipped' | null;
  status: 'draft' | 'approved' | 'retired';
  reviewed_at: Date | null;
}

export async function loadCatalog(
  tx: Tx,
  filter: { id?: string; approvedOnly?: boolean } = {},
): Promise<CatalogRow[]> {
  return tx<CatalogRow[]>`
    select id, stable_key, title, description, skills, subjects, grade_min, grade_max, kind, merchant, merchant_url,
           image_asset_ref, image_license_ref, availability, last_link_check_at, last_link_check_status, status,
           reviewed_at
      from public.resource_catalog
     where (${filter.id ?? null}::uuid is null or id = ${filter.id ?? null})
       and (${filter.approvedOnly ?? false} = false or status = 'approved')
     order by stable_key
  `;
}
