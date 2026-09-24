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
import {
  planDowngrade,
  type EntitlementStatus,
  type FamilyCapacity,
  type ProviderSubscriptionSnapshot,
} from '@pencillift/domain/entitlements';
import { readJson } from '../app.ts';
import type { Tx } from '../db.ts';
import { ApiError, businessRule } from '../errors.ts';
import { assertRecentUnlock, currentFamilyId, requireParent } from '../middleware/auth.ts';
import type { AppDeps, AppEnv } from '../middleware/context.ts';
import { enforceRateLimit, type RateRule } from '../middleware/rate-limit.ts';
import { applySnapshots, resolveUnreachableRedemptions } from '../services/billing-sync.ts';

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

/** Provider states after which a subscription can never grant again without a new observation. */
const TERMINAL_STATUSES: ReadonlySet<EntitlementStatus> = new Set([
  'expired',
  'revoked',
  'refunded',
]);

/** How many other families one new claim may trigger a re-verification for (RV-billing-1). */
const MAX_FORMER_HOLDERS = 3;

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

/**
 * Marks the parent's open requests as applied once verified capacity reflects them. This only
 * updates the request record; paid capacity itself was already computed from provider state.
 */
export async function settleCapacityChanges(
  tx: Tx,
  familyId: string,
  paidSlots: number,
): Promise<void> {
  await tx`
    update public.capacity_changes set status = 'applied'
     where family_id = ${familyId}
       and ((kind = 'upgrade' and status = 'pending_purchase' and to_slots <= ${paidSlots})
         or (kind = 'downgrade' and status = 'scheduled' and ${paidSlots} > 0 and ${paidSlots} <= to_slots))
  `;
}

/**
 * RV-billing-2: `active` means "holds a paid slot" (child_profiles, migration 0001). When verified
 * provider state (expiry, revocation, a store-confirmed downgrade) released a child's slot, the
 * profile goes back to `draft`: paid AI and practice stop for it (spec P11 "stop paid AI for
 * inactive profiles"), its history, exports and rewards are kept, and the parent can later assign an
 * unused paid slot to it again without a new purchase (AC_CAPACITY_03). Profiles that never held a
 * slot and slots the parent released by archiving are left alone. Idempotent; call it inside the
 * transaction that holds the family row lock.
 */
export async function releaseSlotlessProfiles(tx: Tx, familyId: string): Promise<string[]> {
  const released = await tx<{ id: string }[]>`
    update public.child_profiles c set status = 'draft'
     where c.family_id = ${familyId} and c.status = 'active'
       and not exists (select 1 from public.child_slot_assignments s
                        where s.family_id = c.family_id and s.child_id = c.id and s.released_at is null)
       and (select s.release_reason from public.child_slot_assignments s
             where s.family_id = c.family_id and s.child_id = c.id
             order by s.released_at desc limit 1) in ('expired', 'downgrade')
    returning c.id
  `;
  for (const child of released) {
    await tx`
      insert into public.audit_events (family_id, actor_kind, action, target_type, target_id)
      values (${familyId}, 'system', 'child.paid_slot_released', 'child', ${child.id})
    `;
  }
  return released.map((child) => child.id);
}

interface LedgerRow {
  channel: Channel;
  provider_subscription_id: string;
  product_id: string;
  status: EntitlementStatus;
  environment: BillingEnvironment;
  period_start: Date;
  period_end: Date;
  provider_updated_at: Date;
}

function ledgerKey(channel: string, providerSubscriptionId: string): string {
  return JSON.stringify([channel, providerSubscriptionId]);
}

/**
 * RV-billing-1: a COMPLETE provider fetch that no longer lists one of the family's subscriptions
 * means the provider moved it to another subscriber (a RevenueCat restore/transfer) or removed it.
 * It must stop granting here, or one store purchase would give two families paid capacity. The row
 * is re-observed as `revoked` with the provider's own last-modified instant unchanged and a new
 * observation time: this observation wins over the stored one, and a later fetch that lists the
 * subscription again (moved back) is newer still and restores it. History is kept.
 */
function vanishedSnapshots(
  before: readonly LedgerRow[],
  fetched: readonly ProviderSubscriptionSnapshot[],
  environment: BillingEnvironment,
  now: Date,
): ProviderSubscriptionSnapshot[] {
  const listed = new Set(fetched.map((s) => ledgerKey(s.channel, s.providerSubscriptionId)));
  return before
    .filter(
      (r) =>
        r.environment === environment &&
        !TERMINAL_STATUSES.has(r.status) &&
        !listed.has(ledgerKey(r.channel, r.provider_subscription_id)),
    )
    .map((r) => ({
      channel: r.channel,
      providerSubscriptionId: r.provider_subscription_id,
      productId: r.product_id,
      status: 'revoked' as const,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      autoRenew: false,
      environment: r.environment,
      providerUpdatedAt: r.provider_updated_at,
      fetchedAt: now,
    }));
}

