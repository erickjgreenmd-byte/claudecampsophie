import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ApiError } from '../errors.ts';
import type { Tx } from '../db.ts';
import type { AppEnv } from '../middleware/context.ts';
import { sha256Hex, timingSafeEqual } from '../security/crypto.ts';
import {
  applyRefund,
  isRevenueCatRefund,
  mapRevenueCatEventToPeriod,
  mapStripeInvoiceToPeriod,
  reconcilePromotionsForPeriod,
  reconcileFamilyBilling,
  recordBillingPeriod,
  revenueCatRefundChannel,
  reverifyFormerHolders,
  stripeBillingRef,
  syncFamilyFromProvider,
  verifyStripeSignature,
  type RevenueCatEvent,
  type StripeInvoice,
} from '../services/billing-sync.ts';

type Ctx = Context<AppEnv>;

const revenueCatBodySchema = z.object({
  event: z.object({
    id: z.string().min(1).max(200),
    type: z.string().min(1).max(60),
    app_user_id: z.string().min(1).max(200),
    original_app_user_id: z.string().max(200).optional(),
    aliases: z.array(z.string().max(200)).max(50).optional(),
    product_id: z.string().max(200).optional(),
    store: z.string().max(40).optional(),
    purchased_at_ms: z.number().int().optional(),
    expiration_at_ms: z.number().int().nullable().optional(),
    price_in_purchased_currency: z.number().nullable().optional(),
    currency: z.string().max(8).nullable().optional(),
    period_type: z.string().max(40).optional(),
    offer_code: z.string().max(200).nullable().optional(),
    transaction_id: z.string().max(200).optional(),
    cancel_reason: z.string().max(60).optional(),
    event_timestamp_ms: z.number().int().optional(),
    environment: z.string().max(20).optional(),
    // TRANSFER events name the subscriber identities a purchase moved between.
    transferred_from: z.array(z.string().max(200)).max(50).optional(),
    transferred_to: z.array(z.string().max(200)).max(50).optional(),
  }),
});

/** Thrown inside a ledger transaction when the family was tombstoned meanwhile (RV-lead-billing-p17-10). */
class FamilyDeleted extends Error {
  constructor() {
    super('family deleted');
    this.name = 'FamilyDeleted';
  }
}

/** Locks the family row and refuses to write for a tombstoned family. */
async function lockLiveFamily(tx: Tx, familyId: string): Promise<void> {
  const [row] = await tx<{ deleted_at: Date | null }[]>`
    select deleted_at from public.families where id = ${familyId} for update`;
  if (!row || row.deleted_at) throw new FamilyDeleted();
}

/** Events stuck in 'received' longer than this belong to a worker that died; they may be retried. */
const RECEIVED_LEASE_MS = 5 * 60_000;

async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  // Compare fixed-length digests so neither length nor content leaks through timing.
  return timingSafeEqual(enc.encode(await sha256Hex(a)), enc.encode(await sha256Hex(b)));
}

async function recordEvent(
  c: Ctx,
  provider: 'revenuecat' | 'stripe',
  eventId: string,
  type: string,
  raw: string,
): Promise<boolean> {
  const digest = await sha256Hex(raw);
  const rows = await c.var.deps.db.asService(
    (tx) => tx`
      insert into public.billing_provider_events (provider, provider_event_id, event_type, payload_sha256)
      values (${provider}, ${eventId}, ${type}, ${digest})
      on conflict (provider, provider_event_id) do update
        set status = 'received', received_at = now(), error_code = null
        where public.billing_provider_events.status = 'failed'
           or (public.billing_provider_events.status = 'received'
               and public.billing_provider_events.received_at < ${new Date(c.var.deps.clock().getTime() - RECEIVED_LEASE_MS)})
      returning id
    `,
  );
  return rows.length > 0;
}

async function finishEvent(
  c: Ctx,
  provider: 'revenuecat' | 'stripe',
  eventId: string,
  status: 'processed' | 'ignored' | 'failed',
  familyId: string | null,
  errorCode: string | null = null,
): Promise<void> {
  await c.var.deps.db.asService(
    (tx) => tx`
      update public.billing_provider_events
         set status = ${status}, processed_at = now(), family_id = ${familyId}, error_code = ${errorCode}
       where provider = ${provider} and provider_event_id = ${eventId}
    `,
  );
}

/** Finds the live family for any of the provider's subscriber identities (opaque billing refs only). */
async function familyForRefs(c: Ctx, refs: readonly string[]) {
  const [row] = await c.var.deps.db.asService(
    (tx) => tx<{ id: string; billing_ref: string; deleted_at: Date | null }[]>`
      select id, billing_ref, deleted_at from public.families where billing_ref = any(${[...refs]}) limit 1
    `,
  );
  return row ?? null;
}

