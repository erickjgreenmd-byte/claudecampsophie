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
 * Longest time after a subscription's provider period end that an `active` or `grace_period`
 * observation keeps granting paid access without a newer provider observation (RV-entitlements-2).
 *
 * Decision: 30 days. That covers the longest configurable store billing grace period (Apple up to
 * 28 days, Google Play up to 30; confirm against the live store configuration at activation) and
 * leaves renewal webhooks and the reconciliation sweep time to deliver the next period. A genuine
 * renewal or grace state is re-observed with a new period end (or `grace_period` within this
 * window), so honest subscriptions never reach the bound. A row that was never re-verified, e.g.
 * because an EXPIRATION webhook was lost, stops granting instead of unlocking paid service forever
 * ("A local boolean never unlocks paid service", P11; AC_BILLING_03, AC_CAPACITY_10).
 */
export const MAX_ACCESS_AFTER_PERIOD_END_MS = 30 * 86_400_000;

/**
 * Whether a subscription in `status` grants paid access at `now`.
 *
 * - `active` and `grace_period` grant while `now < periodEnd + MAX_ACCESS_AFTER_PERIOD_END_MS`.
 *   Decision: neither lapses exactly at `periodEnd`, because renewal events routinely arrive after
 *   the nominal period end and a store grace period by definition runs past it. They are still
 *   time-bounded, so a stale ledger row cannot grant capacity indefinitely.
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
      return now.getTime() < periodEnd.getTime() + MAX_ACCESS_AFTER_PERIOD_END_MS;
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
