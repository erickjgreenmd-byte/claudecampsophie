import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RandomSource } from '../shared/random.ts';
import {
  allowanceUsage,
  commit,
  DEFAULT_ALLOWANCE_CONFIG,
  EMPTY_ALLOWANCE_STATE,
  release,
  reserve,
  type AllowanceConfig,
  type AllowanceState,
  type ReserveRequest,
} from './index.ts';

/** Deterministic, never-repeating test RandomSource (a counter in the low bytes). */
function counterRandom(): RandomSource {
  let counter = 0;
  return (length) => {
    const bytes = new Uint8Array(length);
    let value = ++counter;
    for (let i = length - 1; i >= 0 && value > 0; i--) {
      bytes[i] = value & 0xff;
      value = Math.floor(value / 256);
    }
    return bytes;
  };
}

const PERIOD = 'sub_period_2026-10-03';
const NEXT_PERIOD = 'sub_period_2026-11-03';

function request(overrides: Partial<ReserveRequest> = {}): ReserveRequest {
  return {
    childId: 'child-riley',
    periodKey: PERIOD,
    units: 1,
    idempotencyKey: 'upload-1',
    paidSlots: 1,
    activeChildIds: ['child-riley'],
    ...overrides,
  };
}

/** Reserves and expects success; returns the new state and reservation. */
function mustReserve(state: AllowanceState, req: ReserveRequest, random: RandomSource) {
  const result = reserve(state, req, DEFAULT_ALLOWANCE_CONFIG, random);
  if (!result.ok) throw new Error(`unexpected ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function usage(state: AllowanceState, childId: string, paidSlots: number, periodKey = PERIOD) {
  return allowanceUsage(state, { childId, periodKey, paidSlots });
}

describe('P11 prototype allowance configuration', () => {
  it('defaults to 40 pages per paid child per billing period and is configurable', () => {
    expect(DEFAULT_ALLOWANCE_CONFIG.pagesPerPaidChildPerPeriod).toBe(40);
    const random = counterRandom();
    const pilot: AllowanceConfig = { ...DEFAULT_ALLOWANCE_CONFIG, pagesPerPaidChildPerPeriod: 5 };
    const five = reserve(EMPTY_ALLOWANCE_STATE, request({ units: 5 }), pilot, random);
    expect(five.ok).toBe(true);
    const six = reserve(EMPTY_ALLOWANCE_STATE, request({ units: 6 }), pilot, random);
    expect(!six.ok && six.error.code).toBe('QUOTA_EXCEEDED');
  });
});

describe('idempotent reservations (AC_CAPTURE_06)', () => {
  it('a duplicate upload/finalize event returns the same reservation and charges once', () => {
    const random = counterRandom();
    const first = mustReserve(EMPTY_ALLOWANCE_STATE, request({ units: 3 }), random);
    expect(first.changed).toBe(true);
    expect(first.reservation.status).toBe('reserved');

    const again = mustReserve(first.state, request({ units: 3 }), random);
    expect(again.changed).toBe(false);
    expect(again.reservation).toEqual(first.reservation);
    expect(again.state).toBe(first.state);
    expect(usage(again.state, 'child-riley', 1).childUsedUnits).toBe(3);
  });

  it('a duplicate event after commit still does not charge again', () => {
    const random = counterRandom();
    const first = mustReserve(EMPTY_ALLOWANCE_STATE, request({ units: 2 }), random);
    const committed = commit(first.state, first.reservation.id);
    if (!committed.ok) throw new Error('commit failed');
    const again = mustReserve(committed.value.state, request({ units: 2 }), random);
    expect(again.changed).toBe(false);
    expect(again.reservation.status).toBe('committed');
    expect(usage(again.state, 'child-riley', 1).childUsedUnits).toBe(2);
  });

  it('a duplicate event after an unreadable release does not re-charge the released scan', () => {
    const random = counterRandom();
    const first = mustReserve(EMPTY_ALLOWANCE_STATE, request({ units: 2 }), random);
    const released = release(first.state, first.reservation.id, 'unreadable');
    if (!released.ok) throw new Error('release failed');
    const again = mustReserve(released.value.state, request({ units: 2 }), random);
    expect(again.changed).toBe(false);
    expect(again.reservation.status).toBe('released');
    expect(usage(again.state, 'child-riley', 1).childUsedUnits).toBe(0);
  });

  it('refuses to reuse an idempotency key for a different child, period or page count', () => {
    const random = counterRandom();
    const both = ['child-riley', 'child-sam'];
    const first = mustReserve(
      EMPTY_ALLOWANCE_STATE,
      request({ paidSlots: 2, activeChildIds: both }),
      random,
    );
    for (const conflicting of [
      request({ paidSlots: 2, activeChildIds: both, childId: 'child-sam' }),
      request({ paidSlots: 2, activeChildIds: both, periodKey: NEXT_PERIOD }),
      request({ paidSlots: 2, activeChildIds: both, units: 2 }),
    ]) {
      const result = reserve(first.state, conflicting, DEFAULT_ALLOWANCE_CONFIG, random);
      expect(!result.ok && result.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    }
  });

  it('property: replaying any successful reserve leaves the ledger exactly as one reserve did', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 1, max: 5 }),
        (units, replays) => {
          const random = counterRandom();
          const once = mustReserve(EMPTY_ALLOWANCE_STATE, request({ units }), random);
          let state = once.state;
          for (let i = 0; i < replays; i++)
            state = mustReserve(state, request({ units }), random).state;
          return state === once.state && usage(state, 'child-riley', 1).childUsedUnits === units;
        },
      ),
    );
  });
});

describe('entitlement is required (P11: a local boolean never unlocks paid service)', () => {
  it('rejects a child who is not assigned to a paid slot', () => {
    const result = reserve(
      EMPTY_ALLOWANCE_STATE,
      request({ childId: 'child-sam', activeChildIds: ['child-riley'] }),
      DEFAULT_ALLOWANCE_CONFIG,
      counterRandom(),
    );
    expect(!result.ok && result.error.code).toBe('CHILD_NOT_ENTITLED');
  });

  it('rejects every child when the family has zero paid slots', () => {
    const result = reserve(
      EMPTY_ALLOWANCE_STATE,
      request({ paidSlots: 0 }),
      DEFAULT_ALLOWANCE_CONFIG,
      counterRandom(),
    );
    expect(!result.ok && result.error.code).toBe('CHILD_NOT_ENTITLED');
  });

  it.each([-1, 1.5, Number.NaN, 5])('rejects an impossible paid slot count %d', (paidSlots) => {
    const result = reserve(
      EMPTY_ALLOWANCE_STATE,
      request({ paidSlots }),
      DEFAULT_ALLOWANCE_CONFIG,
      counterRandom(),
    );
    expect(!result.ok && result.error.code).toBe('INVALID_PAID_SLOTS');
  });

  it.each([
    { units: 0 },
    { units: -3 },
    { units: 1.5 },
    { units: Number.NaN },
    { childId: '' },
    { periodKey: '' },
    { idempotencyKey: '' },
  ])('rejects a malformed request %j', (overrides) => {
    const result = reserve(
      EMPTY_ALLOWANCE_STATE,
      request(overrides),
      DEFAULT_ALLOWANCE_CONFIG,
      counterRandom(),
    );
    expect(!result.ok && result.error.code).toBe('INVALID_REQUEST');
  });
});

describe('per-child allowance and in-flight reservations (AC_SECURITY_06)', () => {
  it('allows exactly the allowance and rejects one page more', () => {
    const random = counterRandom();
    const full = mustReserve(EMPTY_ALLOWANCE_STATE, request({ units: 40 }), random);
    const over = reserve(
      full.state,
      request({ idempotencyKey: 'upload-2' }),
      DEFAULT_ALLOWANCE_CONFIG,
      random,
    );
    expect(!over.ok && over.error.code).toBe('QUOTA_EXCEEDED');
    expect(!over.ok && over.error.details?.['scope']).toBe('child');
  });

  it('a second concurrent reservation fails while the first is still in flight', () => {
    const random = counterRandom();
    const used = mustReserve(EMPTY_ALLOWANCE_STATE, request({ units: 30 }), random);
    const committed = commit(used.state, used.reservation.id);
    if (!committed.ok) throw new Error('commit failed');

    // Two uploads race: each alone would fit (30 + 8 <= 40), together they would not.
    const first = mustReserve(
      committed.value.state,
      request({ idempotencyKey: 'upload-a', units: 8 }),
      random,
    );
    const second = reserve(
      first.state,
      request({ idempotencyKey: 'upload-b', units: 8 }),
      DEFAULT_ALLOWANCE_CONFIG,
      random,
    );
    expect(!second.ok && second.error.code).toBe('QUOTA_EXCEEDED');

    // Once the first in-flight reservation fails for good, the second may proceed.
    const freed = release(first.state, first.reservation.id, 'failed_final');
    if (!freed.ok) throw new Error('release failed');
    const retried = reserve(
      freed.value.state,
      request({ idempotencyKey: 'upload-b', units: 8 }),
      DEFAULT_ALLOWANCE_CONFIG,
      random,
    );
    expect(retried.ok).toBe(true);
  });

  it('a new billing period starts from zero without erasing the prior period', () => {
    const random = counterRandom();
    const full = mustReserve(EMPTY_ALLOWANCE_STATE, request({ units: 40 }), random);
    const next = mustReserve(
      full.state,
      request({ idempotencyKey: 'upload-2', periodKey: NEXT_PERIOD, units: 40 }),
      random,
    );
    expect(usage(next.state, 'child-riley', 1, PERIOD).childUsedUnits).toBe(40);
    expect(usage(next.state, 'child-riley', 1, NEXT_PERIOD).childUsedUnits).toBe(40);
  });
});

describe('unreadable scans do not permanently consume allowance (P11, AC_CAPTURE_06)', () => {
  it('releasing an unreadable scan frees its pages for a new upload', () => {
    const random = counterRandom();
    const full = mustReserve(EMPTY_ALLOWANCE_STATE, request({ units: 40 }), random);
    const released = release(full.state, full.reservation.id, 'unreadable');
    if (!released.ok) throw new Error('release failed');
    expect(released.value.reservation).toMatchObject({
      status: 'released',
      releaseReason: 'unreadable',
    });
    expect(usage(released.value.state, 'child-riley', 1).childUsedUnits).toBe(0);

    const rescan = reserve(
      released.value.state,
      request({ idempotencyKey: 'upload-rescan', units: 40 }),
      DEFAULT_ALLOWANCE_CONFIG,
      random,
    );
    expect(rescan.ok).toBe(true);
  });
});

describe('reassignment and upgrades cannot reset usage or farm allowance (AC_CAPACITY_09)', () => {
  it('reassigning the only paid slot to another child does not grant a fresh allowance', () => {
    const random = counterRandom();
    const riley = mustReserve(EMPTY_ALLOWANCE_STATE, request({ units: 40 }), random);
    const committed = commit(riley.state, riley.reservation.id);
    if (!committed.ok) throw new Error('commit failed');

    // Riley is archived and the single paid slot is reassigned to Sam in the same period.
    const sam = reserve(
      committed.value.state,
      request({ childId: 'child-sam', activeChildIds: ['child-sam'], idempotencyKey: 'sam-1' }),
      DEFAULT_ALLOWANCE_CONFIG,
      random,
    );
    expect(!sam.ok && sam.error.code).toBe('QUOTA_EXCEEDED');
    expect(!sam.ok && sam.error.details?.['scope']).toBe('family');
    // Riley's history is preserved rather than reset, and Sam is shown nothing available.
    expect(usage(committed.value.state, 'child-riley', 1).childUsedUnits).toBe(40);
    expect(usage(committed.value.state, 'child-sam', 1)).toMatchObject({
      childRemainingUnits: 40,
      familyRemainingUnits: 0,
      availableUnits: 0,
    });

    // At the next provider billing period Sam has the slot's normal allowance.
    const nextPeriod = reserve(
      committed.value.state,
      request({
        childId: 'child-sam',
        activeChildIds: ['child-sam'],
        idempotencyKey: 'sam-2',
        periodKey: NEXT_PERIOD,
        units: 40,
      }),
      DEFAULT_ALLOWANCE_CONFIG,
      random,
    );
    expect(nextPeriod.ok).toBe(true);
  });

  it('upgrading mid-period adds the new slot but does not reset the existing child', () => {
    const random = counterRandom();
    const riley = mustReserve(EMPTY_ALLOWANCE_STATE, request({ units: 40 }), random);
    const both = ['child-riley', 'child-sam'];

    const rileyMore = reserve(
      riley.state,
      request({ paidSlots: 2, activeChildIds: both, idempotencyKey: 'riley-2' }),
      DEFAULT_ALLOWANCE_CONFIG,
      random,
    );
    expect(!rileyMore.ok && rileyMore.error.code).toBe('QUOTA_EXCEEDED');

    const sam = mustReserve(
      riley.state,
      request({
        childId: 'child-sam',
        paidSlots: 2,
        activeChildIds: both,
        idempotencyKey: 'sam-1',
        units: 40,
      }),
      random,
    );
    const samMore = reserve(
      sam.state,
      request({
        childId: 'child-sam',
        paidSlots: 2,
        activeChildIds: both,
        idempotencyKey: 'sam-2',
      }),
      DEFAULT_ALLOWANCE_CONFIG,
      random,
    );
    expect(!samMore.ok && samMore.error.code).toBe('QUOTA_EXCEEDED');
  });

  it('an unused paid slot is not spendable by another child (per-child cap still applies)', () => {
    const random = counterRandom();
    const riley = reserve(
      EMPTY_ALLOWANCE_STATE,
      request({ paidSlots: 2, units: 41 }),
      DEFAULT_ALLOWANCE_CONFIG,
      random,
    );
    expect(!riley.ok && riley.error.code).toBe('QUOTA_EXCEEDED');
    const report = usage(EMPTY_ALLOWANCE_STATE, 'child-riley', 2);
    expect(report).toEqual({
      childUsedUnits: 0,
      childAllowanceUnits: 40,
      childRemainingUnits: 40,
      familyUsedUnits: 0,
      familyCeilingUnits: 80,
      familyRemainingUnits: 80,
      availableUnits: 40,
    });
  });

  it('a mid-period downgrade keeps recorded usage and blocks new reservations beyond the new ceiling', () => {
    const random = counterRandom();
    const both = ['child-riley', 'child-sam'];
    const riley = mustReserve(
      EMPTY_ALLOWANCE_STATE,
      request({ paidSlots: 2, activeChildIds: both, units: 30 }),
      random,
    );
    const sam = mustReserve(
      riley.state,
      request({
        childId: 'child-sam',
        paidSlots: 2,
        activeChildIds: both,
        idempotencyKey: 'sam-1',
        units: 30,
      }),
      random,
    );
    const after = reserve(
      sam.state,
      request({ paidSlots: 1, activeChildIds: ['child-riley'], idempotencyKey: 'riley-2' }),
      DEFAULT_ALLOWANCE_CONFIG,
      random,
    );
    expect(!after.ok && after.error.code).toBe('QUOTA_EXCEEDED');
    const report = usage(sam.state, 'child-riley', 1);
    expect(report.familyUsedUnits).toBe(60);
    expect(report.familyRemainingUnits).toBe(0);
  });

  it('property: no operation sequence lets child or family usage exceed the verified ceilings', () => {
    const children = ['child-riley', 'child-sam', 'child-avery', 'child-jordan', 'child-kai'];
    const op = fc.oneof(
      fc.record({
        kind: fc.constant('reserve' as const),
        child: fc.integer({ min: 0, max: children.length - 1 }),
        units: fc.integer({ min: 1, max: 45 }),
        key: fc.integer({ min: 0, max: 30 }),
        active: fc.subarray(children, { minLength: 1 }),
      }),
      fc.record({ kind: fc.constant('commit' as const), pick: fc.nat() }),
      fc.record({
        kind: fc.constant('release' as const),
        pick: fc.nat(),
        reason: fc.constantFrom(
          'unreadable' as const,
          'cancelled' as const,
          'failed_final' as const,
        ),
      }),
    );
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), fc.array(op, { maxLength: 60 }), (slots, ops) => {
        const random = counterRandom();
        let state = EMPTY_ALLOWANCE_STATE;
        for (const o of ops) {
          if (o.kind === 'reserve') {
            const result = reserve(
              state,
              request({
                childId: children[o.child]!,
                units: o.units,
                idempotencyKey: `key-${o.key}`,
                paidSlots: slots,
                activeChildIds: o.active,
              }),
              DEFAULT_ALLOWANCE_CONFIG,
              random,
            );
            if (result.ok) state = result.value.state;
          } else if (state.reservations.length > 0) {
            const target = state.reservations[o.pick % state.reservations.length]!;
            const result =
              o.kind === 'commit' ? commit(state, target.id) : release(state, target.id, o.reason);
            if (result.ok) state = result.value.state;
          }
          const family = usage(state, children[0]!, slots);
          if (family.familyUsedUnits > slots * 40) return false;
          for (const child of children) {
            if (usage(state, child, slots).childUsedUnits > 40) return false;
          }
        }
        return true;
      }),
    );
  });
});

describe('commit and release are idempotent terminal transitions', () => {
  function reserved() {
    const random = counterRandom();
    return mustReserve(EMPTY_ALLOWANCE_STATE, request({ units: 4 }), random);
  }

  it('repeating commit is a no-op that returns the same state', () => {
    const r = reserved();
    const once = commit(r.state, r.reservation.id);
    if (!once.ok) throw new Error('commit failed');
    expect(once.value.changed).toBe(true);
    const twice = commit(once.value.state, r.reservation.id);
    expect(twice.ok && twice.value.changed).toBe(false);
    expect(twice.ok && twice.value.state).toBe(once.value.state);
  });

  it('repeating the same release is a no-op', () => {
    const r = reserved();
    const once = release(r.state, r.reservation.id, 'unreadable');
    if (!once.ok) throw new Error('release failed');
    const twice = release(once.value.state, r.reservation.id, 'unreadable');
    expect(twice.ok && twice.value.changed).toBe(false);
    expect(twice.ok && twice.value.state).toBe(once.value.state);
  });

  it('commit after release, release after commit and a different release reason all conflict', () => {
    const r = reserved();
    const released = release(r.state, r.reservation.id, 'cancelled');
    const committed = commit(r.state, r.reservation.id);
    if (!released.ok || !committed.ok) throw new Error('setup failed');

    const commitAfterRelease = commit(released.value.state, r.reservation.id);
    expect(!commitAfterRelease.ok && commitAfterRelease.error.code).toBe('INVALID_TRANSITION');
    const releaseAfterCommit = release(committed.value.state, r.reservation.id, 'unreadable');
    expect(!releaseAfterCommit.ok && releaseAfterCommit.error.code).toBe('INVALID_TRANSITION');
    const otherReason = release(released.value.state, r.reservation.id, 'unreadable');
    expect(!otherReason.ok && otherReason.error.code).toBe('INVALID_TRANSITION');
  });

  it('reports an unknown reservation id', () => {
    const r = reserved();
    const result = commit(r.state, 'no-such-reservation');
    expect(!result.ok && result.error.code).toBe('RESERVATION_NOT_FOUND');
    const released = release(r.state, 'no-such-reservation', 'unreadable');
    expect(!released.ok && released.error.code).toBe('RESERVATION_NOT_FOUND');
  });

  it('never mutates the state it was given', () => {
    const random = counterRandom();
    const r = mustReserve(EMPTY_ALLOWANCE_STATE, request({ units: 4 }), random);
    const snapshot = structuredClone(r.state);
    commit(r.state, r.reservation.id);
    release(r.state, r.reservation.id, 'unreadable');
    reserve(r.state, request({ idempotencyKey: 'upload-2' }), DEFAULT_ALLOWANCE_CONFIG, random);
    expect(r.state).toEqual(snapshot);
  });

  it('issues UUID v4 reservation ids from the injected RandomSource', () => {
    const r = reserved();
    expect(r.reservation.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
