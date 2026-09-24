import type { BillingEntitlementStatus, BillingStatus } from '@pencillift/contracts';
import { formatUsd } from '@pencillift/domain';
import { productMatches, STORE_LABEL, type StoreChannel, type StoreProductInfo } from './store.ts';

/**
 * View model for the parent plan screen (spec P11, P14 "subscription" + "paid-slot management";
 * AC_CAPACITY_02/06/11). Pure: no react-native imports, no clock. Every state is spelled out in
 * text, never colour alone. Two prices are never merged: the owner-approved price comes from the
 * server (integer cents), the charge comes from the store, and a difference is always stated.
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
    return `${capitalize(storeName)} shows this plan as ${store.priceText} per month in your local currency. PencilLift’s approved US price is ${approved}. You pay the store’s price.`;
  }
  if (store.usdCents === approvedCents) return null;
  return `${capitalize(storeName)} charges ${store.priceText} per month for this plan, which differs from PencilLift’s approved price of ${approved}. You pay the store’s price shown.`;
}

function availabilityFor(input: PlanViewInput): PlanAvailability {
  const { status, deviceChannel } = input;
  if (deviceChannel === null) {
    return {
      kind: 'no_store_on_device',
      message:
        'Plans are bought and changed in the PencilLift app on an iPhone, iPad or Android device.',
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

  let unavailableReason: string | null = null;
  if (relation === 'current') unavailableReason = null;
  else if (availability.kind !== 'ready') unavailableReason = availability.message;
  else if (catalog.length === 0)
    unavailableReason = `This plan isn’t set up in ${STORE_LABEL[deviceChannel!]} yet.`;
  else if (!offered)
    unavailableReason = `${capitalize(STORE_LABEL[deviceChannel!])} isn’t offering this plan right now.`;
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
    productId: offered?.productId ?? null,
    relation,
    purchasable,
    unavailableReason,
    actionLabel,
    a11yLabel: `${label}, ${priceForA11y}${relation === 'current' ? ', your current plan' : ''}`,
  };
}

export function buildPlanView(input: PlanViewInput): PlanView {
  const { status, timeZone } = input;
  const availability = availabilityFor(input);
  const current = status.tiers.find((t) => t.paidSlots === status.paidSlots);
  const headline =
    status.paidSlots === 0
      ? 'No active subscription. Choose a plan to give your children paid learning features.'
      : `Your plan covers ${childrenLabel(status.paidSlots)}${current ? ` (approved price ${formatUsd(current.approvedMonthlyCents)} per month)` : ''}.`;
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
    // Managing an existing subscription opens the store's own page; it needs no SDK key.
    canManage: input.deviceChannel !== null && status.managingChannel === input.deviceChannel,
  };
}
