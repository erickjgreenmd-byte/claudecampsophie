// Independent adversarial review of the entitlements module (spec P11, E2 last two paragraphs, E4;
// AC_CAPACITY_03..10, AC_BILLING_02..05, AC_CONN_04, AC_CONN_05).
// Tests named [RV-entitlements-<n>] are regressions for confirmed defects and fail until fixed.
// Tests under "review probes" pin risky behavior that was checked and found sound.
// Synthetic family/child identifiers only.
import { describe, expect, it } from 'vitest';
import {
  applyDowngradeIfDue,
  bindSnapshotToFamily,
  childHasPaidAi,
  computeFamilyCapacity,
  evaluateClientPurchaseResult,
  grantsAccess,
  planChildActivation,
  planDowngrade,
  reconcileEntitlements,
  resolvePaidSlots,
  type ClientPurchaseResult,
  type EntitlementRecord,
  type ProviderSubscriptionSnapshot,
  type ReconcileResult,
} from './index.ts';
import {
  MAPPINGS,
  NOW,
  PERIOD_END,
  UPDATED_AT,
  minutesAfter,
  productFor,
  snapshot,
} from './test-fixtures.ts';

const MINUTE = 60_000;
const DAY = 86_400_000;
const at = (base: Date, ms: number): Date => new Date(base.getTime() + ms);

function reconcile(
  records: readonly EntitlementRecord[],
  snap: ProviderSubscriptionSnapshot,
  now: Date = NOW,
): ReconcileResult {
  return reconcileEntitlements(records, snap, MAPPINGS, 'production', now);
}