/** Every live family among the provider's subscriber identities (a TRANSFER names several). */
async function liveFamiliesForRefs(c: Ctx, refs: readonly string[]) {
  return c.var.deps.db.asService(
    (tx) => tx<{ id: string; billing_ref: string }[]>`
      select id, billing_ref from public.families
       where billing_ref = any(${[...refs]}) and deleted_at is null
       order by id
    `,
  );
}

type StripeObject = StripeInvoice & {
  object?: string;
  invoice?: string | null;
  charge?: string | null;
  payment_intent?: string | null;
  amount?: number;
  amount_refunded?: number;
  refunded?: boolean;
  status?: string | null;
};

interface StripeEvent {
  id: string;
  type: string;
  data?: { object?: StripeObject };
}

interface StripeTarget {
  readonly familyId: string;
  readonly object: StripeObject;
  /** The invoice a charge/dispute refers to, resolved through the Stripe API if needed. */
  readonly invoiceId: string | null;
}

/**
 * Finds the family an event belongs to. Invoices carry the opaque billing ref; charges and disputes
 * are resolved to the invoice they paid (a Dispute references only the charge; RV-6) and from there
 * to our recorded billing period.
 */
async function resolveStripeTarget(c: Ctx, event: StripeEvent): Promise<StripeTarget | null> {
  const object = event.data?.object;
  if (!object) return null;
  const { deps } = c.var;
  if (event.type.startsWith('invoice.')) {
    const ref = stripeBillingRef(object);
    const family = ref ? await familyForRefs(c, [ref]) : null;
    if (!family || family.deleted_at) return null;
    return { familyId: family.id, object, invoiceId: object.id };
  }
  if (event.type === 'charge.refunded' || event.type.startsWith('charge.dispute.')) {
    const chargeId = event.type === 'charge.refunded' ? object.id : (object.charge ?? null);
    const invoiceId =
      (typeof object.invoice === 'string' ? object.invoice : null) ??
      (chargeId
        ? await deps.providers.stripe.invoiceForCharge(chargeId, object.payment_intent ?? null)
        : null);
    if (invoiceId) {
      const [period] = await deps.db.asService(
        (tx) => tx<{ family_id: string }[]>`
          select family_id from public.billing_periods where channel = 'stripe' and provider_period_id = ${invoiceId}`,
      );
      if (period) return { familyId: period.family_id, object, invoiceId };
    }
    const ref = object.metadata?.billing_ref ?? null;
    const family = ref ? await familyForRefs(c, [ref]) : null;
    if (!family || family.deleted_at) return null;
    return { familyId: family.id, object, invoiceId };
  }
  return null;
}

async function processStripeEvent(
  c: Ctx,
  tx: Tx,
  event: StripeEvent,
  target: StripeTarget,
): Promise<void> {
  const { deps } = c.var;
  const { familyId, object } = target;
  if (
    event.type === 'invoice.created' &&
    object.billing_reason === 'subscription_cycle' &&
    object.status === 'draft'
  ) {
    // Attach a pending web promotion to exactly this renewal invoice (never a proration invoice).
    const period = mapStripeInvoiceToPeriod(object);
    if (!period) return;
    const [pending] = await tx<
      { id: string; campaign_id: string; paid_slots: number; target_period_start: Date | null }[]
    >`
      select id, campaign_id, paid_slots, target_period_start from public.promo_redemptions
       where family_id = ${familyId} and channel = 'stripe' and state = 'provider_pending'
    `;
    if (
      pending?.target_period_start &&
      Math.abs(pending.target_period_start.getTime() - period.periodStart.getTime()) <
        6 * 3600 * 1000
    ) {
      const [mapping] = await tx<{ provider_offer_id: string | null }[]>`
        select provider_offer_id from public.provider_offer_mappings
         where campaign_id = ${pending.campaign_id} and channel = 'stripe' and paid_slots = ${pending.paid_slots} and status = 'ready'
      `;
      if (mapping?.provider_offer_id)
        await deps.providers.stripe.addDiscountToDraftInvoice(object.id, mapping.provider_offer_id);
    }
    return;
  }
  if (event.type === 'invoice.paid') {
    const period = mapStripeInvoiceToPeriod(object);
    if (!period) return;
    const recorded = await recordBillingPeriod(
      tx,
      familyId,
      period,
      deps.config.billingEnvironment,
    );
    if (recorded && period.kind === 'subscription_period') {
      await reconcilePromotionsForPeriod(
        tx,
        familyId,
        period,
        recorded.regularCents,
        object.billing_reason === 'subscription_create',
      );
    }
    return;
  }
  if (!target.invoiceId) return; // a charge that paid no invoice of ours
  if (event.type === 'charge.refunded') {
    const refunded = object.amount_refunded ?? null;
    const full =
      object.refunded === true || (refunded !== null && refunded >= (object.amount ?? 0));
    // A partial refund is recorded as partial with its real amount (RV-lead-billing-p17-7).
    await applyRefund(
      tx,
      familyId,
      'stripe',
      target.invoiceId,
      full ? 'refund' : 'partial_refund',
      refunded,
    );
    return;
  }
  if (event.type === 'charge.dispute.created') {
    await applyRefund(tx, familyId, 'stripe', target.invoiceId, 'chargeback', null);
    return;
  }
  if (event.type === 'charge.dispute.closed' && object.status === 'won') {
    await applyRefund(tx, familyId, 'stripe', target.invoiceId, 'chargeback_reversed', null);
  }
}

