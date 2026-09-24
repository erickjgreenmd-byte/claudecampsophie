import {
  addMonths,
  monthBoundsUtc,
  type BillingPeriodFact,
  type RandomSource,
} from '@pencillift/domain';
import { planAccruals, type SchoolStatus } from '@pencillift/domain/donations';
import {
  explainMonthlyGeneration,
  generatePromoCodes,
  type CampaignTemplate,
  type GenerationPreview,
} from '@pencillift/domain/promotions';
import type { Db, Tx } from '../db.ts';
import { isUniqueViolation } from '../errors.ts';
import { loadDesignations } from './promotions-data.ts';

/**
 * P17 scheduled work, shared by the owner console and the cron dispatcher. Both are idempotent:
 * unique database keys (generation key, family/month donation key) make retries and concurrent
 * workers harmless.
 */

interface TemplateRow {
  id: string;
  name: string;
  school_id: string | null;
  percent_off: number;
  eligible_tiers: number[];
  subscriber_eligibility: ('new' | 'existing' | 'lapsed')[];
  redemption_cap: number;
  budget_cap_cents: number;
  calendar_timezone: string;
  timezone_confirmed: boolean;
  window_start_day: number;
  window_end_day: number;
  code_mode: 'shared' | 'individual';
  individual_code_count: number | null;
  shared_code_usage_cap: number | null;
  channels: ('app_store' | 'play_store' | 'stripe')[];
  enabled: boolean;
  paused: boolean;
  created_at: Date;
}

export async function loadTemplates(tx: Tx): Promise<TemplateRow[]> {
  return tx<TemplateRow[]>`
    select id, name, school_id, percent_off, eligible_tiers, subscriber_eligibility, redemption_cap, budget_cap_cents,
           calendar_timezone, timezone_confirmed, window_start_day, window_end_day, code_mode, individual_code_count,
           shared_code_usage_cap, channels, enabled, paused, created_at
      from public.promo_campaign_templates order by created_at
  `;
}

export function toDomainTemplate(row: TemplateRow): CampaignTemplate {
  return {
    id: row.id,
    enabled: row.enabled,
    paused: row.paused,
    schoolId: row.school_id,
    percentOff: row.percent_off,
    eligibleTiers: row.eligible_tiers,
    subscriberEligibility: row.subscriber_eligibility,
    redemptionCap: row.redemption_cap,
    budgetCapCents: row.budget_cap_cents,
    calendarTimezone: row.calendar_timezone,
    timezoneConfirmed: row.timezone_confirmed,
    redemptionWindow: {
      startDay: row.window_start_day,
      endDay: row.window_end_day === 0 ? 'end_of_month' : row.window_end_day,
    },
    codeMode: row.code_mode,
    ...(row.individual_code_count === null
      ? {}
      : { individualCodeCount: row.individual_code_count }),
    ...(row.shared_code_usage_cap === null
      ? {}
      : { sharedCodeUsageCap: row.shared_code_usage_cap }),
    channels: row.channels,
  };
}

export async function previewGeneration(
  tx: Tx,
  month: string,
): Promise<{ preview: GenerationPreview; templates: TemplateRow[] }> {
  const templates = await loadTemplates(tx);
  const existing = await tx<{ generation_key: string }[]>`
    select generation_key from public.promo_campaigns where campaign_month = ${month}
  `;
  const preview = explainMonthlyGeneration({
    templates: templates.map(toDomainTemplate),
    month,
    existingGenerationKeys: new Set(existing.map((e) => e.generation_key)),
  });
  return { preview, templates };
}

export interface GenerationRunResult {
  readonly month: string;
  readonly created: { campaignId: string; generationKey: string; codeCount: number }[];
  readonly skippedExisting: string[];
}

/** Generates each planned campaign in its own transaction; a concurrent worker's copy is skipped. */
export async function runGeneration(
  db: Db,
  month: string,
  random: RandomSource,
): Promise<GenerationRunResult> {
  const { preview, templates } = await db.asService((tx) => previewGeneration(tx, month));
  const byId = new Map(templates.map((t) => [t.id, t]));
  const created: GenerationRunResult['created'] = [];
  const skippedExisting = preview.skipped
    .filter((s) => s.reason === 'ALREADY_GENERATED')
    .map((s) => `${s.templateId}:${month}`);
  for (const plan of preview.planned) {
    const template = byId.get(plan.templateId)!;
    const result = await db
      .asService(async (tx) => {
        const [campaign] = await tx<{ id: string }[]>`
        insert into public.promo_campaigns
          (template_id, campaign_month, generation_key, school_id, percent_off, eligible_tiers, subscriber_eligibility,
           redemption_cap, budget_cap_cents, opens_at, closes_at, status)
        values (${template.id}, ${month}, ${plan.generationKey}, ${template.school_id}, ${plan.percentOff},
                ${template.eligible_tiers}, ${template.subscriber_eligibility}, ${template.redemption_cap},
                ${template.budget_cap_cents}, ${plan.window.opensAt}, ${plan.window.closesAt}, 'provisioning')
        on conflict (generation_key) do nothing
        returning id
      `;
        if (!campaign) return null;
        const usageCap = template.code_mode === 'individual' ? 1 : template.shared_code_usage_cap;
        const codes = generatePromoCodes(random, plan.codeCount);
        for (const code of codes) {
          await tx`
          insert into public.promo_codes (campaign_id, code_normalized, usage_cap)
          values (${campaign.id}, ${code.normalized}, ${usageCap})
        `;
        }
        // Every channel x tier starts pending: a code is never usable until its provider offer is ready.
        for (const channel of template.channels) {
          for (const slots of template.eligible_tiers) {
            await tx`
            insert into public.provider_offer_mappings (campaign_id, channel, paid_slots, status)
            values (${campaign.id}, ${channel}, ${slots}, 'pending')
          `;
          }
        }
        await tx`
        insert into public.audit_events (actor_kind, action, target_type, target_id, metadata)
        values ('system', 'promo.campaign_generated', 'promo_campaign', ${campaign.id},
                ${JSON.stringify({ generationKey: plan.generationKey, codes: codes.length })}::text::jsonb)
      `;
        return {
          campaignId: campaign.id,
          generationKey: plan.generationKey,
          codeCount: codes.length,
        };
      })
      .catch((error: unknown) => {
        // A code collision with another campaign is astronomically unlikely (50 bits); surface it.
        if (isUniqueViolation(error, 'promo_codes_code_normalized_key'))
          throw new Error('Promo code collision; rerun generation');
        throw error;
      });
    if (result) created.push(result);
    else skippedExisting.push(plan.generationKey);
  }
  return { month, created, skippedExisting };
}