describe('review regressions (entitlements)', () => {
  it('[RV-entitlements-1] a future-dated providerUpdatedAt cannot shadow a later refund', () => {
    // providerUpdatedAt is documented as the provider's own last-modified instant; it can never be
    // later than the moment our server fetched the state. The API's RevenueCat mapper derives it as
    // max(purchase, refund, grace_period_expires_date, billing issue, unsubscribe), so while a
    // subscription is in grace it is the FUTURE grace expiry. reconcileEntitlements accepts that
    // unvalidated, and every genuine later observation (recovery, cancellation, refund, expiry) with
    // a providerUpdatedAt before the grace expiry is then discarded as 'ignored_stale'.
    // P11/AC_BILLING_03/AC_CAPACITY_10: refund and revocation must remove paid capacity;
    // AC_BILLING_04: out-of-order handling must converge to the CURRENT provider state.
    const firstFetch = at(PERIOD_END, 60 * MINUTE);
    const graceExpiry = at(PERIOD_END, 16 * DAY);
    const grace = snapshot({
      status: 'grace_period',
      providerUpdatedAt: graceExpiry, // later than fetchedAt: impossible for a last-modified time
      fetchedAt: firstFetch,
    });
    let records: readonly EntitlementRecord[] = [];
    try {
      records = reconcile([], grace, firstFetch).records;
    } catch (error) {
      // Rejecting the impossible observation outright is an acceptable fix.
      expect(error).toBeInstanceOf(RangeError);
    }

    const refundedAt = at(PERIOD_END, 3 * DAY);
    const refund = snapshot({
      status: 'refunded',
      providerUpdatedAt: refundedAt,
      fetchedAt: at(refundedAt, MINUTE),
    });
    const after = reconcile(records, refund, at(refundedAt, 2 * MINUTE));

    expect(
      after.records.find((r) => r.providerSubscriptionId === refund.providerSubscriptionId)?.status,
    ).toBe('refunded');
    expect(after.capacity.paidSlots).toBe(0);
  });

  it('[RV-entitlements-2] active/grace access is not granted forever from a stale ledger row', () => {
    // grantsAccess never bounds 'active' or 'grace_period' by time, and computeFamilyCapacity has no
    // staleness check (fetchedAt is ignored). If the EXPIRATION/renewal webhook is lost, a row that
    // was last verified a year ago, for a period that ended a year ago, still grants the full tier.
    // No store grace / billing-retry window lasts a year, so this is an unverified local state
    // unlocking paid service. P11: "A local boolean never unlocks paid service"; AC_BILLING_03
    // (expiry produces the correct access state); AC_CAPACITY_10 (expiration reconciles paid
    // capacity); E4: show an honest pending state when entitlement verification is unavailable.
    const yearAfterPeriodEnd = at(PERIOD_END, 365 * DAY);
    for (const status of ['active', 'grace_period'] as const) {
      const verifiedOnce = reconcile([], snapshot({ status }), NOW);
      expect(verifiedOnce.capacity.paidSlots).toBe(2);
      const capacity = computeFamilyCapacity(
        verifiedOnce.records,
        'production',
        yearAfterPeriodEnd,
      );
      expect({ status, paidSlots: capacity.paidSlots }).toEqual({ status, paidSlots: 0 });
    }
  });

  it('[RV-entitlements-3] a provider-scheduled change to an unresolvable product is still shown', () => {
    // P11: "Always show and reconcile the actual paid slot count, assigned profiles, pending changes
    // and managing store." When the provider schedules a change (Apple downgrade at renewal, Google
    // deferred replacement) to a product that is unmapped/inactive, pendingPaidSlots becomes null and
    // computeFamilyCapacity silently omits pendingChange, although at the effective date the family
    // will drop to zero paid slots. The parent is never told a capacity change is pending.
    const result = reconcile(
      [],
      snapshot({
        pendingProductId: 'com.pencillift.capacity.retired_basic',
        pendingEffectiveAt: PERIOD_END,
      }),
    );
    expect(result.capacity.paidSlots).toBe(2);
    expect(result.capacity.pendingChange).toBeDefined();
    expect(result.capacity.pendingChange?.effectiveAt).toEqual(PERIOD_END);
    // The pending product grants nothing, so the pending tier must not be presented as capacity.
    expect(result.capacity.pendingChange?.targetSlots ?? 0).toBe(0);
  });

  it('[RV-entitlements-4] a sandbox observation cannot overwrite a production ledger row', () => {
    // The ledger key is (channel, providerSubscriptionId) without environment, while
    // computeFamilyCapacity explicitly supports ledgers holding both environments. The API derives
    // providerSubscriptionId as rc:<billingRef>:<channel>:<productId> and Apple reuses product ids
    // in sandbox, so sandbox and production rows of one family share a key. Reconciling a sandbox
    // refund under the sandbox runtime replaces the production row and wipes production capacity,
    // contradicting the module's own decision ("a sandbox subscription can neither add production
    // capacity nor overwrite a production row") and AC_CONN_05 (sandbox/production isolation,
    // access invariants preserved).
    const production = reconcile([], snapshot());
    expect(production.capacity.paidSlots).toBe(2);
    let records: readonly EntitlementRecord[] = production.records;
    try {
      records = reconcileEntitlements(
        production.records,
        snapshot({
          environment: 'sandbox',
          status: 'refunded',
          providerUpdatedAt: minutesAfter(UPDATED_AT, 10),
          fetchedAt: minutesAfter(UPDATED_AT, 11),
        }),
        MAPPINGS,
        'sandbox',
        NOW,
      ).records;
    } catch (error) {
      // Refusing a cross-environment key collision is an acceptable fix.
      expect(error).toBeInstanceOf(RangeError);
    }
    expect(records.filter((r) => r.environment === 'production')).toEqual(production.records);
    expect(computeFamilyCapacity(records, 'production', NOW).paidSlots).toBe(2);
  });
});

