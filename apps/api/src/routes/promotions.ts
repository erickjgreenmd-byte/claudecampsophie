import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  promoQuoteRequestSchema,
  promoRedeemRequestSchema,
  setSchoolRequestSchema,
  uuidSchema,
} from '@pencillift/contracts';
import { calendarMonthOf, DEFAULT_MAX_PAID_SLOTS } from '@pencillift/domain';
import { designationForMonth, planSchoolDesignation } from '@pencillift/domain/donations';
import {
  normalizePromoCode,
  transitionRedemption,
  validateRedemption,
  type RedemptionQuote,
  type RedemptionState,
} from '@pencillift/domain/promotions';
import { readJson } from '../app.ts';
import type { Tx } from '../db.ts';
import { ApiError, businessRule, isUniqueViolation } from '../errors.ts';
import { currentFamilyId, requireParent } from '../middleware/auth.ts';
import type { AppEnv } from '../middleware/context.ts';
import { enforceRateLimit, RATE_RULES } from '../middleware/rate-limit.ts';
import {
  loadDesignations,
  loadRedemptionContext,
  loadSubscriptionSnapshot,
  monthToDate,
  type RedemptionContext,
} from '../services/promotions-data.ts';

type Ctx = Context<AppEnv>;

const CODE_MESSAGES: Record<string, string> = {
  CODE_INVALID_FORMAT: 'That doesn’t look like a PencilLift code. Check for typos.',
  CODE_CHECKSUM_MISMATCH: 'That code has a typo. Check each character and try again.',
};

const RULE_MESSAGES: Record<string, string> = {
  CAMPAIGN_NOT_ACTIVE: 'This code isn’t active right now.',
  OUTSIDE_REDEMPTION_WINDOW: 'This month’s code can’t be used outside its redemption dates.',
  CODE_REVOKED: 'This code is no longer valid.',
  CODE_USAGE_CAP_REACHED: 'This code has reached its limit.',
  CAMPAIGN_REDEMPTION_CAP_REACHED: 'This promotion has reached its limit.',
  SCHOOL_AUDIENCE_MISMATCH: 'This code is for families supporting a different school.',
  TIER_NOT_ELIGIBLE: 'This code doesn’t apply to your plan size.',
  SUBSCRIBER_NOT_ELIGIBLE: 'This code isn’t available for your subscription status.',
  CHANNEL_UNAVAILABLE: 'This code isn’t available in this store yet.',
  CHANNEL_MISMATCH: 'Your subscription is managed by a different store; use that store to redeem.',
  FAMILY_ALREADY_REDEEMED_CAMPAIGN:
    'Your family already used this month’s code. Next month brings a new code.',
  PENDING_PROMOTION_EXISTS: 'You already have a discount waiting for an upcoming month.',
  SUBSCRIPTION_NOT_IN_GOOD_STANDING:
    'Please resolve your subscription’s billing before using a code.',
  NEXT_PERIOD_ALREADY_FINALIZED: 'Your next bill is already final. Try again after it renews.',
  TARGET_PERIOD_ALREADY_DISCOUNTED: 'That billing month already has a discount.',
  CAMPAIGN_BUDGET_EXHAUSTED: 'This promotion is fully used.',
};

function ruleError(code: string, fallback: string): ApiError {
  if (code === 'STEP_UP_REQUIRED')
    return new ApiError('STEP_UP_REQUIRED', 'Enter your parent PIN to continue');
  if (code === 'CHILD_MODE_FORBIDDEN')
    return new ApiError('CHILD_MODE_FORBIDDEN', 'Ask a grown-up');
  return businessRule(code, RULE_MESSAGES[code] ?? fallback);
}

async function recentUnlock(c: Ctx): Promise<boolean> {
  const [row] = await c.var.deps.db.asParent(
    c.var.parent,
    (tx) => tx<{ ok: boolean }[]>`select app.has_recent_adult_unlock() as ok`,
  );
  return row?.ok === true;
}

function toQuoteBody(quote: RedemptionQuote, campaignMonth: string) {
  return {
    campaignMonth,
    percentOff: quote.percentOff,
    channel: quote.channel,
    targetPeriod:
      quote.targetPeriod.kind === 'first_full_period'
        ? ({ kind: 'first_full_period' } as const)
        : ({
            kind: 'renewal_period',
            periodStart: quote.targetPeriod.periodStart.toISOString(),
            isProjection: true,
          } as const),
    regularCents: quote.regularCents,
    discountCents: quote.discountCents,
    chargedCents: quote.chargedCents,
    nextRegularRenewalCents: quote.nextRegularRenewalCents,
    isPreview: true as const,
  };
}

