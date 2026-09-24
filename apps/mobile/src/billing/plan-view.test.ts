import { describe, expect, it } from 'vitest';
import { buildPlanView, childrenLabel, currentProductOn, type PlanViewInput } from './plan-view.ts';
import { APP_STORE_PRODUCTS, billingStatus } from './testing.ts';

const TZ = 'America/Chicago';

function view(overrides: Partial<PlanViewInput>) {
  return buildPlanView({
    status: billingStatus(),
    deviceChannel: 'app_store',
    storeAvailable: true,
    storeProducts: APP_STORE_PRODUCTS,
    timeZone: TZ,
    ...overrides,
  });
}

describe('tier list (AC_CAPACITY_01/02/11)', () => {
  it('lists 1–4 children with the approved prices and the store’s actual charge', () => {
    const plan = view({});
    expect(plan.availability).toEqual({ kind: 'ready' });
    expect(plan.tiers.map((t) => [t.label, t.approvedPriceText, t.storePriceText])).toEqual([
      ['1 child', '$39.99 per month', '$39.99 per month'],
      ['2 children', '$49.98 per month', '$49.99 per month'],
      ['3 children', '$59.97 per month', '$59.99 per month'],
      ['4 children', '$69.96 per month', '$69.99 per month'],
    ]);
    expect(plan.tiers.every((t) => t.purchasable && t.relation === 'upgrade')).toBe(true);
    expect(plan.tiers[0]!.actionLabel).toBe('Choose 1 child');
  });

  it('states a store price that differs from the approved price and never relabels it', () => {
    const two = view({}).tiers[1]!;
    expect(two.approvedCents).toBe(4998);
    expect(two.approvedPriceText).toBe('$49.98 per month');
    expect(two.storePriceText).toBe('$49.99 per month');
    expect(two.priceNotice).toBe(
      'The App Store charges $49.99 per month for this plan, which differs from PencilLift’s approved price of $49.98. You pay the store’s price shown.',
    );
    expect(two.a11yLabel).toContain('$49.99 per month from the store; approved price $49.98');
    // One child is exactly representable: no notice.
    expect(view({}).tiers[0]!.priceNotice).toBeNull();
  });

  it('explains a non-USD storefront instead of comparing currencies', () => {
    const plan = view({
      storeProducts: [
        { productId: 'pl_family_1', priceText: '€42,99', usdCents: null, currencyCode: 'EUR' },
      ],
    });
    expect(plan.tiers[0]!.storePriceText).toBe('€42,99 per month');
    expect(plan.tiers[0]!.priceNotice).toMatch(/local currency.*approved US price is \$39\.99/);
    expect(plan.tiers[1]!.purchasable).toBe(false);
    expect(plan.tiers[1]!.unavailableReason).toBe(
      'The App Store isn’t offering this plan right now.',
    );
  });

  it('a tier with no verified catalog product on this store is not purchasable', () => {
    const status = billingStatus();
    const plan = view({
      status: { ...status, products: status.products.filter((p) => p.paidSlots !== 4) },
    });
    expect(plan.tiers[3]!.purchasable).toBe(false);
    expect(plan.tiers[3]!.unavailableReason).toBe('This plan isn’t set up in the App Store yet.');
  });

  it('marks the current plan and offers smaller plans as changes, not new purchases', () => {
    const plan = view({
      status: billingStatus({
        paidSlots: 2,
        assignedSlots: 2,
        managingChannel: 'app_store',
        entitlements: [
          {
            channel: 'app_store',
            productId: 'pl_family_2',
            paidSlots: 2,
            status: 'active',
            periodEnd: '2026-10-10T17:00:00.000Z',
            autoRenew: true,
          },
        ],
      }),
    });
    expect(plan.tiers.map((t) => t.relation)).toEqual([
      'downgrade',
      'current',
      'upgrade',
      'upgrade',
    ]);
    expect(plan.tiers[1]!.purchasable).toBe(false);
    expect(plan.tiers[1]!.actionLabel).toBeNull();
    expect(plan.tiers[2]!.actionLabel).toBe('Change to 3 children');
    expect(plan.currentProductId).toBe('pl_family_2');
    expect(plan.headline).toBe('Your plan covers 2 children (approved price $49.98 per month).');
    expect(plan.managedByLine).toBe('Billed by the App Store.');
    expect(plan.canManage).toBe(true);
    expect(plan.entitlementLines.map((l) => l.text)).toEqual([
      'The App Store: 2 children · Active · renews October 10, 2026 · auto-renew on',
    ]);
  });
});

