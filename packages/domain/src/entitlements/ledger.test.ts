import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_PAID_SLOTS } from '../pricing/index.ts';
import type { BillingChannel } from '../shared/billing.ts';
import {
  bindSnapshotToFamily,
  computeFamilyCapacity,
  reconcileEntitlements,
  type EntitlementRecord,
  type ReconcileResult,
} from './ledger.ts';
import type { ProviderSubscriptionSnapshot } from './products.ts';
import { ENTITLEMENT_STATUSES } from './status.ts';
import {
  CHANNELS,
  MAPPINGS,
  NOW,
  PERIOD_END,
  UPDATED_AT,
  minutesAfter,
  productFor,
  snapshot,
} from './test-fixtures.ts';

function reconcile(
  records: readonly EntitlementRecord[],
  snap: ProviderSubscriptionSnapshot,
  now: Date = NOW,
): ReconcileResult {
  return reconcileEntitlements(records, snap, MAPPINGS, 'production', now);
}

function applyAll(
  snaps: readonly ProviderSubscriptionSnapshot[],
  now: Date = NOW,
): ReconcileResult {
  let records: readonly EntitlementRecord[] = [];
  let last: ReconcileResult | null = null;
  for (const snap of snaps) {
    last = reconcile(records, snap, now);
    records = last.records;
  }
  if (last === null) throw new Error('applyAll needs at least one snapshot');
  return last;
}

const later = (minutes: number): Date => minutesAfter(UPDATED_AT, minutes);

describe('normalized entitlement ledger (AC_BILLING_04, AC_CONN_05)', () => {
  it('a verified purchase inserts one record and grants exactly the mapped capacity', () => {
    const result = reconcile([], snapshot());
    expect(result.changed).toBe(true);
    expect(result.outcome).toBe('inserted');
    expect(result.records).toHaveLength(1);
    expect(result.capacity.paidSlots).toBe(2);
    expect(result.capacity.managingChannel).toBe('app_store');
    expect(result.capacity.conflict).toBeNull();
  });

  it('with no access-granting record the family has zero paid slots', () => {
    const capacity = computeFamilyCapacity([], 'production', NOW);
    expect(capacity).toEqual({
      paidSlots: 0,
      sources: [],
      conflict: null,
      managingChannel: null,
    });
  });

  it('a duplicate webhook delivery (identical snapshot) is a no-op', () => {
    const first = reconcile([], snapshot());
    const replay = reconcile(first.records, snapshot());
    expect(replay.changed).toBe(false);
    expect(replay.outcome).toBe('ignored_duplicate');
    expect(replay.records).toEqual(first.records);
    expect(replay.capacity).toEqual(first.capacity);
  });

  it('an out-of-order older snapshot cannot resurrect a refunded subscription', () => {
    const refunded = reconcile([], snapshot({ status: 'refunded', providerUpdatedAt: later(60) }));
    const stale = reconcile(refunded.records, snapshot({ status: 'active' }));
    expect(stale.changed).toBe(false);
    expect(stale.outcome).toBe('ignored_stale');
    expect(stale.capacity.paidSlots).toBe(0);
    expect(stale.records[0]?.status).toBe('refunded');
  });

  it('an out-of-order older snapshot cannot undo a verified upgrade', () => {
    const upgraded = reconcile(
      [],
      snapshot({ productId: productFor('app_store', 3), providerUpdatedAt: later(30) }),
    );
    const stale = reconcile(upgraded.records, snapshot({ productId: productFor('app_store', 2) }));
    expect(stale.changed).toBe(false);
    expect(stale.capacity.paidSlots).toBe(3);
  });

  it('property: any delivery order of the same provider snapshots converges to the newest state', () => {
    const snapArb = fc
      .record({
        status: fc.constantFrom(...ENTITLEMENT_STATUSES),
        tier: fc.integer({ min: 1, max: 4 }),
        updatedOffset: fc.integer({ min: 0, max: 4 }),
        fetchDelay: fc.integer({ min: 0, max: 2 }),
        autoRenew: fc.boolean(),
      })
      .map(({ status, tier, updatedOffset, fetchDelay, autoRenew }) =>
        snapshot({
          status,
          autoRenew,
          productId: productFor('app_store', tier),
          providerUpdatedAt: later(updatedOffset),
          fetchedAt: later(updatedOffset + fetchDelay),
        }),
      );
    fc.assert(
      fc.property(
        fc
          .array(snapArb, { minLength: 1, maxLength: 8 })
          .chain((list) =>
            fc.tuple(
              fc.constant(list),
              fc.shuffledSubarray(list, { minLength: list.length, maxLength: list.length }),
            ),
          ),
        ([inOrder, shuffled]) => {
          const a = applyAll(inOrder);
          const b = applyAll(shuffled);
          expect(b.records).toEqual(a.records);
          expect(b.capacity).toEqual(a.capacity);
          const newest = Math.max(...inOrder.map((s) => s.providerUpdatedAt.getTime()));
          expect(a.records[0]?.providerUpdatedAt.getTime()).toBe(newest);
        },
      ),
    );
  });

  it('property: replaying any already-delivered snapshot never changes the ledger', () => {
    const snapArb = fc
      .record({
        status: fc.constantFrom(...ENTITLEMENT_STATUSES),
        tier: fc.integer({ min: 1, max: 4 }),
        updatedOffset: fc.integer({ min: 0, max: 4 }),
      })
      .map(({ status, tier, updatedOffset }) =>
        snapshot({
          status,
          productId: productFor('app_store', tier),
          providerUpdatedAt: later(updatedOffset),
          fetchedAt: later(updatedOffset + 1),
        }),
      );
    fc.assert(
      fc.property(fc.array(snapArb, { minLength: 1, maxLength: 6 }), fc.nat(), (list, pick) => {
        const settled = applyAll(list);
        const replayed = list[pick % list.length];
        if (replayed === undefined) throw new Error('unreachable');
        const again = reconcile(settled.records, replayed);
        expect(again.changed).toBe(false);
        expect(again.records).toEqual(settled.records);
      }),
    );
  });

  it('re-fetching unchanged provider state later refreshes verification time only', () => {
    const first = reconcile([], snapshot());
    const refetch = reconcile(first.records, snapshot({ fetchedAt: later(90) }));
    expect(refetch.outcome).toBe('refreshed');
    expect(refetch.capacity).toEqual(first.capacity);
    expect(refetch.records[0]?.fetchedAt).toEqual(later(90));
  });
});