/**
 * Validates a code for the caller's family inside `tx` (service role; every read is family-scoped).
 * With `lock`, campaign and family rows are locked so caps and uniqueness are evaluated serially.
 */
async function evaluate(
  c: Ctx,
  tx: Tx,
  familyId: string,
  body: {
    code: string;
    channel: 'app_store' | 'play_store' | 'stripe';
    paidSlots?: number | undefined;
  },
  unlocked: boolean,
  lock: boolean,
): Promise<{ quote: RedemptionQuote; ctx: RedemptionContext }> {
  const { deps } = c.var;
  const now = deps.clock();
  const normalized = normalizePromoCode(body.code);
  if (!normalized.ok) {
    await enforceRateLimit(
      deps.rateLimiter,
      `promo-invalid:${familyId}`,
      RATE_RULES.promoInvalidCodePerFamily,
      now,
    );
    throw businessRule(
      normalized.error.code,
      CODE_MESSAGES[normalized.error.code] ?? 'That code isn’t valid.',
    );
  }
  const ctx = await loadRedemptionContext(tx, familyId, normalized.value, { lock });
  if (!ctx) {
    await enforceRateLimit(
      deps.rateLimiter,
      `promo-invalid:${familyId}`,
      RATE_RULES.promoInvalidCodePerFamily,
      now,
    );
    throw new ApiError('NOT_FOUND', 'That code isn’t valid. Check it and try again.');
  }
  if (body.channel === 'stripe' && !deps.config.flags.stripeWebBillingEnabled) {
    // Optional adult web billing is disabled until the owner decides launch policy (spec P11).
    throw businessRule('CHANNEL_UNAVAILABLE', RULE_MESSAGES.CHANNEL_UNAVAILABLE!);
  }
  const subscription = await loadSubscriptionSnapshot(tx, familyId);
  const designations = await loadDesignations(tx, familyId);
  const familySchoolId = designationForMonth(
    designations,
    calendarMonthOf(now, deps.config.programTimezone),
  );
  // Decision: a family without verified paid capacity quotes the tier it is about to buy; the
  // default is its current number of child profiles (clamped to the approved tiers).
  const paidSlots =
    ctx.paidSlots > 0
      ? ctx.paidSlots
      : Math.min(DEFAULT_MAX_PAID_SLOTS, Math.max(1, body.paidSlots ?? ctx.childProfiles));
  const result = validateRedemption({
    principal: 'parent',
    recentAdultUnlock: unlocked,
    now,
    familyId,
    code: ctx.code,
    campaign: ctx.campaign,
    familySchoolId,
    familyPaidSlots: paidSlots,
    channel: body.channel,
    channelMappings: ctx.mappings,
    subscription,
    familyRedemptions: ctx.familyRedemptions,
  });
  if (!result.ok) throw ruleError(result.error.code, result.error.message);
  return { quote: result.value, ctx };
}

interface RedemptionRow {
  id: string;
  campaign_month: string;
  channel: 'app_store' | 'play_store' | 'stripe';
  state: RedemptionState;
  percent_off: number;
  regular_cents: number;
  discount_cents: number;
  charged_cents: number;
  target_period_start: Date | null;
  created_at: Date;
  paid_slots: number;
  campaign_id: string;
}

function toRedemptionBody(row: RedemptionRow, offerIds?: ReadonlyMap<string, string>) {
  const offerId = offerIds?.get(`${row.channel}:${row.paid_slots}`);
  const nextAction =
    row.state === 'reserved' && row.channel !== 'stripe' && offerId !== undefined
      ? ({ kind: 'present_store_offer', providerOfferId: offerId } as const)
      : row.state === 'reserved' || row.state === 'provider_pending'
        ? ({ kind: 'await_provider' } as const)
        : ({ kind: 'none' } as const);
  return {
    id: row.id,
    campaignMonth: row.campaign_month,
    channel: row.channel,
    state: row.state,
    percentOff: row.percent_off,
    regularCents: row.regular_cents,
    discountCents: row.discount_cents,
    chargedCents: row.charged_cents,
    targetPeriodStart: row.target_period_start?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    nextAction,
  };
}

