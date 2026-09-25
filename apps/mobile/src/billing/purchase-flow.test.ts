import { describe, expect, it } from 'vitest';
import type { BillingStatus } from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import { buildPlanView, type PlanView } from './plan-view.ts';
import {
  runPlanChange,
  runRestore,
  transition,
  verify,
  type PurchaseContext,
  type PurchaseState,
} from './purchase-flow.ts';
import type { StoreChannel } from './store.ts';
import {
  APP_STORE_PRODUCTS,
  APPROVED_PRICE_PRODUCTS,
  BILLING_REF,
  billingStatus,
  fakeApi,
  fakeStore,
  RILEY,
  SAM,
  type Call,
} from './testing.ts';

const PARENT: PurchaseContext = { mode: 'parent', parentSignedIn: true };
const CHILD_MODE: PurchaseContext = { mode: 'child', parentSignedIn: true };
const SIGNED_OUT: PurchaseContext = { mode: 'signed_out', parentSignedIn: false };

const ACTIVE_TWO = {
  channel: 'app_store' as const,
  productId: 'pl_family_2',
  paidSlots: 2,
  status: 'active' as const,
  periodEnd: '2026-10-10T17:00:00.000Z',
  autoRenew: true,
};

/**
 * The flow mechanics are tested against a catalog priced at the approved totals; a store price that
 * isn't approved is blocked before this flow can start (see the price tests below).
 */
function planFor(status: BillingStatus, channel: StoreChannel = 'app_store'): PlanView {
  return buildPlanView({
    status,
    deviceChannel: channel,
    storeAvailable: true,
    storeProducts: APPROVED_PRICE_PRODUCTS,
    timeZone: 'UTC',
  });
}

function select(
  status: BillingStatus,
  targetSlots: number,
  context: PurchaseContext = PARENT,
  channel: StoreChannel = 'app_store',
): PurchaseState {
  const plan = planFor(status, channel);
  const tier = plan.tiers.find((t) => t.paidSlots === targetSlots)!;
  return transition({ kind: 'idle' }, { type: 'select', tier, plan, status, channel, context });
}

const changeResponse = (call: Call) => {
  const body = call.body as { kind: 'upgrade' | 'downgrade'; toSlots: number };
  return {
    id: '9c4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b',
    kind: body.kind,
    fromSlots: 0,
    toSlots: body.toSlots,
    keepChildIds: [],
    status: body.kind === 'upgrade' ? 'pending_purchase' : 'scheduled',
    currentRecurringCents: 0,
    newRecurringCents: 4998,
    nextStep: body.kind === 'upgrade' ? 'purchase_in_store' : 'change_in_store',
    createdAt: '2026-09-24T15:00:00.000Z',
  };
};

/** Server double: capacity-change is accepted; sync returns `afterSync` (the verified state). */
function server(afterSync: BillingStatus | Error, log: string[] = []) {
  return fakeApi((call) => {
    if (call.path === '/v1/billing/capacity-changes') return changeResponse(call);
    if (call.path === '/v1/billing/sync') return afterSync;
    return new Error(`unexpected ${call.method} ${call.path}`);
  }, log);
}

describe('who may buy (spec P3, AC_BILLING_05, AC_CAPACITY_04)', () => {
  it('child mode is blocked before anything opens', () => {
    const state = select(billingStatus(), 2, CHILD_MODE);
    expect(state).toMatchObject({ kind: 'blocked', reason: 'child_mode' });
    if (state.kind === 'blocked') expect(state.message).toMatch(/child mode.*grown-up/);
  });

  it('a signed-out parent is blocked', () => {
    expect(select(billingStatus(), 2, SIGNED_OUT)).toMatchObject({
      kind: 'blocked',
      reason: 'signed_out',
    });
  });

  it('switching to child mode while confirming blocks the purchase: no API or store call', async () => {
    const confirming = select(billingStatus(), 2);
    expect(confirming.kind).toBe('confirming');
    const log: string[] = [];
    const { api, calls } = server(billingStatus(), log);
    const store = fakeStore({}, log);
    const final = await runPlanChange({ api, store, context: () => CHILD_MODE }, confirming);
    expect(final).toMatchObject({ kind: 'blocked', reason: 'child_mode' });
    expect(calls).toEqual([]);
    expect(store.purchases).toEqual([]);
  });

  it('a plan without a store product, or a build without store keys, cannot be selected', () => {
    const status = billingStatus();
    const plan = buildPlanView({
      status,
      deviceChannel: 'app_store',
      storeAvailable: false,
      storeProducts: null,
    });
    const blocked = transition(
      { kind: 'idle' },
      {
        type: 'select',
        tier: plan.tiers[1]!,
        plan,
        status,
        channel: 'app_store',
        context: PARENT,
      },
    );
    expect(blocked).toMatchObject({ kind: 'blocked', reason: 'not_in_build' });
  });
});

