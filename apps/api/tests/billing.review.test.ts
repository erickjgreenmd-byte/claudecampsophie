import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { billingStatusResponseSchema, type BillingStatus } from '@pencillift/contracts';
import type { ProviderSubscriptionSnapshot } from '@pencillift/domain/entitlements';
import {
  grantAdultUnlock,
  seedChild,
  seedFamily,
  type SeededFamily,
} from '@pencillift/db/testing/fixtures';
import { createRevenueCatProvider } from '../src/providers/billing.ts';
import { createTestApi, parentToken, type TestApi } from './helpers.ts';

/**
 * Adversarial review of the parent billing vertical (spec P11; AC_BILLING_02, AC_CAPACITY_03/05/08/10).
 * Each `it` is a regression test for a defect found by the review and is expected to FAIL until the
 * defect is fixed. The subscriber-state provider is the labeled mock, or the real RevenueCat mapper
 * fed labeled, synthetic RevenueCat JSON through a fake fetch: no live store or provider is called.
 */

let api: TestApi;
const SESSION = '0b999999-2222-4333-8444-555555555555';

interface Family extends SeededFamily {
  token: string;
  ref: string;
}

async function family(options: { childCount?: number } = {}): Promise<Family> {
  const fam = await seedFamily(api.db, { childCount: options.childCount ?? 0 });
  await grantAdultUnlock(api.db, fam.ownerId, SESSION, 3600);
  const [row] = await api.db.sql<{ billing_ref: string }[]>`
    select billing_ref from public.families where id = ${fam.familyId}`;
  return {
    ...fam,
    token: await parentToken(fam.ownerId, { sessionId: SESSION }),
    ref: row!.billing_ref,
  };
}

async function consent(fam: Family): Promise<void> {
  await api.db.sql`
    insert into public.consent_records (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
    values (${fam.familyId}, ${fam.ownerId}, 'mock', 'mock', 'child_learning_data', 'v1', 'verified', true, now())`;
}

function snapshot(
  ref: string,
  overrides: Partial<ProviderSubscriptionSnapshot> = {},
): ProviderSubscriptionSnapshot {
  const productId = overrides.productId ?? 'pl_family_2';
  const channel = overrides.channel ?? 'app_store';
  return {
    channel,
    providerSubscriptionId: `rc:${ref}:${channel}:${productId}`,
    productId,
    status: 'active',
    periodStart: new Date('2026-09-10T00:00:00Z'),
    periodEnd: new Date('2026-10-10T00:00:00Z'),
    autoRenew: true,
    environment: 'sandbox',
    providerUpdatedAt: new Date('2026-09-10T00:00:00Z'),
    fetchedAt: new Date('2026-09-24T15:00:00Z'),
    ...overrides,
  };
}

const sync = (token: string) => api.request('/v1/billing/sync', { method: 'POST', token });
const change = (token: string, body: unknown) =>
  api.request('/v1/billing/capacity-changes', { method: 'POST', token, body });
const activate = (token: string, childId: string) =>
  api.request(`/v1/children/${childId}/activate`, { method: 'POST', token });

async function synced(token: string): Promise<{ status: number; body: BillingStatus | null }> {
  const res = await sync(token);
  const raw: unknown = await res.json();
  return {
    status: res.status,
    body: res.status === 200 ? billingStatusResponseSchema.parse(raw) : null,
  };
}

async function paidSlots(fam: SeededFamily): Promise<number> {
  const [row] = await api.db.sql<{ paid_slots: number }[]>`
    select paid_slots from public.family_capacity where family_id = ${fam.familyId}`;
  return row?.paid_slots ?? 0;
}

async function openSlotChildren(fam: SeededFamily): Promise<string[]> {
  const rows = await api.db.sql<{ child_id: string }[]>`
    select child_id from public.child_slot_assignments
     where family_id = ${fam.familyId} and released_at is null order by child_id`;
  return rows.map((r) => r.child_id);
}

beforeAll(async () => {
  api = await createTestApi();
  for (const [product, slots] of [
    ['pl_family_1', 1],
    ['pl_family_2', 2],
    ['pl_family_3', 3],
  ] as const) {
    await api.db.sql`
      insert into public.store_product_mappings (channel, product_id, environment, paid_slots, active)
      values ('app_store', ${product}, 'sandbox', ${slots}, true)`;
  }
});

afterAll(async () => {
  await api?.close();
});

