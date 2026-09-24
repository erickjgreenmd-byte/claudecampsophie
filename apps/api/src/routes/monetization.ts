import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { z } from 'zod';
import {
  monetizationPreferencesSchema,
  placementQuerySchema,
  placementReportRequestSchema,
  placementViewedRequestSchema,
  resourcesQuerySchema,
  serveTokenSchema,
  uuidSchema,
} from '@pencillift/contracts';
import {
  AMAZON_PRICE_NOTE,
  buildOutboundUrl,
  campaignServableReason,
  countViewable,
  effectiveItemMode,
  providerGate,
  rankResources,
  resolveMerchantMode,
  selectSponsorCard,
  validateCreative,
  type MerchantModeResult,
  type MonetizationPlatform,
  type MonetizationProperty,
  type Placement,
} from '@pencillift/domain/monetization';
import { readJson } from '../app.ts';
import type { Tx } from '../db.ts';
import { ApiError, businessRule } from '../errors.ts';
import { assertRecentUnlock, currentFamilyId, requireParent } from '../middleware/auth.ts';
import type { AppEnv } from '../middleware/context.ts';
import { randomToken } from '../security/crypto.ts';
import {
  DEFAULT_LOCALE,
  LINK_LOCALES,
  WHY_SHOWN,
  bumpCounter,
  disclosureFor,
  familyIsAdFree,
  loadApprovals,
  loadCampaignCandidates,
  loadCatalog,
  loadPlacementRule,
  loadPrefs,
  loadSwitches,
  lockCampaignBilling,
  requestProperty,
  serveTokenHash,
  sessionKeyHash,
  type CampaignCandidate,
} from '../services/monetization-data.ts';

type Ctx = Context<AppEnv>;

/**
 * Parent-only commercial surfaces (spec P16, AC_MON_02..16). Every route needs a verified parent
 * (Supabase) token AND a server-verified recent adult unlock bound to that auth session; child
 * tokens, unknown roles, expired unlocks and relocked sessions receive no commercial DTO. No route
 * here writes points, rewards, usage allowances or discounts (AC_MON_13).
 */

/** Commercial responses are never cached (back-stack/cache replay) and never send a referrer. */
const commercialHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
};

function parseQuery<S extends z.ZodType>(c: Ctx, schema: S): z.infer<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.') || '(query)').slice(0, 5);
    throw new ApiError('VALIDATION_FAILED', `Invalid request: ${fields.join(', ')}`);
  }
  return parsed.data;
}

/** Adult gate shared by every route: parent token (middleware) + recent unlock + active family. */
async function adultContext(c: Ctx): Promise<{ familyId: string; now: Date }> {
  await assertRecentUnlock(c);
  const familyId = await currentFamilyId(c);
  return { familyId, now: c.var.deps.clock() };
}

/**
 * The property this request is served on. A browser is always the web property, whatever
 * `platform` it declares, so a web visitor can never obtain another property's approvals, merchant
 * mode or tagged links by claiming ios/android (RV-MON-04).
 */
function servedProperty(
  c: Ctx,
  declared: MonetizationPlatform,
  locale: string,
): MonetizationProperty {
  return requestProperty(
    c.var.deps.config,
    {
      origin: c.req.header('origin') ?? null,
      secFetchSite: c.req.header('sec-fetch-site') ?? null,
      secFetchMode: c.req.header('sec-fetch-mode') ?? null,
    },
    declared,
    locale,
  );
}

function serveTokenParam(c: Ctx): string {
  const parsed = serveTokenSchema.safeParse(c.req.param('serveToken'));
  if (!parsed.success) throw new ApiError('NOT_FOUND', 'This card is no longer available');
  return parsed.data;
}

interface ServeRow {
  serve_token_hash: string;
  campaign_id: string;
  placement: Placement;
  platform: MonetizationPlatform;
  locale: string;
  served_at: Date;
  viewed_at: Date | null;
  clicked_at: Date | null;
  dismissed_at: Date | null;
  reported_at: Date | null;
}