describe('confirmation shows what the parent is agreeing to (AC_CAPACITY_06)', () => {
  it('child count, the store’s recurring total and store confirmation', () => {
    const state = select(billingStatus({ paidSlots: 1, assignedSlots: 1 }), 2);
    expect(state.kind).toBe('confirming');
    if (state.kind !== 'confirming') return;
    const c = state.confirmation;
    expect(c).toMatchObject({
      direction: 'upgrade',
      currentSlots: 1,
      targetSlots: 2,
      productId: 'pl_family_2',
      billingRef: BILLING_REF,
      heading: 'Change your plan to 2 children',
      childCountLine: 'Your plan will cover 2 children (it covers 1 child today).',
      recurringLine: 'New monthly total: $49.98 per month, as charged by the App Store.',
      storeConfirmationLine:
        'You’ll confirm in the App Store. Nothing is charged unless you confirm there.',
    });
    expect(c.priceNotice).toBeNull();
    expect(c.dueNowLine).toMatch(/shows what you’ll pay today, including any proration/);
    expect(c.activationLine).toMatch(/only after the store confirms payment.*Ask to Buy/);
    // Never promises a fixed immediate charge such as a full $9.99 add-on today.
    const text = Object.values(c).join(' ');
    expect(text).not.toMatch(/\$9\.99/);
    expect(text).not.toMatch(/charged (today|now|immediately)/i);
  });

  it('states the subscription title, monthly length, renewal and charge terms per store (APL-17)', () => {
    const cases: readonly [StoreChannel, string, string][] = [
      ['app_store', 'the App Store', 'Apple Account'],
      ['play_store', 'Google Play', 'Google Play account'],
      ['amazon_appstore', 'the Amazon Appstore', 'Amazon account'],
    ];
    for (const [channel, storeName, account] of cases) {
      const base = billingStatus();
      // The fixture catalog covers the App Store and Google Play; add the Amazon Appstore's entry.
      const status = billingStatus({
        products: [
          ...base.products,
          ...base.tiers.map((t) => ({
            channel: 'amazon_appstore' as const,
            productId: `pl_family_${t.paidSlots}`,
            paidSlots: t.paidSlots,
            storePriceCents: null,
            priceCheck: 'not_verified' as const,
          })),
        ],
      });
      const state = select(status, 2, PARENT, channel);
      expect(state.kind).toBe('confirming');
      if (state.kind !== 'confirming') return;
      const c = state.confirmation;
      expect(c.titleLine).toBe('Subscription: PencilLift family plan, 2 children.');
      expect(c.periodLine).toBe('Length: 1 month, billed monthly.');
      expect(c.recurringLine).toContain('$49.98 per month');
      expect(c.renewalLine).toBe(
        `It renews automatically every month at $49.98 per month until you cancel. To stop the next charge, cancel in ${storeName} at least 24 hours before the current month ends.`,
      );
      expect(c.chargeLine).toBe(
        `Payment is charged to your ${account} when you confirm the purchase in ${storeName}.`,
      );
      expect(c.legalLine).toBe(
        'By continuing you agree to the PencilLift Terms of use and Privacy policy (links below).',
      );
      // Approved prices are never restated as a different number.
      expect(Object.values(c).join(' ')).not.toMatch(/\$9\.99|\$49\.99/);
    }
  });

  it('a plan whose store price isn’t the approved price can’t be selected (AC_CAPACITY_02)', () => {
    const status = billingStatus({ paidSlots: 1, assignedSlots: 1 });
    const plan = buildPlanView({
      status,
      deviceChannel: 'app_store',
      storeAvailable: true,
      storeProducts: APP_STORE_PRODUCTS,
      timeZone: 'UTC',
    });
    const state = transition(
      { kind: 'idle' },
      {
        type: 'select',
        tier: plan.tiers[1]!,
        plan,
        status,
        channel: 'app_store',
        context: PARENT,
      },
    );
    expect(state).toMatchObject({ kind: 'blocked', reason: 'tier_unavailable' });
    if (state.kind === 'blocked') {
      expect(state.message).toMatch(
        /charges \$49\.99 per month for 2 children.*approved price is \$49\.98/,
      );
    }
  });

  it('a subscription the store is still retrying blocks a second one (RV-billing-5)', () => {
    const status = billingStatus({
      entitlements: [{ ...ACTIVE_TWO, channel: 'play_store', status: 'billing_retry' }],
    });
    expect(select(status, 2, PARENT, 'play_store')).toMatchObject({
      kind: 'blocked',
      reason: 'store_action_needed',
    });
  });
});

