import type { BillingChannel } from '@pencillift/domain';
import type { Designation } from '@pencillift/domain/donations';
import type {
  CampaignSnapshot,
  ChannelMapping,
  FamilyRedemptionRecord,
  PromoCodeRecord,
  PromoSubscriptionSnapshot,
  RedemptionState,
  SubscriberClass,
} from '@pencillift/domain/promotions';
import type { Tx } from '../db.ts';

/**
 * Data access for P17. Every function is scoped by an explicit family id because callers run as
 * service_role (RLS bypassed) for rows families must not list (codes, campaigns, mappings).
 */

const ACCESS_STATUSES = ['active', 'grace_period', 'billing_retry', 'cancelled_active'] as const;

interface EntitlementRow {
  channel: BillingChannel;
  status: string;
  period_start: Date | null;
  period_end: Date | null;
}

/** Normalized provider subscription for promotion targeting, or null for a never-subscribed family. */
export async function loadSubscriptionSnapshot(
  tx: Tx,
  familyId: string,
): Promise<PromoSubscriptionSnapshot | null> {
  const rows = await tx<EntitlementRow[]>`
    select channel, status, period_start, period_end
      from public.family_entitlements
     where family_id = ${familyId} and period_start is not null and period_end is not null
     order by (status = any(${[...ACCESS_STATUSES]})) desc, period_end desc
     limit 1
  `;
  const row = rows[0];
  if (!row?.period_start || !row.period_end) return null;
  const status = mapStatus(row.status);
  if (status === null) return null;
  const finalized = await tx<{ period_start: Date }[]>`
    select period_start from public.billing_periods
     where family_id = ${familyId} and channel = ${row.channel} and kind = 'subscription_period'
       and period_start >= ${row.period_end} and settlement <> 'pending'
  `;
  return {
    status,
    channel: row.channel,
    currentPeriodStart: row.period_start,
    currentPeriodEnd: row.period_end,
    finalizedPeriodStarts: finalized.map((f) => f.period_start),
  };
}

function mapStatus(status: string): PromoSubscriptionSnapshot['status'] | null {
  switch (status) {
    case 'active':
    case 'cancelled_active':
    case 'grace_period':
    case 'billing_retry':
    case 'expired':
      return status;
    case 'revoked':
    case 'refunded':
      return 'expired';
    default:
      // 'pending' (e.g. Ask to Buy): nothing verified yet, so the family is treated as new.
      return null;
  }
}

export async function loadDesignations(tx: Tx, familyId: string): Promise<Designation[]> {
  const rows = await tx<{ school_id: string; from_month: string; to_month: string | null }[]>`
    select school_id, to_char(effective_from, 'YYYY-MM') as from_month, to_char(effective_to, 'YYYY-MM') as to_month
      from public.family_school_designations where family_id = ${familyId}
  `;
  return rows.map((r) => ({
    schoolId: r.school_id,
    effectiveFromMonth: r.from_month,
    effectiveToMonth: r.to_month,
  }));
}

export function monthToDate(month: string): string {
  return `${month}-01`;
}

export interface RedemptionContext {
  readonly code: PromoCodeRecord;
  readonly campaign: CampaignSnapshot & { readonly campaignMonth: string };
  readonly mappings: ChannelMapping[];
  /** Provider offer id per `${channel}:${paidSlots}` for ready mappings (what the client presents). */
  readonly offerIds: ReadonlyMap<string, string>;
  readonly familyRedemptions: FamilyRedemptionRecord[];
  readonly paidSlots: number;
  readonly childProfiles: number;
}

/**
 * Loads everything validateRedemption needs. With `lock`, the campaign row and the family row are
 * locked FOR UPDATE so caps, budget and per-family uniqueness are evaluated serially; the partial
 * unique indexes remain the final guard.
 */
