import { Hono, type Context } from 'hono';
import {
  calendarMonthSchema,
  campaignActionSchema,
  createSchoolRequestSchema,
  generationRequestSchema,
  markPayoutPaidRequestSchema,
  offerMappingInputSchema,
  preparePayoutRequestSchema,
  promoTemplateInputSchema,
  uuidSchema,
} from '@pencillift/contracts';
import { buildPayoutBatch, transitionPayout } from '@pencillift/domain/donations';
import {
  formatPromoCode,
  redemptionWindowUtc,
  validateTemplateForActivation,
} from '@pencillift/domain/promotions';
import { readJson } from '../app.ts';
import type { Tx } from '../db.ts';
import { ApiError, businessRule } from '../errors.ts';
import { requireOwnerAdmin, requireParent } from '../middleware/auth.ts';
import type { AppEnv } from '../middleware/context.ts';
import {
  loadTemplates,
  previewGeneration,
  runGeneration,
  toDomainTemplate,
} from '../services/p17-jobs.ts';

type Ctx = Context<AppEnv>;

function idParam(c: Ctx, name: string): string {
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
) {
  await tx`
    insert into public.audit_events (actor_user_id, actor_kind, action, target_type, target_id, metadata)
    values (${c.var.parent.userId}, 'admin', ${action}, ${targetType}, ${targetId}, ${JSON.stringify(metadata)}::text::jsonb)
  `;
}

type TemplateRow = Awaited<ReturnType<typeof loadTemplates>>[number];

function templateBody(t: TemplateRow) {
  return {
    id: t.id,
    name: t.name,
    schoolId: t.school_id,
    percentOff: t.percent_off,
    eligibleTiers: t.eligible_tiers,
    subscriberEligibility: t.subscriber_eligibility,
    redemptionCap: t.redemption_cap,
    budgetCapCents: t.budget_cap_cents,
    calendarTimezone: t.calendar_timezone,
    timezoneConfirmed: t.timezone_confirmed,
    windowStartDay: t.window_start_day,
    windowEndDay: t.window_end_day === 0 ? ('end_of_month' as const) : t.window_end_day,
    codeMode: t.code_mode,
    ...(t.individual_code_count === null ? {} : { individualCodeCount: t.individual_code_count }),
    ...(t.shared_code_usage_cap === null ? {} : { sharedCodeUsageCap: t.shared_code_usage_cap }),
    channels: t.channels,
    enabled: t.enabled,
    paused: t.paused,
    createdAt: t.created_at.toISOString(),
  };
}

async function templateById(tx: Tx, id: string): Promise<TemplateRow> {
  const found = (await loadTemplates(tx)).find((t) => t.id === id);
  if (!found) throw new ApiError('NOT_FOUND', 'Template not found');
  return found;
}