describe('access state transitions reconcile paid capacity (AC_BILLING_03, AC_CAPACITY_10)', () => {
  const active = reconcile([], snapshot());

  it('refund removes paid capacity immediately, inside the paid period', () => {
    const refunded = reconcile(
      active.records,
      snapshot({ status: 'refunded', providerUpdatedAt: later(10) }),
    );
    expect(refunded.capacity.paidSlots).toBe(0);
    expect(refunded.capacity.managingChannel).toBeNull();
  });

  it('revocation (e.g. Family Sharing / chargeback) removes paid capacity immediately', () => {
    const revoked = reconcile(
      active.records,
      snapshot({ status: 'revoked', providerUpdatedAt: later(10) }),
    );
    expect(revoked.capacity.paidSlots).toBe(0);
  });

  it('grace period retains paid capacity after a failed renewal', () => {
    const grace = reconcile(
      active.records,
      snapshot({ status: 'grace_period', providerUpdatedAt: later(10) }),
      new Date(PERIOD_END.getTime() + 86_400_000),
    );
    expect(grace.capacity.paidSlots).toBe(2);
  });

  it('billing retry without grace removes paid capacity', () => {
    const retry = reconcile(
      active.records,
      snapshot({ status: 'billing_retry', providerUpdatedAt: later(10) }),
    );
    expect(retry.capacity.paidSlots).toBe(0);
  });

  it('cancellation keeps capacity until the paid period ends, then it lapses without a new event', () => {
    const cancelled = reconcile(
      active.records,
      snapshot({ status: 'cancelled_active', autoRenew: false, providerUpdatedAt: later(10) }),
    );
    expect(cancelled.capacity.paidSlots).toBe(2);
    expect(computeFamilyCapacity(cancelled.records, 'production', PERIOD_END).paidSlots).toBe(0);
  });

  it('expiry removes paid capacity; a later verified renewal restores it', () => {
    const expired = reconcile(
      active.records,
      snapshot({ status: 'expired', providerUpdatedAt: later(10) }),
    );
    expect(expired.capacity.paidSlots).toBe(0);
    const renewed = reconcile(
      expired.records,
      snapshot({ status: 'active', providerUpdatedAt: later(20) }),
    );
    expect(renewed.capacity.paidSlots).toBe(2);
  });

  it('a verified upgrade on the same subscription yields exactly the purchased tier (AC_CAPACITY_05)', () => {
    const upgraded = reconcile(
      active.records,
      snapshot({ productId: productFor('app_store', 3), providerUpdatedAt: later(10) }),
    );
    expect(upgraded.records).toHaveLength(1);
    expect(upgraded.capacity.paidSlots).toBe(3);
  });

  it('a newer snapshot for an unmapped product fails closed instead of keeping old capacity', () => {
    const unknown = reconcile(
      active.records,
      snapshot({ productId: 'com.pencillift.capacity.mystery', providerUpdatedAt: later(10) }),
    );
    expect(unknown.changed).toBe(true);
    expect(unknown.capacity.paidSlots).toBe(0);
    expect(unknown.records[0]?.mappingError).toBe('UNKNOWN_PRODUCT');
  });
});