describe('RV-billing-1: one store purchase never gives paid capacity to two families (AC_CAPACITY_05, AC_BILLING_02)', () => {
  it('after RevenueCat moves a subscription to another family’s billing ref (restore/transfer), only one family keeps the slots', async () => {
    // Labeled fake of RevenueCat GET /v1/subscribers/{app_user_id}: synthetic JSON only.
    const subscribers = new Map<string, Record<string, unknown>>();
    const revenueCat = createRevenueCatProvider('sk_review_fake_not_a_key', (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const ref = decodeURIComponent(url.split('/subscribers/')[1] ?? '');
      return Promise.resolve(
        new Response(
          JSON.stringify({ subscriber: { subscriptions: subscribers.get(ref) ?? {} } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    const spy = vi
      .spyOn(api.providers.subscriptions, 'fetchSubscriptions')
      .mockImplementation((ref, now) => revenueCat.fetchSubscriptions(ref, now));
    try {
      // The same App Store transaction, as RevenueCat reports it under whichever app user owns it.
      const storeSubscription = {
        store: 'app_store',
        is_sandbox: true,
        purchase_date: '2026-09-10T00:00:00Z',
        original_purchase_date: '2026-09-10T00:00:00Z',
        expires_date: '2026-10-10T00:00:00Z',
        store_transaction_id: '2000000000000001',
        unsubscribe_detected_at: null,
        billing_issues_detected_at: null,
        grace_period_expires_date: null,
        refunded_at: null,
      };
      const a = await family();
      const b = await family();
      subscribers.set(a.ref, { pl_family_2: storeSubscription });
      expect((await synced(a.token)).body?.paidSlots).toBe(2);

      // Family B's parent restores with the same store account: RevenueCat's default transfer
      // behaviour moves the purchase to B's app user id, so A's subscriber no longer lists it.
      subscribers.set(a.ref, {});
      subscribers.set(b.ref, { pl_family_2: storeSubscription });
      await synced(b.token);
      await synced(a.token);

      const withCapacity = [await paidSlots(a), await paidSlots(b)].filter((n) => n > 0);
      // Today both A and B hold 2 paid slots from one $49.99 purchase.
      expect(withCapacity.length).toBeLessThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('RV-billing-2: slots released by a verified change can be reassigned without a new purchase (AC_CAPACITY_03/10)', () => {
  it('after the subscription lapses and the family subscribes again, a previously active child can take an unused paid slot', async () => {
    const fam = await family();
    await consent(fam);
    const riley = await seedChild(api.db, fam.familyId, 'Riley', 'draft');
    const sam = await seedChild(api.db, fam.familyId, 'Sam', 'draft');
    const state = api.providers.subscriptions.state;

    state.set(fam.ref, [snapshot(fam.ref)]);
    expect((await synced(fam.token)).body?.paidSlots).toBe(2);
    for (const child of [riley, sam])
      expect((await activate(fam.token, child.id)).status).toBe(200);
    expect(await openSlotChildren(fam)).toHaveLength(2);

    // The store reports expiry: every slot is released (history kept).
    state.set(fam.ref, [
      snapshot(fam.ref, { status: 'expired', providerUpdatedAt: new Date('2026-09-20T00:00:00Z') }),
    ]);
    expect((await synced(fam.token)).body?.paidSlots).toBe(0);
    expect(await openSlotChildren(fam)).toEqual([]);

    // The parent subscribes again; the plan screen now says "2 unused paid slots — assign them in
    // Children, no new purchase is needed".
    state.set(fam.ref, [
      snapshot(fam.ref, {
        periodStart: new Date('2026-09-24T00:00:00Z'),
        periodEnd: new Date('2026-10-24T00:00:00Z'),
        providerUpdatedAt: new Date('2026-09-24T12:00:00Z'),
      }),
    ]);
    const again = (await synced(fam.token)).body!;
    expect(again.paidSlots).toBe(2);
    expect(again.assignedSlots).toBe(0);

    // Assigning the unused slot to Riley must work. Today the activate route answers 200 without
    // assigning a slot (Riley's profile was left `active` when the slot was released), so Riley can
    // never get paid access back while the family pays for two slots.
    const res = await activate(fam.token, riley.id);
    expect(res.status).toBe(200);
    expect(await openSlotChildren(fam)).toContain(riley.id);
  });
});

describe('RV-billing-3: the server never picks which unselected child keeps paid access (spec P11 downgrade)', () => {
  it('a downgrade keeping only Riley does not leave a slot with a child the parent did not choose', async () => {
    const fam = await family({ childCount: 3 });
    const [riley, sam, jordan] = fam.children.map((c) => c.id) as [string, string, string];
    const state = api.providers.subscriptions.state;
    state.set(fam.ref, [snapshot(fam.ref, { productId: 'pl_family_3' })]);
    expect((await synced(fam.token)).body?.paidSlots).toBe(3);
    for (const id of [riley, sam, jordan]) {
      await api.db.sql`
        insert into public.child_slot_assignments (family_id, child_id) values (${fam.familyId}, ${id})`;
    }

    // The mobile keep-selector says "Choose up to 2 … Others keep their history … but paid
    // learning features stop when the change takes effect"; the parent chooses Riley only.
    const res = await change(fam.token, { kind: 'downgrade', toSlots: 2, keepChildIds: [riley] });
    if (res.status !== 201) {
      // Acceptable fix: refuse an incomplete selection instead of choosing for the parent.
      expect(res.status).toBe(422);
      return;
    }
    state.set(fam.ref, [
      snapshot(fam.ref, {
        productId: 'pl_family_2',
        providerSubscriptionId: `rc:${fam.ref}:app_store:pl_family_3`,
        providerUpdatedAt: new Date('2026-09-24T12:00:00Z'),
      }),
    ]);
    expect((await synced(fam.token)).body?.paidSlots).toBe(2);
    // Today Riley AND whichever of Sam/Jordan was assigned first keep paid slots.
    expect(await openSlotChildren(fam)).toEqual([riley]);
  });
});
