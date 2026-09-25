import type {
  BillingEntitlement,
  BillingEntitlementStatus,
  BillingProduct,
  BillingStatus,
} from '@pencillift/contracts';
import { formatUsd } from '@pencillift/domain';
import { productMatches, STORE_LABEL, type StoreChannel, type StoreProductInfo } from './store.ts';

/**
 * View model for the parent plan screen (spec P11, P14 "subscription" + "paid-slot management";
 * AC_CAPACITY_02/06/11). Pure: no react-native imports, no clock. Every state is spelled out in
 * text, never colour alone. Two prices are never merged: the owner-approved price comes from the
 * server (integer cents), the charge comes from the store, and a difference is always stated. A
 * plan whose US store price is not the approved price is never offered (AC_CAPACITY_02).
 */

export interface PlanViewInput {
  readonly status: BillingStatus;
  /** This device's store, or null where there is none. */
  readonly deviceChannel: StoreChannel | null;
  /** Native purchases are configured in this build (a real public SDK key is present). */
  readonly storeAvailable: boolean;
  /** Products as loaded from the store, or null while unavailable/not loaded. */
  readonly storeProducts: readonly StoreProductInfo[] | null;
  /** IANA zone for dates; the device zone when omitted (tests pass one for determinism). */
  readonly timeZone?: string | undefined;
}

export type PlanAvailability =
  | { readonly kind: 'ready' }
  /** No real store key in this build: nothing can be bought here, and nothing is pretended. */
  | { readonly kind: 'not_in_build'; readonly message: string }
  | { readonly kind: 'no_store_on_device'; readonly message: string }
  /** The subscription is billed by a different store: buying here would create a duplicate. */
  | { readonly kind: 'managed_elsewhere'; readonly message: string }
  /**
   * A store subscription grants nothing right now but is still live (billing retry, or a purchase
   * waiting for Ask to Buy / payment): the store may still charge it, so a new purchase anywhere
   * could make the family pay twice (RV-billing-5).
   */
  | { readonly kind: 'store_action_needed'; readonly message: string }
  | { readonly kind: 'store_loading'; readonly message: string };

export type TierRelation = 'current' | 'upgrade' | 'downgrade';

export interface TierView {
  readonly paidSlots: number;
  readonly label: string;
  readonly approvedCents: number;
  readonly approvedPriceText: string;
  /** The store's own price for this plan on this device: the actual charge. */
  readonly storePriceText: string | null;
  /** Stated whenever the store price differs from the approved price (never silently relabeled). */
  readonly priceNotice: string | null;
  /**
   * Why this plan can't be bought here because of its price (a concrete catalog constraint), or
   * null. Set whenever the store's US price is not the approved price or can't be confirmed.
   */
  readonly priceBlock: string | null;
  /** Store product to buy on this device, when one is verified and offered by the store. */
  readonly productId: string | null;
  readonly relation: TierRelation;
  readonly purchasable: boolean;
  readonly unavailableReason: string | null;
  readonly actionLabel: string | null;
  readonly a11yLabel: string;
}

export interface EntitlementLine {
  readonly key: string;
  readonly text: string;
}

export interface PlanView {
  readonly headline: string;
  readonly slotsLine: string;
  readonly unusedSlotLine: string | null;
  readonly managedByLine: string | null;
  readonly conflictWarning: string | null;
  readonly pendingLine: string | null;
  readonly requestedLine: string | null;
  readonly entitlementLines: readonly EntitlementLine[];
  readonly availability: PlanAvailability;
  readonly tiers: readonly TierView[];
  /** The product this family pays for on this device's store now, if any. */
  readonly currentProductId: string | null;
  readonly canRestore: boolean;
  readonly canManage: boolean;
}

export function childrenLabel(count: number): string {
  return count === 1 ? '1 child' : `${count} children`;
}

function perMonth(text: string): string {
  return `${text} per month`;
}

function longDate(iso: string, timeZone: string | undefined): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    ...(timeZone === undefined ? {} : { timeZone }),
  });
}

const STATUS_TEXT: Record<BillingEntitlementStatus, string> = {
  pending: 'Waiting for the store (for example Ask to Buy) — no access yet',
  active: 'Active',
  grace_period: 'Payment problem — access continues during the store’s grace period',
  billing_retry: 'Payment problem — the store is retrying; paid access is paused',
  cancelled_active: 'Cancelled — access continues until the period ends',
  expired: 'Ended',
  revoked: 'Revoked by the store',
  refunded: 'Refunded',
};

/** Statuses in which a subscription is the family's current store product. */
const CURRENT_STATUSES = new Set<BillingEntitlementStatus>([
  'active',
  'grace_period',
  'billing_retry',
  'cancelled_active',
]);