describe('review probes (entitlements, verified sound)', () => {
  it('cancelled_active lapses exactly at the period end instant', () => {
    expect(grantsAccess('cancelled_active', PERIOD_END, at(PERIOD_END, -1))).toBe(true);
    expect(grantsAccess('cancelled_active', PERIOD_END, PERIOD_END)).toBe(false);
  });

  it('identical-timestamp conflicting observations converge to the more restrictive one in either order', () => {
    const active = snapshot({ status: 'active' });
    const refunded = snapshot({ status: 'refunded' });
    const ab = reconcile(reconcile([], active).records, refunded);
    const ba = reconcile(reconcile([], refunded).records, active);
    expect(ab.records).toEqual(ba.records);
    expect(ab.capacity.paidSlots).toBe(0);
  });

  it('two guardians on two platforms never sum capacity, even at the max tier', () => {
    const apple = reconcile([], snapshot({ productId: productFor('app_store', 4) }));
    const both = reconcile(
      apple.records,
      snapshot({
        channel: 'play_store',
        providerSubscriptionId: 'GPA.0000-guardian-two',
        productId: productFor('play_store', 4),
      }),
    );
    expect(both.capacity.paidSlots).toBe(4);
    expect(both.capacity.conflict).toBe('duplicate_active_subscriptions');
  });

  it('a product id is matched exactly (no case folding or unicode look-alikes)', () => {
    const cyrillicC = 'сom.pencillift.capacity.4'; // first letter is U+0441
    for (const productId of [
      productFor('app_store', 4).toUpperCase(),
      cyrillicC,
      ` ${productFor('app_store', 4)}`,
    ]) {
      const result = resolvePaidSlots(snapshot({ productId }), MAPPINGS, 'production');
      expect(result.ok).toBe(false);
    }
  });

  it('family binding is exact: a look-alike or normalised subscriber ref never binds', () => {
    const familyRef = 'fam_0a1b2c3d4e5f6071';
    expect(bindSnapshotToFamily(familyRef, familyRef.normalize('NFKC')).ok).toBe(true);
    expect(bindSnapshotToFamily(familyRef, 'fam_0a1b2c3d4e5f6071​').ok).toBe(false);
    expect(bindSnapshotToFamily(familyRef, undefined as unknown as string).ok).toBe(false);
  });

  it('a truthy but non-boolean adult unlock is not accepted as a step-up', () => {
    const result = planChildActivation({
      paidSlots: 2,
      activeChildIds: [],
      child: { id: 'child-sam', status: 'draft' },
      principal: 'parent',
      recentAdultUnlock: 'yes' as unknown as boolean,
    });
    expect(result.ok ? null : result.error.code).toBe('STEP_UP_REQUIRED');
  });

  it('prototype-named forged client purchase results grant nothing', () => {
    for (const forged of ['constructor', '__proto__', 'toString']) {
      expect(evaluateClientPurchaseResult(forged as ClientPurchaseResult)).toEqual({
        grantsCapacity: false,
        next: 'no_change',
      });
    }
  });

  it('duplicate assignment rows do not let a second child in on a one-slot plan', () => {
    const check = (childId: string) =>
      childHasPaidAi({
        childStatus: 'active',
        capacity: { paidSlots: 1 },
        assignedChildIds: ['child-riley', 'child-riley', 'child-sam'],
        childId,
      });
    expect(check('child-riley')).toBe(true);
    expect(check('child-sam')).toBe(false);
  });

  it('a downgrade applies at, not before, the provider date and never deletes a profile', () => {
    const plan = planDowngrade({
      currentSlots: 2,
      targetSlots: 1,
      activeChildIds: ['child-riley', 'child-sam'],
      keepChildIds: ['child-sam'],
      providerEffectiveAt: PERIOD_END,
      principal: 'parent',
      recentAdultUnlock: true,
    });
    if (!plan.ok) throw new Error(plan.error.code);
    const children = [
      { id: 'child-riley', status: 'active' as const },
      { id: 'child-sam', status: 'active' as const },
    ];
    expect(
      applyDowngradeIfDue({ scheduled: plan.value, children }, at(PERIOD_END, -1)).applied,
    ).toBe(false);
    const applied = applyDowngradeIfDue({ scheduled: plan.value, children }, PERIOD_END);
    expect(applied.children).toEqual([
      { id: 'child-riley', status: 'inactive_history_retained' },
      { id: 'child-sam', status: 'active' },
    ]);
  });
});