describe('pending and Ask to Buy never grant (AC_BILLING_02, AC_CAPACITY_04)', () => {
  it('a pending/Ask to Buy provider state grants nothing until the provider approves it', () => {
    const pending = reconcile([], snapshot({ status: 'pending' }));
    expect(pending.capacity.paidSlots).toBe(0);
    expect(pending.capacity.sources).toEqual([]);
    const approved = reconcile(
      pending.records,
      snapshot({ status: 'active', providerUpdatedAt: later(45) }),
    );
    expect(approved.capacity.paidSlots).toBe(2);
  });

  it('a pending upgrade does not raise capacity before the provider confirms it', () => {
    const current = reconcile(
      [],
      snapshot({
        productId: productFor('app_store', 2),
        pendingProductId: productFor('app_store', 3),
        pendingEffectiveAt: PERIOD_END,
      }),
    );
    expect(current.capacity.paidSlots).toBe(2);
    expect(current.capacity.pendingChange).toEqual({ targetSlots: 3, effectiveAt: PERIOD_END });
  });
});

describe('one family billing identity across guardians and platforms (AC_CONN_04, AC_CAPACITY_05)', () => {
  it('a second guardian restoring the same subscription on another device cannot double slots', () => {
    const guardianOne = reconcile([], snapshot());
    const guardianTwoRestore = reconcile(guardianOne.records, snapshot({ fetchedAt: later(300) }));
    expect(guardianTwoRestore.records).toHaveLength(1);
    expect(guardianTwoRestore.capacity.paidSlots).toBe(2);
    expect(guardianTwoRestore.capacity.conflict).toBeNull();
  });

  it('concurrent upgrades by two guardians resolve to the single provider tier, never a sum', () => {
    const base = reconcile([], snapshot());
    const upgradeA = snapshot({
      productId: productFor('app_store', 3),
      providerUpdatedAt: later(5),
    });
    const upgradeB = snapshot({
      productId: productFor('app_store', 3),
      providerUpdatedAt: later(5),
    });
    const afterA = reconcile(base.records, upgradeA);
    const afterB = reconcile(afterA.records, upgradeB);
    expect(afterB.changed).toBe(false);
    expect(afterB.capacity.paidSlots).toBe(3);
  });

  it('Apple + Google subscriptions are not summed; the conflict is flagged for the parent', () => {
    const apple = reconcile([], snapshot());
    const both = reconcile(
      apple.records,
      snapshot({
        channel: 'play_store',
        providerSubscriptionId: 'GPA.0000-riley-family',
        productId: productFor('play_store', 3),
      }),
    );
    expect(both.records).toHaveLength(2);
    expect(both.capacity.paidSlots).toBe(3);
    expect(both.capacity.conflict).toBe('duplicate_active_subscriptions');
    expect(both.capacity.managingChannel).toBe('play_store');
    expect(both.capacity.sources.map((s) => s.channel)).toEqual(['play_store', 'app_store']);
  });

  it('property: capacity is the largest single access-granting tier and never exceeds the max tier', () => {
    const subArb = fc.record({
      channel: fc.constantFrom<BillingChannel>(...CHANNELS),
      subscriptionNo: fc.integer({ min: 1, max: 3 }),
      tier: fc.integer({ min: 1, max: 4 }),
      status: fc.constantFrom(...ENTITLEMENT_STATUSES),
    });
    fc.assert(
      fc.property(fc.array(subArb, { minLength: 1, maxLength: 8 }), (subs) => {
        const snaps = subs.map((s, i) =>
          snapshot({
            channel: s.channel,
            providerSubscriptionId: `${s.channel}-sub-${s.subscriptionNo}`,
            productId: productFor(s.channel, s.tier),
            status: s.status,
            providerUpdatedAt: later(i),
            fetchedAt: later(i),
          }),
        );
        const { records, capacity } = applyAll(snaps);
        const grantingTiers = records
          .filter((r) => ['active', 'grace_period', 'cancelled_active'].includes(r.status))
          .map((r) => r.paidSlots);
        expect(capacity.paidSlots).toBeLessThanOrEqual(DEFAULT_MAX_PAID_SLOTS);
        expect(capacity.paidSlots).toBe(
          grantingTiers.length === 0 ? 0 : Math.max(...grantingTiers),
        );
        expect(capacity.conflict === null).toBe(grantingTiers.length < 2);
      }),
    );
  });

  it('the provider subscriber must be the family billing identity shared by all guardians', () => {
    const familyRef = 'fam_0a1b2c3d4e5f60718293a4b5';
    expect(bindSnapshotToFamily(familyRef, familyRef).ok).toBe(true);
    const foreign = bindSnapshotToFamily(familyRef, 'fam_ffffffffffffffffffffffff');
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe('SUBSCRIBER_MISMATCH');
    // A guardian's personal user id is never the subscriber identity.
    const personal = bindSnapshotToFamily(familyRef, '7c9e6679-7425-40de-944b-e07fc1f90ae7');
    expect(personal.ok).toBe(false);
    // Near-miss identifiers are not normalised into a match.
    expect(bindSnapshotToFamily(familyRef, ` ${familyRef}`).ok).toBe(false);
    expect(bindSnapshotToFamily(familyRef, familyRef.toUpperCase()).ok).toBe(false);
    const empty = bindSnapshotToFamily('', '');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('INVALID_BILLING_REF');
  });
});

