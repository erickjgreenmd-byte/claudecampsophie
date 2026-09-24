import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ApiError } from '../errors.ts';
import type { AppEnv } from '../middleware/context.ts';
import { sha256Hex, timingSafeEqual } from '../security/crypto.ts';
import {
  applyRefund,
  applySnapshots,
  isRevenueCatRefund,
  mapRevenueCatEventToPeriod,
  mapStripeInvoiceToPeriod,
  reconcilePromotionsForPeriod,
  recordBillingPeriod,
  stripeBillingRef,
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
  }),
});

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
    const refs = [event.app_user_id, event.original_app_user_id, ...(event.aliases ?? [])].filter(
      (x): x is string => typeof x === 'string' && x.length > 0,
    );
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
      await deps.db.asService(async (tx) => {
        await tx`select 1 from public.families where id = ${family.id} for update`;
        await applySnapshots(tx, family.id, snapshots, deps.config.billingEnvironment, now);
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
        if (isRevenueCatRefund(event) && event.transaction_id && event.store) {
          const channel =
            event.store === 'app_store' || event.store === 'play_store' ? event.store : null;
          if (channel)
            await applyRefund(tx, family.id, channel, event.transaction_id, 'refund', null);
        }
      });
      await finishEvent(c, 'revenuecat', event.id, 'processed', family.id);
      return c.json({ status: 'processed' });
    } catch (error) {
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
    const event = JSON.parse(raw) as {
      id: string;
      type: string;
      data?: { object?: StripeInvoice & { invoice?: string; amount_refunded?: number } };
    };
    if (!(await recordEvent(c, 'stripe', event.id, event.type, raw)))
      return c.json({ status: 'duplicate' });
    const object = event.data?.object;
    const ref = object ? stripeBillingRef(object) : null;
    const family = ref ? await familyForRefs(c, [ref]) : null;
    if (!family || family.deleted_at || !object) {
      await finishEvent(
        c,
        'stripe',
        event.id,
        'ignored',
        family?.id ?? null,
        family?.deleted_at ? 'FAMILY_DELETED' : 'UNKNOWN_SUBSCRIBER',
      );
      return c.json({ status: 'ignored' });
    }
    await deps.db.asService(async (tx) => {
      await tx`select 1 from public.families where id = ${family.id} for update`;
      if (
        event.type === 'invoice.created' &&
        object.billing_reason === 'subscription_cycle' &&
        object.status === 'draft'
      ) {
        // Attach a pending web promotion to exactly this renewal invoice (never a proration invoice).
        const period = mapStripeInvoiceToPeriod(object);
        if (period) {
          const [pending] = await tx<
            {
              id: string;
              campaign_id: string;
              paid_slots: number;
              target_period_start: Date | null;
            }[]
          >`
            select id, campaign_id, paid_slots, target_period_start from public.promo_redemptions
             where family_id = ${family.id} and channel = 'stripe' and state = 'provider_pending'
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
              await deps.providers.stripe.addDiscountToDraftInvoice(
                object.id,
                mapping.provider_offer_id,
              );
          }
        }
      }
      if (event.type === 'invoice.paid') {
        const period = mapStripeInvoiceToPeriod(object);
        if (period) {
          const recorded = await recordBillingPeriod(
            tx,
            family.id,
            period,
            deps.config.billingEnvironment,
          );
          if (recorded && period.kind === 'subscription_period') {
            await reconcilePromotionsForPeriod(
              tx,
              family.id,
              period,
              recorded.regularCents,
              object.billing_reason === 'subscription_create',
            );
          }
        }
      }
      if (event.type === 'charge.refunded' && object.invoice) {
        await applyRefund(
          tx,
          family.id,
          'stripe',
          object.invoice,
          'refund',
          object.amount_refunded ?? null,
        );
      }
      if (event.type === 'charge.dispute.created' && object.invoice) {
        await applyRefund(tx, family.id, 'stripe', object.invoice, 'chargeback', null);
      }
    });
    await finishEvent(c, 'stripe', event.id, 'processed', family.id);
    return c.json({ status: 'processed' });
  });

  return r;
}