describe('purchase outcomes (AC_BILLING_02, AC_CAPACITY_04/05)', () => {
  it('records intent (step-up) → binds the store → store sheet → server sync, in that order', async () => {
    const log: string[] = [];
    const { api, calls } = server(
      billingStatus({ paidSlots: 2, assignedSlots: 0, managingChannel: 'app_store' }),
      log,
    );
    const store = fakeStore({}, log);
    const seen: string[] = [];
    const final = await runPlanChange(
      { api, store, context: () => PARENT, onState: (s) => seen.push(s.kind) },
      select(billingStatus(), 2),
    );
    expect(log).toEqual([
      'api POST /v1/billing/capacity-changes',
      `store identify ${BILLING_REF}`,
      'store purchase pl_family_2',
      'api POST /v1/billing/sync',
    ]);
    // The server also checks this store's verified price before the store opens.
    expect(calls[0]!.body).toEqual({ kind: 'upgrade', toSlots: 2, channel: 'app_store' });
    expect(calls[1]!.body).toBeUndefined();
    expect(store.purchases).toEqual([{ productId: 'pl_family_2', replacing: null }]);
    expect(seen).toEqual(['purchasing', 'verifying']);
    expect(final).toMatchObject({ kind: 'success', paidSlots: 2 });
    if (final.kind === 'success') {
      expect(final.message).toMatch(/Confirmed by the store: your plan now covers 2 children/);
      expect(final.message).toMatch(/Assign the unused slots/);
    }
  });

  it('a store “success” the server hasn’t verified yet is not shown as done', async () => {
    const { api } = server(billingStatus());
    const final = await runPlanChange(
      { api, store: fakeStore(), context: () => PARENT },
      select(billingStatus(), 2),
    );
    expect(final.kind).toBe('verifying');
    // "Check again" once the webhook/provider state has landed.
    const later = fakeApi(() => billingStatus({ paidSlots: 2, managingChannel: 'app_store' }));
    const after = await verify(
      { api: later.api, store: fakeStore(), context: () => PARENT },
      final,
    );
    expect(after).toMatchObject({ kind: 'success', paidSlots: 2 });
  });

  it('Ask to Buy / payment pending grants nothing, even after a sync', async () => {
    const log: string[] = [];
    const { api } = server(billingStatus(), log);
    const final = await runPlanChange(
      { api, store: fakeStore({ outcome: { kind: 'pending' } }, log), context: () => PARENT },
      select(billingStatus(), 2),
    );
    expect(final.kind).toBe('pending');
    if (final.kind === 'pending') expect(final.message).toMatch(/No child slot is added/);
    expect(log).toContain('api POST /v1/billing/sync');
    // Only when the provider later reports the completed purchase does it become success.
    const done = transition(final, {
      type: 'verified',
      status: billingStatus({ paidSlots: 2 }),
    });
    expect(done).toMatchObject({ kind: 'success', paidSlots: 2 });
  });

  it('a cancelled purchase changes nothing and does not sync', async () => {
    const log: string[] = [];
    const { api } = server(billingStatus(), log);
    const final = await runPlanChange(
      { api, store: fakeStore({ outcome: { kind: 'cancelled' } }, log), context: () => PARENT },
      select(billingStatus(), 2),
    );
    expect(final).toMatchObject({ kind: 'cancelled' });
    expect(log).not.toContain('api POST /v1/billing/sync');
  });

  it('a failed purchase grants nothing unless the provider shows it actually completed', async () => {
    const failed = { kind: 'failed' as const, message: 'Store error' };
    const nothing = await runPlanChange(
      {
        api: server(billingStatus()).api,
        store: fakeStore({ outcome: failed }),
        context: () => PARENT,
      },
      select(billingStatus(), 2),
    );
    expect(nothing).toMatchObject({ kind: 'failed', message: 'Store error', needsPin: false });
    const completed = await runPlanChange(
      {
        api: server(billingStatus({ paidSlots: 2 })).api,
        store: fakeStore({ outcome: failed }),
        context: () => PARENT,
      },
      select(billingStatus(), 2),
    );
    expect(completed).toMatchObject({ kind: 'success', paidSlots: 2 });
  });

  it('without a fresh parent PIN the server refuses and the store never opens', async () => {
    const log: string[] = [];
    const { api } = fakeApi(
      () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403),
      log,
    );
    const store = fakeStore({}, log);
    const final = await runPlanChange(
      { api, store, context: () => PARENT },
      select(billingStatus(), 2),
    );
    expect(final).toMatchObject({ kind: 'failed', needsPin: true });
    expect(store.purchases).toEqual([]);
    expect(store.identified).toEqual([]);
    expect(log).toEqual(['api POST /v1/billing/capacity-changes']);
  });

  it('a sync failure after a store success keeps waiting instead of claiming success', async () => {
    const final = await runPlanChange(
      {
        api: server(new ApiRequestError('NETWORK', 'offline', 0)).api,
        store: fakeStore(),
        context: () => PARENT,
      },
      select(billingStatus(), 2),
    );
    expect(final.kind).toBe('verifying');
    if (final.kind === 'verifying') expect(final.message).toMatch(/Nothing changes until/);
  });

  it('Google Play upgrades replace the current subscription instead of adding a second one', async () => {
    const status = billingStatus({
      paidSlots: 2,
      assignedSlots: 2,
      managingChannel: 'play_store',
      entitlements: [{ ...ACTIVE_TWO, channel: 'play_store' }],
    });
    const store = fakeStore({ channel: 'play_store' });
    await runPlanChange(
      { api: server(billingStatus({ paidSlots: 3 })).api, store, context: () => PARENT },
      select(status, 3, PARENT, 'play_store'),
    );
    expect(store.purchases).toEqual([
      { productId: 'pl_family_3', replacing: { productId: 'pl_family_2', direction: 'upgrade' } },
    ]);
  });
});