describe('sandbox and production are isolated (AC_CONN_05)', () => {
  it('a sandbox purchase never touches the production ledger or capacity', () => {
    const production = reconcile([], snapshot());
    const sandbox = reconcile(
      production.records,
      snapshot({
        environment: 'sandbox',
        providerSubscriptionId: 'sub_sandbox_tester',
        productId: productFor('app_store', 4),
        providerUpdatedAt: later(10),
      }),
    );
    expect(sandbox.changed).toBe(false);
    expect(sandbox.outcome).toBe('rejected_environment');
    expect(sandbox.records).toEqual(production.records);
    expect(sandbox.capacity.paidSlots).toBe(2);
  });

  it('a sandbox snapshot cannot overwrite a production record that shares its key', () => {
    const production = reconcile([], snapshot());
    const sandbox = reconcile(
      production.records,
      snapshot({ environment: 'sandbox', status: 'refunded', providerUpdatedAt: later(10) }),
    );
    expect(sandbox.records).toEqual(production.records);
    expect(sandbox.capacity.paidSlots).toBe(2);
  });

  it('records from another environment are ignored when computing capacity', () => {
    const inSandbox = reconcileEntitlements(
      [],
      snapshot({ environment: 'sandbox' }),
      MAPPINGS,
      'sandbox',
      NOW,
    );
    expect(inSandbox.capacity.paidSlots).toBe(2);
    expect(computeFamilyCapacity(inSandbox.records, 'production', NOW).paidSlots).toBe(0);
  });
});