/** A serve is usable only by the auth session it was served to (replays from elsewhere fail). */
async function lockServe(c: Ctx, tx: Tx, token: string): Promise<ServeRow> {
  const hash = await serveTokenHash(token);
  const sessionKey = await sessionKeyHash(c.var.deps.config, c.var.parent.sessionId);
  const [serve] = await tx<ServeRow[]>`
    select serve_token_hash, campaign_id, placement, platform, locale, served_at, viewed_at, clicked_at, dismissed_at,
           reported_at
      from private.placement_serves
     where serve_token_hash = ${hash} and session_key_hash = ${sessionKey}
     for update
  `;
  if (!serve) throw new ApiError('NOT_FOUND', 'This card is no longer available');
  return serve;
}

/**
 * Whether a previously served card may still count or navigate: switches, provider approval,
 * placement rule, campaign state/window/cap, ad-free status and the family's hide preference are
 * all re-evaluated, so a kill switch or pause takes effect immediately (AC_MON_14).
 */
async function serveStillLive(
  c: Ctx,
  tx: Tx,
  serve: ServeRow,
  familyId: string,
  now: Date,
): Promise<CampaignCandidate | null> {
  const { config } = c.var.deps;
  const [campaign] = await loadCampaignCandidates(tx, { campaignId: serve.campaign_id });
  if (!campaign) return null;
  // The follow-up request must come from the same kind of property the card was served on.
  const property = servedProperty(c, serve.platform, serve.locale);
  if (property.platform !== serve.platform) return null;
  const gate = providerGate('sponsor_direct', {
    environment: config.environment,
    property,
    approvals: await loadApprovals(tx),
    switches: await loadSwitches(tx),
    now,
  });
  const rule = await loadPlacementRule(tx, serve.placement);
  if (!gate.enabled || !rule.enabled) return null;
  if (
    campaignServableReason(campaign, {
      placement: serve.placement,
      platform: serve.platform,
      now,
    }) !== null
  ) {
    return null;
  }
  const prefs = await loadPrefs(tx, familyId);
  if (prefs.hideSponsorCards) return null;
  if (await familyIsAdFree(tx, familyId, config.billingEnvironment, now)) return null;
  return campaign;
}

function destinationHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function merchantModeFor(
  c: Ctx,
  tx: Tx,
  property: MonetizationProperty,
  now: Date,
): Promise<MerchantModeResult> {
  return resolveMerchantMode({
    environment: c.var.deps.config.environment,
    property,
    approvals: await loadApprovals(tx),
    switches: await loadSwitches(tx),
    now,
    linksPermitted: LINK_LOCALES.has(property.locale),
  });
}

