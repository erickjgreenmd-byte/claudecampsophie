import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyDowngradeIfDue,
  planDowngrade,
  type DowngradeInput,
  type ScheduledDowngrade,
} from './downgrade.ts';
import type { ChildProfileState } from './slots.ts';

const EFFECTIVE = new Date('2026-10-10T15:00:00.000Z');

function input(overrides: Partial<DowngradeInput> = {}): DowngradeInput {
  return {
    currentSlots: 3,
    targetSlots: 2,
    activeChildIds: ['child-riley', 'child-sam', 'child-avery'],
    keepChildIds: ['child-riley', 'child-avery'],
    providerEffectiveAt: EFFECTIVE,
    principal: 'parent',
    recentAdultUnlock: true,
    ...overrides,
  };
}

function errorCode(result: ReturnType<typeof planDowngrade>): string | null {
  return result.ok ? null : result.error.code;
}

function scheduled(overrides: Partial<DowngradeInput> = {}): ScheduledDowngrade {
  const result = planDowngrade(input(overrides));
  if (!result.ok) throw new Error(`expected a scheduled downgrade, got ${result.error.code}`);
  return result.value;
}

const CHILDREN: readonly ChildProfileState[] = [
  { id: 'child-riley', status: 'active' },
  { id: 'child-sam', status: 'active' },
  { id: 'child-avery', status: 'active' },
  { id: 'child-jordan', status: 'draft' },
  { id: 'child-casey', status: 'archived' },
];

describe('downgrade planning (AC_CAPACITY_08, AC_BILLING_05)', () => {
  it('is scheduled for the provider-confirmed date with the parent-selected profiles', () => {
    const plan = scheduled();
    expect(plan.effectiveAt).toEqual(EFFECTIVE);
    expect(plan.fromSlots).toBe(3);
    expect(plan.targetSlots).toBe(2);
    expect([...plan.keepChildIds].sort()).toEqual(['child-avery', 'child-riley']);
    expect(plan.deactivateChildIds).toEqual(['child-sam']);
    expect(plan.newRecurringCents).toBe(4998);
  });

  it('cannot be requested from child mode or without a recent adult step-up', () => {
    expect(errorCode(planDowngrade(input({ principal: 'child' })))).toBe('CHILD_MODE_FORBIDDEN');
    expect(errorCode(planDowngrade(input({ recentAdultUnlock: false })))).toBe('STEP_UP_REQUIRED');
  });

  it('kept profiles must be currently active profiles', () => {
    expect(errorCode(planDowngrade(input({ keepChildIds: ['child-riley', 'child-jordan'] })))).toBe(
      'KEEP_NOT_ACTIVE',
    );
  });

  it('cannot keep more profiles active than the lower tier pays for', () => {
    expect(
      errorCode(
        planDowngrade(input({ keepChildIds: ['child-riley', 'child-sam', 'child-avery'] })),
      ),
    ).toBe('TOO_MANY_KEPT');
  });

  it('duplicate ids in the keep list are not counted twice', () => {
    const plan = scheduled({ keepChildIds: ['child-riley', 'child-riley'] });
    expect(plan.keepChildIds).toEqual(['child-riley']);
    expect([...plan.deactivateChildIds].sort()).toEqual(['child-avery', 'child-sam']);
  });

  it('only a lower paid tier is a downgrade; cancellation is managed in the store', () => {
    expect(errorCode(planDowngrade(input({ targetSlots: 3 })))).toBe('NOT_A_DOWNGRADE');
    expect(errorCode(planDowngrade(input({ targetSlots: 4 })))).toBe('NOT_A_DOWNGRADE');
    expect(errorCode(planDowngrade(input({ targetSlots: 0, keepChildIds: [] })))).toBe(
      'INVALID_TARGET_SLOTS',
    );
    expect(errorCode(planDowngrade(input({ targetSlots: 1.5 })))).toBe('INVALID_TARGET_SLOTS');
  });

  it('property: a valid plan partitions the active profiles into kept and deactivated', () => {
    const everyone = ['a', 'b', 'c', 'd'];
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }),
        fc.subarray(everyone, { minLength: 1 }),
        fc.nat(),
        (currentSlots, activeChildIds, seed) => {
          const targetSlots = 1 + (seed % (currentSlots - 1));
          const keepChildIds = activeChildIds.slice(0, targetSlots);
          const plan = planDowngrade(
            input({ currentSlots, targetSlots, activeChildIds, keepChildIds }),
          );
          expect(plan.ok).toBe(true);
          if (!plan.ok) return;
          expect(plan.value.keepChildIds.length).toBeLessThanOrEqual(targetSlots);
          expect([...plan.value.keepChildIds, ...plan.value.deactivateChildIds].sort()).toEqual(
            [...activeChildIds].sort(),
          );
        },
      ),
    );
  });
});

describe('downgrade application timing and retention (AC_CAPACITY_08)', () => {
  it('before the effective date nothing changes and existing paid access is retained', () => {
    const plan = scheduled();
    const before = applyDowngradeIfDue(
      { scheduled: plan, children: CHILDREN },
      new Date(EFFECTIVE.getTime() - 1),
    );
    expect(before.applied).toBe(false);
    expect(before.children).toEqual(CHILDREN);
    expect(before.paidSlots).toBe(3);
    expect(before.deactivatedChildIds).toEqual([]);
  });

  it('at the effective date only the selected profiles stay active; others keep their history', () => {
    const plan = scheduled();
    const after = applyDowngradeIfDue({ scheduled: plan, children: CHILDREN }, EFFECTIVE);
    expect(after.applied).toBe(true);
    expect(after.paidSlots).toBe(2);
    expect(after.children).toEqual([
      { id: 'child-riley', status: 'active' },
      { id: 'child-sam', status: 'inactive_history_retained' },
      { id: 'child-avery', status: 'active' },
      { id: 'child-jordan', status: 'draft' },
      { id: 'child-casey', status: 'archived' },
    ]);
    expect(after.deactivatedChildIds).toEqual(['child-sam']);
    expect(after.retention).toEqual({
      history: 'retained',
      exports: 'retained',
      rewardRecords: 'retained',
      paidAi: 'stopped',
    });
  });

  it('a child activated after scheduling but not selected is also deactivated at the effective date', () => {
    const plan = scheduled();
    const children: ChildProfileState[] = [
      { id: 'child-riley', status: 'active' },
      { id: 'child-avery', status: 'active' },
      { id: 'child-jordan', status: 'active' },
    ];
    const after = applyDowngradeIfDue({ scheduled: plan, children }, EFFECTIVE);
    expect(after.deactivatedChildIds).toEqual(['child-jordan']);
    expect(after.children.filter((c) => c.status === 'active')).toHaveLength(2);
  });

  it('property: applying is idempotent and never deletes a profile', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60 }), (daysAfter) => {
        const plan = scheduled();
        const now = new Date(EFFECTIVE.getTime() + daysAfter * 86_400_000);
        const once = applyDowngradeIfDue({ scheduled: plan, children: CHILDREN }, now);
        const twice = applyDowngradeIfDue({ scheduled: plan, children: once.children }, now);
        expect(once.children.map((c) => c.id)).toEqual(CHILDREN.map((c) => c.id));
        expect(twice.children).toEqual(once.children);
        expect(twice.children.filter((c) => c.status === 'active').length).toBeLessThanOrEqual(
          plan.targetSlots,
        );
      }),
    );
  });
});
