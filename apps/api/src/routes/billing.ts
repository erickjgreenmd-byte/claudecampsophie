import { Hono, type Context } from 'hono';
import {
  capacityChangeRequestSchema,
  type BillingPriceCheck,
  type BillingStatus,
  type CapacityChangeResponse,
} from '@pencillift/contracts';
import {
  DEFAULT_MAX_PAID_SLOTS,
  formatUsd,
  monthlyPriceCents,
  priceTable,
} from '@pencillift/domain';
import { planDowngrade } from '@pencillift/domain/entitlements';
import { readJson } from '../app.ts';
import type { Tx } from '../db.ts';
import { ApiError, businessRule } from '../errors.ts';
import { assertRecentUnlock, currentFamilyId, requireParent } from '../middleware/auth.ts';
import type { AppEnv } from '../middleware/context.ts';
import { enforceRateLimit, type RateRule } from '../middleware/rate-limit.ts';
import {
  reconcileFamilyBilling,
  releaseSlotlessProfiles,
  reverifyFormerHolders,
  SubscriptionBoundElsewhere,
  type FamilyBillingResult,
} from '../services/billing-sync.ts';

type Ctx = Context<AppEnv>;
type Channel = 'app_store' | 'play_store' | 'stripe';
type BillingEnvironment = 'sandbox' | 'production';

/**
 * Parent billing (spec P11, P14 "subscription" + "paid-slot management"; AC_BILLING_*,
 * AC_CAPACITY_*). Paid capacity changes ONLY through verified provider state:
 * - GET  /v1/billing/status            what the family actually pays for, and what it could buy;
 * - POST /v1/billing/sync              server-side fetch of the provider's current state (the same
 *                                      reconciliation as the webhook path); a client claim is ignored;
 * - POST /v1/billing/capacity-changes  records the parent's intent (step-up). It never grants or
 *                                      removes a slot; the store purchase/change does, once verified.
 */

/** Named limits, reviewed here (kept beside the routes they protect). */
export const BILLING_RATE_RULES = {
  syncPerFamily: { limit: 12, windowSeconds: 3600 },
  capacityChangePerFamily: { limit: 20, windowSeconds: 3600 },
} as const satisfies Record<string, RateRule>;

/** Labeled subscriber-state mocks may answer only in development and test (never staging/production). */
const MOCK_PROVIDER_ENVIRONMENTS = new Set(['development', 'test']);

const DOWNGRADE_MESSAGES: Record<string, string> = {
  NOT_A_DOWNGRADE: 'Choose a plan with fewer children than your current plan.',
  KEEP_NOT_ACTIVE: 'Only children who are active now can stay active on the smaller plan.',
  TOO_MANY_KEPT: 'The smaller plan can’t keep that many children active.',
  INVALID_TARGET_SLOTS: 'Choose a plan for 1 to 4 children.',
};

const STORE_NAME: Record<Channel, string> = {
  app_store: 'The App Store',
  play_store: 'Google Play',
  stripe: 'Web billing',
};

function childrenLabel(count: number): string {
  return count === 1 ? '1 child' : `${count} children`;
}

function recurringCents(paidSlots: number): number {
  return paidSlots <= 0
    ? 0
    : monthlyPriceCents(paidSlots, Math.max(DEFAULT_MAX_PAID_SLOTS, paidSlots));
}

/** Owner-approved monthly price for a tier (3999 + 999 × (slots − 1)), or null outside the tiers. */
function approvedCents(paidSlots: number): number | null {
  return priceTable().find((t) => t.paidSlots === paidSlots)?.cents ?? null;
}

/**
 * RV-billing-4 (AC_CAPACITY_02, docs/Owner_Actions.md #1): the server's own comparison of a verified
 * store price with the approved price. A product that differs is reported as such and never sold.
 */
export function priceCheckFor(
  paidSlots: number,
  storePriceCents: number | null,
): BillingPriceCheck {
  if (storePriceCents === null) return 'not_verified';
  return approvedCents(paidSlots) === storePriceCents
    ? 'matches_approved'
    : 'differs_from_approved';
}