/** Owner-admin P17 console routes (MFA session required on every call). */
export function adminPromotionsRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireParent);
  r.use('*', requireOwnerAdmin);

  // ------------------------------------------------------------------ templates
  r.get('/promo-templates', async (c) => {
    const rows = await c.var.deps.db.asService((tx) => loadTemplates(tx));
    return c.json({ templates: rows.map(templateBody) });
  });

  r.post('/promo-templates', async (c) => {
    const input = await readJson(c, promoTemplateInputSchema);
    const row = await c.var.deps.db.asService(async (tx) => {
      const [created] = await tx<{ id: string }[]>`
        insert into public.promo_campaign_templates
          (name, school_id, percent_off, eligible_tiers, subscriber_eligibility, redemption_cap, budget_cap_cents,
           calendar_timezone, timezone_confirmed, window_start_day, window_end_day, code_mode, individual_code_count,
           shared_code_usage_cap, channels, enabled, created_by)
        values (${input.name}, ${input.schoolId}, ${input.percentOff}, ${input.eligibleTiers}, ${input.subscriberEligibility},
                ${input.redemptionCap}, ${input.budgetCapCents}, ${input.calendarTimezone}, ${input.timezoneConfirmed},
                ${input.windowStartDay}, ${input.windowEndDay === 'end_of_month' ? 0 : input.windowEndDay}, ${input.codeMode},
                ${input.individualCodeCount ?? null}, ${input.sharedCodeUsageCap ?? null}, ${input.channels}, false,
                ${c.var.parent.userId})
        returning id
      `;
      await audit(tx, c, 'promo.template_created', 'promo_template', created!.id);
      return templateById(tx, created!.id);
    });
    return c.json(templateBody(row), 201);
  });

  r.patch('/promo-templates/:id', async (c) => {
    const id = idParam(c, 'id');
    const input = await readJson(
      c,
      promoTemplateInputSchema
        .partial()
        .extend({ paused: promoTemplateInputSchema.shape.timezoneConfirmed.optional() }),
    );
    const row = await c.var.deps.db.asService(async (tx) => {
      const current = await templateById(tx, id);
      const merged = {
        name: input.name ?? current.name,
        school_id: input.schoolId === undefined ? current.school_id : input.schoolId,
        percent_off: input.percentOff ?? current.percent_off,
        eligible_tiers: input.eligibleTiers ?? current.eligible_tiers,
        subscriber_eligibility: input.subscriberEligibility ?? current.subscriber_eligibility,
        redemption_cap: input.redemptionCap ?? current.redemption_cap,
        budget_cap_cents: input.budgetCapCents ?? current.budget_cap_cents,
        calendar_timezone: input.calendarTimezone ?? current.calendar_timezone,
        // Changing the zone always requires a fresh confirmation (spec P17: zone visible before activation).
        timezone_confirmed:
          input.calendarTimezone !== undefined &&
          input.calendarTimezone !== current.calendar_timezone
            ? (input.timezoneConfirmed ?? false)
            : (input.timezoneConfirmed ?? current.timezone_confirmed),
        window_start_day: input.windowStartDay ?? current.window_start_day,
        window_end_day:
          input.windowEndDay === undefined
            ? current.window_end_day
            : input.windowEndDay === 'end_of_month'
              ? 0
              : input.windowEndDay,
        code_mode: input.codeMode ?? current.code_mode,
        individual_code_count: input.individualCodeCount ?? current.individual_code_count,
        shared_code_usage_cap: input.sharedCodeUsageCap ?? current.shared_code_usage_cap,
        channels: input.channels ?? current.channels,
        paused: input.paused ?? current.paused,
      };
      // Editing an enabled template that no longer validates disables it rather than generating from it.
      const stillValid = validateTemplateForActivation(
        toDomainTemplate({ ...current, ...merged, enabled: current.enabled }),
      ).ok;
      await tx`
        update public.promo_campaign_templates set
          name = ${merged.name}, school_id = ${merged.school_id}, percent_off = ${merged.percent_off},
          eligible_tiers = ${merged.eligible_tiers}, subscriber_eligibility = ${merged.subscriber_eligibility},
          redemption_cap = ${merged.redemption_cap}, budget_cap_cents = ${merged.budget_cap_cents},
          calendar_timezone = ${merged.calendar_timezone}, timezone_confirmed = ${merged.timezone_confirmed},
          window_start_day = ${merged.window_start_day}, window_end_day = ${merged.window_end_day},
          code_mode = ${merged.code_mode}, individual_code_count = ${merged.individual_code_count},
          shared_code_usage_cap = ${merged.shared_code_usage_cap}, channels = ${merged.channels},
          paused = ${merged.paused}, enabled = ${current.enabled && stillValid}
        where id = ${id}
      `;
      await audit(tx, c, 'promo.template_updated', 'promo_template', id);
      return templateById(tx, id);
    });
    return c.json(templateBody(row));
  });

  r.post('/promo-templates/:id/activate', async (c) => {
    const id = idParam(c, 'id');
    const result = await c.var.deps.db.asService(async (tx) => {
      const current = await templateById(tx, id);
      const checked = validateTemplateForActivation({
        ...toDomainTemplate(current),
        enabled: true,
      });
      if (!checked.ok) {
        const details = checked.error.details as { problems?: unknown } | undefined;
        const problems = Array.isArray(details?.problems)
          ? details.problems.map(String)
          : [checked.error.code];
        return { ok: false, problems };
      }
      await tx`update public.promo_campaign_templates set enabled = true where id = ${id}`;
      await audit(tx, c, 'promo.template_activated', 'promo_template', id);
      return { ok: true, problems: [] as string[] };
    });
    return c.json(result);
  });

  // ------------------------------------------------------------------ monthly generation
  r.get('/promo-generation/preview', async (c) => {
    const month = monthQuery(c);
    const { preview, templates } = await c.var.deps.db.asService((tx) =>
      previewGeneration(tx, month),
    );
    const names = new Map(templates.map((t) => [t.id, t.name]));
    const byId = new Map(templates.map((t) => [t.id, t]));
    const already = preview.skipped
      .filter((s) => s.reason === 'ALREADY_GENERATED')
      .map((s) => {
        const t = byId.get(s.templateId)!;
        const domain = toDomainTemplate(t);
        const window = redemptionWindowUtc(month, domain.calendarTimezone, domain.redemptionWindow);
        return {
          templateId: t.id,
          templateName: t.name,
          generationKey: `${t.id}:${month}`,
          percentOff: t.percent_off,
          opensAt: window.opensAt.toISOString(),
          closesAt: window.closesAt.toISOString(),
          codeCount: t.code_mode === 'individual' ? (t.individual_code_count ?? 0) : 1,
          alreadyGenerated: true,
        };
      });
    const items = [
      ...already,
      ...preview.planned.map((p) => ({
        templateId: p.templateId,
        templateName: names.get(p.templateId) ?? '',
        generationKey: p.generationKey,
        percentOff: p.percentOff,
        opensAt: p.window.opensAt.toISOString(),
        closesAt: p.window.closesAt.toISOString(),
        codeCount: p.codeCount,
        alreadyGenerated: false,
      })),
    ];
    return c.json({ month, items });
  });

  r.post('/promo-generation/run', async (c) => {
    const { month } = await readJson(c, generationRequestSchema);
    const result = await runGeneration(c.var.deps.db, month, c.var.deps.random);
    await c.var.deps.db.asService((tx) =>
      audit(tx, c, 'promo.generation_run', 'promo_month', month, {
        created: result.created.length,
      }),
    );
    return c.json(result);
  });

  // ------------------------------------------------------------------ campaigns
  r.get('/campaigns', async (c) => {
    const month = monthQuery(c);
    const rows = await c.var.deps.db.asService(async (tx) => {
      const campaigns = await tx<
        {
          id: string;
          template_id: string;
          campaign_month: string;
          status: 'provisioning' | 'active' | 'paused' | 'revoked' | 'ended' | 'failed';
          percent_off: number;
          school_id: string | null;
          opens_at: Date;
          closes_at: Date;
          redemption_cap: number;
          budget_cap_cents: number;
          live: number;
          confirmed: number;
          committed: number;
        }[]
      >`
        select c.id, c.template_id, c.campaign_month, c.status, c.percent_off, c.school_id, c.opens_at, c.closes_at,
               c.redemption_cap, c.budget_cap_cents,
               count(r.id) filter (where r.state in ('reserved','provider_pending','confirmed','reconciled'))::int as live,
               count(r.id) filter (where r.state in ('confirmed','reconciled'))::int as confirmed,
               coalesce(sum(r.discount_cents) filter (where r.state in ('reserved','provider_pending','confirmed','reconciled')), 0)::int as committed
          from public.promo_campaigns c
          left join public.promo_redemptions r on r.campaign_id = c.id
         where c.campaign_month = ${month}
         group by c.id
         order by c.created_at
      `;
      const mappings = await tx<
        {
          campaign_id: string;
          channel: 'app_store' | 'play_store' | 'stripe';
          paid_slots: number;
          status: 'pending' | 'ready' | 'failed' | 'unsupported';
          provider_offer_id: string | null;
          reason: string | null;
        }[]
      >`
        select campaign_id, channel, paid_slots, status, provider_offer_id, reason from public.provider_offer_mappings
         where campaign_id = any(${campaigns.map((x) => x.id)}) order by channel, paid_slots
      `;
      return campaigns.map((x) => ({
        id: x.id,
        templateId: x.template_id,
        campaignMonth: x.campaign_month,
        status: x.status,
        percentOff: x.percent_off,
        schoolId: x.school_id,
        opensAt: x.opens_at.toISOString(),
        closesAt: x.closes_at.toISOString(),
        redemptionCap: x.redemption_cap,
        liveRedemptions: x.live,
        confirmedRedemptions: x.confirmed,
        budgetCapCents: x.budget_cap_cents,
        committedDiscountCents: x.committed,
        offerMappings: mappings
          .filter((m) => m.campaign_id === x.id)
          .map((m) => ({
            channel: m.channel,
            paidSlots: m.paid_slots,
            status: m.status,
            providerOfferId: m.provider_offer_id,
            reason: m.reason,
          })),
      }));
    });
    return c.json({ campaigns: rows });
  });

  r.post('/campaigns/:id/action', async (c) => {
    const id = idParam(c, 'id');
    const { action } = await readJson(c, campaignActionSchema);
    await c.var.deps.db.asService(async (tx) => {
      const [campaign] = await tx<
        { status: string }[]
      >`select status from public.promo_campaigns where id = ${id} for update`;
      if (!campaign) throw new ApiError('NOT_FOUND', 'Campaign not found');
      const allowed: Record<string, string[]> = {
        pause: ['active', 'provisioning'],
        resume: ['paused'],
        revoke: ['active', 'paused', 'provisioning', 'failed'],
      };
      if (!allowed[action]!.includes(campaign.status)) {
        throw businessRule('INVALID_TRANSITION', `Cannot ${action} a ${campaign.status} campaign`);
      }
      const target = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'revoked';
      await tx`update public.promo_campaigns set status = ${target} where id = ${id}`;
      // Revoking stops new redemptions; already confirmed benefits are never taken back (spec P17).
      if (action === 'revoke')
        await tx`update public.promo_codes set status = 'revoked' where campaign_id = ${id}`;
      await audit(tx, c, `promo.campaign_${action}`, 'promo_campaign', id);
    });
    return c.json({ ok: true });
  });

  r.put('/campaigns/:id/offer-mappings', async (c) => {
    const id = idParam(c, 'id');
    const input = await readJson(c, offerMappingInputSchema);
    if (input.status === 'ready' && !input.providerOfferId) {
      throw new ApiError('VALIDATION_FAILED', 'A ready mapping needs the provider offer id');
    }
    if ((input.status === 'failed' || input.status === 'unsupported') && !input.reason) {
      throw new ApiError('VALIDATION_FAILED', 'Explain why the mapping failed or is unsupported');
    }
    await c.var.deps.db.asService(async (tx) => {
      const [campaign] = await tx<
        { status: string }[]
      >`select status from public.promo_campaigns where id = ${id} for update`;
      if (!campaign) throw new ApiError('NOT_FOUND', 'Campaign not found');
      await tx`
        insert into public.provider_offer_mappings (campaign_id, channel, paid_slots, provider_offer_id, status, reason, updated_at)
        values (${id}, ${input.channel}, ${input.paidSlots}, ${input.providerOfferId}, ${input.status}, ${input.reason}, now())
        on conflict (campaign_id, channel, paid_slots) do update
          set provider_offer_id = excluded.provider_offer_id, status = excluded.status, reason = excluded.reason, updated_at = now()
      `;
      // The first ready channel makes a provisioning campaign redeemable (per-channel readiness still applies).
      if (input.status === 'ready' && campaign.status === 'provisioning') {
        await tx`update public.promo_campaigns set status = 'active' where id = ${id}`;
      }
      await audit(tx, c, 'promo.offer_mapping_set', 'promo_campaign', id, {
        channel: input.channel,
        paidSlots: input.paidSlots,
        status: input.status,
      });
    });
    return c.json({ ok: true });
  });

  r.get('/campaigns/:id/codes', async (c) => {
    const id = idParam(c, 'id');
    const codes = await c.var.deps.db.asService(
      (tx) => tx<
        {
          id: string;
          code_normalized: string;
          usage_cap: number | null;
          status: 'active' | 'revoked';
        }[]
      >`
        select id, code_normalized, usage_cap, status from public.promo_codes where campaign_id = ${id} order by created_at limit 5000
      `,
    );
    await c.var.deps.db.asService((tx) => audit(tx, c, 'promo.codes_viewed', 'promo_campaign', id));
    return c.json({
      campaignId: id,
      codes: codes.map((x) => ({
        id: x.id,
        code: formatPromoCode(x.code_normalized),
        usageCap: x.usage_cap,
        status: x.status,
      })),
    });
  });

  // ------------------------------------------------------------------ schools and reports
  r.get('/schools', async (c) => {
    const rows = await c.var.deps.db.asService(
      (tx) => tx<
        {
          id: string;
          name: string;
          city: string | null;
          region: string | null;
          status: 'pending_verification' | 'active' | 'inactive';
          recipient_verified: boolean;
        }[]
      >`
        select id, name, city, region, status, recipient_verified from public.schools order by name
      `,
    );
    return c.json({
      schools: rows.map((s) => ({
        id: s.id,
        name: s.name,
        city: s.city,
        region: s.region,
        status: s.status,
        recipientVerified: s.recipient_verified,
      })),
    });
  });

  r.post('/schools', async (c) => {
    const input = await readJson(c, createSchoolRequestSchema);
    const row = await c.var.deps.db.asService(async (tx) => {
      const [created] = await tx<
        {
          id: string;
          name: string;
          city: string | null;
          region: string | null;
          status: 'pending_verification';
          recipient_verified: boolean;
        }[]
      >`
        insert into public.schools (name, city, region) values (${input.name}, ${input.city}, ${input.region})
        returning id, name, city, region, status, recipient_verified
      `;
      await audit(tx, c, 'school.created', 'school', created!.id);
      return created!;
    });
    return c.json(
      {
        id: row.id,
        name: row.name,
        city: row.city,
        region: row.region,
        status: row.status,
        recipientVerified: row.recipient_verified,
      },
      201,
    );
  });

  r.get('/schools/:id/report', async (c) => {
    const id = idParam(c, 'id');
    const month = monthQuery(c);
    // Runs as the admin's own role so the report function applies its authorization and suppression rules.
    const [row] = await c.var.deps.db.asParent(
      c.var.parent,
      (tx) => tx<
        {
          school_id: string;
          donation_month: string;
          attributed_signups: string;
          donation_eligible_families: string;
          accrued_cents: string | null;
          paid_cents: string | null;
        }[]
      >`
        select * from public.school_month_report(${id}, ${month})
      `,
    );
    if (!row) throw new ApiError('NOT_FOUND', 'School not found');
    return c.json({
      schoolId: row.school_id,
      month: row.donation_month,
      attributedSignups: row.attributed_signups,
      donationEligibleFamilies: row.donation_eligible_families,
      accruedCents: row.accrued_cents === null ? null : Number(row.accrued_cents),
      paidCents: row.paid_cents === null ? null : Number(row.paid_cents),
    });
  });

  // ------------------------------------------------------------------ payouts
  type PayoutRow = {
    id: string;
    school_id: string;
    batch_key: string;
    total_cents: number;
    status: 'accrued' | 'approved' | 'paid' | 'failed' | 'adjusted';
    external_transfer_ref: string | null;
    created_at: Date;
  };
  const payoutBody = (p: PayoutRow) => ({
    id: p.id,
    schoolId: p.school_id,
    batchKey: p.batch_key,
    totalCents: p.total_cents,
    status: p.status,
    externalTransferRef: p.external_transfer_ref,
    createdAt: p.created_at.toISOString(),
  });

  r.get('/payouts', async (c) => {
    const schoolId = uuidSchema.safeParse(c.req.query('schoolId'));
    if (!schoolId.success) throw new ApiError('VALIDATION_FAILED', 'schoolId is required');
    const rows = await c.var.deps.db.asService(
      (tx) => tx<PayoutRow[]>`
        select id, school_id, batch_key, total_cents, status, external_transfer_ref, created_at
          from public.donation_payout_batches where school_id = ${schoolId.data} order by created_at desc
      `,
    );
    return c.json({ payouts: rows.map(payoutBody) });
  });

  r.post('/payouts/prepare', async (c) => {
    const { deps } = c.var;
    const input = await readJson(c, preparePayoutRequestSchema);
    const batchKey = `payout:${input.schoolId}:${input.throughMonth}`;
    const result = await deps.db.asService(async (tx) => {
      const [school] = await tx<
        { recipient_verified: boolean }[]
      >`select recipient_verified from public.schools where id = ${input.schoolId} for update`;
      if (!school) throw new ApiError('NOT_FOUND', 'School not found');
      const [existing] = await tx<PayoutRow[]>`
        select id, school_id, batch_key, total_cents, status, external_transfer_ref, created_at
          from public.donation_payout_batches where batch_key = ${batchKey}
      `;
      if (existing) return { status: 'created' as const, payout: payoutBody(existing) };
      const accruals = await tx<{ id: string; donation_month: string; amount_cents: number }[]>`
        select id, donation_month, amount_cents from public.donation_accruals
         where school_id = ${input.schoolId} and payout_batch_id is null and donation_month <= ${input.throughMonth}
      `;
      const adjustments = await tx<
        { idempotency_key: string; accrual_id: string; amount_cents: number }[]
      >`
        select j.idempotency_key, j.accrual_id, j.amount_cents from public.donation_adjustments j
          join public.donation_accruals a on a.id = j.accrual_id
         where a.school_id = ${input.schoolId} and j.payout_batch_id is null
      `;
      const plan = buildPayoutBatch({
        schoolId: input.schoolId,
        batchKey,
        accruals: accruals.map((a) => ({
          id: a.id,
          schoolId: input.schoolId,
          donationMonth: a.donation_month,
          amountCents: a.amount_cents,
        })),
        adjustments: adjustments.map((j) => ({
          idempotencyKey: j.idempotency_key,
          accrualId: j.accrual_id,
          schoolId: input.schoolId,
          amountCents: j.amount_cents,
        })),
        recipientVerified: school.recipient_verified,
        transfersEnabled: deps.config.flags.payoutTransfersEnabled,
      });
      if (!plan.ok) {
        if (plan.error.code === 'TRANSFERS_DISABLED') {
          throw new ApiError(
            'BLOCKED_EXTERNAL',
            'School transfers are disabled until real recipient details are configured',
            { rule: 'TRANSFERS_DISABLED' },
          );
        }
        throw businessRule(plan.error.code, plan.error.message);
      }
      if (plan.value.status === 'carried_forward')
        return { status: 'carried_forward' as const, netCents: plan.value.totalCents };
      const [batch] = await tx<PayoutRow[]>`
        insert into public.donation_payout_batches (school_id, batch_key, total_cents)
        values (${input.schoolId}, ${batchKey}, ${plan.value.totalCents})
        returning id, school_id, batch_key, total_cents, status, external_transfer_ref, created_at
      `;
      await tx`update public.donation_accruals set payout_batch_id = ${batch!.id} where id = any(${accruals.map((a) => a.id)})`;
      await tx`update public.donation_adjustments set payout_batch_id = ${batch!.id} where idempotency_key = any(${adjustments.map((j) => j.idempotency_key)})`;
      await audit(tx, c, 'payout.prepared', 'payout_batch', batch!.id, {
        totalCents: plan.value.totalCents,
      });
      return { status: 'created' as const, payout: payoutBody(batch!) };
    });
    return c.json(result);
  });

  async function transition(
    c: Ctx,
    id: string,
    event: Parameters<typeof transitionPayout>[1],
    apply: (tx: Tx, next: string) => Promise<void>,
  ) {
    return c.var.deps.db.asService(async (tx) => {
      const [batch] = await tx<PayoutRow[]>`
        select id, school_id, batch_key, total_cents, status, external_transfer_ref, created_at
          from public.donation_payout_batches where id = ${id} for update
      `;
      if (!batch) throw new ApiError('NOT_FOUND', 'Payout not found');
      const next = transitionPayout(batch.status, event);
      if (!next.ok) throw businessRule(next.error.code, next.error.message);
      await apply(tx, next.value.status);
      await audit(tx, c, `payout.${event.type}`, 'payout_batch', id);
      const [updated] = await tx<PayoutRow[]>`
        select id, school_id, batch_key, total_cents, status, external_transfer_ref, created_at
          from public.donation_payout_batches where id = ${id}
      `;
      return payoutBody(updated!);
    });
  }

  r.post('/payouts/:id/approve', async (c) => {
    const id = idParam(c, 'id');
    const { deps } = c.var;
    const [school] = await deps.db.asService(
      (tx) => tx<{ recipient_verified: boolean; batch_key: string }[]>`
        select s.recipient_verified, b.batch_key from public.donation_payout_batches b join public.schools s on s.id = b.school_id where b.id = ${id}
      `,
    );
    if (!school) throw new ApiError('NOT_FOUND', 'Payout not found');
    const body = await transition(
      c,
      id,
      {
        type: 'approve',
        batchKey: school.batch_key,
        recipientVerified: school.recipient_verified,
        transfersEnabled: deps.config.flags.payoutTransfersEnabled,
      },
      async (tx, next) => {
        await tx`update public.donation_payout_batches set status = ${next}, approved_at = now() where id = ${id}`;
      },
    );
    return c.json(body);
  });

  r.post('/payouts/:id/mark-paid', async (c) => {
    const id = idParam(c, 'id');
    const { externalTransferRef } = await readJson(c, markPayoutPaidRequestSchema);
    if (!c.var.deps.config.flags.payoutTransfersEnabled) {
      throw new ApiError(
        'BLOCKED_EXTERNAL',
        'School transfers are disabled until real recipient details are configured',
        { rule: 'TRANSFERS_DISABLED' },
      );
    }
    const body = await transition(
      c,
      id,
      { type: 'mark_paid', transferReference: externalTransferRef },
      async (tx, next) => {
        await tx`
        update public.donation_payout_batches set status = ${next}, external_transfer_ref = ${externalTransferRef}, paid_at = now()
         where id = ${id}
      `;
      },
    );
    return c.json(body);
  });

  return r;
}
