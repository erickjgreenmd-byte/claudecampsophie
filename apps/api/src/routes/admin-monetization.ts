import { Hono, type Context } from 'hono';
import {
  approvalInputSchema,
  approvalStatusChangeSchema,
  calendarMonthSchema,
  campaignInputSchema,
  campaignPatchSchema,
  campaignTransitionRequestSchema,
  catalogInputSchema,
  catalogPatchSchema,
  creativeInputSchema,
  creativeReviewSchema,
  monetizationSwitchKeySchema,
  placementRuleUpdateSchema,
  placementSchema,
  revenueAdjustmentRequestSchema,
  revenueImportRequestSchema,
  sponsorInputSchema,
  sponsorPatchSchema,
  switchUpdateSchema,
  uuidSchema,
} from '@pencillift/contracts';
import {
  AGGREGATE_REPORT_MIN_COUNT,
  MONETIZATION_PLATFORMS,
  MONETIZATION_PROVIDERS,
  adjustmentAllowed,
  campaignServableReason,
  campaignTransition,
  canonicalAmazonProductUrl,
  canonicalOtherMerchantUrl,
  evidenceQuality,
  isValidPublisherTag,
  providerGate,
  revenueSummary,
  suppressSmallCount,
  validateCreative,
  type CampaignEvent,
  type CampaignState,
  type MonetizationPlatform,
  type Placement,
  type RevenueAdjustmentKind,
  type RevenueCategory,
} from '@pencillift/domain/monetization';
import { readJson } from '../app.ts';
import type { Tx } from '../db.ts';
import { ApiError, businessRule, isUniqueViolation } from '../errors.ts';
import { requireOwnerAdmin, requireParent } from '../middleware/auth.ts';
import type { AppEnv } from '../middleware/context.ts';
import { sha256Hex } from '../security/crypto.ts';
import {
  loadApprovals,
  loadCampaignCandidates,
  loadCatalog,
  loadSwitches,
  propertyFor,
  DEFAULT_LOCALE,
  type CatalogRow,
} from '../services/monetization-data.ts';
import { checkMerchantLink } from '../services/monetization-links.ts';

type Ctx = Context<AppEnv>;

/**
 * Owner-only monetization console (spec P16.5, AC_MON_15). Every route requires an owner admin
 * with an MFA (aal2) session; every mutation writes an audit event. Campaigns are sold through
 * owner contracting: there is no advertiser self-service flow. Reports are aggregates only with
 * small-cohort suppression and never include a family, user or child identifier.
 */

function idParam(c: Ctx, name = 'id'): string {
  const parsed = uuidSchema.safeParse(c.req.param(name));
  if (!parsed.success) throw new ApiError('NOT_FOUND', 'Not found');
  return parsed.data;
}

function monthQuery(c: Ctx): string {
  const parsed = calendarMonthSchema.safeParse(c.req.query('month'));
  if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'month must be YYYY-MM');
  return parsed.data;
}

