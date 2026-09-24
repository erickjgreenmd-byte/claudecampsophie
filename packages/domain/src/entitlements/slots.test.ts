import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_PAID_SLOTS, monthlyPriceCents } from '../pricing/index.ts';
import {
  CLIENT_PURCHASE_RESULTS,
  childHasPaidAi,
  describeProfileRemoval,
  evaluateClientPurchaseResult,
  planChildActivation,
  type ChildActivationInput,
  type ChildProfileStatus,
} from './slots.ts';

const parent = { principal: 'parent', recentAdultUnlock: true } as const;

function activation(overrides: Partial<ChildActivationInput> = {}): ChildActivationInput {
  return {
    paidSlots: 2,
    activeChildIds: ['child-riley'],
    child: { id: 'child-sam', status: 'draft' },
    ...parent,
    ...overrides,
  };
}

function errorCode(result: ReturnType<typeof planChildActivation>): string | null {
  return result.ok ? null : result.error.code;
}

describe('child activation and paid slots (AC_CAPACITY_03, AC_CAPACITY_04, AC_BILLING_05)', () => {
  it('an unused paid slot is assigned without buying again', () => {
    const result = planChildActivation(activation());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.action).toBe('assign_existing_slot');
      expect(result.value).not.toHaveProperty('newRecurringCents');
    }
  });

  it('purchases and activations cannot be initiated from child mode, even with an unlock', () => {
    expect(errorCode(planChildActivation(activation({ principal: 'child' })))).toBe(
      'CHILD_MODE_FORBIDDEN',
    );
    expect(errorCode(planChildActivation(activation({ principal: 'child', paidSlots: 1 })))).toBe(
      'CHILD_MODE_FORBIDDEN',
    );
  });

  it('adding a child requires a recent adult step-up, even into an unused slot', () => {
    expect(errorCode(planChildActivation(activation({ recentAdultUnlock: false })))).toBe(
      'STEP_UP_REQUIRED',
    );
  });

  it('when every paid slot is used, the parent must buy the next tier through the store', () => {
    const result = planChildActivation(
      activation({ paidSlots: 2, activeChildIds: ['child-riley', 'child-avery'] }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        action: 'purchase_required',
        childId: 'child-sam',
        targetSlots: 3,
        currentRecurringCents: 4998,
        newRecurringCents: 5997,
        dueNow: 'provider_supplied',
        activation: 'after_server_verified_purchase',
      },
    });
  });

  it('with no subscription the first purchase has no current recurring charge', () => {
    const result = planChildActivation(activation({ paidSlots: 0, activeChildIds: [] }));
    expect(result.ok && result.value).toMatchObject({
      action: 'purchase_required',
      targetSlots: 1,
      currentRecurringCents: 0,
      newRecurringCents: 3999,
    });
  });

  it('after a lapse, repurchase covers every still-active child plus the new one', () => {
    const result = planChildActivation(
      activation({ paidSlots: 0, activeChildIds: ['child-riley', 'child-avery'] }),
    );
    expect(result.ok && result.value).toMatchObject({
      action: 'purchase_required',
      targetSlots: 3,
      currentRecurringCents: 0,
      newRecurringCents: 5997,
    });
  });

  it('the max tier cannot be exceeded, and a lapsed family is not offered a tier that cannot fit', () => {
    const full = ['child-riley', 'child-sam-2', 'child-avery', 'child-jordan'];
    expect(
      errorCode(
        planChildActivation(
          activation({
            paidSlots: 4,
            activeChildIds: full,
            child: { id: 'child-casey', status: 'draft' },
          }),
        ),
      ),
    ).toBe('MAX_TIER_REACHED');
    expect(
      errorCode(
        planChildActivation(
          activation({
            paidSlots: 0,
            activeChildIds: full,
            child: { id: 'child-casey', status: 'draft' },
          }),
        ),
      ),
    ).toBe('MAX_TIER_REACHED');
  });

  it('archived and downgrade-inactive profiles are reactivated through the same slot rule', () => {
    for (const status of ['archived', 'inactive_history_retained'] as const) {
      const result = planChildActivation(activation({ child: { id: 'child-sam', status } }));
      expect(result.ok && result.value.action).toBe('assign_existing_slot');
    }
  });

  it('an already-active child cannot take a second slot', () => {
    expect(
      errorCode(planChildActivation(activation({ child: { id: 'child-sam', status: 'active' } }))),
    ).toBe('ALREADY_ACTIVE');
    expect(
      errorCode(
        planChildActivation(
          activation({
            activeChildIds: ['child-sam'],
            child: { id: 'child-sam', status: 'draft' },
          }),
        ),
      ),
    ).toBe('ALREADY_ACTIVE');
  });

  it('a tombstoned or unrecognised profile can never be activated', () => {
    for (const status of ['tombstoned', 'suspended'] as ChildProfileStatus[]) {
      expect(
        errorCode(planChildActivation(activation({ child: { id: 'child-sam', status } }))),
      ).toBe('CHILD_NOT_DRAFT');
    }
  });

  it('property: activation never over-assigns slots and quotes only approved list prices', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: DEFAULT_MAX_PAID_SLOTS }),
        fc.integer({ min: 0, max: DEFAULT_MAX_PAID_SLOTS }),
        (paidSlots, activeCount) => {
          const activeChildIds = Array.from({ length: activeCount }, (_, i) => `child-${i}`);
          const result = planChildActivation(
            activation({ paidSlots, activeChildIds, child: { id: 'child-new', status: 'draft' } }),
          );
          if (!result.ok) {
            expect(result.error.code).toBe('MAX_TIER_REACHED');
            expect(Math.max(paidSlots, activeCount) + 1).toBeGreaterThan(DEFAULT_MAX_PAID_SLOTS);
            return;
          }
          const plan = result.value;
          if (plan.action === 'assign_existing_slot') {
            expect(activeCount + 1).toBeLessThanOrEqual(paidSlots);
            return;
          }
          expect(plan.targetSlots).toBeGreaterThan(paidSlots);
          expect(plan.targetSlots).toBeGreaterThanOrEqual(activeCount + 1);
          expect(plan.targetSlots).toBeLessThanOrEqual(DEFAULT_MAX_PAID_SLOTS);
          expect(plan.newRecurringCents).toBe(monthlyPriceCents(plan.targetSlots));
          expect(plan.currentRecurringCents).toBe(
            paidSlots === 0 ? 0 : monthlyPriceCents(paidSlots),
          );
        },
      ),
    );
  });
});