const REDEMPTION_COLUMNS = `r.id, c.campaign_month, r.channel, r.state, r.percent_off, r.regular_cents, r.discount_cents,
  r.charged_cents, r.target_period_start, r.created_at, r.paid_slots, r.campaign_id`;

async function schoolSummaries(tx: Tx, ids: readonly string[]) {
  if (ids.length === 0)
    return new Map<
      string,
      { id: string; name: string; city: string | null; region: string | null }
    >();
  const rows = await tx<{ id: string; name: string; city: string | null; region: string | null }[]>`
    select id, name, city, region from public.schools where id = any(${[...ids]})
  `;
  return new Map(rows.map((r) => [r.id, r]));
}

async function familySchoolBody(c: Ctx, tx: Tx, familyId: string) {
  const zone = c.var.deps.config.programTimezone;
  const month = calendarMonthOf(c.var.deps.clock(), zone);
  const designations = await loadDesignations(tx, familyId);
  const currentId = designationForMonth(designations, month);
  const pending = designations
    .filter((d) => d.effectiveFromMonth > month)
    .sort((a, b) => (a.effectiveFromMonth < b.effectiveFromMonth ? -1 : 1))[0];
  const schools = await schoolSummaries(
    tx,
    [currentId, pending?.schoolId].filter((x): x is string => typeof x === 'string'),
  );
  return {
    current: currentId ? (schools.get(currentId) ?? null) : null,
    pending:
      pending && schools.get(pending.schoolId)
        ? { school: schools.get(pending.schoolId)!, effectiveFromMonth: pending.effectiveFromMonth }
        : null,
    programTimezone: zone,
    contributionIsPencilLiftFunded: true as const,
  };
}

const schoolQuerySchema = z.string().trim().max(80);