/**
 * Store states that grant no access now but keep the subscription alive: the store retries the
 * charge (billing retry) or may still complete the purchase (Ask to Buy / payment pending).
 */
const LIVE_NOT_GRANTING = new Set<BillingEntitlementStatus>(['billing_retry', 'pending']);

/** A live subscription that grants nothing right now, if the family has one (RV-billing-5). */
export function waitingSubscription(status: BillingStatus): BillingEntitlement | null {
  return status.entitlements.find((e) => LIVE_NOT_GRANTING.has(e.status)) ?? null;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function entitlementLine(
  e: BillingStatus['entitlements'][number],
  timeZone: string | undefined,
): string {
  const plan = e.paidSlots > 0 ? childrenLabel(e.paidSlots) : 'plan not recognized';
  const when = e.periodEnd
    ? e.status === 'active' && e.autoRenew
      ? `renews ${longDate(e.periodEnd, timeZone)}`
      : `${e.status === 'expired' || e.status === 'refunded' || e.status === 'revoked' ? 'ended' : 'ends'} ${longDate(e.periodEnd, timeZone)}`
    : 'no date from the store yet';
  const renew = e.autoRenew ? 'auto-renew on' : 'auto-renew off';
  return `${capitalize(STORE_LABEL[e.channel])}: ${plan} · ${STATUS_TEXT[e.status]} · ${when} · ${renew}`;
}

function priceNotice(
  channel: StoreChannel,
  approvedCents: number,
  store: StoreProductInfo,
): string | null {
  const storeName = STORE_LABEL[channel];
  const approved = formatUsd(approvedCents);
  if (store.usdCents === null) {
    return `${capitalize(storeName)} shows this plan as ${store.priceText} per month in your local currency. PencilLift’s approved US price is ${approved}.`;
  }
  if (store.usdCents === approvedCents) return null;
  return `${capitalize(storeName)} charges ${store.priceText} per month for this plan, which differs from PencilLift’s approved price of ${approved}.`;
}

/**
 * RV-billing-4 (AC_CAPACITY_02, docs/Owner_Actions.md #1): a plan is sold only when its US store
 * price is known to equal the approved price, so $49.99 for 2 children is blocked with the concrete
 * constraint instead of being offered with a notice. The device compares a USD price itself; the
 * server's verified catalog price must also agree, and it is the only check for a storefront in
 * another currency. Returns the parent-facing report, or null when the price is approved.
 */
function priceBlockFor(
  channel: StoreChannel,
  tier: BillingStatus['tiers'][number],
  offered: StoreProductInfo,
  catalogProduct: BillingProduct | undefined,
): string | null {
  const approved = formatUsd(tier.approvedMonthlyCents);
  const storeName = STORE_LABEL[channel];
  const differs = (charge: string) =>
    `${capitalize(storeName)} charges ${charge} per month for ${childrenLabel(tier.paidSlots)}, but PencilLift’s approved price is ${approved}. Prices are never rounded, so this plan can’t be bought in ${storeName} until its store price matches.`;
  if (offered.usdCents !== null && offered.usdCents !== tier.approvedMonthlyCents) {
    return differs(offered.priceText);
  }
  if (
    catalogProduct?.priceCheck === 'differs_from_approved' &&
    catalogProduct.storePriceCents !== null
  ) {
    return differs(formatUsd(catalogProduct.storePriceCents));
  }
  if (offered.usdCents === null && catalogProduct?.priceCheck !== 'matches_approved') {
    return `${capitalize(storeName)} shows this plan in another currency, and its US price hasn’t been confirmed as PencilLift’s approved ${approved} yet, so it can’t be bought here for now.`;
  }
  return null;
}

function availabilityFor(input: PlanViewInput): PlanAvailability {
  const { status, deviceChannel } = input;
  if (deviceChannel === null) {
    return {
      kind: 'no_store_on_device',
      message:
        'Plans are bought and changed in the PencilLift app on an iPhone, iPad, Android device or Fire tablet.',
    };
  }
  if (!input.storeAvailable) {
    return {
      kind: 'not_in_build',
      message:
        'Buying or changing a plan isn’t available in this build of the app. Nothing can be charged here; your current plan is shown as your store reports it.',
    };
  }
  if (status.managingChannel !== null && status.managingChannel !== deviceChannel) {
    const other = STORE_LABEL[status.managingChannel];
    return {
      kind: 'managed_elsewhere',
      message: `Your subscription is billed by ${other}. To avoid paying twice, change it through ${other}${status.managingChannel === 'stripe' ? '' : ' on the device and account that bought it'}.`,
    };
  }
  const waiting = waitingSubscription(status);
  if (waiting !== null) {
    const store = STORE_LABEL[waiting.channel];
    return {
      kind: 'store_action_needed',
      message:
        waiting.status === 'billing_retry'
          ? `Your subscription in ${store} has a payment problem, and ${store} is still trying to charge it. Update your payment details or cancel it in ${store} before buying or changing a plan, so you aren’t charged twice.`
          : `A purchase in ${store} is waiting for approval (for example Ask to Buy) or for the payment to finish. Wait for it to complete before buying or changing a plan, so you aren’t charged twice.`,
    };
  }
  if (input.storeProducts === null) {
    return { kind: 'store_loading', message: 'Loading plans from the store…' };
  }
  return { kind: 'ready' };
}

/** The store product this family currently pays for on `channel`, if any. */
export function currentProductOn(
  status: BillingStatus,
  channel: StoreChannel | null,
): string | null {
  if (channel === null || status.managingChannel !== channel) return null;
  const current = status.entitlements.find(
    (e) =>
      e.channel === channel && CURRENT_STATUSES.has(e.status) && e.paidSlots === status.paidSlots,
  );
  return current?.productId ?? null;
}

function tierView(
  input: PlanViewInput,
  availability: PlanAvailability,
  tier: BillingStatus['tiers'][number],
): TierView {
  const { status, deviceChannel } = input;
  const label = childrenLabel(tier.paidSlots);
  const approvedPriceText = formatUsd(tier.approvedMonthlyCents);
  const relation: TierRelation =
    status.paidSlots > 0 && tier.paidSlots === status.paidSlots
      ? 'current'
      : tier.paidSlots > status.paidSlots
        ? 'upgrade'
        : 'downgrade';
  const catalog =
    deviceChannel === null
      ? []
      : status.products.filter(
          (p) => p.channel === deviceChannel && p.paidSlots === tier.paidSlots,
        );
  const offered =
    input.storeProducts?.find((sp) =>
      catalog.some((p) => productMatches(p.productId, sp.productId)),
    ) ?? null;
  const notice =
    offered && deviceChannel
      ? priceNotice(deviceChannel, tier.approvedMonthlyCents, offered)
      : null;
  const priceBlock =
    offered && deviceChannel
      ? priceBlockFor(
          deviceChannel,
          tier,
          offered,
          catalog.find((p) => productMatches(p.productId, offered.productId)),
        )
      : null;

  let unavailableReason: string | null = null;
  if (relation === 'current') unavailableReason = null;
  else if (availability.kind !== 'ready') unavailableReason = availability.message;
  else if (catalog.length === 0)
    unavailableReason = `This plan isn’t set up in ${STORE_LABEL[deviceChannel!]} yet.`;
  else if (!offered)
    unavailableReason = `${capitalize(STORE_LABEL[deviceChannel!])} isn’t offering this plan right now.`;
  else if (priceBlock !== null) unavailableReason = priceBlock;
  const purchasable = relation !== 'current' && unavailableReason === null && offered !== null;
  const actionLabel =
    relation === 'current'
      ? null
      : relation === 'upgrade'
        ? status.paidSlots === 0
          ? `Choose ${label}`
          : `Change to ${label}`
        : `Change to ${label}`;
  const priceForA11y = offered
    ? `${offered.priceText} per month from the store; approved price ${approvedPriceText}`
    : `approved price ${approvedPriceText} per month`;
  return {
    paidSlots: tier.paidSlots,
    label,
    approvedCents: tier.approvedMonthlyCents,
    approvedPriceText: perMonth(approvedPriceText),
    storePriceText: offered ? perMonth(offered.priceText) : null,
    priceNotice: notice,
    priceBlock,
    productId: offered?.productId ?? null,
    relation,
    purchasable,
    unavailableReason,
    actionLabel,
    a11yLabel: `${label}, ${priceForA11y}${relation === 'current' ? ', your current plan' : ''}`,
  };
}

/** What the store charges for the plan the family pays for now, as the store or server reports it. */
function currentCharge(
  input: PlanViewInput,
): { readonly store: string; readonly text: string; readonly usdCents: number | null } | null {
  const { status, deviceChannel } = input;
  const managing = status.managingChannel;
  if (managing === null) return null;
  const entitlement = status.entitlements.find(
    (e) =>
      e.channel === managing && CURRENT_STATUSES.has(e.status) && e.paidSlots === status.paidSlots,
  );
  if (!entitlement) return null;
  const store = STORE_LABEL[managing];
  if (managing === deviceChannel) {
    const onDevice = input.storeProducts?.find((sp) =>
      productMatches(entitlement.productId, sp.productId),
    );
    if (onDevice) return { store, text: onDevice.priceText, usdCents: onDevice.usdCents };
  }
  const verified = status.products.find(
    (p) =>
      p.channel === managing && p.productId === entitlement.productId && p.storePriceCents !== null,
  );
  if (verified === undefined || verified.storePriceCents === null) return null;
  return { store, text: formatUsd(verified.storePriceCents), usdCents: verified.storePriceCents };
}

/**
 * The plan headline never presents the approved price as the charge (RV-billing-4): the store's own
 * price is named, and a difference is stated. A live subscription that grants nothing right now is
 * never described as "no subscription" (RV-billing-5).
 */
function headlineFor(input: PlanViewInput): string {
  const { status } = input;
  if (status.paidSlots === 0) {
    const waiting = waitingSubscription(status);
    if (waiting?.status === 'billing_retry') {
      return `Paid access is paused: ${STORE_LABEL[waiting.channel]} couldn’t take the last payment and is still retrying it.`;
    }
    if (waiting?.status === 'pending') {
      return `No paid access yet: a purchase in ${STORE_LABEL[waiting.channel]} is waiting for approval or for the payment to finish.`;
    }
    return 'No active subscription. Choose a plan to give your children paid learning features.';
  }
  const covers = `Your plan covers ${childrenLabel(status.paidSlots)}`;
  const tier = status.tiers.find((t) => t.paidSlots === status.paidSlots);
  if (!tier) return `${covers}.`;
  const approved = formatUsd(tier.approvedMonthlyCents);
  const charge = currentCharge(input);
  if (charge === null) {
    return `${covers}. PencilLift’s approved price is ${approved} per month; your store receipt shows what you’re charged.`;
  }
  if (charge.usdCents === tier.approvedMonthlyCents) return `${covers} (${approved} per month).`;
  if (charge.usdCents === null) {
    return `${covers}. ${capitalize(charge.store)} charges ${charge.text} per month in your local currency (PencilLift’s approved US price is ${approved}).`;
  }
  return `${covers}. ${capitalize(charge.store)} charges ${charge.text} per month, which differs from PencilLift’s approved price of ${approved}.`;
}

export function buildPlanView(input: PlanViewInput): PlanView {
  const { status, timeZone } = input;
  const availability = availabilityFor(input);
  const headline = headlineFor(input);
  const free = Math.max(0, status.paidSlots - status.assignedSlots);
  const slotsLine = `${status.paidSlots} paid child ${status.paidSlots === 1 ? 'slot' : 'slots'} · ${status.assignedSlots} in use · ${free} unused`;
  const unusedSlotLine =
    free > 0
      ? `You have ${free} unused paid ${free === 1 ? 'slot' : 'slots'}. Assign ${free === 1 ? 'it' : 'them'} to a child in Children — no new purchase is needed.`
      : null;
  const managedByLine = status.managingChannel
    ? `Billed by ${STORE_LABEL[status.managingChannel]}.`
    : null;
  const conflictWarning =
    status.conflict === 'duplicate_active_subscriptions'
      ? 'You have more than one active subscription (for example in both the App Store and Google Play). They don’t add up: you get the larger plan only. Cancel the one you don’t need in its store so you aren’t charged twice.'
      : null;
  const pendingLine = status.pendingChange
    ? `The store will change your plan to ${childrenLabel(status.pendingChange.targetSlots)} on ${longDate(status.pendingChange.effectiveAt, timeZone)}. Until then, your current plan continues.`
    : null;
  const requested = status.requestedChange;
  const requestedLine = requested
    ? requested.kind === 'upgrade'
      ? `You started changing to ${childrenLabel(requested.toSlots)}. No store purchase has been confirmed yet, so nothing has changed.`
      : `You chose ${childrenLabel(requested.toSlots)} with ${childrenLabel(requested.keepCount)} staying active. It takes effect only when the store confirms the change.`
    : null;
  const tiers = status.tiers.map((tier) => tierView(input, availability, tier));
  return {
    headline,
    slotsLine,
    unusedSlotLine,
    managedByLine,
    conflictWarning,
    pendingLine,
    requestedLine,
    entitlementLines: status.entitlements.map((e, i) => ({
      key: `${e.channel}:${e.productId}:${i}`,
      text: entitlementLine(e, timeZone),
    })),
    availability,
    tiers,
    currentProductId: currentProductOn(status, input.deviceChannel),
    canRestore: input.storeAvailable && input.deviceChannel !== null,
    // Managing an existing subscription opens the store's own page; it needs no SDK key. A
    // subscription in billing retry on this store is managed there too (fix the payment method).
    canManage:
      input.deviceChannel !== null &&
      (status.managingChannel === input.deviceChannel ||
        status.entitlements.some(
          (e) => e.channel === input.deviceChannel && e.status === 'billing_retry',
        )),
  };
}
