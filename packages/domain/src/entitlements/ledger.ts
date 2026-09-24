import { DEFAULT_MAX_PAID_SLOTS } from '../pricing/index.ts';
import type { BillingChannel } from '../shared/billing.ts';
import { err, ok, type Result } from '../shared/result.ts';
import {
  resolvePaidSlots,
  resolveProductSlots,
  type BillingEnvironment,
  type ProviderSubscriptionSnapshot,
  type ResolvePaidSlotsErrorCode,
  type StoreProductMapping,
} from './products.ts';
import { accessRank, assertValidInstant, grantsAccess, type EntitlementStatus } from './status.ts';

/**
 * One row of the normalized family entitlement ledger (`family_entitlements`), keyed by
 * (channel, providerSubscriptionId). It is the provider snapshot plus the capacity our server
 * resolved from verified product mappings — never a client-supplied slot count.
 */
export interface EntitlementRecord extends ProviderSubscriptionSnapshot {
  /** Paid slots resolved from the verified mapping; 0 when the product could not be resolved. */
  readonly paidSlots: number;
  readonly mappingError: ResolvePaidSlotsErrorCode | null;
  /** Resolved tier of `pendingProductId`, or null when absent/unresolvable. */
  readonly pendingPaidSlots: number | null;
}

/** An access-granting ledger row, as shown to the parent ("actual paid slot count and managing store"). */
export interface CapacitySource {
  readonly channel: BillingChannel;
  readonly providerSubscriptionId: string;
  readonly productId: string;
  readonly status: EntitlementStatus;
  readonly paidSlots: number;
  readonly periodEnd: Date;
  readonly autoRenew: boolean;
  readonly mappingError: ResolvePaidSlotsErrorCode | null;
}

export type CapacityConflict = 'duplicate_active_subscriptions';

export interface PendingCapacityChange {
  readonly targetSlots: number;
  readonly effectiveAt: Date;
}

export interface FamilyCapacity {
  /** MAX over access-granting records — never a sum across subscriptions or platforms. */
  readonly paidSlots: number;
  /** Access-granting records, the capacity-providing (managing) one first. */
  readonly sources: readonly CapacitySource[];
  readonly conflict: CapacityConflict | null;
  readonly managingChannel: BillingChannel | null;
  /** Provider-scheduled tier change on the managing subscription; informational until confirmed. */
  readonly pendingChange?: PendingCapacityChange;
}

export type ReconcileOutcome =
  | 'inserted'
  | 'updated'
  /** Same provider state observed again later: only `fetchedAt` advanced. */
  | 'refreshed'
  | 'ignored_duplicate'
  | 'ignored_stale'
  | 'rejected_environment';

export interface ReconcileResult {
  readonly records: readonly EntitlementRecord[];
  readonly capacity: FamilyCapacity;
  readonly changed: boolean;
  readonly outcome: ReconcileOutcome;
  /** Why the snapshot's product grants no capacity, if it does not. */
  readonly mappingError: ResolvePaidSlotsErrorCode | null;
}

/**
 * Upserts one fetched provider snapshot into a family's ledger and recomputes paid capacity.
 *
 * Ordering is by (providerUpdatedAt, fetchedAt): an older observation is ignored, so out-of-order
 * webhooks cannot regress state, and replaying an identical snapshot is a no-op. The ledger always
 * converges to the greatest observation whatever the delivery order (see tie-break below).
 *
 * Decision: a snapshot from another environment is rejected without touching the ledger, so a
 * sandbox subscription can neither add production capacity nor overwrite a production row.
 * Decision: a same-environment snapshot whose product cannot be resolved (unknown, inactive,
 * ambiguous) is still recorded — with `paidSlots: 0` and `mappingError` — so that its status change
 * (e.g. a refund) takes effect and the family fails closed instead of keeping stale capacity.
 */