describe('smaller plans (AC_CAPACITY_08/09)', () => {
  const current = billingStatus({
    paidSlots: 2,
    assignedSlots: 2,
    managingChannel: 'app_store',
    entitlements: [ACTIVE_TWO],
  });

  it('asks which children stay active before anything is sent', async () => {
    const confirming = select(current, 1);
    expect(confirming.kind).toBe('confirming');
    if (confirming.kind !== 'confirming') return;
    expect(confirming.confirmation.needsKeepSelection).toBe(true);
    expect(confirming.confirmation.dueNowLine).toMatch(/usually your next renewal.*keeps access/);
    const log: string[] = [];
    const { api } = server(current, log);
    const final = await runPlanChange(
      { api, store: fakeStore({}, log), context: () => PARENT },
      confirming,
    );
    expect(final).toMatchObject({ kind: 'failed' });
    expect(log).toEqual([]);
  });

  it('records the kept children, changes in the store, and shows the store-confirmed date', async () => {
    const log: string[] = [];
    const scheduled = billingStatus({
      ...current,
      pendingChange: { targetSlots: 1, effectiveAt: '2026-10-10T17:00:00.000Z' },
    });
    const { api, calls } = server(scheduled, log);
    const store = fakeStore({}, log);
    const final = await runPlanChange(
      { api, store, context: () => PARENT, timeZone: 'UTC' },
      select(current, 1),
      [RILEY],
    );
    expect(calls[0]!.body).toEqual({
      kind: 'downgrade',
      toSlots: 1,
      keepChildIds: [RILEY],
      channel: 'app_store',
    });
    expect(store.purchases).toEqual([
      { productId: 'pl_family_1', replacing: { productId: 'pl_family_2', direction: 'downgrade' } },
    ]);
    expect(final).toMatchObject({ kind: 'scheduled', targetSlots: 1 });
    if (final.kind === 'scheduled') {
      expect(final.message).toBe(
        'Confirmed by the store: your plan changes to 1 child on October 10, 2026. Until then, every child keeps access.',
      );
    }
  });

  it('a smaller plan with room for every active child needs no selection', () => {
    const roomy = select(billingStatus({ ...current, assignedSlots: 1 }), 1);
    expect(roomy.kind === 'confirming' && roomy.confirmation.needsKeepSelection).toBe(false);
    expect(roomy.kind === 'confirming' && roomy.confirmation.keepCount).toBe(0);
  });

  it('the parent fills every slot of the smaller plan; a partial choice is never sent (RV-billing-3)', async () => {
    const three = billingStatus({
      paidSlots: 3,
      assignedSlots: 3,
      managingChannel: 'app_store',
      entitlements: [{ ...ACTIVE_TWO, productId: 'pl_family_3', paidSlots: 3 }],
    });
    const confirming = select(three, 2);
    expect(confirming.kind === 'confirming' && confirming.confirmation.keepCount).toBe(2);
    for (const keep of [[RILEY], [RILEY, RILEY]]) {
      const log: string[] = [];
      const { api } = server(three, log);
      const final = await runPlanChange(
        { api, store: fakeStore({}, log), context: () => PARENT },
        confirming,
        keep,
      );
      expect(final).toMatchObject({
        kind: 'failed',
        message: 'Choose 2 children to keep active on the smaller plan.',
      });
      expect(log).toEqual([]);
    }
    const { api, calls } = server(three);
    await runPlanChange({ api, store: fakeStore(), context: () => PARENT }, confirming, [
      RILEY,
      SAM,
    ]);
    expect(calls[0]!.body).toMatchObject({
      kind: 'downgrade',
      toSlots: 2,
      keepChildIds: [RILEY, SAM],
    });
  });
});