/** A live subscription this reconciliation newly added to the family's ledger. */
interface NewClaim {
  readonly channel: Channel;
  readonly productId: string;
  readonly environment: BillingEnvironment;
  readonly periodStart: Date;
  readonly periodEnd: Date;
}

export interface FamilyBillingResult {
  readonly capacity: FamilyCapacity;
  readonly newClaims: readonly NewClaim[];
}

/**
 * Reconciles one family from a COMPLETE provider fetch of its billing ref (never a single event's
 * payload). Must run inside a transaction that already holds the family row lock. Throws the
 * applySnapshots BUG-006 error when a subscription is bound to another family.
 */
export async function reconcileFamilyBilling(
  tx: Tx,
  familyId: string,
  snapshots: readonly ProviderSubscriptionSnapshot[],
  environment: BillingEnvironment,
  now: Date,
): Promise<FamilyBillingResult> {
  const before = await tx<LedgerRow[]>`
    select channel, provider_subscription_id, product_id, status, environment, period_start, period_end,
           provider_updated_at
      from public.family_entitlements
     where family_id = ${familyId} and period_start is not null and period_end is not null
  `;
  const vanished = vanishedSnapshots(before, snapshots, environment, now);
  const capacity = await applySnapshots(
    tx,
    familyId,
    [...snapshots, ...vanished],
    environment,
    now,
  );
  await releaseSlotlessProfiles(tx, familyId);
  // A redemption whose target period can no longer happen is resolved now (RV-2).
  await resolveUnreachableRedemptions(tx, now, familyId);
  await settleCapacityChanges(tx, familyId, capacity.paidSlots);
  const known = new Set(before.map((r) => ledgerKey(r.channel, r.provider_subscription_id)));
  const newClaims = snapshots
    .filter(
      (s) =>
        s.environment === environment &&
        !TERMINAL_STATUSES.has(s.status) &&
        !known.has(ledgerKey(s.channel, s.providerSubscriptionId)),
    )
    .map((s) => ({
      channel: s.channel,
      productId: s.productId,
      environment: s.environment,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
    }));
  return { capacity, newClaims };
}

/** Fetches a family's provider state and reconciles it with the family row locked. */
async function syncFamilyFromProvider(
  deps: AppDeps,
  familyId: string,
  billingRef: string,
  now: Date,
): Promise<FamilyBillingResult | null> {
  const snapshots = await deps.providers.subscriptions.fetchSubscriptions(billingRef, now);
  return deps.db.asService(async (tx) => {
    const [live] = await tx<{ deleted_at: Date | null }[]>`
      select deleted_at from public.families where id = ${familyId} for update
    `;
    if (!live || live.deleted_at) return null;
    return reconcileFamilyBilling(tx, familyId, snapshots, deps.config.billingEnvironment, now);
  });
}

/**
 * RV-billing-1: when this family newly holds a live store subscription that another family's ledger
 * also holds for the same store product and exact provider period (a restore or transfer moved it),
 * that family is re-verified with the provider at once, so one purchase never keeps paying for two
 * families while the other parent is away. Only the provider's answer for that family's OWN billing
 * ref decides; nothing from this request is written to it and nothing about it is returned. Best
 * effort after this family's own transaction committed (no nested family locks): a failure is
 * logged, and that family is corrected by its own next sync.
 */
async function reverifyFormerHolders(
  deps: AppDeps,
  familyId: string,
  claims: readonly NewClaim[],
  now: Date,
  requestId: string,
): Promise<void> {
  if (claims.length === 0) return;
  const holders = new Map<string, string>();
  for (const claim of claims) {
    if (holders.size >= MAX_FORMER_HOLDERS) break;
    const rows = await deps.db.asService(
      (tx) => tx<{ id: string; billing_ref: string }[]>`
        select distinct f.id, f.billing_ref
          from public.family_entitlements e
          join public.families f on f.id = e.family_id and f.deleted_at is null
         where e.family_id <> ${familyId}
           and e.channel = ${claim.channel} and e.product_id = ${claim.productId}
           and e.environment = ${claim.environment}
           and e.period_start = ${claim.periodStart} and e.period_end = ${claim.periodEnd}
           and e.status not in ('expired', 'revoked', 'refunded')
         limit ${MAX_FORMER_HOLDERS}
      `,
    );
    for (const row of rows) {
      if (holders.size < MAX_FORMER_HOLDERS) holders.set(row.id, row.billing_ref);
    }
  }
  for (const [holderId, billingRef] of holders) {
    try {
      await syncFamilyFromProvider(deps, holderId, billingRef, now);
    } catch {
      deps.log({ level: 'warn', event: 'billing_former_holder_reverify_failed', requestId });
    }
  }
}

/** Thrown by applySnapshots when a store subscription already belongs to another family (BUG-006). */
const BOUND_ELSEWHERE = 'Provider subscription is bound to a different family';

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
      if (error instanceof Error && error.message === BOUND_ELSEWHERE) {
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
