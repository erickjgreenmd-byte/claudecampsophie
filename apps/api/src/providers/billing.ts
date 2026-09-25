import { z } from 'zod';
import type { BillingChannel } from '@pencillift/domain';
import type {
  BillingEnvironment,
  EntitlementStatus,
  ProviderSubscriptionSnapshot,
} from '@pencillift/domain/entitlements';

/**
 * Billing provider adapters (docs/Architecture.md §5). The server never trusts a client purchase
 * result: after an authenticated, deduplicated webhook it fetches the provider's current state.
 *
 * The RevenueCat and Stripe clients below are written against the providers' documented REST APIs
 * but have NOT been exercised against live accounts (no credentials; docs/Connections.md). Tests use
 * the labeled mocks.
 */

export interface SubscriberStateProvider {
  readonly name: string;
  readonly isMock: boolean;
  /** Current subscriptions for the family's opaque billing ref (RevenueCat appUserID). */
  fetchSubscriptions(billingRef: string, now: Date): Promise<ProviderSubscriptionSnapshot[]>;
}

export interface StripeBillingClient {
  readonly name: string;
  readonly isMock: boolean;
  /** Attaches a one-time coupon to a DRAFT renewal invoice only (never a proration invoice). */
  addDiscountToDraftInvoice(invoiceId: string, couponId: string): Promise<void>;
  /**
   * The invoice a charge paid, for refunds and disputes (a Dispute references only the charge and
   * payment intent). Null when the charge paid no invoice.
   */
  invoiceForCharge(chargeId: string, paymentIntentId: string | null): Promise<string | null>;
}

// ---------------------------------------------------------------------------------------------
// RevenueCat (GET /v1/subscribers/{app_user_id})
// ---------------------------------------------------------------------------------------------

const nullableDate = z.string().nullable().optional();

const revenueCatSubscriptionSchema = z.object({
  expires_date: nullableDate,
  purchase_date: nullableDate,
  unsubscribe_detected_at: nullableDate,
  billing_issues_detected_at: nullableDate,
  grace_period_expires_date: nullableDate,
  refunded_at: nullableDate,
  is_sandbox: z.boolean().optional(),
  store: z.string().optional(),
});

const revenueCatSubscriberSchema = z.object({
  subscriber: z
    .object({ subscriptions: z.record(z.string(), revenueCatSubscriptionSchema).optional() })
    .optional(),
});

type RevenueCatSubscription = z.infer<typeof revenueCatSubscriptionSchema>;

/**
 * RevenueCat store names → PencilLift billing channels. The REST subscriber payload spells stores
 * in lowercase (`app_store`); webhook events spell them in uppercase (`APP_STORE`, `PLAY_STORE`,
 * `AMAZON`, `STRIPE`, `PROMOTIONAL`, `MAC_APP_STORE`), which a lowercase-only map turned into
 * "unknown store" for every real event (BUG-113). Both spellings are accepted. `AMAZON` is the
 * Amazon Appstore (Fire tablets). Promotional grants, the Mac App Store and any store PencilLift
 * does not sell on are not paid capacity and map to null.
 */
const STORE_CHANNEL: Record<string, BillingChannel | undefined> = {
  app_store: 'app_store',
  play_store: 'play_store',
  stripe: 'stripe',
  amazon: 'amazon_appstore',
};

/** The billing channel a RevenueCat `store` value names, in either spelling, or null. */
export function revenueCatStoreChannel(store: string | null | undefined): BillingChannel | null {
  if (typeof store !== 'string') return null;
  return STORE_CHANNEL[store.trim().toLowerCase()] ?? null;
}