describe('client purchase results never grant capacity (AC_BILLING_02, AC_CAPACITY_04)', () => {
  it('success waits for server verification', () => {
    expect(evaluateClientPurchaseResult('success')).toEqual({
      grantsCapacity: false,
      next: 'await_server_verification',
    });
  });

  it('pending and Ask to Buy show an honest pending state', () => {
    expect(evaluateClientPurchaseResult('pending').next).toBe('show_pending');
    expect(evaluateClientPurchaseResult('ask_to_buy_pending').next).toBe('show_pending');
  });

  it('cancelled and failed purchases change nothing', () => {
    expect(evaluateClientPurchaseResult('cancelled').next).toBe('no_change');
    expect(evaluateClientPurchaseResult('failed').next).toBe('no_change');
  });

  it('no client-reported outcome, known or forged, ever grants capacity', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom(...CLIENT_PURCHASE_RESULTS), fc.string()),
        (reported) => {
          const outcome = evaluateClientPurchaseResult(
            reported as (typeof CLIENT_PURCHASE_RESULTS)[number],
          );
          expect(outcome.grantsCapacity).toBe(false);
        },
      ),
    );
    expect(evaluateClientPurchaseResult('granted' as 'success').next).toBe('no_change');
  });
});

describe('profile removal makes no billing claims (AC_CAPACITY_09)', () => {
  it('removing or archiving a profile never claims cancellation or a lower renewal', () => {
    expect(describeProfileRemoval()).toMatchObject({
      changesSubscription: false,
      renewalChange: 'none',
    });
  });

  it('property: with any paid capacity the renewal charge shown stays the current tier price', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: DEFAULT_MAX_PAID_SLOTS }), (paidSlots) => {
        const description = describeProfileRemoval({ paidSlots, managingChannel: 'play_store' });
        expect(description.changesSubscription).toBe(false);
        expect(description.renewalChange).toBe('none');
        expect(description.paidSlotsAfterRemoval).toBe(paidSlots);
        expect(description.recurringCentsAfterRemoval).toBe(
          paidSlots === 0 ? 0 : monthlyPriceCents(paidSlots),
        );
      }),
    );
  });
});

describe('paid AI per child (AC_CAPACITY_07)', () => {
  const capacity = { paidSlots: 2 };

  it('an active child assigned to a paid slot has paid AI', () => {
    expect(
      childHasPaidAi({
        childStatus: 'active',
        capacity,
        assignedChildIds: ['child-riley', 'child-sam'],
        childId: 'child-sam',
      }),
    ).toBe(true);
  });

  it('draft, archived and downgrade-inactive profiles have no paid AI', () => {
    for (const childStatus of ['draft', 'archived', 'inactive_history_retained'] as const) {
      expect(
        childHasPaidAi({
          childStatus,
          capacity,
          assignedChildIds: ['child-sam'],
          childId: 'child-sam',
        }),
      ).toBe(false);
    }
  });

  it('an unassigned active child has no paid AI', () => {
    expect(
      childHasPaidAi({
        childStatus: 'active',
        capacity,
        assignedChildIds: ['child-riley'],
        childId: 'child-sam',
      }),
    ).toBe(false);
  });

  it('without paid capacity no child has paid AI', () => {
    expect(
      childHasPaidAi({
        childStatus: 'active',
        capacity: { paidSlots: 0 },
        assignedChildIds: ['child-sam'],
        childId: 'child-sam',
      }),
    ).toBe(false);
  });

  it('base access (one slot) never grants all four profiles paid AI', () => {
    const four = ['child-riley', 'child-sam', 'child-avery', 'child-jordan'];
    const withAi = four.filter((childId) =>
      childHasPaidAi({
        childStatus: 'active',
        capacity: { paidSlots: 1 },
        assignedChildIds: four,
        childId,
      }),
    );
    expect(withAi).toEqual(['child-riley']);
  });

  it('property: the number of children with paid AI never exceeds paid slots', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: DEFAULT_MAX_PAID_SLOTS }),
        fc.array(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'), { maxLength: 10 }),
        (paidSlots, assignedChildIds) => {
          const everyone = ['a', 'b', 'c', 'd', 'e', 'f'];
          const withAi = everyone.filter((childId) =>
            childHasPaidAi({
              childStatus: 'active',
              capacity: { paidSlots },
              assignedChildIds,
              childId,
            }),
          );
          expect(withAi.length).toBeLessThanOrEqual(paidSlots);
          for (const childId of withAi) expect(assignedChildIds).toContain(childId);
        },
      ),
    );
  });
});