export function reconcileEntitlements(
  records: readonly EntitlementRecord[],
  snapshot: ProviderSubscriptionSnapshot,
  mappings: readonly StoreProductMapping[],
  runtimeEnvironment: BillingEnvironment,
  now: Date,
  maxSlots: number = DEFAULT_MAX_PAID_SLOTS,
): ReconcileResult {
  assertValidSnapshot(snapshot);
  assertValidInstant(now, 'now');
  assertUniqueKeys(records);

  const unchanged = (
    outcome: ReconcileOutcome,
    mappingError: ResolvePaidSlotsErrorCode | null,
  ) => ({
    records,
    capacity: computeFamilyCapacity(records, runtimeEnvironment, now),
    changed: false,
    outcome,
    mappingError,
  });

  if (snapshot.environment !== runtimeEnvironment) {
    return unchanged('rejected_environment', 'ENVIRONMENT_MISMATCH');
  }

  const candidate = toRecord(snapshot, mappings, runtimeEnvironment, maxSlots);
  const index = records.findIndex(
    (r) =>
      r.channel === candidate.channel &&
      r.providerSubscriptionId === candidate.providerSubscriptionId,
  );
  const existing = index === -1 ? undefined : records[index];

  let outcome: ReconcileOutcome;
  if (existing === undefined) {
    outcome = 'inserted';
  } else {
    const recency = compareRecency(candidate, existing);
    const sameMaterial = materialKey(candidate) === materialKey(existing);
    if (recency < 0) {
      outcome = 'ignored_stale';
    } else if (recency === 0) {
      // Decision: two different observations with identical timestamps are resolved
      // deterministically in favour of the more restrictive one (fail closed), then by a canonical
      // content order, so the result never depends on webhook delivery order.
      outcome = sameMaterial
        ? 'ignored_duplicate'
        : prefersOnTie(candidate, existing)
          ? 'updated'
          : 'ignored_stale';
    } else {
      outcome = sameMaterial ? 'refreshed' : 'updated';
    }
  }

  if (outcome === 'ignored_stale' || outcome === 'ignored_duplicate') {
    return unchanged(outcome, candidate.mappingError);
  }

  const nextRecords =
    index === -1
      ? [...records, candidate]
      : records.map((record, i) => (i === index ? candidate : record));
  return {
    records: nextRecords,
    capacity: computeFamilyCapacity(nextRecords, runtimeEnvironment, now),
    changed: true,
    outcome,
    mappingError: candidate.mappingError,
  };
}

/**
 * Paid capacity at `now` from the ledger alone (no local booleans, no client input). Records from
 * another environment are ignored. Two or more access-granting subscriptions (e.g. Apple + Google)
 * are flagged as a conflict and never summed.
 */
export function computeFamilyCapacity(
  records: readonly EntitlementRecord[],
  runtimeEnvironment: BillingEnvironment,
  now: Date,
): FamilyCapacity {
  assertValidInstant(now, 'now');
  const granting = records
    .filter((r) => r.environment === runtimeEnvironment && grantsAccess(r.status, r.periodEnd, now))
    .sort(compareSourcePriority);
  const managing = granting[0];
  const base = {
    paidSlots: granting.reduce((max, r) => Math.max(max, r.paidSlots), 0),
    sources: granting.map(toSource),
    // Decision: any two access-granting subscriptions are flagged, including a cancelled one that
    // is still inside its paid period, so the parent always sees overlapping store charges.
    conflict: granting.length > 1 ? ('duplicate_active_subscriptions' as const) : null,
    managingChannel: managing?.channel ?? null,
  };
  if (
    managing?.pendingPaidSlots !== null &&
    managing?.pendingPaidSlots !== undefined &&
    managing.pendingEffectiveAt !== undefined
  ) {
    return {
      ...base,
      pendingChange: {
        targetSlots: managing.pendingPaidSlots,
        effectiveAt: new Date(managing.pendingEffectiveAt.getTime()),
      },
    };
  }
  return base;
}

export const SUBSCRIBER_BINDING_ERROR_CODES = [
  'INVALID_BILLING_REF',
  'SUBSCRIBER_MISMATCH',
] as const;
export type SubscriberBindingErrorCode = (typeof SUBSCRIBER_BINDING_ERROR_CODES)[number];

/**
 * A provider subscription belongs to a family only when the provider's subscriber identity (the
 * RevenueCat appUserID / Stripe customer metadata) is exactly the family's opaque billing ref, which
 * every guardian shares. Guardian user ids, client-supplied family ids and near-miss strings never
 * match, so switching accounts cannot pull another family's capacity across (AC_CONN_04).
 */
export function bindSnapshotToFamily(
  familyBillingRef: string,
  providerSubscriberRef: string,
): Result<{ readonly familyBillingRef: string }, SubscriberBindingErrorCode> {
  if (typeof familyBillingRef !== 'string' || familyBillingRef.length === 0) {
    return err('INVALID_BILLING_REF', 'Family billing reference is missing');
  }
  if (providerSubscriberRef !== familyBillingRef) {
    return err('SUBSCRIBER_MISMATCH', 'Provider subscriber is not this family billing identity');
  }
  return ok({ familyBillingRef });
}

// ---------------------------------------------------------------------------------------------