async function audit(
  tx: Tx,
  c: Ctx,
  action: string,
  targetType: string,
  targetId: string,
  metadata: object = {},
): Promise<void> {
  await tx`
    insert into public.audit_events (actor_user_id, actor_kind, action, target_type, target_id, metadata)
    values (${c.var.parent.userId}, 'admin', ${action}, ${targetType}, ${targetId}, ${JSON.stringify(metadata)}::text::jsonb)
  `;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

// ---------------------------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------------------------

interface SponsorRow {
  id: string;
  business_name: string;
  contact_ref: string | null;
  allowed_domains: string[];
  status: 'active' | 'suspended';
  created_at: Date;
}

const sponsorBody = (s: SponsorRow) => ({
  id: s.id,
  businessName: s.business_name,
  contactRef: s.contact_ref,
  allowedDomains: s.allowed_domains,
  status: s.status,
  createdAt: s.created_at.toISOString(),
});

interface CreativeRow {
  id: string;
  sponsor_id: string;
  version: number;
  headline: string;
  body: string;
  cta_label: string;
  destination_url: string;
  image_asset_ref: string | null;
  image_license_ref: string | null;
  review_status: 'draft' | 'in_review' | 'approved' | 'rejected';
  self_reviewed: boolean;
  created_by: string;
  reviewed_at: Date | null;
  created_at: Date;
}

const creativeBody = (r: CreativeRow) => ({
  id: r.id,
  sponsorId: r.sponsor_id,
  version: r.version,
  headline: r.headline,
  body: r.body,
  ctaLabel: r.cta_label,
  destinationUrl: r.destination_url,
  imageAssetRef: r.image_asset_ref,
  imageLicenseRef: r.image_license_ref,
  reviewStatus: r.review_status,
  selfReviewed: r.self_reviewed,
  reviewedAt: iso(r.reviewed_at),
  createdAt: r.created_at.toISOString(),
});

interface CampaignRow {
  id: string;
  sponsor_id: string;
  creative_id: string;
  name: string;
  placement: Placement;
  platforms: MonetizationPlatform[];
  starts_at: Date;
  ends_at: Date;
  impression_cap: number;
  fee_model: 'fixed_fee' | 'none';
  contracted_fee_cents: number;
  invoice_status: 'not_invoiced' | 'invoiced' | 'paid' | 'void';
  status: CampaignState;
  paused_reason: string | null;
}

async function campaignBodies(tx: Tx, now: Date, id?: string) {
  const rows = await tx<CampaignRow[]>`
    select id, sponsor_id, creative_id, name, placement, platforms, starts_at, ends_at, impression_cap, fee_model,
           contracted_fee_cents, invoice_status, status, paused_reason
      from public.sponsor_campaigns
     where (${id ?? null}::uuid is null or id = ${id ?? null})
     order by created_at
  `;
  const facts = new Map(
    (await loadCampaignCandidates(tx, id ? { campaignId: id } : {})).map((f) => [f.id, f]),
  );
  return rows.map((r) => {
    const f = facts.get(r.id);
    const reason =
      f === undefined
        ? 'STATUS'
        : campaignServableReason(f, {
            placement: r.placement,
            platform: r.platforms[0] ?? 'web',
            now,
          });
    return {
      id: r.id,
      sponsorId: r.sponsor_id,
      creativeId: r.creative_id,
      name: r.name,
      placement: r.placement,
      platforms: r.platforms,
      startsAt: r.starts_at.toISOString(),
      endsAt: r.ends_at.toISOString(),
      impressionCap: r.impression_cap,
      feeModel: r.fee_model,
      contractedFeeCents: r.contracted_fee_cents,
      invoiceStatus: r.invoice_status,
      status: r.status,
      pausedReason: r.paused_reason,
      servableNow: reason === null,
      notServableReason: reason,
      viewableImpressions: f?.viewableImpressions ?? 0,
    };
  });
}

interface ApprovalRow {
  id: string;
  provider: (typeof MONETIZATION_PROVIDERS)[number];
  platform: MonetizationPlatform;
  property_identifier: string;
  locale: string;
  intended_audience: string;
  vendor_sdk_version: string | null;
  policy_reviewed_at: Date;
  evidence_ref: string;
  approval_scope: string;
  publisher_tag: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'revoked' | 'expired';
  status_reason: string | null;
  expires_at: Date;
  created_at: Date;
}

const approvalBody = (a: ApprovalRow) => ({
  id: a.id,
  provider: a.provider,
  platform: a.platform,
  propertyIdentifier: a.property_identifier,
  locale: a.locale,
  intendedAudience: a.intended_audience,
  vendorSdkVersion: a.vendor_sdk_version,
  policyReviewedAt: a.policy_reviewed_at.toISOString(),
  evidenceRef: a.evidence_ref,
  evidenceQuality: evidenceQuality(a.evidence_ref),
  approvalScope: a.approval_scope,
  publisherTag: a.publisher_tag,
  status: a.status,
  statusReason: a.status_reason,
  expiresAt: a.expires_at.toISOString(),
  createdAt: a.created_at.toISOString(),
});

const catalogBody = (r: CatalogRow) => ({
  id: r.id,
  stableKey: r.stable_key,
  title: r.title,
  description: r.description,
  skills: r.skills,
  subjects: r.subjects,
  gradeMin: r.grade_min,
  gradeMax: r.grade_max,
  kind: r.kind,
  merchant: r.merchant,
  merchantUrl: r.merchant_url,
  imageAssetRef: r.image_asset_ref,
  imageLicenseRef: r.image_license_ref,
  availability: r.availability,
  lastLinkCheckAt: iso(r.last_link_check_at),
  lastLinkCheckStatus: r.last_link_check_status,
  status: r.status,
  reviewedAt: iso(r.reviewed_at),
});

async function catalogById(tx: Tx, id: string): Promise<CatalogRow> {
  const [row] = await loadCatalog(tx, { id });
  if (!row) throw new ApiError('NOT_FOUND', 'Resource not found');
  return row;
}

/** Validates and canonicalizes a catalog merchant link (Amazon: exact /dp/<ASIN>, no tag). */
function canonicalMerchantUrl(
  merchant: 'amazon' | 'other' | 'none',
  url: string | null,
): string | null {
  if (merchant === 'none') {
    if (url !== null)
      throw new ApiError('VALIDATION_FAILED', 'Free resources have no merchant link');
    return null;
  }
  if (url === null) throw new ApiError('VALIDATION_FAILED', 'A merchant resource needs its link');
  const result =
    merchant === 'amazon' ? canonicalAmazonProductUrl(url) : canonicalOtherMerchantUrl(url);
  if (!result.ok) throw businessRule(result.error.code, result.error.message);
  return result.value;
}

function creativeProblemsError(problems: ReturnType<typeof validateCreative>): ApiError {
  const list = problems.map((p) => `${p.code}(${p.field})`).join(', ');
  return businessRule('CREATIVE_INVALID', `Creative rejected: ${list}`.slice(0, 480));
}

const SOURCE_PROVIDERS: Readonly<Record<string, readonly string[]>> = {
  sponsor_invoice: ['sponsor_direct'],
  amazon_report: ['amazon_associates'],
  ad_network: ['ad_network'],
  manual: ['sponsor_direct', 'amazon_associates', 'ad_network'],
};

export function adminMonetizationRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('/monetization/*', requireParent, requireOwnerAdmin);

  // ------------------------------------------------------------------ status, switches, rules
  r.get('/monetization/status', async (c) => {
    const { deps } = c.var;
    const now = deps.clock();
    const body = await deps.db.asService(async (tx) => {
      const switches = await tx<
        { key: string; enabled: boolean; changed_at: Date; reason: string | null }[]
      >`
        select key, enabled, changed_at, reason from public.monetization_switches order by key
      `;
      const switchMap = await loadSwitches(tx);
      const approvals = await loadApprovals(tx);
      const providers = MONETIZATION_PROVIDERS.flatMap((provider) =>
        MONETIZATION_PLATFORMS.map((platform) => {
          const property = propertyFor(deps.config, platform, DEFAULT_LOCALE);
          const gate = providerGate(provider, {
            environment: deps.config.environment,
            property,
            approvals,
            switches: switchMap,
            now,
          });
          return {
            provider,
            platform,
            propertyIdentifier: property.identifier,
            enabled: gate.enabled,
            fixture: gate.fixture,
            reasons: [...gate.reasons],
          };
        }),
      );
      return {
        environment: deps.config.environment,
        switches: switches.map((s) => ({
          key: s.key,
          enabled: s.enabled,
          changedAt: s.changed_at.toISOString(),
          reason: s.reason,
        })),
        providers,
      };
    });
    return c.json(body);
  });

  r.get('/monetization/switches', async (c) => {
    const rows = await c.var.deps.db.asService(
      (tx) => tx<{ key: string; enabled: boolean; changed_at: Date; reason: string | null }[]>`
        select key, enabled, changed_at, reason from public.monetization_switches order by key
      `,
    );
    return c.json({
      switches: rows.map((s) => ({
        key: s.key,
        enabled: s.enabled,
        changedAt: s.changed_at.toISOString(),
        reason: s.reason,
      })),
    });
  });

  r.put('/monetization/switches/:key', async (c) => {
    const key = monetizationSwitchKeySchema.safeParse(c.req.param('key'));
    if (!key.success) throw new ApiError('NOT_FOUND', 'Unknown switch');
    const input = await readJson(c, switchUpdateSchema);
    const body = await c.var.deps.db.asService(async (tx) => {
      const [before] = await tx<{ enabled: boolean }[]>`
        select enabled from public.monetization_switches where key = ${key.data} for update
      `;
      if (!before) throw new ApiError('NOT_FOUND', 'Unknown switch');
      const [row] = await tx<
        { key: string; enabled: boolean; changed_at: Date; reason: string | null }[]
      >`
        update public.monetization_switches
           set enabled = ${input.enabled}, reason = ${input.reason}, changed_by = ${c.var.parent.userId}, changed_at = now()
         where key = ${key.data}
        returning key, enabled, changed_at, reason
      `;
      await audit(tx, c, 'monetization.switch_changed', 'monetization_switch', key.data, {
        from: before.enabled,
        to: input.enabled,
      });
      return {
        key: row!.key,
        enabled: row!.enabled,
        changedAt: row!.changed_at.toISOString(),
        reason: row!.reason,
      };
    });
    return c.json(body);
  });

  r.get('/monetization/placement-rules', async (c) => {
    const rows = await c.var.deps.db.asService(
      (tx) => tx<
        {
          placement: Placement;
          max_new_cards_per_session: number;
          min_visible_ms: number;
          min_visible_ratio: string;
          enabled: boolean;
        }[]
      >`
        select placement, max_new_cards_per_session, min_visible_ms, min_visible_ratio::text as min_visible_ratio, enabled
          from public.placement_rules order by placement
      `,
    );
    return c.json({
      rules: rows.map((r) => ({
        placement: r.placement,
        maxCardsPerScreen: 1,
        maxNewCardsPerSession: r.max_new_cards_per_session,
        minVisibleMs: r.min_visible_ms,
        minVisibleRatio: Number(r.min_visible_ratio),
        enabled: r.enabled,
      })),
    });
  });

  r.put('/monetization/placement-rules/:placement', async (c) => {
    const placement = placementSchema.safeParse(c.req.param('placement'));
    if (!placement.success) throw new ApiError('NOT_FOUND', 'Unknown placement');
    const input = await readJson(c, placementRuleUpdateSchema);
    await c.var.deps.db.asService(async (tx) => {
      await tx`
        update public.placement_rules
           set max_new_cards_per_session = ${input.maxNewCardsPerSession}, min_visible_ms = ${input.minVisibleMs},
               min_visible_ratio = ${input.minVisibleRatio}, enabled = ${input.enabled},
               updated_by = ${c.var.parent.userId}, updated_at = now()
         where placement = ${placement.data}
      `;
      await audit(
        tx,
        c,
        'monetization.placement_rule_updated',
        'placement_rule',
        placement.data,
        input,
      );
    });
    return c.json({ placement: placement.data, ...input });
  });

  // ------------------------------------------------------------------ approvals (policy evidence)
  r.get('/monetization/approvals', async (c) => {
    const rows = await c.var.deps.db.asService(
      (tx) =>
        tx<ApprovalRow[]>`select * from public.monetization_approvals order by created_at desc`,
    );
    return c.json({ approvals: rows.map(approvalBody) });
  });

  r.post('/monetization/approvals', async (c) => {
    const { deps } = c.var;
    const input = await readJson(c, approvalInputSchema);
    const now = deps.clock();
    const quality = evidenceQuality(input.evidenceRef);
    if (quality === 'invalid') {
      throw businessRule(
        'EVIDENCE_INVALID',
        'Record a reference to the actual policy evidence (a boolean, key or placeholder is not evidence)',
      );
    }
    if (
      quality === 'fixture' &&
      deps.config.environment !== 'development' &&
      deps.config.environment !== 'test'
    ) {
      throw businessRule(
        'FIXTURE_EVIDENCE_NOT_ALLOWED',
        'Fixture evidence is only for development and tests',
      );
    }
    const reviewedAt = new Date(input.policyReviewedAt);
    const expiresAt = new Date(input.expiresAt);
    if (reviewedAt.getTime() > now.getTime()) {
      throw new ApiError('VALIDATION_FAILED', 'The policy review date cannot be in the future');
    }
    if (expiresAt.getTime() <= reviewedAt.getTime()) {
      throw new ApiError('VALIDATION_FAILED', 'The expiry must be after the review date');
    }
    if (input.provider !== 'amazon_associates' && input.publisherTag !== null) {
      throw new ApiError('VALIDATION_FAILED', 'Only Amazon approvals carry a publisher tag');
    }
    if (
      input.provider === 'amazon_associates' &&
      input.publisherTag !== null &&
      !isValidPublisherTag(input.publisherTag)
    ) {
      throw businessRule(
        'TAG_INVALID',
        'Enter the publisher-level tag exactly as issued (e.g. name-20)',
      );
    }
    if (
      input.provider === 'amazon_associates' &&
      input.status === 'approved' &&
      input.publisherTag === null
    ) {
      throw businessRule(
        'TAG_REQUIRED',
        'An approved Amazon property needs its publisher-level tag',
      );
    }
    const row = await deps.db.asService(async (tx) => {
      const [created] = await tx<ApprovalRow[]>`
        insert into public.monetization_approvals
          (provider, platform, property_identifier, locale, intended_audience, vendor_sdk_version, policy_reviewed_at,
           evidence_ref, approval_scope, publisher_tag, status, expires_at, recorded_by)
        values (${input.provider}, ${input.platform}, ${input.propertyIdentifier}, ${input.locale}, ${input.intendedAudience},
                ${input.vendorSdkVersion}, ${reviewedAt}, ${input.evidenceRef}, ${input.approvalScope}, ${input.publisherTag},
                ${input.status}, ${expiresAt}, ${c.var.parent.userId})
        returning *
      `;
      await audit(tx, c, 'monetization.approval_recorded', 'monetization_approval', created!.id, {
        provider: input.provider,
        platform: input.platform,
        status: input.status,
        evidenceQuality: quality,
      });
      return created!;
    });
    return c.json(approvalBody(row), 201);
  });

  for (const [action, target] of [
    ['approve', 'approved'],
    ['reject', 'rejected'],
    ['revoke', 'revoked'],
  ] as const) {
    r.post(`/monetization/approvals/:id/${action}`, async (c) => {
      const id = idParam(c);
      const { reason } = await readJson(c, approvalStatusChangeSchema);
      const row = await c.var.deps.db.asService(async (tx) => {
        const [current] = await tx<ApprovalRow[]>`
          select * from public.monetization_approvals where id = ${id} for update
        `;
        if (!current) throw new ApiError('NOT_FOUND', 'Approval not found');
        const allowed =
          (current.status === 'pending' && ['approved', 'rejected', 'revoked'].includes(target)) ||
          (current.status === 'approved' && target === 'revoked');
        if (!allowed)
          throw businessRule('INVALID_TRANSITION', `Cannot ${action} a ${current.status} approval`);
        if (target === 'approved') {
          if (evidenceQuality(current.evidence_ref) === 'invalid') {
            throw businessRule('EVIDENCE_INVALID', 'This record has no usable evidence reference');
          }
          if (current.provider === 'amazon_associates' && current.publisher_tag === null) {
            throw businessRule(
              'TAG_REQUIRED',
              'An approved Amazon property needs its publisher-level tag',
            );
          }
        }
        const [updated] = await tx<ApprovalRow[]>`
          update public.monetization_approvals set status = ${target}, status_reason = ${reason}
           where id = ${id} returning *
        `;
        await audit(tx, c, `monetization.approval_${action}`, 'monetization_approval', id, {
          from: current.status,
          to: target,
        });
        return updated!;
      });
      return c.json(approvalBody(row));
    });
  }

  // ------------------------------------------------------------------ sponsors and creatives
  r.get('/monetization/sponsors', async (c) => {
    const rows = await c.var.deps.db.asService(
      (tx) => tx<SponsorRow[]>`
        select id, business_name, contact_ref, allowed_domains, status, created_at from public.sponsors order by business_name
      `,
    );
    return c.json({ sponsors: rows.map(sponsorBody) });
  });

  r.post('/monetization/sponsors', async (c) => {
    const input = await readJson(c, sponsorInputSchema);
    const row = await c.var.deps.db.asService(async (tx) => {
      const [created] = await tx<SponsorRow[]>`
        insert into public.sponsors (business_name, contact_ref, allowed_domains, created_by)
        values (${input.businessName}, ${input.contactRef}, ${input.allowedDomains}, ${c.var.parent.userId})
        returning id, business_name, contact_ref, allowed_domains, status, created_at
      `;
      await audit(tx, c, 'monetization.sponsor_created', 'sponsor', created!.id);
      return created!;
    });
    return c.json(sponsorBody(row), 201);
  });

  r.patch('/monetization/sponsors/:id', async (c) => {
    const id = idParam(c);
    const input = await readJson(c, sponsorPatchSchema);
    const row = await c.var.deps.db.asService(async (tx) => {
      const [current] = await tx<SponsorRow[]>`
        select id, business_name, contact_ref, allowed_domains, status, created_at from public.sponsors where id = ${id} for update
      `;
      if (!current) throw new ApiError('NOT_FOUND', 'Sponsor not found');
      const [updated] = await tx<SponsorRow[]>`
        update public.sponsors set
          business_name = ${input.businessName ?? current.business_name},
          contact_ref = ${input.contactRef === undefined ? current.contact_ref : input.contactRef},
          allowed_domains = ${input.allowedDomains ?? current.allowed_domains},
          status = ${input.status ?? current.status}
        where id = ${id}
        returning id, business_name, contact_ref, allowed_domains, status, created_at
      `;
      await audit(tx, c, 'monetization.sponsor_updated', 'sponsor', id, {
        fields: Object.keys(input),
        status: updated!.status,
      });
      return updated!;
    });
    return c.json(sponsorBody(row));
  });

  r.get('/monetization/sponsors/:id/creatives', async (c) => {
    const id = idParam(c);
    const rows = await c.var.deps.db.asService(
      (tx) => tx<CreativeRow[]>`
        select id, sponsor_id, version, headline, body, cta_label, destination_url, image_asset_ref, image_license_ref,
               review_status, self_reviewed, created_by, reviewed_at, created_at
          from public.sponsor_creatives where sponsor_id = ${id} order by version desc
      `,
    );
    return c.json({ creatives: rows.map(creativeBody) });
  });

  // Editing a creative = a new immutable version, which always needs its own review.
  r.post('/monetization/sponsors/:id/creatives', async (c) => {
    const sponsorId = idParam(c);
    const input = await readJson(c, creativeInputSchema);
    const row = await c.var.deps.db.asService(async (tx) => {
      const [sponsor] = await tx<{ allowed_domains: string[] }[]>`
        select allowed_domains from public.sponsors where id = ${sponsorId} for update
      `;
      if (!sponsor) throw new ApiError('NOT_FOUND', 'Sponsor not found');
      const problems = validateCreative(input, sponsor.allowed_domains);
      if (problems.length > 0) throw creativeProblemsError(problems);
      const destination = new URL(input.destinationUrl).href;
      const [created] = await tx<CreativeRow[]>`
        insert into public.sponsor_creatives
          (sponsor_id, version, headline, body, cta_label, destination_url, image_asset_ref, image_license_ref, created_by)
        values (${sponsorId},
                (select coalesce(max(version), 0) + 1 from public.sponsor_creatives where sponsor_id = ${sponsorId}),
                ${input.headline.trim()}, ${input.body.trim()}, ${input.ctaLabel.trim()}, ${destination},
                ${input.imageAssetRef}, ${input.imageLicenseRef}, ${c.var.parent.userId})
        returning id, sponsor_id, version, headline, body, cta_label, destination_url, image_asset_ref, image_license_ref,
                  review_status, self_reviewed, created_by, reviewed_at, created_at
      `;
      await audit(tx, c, 'monetization.creative_created', 'sponsor_creative', created!.id, {
        sponsorId,
        version: created!.version,
      });
      return created!;
    });
    return c.json(creativeBody(row), 201);
  });

  async function reviewCreative(
    c: Ctx,
    id: string,
    target: 'in_review' | 'approved' | 'rejected',
    note: string | undefined,
  ) {
    const reviewer = c.var.parent.userId;
    return c.var.deps.db.asService(async (tx) => {
      const [current] = await tx<
        (CreativeRow & { allowed_domains: string[]; sponsor_status: string })[]
      >`
        select cr.id, cr.sponsor_id, cr.version, cr.headline, cr.body, cr.cta_label, cr.destination_url,
               cr.image_asset_ref, cr.image_license_ref, cr.review_status, cr.self_reviewed, cr.created_by,
               cr.reviewed_at, cr.created_at, s.allowed_domains, s.status as sponsor_status
          from public.sponsor_creatives cr join public.sponsors s on s.id = cr.sponsor_id
         where cr.id = ${id} for update of cr
      `;
      if (!current) throw new ApiError('NOT_FOUND', 'Creative not found');
      const from = current.review_status;
      const allowed =
        (from === 'draft' && target === 'in_review') ||
        (from === 'in_review' && (target === 'approved' || target === 'rejected'));
      if (!allowed)
        throw businessRule('INVALID_TRANSITION', `Cannot move a ${from} creative to ${target}`);
      let selfReviewed = false;
      if (target === 'approved') {
        const problems = validateCreative(
          {
            headline: current.headline,
            body: current.body,
            ctaLabel: current.cta_label,
            destinationUrl: current.destination_url,
            imageAssetRef: current.image_asset_ref,
            imageLicenseRef: current.image_license_ref,
          },
          current.allowed_domains,
        );
        if (problems.length > 0) throw creativeProblemsError(problems);
        if (current.sponsor_status !== 'active')
          throw businessRule('SPONSOR_SUSPENDED', 'The sponsor is suspended');
        if (current.created_by === reviewer) {
          // Decision: with two or more owner admins a creative needs a second reviewer; a sole owner
          // may self-review, which is recorded on the row and in the audit trail.
          const [admins] = await tx<{ n: number }[]>`
            select count(*)::int as n from public.admin_users where role = 'owner_admin' and revoked_at is null
          `;
          if ((admins?.n ?? 0) >= 2) {
            throw businessRule(
              'SELF_REVIEW_NOT_ALLOWED',
              'Another owner admin must review this creative',
            );
          }
          selfReviewed = true;
        }
      }
      const reviewed = target === 'approved' || target === 'rejected';
      const [updated] = await tx<CreativeRow[]>`
        update public.sponsor_creatives
           set review_status = ${target},
               reviewed_by = ${reviewed ? reviewer : null},
               reviewed_at = ${reviewed ? c.var.deps.clock() : null},
               review_note = ${note ?? null},
               self_reviewed = ${selfReviewed}
         where id = ${id}
        returning id, sponsor_id, version, headline, body, cta_label, destination_url, image_asset_ref, image_license_ref,
                  review_status, self_reviewed, created_by, reviewed_at, created_at
      `;
      await audit(tx, c, `monetization.creative_${target}`, 'sponsor_creative', id, {
        from,
        to: target,
        ...(target === 'approved' ? { selfReview: selfReviewed } : {}),
      });
      return updated!;
    });
  }

  r.post('/monetization/creatives/:id/submit', async (c) =>
    c.json(creativeBody(await reviewCreative(c, idParam(c), 'in_review', undefined))),
  );
  r.post('/monetization/creatives/:id/approve', async (c) => {
    const { note } = await readJson(c, creativeReviewSchema);
    return c.json(creativeBody(await reviewCreative(c, idParam(c), 'approved', note)));
  });
  r.post('/monetization/creatives/:id/reject', async (c) => {
    const { note } = await readJson(c, creativeReviewSchema);
    return c.json(creativeBody(await reviewCreative(c, idParam(c), 'rejected', note)));
  });

  // ------------------------------------------------------------------ campaigns
  r.get('/monetization/campaigns', async (c) => {
    const now = c.var.deps.clock();
    const rows = await c.var.deps.db.asService((tx) => campaignBodies(tx, now));
    return c.json({ campaigns: rows });
  });

  r.post('/monetization/campaigns', async (c) => {
    const input = await readJson(c, campaignInputSchema);
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new ApiError('VALIDATION_FAILED', 'The campaign must end after it starts');
    }
    if ((input.feeModel === 'fixed_fee') !== input.contractedFeeCents > 0) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'A fixed-fee campaign needs its contracted fee (and only then)',
      );
    }
    const now = c.var.deps.clock();
    const body = await c.var.deps.db.asService(async (tx) => {
      const [creative] = await tx<{ sponsor_id: string }[]>`
        select sponsor_id from public.sponsor_creatives where id = ${input.creativeId}
      `;
      if (!creative || creative.sponsor_id !== input.sponsorId) {
        throw new ApiError('NOT_FOUND', 'Creative not found for this sponsor');
      }
      const [created] = await tx<{ id: string }[]>`
        insert into public.sponsor_campaigns
          (sponsor_id, creative_id, name, placement, platforms, starts_at, ends_at, impression_cap, fee_model,
           contracted_fee_cents, created_by)
        values (${input.sponsorId}, ${input.creativeId}, ${input.name}, ${input.placement}, ${[...new Set(input.platforms)]},
                ${startsAt}, ${endsAt}, ${input.impressionCap}, ${input.feeModel}, ${input.contractedFeeCents},
                ${c.var.parent.userId})
        returning id
      `;
      await audit(tx, c, 'monetization.campaign_created', 'sponsor_campaign', created!.id, {
        placement: input.placement,
      });
      const [out] = await campaignBodies(tx, now, created!.id);
      return out!;
    });
    return c.json(body, 201);
  });

  r.patch('/monetization/campaigns/:id', async (c) => {
    const id = idParam(c);
    const input = await readJson(c, campaignPatchSchema);
    const now = c.var.deps.clock();
    const body = await c.var.deps.db.asService(async (tx) => {
      const [current] = await tx<CampaignRow[]>`
        select id, sponsor_id, creative_id, name, placement, platforms, starts_at, ends_at, impression_cap, fee_model,
               contracted_fee_cents, invoice_status, status, paused_reason
          from public.sponsor_campaigns where id = ${id} for update
      `;
      if (!current) throw new ApiError('NOT_FOUND', 'Campaign not found');
      const reviewSurfaceChanged =
        (input.creativeId !== undefined && input.creativeId !== current.creative_id) ||
        (input.placement !== undefined && input.placement !== current.placement) ||
        (input.platforms !== undefined &&
          [...new Set(input.platforms)].sort().join(',') !==
            [...current.platforms].sort().join(','));
      let status = current.status;
      if (reviewSurfaceChanged) {
        const next = campaignTransition(current.status, { type: 'creative_changed' });
        if (!next.ok) throw businessRule(next.error.code, next.error.message);
        status = next.value;
      }
      if (input.creativeId !== undefined) {
        const [creative] = await tx<{ sponsor_id: string }[]>`
          select sponsor_id from public.sponsor_creatives where id = ${input.creativeId}
        `;
        if (!creative || creative.sponsor_id !== current.sponsor_id) {
          throw new ApiError('NOT_FOUND', 'Creative not found for this sponsor');
        }
      }
      const startsAt = input.startsAt ? new Date(input.startsAt) : current.starts_at;
      const endsAt = input.endsAt ? new Date(input.endsAt) : current.ends_at;
      if (endsAt.getTime() <= startsAt.getTime()) {
        throw new ApiError('VALIDATION_FAILED', 'The campaign must end after it starts');
      }
      if (current.status === 'ended' && Object.keys(input).some((k) => k !== 'invoiceStatus')) {
        throw businessRule('INVALID_TRANSITION', 'An ended campaign only accepts invoice updates');
      }
      await tx`
        update public.sponsor_campaigns set
          creative_id = ${input.creativeId ?? current.creative_id},
          name = ${input.name ?? current.name},
          placement = ${input.placement ?? current.placement},
          platforms = ${input.platforms ? [...new Set(input.platforms)] : current.platforms},
          starts_at = ${startsAt}, ends_at = ${endsAt},
          impression_cap = ${input.impressionCap ?? current.impression_cap},
          invoice_status = ${input.invoiceStatus ?? current.invoice_status},
          status = ${status}
        where id = ${id}
      `;
      await audit(tx, c, 'monetization.campaign_updated', 'sponsor_campaign', id, {
        fields: Object.keys(input),
        from: current.status,
        to: status,
      });
      const [out] = await campaignBodies(tx, now, id);
      return out!;
    });
    return c.json(body);
  });

  r.post('/monetization/campaigns/:id/transition', async (c) => {
    const id = idParam(c);
    const input = await readJson(c, campaignTransitionRequestSchema);
    const now = c.var.deps.clock();
    const body = await c.var.deps.db.asService(async (tx) => {
      const [current] = await tx<{ status: CampaignState; ends_at: Date; review_status: string }[]>`
        select c.status, c.ends_at, cr.review_status
          from public.sponsor_campaigns c join public.sponsor_creatives cr on cr.id = c.creative_id
         where c.id = ${id} for update of c
      `;
      if (!current) throw new ApiError('NOT_FOUND', 'Campaign not found');
      const creativeApproved = current.review_status === 'approved';
      const event: CampaignEvent =
        input.action === 'approve'
          ? { type: 'approve', creativeApproved }
          : input.action === 'activate'
            ? { type: 'activate', creativeApproved, now, endsAt: current.ends_at }
            : input.action === 'resume'
              ? { type: 'resume', now, endsAt: current.ends_at }
              : { type: input.action };
      if (input.action === 'pause' && !input.reason) {
        throw new ApiError('VALIDATION_FAILED', 'Record why the campaign is paused');
      }
      const next = campaignTransition(current.status, event);
      if (!next.ok) throw businessRule(next.error.code, next.error.message);
      await tx`
        update public.sponsor_campaigns
           set status = ${next.value}, paused_reason = ${next.value === 'paused' ? (input.reason ?? null) : null}
         where id = ${id}
      `;
      await audit(tx, c, `monetization.campaign_${input.action}`, 'sponsor_campaign', id, {
        from: current.status,
        to: next.value,
      });
      const [out] = await campaignBodies(tx, now, id);
      return out!;
    });
    return c.json(body);
  });

  // ------------------------------------------------------------------ resource catalog
  r.get('/monetization/catalog', async (c) => {
    const rows = await c.var.deps.db.asService((tx) => loadCatalog(tx));
    return c.json({ items: rows.map(catalogBody) });
  });

  r.post('/monetization/catalog', async (c) => {
    const input = await readJson(c, catalogInputSchema);
    if (input.gradeMax < input.gradeMin)
      throw new ApiError('VALIDATION_FAILED', 'gradeMax must be >= gradeMin');
    if (
      (input.kind === 'parent_exercise' || input.kind === 'in_app_practice') &&
      input.merchant !== 'none'
    ) {
      throw new ApiError('VALIDATION_FAILED', 'Free learning options never carry a merchant link');
    }
    const url = canonicalMerchantUrl(input.merchant, input.merchantUrl);
    const row = await c.var.deps.db.asService(async (tx) => {
      const [created] = await tx<{ id: string }[]>`
        insert into public.resource_catalog
          (stable_key, title, description, skills, subjects, grade_min, grade_max, kind, merchant, merchant_url,
           image_asset_ref, image_license_ref, created_by)
        values (${input.stableKey}, ${input.title}, ${input.description}, ${input.skills}, ${[...new Set(input.subjects)]},
                ${input.gradeMin}, ${input.gradeMax}, ${input.kind}, ${input.merchant}, ${url}, ${input.imageAssetRef},
                ${input.imageLicenseRef}, ${c.var.parent.userId})
        returning id
      `;
      await audit(tx, c, 'monetization.catalog_created', 'resource', created!.id, {
        merchant: input.merchant,
      });
      return catalogById(tx, created!.id);
    });
    return c.json(catalogBody(row), 201);
  });

  r.patch('/monetization/catalog/:id', async (c) => {
    const id = idParam(c);
    const input = await readJson(c, catalogPatchSchema);
    const row = await c.var.deps.db.asService(async (tx) => {
      const current = await catalogById(tx, id);
      const merchant = input.merchant ?? current.merchant;
      const kind = input.kind ?? current.kind;
      const gradeMin = input.gradeMin ?? current.grade_min;
      const gradeMax = input.gradeMax ?? current.grade_max;
      if (gradeMax < gradeMin)
        throw new ApiError('VALIDATION_FAILED', 'gradeMax must be >= gradeMin');
      if ((kind === 'parent_exercise' || kind === 'in_app_practice') && merchant !== 'none') {
        throw new ApiError(
          'VALIDATION_FAILED',
          'Free learning options never carry a merchant link',
        );
      }
      const url = canonicalMerchantUrl(
        merchant,
        input.merchantUrl === undefined ? current.merchant_url : input.merchantUrl,
      );
      // Any content change to a reviewed item needs a fresh human review.
      const status = current.status === 'approved' ? 'draft' : current.status;
      await tx`
        update public.resource_catalog set
          title = ${input.title ?? current.title}, description = ${input.description ?? current.description},
          skills = ${input.skills ?? current.skills},
          subjects = ${input.subjects ? [...new Set(input.subjects)] : current.subjects},
          grade_min = ${gradeMin}, grade_max = ${gradeMax}, kind = ${kind}, merchant = ${merchant}, merchant_url = ${url},
          image_asset_ref = ${input.imageAssetRef === undefined ? current.image_asset_ref : input.imageAssetRef},
          image_license_ref = ${input.imageLicenseRef === undefined ? current.image_license_ref : input.imageLicenseRef},
          status = ${status},
          reviewed_by = case when ${status} = 'draft' then null else reviewed_by end,
          reviewed_at = case when ${status} = 'draft' then null else reviewed_at end
        where id = ${id}
      `;
      await audit(tx, c, 'monetization.catalog_updated', 'resource', id, {
        fields: Object.keys(input),
      });
      return catalogById(tx, id);
    });
    return c.json(catalogBody(row));
  });

  r.post('/monetization/catalog/:id/approve', async (c) => {
    const id = idParam(c);
    const row = await c.var.deps.db.asService(async (tx) => {
      const current = await catalogById(tx, id);
      if (current.status !== 'draft')
        throw businessRule('INVALID_TRANSITION', `Cannot approve a ${current.status} resource`);
      await tx`
        update public.resource_catalog
           set status = 'approved', reviewed_by = ${c.var.parent.userId}, reviewed_at = ${c.var.deps.clock()}
         where id = ${id}
      `;
      await audit(tx, c, 'monetization.catalog_approved', 'resource', id);
      return catalogById(tx, id);
    });
    return c.json(catalogBody(row));
  });

  r.post('/monetization/catalog/:id/retire', async (c) => {
    const id = idParam(c);
    const row = await c.var.deps.db.asService(async (tx) => {
      await catalogById(tx, id);
      await tx`update public.resource_catalog set status = 'retired' where id = ${id}`;
      await audit(tx, c, 'monetization.catalog_retired', 'resource', id);
      return catalogById(tx, id);
    });
    return c.json(catalogBody(row));
  });

  r.post('/monetization/catalog/:id/link-check', async (c) => {
    const id = idParam(c);
    const { deps } = c.var;
    const current = await deps.db.asService((tx) => catalogById(tx, id));
    // Checks the canonical untagged URL only: a check never counts as a click or sets a cookie.
    const result = await checkMerchantLink(deps.config, current.merchant_url);
    await deps.db.asService(async (tx) => {
      if (result.status !== 'skipped') {
        await tx`
          update public.resource_catalog
             set availability = ${result.availability}, last_link_check_at = ${deps.clock()},
                 last_link_check_status = ${result.status}
           where id = ${id}
        `;
      } else {
        await tx`
          update public.resource_catalog set last_link_check_at = ${deps.clock()}, last_link_check_status = 'skipped'
           where id = ${id}
        `;
      }
      await audit(tx, c, 'monetization.catalog_link_checked', 'resource', id, {
        status: result.status,
        httpStatus: result.httpStatus,
      });
    });
    return c.json(result);
  });

  // ------------------------------------------------------------------ inappropriate-ad reports
  r.get('/monetization/ad-reports', async (c) => {
    const rows = await c.var.deps.db.asService(
      (tx) => tx<
        {
          id: string;
          campaign_id: string | null;
          catalog_id: string | null;
          category: 'inappropriate' | 'misleading' | 'irrelevant' | 'other';
          platform: MonetizationPlatform;
          placement: Placement;
          created_date: Date;
          status: 'open' | 'reviewed';
        }[]
      >`
        select id, campaign_id, catalog_id, category, platform, placement, created_date, status
          from public.ad_reports order by created_date desc, id limit 500
      `,
    );
    return c.json({
      reports: rows.map((r) => ({
        id: r.id,
        campaignId: r.campaign_id,
        catalogId: r.catalog_id,
        category: r.category,
        platform: r.platform,
        placement: r.placement,
        createdDate: r.created_date.toISOString().slice(0, 10),
        status: r.status,
      })),
    });
  });

  r.post('/monetization/ad-reports/:id/review', async (c) => {
    const id = idParam(c);
    await c.var.deps.db.asService(async (tx) => {
      const rows = await tx`
        update public.ad_reports set status = 'reviewed', reviewed_by = ${c.var.parent.userId}, reviewed_at = now()
         where id = ${id} and status = 'open' returning id
      `;
      if (rows.length === 0) throw new ApiError('NOT_FOUND', 'Open report not found');
      await audit(tx, c, 'monetization.ad_report_reviewed', 'ad_report', id);
    });
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------ revenue ledger
  r.post('/monetization/revenue/imports', async (c) => {
    const input = await readJson(c, revenueImportRequestSchema);
    const allowedProviders = SOURCE_PROVIDERS[input.source] ?? [];
    for (const [i, row] of input.rows.entries()) {
      if (!allowedProviders.includes(row.provider)) {
        throw new ApiError(
          'VALIDATION_FAILED',
          `Row ${i + 1}: ${row.provider} rows do not belong in a ${input.source} import`,
        );
      }
      if (row.provider !== 'amazon_associates' && row.placement === null) {
        throw new ApiError(
          'VALIDATION_FAILED',
          `Row ${i + 1}: sponsor and network revenue must name its placement`,
        );
      }
      if (row.campaignId !== null && row.provider !== 'sponsor_direct') {
        throw new ApiError(
          'VALIDATION_FAILED',
          `Row ${i + 1}: only sponsor revenue references a campaign`,
        );
      }
    }
    // Deterministic fingerprint of the file's content: a re-upload is refused, not double-counted.
    const fileSha256 = await sha256Hex(
      JSON.stringify({ source: input.source, periodMonth: input.periodMonth, rows: input.rows }),
    );
    const body = await c.var.deps.db.asService(async (tx) => {
      const [existing] = await tx<{ id: string }[]>`
        select id from public.revenue_imports where file_sha256 = ${fileSha256}
      `;
      if (existing) {
        throw new ApiError('CONFLICT', 'This file was already imported', {
          rule: 'DUPLICATE_IMPORT',
        });
      }
      const [imp] = await tx<{ id: string }[]>`
        insert into public.revenue_imports (source, file_sha256, period_month, imported_by, row_count, note)
        values (${input.source}, ${fileSha256}, ${input.periodMonth}, ${c.var.parent.userId}, ${input.rows.length}, ${input.note})
        returning id
      `;
      try {
        for (const row of input.rows) {
          await tx`
            insert into public.revenue_entries
              (import_id, source, external_ref, category, provider, campaign_id, placement, amount_cents, period_month)
            values (${imp!.id}, ${input.source}, ${row.externalRef}, ${row.category}, ${row.provider}, ${row.campaignId},
                    ${row.placement}, ${row.amountCents}, ${row.periodMonth ?? input.periodMonth})
          `;
        }
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ApiError('CONFLICT', 'A row in this file was already imported', {
            rule: 'DUPLICATE_ENTRY',
          });
        }
        throw error;
      }
      await audit(tx, c, 'monetization.revenue_imported', 'revenue_import', imp!.id, {
        source: input.source,
        periodMonth: input.periodMonth,
        rows: input.rows.length,
      });
      return { importId: imp!.id, fileSha256, rowCount: input.rows.length };
    });
    return c.json(body, 201);
  });

  r.post('/monetization/revenue/adjustments', async (c) => {
    const input = await readJson(c, revenueAdjustmentRequestSchema);
    if (input.kind !== 'correction' && input.amountCents >= 0) {
      throw new ApiError('VALIDATION_FAILED', 'Refunds and reversals are negative amounts');
    }
    const body = await c.var.deps.db.asService(async (tx) => {
      const [prior] = await tx<
        { id: string; entry_id: string; amount_cents: number; kind: string }[]
      >`
        select id, entry_id, amount_cents, kind from public.revenue_adjustments where idempotency_key = ${input.idempotencyKey}
      `;
      if (prior) {
        if (
          prior.entry_id !== input.entryId ||
          prior.amount_cents !== input.amountCents ||
          prior.kind !== input.kind
        ) {
          throw new ApiError(
            'CONFLICT',
            'This idempotency key was used for a different adjustment',
          );
        }
        return { id: prior.id, replayed: true };
      }
      const [entry] = await tx<{ amount_cents: number }[]>`
        select amount_cents from public.revenue_entries where id = ${input.entryId} for update
      `;
      if (!entry) throw new ApiError('NOT_FOUND', 'Revenue entry not found');
      const existing = await tx<{ amount_cents: number }[]>`
        select amount_cents from public.revenue_adjustments where entry_id = ${input.entryId}
      `;
      if (
        !adjustmentAllowed(
          entry.amount_cents,
          existing.map((e) => e.amount_cents),
          input.amountCents,
        )
      ) {
        throw businessRule(
          'ADJUSTMENT_EXCEEDS_ENTRY',
          'An adjustment cannot take an entry below zero',
        );
      }
      const [created] = await tx<{ id: string }[]>`
        insert into public.revenue_adjustments (entry_id, kind, amount_cents, reason, idempotency_key, created_by)
        values (${input.entryId}, ${input.kind}, ${input.amountCents}, ${input.reason}, ${input.idempotencyKey},
                ${c.var.parent.userId})
        returning id
      `;
      await audit(tx, c, 'monetization.revenue_adjusted', 'revenue_entry', input.entryId, {
        kind: input.kind,
        amountCents: input.amountCents,
      });
      return { id: created!.id, replayed: false };
    });
    return c.json(body, body.replayed ? 200 : 201);
  });

  async function summaryFor(tx: Tx, month: string, now: Date) {
    const entries = await tx<
      {
        id: string;
        category: RevenueCategory;
        provider: (typeof MONETIZATION_PROVIDERS)[number];
        placement: Placement | null;
        period_month: string;
        amount_cents: number;
      }[]
    >`
      select id, category, provider, placement, period_month, amount_cents
        from public.revenue_entries where period_month = ${month}
    `;
    const adjustments = await tx<
      { entry_id: string; kind: RevenueAdjustmentKind; amount_cents: number }[]
    >`
      select a.entry_id, a.kind, a.amount_cents from public.revenue_adjustments a
        join public.revenue_entries e on e.id = a.entry_id where e.period_month = ${month}
    `;
    // ALL active families (non-buyers, ad-free and hidden-card families included) vs adults who
    // could actually be shown a sponsor placement.
    const [cohorts] = await tx<{ active_families: number; ad_eligible_adults: number }[]>`
      select
        (select count(*)::int from public.families f where f.deleted_at is null) as active_families,
        (select count(*)::int
           from public.family_memberships m
           join public.families f on f.id = m.family_id and f.deleted_at is null
           left join public.family_monetization_prefs p on p.family_id = f.id
          where m.status = 'active' and coalesce(p.hide_sponsor_cards, false) = false
            and not exists (
              select 1 from public.family_entitlements e
                join public.store_feature_mappings sm
                  on sm.channel = e.channel and sm.product_id = e.product_id and sm.environment = e.environment
                 and sm.feature = 'ad_free' and sm.active
               where e.family_id = f.id
                 and (e.status in ('active', 'grace_period')
                      or (e.status = 'cancelled_active' and e.period_end > ${now})))) as ad_eligible_adults
    `;
    return revenueSummary(
      entries.map((e) => ({
        id: e.id,
        category: e.category,
        provider: e.provider,
        placement: e.placement,
        periodMonth: e.period_month,
        amountCents: e.amount_cents,
      })),
      adjustments.map((a) => ({ entryId: a.entry_id, kind: a.kind, amountCents: a.amount_cents })),
      {
        activeFamilies: cohorts?.active_families ?? 0,
        adEligibleAdults: cohorts?.ad_eligible_adults ?? 0,
      },
    );
  }

  r.get('/monetization/revenue/summary', async (c) => {
    const month = monthQuery(c);
    const now = c.var.deps.clock();
    const summary = await c.var.deps.db.asService((tx) => summaryFor(tx, month, now));
    return c.json({ month, ...summary });
  });

  // Aggregate campaign/date/platform totals only, with small-cohort suppression (AC_MON_16).
  r.get('/monetization/report', async (c) => {
    const month = monthQuery(c);
    const now = c.var.deps.clock();
    const body = await c.var.deps.db.asService(async (tx) => {
      const events = await tx<
        {
          campaign_id: string | null;
          catalog_id: string | null;
          platform: MonetizationPlatform;
          placement: Placement;
          kind: 'opportunity' | 'served' | 'viewable_impression' | 'click' | 'dismiss' | 'report';
          total: number;
        }[]
      >`
        select campaign_id, catalog_id, platform, placement, kind, sum(count)::int as total
          from public.aggregate_ad_events
         where to_char(event_date, 'YYYY-MM') = ${month}
         group by campaign_id, catalog_id, platform, placement, kind
         order by campaign_id nulls first, catalog_id nulls first, platform, placement, kind
      `;
      await audit(tx, c, 'monetization.report_viewed', 'monetization_report', month);
      return {
        month,
        minCohort: AGGREGATE_REPORT_MIN_COUNT,
        events: events.map((e) => {
          const count = suppressSmallCount(e.total);
          return {
            campaignId: e.campaign_id,
            catalogId: e.catalog_id,
            platform: e.platform,
            placement: e.placement,
            kind: e.kind,
            count,
            suppressed: count === null,
          };
        }),
        revenue: await summaryFor(tx, month, now),
        revenueFromImportsOnly: true as const,
      };
    });
    return c.json(body);
  });

  return r;
}
