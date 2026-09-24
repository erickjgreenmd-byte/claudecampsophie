/**
 * Normalized access states for one provider subscription (spec P11). Every provider (RevenueCat for
 * Apple/Google, optional Stripe) is mapped into this vocabulary before it reaches the ledger.
 */
export const ENTITLEMENT_STATUSES = [
  'pending',
  'active',
  'grace_period',
  'billing_retry',
  /** Auto-renew turned off but still inside the paid period. */
  'cancelled_active',
  'expired',
  'revoked',
  'refunded',
] as const;

export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number];

export function assertValidInstant(value: Date, label: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError(`${label} must be a valid Date`);
  }
  return value;
}

/**
 * Whether a subscription in `status` grants paid access at `now`.
 *
 * - `active` and `grace_period` grant. Decision: neither is gated on `periodEnd`. Renewal events
 *   routinely arrive after the nominal period end and a store grace period by definition runs past
 *   it; the freshly fetched provider status is authoritative, and snapshot staleness is handled by
 *   provider reconciliation, not by guessing here.
 * - `cancelled_active` grants only while `now < periodEnd` (Decision: the end instant is exclusive),
 *   so capacity lapses at period end even if no expiry event is ever delivered.
 * - `billing_retry` does NOT grant. Decision: RevenueCat/store grace periods are normalized to
 *   `grace_period`; `billing_retry` means the provider is retrying after grace (or with grace
 *   disabled), and the store itself has removed access.
 * - `pending` (incl. Ask to Buy), `expired`, `revoked` and `refunded` never grant.
 * - Any other value (untrusted provider data that bypassed parsing) fails closed.
 */
export function grantsAccess(status: EntitlementStatus, periodEnd: Date, now: Date): boolean {
  assertValidInstant(periodEnd, 'periodEnd');
  assertValidInstant(now, 'now');
  switch (status) {
    case 'active':
    case 'grace_period':
      return true;
    case 'cancelled_active':
      return now.getTime() < periodEnd.getTime();
    case 'billing_retry':
    case 'pending':
    case 'expired':
    case 'revoked':
    case 'refunded':
      return false;
    default:
      return false;
  }
}

/**
 * Deterministic restrictiveness rank used only to break exact ties between conflicting provider
 * observations: lower is more restrictive. Independent of `now` so ledger ordering is stable.
 */
export function accessRank(status: EntitlementStatus): number {
  switch (status) {
    case 'active':
      return 3;
    case 'grace_period':
      return 2;
    case 'cancelled_active':
      return 1;
    case 'billing_retry':
    case 'pending':
    case 'expired':
    case 'revoked':
    case 'refunded':
      return 0;
    default:
      return 0;
  }
}