describe('restore (AC_BILLING_02, AC_CAPACITY_10)', () => {
  it('restores, then shows only what the server verified', async () => {
    const log: string[] = [];
    const { api } = server(billingStatus({ paidSlots: 2 }), log);
    const store = fakeStore({}, log);
    const result = await runRestore({ api, store, context: () => PARENT }, BILLING_REF);
    expect(log).toEqual([
      `store identify ${BILLING_REF}`,
      'store restore',
      'api POST /v1/billing/sync',
    ]);
    expect(result).toEqual({
      kind: 'restored',
      paidSlots: 2,
      message: 'Checked with the store: your plan covers 2 children.',
    });
    const none = await runRestore(
      { api: server(billingStatus()).api, store: fakeStore(), context: () => PARENT },
      BILLING_REF,
    );
    expect(none).toMatchObject({ kind: 'restored', paidSlots: 0 });
  });

  it('is blocked in child mode and when the build has no store', async () => {
    const log: string[] = [];
    const { api } = server(billingStatus(), log);
    const store = fakeStore({}, log);
    expect(await runRestore({ api, store, context: () => CHILD_MODE }, BILLING_REF)).toMatchObject({
      kind: 'blocked',
    });
    expect(
      await runRestore(
        { api, store: fakeStore({ available: false }, log), context: () => PARENT },
        BILLING_REF,
      ),
    ).toMatchObject({ kind: 'blocked', message: expect.stringMatching(/this build/) as unknown });
    expect(log).toEqual([]);
  });

  it('a store restore failure does not sync or claim anything', async () => {
    const log: string[] = [];
    const { api } = server(billingStatus({ paidSlots: 2 }), log);
    const result = await runRestore(
      {
        api,
        store: fakeStore({ restore: { kind: 'failed', message: 'Restore failed' } }, log),
        context: () => PARENT,
      },
      BILLING_REF,
    );
    expect(result).toEqual({ kind: 'failed', message: 'Restore failed' });
    expect(log).not.toContain('api POST /v1/billing/sync');
  });
});

describe('state machine guards', () => {
  it('ignores events that don’t apply to the current state', () => {
    const idle: PurchaseState = { kind: 'idle' };
    expect(transition(idle, { type: 'confirm', context: PARENT })).toBe(idle);
    expect(transition(idle, { type: 'store_result', outcome: { kind: 'success' } })).toBe(idle);
    expect(transition(idle, { type: 'verified', status: billingStatus({ paidSlots: 4 }) })).toBe(
      idle,
    );
    const confirming = select(billingStatus(), 2);
    expect(transition(confirming, { type: 'store_result', outcome: { kind: 'success' } })).toBe(
      confirming,
    );
    expect(transition(confirming, { type: 'reset' })).toEqual({ kind: 'idle' });
  });
});