/** Provider webhooks (spec E2, P11, P17): authenticate → dedupe → fetch current state → reconcile. */
export function webhooksRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post('/revenuecat', async (c) => {
    const { deps } = c.var;
    const expected = deps.config.webhooks.revenuecatAuthorization;
    if (!expected) throw new ApiError('NOT_CONFIGURED', 'Webhook not configured');
    if (!(await constantTimeEquals(c.req.header('authorization') ?? '', expected))) {
      throw new ApiError('UNAUTHENTICATED', 'Invalid webhook authorization');
    }
    const raw = await c.req.text();
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new ApiError('VALIDATION_FAILED', 'Invalid JSON');
    }
    const parsed = revenueCatBodySchema.safeParse(parsedJson);
    if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'Unexpected event shape');
    const e = parsed.data.event;
    const event: RevenueCatEvent = {
      id: e.id,
      type: e.type,
      app_user_id: e.app_user_id,
      original_app_user_id: e.original_app_user_id,
      aliases: e.aliases,
      product_id: e.product_id,
      store: e.store,
      purchased_at_ms: e.purchased_at_ms,
      expiration_at_ms: e.expiration_at_ms ?? undefined,
      price_in_purchased_currency: e.price_in_purchased_currency ?? undefined,
      currency: e.currency ?? undefined,
      period_type: e.period_type,
      offer_code: e.offer_code,
      transaction_id: e.transaction_id,
      cancel_reason: e.cancel_reason,
      event_timestamp_ms: e.event_timestamp_ms,
    };

    if (!(await recordEvent(c, 'revenuecat', event.id, event.type, raw))) {
      return c.json({ status: 'duplicate' });
    }
    // Sandbox (TestFlight / review) purchases never enter the production ledger and vice versa
    // (RV-lead-billing-p17-4). Production requires the event to say PRODUCTION.
    const expectedEnv = deps.config.billingEnvironment === 'production' ? 'PRODUCTION' : 'SANDBOX';
    const eventEnv = e.environment?.toUpperCase();
    if (eventEnv !== expectedEnv && !(eventEnv === undefined && expectedEnv === 'SANDBOX')) {
      await finishEvent(c, 'revenuecat', event.id, 'ignored', null, 'ENVIRONMENT_MISMATCH');
      return c.json({ status: 'ignored' });
    }
    const refs = [event.app_user_id, event.original_app_user_id, ...(event.aliases ?? [])].filter(
      (x): x is string => typeof x === 'string' && x.length > 0,
    );
    if (event.type === 'TRANSFER') {
      // A restore moved a purchase between subscriber identities. Each named family is re-verified
      // from its OWN complete provider state in its own transaction (no nested family locks), so
      // the purchase grants exactly where the provider now lists it (RV-billing-1).
      const named = [...refs, ...(e.transferred_from ?? []), ...(e.transferred_to ?? [])].filter(
        (x) => x.length > 0,
      );
      const families = await liveFamiliesForRefs(c, named);
      if (families.length === 0) {
        await finishEvent(c, 'revenuecat', event.id, 'ignored', null, 'UNKNOWN_SUBSCRIBER');
        return c.json({ status: 'ignored' });
      }
      try {
        const now = deps.clock();
        for (const f of families) await syncFamilyFromProvider(deps, f.id, f.billing_ref, now);
      } catch (error) {
        await finishEvent(
          c,
          'revenuecat',
          event.id,
          'failed',
          families[0]!.id,
          error instanceof Error ? error.name : 'Error',
        );
        throw new ApiError('PROVIDER_UNAVAILABLE', 'Temporary failure; retry');
      }
      await finishEvent(c, 'revenuecat', event.id, 'processed', families[0]!.id);
      return c.json({ status: 'processed' });
    }
    const family = await familyForRefs(c, refs);
    if (!family) {
      await finishEvent(c, 'revenuecat', event.id, 'ignored', null, 'UNKNOWN_SUBSCRIBER');
      return c.json({ status: 'ignored' });
    }
    if (family.deleted_at) {
      // Deleted families are never rebuilt by late provider events (spec E4 Deletion).
      await finishEvent(c, 'revenuecat', event.id, 'ignored', family.id, 'FAMILY_DELETED');
      return c.json({ status: 'ignored' });
    }
    try {
      const now = deps.clock();
      // Never trust event payload state: fetch the provider's current subscriber state.
      const snapshots = await deps.providers.subscriptions.fetchSubscriptions(
        family.billing_ref,
        now,
      );
      const result = await deps.db.asService(async (tx) => {
        await lockLiveFamily(tx, family.id);
        // The same whole-family reconciliation as POST /v1/billing/sync: a subscription the provider
        // no longer lists stops granting, released children go back to draft, open capacity
        // requests settle. The event's own period, promotions and refund are recorded once the
        // ledger reflects the fetch and before unreachable redemptions are resolved.
        return reconcileFamilyBilling(
          tx,
          family.id,
          snapshots,
          deps.config.billingEnvironment,
          now,
          async () => {
            const period = mapRevenueCatEventToPeriod(event);
            if (period) {
              const recorded = await recordBillingPeriod(
                tx,
                family.id,
                period,
                deps.config.billingEnvironment,
              );
              if (recorded) {
                await reconcilePromotionsForPeriod(
                  tx,
                  family.id,
                  period,
                  recorded.regularCents,
                  event.type === 'INITIAL_PURCHASE',
                );
              }
            }
            if (isRevenueCatRefund(event) && event.transaction_id) {
              const channel = revenueCatRefundChannel(event);
              if (channel)
                await applyRefund(tx, family.id, channel, event.transaction_id, 'refund', null);
            }
          },
        );
      });
      // A purchase newly listed here may still be granting to the family it came from.
      await reverifyFormerHolders(deps, family.id, result.newClaims, now, c.var.requestId);
      await finishEvent(c, 'revenuecat', event.id, 'processed', family.id);
      return c.json({ status: 'processed' });
    } catch (error) {
      if (error instanceof FamilyDeleted) {
        await finishEvent(c, 'revenuecat', event.id, 'ignored', family.id, 'FAMILY_DELETED');
        return c.json({ status: 'ignored' });
      }
      await finishEvent(
        c,
        'revenuecat',
        event.id,
        'failed',
        family.id,
        error instanceof Error ? error.name : 'Error',
      );
      // The provider retries; recordEvent re-opens a failed event so the retry is reprocessed.
      throw new ApiError('PROVIDER_UNAVAILABLE', 'Temporary failure; retry');
    }
  });

  r.post('/stripe', async (c) => {
    const { deps } = c.var;
    const secret = deps.config.webhooks.stripeSigningSecret;
    if (!secret || !deps.config.flags.stripeWebBillingEnabled)
      throw new ApiError('NOT_CONFIGURED', 'Web billing is not enabled');
    const raw = await c.req.text();
    if (
      !(await verifyStripeSignature(raw, c.req.header('stripe-signature'), secret, deps.clock()))
    ) {
      throw new ApiError('UNAUTHENTICATED', 'Invalid signature');
    }
    let event: StripeEvent;
    try {
      event = JSON.parse(raw) as StripeEvent;
    } catch {
      throw new ApiError('VALIDATION_FAILED', 'Invalid JSON');
    }
    if (typeof event.id !== 'string' || typeof event.type !== 'string')
      throw new ApiError('VALIDATION_FAILED', 'Unexpected event shape');
    if (!(await recordEvent(c, 'stripe', event.id, event.type, raw)))
      return c.json({ status: 'duplicate' });
    let familyId: string | null = null;
    try {
      const target = await resolveStripeTarget(c, event);
      familyId = target?.familyId ?? null;
      if (!target) {
        await finishEvent(c, 'stripe', event.id, 'ignored', null, 'UNKNOWN_SUBSCRIBER');
        return c.json({ status: 'ignored' });
      }
      await deps.db.asService(async (tx) => {
        await lockLiveFamily(tx, target.familyId);
        await processStripeEvent(c, tx, event, target);
      });
      await finishEvent(c, 'stripe', event.id, 'processed', target.familyId);
      return c.json({ status: 'processed' });
    } catch (error) {
      if (error instanceof FamilyDeleted) {
        await finishEvent(c, 'stripe', event.id, 'ignored', familyId, 'FAMILY_DELETED');
        return c.json({ status: 'ignored' });
      }
      // Stripe retries the same event; a failed event is re-opened then (RV-lead-billing-p17-5).
      await finishEvent(
        c,
        'stripe',
        event.id,
        'failed',
        familyId,
        error instanceof Error ? error.name : 'Error',
      );
      throw new ApiError('PROVIDER_UNAVAILABLE', 'Temporary failure; retry');
    }
  });

  return r;
}
