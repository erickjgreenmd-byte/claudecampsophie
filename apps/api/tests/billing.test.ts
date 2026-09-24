import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  billingStatusResponseSchema,
  capacityChangeResponseSchema,
  type BillingStatus,
} from '@pencillift/contracts';
import type { ProviderSubscriptionSnapshot } from '@pencillift/domain/entitlements';
import {
  grantAdultUnlock,
  seedChild,
  seedFamily,
  type SeededFamily,
} from '@pencillift/db/testing/fixtures';
import { issueChildAccessToken } from '../src/auth/child.ts';
import { applySnapshots } from '../src/services/billing-sync.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * Parent billing routes (spec P11; AC_BILLING_02/05, AC_CAPACITY_04/05/08/10). The subscriber-state
 * provider is the labeled mock (`createSubscriberStateMock`): these tests prove our reconciliation
 * and authorization, not store behaviour, which needs sandbox receipts (docs/Connections.md).
 */

let api: TestApi;
const SESSION = '0b111111-2222-4333-8444-555555555555';

interface Family extends SeededFamily {
  token: string;
  ref: string;
}

async function family(options: { childCount?: number; unlocked?: boolean } = {}): Promise<Family> {
  const fam = await seedFamily(api.db, { childCount: options.childCount ?? 1 });
  if (options.unlocked !== false) await grantAdultUnlock(api.db, fam.ownerId, SESSION, 3600);
  const [row] = await api.db.sql<
    { billing_ref: string }[]
  >`select billing_ref from public.families where id = ${fam.familyId}`;
  return {
    ...fam,
    token: await parentToken(fam.ownerId, { sessionId: SESSION }),
    ref: row!.billing_ref,
  };
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

const getStatus = (token: string) => api.request('/v1/billing/status', { token });
const sync = (token: string, body?: unknown) =>
  api.request('/v1/billing/sync', { method: 'POST', token, ...(body ? { body } : {}) });
const change = (token: string, body: unknown) =>
  api.request('/v1/billing/capacity-changes', { method: 'POST', token, body });

async function status(token: string): Promise<BillingStatus> {
  const res = await getStatus(token);
  expect(res.status).toBe(200);
  return billingStatusResponseSchema.parse(await res.json());
}

async function capacityRow(fam: SeededFamily) {
  const [row] = await api.db.sql<{ paid_slots: number }[]>`
    select paid_slots from public.family_capacity where family_id = ${fam.familyId}`;
  return row?.paid_slots ?? 0;
}

async function changeRows(fam: SeededFamily) {
  return api.db.sql<
    {
      kind: string;
      status: string;
      from_slots: number;
      to_slots: number;
      keep_child_ids: string[];
    }[]
  >`
    select kind, status, from_slots, to_slots, keep_child_ids from public.capacity_changes
     where family_id = ${fam.familyId} order by created_at`;
}

/** Gives a family verified paid capacity through the real sync path (mock provider state). */
async function subscribe(fam: Family, productId: string): Promise<BillingStatus> {
  api.providers.subscriptions.state.set(fam.ref, [snapshot(fam.ref, { productId })]);
  const res = await sync(fam.token);
  expect(res.status).toBe(200);
  return billingStatusResponseSchema.parse(await res.json());
}

beforeAll(async () => {
  api = await createTestApi();
  for (const [channel, product, env, slots, price, active] of [
    ['app_store', 'pl_family_1', 'sandbox', 1, 3999, true],
    ['app_store', 'pl_family_2', 'sandbox', 2, 4999, true],
    ['app_store', 'pl_family_3', 'sandbox', 3, null, true],
    ['play_store', 'pl_family_2', 'sandbox', 2, 4998, true],
    ['app_store', 'pl_family_retired', 'sandbox', 2, null, false],
    ['app_store', 'pl_family_2_prod', 'production', 2, null, true],
  ] as const) {
    await api.db.sql`
      insert into public.store_product_mappings (channel, product_id, environment, paid_slots, store_price_cents, active)
      values (${channel}, ${product}, ${env}, ${slots}, ${price}, ${active})
    `;
  }
});

afterAll(async () => {
  await api?.close();
});

describe('GET /v1/billing/status (spec P11, P14 subscription)', () => {
  it('requires a parent: no token and a child token are both rejected', async () => {
    const fam = await family();
    expect((await api.request('/v1/billing/status')).status).toBe(401);
    const child = fam.children[0]!;
    const { token } = await issueChildAccessToken(
      api.config,
      { kind: 'child', childId: child.id, familyId: fam.familyId, sessionId: child.sessionId },
      api.now.value,
    );
    for (const res of [await getStatus(token), await sync(token), await change(token, {})]) {
      expect(res.status).toBe(401);
    }
  });

  it('returns the strict shape with approved prices and runtime-environment products only', async () => {
    const fam = await family({ childCount: 2 });
    const res = await getStatus(fam.token);
    const raw = await res.text();
    const body = billingStatusResponseSchema.parse(JSON.parse(raw));
    expect(body).toMatchObject({
      billingRef: fam.ref,
      paidSlots: 0,
      assignedSlots: 0,
      managingChannel: null,
      conflict: null,
      pendingChange: null,
      requestedChange: null,
      entitlements: [],
    });
    expect(body.billingRef).toMatch(/^fam_[0-9a-f]{24}$/);
    // AC_CAPACITY_01: exact approved totals, no family fee.
    expect(body.tiers).toEqual([
      { paidSlots: 1, approvedMonthlyCents: 3999 },
      { paidSlots: 2, approvedMonthlyCents: 4998 },
      { paidSlots: 3, approvedMonthlyCents: 5997 },
      { paidSlots: 4, approvedMonthlyCents: 6996 },
    ]);
    // Inactive and production mappings never appear in a sandbox runtime. The server compares each
    // verified store price with the approved price (AC_CAPACITY_02): $49.99 ≠ $49.98 is reported.
    expect(body.products).toEqual([
      {
        channel: 'app_store',
        productId: 'pl_family_1',
        paidSlots: 1,
        storePriceCents: 3999,
        priceCheck: 'matches_approved',
      },
      {
        channel: 'app_store',
        productId: 'pl_family_2',
        paidSlots: 2,
        storePriceCents: 4999,
        priceCheck: 'differs_from_approved',
      },
      {
        channel: 'app_store',
        productId: 'pl_family_3',
        paidSlots: 3,
        storePriceCents: null,
        priceCheck: 'not_verified',
      },
      {
        channel: 'play_store',
        productId: 'pl_family_2',
        paidSlots: 2,
        storePriceCents: 4998,
        priceCheck: 'matches_approved',
      },
    ]);
    // No internal identifiers besides the opaque billing ref.
    for (const id of [fam.familyId, fam.ownerId, ...fam.children.map((ch) => ch.id)]) {
      expect(raw).not.toContain(id);
    }
  });

  it('a parent without a family gets NOT_FOUND', async () => {
    const userId = await api.db.createUser();
    const token = await parentToken(userId);
    const res = await getStatus(token);
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/billing/sync (AC_BILLING_02/05, AC_CAPACITY_05/10)', () => {
  it('applies the provider’s current state and reports verified capacity without internal ids', async () => {
    const fam = await family({ childCount: 2 });
    api.providers.subscriptions.state.set(fam.ref, [snapshot(fam.ref)]);
    const res = await sync(fam.token);
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = billingStatusResponseSchema.parse(JSON.parse(raw));
    expect(body.paidSlots).toBe(2);
    expect(body.managingChannel).toBe('app_store');
    expect(body.entitlements).toEqual([
      {
        channel: 'app_store',
        productId: 'pl_family_2',
        paidSlots: 2,
        status: 'active',
        periodEnd: '2026-10-10T00:00:00.000Z',
        autoRenew: true,
      },
    ]);
    expect(await capacityRow(fam)).toBe(2);
    // The provider subscription key embeds the ref but is never echoed; nor are family/user ids.
    expect(raw).not.toContain(`rc:${fam.ref}`);
    expect(raw).not.toContain(fam.familyId);
    expect(raw).not.toContain(fam.ownerId);
    // GET returns the same verified picture.
    expect((await status(fam.token)).paidSlots).toBe(2);
  });

  it('a client claim in the request body never unlocks anything', async () => {
    const fam = await family();
    const res = await sync(fam.token, {
      paidSlots: 4,
      productId: 'pl_family_3',
      status: 'active',
      purchase: 'success',
    });
    expect(res.status).toBe(200);
    expect(billingStatusResponseSchema.parse(await res.json()).paidSlots).toBe(0);
    expect(await capacityRow(fam)).toBe(0);
  });

  it('a pending (Ask to Buy) subscription grants no slot', async () => {
    const fam = await family();
    api.providers.subscriptions.state.set(fam.ref, [snapshot(fam.ref, { status: 'pending' })]);
    const body = billingStatusResponseSchema.parse(await (await sync(fam.token)).json());
    expect(body.paidSlots).toBe(0);
    expect(body.entitlements.map((e) => e.status)).toEqual(['pending']);
  });

  it('is family-isolated: one family’s sync never reads or writes another family’s state', async () => {
    const a = await family();
    const b = await family();
    api.providers.subscriptions.state.set(a.ref, [snapshot(a.ref, { productId: 'pl_family_3' })]);
    const spy = vi.spyOn(api.providers.subscriptions, 'fetchSubscriptions');
    const res = await sync(b.token);
    expect(res.status).toBe(200);
    // The server looked up only B's own billing ref; nothing from the request picks the subscriber.
    expect(spy.mock.calls.map(([ref]) => ref)).toEqual([b.ref]);
    spy.mockRestore();
    const bStatus = billingStatusResponseSchema.parse(await res.json());
    expect(bStatus.billingRef).toBe(b.ref);
    expect(bStatus.paidSlots).toBe(0);
    expect(bStatus.entitlements).toEqual([]);
    expect(await capacityRow(a)).toBe(0);
    // A's own sync grants A only; B's status still shows nothing of A.
    const aSynced = billingStatusResponseSchema.parse(await (await sync(a.token)).json());
    expect(aSynced.paidSlots).toBe(3);
    const bAfter = await status(b.token);
    expect(bAfter.paidSlots).toBe(0);
    expect(JSON.stringify(bAfter)).not.toContain(a.ref);
  });

  it('a store subscription already bound to another family fails loudly and grants nothing', async () => {
    const owner = await family();
    await subscribe(owner, 'pl_family_2');
    const other = await family();
    api.providers.subscriptions.state.set(other.ref, [snapshot(owner.ref)]);
    const res = await sync(other.token);
    expect(res.status).toBe(422);
    expect((await json<{ error: { rule: string } }>(res)).error.rule).toBe(
      'SUBSCRIPTION_BOUND_ELSEWHERE',
    );
    expect(await capacityRow(other)).toBe(0);
    expect(await capacityRow(owner)).toBe(2);
  });

  it('expiry from the provider removes paid capacity (AC_CAPACITY_10)', async () => {
    const fam = await family();
    await subscribe(fam, 'pl_family_2');
    api.providers.subscriptions.state.set(fam.ref, [
      snapshot(fam.ref, {
        status: 'expired',
        providerUpdatedAt: new Date('2026-09-20T00:00:00Z'),
      }),
    ]);
    const body = billingStatusResponseSchema.parse(await (await sync(fam.token)).json());
    expect(body.paidSlots).toBe(0);
    expect(body.entitlements[0]!.status).toBe('expired');
  });

  it('two platforms never add up and the conflict is reported to the parent', async () => {
    const fam = await family();
    api.providers.subscriptions.state.set(fam.ref, [
      snapshot(fam.ref),
      snapshot(fam.ref, { channel: 'play_store', productId: 'pl_family_2' }),
    ]);
    const body = billingStatusResponseSchema.parse(await (await sync(fam.token)).json());
    expect(body.paidSlots).toBe(2);
    expect(body.conflict).toBe('duplicate_active_subscriptions');
  });

  it('a family deleted while the provider is being asked is never rebuilt (spec E4)', async () => {
    const fam = await family();
    const spy = vi
      .spyOn(api.providers.subscriptions, 'fetchSubscriptions')
      .mockImplementationOnce(async (ref) => {
        await api.db.sql`update public.families set deleted_at = now() where id = ${fam.familyId}`;
        return [snapshot(ref)];
      });
    const res = await sync(fam.token);
    spy.mockRestore();
    expect(res.status).toBe(404);
    const rows = await api.db
      .sql`select id from public.family_entitlements where family_id = ${fam.familyId}`;
    expect(rows).toHaveLength(0);
    expect(await capacityRow(fam)).toBe(0);
  });

  it('a provider failure answers PROVIDER_UNAVAILABLE and leaves capacity unchanged', async () => {
    const fam = await family();
    await subscribe(fam, 'pl_family_2');
    const spy = vi
      .spyOn(api.providers.subscriptions, 'fetchSubscriptions')
      .mockRejectedValueOnce(new Error('upstream down'));
    const res = await sync(fam.token);
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(await capacityRow(fam)).toBe(2);
  });

  it('is rate limited per family (12 per hour)', async () => {
    const fam = await family();
    for (let i = 0; i < 12; i += 1) expect((await sync(fam.token)).status).toBe(200);
    const res = await sync(fam.token);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    // Another family is unaffected.
    expect((await sync((await family()).token)).status).toBe(200);
  });

  it('marks the parent’s upgrade request applied only once verified capacity covers it', async () => {
    const fam = await family();
    expect((await change(fam.token, { kind: 'upgrade', toSlots: 2 })).status).toBe(201);
    // No provider state yet: the request stays open and nothing is granted.
    await sync(fam.token);
    expect((await changeRows(fam)).map((r) => r.status)).toEqual(['pending_purchase']);
    expect((await status(fam.token)).requestedChange).toMatchObject({
      kind: 'upgrade',
      toSlots: 2,
      status: 'pending_purchase',
    });
    const body = await subscribe(fam, 'pl_family_2');
    expect(body.paidSlots).toBe(2);
    expect(body.requestedChange).toBeNull();
    expect((await changeRows(fam)).map((r) => r.status)).toEqual(['applied']);
  });
});

describe('POST /v1/billing/capacity-changes (AC_CAPACITY_04/08/09)', () => {
  it('requires a recent parent PIN step-up and records nothing without it', async () => {
    const fam = await family({ unlocked: false });
    const res = await change(fam.token, { kind: 'upgrade', toSlots: 2 });
    expect(res.status).toBe(403);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('STEP_UP_REQUIRED');
    expect(await changeRows(fam)).toEqual([]);
  });

  it('an upgrade records intent only: paid capacity is unchanged until the store confirms', async () => {
    const fam = await family({ childCount: 2 });
    const res = await change(fam.token, { kind: 'upgrade', toSlots: 2 });
    expect(res.status).toBe(201);
    const body = capacityChangeResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      kind: 'upgrade',
      fromSlots: 0,
      toSlots: 2,
      keepChildIds: [],
      status: 'pending_purchase',
      currentRecurringCents: 0,
      newRecurringCents: 4998,
      nextStep: 'purchase_in_store',
    });
    expect(await capacityRow(fam)).toBe(0);
    expect((await status(fam.token)).paidSlots).toBe(0);
  });

  it('rejects upgrades that are not larger than the verified plan and malformed requests', async () => {
    const fam = await family();
    await subscribe(fam, 'pl_family_2');
    const same = await change(fam.token, { kind: 'upgrade', toSlots: 2 });
    expect(same.status).toBe(422);
    expect((await json<{ error: { rule: string } }>(same)).error.rule).toBe('NOT_AN_UPGRADE');
    for (const bad of [
      { kind: 'upgrade', toSlots: 5 },
      { kind: 'upgrade', toSlots: 0 },
      { kind: 'upgrade', toSlots: 3, keepChildIds: [fam.children[0]!.id] },
      { kind: 'upgrade', toSlots: 3, paidSlots: 3 },
      { kind: 'refund', toSlots: 1 },
    ]) {
      expect((await change(fam.token, bad)).status).toBe(400);
    }
    expect(await changeRows(fam)).toEqual([]);
  });

  it('a downgrade validates the keep list against this family and the new tier', async () => {
    const fam = await family({ childCount: 3 });
    await subscribe(fam, 'pl_family_3');
    const stranger = await family();
    const [riley, sam, jordan] = fam.children.map((ch) => ch.id) as [string, string, string];

    const foreign = await change(fam.token, {
      kind: 'downgrade',
      toSlots: 2,
      keepChildIds: [riley, stranger.children[0]!.id],
    });
    expect(foreign.status).toBe(404);

    const tooMany = await change(fam.token, {
      kind: 'downgrade',
      toSlots: 2,
      keepChildIds: [riley, sam, jordan],
    });
    expect(tooMany.status).toBe(422);
    expect((await json<{ error: { rule: string } }>(tooMany)).error.rule).toBe('TOO_MANY_KEPT');

    // Omitted or empty: the server never chooses which children lose paid access.
    for (const keepChildIds of [undefined, []]) {
      const unchosen = await change(fam.token, {
        kind: 'downgrade',
        toSlots: 2,
        ...(keepChildIds ? { keepChildIds } : {}),
      });
      expect((await json<{ error: { rule: string } }>(unchosen)).error.rule).toBe(
        'KEEP_SELECTION_REQUIRED',
      );
    }

    const notSmaller = await change(fam.token, { kind: 'downgrade', toSlots: 3, keepChildIds: [] });
    expect((await json<{ error: { rule: string } }>(notSmaller)).error.rule).toBe(
      'NOT_A_DOWNGRADE',
    );
    expect(await changeRows(fam)).toEqual([]);

    const ok = await change(fam.token, {
      kind: 'downgrade',
      toSlots: 2,
      keepChildIds: [riley, sam],
    });
    expect(ok.status).toBe(201);
    expect(capacityChangeResponseSchema.parse(await ok.json())).toMatchObject({
      kind: 'downgrade',
      fromSlots: 3,
      toSlots: 2,
      keepChildIds: [riley, sam],
      status: 'scheduled',
      currentRecurringCents: 5997,
      newRecurringCents: 4998,
      nextStep: 'change_in_store',
    });
    // AC_CAPACITY_09: recording a downgrade never lowers paid capacity by itself.
    expect(await capacityRow(fam)).toBe(3);
    expect((await status(fam.token)).requestedChange).toMatchObject({
      kind: 'downgrade',
      toSlots: 2,
      status: 'scheduled',
      keepCount: 2,
    });
  });

  it('only active children can be kept, and a draft profile is never counted as active', async () => {
    const fam = await family({ childCount: 2 });
    await subscribe(fam, 'pl_family_2');
    const draft = await seedChild(api.db, fam.familyId, 'Avery', 'draft');
    const res = await change(fam.token, {
      kind: 'downgrade',
      toSlots: 1,
      keepChildIds: [draft.id],
    });
    expect((await json<{ error: { rule: string } }>(res)).error.rule).toBe('KEEP_NOT_ACTIVE');
  });

  it('a downgrade without paid capacity is refused', async () => {
    const fam = await family();
    const res = await change(fam.token, { kind: 'downgrade', toSlots: 1, keepChildIds: [] });
    expect((await json<{ error: { rule: string } }>(res)).error.rule).toBe('NOT_A_DOWNGRADE');
  });

  it('a newer request supersedes the open one, and families never see each other’s requests', async () => {
    const fam = await family({ childCount: 2 });
    await subscribe(fam, 'pl_family_2');
    const other = await family();
    expect((await change(fam.token, { kind: 'upgrade', toSlots: 3 })).status).toBe(201);
    expect(
      (
        await change(fam.token, {
          kind: 'downgrade',
          toSlots: 1,
          keepChildIds: [fam.children[1]!.id],
        })
      ).status,
    ).toBe(201);
    const rows = await changeRows(fam);
    expect(rows.map((r) => [r.kind, r.status])).toEqual([
      ['upgrade', 'cancelled'],
      ['downgrade', 'scheduled'],
    ]);
    expect(rows[1]!.keep_child_ids).toEqual([fam.children[1]!.id]);
    expect((await status(other.token)).requestedChange).toBeNull();
  });

  it('the kept child keeps its slot when the verified downgrade lands (AC_CAPACITY_08)', async () => {
    const fam = await family({ childCount: 2 });
    await subscribe(fam, 'pl_family_2');
    const [riley, sam] = fam.children.map((ch) => ch.id) as [string, string];
    for (const id of [riley, sam]) {
      await api.db
        .sql`insert into public.child_slot_assignments (family_id, child_id) values (${fam.familyId}, ${id})`;
    }
    expect((await status(fam.token)).assignedSlots).toBe(2);
    await change(fam.token, { kind: 'downgrade', toSlots: 1, keepChildIds: [riley] });
    // Until the store reports the new product, both children keep their paid slots.
    expect((await status(fam.token)).assignedSlots).toBe(2);
    api.providers.subscriptions.state.set(fam.ref, [
      snapshot(fam.ref, {
        productId: 'pl_family_1',
        providerSubscriptionId: `rc:${fam.ref}:app_store:pl_family_2`,
        providerUpdatedAt: new Date('2026-10-10T00:00:00Z'),
      }),
    ]);
    const body = billingStatusResponseSchema.parse(await (await sync(fam.token)).json());
    expect(body.paidSlots).toBe(1);
    expect(body.assignedSlots).toBe(1);
    const open = await api.db.sql<{ child_id: string }[]>`
      select child_id from public.child_slot_assignments where family_id = ${fam.familyId} and released_at is null`;
    expect(open.map((o) => o.child_id)).toEqual([riley]);
    // History is kept: Sam's profile still exists, back to draft so paid AI stops (RV-billing-2).
    const [samRow] = await api.db.sql<{ status: string }[]>`
      select status from public.child_profiles where id = ${sam} and family_id = ${fam.familyId}`;
    expect(samRow?.status).toBe('draft');
    expect((await changeRows(fam)).map((r) => r.status)).toEqual(['applied']);
  });
});

async function giveConsent(fam: SeededFamily): Promise<void> {
  await api.db.sql`
    insert into public.consent_records (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
    values (${fam.familyId}, ${fam.ownerId}, 'mock', 'mock', 'child_learning_data', 'v1', 'verified', true, now())`;
}

const activate = (token: string, childId: string) =>
  api.request(`/v1/children/${childId}/activate`, { method: 'POST', token });

async function childStatus(childId: string): Promise<string | undefined> {
  const [row] = await api.db.sql<{ status: string }[]>`
    select status from public.child_profiles where id = ${childId}`;
  return row?.status;
}

async function openSlots(fam: SeededFamily): Promise<string[]> {
  const rows = await api.db.sql<{ child_id: string }[]>`
    select child_id from public.child_slot_assignments
     where family_id = ${fam.familyId} and released_at is null order by assigned_at`;
  return rows.map((r) => r.child_id);
}

describe('a subscription the provider no longer lists stops granting (RV-billing-1, AC_CAPACITY_05)', () => {
  it('a complete fetch without the subscription revokes it here; listing it again restores it', async () => {
    const fam = await family();
    await subscribe(fam, 'pl_family_2');
    api.providers.subscriptions.state.set(fam.ref, []);
    const moved = billingStatusResponseSchema.parse(await (await sync(fam.token)).json());
    expect(moved.paidSlots).toBe(0);
    expect(moved.managingChannel).toBeNull();
    // History is kept, with the provider's verdict for this family.
    expect(moved.entitlements.map((e) => [e.productId, e.status])).toEqual([
      ['pl_family_2', 'revoked'],
    ]);
    const saved = api.now.value;
    try {
      // Moved back later (a newer observation of the same provider state): it grants again.
      api.now.value = new Date(saved.getTime() + 60_000);
      api.providers.subscriptions.state.set(fam.ref, [snapshot(fam.ref)]);
      const back = billingStatusResponseSchema.parse(await (await sync(fam.token)).json());
      expect(back.paidSlots).toBe(2);
      expect(back.entitlements.map((e) => e.status)).toEqual(['active']);
    } finally {
      api.now.value = saved;
    }
  });

  // One store purchase's provider period, distinct from every other fixture in this file.
  const TRANSFERRED = {
    periodStart: new Date('2026-09-11T07:13:21.123Z'),
    periodEnd: new Date('2026-10-11T07:13:21.123Z'),
    providerUpdatedAt: new Date('2026-09-11T07:13:21.123Z'),
  };

  it('when only the new holder syncs, the former holder is re-verified and stops granting', async () => {
    const a = await family();
    const b = await family();
    api.providers.subscriptions.state.set(a.ref, [snapshot(a.ref, TRANSFERRED)]);
    expect(billingStatusResponseSchema.parse(await (await sync(a.token)).json()).paidSlots).toBe(2);
    // The provider moved the purchase (same product and period) to B's billing ref.
    api.providers.subscriptions.state.set(a.ref, []);
    api.providers.subscriptions.state.set(b.ref, [snapshot(b.ref, TRANSFERRED)]);
    const spy = vi.spyOn(api.providers.subscriptions, 'fetchSubscriptions');
    const res = await sync(b.token);
    const refs = spy.mock.calls.map(([ref]) => ref);
    spy.mockRestore();
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(billingStatusResponseSchema.parse(JSON.parse(raw)).paidSlots).toBe(2);
    // The server asked the provider about A's own ref; nothing about A reaches B's response.
    expect(refs).toEqual([b.ref, a.ref]);
    expect(raw).not.toContain(a.ref);
    expect(await capacityRow(a)).toBe(0);
    expect(await capacityRow(b)).toBe(2);
  });

  it('another family that still holds its own subscription for the same period keeps it', async () => {
    const a = await family();
    const b = await family();
    const period = {
      periodStart: new Date('2026-09-12T08:00:00.456Z'),
      periodEnd: new Date('2026-10-12T08:00:00.456Z'),
      providerUpdatedAt: new Date('2026-09-12T08:00:00.456Z'),
    };
    api.providers.subscriptions.state.set(a.ref, [snapshot(a.ref, period)]);
    await sync(a.token);
    api.providers.subscriptions.state.set(b.ref, [snapshot(b.ref, period)]);
    const spy = vi.spyOn(api.providers.subscriptions, 'fetchSubscriptions');
    const res = await sync(b.token);
    const refs = spy.mock.calls.map(([ref]) => ref);
    spy.mockRestore();
    expect(billingStatusResponseSchema.parse(await res.json()).paidSlots).toBe(2);
    // A was re-verified: the provider still lists A's own subscription, so nothing changes.
    expect(refs).toEqual([b.ref, a.ref]);
    expect(await capacityRow(a)).toBe(2);
    expect((await status(a.token)).entitlements.map((e) => e.status)).toEqual(['active']);
  });
});

describe('slots the store releases can be assigned again (RV-billing-2, AC_CAPACITY_03/08/10)', () => {
  it('a child whose slot the store released goes back to draft; other profiles are untouched', async () => {
    const fam = await family({ childCount: 1 });
    await giveConsent(fam);
    const legacy = fam.children[0]!.id; // active fixture profile that never held a slot
    const { id: riley } = await seedChild(api.db, fam.familyId, 'Riley', 'draft');
    await subscribe(fam, 'pl_family_2');
    expect((await activate(fam.token, riley)).status).toBe(200);
    expect(await openSlots(fam)).toEqual([riley]);

    api.providers.subscriptions.state.set(fam.ref, [
      snapshot(fam.ref, { status: 'expired', providerUpdatedAt: new Date('2026-09-20T00:00:00Z') }),
    ]);
    expect(billingStatusResponseSchema.parse(await (await sync(fam.token)).json()).paidSlots).toBe(
      0,
    );
    expect(await childStatus(riley)).toBe('draft');
    expect(await childStatus(legacy)).toBe('active');
    const audit = await api.db.sql<{ action: string; target_id: string }[]>`
      select action, target_id from public.audit_events
       where family_id = ${fam.familyId} and action = 'child.paid_slot_released'`;
    expect(audit.map((a) => a.target_id)).toEqual([riley]);
  });

  it('a downgrade request never counts a child whose slot a webhook already released', async () => {
    const fam = await family({ childCount: 0 });
    await giveConsent(fam);
    const ids: string[] = [];
    for (const name of ['Riley', 'Sam', 'Jordan']) {
      ids.push((await seedChild(api.db, fam.familyId, name, 'draft')).id);
    }
    const [riley, sam, jordan] = ids as [string, string, string];
    await subscribe(fam, 'pl_family_3');
    for (const id of ids) expect((await activate(fam.token, id)).status).toBe(200);
    // The webhook path (applySnapshots only) lands a store downgrade to 2: Jordan's slot is released.
    await api.apiDb.asService((tx) =>
      applySnapshots(
        tx,
        fam.familyId,
        [
          snapshot(fam.ref, {
            productId: 'pl_family_2',
            providerSubscriptionId: `rc:${fam.ref}:app_store:pl_family_3`,
            providerUpdatedAt: new Date('2026-09-24T12:00:00Z'),
          }),
        ],
        'sandbox',
        api.now.value,
      ),
    );
    expect(await openSlots(fam)).toEqual([riley, sam]);
    expect(
      (await api.request(`/v1/children/${sam}/archive`, { method: 'POST', token: fam.token }))
        .status,
    ).toBe(200);
    // Riley alone holds a slot and fits a 1-child plan: no selection is needed, and Jordan (slot
    // already released) is not counted as active.
    const res = await change(fam.token, { kind: 'downgrade', toSlots: 1 });
    expect(res.status).toBe(201);
    expect(capacityChangeResponseSchema.parse(await res.json()).keepChildIds).toEqual([riley]);
    expect(await childStatus(jordan)).toBe('draft');
  });
});

describe('the parent, never the server, picks who keeps a slot (RV-billing-3)', () => {
  it('an incomplete keep list is refused; an empty list when everyone fits keeps everyone', async () => {
    const fam = await family({ childCount: 3 });
    await subscribe(fam, 'pl_family_3');
    const [riley, sam] = fam.children.map((ch) => ch.id) as [string, string, string];
    for (const keepChildIds of [[riley], [riley, riley]]) {
      const res = await change(fam.token, { kind: 'downgrade', toSlots: 2, keepChildIds });
      expect(res.status).toBe(422);
      const body = await json<{ error: { rule: string; message: string } }>(res);
      expect(body.error.rule).toBe('KEEP_SELECTION_INCOMPLETE');
      expect(body.error.message).toMatch(/Choose 2 children to keep active/);
    }
    expect(await changeRows(fam)).toEqual([]);
    expect(
      (await change(fam.token, { kind: 'downgrade', toSlots: 2, keepChildIds: [riley, sam] }))
        .status,
    ).toBe(201);

    const roomy = await family({ childCount: 1 });
    await subscribe(roomy, 'pl_family_2');
    const res = await change(roomy.token, { kind: 'downgrade', toSlots: 1, keepChildIds: [] });
    expect(res.status).toBe(201);
    expect(capacityChangeResponseSchema.parse(await res.json()).keepChildIds).toEqual([
      roomy.children[0]!.id,
    ]);
  });
});

describe('a store price that is not the approved price is not sold (RV-billing-4, AC_CAPACITY_02)', () => {
  it('refuses the intent for a tier whose verified store price differs, before the store opens', async () => {
    const fam = await family();
    const res = await change(fam.token, { kind: 'upgrade', toSlots: 2, channel: 'app_store' });
    expect(res.status).toBe(422);
    const body = await json<{ error: { rule: string; message: string } }>(res);
    expect(body.error.rule).toBe('STORE_PRICE_NOT_APPROVED');
    expect(body.error.message).toBe(
      'The App Store charges $49.99 per month for 2 children, which isn’t PencilLift’s approved price of $49.98. This plan can’t be bought there until the store price matches.',
    );
    expect(await changeRows(fam)).toEqual([]);
    // Exact price (Google Play $49.98) and a not-yet-verified price (checked on the device) pass.
    expect(
      (await change(fam.token, { kind: 'upgrade', toSlots: 2, channel: 'play_store' })).status,
    ).toBe(201);
    expect(
      (await change(fam.token, { kind: 'upgrade', toSlots: 3, channel: 'app_store' })).status,
    ).toBe(201);
  });
});

describe('the labeled subscriber-state mock never answers outside development/test', () => {
  it('staging with the mock provider refuses to sync instead of pretending', async () => {
    const staging = await createTestApi({ APP_ENV: 'staging' });
    try {
      const fam = await seedFamily(staging.db);
      const token = await parentToken(fam.ownerId);
      const spy = vi.spyOn(staging.providers.subscriptions, 'fetchSubscriptions');
      const res = await staging.request('/v1/billing/sync', { method: 'POST', token });
      expect(res.status).toBe(503);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe('NOT_CONFIGURED');
      expect(spy).not.toHaveBeenCalled();
      // Reading the verified (empty) state is still honest and allowed.
      const status = await staging.request('/v1/billing/status', { token });
      expect(billingStatusResponseSchema.parse(await status.json()).paidSlots).toBe(0);
    } finally {
      await staging.close();
    }
  });
});