export async function loadRedemptionContext(
  tx: Tx,
  familyId: string,
  codeNormalized: string,
  options: { lock: boolean },
): Promise<RedemptionContext | null> {
  const [code] = await tx<
    { id: string; campaign_id: string; usage_cap: number | null; status: 'active' | 'revoked' }[]
  >`
    select id, campaign_id, usage_cap, status from public.promo_codes where code_normalized = ${codeNormalized}
  `;
  if (!code) return null;
  if (options.lock) {
    await tx`select 1 from public.families where id = ${familyId} for update`;
    await tx`select 1 from public.promo_campaigns where id = ${code.campaign_id} for update`;
  }
  const [campaign] = await tx<
    {
      id: string;
      template_id: string;
      campaign_month: string;
      status: CampaignSnapshot['status'];
      opens_at: Date;
      closes_at: Date;
      percent_off: number;
      eligible_tiers: number[];
      subscriber_eligibility: SubscriberClass[];
      redemption_cap: number;
      budget_cap_cents: number;
      school_id: string | null;
    }[]
  >`
    select id, template_id, campaign_month, status, opens_at, closes_at, percent_off, eligible_tiers,
           subscriber_eligibility, redemption_cap, budget_cap_cents, school_id
      from public.promo_campaigns where id = ${code.campaign_id}
  `;
  if (!campaign) return null;
  const [usage] = await tx<{ live: number; committed: number; code_uses: number }[]>`
    select count(*)::int as live,
           coalesce(sum(discount_cents), 0)::int as committed,
           (count(*) filter (where code_id = ${code.id}))::int as code_uses
      from public.promo_redemptions
     where campaign_id = ${campaign.id} and state in ('reserved', 'provider_pending', 'confirmed', 'reconciled')
  `;
  const mappings = await tx<
    {
      channel: BillingChannel;
      paid_slots: number;
      status: ChannelMapping['status'];
      provider_offer_id: string | null;
      reason: string | null;
    }[]
  >`
    select channel, paid_slots, status, provider_offer_id, reason
      from public.provider_offer_mappings where campaign_id = ${campaign.id}
  `;
  const familyRedemptions = await tx<
    { campaign_id: string; state: RedemptionState; target_period_key: string }[]
  >`
    select campaign_id, state, target_period_key from public.promo_redemptions where family_id = ${familyId}
  `;
  const [capacity] = await tx<
    { paid_slots: number }[]
  >`select paid_slots from public.family_capacity where family_id = ${familyId}`;
  const [children] = await tx<{ n: number }[]>`
    select count(*)::int as n from public.child_profiles where family_id = ${familyId} and status in ('draft', 'active')
  `;
  return {
    code: {
      codeId: code.id,
      campaignId: code.campaign_id,
      usageCount: usage?.code_uses ?? 0,
      usageCap: code.usage_cap,
      status: code.status,
    },
    campaign: {
      id: campaign.id,
      templateId: campaign.template_id,
      campaignMonth: campaign.campaign_month,
      status: campaign.status,
      opensAt: campaign.opens_at,
      closesAt: campaign.closes_at,
      percentOff: campaign.percent_off,
      eligibleTiers: campaign.eligible_tiers,
      subscriberEligibility: campaign.subscriber_eligibility,
      redemptionCap: campaign.redemption_cap,
      liveRedemptionCount: usage?.live ?? 0,
      budgetCapCents: campaign.budget_cap_cents,
      committedDiscountCents: usage?.committed ?? 0,
      schoolId: campaign.school_id,
    },
    mappings: mappings.map((m): ChannelMapping => ({
      campaignId: campaign.id,
      channel: m.channel,
      paidSlots: m.paid_slots,
      status: m.status,
      ...(m.reason === null ? {} : { reason: m.reason }),
    })),
    offerIds: new Map(
      mappings
        .filter((m) => m.status === 'ready' && m.provider_offer_id !== null)
        .map((m) => [`${m.channel}:${m.paid_slots}`, m.provider_offer_id!] as const),
    ),
    familyRedemptions: familyRedemptions.map((r) => ({
      familyId,
      campaignId: r.campaign_id,
      state: r.state,
      targetPeriodKey: r.target_period_key,
    })),
    paidSlots: capacity?.paid_slots ?? 0,
    childProfiles: children?.n ?? 0,
  };
}