function toRecord(
  snapshot: ProviderSubscriptionSnapshot,
  mappings: readonly StoreProductMapping[],
  runtimeEnvironment: BillingEnvironment,
  maxSlots: number,
): EntitlementRecord {
  const resolved = resolvePaidSlots(snapshot, mappings, runtimeEnvironment, maxSlots);
  let pendingPaidSlots: number | null = null;
  if (snapshot.pendingProductId !== undefined) {
    const pending = resolveProductSlots(
      snapshot.channel,
      snapshot.pendingProductId,
      snapshot.environment,
      mappings,
      runtimeEnvironment,
      maxSlots,
    );
    pendingPaidSlots = pending.ok ? pending.value : null;
  }
  // Built field by field (and dates copied) so stray properties on the input never reach the ledger.
  return {
    channel: snapshot.channel,
    providerSubscriptionId: snapshot.providerSubscriptionId,
    productId: snapshot.productId,
    status: snapshot.status,
    periodStart: copy(snapshot.periodStart),
    periodEnd: copy(snapshot.periodEnd),
    autoRenew: snapshot.autoRenew,
    environment: snapshot.environment,
    providerUpdatedAt: copy(snapshot.providerUpdatedAt),
    fetchedAt: copy(snapshot.fetchedAt),
    ...(snapshot.pendingProductId === undefined
      ? {}
      : { pendingProductId: snapshot.pendingProductId }),
    ...(snapshot.pendingEffectiveAt === undefined
      ? {}
      : { pendingEffectiveAt: copy(snapshot.pendingEffectiveAt) }),
    paidSlots: resolved.ok ? resolved.value : 0,
    mappingError: resolved.ok ? null : resolved.error.code,
    pendingPaidSlots,
  };
}

function toSource(record: EntitlementRecord): CapacitySource {
  return {
    channel: record.channel,
    providerSubscriptionId: record.providerSubscriptionId,
    productId: record.productId,
    status: record.status,
    paidSlots: record.paidSlots,
    periodEnd: copy(record.periodEnd),
    autoRenew: record.autoRenew,
    mappingError: record.mappingError,
  };
}

function copy(date: Date): Date {
  return new Date(date.getTime());
}

function compareRecency(a: EntitlementRecord, b: EntitlementRecord): number {
  const updated = a.providerUpdatedAt.getTime() - b.providerUpdatedAt.getTime();
  return updated !== 0 ? updated : a.fetchedAt.getTime() - b.fetchedAt.getTime();
}

/** Canonical content of a record, excluding the observation time `fetchedAt`. */
function materialKey(r: EntitlementRecord): string {
  return JSON.stringify([
    r.channel,
    r.providerSubscriptionId,
    r.productId,
    r.status,
    r.periodStart.toISOString(),
    r.periodEnd.toISOString(),
    r.autoRenew,
    r.environment,
    r.providerUpdatedAt.toISOString(),
    r.pendingProductId ?? null,
    r.pendingEffectiveAt?.toISOString() ?? null,
    r.paidSlots,
    r.mappingError,
    r.pendingPaidSlots,
  ]);
}

/** Strict total order over differing observations with identical timestamps. */
function prefersOnTie(candidate: EntitlementRecord, existing: EntitlementRecord): boolean {
  const rank = accessRank(candidate.status) - accessRank(existing.status);
  if (rank !== 0) return rank < 0;
  const slots = candidate.paidSlots - existing.paidSlots;
  if (slots !== 0) return slots < 0;
  return materialKey(candidate) < materialKey(existing);
}

/** Managing source first: largest tier, then auto-renewing, then latest period end, then stable ids. */
function compareSourcePriority(a: EntitlementRecord, b: EntitlementRecord): number {
  if (a.paidSlots !== b.paidSlots) return b.paidSlots - a.paidSlots;
  if (a.autoRenew !== b.autoRenew) return a.autoRenew ? -1 : 1;
  const end = b.periodEnd.getTime() - a.periodEnd.getTime();
  if (end !== 0) return end;
  if (a.channel !== b.channel) return a.channel < b.channel ? -1 : 1;
  if (a.providerSubscriptionId !== b.providerSubscriptionId) {
    return a.providerSubscriptionId < b.providerSubscriptionId ? -1 : 1;
  }
  return 0;
}

function assertValidSnapshot(snapshot: ProviderSubscriptionSnapshot): void {
  if (
    typeof snapshot.providerSubscriptionId !== 'string' ||
    snapshot.providerSubscriptionId === ''
  ) {
    throw new RangeError('providerSubscriptionId must be a non-empty string');
  }
  if (typeof snapshot.productId !== 'string' || snapshot.productId === '') {
    throw new RangeError('productId must be a non-empty string');
  }
  assertValidInstant(snapshot.periodStart, 'periodStart');
  assertValidInstant(snapshot.periodEnd, 'periodEnd');
  assertValidInstant(snapshot.providerUpdatedAt, 'providerUpdatedAt');
  assertValidInstant(snapshot.fetchedAt, 'fetchedAt');
  if (snapshot.pendingEffectiveAt !== undefined) {
    assertValidInstant(snapshot.pendingEffectiveAt, 'pendingEffectiveAt');
  }
  if (snapshot.periodEnd.getTime() < snapshot.periodStart.getTime()) {
    throw new RangeError('periodEnd must not precede periodStart');
  }
}

function assertUniqueKeys(records: readonly EntitlementRecord[]): void {
  const seen = new Set<string>();
  for (const r of records) {
    const key = JSON.stringify([r.channel, r.providerSubscriptionId]);
    if (seen.has(key)) {
      throw new RangeError(`Ledger holds duplicate rows for ${r.channel} subscription`);
    }
    seen.add(key);
  }
}