/** The family's billing picture, read with the parent's own role so RLS is a second layer. */
async function loadStatus(
  tx: Tx,
  familyId: string,
  environment: BillingEnvironment,
): Promise<BillingStatus> {
  const [family] = await tx<{ billing_ref: string }[]>`
    select billing_ref from public.families where id = ${familyId} and deleted_at is null
  `;
  if (!family) throw new ApiError('NOT_FOUND', 'Create your family first');
  const [capacity] = await tx<
    {
      paid_slots: number;
      managing_channel: Channel | null;
      conflict: 'duplicate_active_subscriptions' | null;
      pending_target_slots: number | null;
      pending_effective_at: Date | null;
    }[]
  >`
    select paid_slots, managing_channel, conflict, pending_target_slots, pending_effective_at
      from public.family_capacity where family_id = ${familyId}
  `;
  const [assigned] = await tx<{ n: number }[]>`
    select count(*)::int as n from public.child_slot_assignments
     where family_id = ${familyId} and released_at is null
  `;
  const [requested] = await tx<
    {
      kind: 'upgrade' | 'downgrade';
      to_slots: number;
      status: 'pending_purchase' | 'scheduled';
      keep_count: number;
      created_at: Date;
    }[]
  >`
    select kind, to_slots, status, cardinality(keep_child_ids)::int as keep_count, created_at
      from public.capacity_changes
     where family_id = ${familyId} and status in ('pending_purchase', 'scheduled')
     order by created_at desc limit 1
  `;
  const entitlements = await tx<
    {
      channel: Channel;
      product_id: string;
      paid_slots: number;
      status: BillingStatus['entitlements'][number]['status'];
      period_end: Date | null;
      auto_renew: boolean;
    }[]
  >`
    select channel, product_id, paid_slots, status, period_end, auto_renew
      from public.family_entitlements
     where family_id = ${familyId} and environment = ${environment}
     order by period_end desc nulls last, created_at desc
     limit 20
  `;
  const products = await tx<
    { channel: Channel; product_id: string; paid_slots: number; store_price_cents: number | null }[]
  >`
    select distinct channel, product_id, paid_slots, store_price_cents
      from public.store_product_mappings
     where environment = ${environment} and active
     order by channel, paid_slots, product_id
  `;
  return {
    billingRef: family.billing_ref,
    paidSlots: capacity?.paid_slots ?? 0,
    assignedSlots: assigned?.n ?? 0,
    managingChannel: capacity?.managing_channel ?? null,
    conflict: capacity?.conflict ?? null,
    pendingChange:
      capacity?.pending_target_slots !== null &&
      capacity?.pending_target_slots !== undefined &&
      capacity.pending_effective_at
        ? {
            targetSlots: capacity.pending_target_slots,
            effectiveAt: capacity.pending_effective_at.toISOString(),
          }
        : null,
    requestedChange: requested
      ? {
          kind: requested.kind,
          toSlots: requested.to_slots,
          status: requested.status,
          keepCount: requested.keep_count,
          createdAt: requested.created_at.toISOString(),
        }
      : null,
    entitlements: entitlements.map((e) => ({
      channel: e.channel,
      productId: e.product_id,
      paidSlots: e.paid_slots,
      status: e.status,
      periodEnd: e.period_end?.toISOString() ?? null,
      autoRenew: e.auto_renew,
    })),
    products: products.map((p) => ({
      channel: p.channel,
      productId: p.product_id,
      paidSlots: p.paid_slots,
      storePriceCents: p.store_price_cents,
      priceCheck: priceCheckFor(p.paid_slots, p.store_price_cents),
    })),
    tiers: priceTable().map((t) => ({ paidSlots: t.paidSlots, approvedMonthlyCents: t.cents })),
  };
}

function statusFor(c: Ctx, familyId: string): Promise<BillingStatus> {
  const { deps, parent } = c.var;
  return deps.db.asParent(parent, (tx) => loadStatus(tx, familyId, deps.config.billingEnvironment));
}