/** P17 parent routes: school selection and monthly promo codes. */
export function promotionsRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('/schools', requireParent);
  r.use('/family/school', requireParent);
  r.use('/family/promotions', requireParent);
  r.use('/family/promotions/*', requireParent);

  r.get('/schools', async (c) => {
    const query = schoolQuerySchema.safeParse(c.req.query('query') ?? '');
    if (!query.success) throw new ApiError('VALIDATION_FAILED', 'Search is too long');
    const pattern = `%${query.data.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const rows = await c.var.deps.db.asParent(
      c.var.parent,
      (tx) => tx<{ id: string; name: string; city: string | null; region: string | null }[]>`
        select id, name, city, region from public.schools
         where status = 'active' and name ilike ${pattern}
         order by name limit 50
      `,
    );
    return c.json({ schools: rows });
  });

  r.get('/family/school', async (c) => {
    const familyId = await currentFamilyId(c);
    return c.json(await c.var.deps.db.asService((tx) => familySchoolBody(c, tx, familyId)));
  });

  r.put('/family/school', async (c) => {
    const { deps, parent } = c.var;
    const familyId = await currentFamilyId(c);
    const { schoolId } = await readJson(c, setSchoolRequestSchema);
    const body = await deps.db.asService(async (tx) => {
      const [school] = await tx<
        { status: string }[]
      >`select status from public.schools where id = ${schoolId}`;
      if (school?.status !== 'active') throw new ApiError('NOT_FOUND', 'School not found');
      await tx`select 1 from public.families where id = ${familyId} for update`;
      const existing = await loadDesignations(tx, familyId);
      const plan = planSchoolDesignation({
        designations: existing,
        newSchoolId: schoolId,
        now: deps.clock(),
        programZone: deps.config.programTimezone,
      });
      if (!plan.ok) throw businessRule(plan.error.code, 'That school can’t be selected');
      if (plan.value.changed) {
        // Replace the stored history with the planned one. Rows that already took effect keep their
        // start month (only their end can move), so past months and accruals are preserved; the
        // exclusion constraint rejects any overlap.
        const key = (d: { schoolId: string; effectiveFromMonth: string }) =>
          `${d.schoolId}|${d.effectiveFromMonth}`;
        const planned = new Map(plan.value.designations.map((d) => [key(d), d]));
        // Order matters (BUG-005): remove dropped rows first, then move end months, then insert, so
        // no intermediate state overlaps and trips the exclusion constraint.
        const removed = existing.filter((old) => !planned.has(key(old)));
        const kept = existing.filter((old) => planned.has(key(old)));
        for (const old of removed) {
          const deleted = await tx`
            delete from public.family_school_designations
             where family_id = ${familyId} and school_id = ${old.schoolId}
               and effective_from = ${monthToDate(old.effectiveFromMonth)}::date
               and effective_from > date_trunc('month', ${deps.clock()}::timestamptz at time zone ${deps.config.programTimezone})::date
          `;
          // Only not-yet-effective designations may be dropped; history is never rewritten.
          if (deleted.count !== 1) throw new ApiError('INTERNAL', 'Designation history conflict');
        }
        for (const old of kept) {
          const next = planned.get(key(old))!;
          if (next.effectiveToMonth !== old.effectiveToMonth) {
            await tx`
              update public.family_school_designations
                 set effective_to = ${next.effectiveToMonth === null ? null : monthToDate(next.effectiveToMonth)}::date
               where family_id = ${familyId} and school_id = ${old.schoolId}
                 and effective_from = ${monthToDate(old.effectiveFromMonth)}::date
            `;
          }
          planned.delete(key(old));
        }
        for (const d of planned.values()) {
          await tx`
            insert into public.family_school_designations (family_id, school_id, effective_from, effective_to, created_by)
            values (${familyId}, ${d.schoolId}, ${monthToDate(d.effectiveFromMonth)}::date,
                    ${d.effectiveToMonth === null ? null : monthToDate(d.effectiveToMonth)}::date, ${parent.userId})
          `;
        }
        // Signup attribution (independent of discounts): record the first school a family chooses.
        await tx`
          insert into public.family_school_attributions (family_id, school_id, source)
          select ${familyId}, ${schoolId}, 'manual'
           where not exists (select 1 from public.family_school_attributions where family_id = ${familyId} and superseded_at is null)
        `;
        await tx`
          insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
          values (${familyId}, ${parent.userId}, 'parent', 'school.designated', 'school', ${schoolId},
                  ${JSON.stringify({ effectiveFromMonth: plan.value.effectiveFromMonth })}::text::jsonb)
        `;
      }
      return familySchoolBody(c, tx, familyId);
    });
    return c.json(body);
  });

  r.post('/family/promotions/quote', async (c) => {
    const { deps, parent } = c.var;
    const familyId = await currentFamilyId(c);
    await enforceRateLimit(
      deps.rateLimiter,
      `promo-quote:${parent.userId}`,
      RATE_RULES.promoQuotePerUser,
      deps.clock(),
    );
    const body = await readJson(c, promoQuoteRequestSchema);
    const unlocked = await recentUnlock(c);
    const { quote, ctx } = await deps.db.asService((tx) =>
      evaluate(c, tx, familyId, body, unlocked, false),
    );
    return c.json(toQuoteBody(quote, ctx.campaign.campaignMonth));
  });

  r.post('/family/promotions/redeem', async (c) => {
    const { deps, parent } = c.var;
    const familyId = await currentFamilyId(c);
    await enforceRateLimit(
      deps.rateLimiter,
      `promo-redeem:${familyId}`,
      RATE_RULES.promoRedeemPerFamily,
      deps.clock(),
    );
    const body = await readJson(c, promoRedeemRequestSchema);
    const unlocked = await recentUnlock(c);
    try {
      const result = await deps.db.asService(async (tx) => {
        // Idempotent replay: the same key from the same family returns the original redemption.
        const [replay] = await tx<(RedemptionRow & { family_id: string })[]>`
          select ${tx.unsafe(REDEMPTION_COLUMNS)}, r.family_id
            from public.promo_redemptions r join public.promo_campaigns c on c.id = r.campaign_id
           where r.idempotency_key = ${body.idempotencyKey}
        `;
        if (replay) {
          if (replay.family_id !== familyId)
            throw new ApiError('CONFLICT', 'Use a new request key');
          return { row: replay, offerIds: undefined };
        }
        const { quote, ctx } = await evaluate(c, tx, familyId, body, unlocked, true);
        const initial: RedemptionState = 'reserved';
        const next =
          body.channel === 'stripe' ? transitionRedemption(initial, 'submit_to_provider') : null;
        if (next && !next.ok) throw new ApiError('INTERNAL', 'Invalid redemption state');
        const state = next?.ok ? next.value : initial;
        const [row] = await tx<RedemptionRow[]>`
          with inserted as (
            insert into public.promo_redemptions
              (family_id, campaign_id, code_id, channel, target_period_key, target_period_start, state, idempotency_key,
               paid_slots, percent_off, regular_cents, discount_cents, charged_cents, redeemed_by)
            values (${familyId}, ${quote.campaignId}, ${quote.codeId}, ${quote.channel}, ${quote.targetPeriodKey},
                    ${quote.targetPeriod.kind === 'renewal_period' ? quote.targetPeriod.periodStart : null}, 'reserved',
                    ${body.idempotencyKey}, ${quote.paidSlots}, ${quote.percentOff}, ${quote.regularCents},
                    ${quote.discountCents}, ${quote.chargedCents}, ${parent.userId})
            returning *
          )
          select i.id, ${ctx.campaign.campaignMonth}::text as campaign_month, i.channel, i.state, i.percent_off,
                 i.regular_cents, i.discount_cents, i.charged_cents, i.target_period_start, i.created_at, i.paid_slots,
                 i.campaign_id
            from inserted i
        `;
        if (state !== 'reserved') {
          await tx`update public.promo_redemptions set state = ${state} where id = ${row!.id}`;
          row!.state = state;
        }
        await tx`
          insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
          values (${familyId}, ${parent.userId}, 'parent', 'promo.redeemed', 'promo_redemption', ${row!.id},
                  ${JSON.stringify({ channel: quote.channel, percentOff: quote.percentOff })}::text::jsonb)
        `;
        return { row: row!, offerIds: ctx.offerIds };
      });
      return c.json(toRedemptionBody(result.row, result.offerIds), 201);
    } catch (error) {
      // Concurrent requests that pass validation together are stopped by the partial unique indexes.
      if (isUniqueViolation(error, 'promo_redemptions_once_per_campaign')) {
        throw ruleError('FAMILY_ALREADY_REDEEMED_CAMPAIGN', '');
      }
      if (isUniqueViolation(error, 'promo_redemptions_one_per_period'))
        throw ruleError('TARGET_PERIOD_ALREADY_DISCOUNTED', '');
      if (isUniqueViolation(error, 'promo_redemptions_one_in_flight'))
        throw ruleError('PENDING_PROMOTION_EXISTS', '');
      if (isUniqueViolation(error, 'promo_redemptions_idempotency_key_key')) {
        throw new ApiError('CONFLICT', 'This request is already being processed');
      }
      throw error;
    }
  });

  // The app reports that the store offer sheet was presented/purchase started (native channels).
  r.post('/family/promotions/:id/submitted', async (c) => {
    const { deps, parent } = c.var;
    const id = uuidSchema.safeParse(c.req.param('id'));
    if (!id.success) throw new ApiError('NOT_FOUND', 'Not found');
    const familyId = await currentFamilyId(c);
    const row = await deps.db.asService(async (tx) => {
      const [current] = await tx<RedemptionRow[]>`
        select ${tx.unsafe(REDEMPTION_COLUMNS)}
          from public.promo_redemptions r join public.promo_campaigns c on c.id = r.campaign_id
         where r.id = ${id.data} and r.family_id = ${familyId}
         for update of r
      `;
      if (!current) throw new ApiError('NOT_FOUND', 'Not found');
      if (current.state === 'provider_pending') return current;
      const next = transitionRedemption(current.state, 'submit_to_provider');
      if (!next.ok || current.channel === 'stripe') {
        throw businessRule('INVALID_TRANSITION', 'This promotion can’t be submitted again');
      }
      await tx`update public.promo_redemptions set state = ${next.value} where id = ${current.id}`;
      await tx`
        insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id)
        values (${familyId}, ${parent.userId}, 'parent', 'promo.submitted', 'promo_redemption', ${current.id})
      `;
      return { ...current, state: next.value };
    });
    return c.json(toRedemptionBody(row));
  });

  r.get('/family/promotions', async (c) => {
    const familyId = await currentFamilyId(c);
    const rows = await c.var.deps.db.asService(
      (tx) => tx<RedemptionRow[]>`
        select ${tx.unsafe(REDEMPTION_COLUMNS)}
          from public.promo_redemptions r join public.promo_campaigns c on c.id = r.campaign_id
         where r.family_id = ${familyId}
         order by r.created_at desc limit 100
      `,
    );
    return c.json({ redemptions: rows.map((row) => toRedemptionBody(row)) });
  });

  return r;
}