describe('honest availability states', () => {
  it('without a real store key in this build nothing is purchasable and it says so', () => {
    const plan = view({ storeAvailable: false, storeProducts: null });
    expect(plan.availability.kind).toBe('not_in_build');
    if (plan.availability.kind === 'not_in_build') {
      expect(plan.availability.message).toMatch(/isn’t available in this build/);
    }
    expect(plan.tiers.some((t) => t.purchasable)).toBe(false);
    expect(plan.tiers.every((t) => t.storePriceText === null)).toBe(true);
    // Approved prices are still shown.
    expect(plan.tiers[3]!.approvedPriceText).toBe('$69.96 per month');
    expect(plan.canRestore).toBe(false);
  });

  it('a subscription billed by another store cannot be duplicated from this device', () => {
    const plan = view({
      status: billingStatus({ paidSlots: 1, assignedSlots: 1, managingChannel: 'play_store' }),
    });
    expect(plan.availability.kind).toBe('managed_elsewhere');
    if (plan.availability.kind === 'managed_elsewhere') {
      expect(plan.availability.message).toMatch(/billed by Google Play.*avoid paying twice/);
    }
    expect(plan.tiers.some((t) => t.purchasable)).toBe(false);
    expect(plan.canManage).toBe(false);
    expect(plan.currentProductId).toBeNull();
  });

  it('a device without a store (web) and a store still loading are explicit states', () => {
    expect(view({ deviceChannel: null }).availability.kind).toBe('no_store_on_device');
    const loading = view({ storeProducts: null });
    expect(loading.availability.kind).toBe('store_loading');
    expect(loading.tiers.some((t) => t.purchasable)).toBe(false);
  });
});

describe('plan summary lines', () => {
  it('shows unused slots, conflicts, provider-confirmed and requested changes in words', () => {
    const plan = view({
      status: billingStatus({
        paidSlots: 3,
        assignedSlots: 1,
        managingChannel: 'app_store',
        conflict: 'duplicate_active_subscriptions',
        pendingChange: { targetSlots: 2, effectiveAt: '2026-10-10T17:00:00.000Z' },
        requestedChange: {
          kind: 'downgrade',
          toSlots: 2,
          status: 'scheduled',
          keepCount: 1,
          createdAt: '2026-09-20T15:00:00.000Z',
        },
      }),
    });
    expect(plan.slotsLine).toBe('3 paid child slots · 1 in use · 2 unused');
    expect(plan.unusedSlotLine).toMatch(/2 unused paid slots.*no new purchase is needed/);
    expect(plan.conflictWarning).toMatch(/more than one active subscription.*charged twice/);
    expect(plan.pendingLine).toBe(
      'The store will change your plan to 2 children on October 10, 2026. Until then, your current plan continues.',
    );
    expect(plan.requestedLine).toMatch(/2 children with 1 child staying active.*store confirms/);
  });

  it('an upgrade request is described as not yet purchased', () => {
    const plan = view({
      status: billingStatus({
        requestedChange: {
          kind: 'upgrade',
          toSlots: 2,
          status: 'pending_purchase',
          keepCount: 0,
          createdAt: '2026-09-20T15:00:00.000Z',
        },
      }),
    });
    expect(plan.headline).toMatch(/^No active subscription/);
    expect(plan.requestedLine).toMatch(/No store purchase has been confirmed yet/);
    expect(plan.unusedSlotLine).toBeNull();
  });

  it('entitlement lines spell out Ask to Buy, grace, cancellation and auto-renew', () => {
    const status = billingStatus({
      entitlements: [
        {
          channel: 'play_store',
          productId: 'pl_family_1',
          paidSlots: 1,
          status: 'pending',
          periodEnd: null,
          autoRenew: true,
        },
        {
          channel: 'app_store',
          productId: 'pl_family_2',
          paidSlots: 2,
          status: 'cancelled_active',
          periodEnd: '2026-10-10T17:00:00.000Z',
          autoRenew: false,
        },
        {
          channel: 'app_store',
          productId: 'unknown',
          paidSlots: 0,
          status: 'expired',
          periodEnd: '2026-08-10T17:00:00.000Z',
          autoRenew: false,
        },
      ],
    });
    expect(view({ status }).entitlementLines.map((l) => l.text)).toEqual([
      'Google Play: 1 child · Waiting for the store (for example Ask to Buy) — no access yet · no date from the store yet · auto-renew on',
      'The App Store: 2 children · Cancelled — access continues until the period ends · ends October 10, 2026 · auto-renew off',
      'The App Store: plan not recognized · Ended · ended August 10, 2026 · auto-renew off',
    ]);
  });

  it('current product is only a granting subscription on this device’s managing store', () => {
    const status = billingStatus({
      paidSlots: 2,
      managingChannel: 'app_store',
      entitlements: [
        {
          channel: 'app_store',
          productId: 'pl_family_1',
          paidSlots: 1,
          status: 'expired',
          periodEnd: null,
          autoRenew: false,
        },
        {
          channel: 'app_store',
          productId: 'pl_family_2',
          paidSlots: 2,
          status: 'grace_period',
          periodEnd: null,
          autoRenew: true,
        },
      ],
    });
    expect(currentProductOn(status, 'app_store')).toBe('pl_family_2');
    expect(currentProductOn(status, 'play_store')).toBeNull();
    expect(currentProductOn(status, null)).toBeNull();
    expect(childrenLabel(1)).toBe('1 child');
  });
});