export function billingRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('/billing/*', requireParent);

  r.get('/billing/status', async (c) => {
    const familyId = await currentFamilyId(c);
    return c.json(await statusFor(c, familyId));
  });

  r.post('/billing/sync', async (c) => {
    const { deps } = c.var;
    const familyId = await currentFamilyId(c);
    const now = deps.clock();
    await enforceRateLimit(
      deps.rateLimiter,
      `billing-sync:${familyId}`,
      BILLING_RATE_RULES.syncPerFamily,
      now,
    );
    const provider = deps.providers.subscriptions;
    if (provider.isMock && !MOCK_PROVIDER_ENVIRONMENTS.has(deps.config.environment)) {
      throw new ApiError(
        'NOT_CONFIGURED',
        'Store billing isn’t connected yet, so your plan can’t be checked right now.',
      );
    }
    // The request body is deliberately ignored: only the provider's own state can change capacity.
    const [family] = await deps.db.asService(
      (tx) => tx<{ billing_ref: string }[]>`
        select billing_ref from public.families where id = ${familyId} and deleted_at is null
      `,
    );
    if (!family) throw new ApiError('NOT_FOUND', 'Create your family first');
    let snapshots;
    try {
      snapshots = await provider.fetchSubscriptions(family.billing_ref, now);
    } catch {
      deps.log({
        level: 'warn',
        event: 'billing_sync_provider_failed',
        requestId: c.var.requestId,
      });
      throw new ApiError(
        'PROVIDER_UNAVAILABLE',
        'We couldn’t reach the store just now. Your plan is unchanged; please try again shortly.',
      );
    }
    let result: FamilyBillingResult;
    try {
      result = await deps.db.asService(async (tx) => {
        // Same serialization as the webhook path (routes/webhooks.ts). A family tombstoned while
        // the provider was being asked is never rebuilt (spec E4 Deletion).
        const [live] = await tx<{ deleted_at: Date | null }[]>`
          select deleted_at from public.families where id = ${familyId} for update
        `;
        if (!live || live.deleted_at) throw new ApiError('NOT_FOUND', 'Create your family first');
        return reconcileFamilyBilling(tx, familyId, snapshots, deps.config.billingEnvironment, now);
      });
    } catch (error) {
      if (error instanceof SubscriptionBoundElsewhere) {
        throw businessRule(
          'SUBSCRIPTION_BOUND_ELSEWHERE',
          'This store subscription is linked to a different PencilLift family. Contact support to move it.',
        );
      }
      throw error;
    }
    await reverifyFormerHolders(deps, familyId, result.newClaims, now, c.var.requestId);
    return c.json(await statusFor(c, familyId));
  });

  r.post('/billing/capacity-changes', async (c) => {
    const { deps, parent } = c.var;
    const familyId = await currentFamilyId(c);
    // Only a recently reauthenticated parent may authorize a capacity change (spec P3, P11).
    await assertRecentUnlock(c);
    const now = deps.clock();
    await enforceRateLimit(
      deps.rateLimiter,
      `billing-capacity:${familyId}`,
      BILLING_RATE_RULES.capacityChangePerFamily,
      now,
    );
    const body = await readJson(c, capacityChangeRequestSchema);
    const environment = deps.config.billingEnvironment;
    const result = await deps.db.asService(async (tx): Promise<CapacityChangeResponse> => {
      const [locked] = await tx<{ id: string }[]>`
        select id from public.families where id = ${familyId} and deleted_at is null for update
      `;
      if (!locked) throw new ApiError('NOT_FOUND', 'Create your family first');
      // Slots the store already took away (e.g. by a webhook) no longer count as active (RV-billing-2).
      await releaseSlotlessProfiles(tx, familyId);
      const [capacity] = await tx<{ paid_slots: number; managing_channel: Channel | null }[]>`
        select paid_slots, managing_channel from public.family_capacity where family_id = ${familyId}
      `;
      const paidSlots = capacity?.paid_slots ?? 0;
      let keep: string[] = [];
      let status: 'pending_purchase' | 'scheduled';
      if (body.kind === 'upgrade') {
        if (body.toSlots <= paidSlots) {
          throw businessRule(
            'NOT_AN_UPGRADE',
            `Your plan already covers ${paidSlots} ${paidSlots === 1 ? 'child' : 'children'}. Choose a larger plan to add a child slot.`,
          );
        }
        status = 'pending_purchase';
      } else {
        // Service role bypasses RLS, so every child id is checked against this family explicitly.
        const children = await tx<{ id: string; status: string }[]>`
          select id, status from public.child_profiles where family_id = ${familyId}
        `;
        const own = new Set(children.map((ch) => ch.id));
        if (body.keepChildIds?.some((id) => !own.has(id))) {
          throw new ApiError('NOT_FOUND', 'Child not found');
        }
        const active = children.filter((ch) => ch.status === 'active').map((ch) => ch.id);
        const chosen = (body.keepChildIds?.length ?? 0) > 0;
        // The parent must choose who stays active whenever the smaller plan can't keep everyone;
        // an omitted or empty list never lets the server pick for them.
        if (!chosen && active.length > body.toSlots) {
          throw businessRule(
            'KEEP_SELECTION_REQUIRED',
            'Choose which children stay active on the smaller plan.',
          );
        }
        // Informational only: the store confirms the real effective date (usually the next renewal).
        const [managing] = await tx<{ period_end: Date | null }[]>`
          select period_end from public.family_entitlements
           where family_id = ${familyId} and environment = ${environment}
             and channel = ${capacity?.managing_channel ?? ''}
           order by period_end desc nulls last limit 1
        `;
        const plan = planDowngrade({
          currentSlots: paidSlots,
          targetSlots: body.toSlots,
          activeChildIds: active,
          // Without a selection every active child fits the smaller plan and stays active.
          keepChildIds: chosen ? body.keepChildIds! : active,
          providerEffectiveAt: managing?.period_end ?? now,
          principal: 'parent',
          recentAdultUnlock: true,
        });
        if (!plan.ok) {
          throw businessRule(
            plan.error.code,
            DOWNGRADE_MESSAGES[plan.error.code] ?? plan.error.message,
          );
        }
        // RV-billing-3: a partial selection would leave the server to decide which unchosen child
        // keeps a paid slot when the store applies the change. The parent fills every slot of the
        // smaller plan (or archives a child to stop its paid features).
        const required = Math.min(active.length, body.toSlots);
        if (plan.value.keepChildIds.length < required) {
          throw businessRule(
            'KEEP_SELECTION_INCOMPLETE',
            `Choose ${childrenLabel(required)} to keep active on the smaller plan. To stop a child’s paid learning features, archive them in Children instead.`,
          );
        }
        keep = [...plan.value.keepChildIds];
        status = 'scheduled';
      }
      const approved = approvedCents(body.toSlots);
      if (body.channel !== undefined && approved !== null) {
        // RV-billing-4 (AC_CAPACITY_02): a tier whose verified store price is not the approved
        // price is never sold (docs/Owner_Actions.md #1). Refused before the store ever opens.
        const [differing] = await tx<{ store_price_cents: number }[]>`
          select store_price_cents from public.store_product_mappings
           where channel = ${body.channel} and paid_slots = ${body.toSlots}
             and environment = ${environment} and active
             and store_price_cents is not null and store_price_cents <> ${approved}
           order by store_price_cents limit 1
        `;
        if (differing) {
          throw businessRule(
            'STORE_PRICE_NOT_APPROVED',
            `${STORE_NAME[body.channel]} charges ${formatUsd(differing.store_price_cents)} per month for ${childrenLabel(body.toSlots)}, which isn’t PencilLift’s approved price of ${formatUsd(approved)}. This plan can’t be bought there until the store price matches.`,
          );
        }
      }
      // At most one open request per family: a new choice supersedes the previous one.
      await tx`
        update public.capacity_changes set status = 'cancelled'
         where family_id = ${familyId} and status in ('pending_purchase', 'scheduled')
      `;
      const [row] = await tx<{ id: string; created_at: Date }[]>`
        insert into public.capacity_changes (family_id, requested_by, kind, from_slots, to_slots, keep_child_ids, status)
        values (${familyId}, ${parent.userId}, ${body.kind}, ${paidSlots}, ${body.toSlots}, ${keep}::uuid[], ${status})
        returning id, created_at
      `;
      await tx`
        insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
        values (${familyId}, ${parent.userId}, 'parent', 'billing.capacity_change_requested', 'capacity_change', ${row!.id},
                ${JSON.stringify({ kind: body.kind, fromSlots: paidSlots, toSlots: body.toSlots })}::text::jsonb)
      `;
      return {
        id: row!.id,
        kind: body.kind,
        fromSlots: paidSlots,
        toSlots: body.toSlots,
        keepChildIds: keep,
        status,
        currentRecurringCents: recurringCents(paidSlots),
        newRecurringCents: recurringCents(body.toSlots),
        nextStep: body.kind === 'upgrade' ? 'purchase_in_store' : 'change_in_store',
        createdAt: row!.created_at.toISOString(),
      };
    });
    return c.json(result, 201);
  });

  return r;
}