export function monetizationRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  for (const path of [
    '/placements',
    '/placements/*',
    '/resources',
    '/resources/*',
    '/monetization/*',
  ]) {
    r.use(path, commercialHeaders);
  }

  // ------------------------------------------------------------------ sponsor placements
  r.get('/placements', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const { familyId, now } = await adultContext(c);
    const query = parseQuery(c, placementQuerySchema);
    const locale = query.locale ?? DEFAULT_LOCALE;
    const property = servedProperty(c, query.platform, locale);
    const platform = property.platform;
    const sessionKey = await sessionKeyHash(deps.config, parent.sessionId);

    const body = await deps.db.asService(async (tx) => {
      // Serialize per auth session so parallel requests cannot exceed the session cap.
      await tx`select pg_advisory_xact_lock(hashtextextended(${sessionKey}, 0))`;
      const session = await tx<{ campaign_id: string; dismissed: boolean }[]>`
        select campaign_id, dismissed_at is not null as dismissed
          from private.placement_serves where session_key_hash = ${sessionKey}
      `;
      const selection = selectSponsorCard({
        campaigns: await loadCampaignCandidates(tx, {
          placement: query.placement,
          servingOnly: true,
        }),
        placement: query.placement,
        platform,
        propertyIdentifier: property.identifier,
        locale,
        environment: deps.config.environment,
        now,
        servedThisSession: session.length,
        servedCampaignIdsThisSession: session.map((s) => s.campaign_id),
        dismissedCampaignIdsThisSession: session
          .filter((s) => s.dismissed)
          .map((s) => s.campaign_id),
        rule: await loadPlacementRule(tx, query.placement),
        prefs: await loadPrefs(tx, familyId),
        adFree: await familyIsAdFree(tx, familyId, deps.config.billingEnvironment, now),
        switches: await loadSwitches(tx),
        approvals: await loadApprovals(tx),
      });
      if (selection.kind === 'no_card') {
        if (selection.reason !== 'disabled') {
          await bumpCounter(tx, {
            now,
            platform,
            placement: query.placement,
            kind: 'opportunity',
          });
        }
        return { card: null, reason: selection.reason };
      }
      const campaign = selection.campaign;
      // Defense in depth: never serve a creative that no longer validates for its sponsor.
      if (
        validateCreative(
          {
            headline: campaign.headline,
            body: campaign.body,
            ctaLabel: campaign.ctaLabel,
            destinationUrl: campaign.destinationUrl,
            imageAssetRef: campaign.imageAssetRef,
            imageLicenseRef: campaign.imageLicenseRef,
          },
          campaign.sponsorAllowedDomains,
        ).length > 0
      ) {
        return { card: null, reason: 'no_eligible' as const };
      }
      const token = randomToken();
      await tx`
        insert into private.placement_serves
          (serve_token_hash, session_key_hash, campaign_id, placement, platform, locale, served_at)
        values (${await serveTokenHash(token)}, ${sessionKey}, ${campaign.id}, ${query.placement}, ${platform},
                ${locale}, ${now})
      `;
      await bumpCounter(tx, {
        now,
        platform,
        placement: query.placement,
        kind: 'opportunity',
      });
      await bumpCounter(tx, {
        campaignId: campaign.id,
        now,
        platform,
        placement: query.placement,
        kind: 'served',
      });
      return {
        card: {
          serveToken: token,
          placement: query.placement,
          label: `Sponsored by ${campaign.sponsorName}`,
          headline: campaign.headline,
          body: campaign.body,
          ctaLabel: campaign.ctaLabel,
          destinationHost: destinationHost(campaign.destinationUrl),
          imageAssetRef: campaign.imageAssetRef,
          whyShown: WHY_SHOWN[query.placement],
        },
        reason: 'served' as const,
      };
    });
    return c.json(body);
  });

  r.post('/placements/:serveToken/viewed', requireParent, async (c) => {
    const { deps } = c.var;
    const { familyId, now } = await adultContext(c);
    const token = serveTokenParam(c);
    const input = await readJson(c, placementViewedRequestSchema);
    const body = await deps.db.asService(async (tx) => {
      const serve = await lockServe(c, tx, token);
      // Billing is serialized per campaign BEFORE the cap is re-read, so parallel beacons from
      // other sessions can never push a campaign past its impression cap (RV-MON-01).
      await lockCampaignBilling(tx, serve.campaign_id);
      const live = await serveStillLive(c, tx, serve, familyId, now);
      if (!live) return { counted: false, reason: 'placement_withdrawn' };
      const rule = await loadPlacementRule(tx, serve.placement);
      const outcome = countViewable({
        servedAt: serve.served_at,
        viewedAt: serve.viewed_at,
        // A dismissed/reported card left the screen then: no later beacon can claim more (RV-MON-03).
        dismissedAt: serve.dismissed_at,
        now,
        visibleMs: input.visibleMs,
        visibleRatio: input.visibleRatio,
        rule,
      });
      if (!outcome.counted) return { counted: false, reason: outcome.reason };
      await tx`update private.placement_serves set viewed_at = ${now} where serve_token_hash = ${serve.serve_token_hash}`;
      await bumpCounter(tx, {
        campaignId: serve.campaign_id,
        now,
        platform: serve.platform,
        placement: serve.placement,
        kind: 'viewable_impression',
      });
      return { counted: true, reason: null };
    });
    return c.json(body);
  });

  // Dismiss and report are safety controls: they always work for the serving session and never
  // navigate anywhere.
  r.post('/placements/:serveToken/dismiss', requireParent, async (c) => {
    const { deps } = c.var;
    const { now } = await adultContext(c);
    const token = serveTokenParam(c);
    await deps.db.asService(async (tx) => {
      const serve = await lockServe(c, tx, token);
      if (serve.dismissed_at !== null) return;
      await tx`update private.placement_serves set dismissed_at = ${now} where serve_token_hash = ${serve.serve_token_hash}`;
      await bumpCounter(tx, {
        campaignId: serve.campaign_id,
        now,
        platform: serve.platform,
        placement: serve.placement,
        kind: 'dismiss',
      });
    });
    return c.body(null, 204);
  });

  r.post('/placements/:serveToken/report', requireParent, async (c) => {
    const { deps } = c.var;
    const { now } = await adultContext(c);
    const token = serveTokenParam(c);
    const { category } = await readJson(c, placementReportRequestSchema);
    await deps.db.asService(async (tx) => {
      const serve = await lockServe(c, tx, token);
      if (serve.reported_at !== null) return;
      await tx`
        update private.placement_serves set reported_at = ${now}, dismissed_at = coalesce(dismissed_at, ${now})
         where serve_token_hash = ${serve.serve_token_hash}
      `;
      await tx`
        insert into public.ad_reports (campaign_id, category, platform, placement, created_date)
        values (${serve.campaign_id}, ${category}, ${serve.platform}, ${serve.placement}, ${now.toISOString().slice(0, 10)})
      `;
      await bumpCounter(tx, {
        campaignId: serve.campaign_id,
        now,
        platform: serve.platform,
        placement: serve.placement,
        kind: 'report',
      });
    });
    return c.body(null, 204);
  });

  r.post('/placements/:serveToken/click', requireParent, async (c) => {
    const { deps } = c.var;
    const { familyId, now } = await adultContext(c);
    const token = serveTokenParam(c);
    const url = await deps.db.asService(async (tx) => {
      const serve = await lockServe(c, tx, token);
      // A dismissed or reported card is gone from the parent's screen: a later tap is a replay and
      // never navigates or counts (RV-MON-03).
      if (serve.dismissed_at !== null) {
        throw new ApiError('NOT_FOUND', 'This offer is no longer available');
      }
      const live = await serveStillLive(c, tx, serve, familyId, now);
      if (!live) throw new ApiError('NOT_FOUND', 'This offer is no longer available');
      if (
        validateCreative(
          {
            headline: live.headline,
            body: live.body,
            ctaLabel: live.ctaLabel,
            destinationUrl: live.destinationUrl,
            imageAssetRef: live.imageAssetRef,
            imageLicenseRef: live.imageLicenseRef,
          },
          live.sponsorAllowedDomains,
        ).length > 0
      ) {
        throw new ApiError('NOT_FOUND', 'This offer is no longer available');
      }
      if (serve.clicked_at === null) {
        await tx`update private.placement_serves set clicked_at = ${now} where serve_token_hash = ${serve.serve_token_hash}`;
        await bumpCounter(tx, {
          campaignId: serve.campaign_id,
          now,
          platform: serve.platform,
          placement: serve.placement,
          kind: 'click',
        });
      }
      // The sponsor's reviewed destination as approved; nothing about the family is appended.
      return live.destinationUrl;
    });
    return c.json({ url });
  });

  // ------------------------------------------------------------------ resources (no paywall)
  // Free authenticated adults and cancelled subscribers keep access (AC_MON_11): no entitlement check.
  r.get('/resources', requireParent, async (c) => {
    const { deps } = c.var;
    const { familyId, now } = await adultContext(c);
    const query = parseQuery(c, resourcesQuerySchema);
    const property = servedProperty(c, query.platform, query.locale ?? DEFAULT_LOCALE);
    const body = await deps.db.asService(async (tx) => {
      const mode = await merchantModeFor(c, tx, property, now);
      const prefs = await loadPrefs(tx, familyId);
      const rows = await loadCatalog(tx, { approvedOnly: true });
      const ranked = rankResources(
        rows.map((row) => ({
          id: row.id,
          stableKey: row.stable_key,
          subjects: row.subjects,
          skills: row.skills,
          gradeMin: row.grade_min,
          gradeMax: row.grade_max,
          kind: row.kind,
          availability: row.availability,
          status: row.status,
          row,
        })),
        { subject: query.subject, grade: query.grade, skills: query.skill ? [query.skill] : [] },
      );
      const visible = prefs.hideAffiliate
        ? ranked.filter(({ item }) => item.row.merchant === 'none')
        : ranked;
      return {
        mode: mode.mode,
        commercialHidden: prefs.hideAffiliate,
        items: visible.map(({ item, relevance }) => {
          const itemMode = effectiveItemMode(
            mode.mode,
            { merchant: item.row.merchant, merchantUrl: item.row.merchant_url },
            {
              personalized: false,
            },
          );
          return {
            id: item.row.id,
            title: item.row.title,
            description: item.row.description,
            kind: item.row.kind,
            subjects: item.row.subjects,
            skills: item.row.skills,
            gradeMin: item.row.grade_min,
            gradeMax: item.row.grade_max,
            relevance,
            mode: itemMode,
            merchant: item.row.merchant,
            disclosure: disclosureFor(itemMode),
            // No authorized, refreshed price source exists: never show a price (AC_MON_12).
            price: null,
            priceNote:
              item.row.merchant === 'amazon' && itemMode !== 'education_only'
                ? AMAZON_PRICE_NOTE
                : null,
            availability: item.row.availability,
            imageAssetRef: item.row.image_asset_ref,
          };
        }),
      };
    });
    return c.json(body);
  });

  r.get('/resources/:id/outbound', requireParent, async (c) => {
    const { deps } = c.var;
    const id = uuidSchema.safeParse(c.req.param('id'));
    if (!id.success) throw new ApiError('NOT_FOUND', 'This resource is no longer available');
    const { familyId, now } = await adultContext(c);
    const query = parseQuery(c, resourcesQuerySchema.pick({ platform: true, locale: true }));
    const property = servedProperty(c, query.platform, query.locale ?? DEFAULT_LOCALE);
    const body = await deps.db.asService(async (tx) => {
      const [row] = await loadCatalog(tx, { id: id.data, approvedOnly: true });
      // Invalid, retired or unavailable products fail safely (AC_MON_12).
      if (!row || row.availability === 'unavailable') {
        throw new ApiError('NOT_FOUND', 'This resource is no longer available');
      }
      const prefs = await loadPrefs(tx, familyId);
      if (prefs.hideAffiliate && row.merchant !== 'none') {
        throw new ApiError('NOT_FOUND', 'This resource is hidden by your preferences');
      }
      const mode = await merchantModeFor(c, tx, property, now);
      const itemMode = effectiveItemMode(
        mode.mode,
        { merchant: row.merchant, merchantUrl: row.merchant_url },
        { personalized: false },
      );
      if (itemMode === 'education_only') {
        throw businessRule('LINKS_UNAVAILABLE', 'This resource has no outside link here');
      }
      const url = buildOutboundUrl(
        { merchant: row.merchant, merchantUrl: row.merchant_url },
        itemMode,
        itemMode === 'amazon_associates' ? mode.tag : null,
      );
      if (!url.ok) throw new ApiError('NOT_FOUND', 'This resource is no longer available');
      await bumpCounter(tx, {
        catalogId: row.id,
        now,
        platform: property.platform,
        placement: 'resources_browse',
        kind: 'click',
      });
      return { url: url.value, mode: itemMode, disclosure: disclosureFor(itemMode) };
    });
    return c.json(body);
  });

  // ------------------------------------------------------------------ preferences
  r.get('/monetization/preferences', requireParent, async (c) => {
    const { familyId } = await adultContext(c);
    // Read under the parent's own role: RLS (family member) is the second layer.
    const [row] = await c.var.deps.db.asParent(
      c.var.parent,
      (tx) => tx<{ hide_affiliate: boolean; hide_sponsor_cards: boolean }[]>`
        select hide_affiliate, hide_sponsor_cards from public.family_monetization_prefs where family_id = ${familyId}
      `,
    );
    return c.json({
      hideAffiliate: row?.hide_affiliate ?? false,
      hideSponsorCards: row?.hide_sponsor_cards ?? false,
    });
  });

  r.put('/monetization/preferences', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const { familyId } = await adultContext(c);
    const input = await readJson(c, monetizationPreferencesSchema);
    await deps.db.asService(async (tx) => {
      await tx`
        insert into public.family_monetization_prefs (family_id, hide_affiliate, hide_sponsor_cards, updated_by, updated_at)
        values (${familyId}, ${input.hideAffiliate}, ${input.hideSponsorCards}, ${parent.userId}, now())
        on conflict (family_id) do update
          set hide_affiliate = excluded.hide_affiliate, hide_sponsor_cards = excluded.hide_sponsor_cards,
              updated_by = excluded.updated_by, updated_at = now()
      `;
      await tx`
        insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
        values (${familyId}, ${parent.userId}, 'parent', 'monetization.preferences_updated', 'family', ${familyId},
                ${JSON.stringify(input)}::text::jsonb)
      `;
    });
    return c.json(input);
  });

  return r;
}