interface PeriodRow {
  id: string;
  family_id: string;
  channel: BillingPeriodFact['channel'];
  provider_period_id: string;
  kind: BillingPeriodFact['kind'];
  period_start: Date;
  period_end: Date;
  paid_slots: number;
  regular_amount_cents: number;
  charged_amount_cents: number;
  discount_cents: number;
  discount_sources: BillingPeriodFact['discountSources'][number][];
  settlement: BillingPeriodFact['settlement'];
  settled_at: Date | null;
  refunded_cents: number;
}

function toFact(row: PeriodRow): BillingPeriodFact {
  return {
    familyId: row.family_id,
    channel: row.channel,
    providerPeriodId: row.provider_period_id,
    kind: row.kind,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    paidSlots: row.paid_slots,
    regularAmountCents: row.regular_amount_cents,
    chargedAmountCents: row.charged_amount_cents,
    discountCents: row.discount_cents,
    discountSources: row.discount_sources,
    settlement: row.settlement,
    settledAt: row.settled_at,
    refundedCents: row.refunded_cents,
  };
}

export interface AccrualRunResult {
  readonly month: string;
  readonly familiesEvaluated: number;
  readonly accrued: number;
  readonly skipped: number;
}

/**
 * Accrues $1 per eligible family/month for periods starting in `month` and the two months before
 * (late settlements are recorded against their original month). Families are processed one per
 * transaction; the (family, month) and billing-period unique keys make reruns harmless. Deleted
 * families are skipped.
 */
export async function runDonationAccrual(
  db: Db,
  month: string,
  programZone: string,
): Promise<AccrualRunResult> {
  const windowStart = monthBoundsUtc(addMonths(month, -2), programZone).start;
  const windowEnd = monthBoundsUtc(month, programZone).end;
  const families = await db.asService(
    (tx) => tx<{ family_id: string }[]>`
      select distinct p.family_id from public.billing_periods p
        join public.families f on f.id = p.family_id and f.deleted_at is null
       where p.kind = 'subscription_period' and p.period_start >= ${windowStart} and p.period_start < ${windowEnd}
    `,
  );
  let accrued = 0;
  let skipped = 0;
  for (const { family_id: familyId } of families) {
    const counts = await db.asService(async (tx) => {
      await tx`select 1 from public.families where id = ${familyId} for update`;
      const periods = await tx<PeriodRow[]>`
        select id, family_id, channel, provider_period_id, kind, period_start, period_end, paid_slots, regular_amount_cents,
               charged_amount_cents, discount_cents, discount_sources, settlement, settled_at, refunded_cents
          from public.billing_periods
         where family_id = ${familyId} and period_start >= ${windowStart} and period_start < ${windowEnd}
      `;
      const designations = await loadDesignations(tx, familyId);
      const schoolRows = await tx<{ id: string; status: string }[]>`
        select id, status from public.schools where id = any(${designations.map((d) => d.schoolId)})
      `;
      const statuses = new Map(schoolRows.map((s) => [s.id, s.status]));
      const existing = await tx<{ donation_month: string }[]>`
        select donation_month from public.donation_accruals where family_id = ${familyId}
      `;
      const plan = planAccruals({
        periods: periods.map(toFact),
        designations,
        programZone,
        schoolStatus: (id): SchoolStatus => {
          const status = statuses.get(id);
          return status === 'active' ? 'active' : status === undefined ? 'unknown' : 'inactive';
        },
        existingAccrualMonths: new Set(existing.map((e) => e.donation_month)),
      });
      const periodIds = new Map(periods.map((p) => [p.provider_period_id, p.id]));
      let inserted = 0;
      for (const a of plan.accruals) {
        const billingPeriodId = periodIds.get(a.providerPeriodId);
        if (billingPeriodId === undefined)
          throw new Error('Accrual references a period outside the evaluated window');
        const rows = await tx`
          insert into public.donation_accruals (family_id, school_id, donation_month, amount_cents, billing_period_id, eligibility_snapshot)
          values (${familyId}, ${a.schoolId}, ${a.donationMonth}, ${a.amountCents}, ${billingPeriodId}, ${JSON.stringify(a.snapshot)}::text::jsonb)
          on conflict do nothing
          returning id
        `;
        inserted += rows.length;
      }
      return { inserted, skipped: plan.skipped.length };
    });
    accrued += counts.inserted;
    skipped += counts.skipped;
  }
  return { month, familiesEvaluated: families.length, accrued, skipped };
}