function date(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Pure mapping of one RevenueCat subscription entry to a normalized snapshot (unit-tested). */
export function mapRevenueCatSubscription(
  billingRef: string,
  productId: string,
  sub: RevenueCatSubscription,
  now: Date,
): ProviderSubscriptionSnapshot | null {
  const channel = revenueCatStoreChannel(sub.store);
  // Promotional/manual grants and other stores are not paid capacity.
  if (!channel) return null;
  const periodStart = date(sub.purchase_date);
  const periodEnd = date(sub.expires_date);
  if (!periodStart || !periodEnd) return null;
  const refunded = date(sub.refunded_at);
  const grace = date(sub.grace_period_expires_date);
  const billingIssue = date(sub.billing_issues_detected_at);
  const unsubscribed = date(sub.unsubscribe_detected_at);
  let status: EntitlementStatus;
  if (refunded) status = 'refunded';
  else if (periodEnd <= now) status = grace && grace > now ? 'grace_period' : 'expired';
  else if (billingIssue) status = grace && grace > now ? 'grace_period' : 'billing_retry';
  else if (unsubscribed) status = 'cancelled_active';
  else status = 'active';
  const changes = [periodStart, refunded, grace, billingIssue, unsubscribed].filter(
    (d): d is Date => d !== null,
  );
  const providerUpdatedAt = new Date(Math.max(...changes.map((d) => d.getTime())));
  return {
    channel,
    // Globally unique: product ids repeat across families, so the subscriber identity is part of the
    // key (BUG-006). A store product per family has one RevenueCat subscription entry.
    providerSubscriptionId: `rc:${billingRef}:${channel}:${productId}`,
    productId,
    status,
    periodStart,
    periodEnd,
    autoRenew: unsubscribed === null,
    environment: (sub.is_sandbox ? 'sandbox' : 'production') satisfies BillingEnvironment,
    providerUpdatedAt,
    fetchedAt: now,
  };
}

export function createRevenueCatProvider(
  secretApiKey: string,
  fetchImpl: typeof fetch = fetch,
): SubscriberStateProvider {
  return {
    name: 'revenuecat',
    isMock: false,
    async fetchSubscriptions(billingRef, now) {
      const response = await fetchImpl(
        `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(billingRef)}`,
        {
          headers: { authorization: `Bearer ${secretApiKey}`, accept: 'application/json' },
        },
      );
      if (!response.ok)
        throw new Error(`RevenueCat subscriber fetch failed with ${response.status}`);
      // Provider data is untrusted input: validate its shape instead of casting.
      const body = revenueCatSubscriberSchema.parse(await response.json());
      const subs = body.subscriber?.subscriptions ?? {};
      return Object.entries(subs)
        .map(([productId, sub]) => mapRevenueCatSubscription(billingRef, productId, sub, now))
        .filter((s): s is ProviderSubscriptionSnapshot => s !== null);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Stripe (optional adult web billing; disabled by default)
// ---------------------------------------------------------------------------------------------

const stripeChargeSchema = z.object({
  invoice: z.string().nullable().optional(),
  payment_intent: z.string().nullable().optional(),
});

const stripeInvoicePaymentsSchema = z.object({
  data: z.array(z.object({ invoice: z.string().nullable().optional() })),
});

export function createStripeClient(
  secretKey: string,
  fetchImpl: typeof fetch = fetch,
): StripeBillingClient {
  return {
    name: 'stripe',
    isMock: false,
    async addDiscountToDraftInvoice(invoiceId, couponId) {
      const response = await fetchImpl(
        `https://api.stripe.com/v1/invoices/${encodeURIComponent(invoiceId)}`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${secretKey}`,
            'content-type': 'application/x-www-form-urlencoded',
            'idempotency-key': `discount:${invoiceId}:${couponId}`,
          },
          body: new URLSearchParams({ 'discounts[0][coupon]': couponId }).toString(),
        },
      );
      if (!response.ok) throw new Error(`Stripe invoice discount failed with ${response.status}`);
    },
    async invoiceForCharge(chargeId, paymentIntentId) {
      const headers = { authorization: `Bearer ${secretKey}` };
      // Older API versions expose charge.invoice directly.
      const charge = await fetchImpl(
        `https://api.stripe.com/v1/charges/${encodeURIComponent(chargeId)}`,
        { headers },
      );
      if (!charge.ok) throw new Error(`Stripe charge lookup failed with ${charge.status}`);
      const body = stripeChargeSchema.safeParse(await charge.json());
      if (!body.success) throw new Error('Unexpected Stripe charge shape');
      if (body.data.invoice) return body.data.invoice;
      // Newer API versions link invoices to payments through invoice payments.
      const intent = paymentIntentId ?? body.data.payment_intent ?? null;
      if (!intent) return null;
      const payments = await fetchImpl(
        `https://api.stripe.com/v1/invoice_payments?payment[type]=payment_intent&payment[payment_intent]=${encodeURIComponent(intent)}`,
        { headers },
      );
      if (!payments.ok)
        throw new Error(`Stripe invoice payment lookup failed with ${payments.status}`);
      const list = stripeInvoicePaymentsSchema.safeParse(await payments.json());
      if (!list.success) throw new Error('Unexpected Stripe invoice payment shape');
      return list.data.data[0]?.invoice ?? null;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Labeled mocks
// ---------------------------------------------------------------------------------------------

export function createSubscriberStateMock(): SubscriberStateProvider & {
  readonly state: Map<string, ProviderSubscriptionSnapshot[]>;
} {
  const state = new Map<string, ProviderSubscriptionSnapshot[]>();
  return {
    name: 'subscriber_state_mock',
    isMock: true,
    state,
    fetchSubscriptions(billingRef, now) {
      return Promise.resolve((state.get(billingRef) ?? []).map((s) => ({ ...s, fetchedAt: now })));
    },
  };
}

export function createStripeClientMock(): StripeBillingClient & {
  readonly discounts: { invoiceId: string; couponId: string }[];
  /** What the (mocked) Stripe API answers for charge -> invoice lookups. */
  readonly chargeInvoices: Map<string, string>;
} {
  const discounts: { invoiceId: string; couponId: string }[] = [];
  const chargeInvoices = new Map<string, string>();
  return {
    name: 'stripe_mock',
    isMock: true,
    discounts,
    chargeInvoices,
    addDiscountToDraftInvoice(invoiceId, couponId) {
      discounts.push({ invoiceId, couponId });
      return Promise.resolve();
    },
    invoiceForCharge(chargeId) {
      return Promise.resolve(chargeInvoices.get(chargeId) ?? null);
    },
  };
}
