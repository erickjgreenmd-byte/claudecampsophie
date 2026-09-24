import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderSubscriptionSnapshot } from '@pencillift/domain/entitlements';
import { seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { createTestApi, json, type TestApi } from './helpers.ts';

/**
 * The RevenueCat webhook reconciles the whole family the same way POST /v1/billing/sync does
 * (RV-billing-1/2 on the webhook path): a subscription the provider no longer lists stops granting,
 * a TRANSFER re-verifies every family it names, and children whose slot a verified change released
 * go back to draft. Synthetic families only; the subscriber-state provider is the labeled mock.
 */
const RC_AUTH = 'Bearer rc-webhook-secret-for-tests-0123456789';
let api: TestApi;

async function refOf(fam: SeededFamily): Promise<string> {
  const [row] = await api.db.sql<{ billing_ref: string }[]>`
    select billing_ref from public.families where id = ${fam.familyId}`;
  return row!.billing_ref;
}

function snapshot(
  ref: string,
  overrides: Partial<ProviderSubscriptionSnapshot> = {},
): ProviderSubscriptionSnapshot {
  return {
    channel: 'app_store',
    providerSubscriptionId: `rc:${ref}:app_store:pl_family_2`,
    productId: 'pl_family_2',
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

function rcEvent(ref: string, overrides: Record<string, unknown> = {}) {
  return {
    event: {
      id: randomUUID(),
      type: 'RENEWAL',
      app_user_id: ref,
      product_id: 'pl_family_2',
      store: 'app_store',
      purchased_at_ms: Date.parse('2026-09-10T00:00:00Z'),
      expiration_at_ms: Date.parse('2026-10-10T00:00:00Z'),
      price_in_purchased_currency: 49.98,
      currency: 'USD',
      period_type: 'NORMAL',
      transaction_id: `tx_${randomUUID()}`,
      event_timestamp_ms: Date.parse('2026-09-10T00:05:00Z'),
      ...overrides,
    },
  };
}

async function post(body: unknown): Promise<string> {
  const res = await api.request('/webhooks/revenuecat', {
    method: 'POST',
    body,
    headers: { authorization: RC_AUTH },
  });
  expect(res.status).toBe(200);
  return (await json<{ status: string }>(res)).status;
}

async function paidSlots(fam: SeededFamily): Promise<number> {
  const [row] = await api.db.sql<{ paid_slots: number }[]>`
    select paid_slots from public.family_capacity where family_id = ${fam.familyId}`;
  return row?.paid_slots ?? 0;
}

beforeAll(async () => {
  api = await createTestApi({ REVENUECAT_WEBHOOK_AUTH: RC_AUTH });
  await api.db.sql`
    insert into public.store_product_mappings (channel, product_id, environment, paid_slots)
    values ('app_store', 'pl_family_2', 'sandbox', 2)
    on conflict do nothing`;
});

afterAll(async () => {
  await api?.close();
});

describe('RevenueCat webhook reconciles the whole family (RV-billing-1/2, AC_BILLING_03)', () => {
  it('a subscription the provider no longer lists stops granting on the webhook path', async () => {
    const fam = await seedFamily(api.db);
    const ref = await refOf(fam);
    api.providers.subscriptions.state.set(ref, [snapshot(ref)]);
    expect(await post(rcEvent(ref))).toBe('processed');
    expect(await paidSlots(fam)).toBe(2);

    // The provider moved the purchase away (restore on another account): a complete fetch for this
    // family no longer lists it. Any event for the family must stop the old grant.
    api.providers.subscriptions.state.set(ref, []);
    expect(await post(rcEvent(ref, { type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE' }))).toBe(
      'processed',
    );
    expect(await paidSlots(fam)).toBe(0);
  });

  it('a TRANSFER re-verifies both the old and the new family', async () => {
    const from = await seedFamily(api.db);
    const to = await seedFamily(api.db);
    const fromRef = await refOf(from);
    const toRef = await refOf(to);
    api.providers.subscriptions.state.set(fromRef, [snapshot(fromRef)]);
    expect(await post(rcEvent(fromRef))).toBe('processed');
    expect(await paidSlots(from)).toBe(2);

    api.providers.subscriptions.state.set(fromRef, []);
    api.providers.subscriptions.state.set(toRef, [snapshot(toRef)]);
    const transfer = rcEvent(toRef, {
      type: 'TRANSFER',
      transferred_from: [fromRef],
      transferred_to: [toRef],
    });
    expect(await post(transfer)).toBe('processed');
    expect(await paidSlots(from)).toBe(0);
    expect(await paidSlots(to)).toBe(2);
  });

  it('children whose slot an expiry released go back to draft', async () => {
    const fam = await seedFamily(api.db, { childCount: 2 });
    const ref = await refOf(fam);
    api.providers.subscriptions.state.set(ref, [snapshot(ref)]);
    expect(await post(rcEvent(ref))).toBe('processed');
    for (const child of fam.children) {
      await api.db.sql`
        update public.child_profiles set status = 'active' where id = ${child.id}`;
      await api.db.sql`
        insert into public.child_slot_assignments (family_id, child_id)
        values (${fam.familyId}, ${child.id}) on conflict do nothing`;
    }

    api.providers.subscriptions.state.set(ref, [
      snapshot(ref, { status: 'expired', providerUpdatedAt: new Date('2026-09-20T00:00:00Z') }),
    ]);
    expect(await post(rcEvent(ref, { type: 'EXPIRATION' }))).toBe('processed');
    expect(await paidSlots(fam)).toBe(0);
    const statuses = await api.db.sql<{ status: string }[]>`
      select status from public.child_profiles where family_id = ${fam.familyId}`;
    expect(statuses.map((s) => s.status)).toEqual(['draft', 'draft']);
  });
});
