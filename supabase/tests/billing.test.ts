import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import {
  childClaims,
  seedChild,
  seedFamily,
  seedOwnerAdmin,
  type SeededFamily,
} from './fixtures.ts';

let db: TestDb;
let fam: SeededFamily;
let other: SeededFamily;
let adminId: string;

async function setCapacity(familyId: string, slots: number) {
  await db.sql`
    insert into public.family_capacity (family_id, paid_slots) values (${familyId}, ${slots})
    on conflict (family_id) do update set paid_slots = excluded.paid_slots
  `;
}

beforeAll(async () => {
  db = await createTestDb();
  fam = await seedFamily(db, { childCount: 3 });
  other = await seedFamily(db, { childCount: 1 });
  adminId = await seedOwnerAdmin(db);
});

afterAll(async () => {
  await db?.drop();
});

describe('paid slot capacity (AC_CAPACITY_04, AC_CAPACITY_05, AC_CAPACITY_07)', () => {
  it('cannot assign more open slots than verified paid capacity', async () => {
    await setCapacity(fam.familyId, 2);
    await db.sql`insert into public.child_slot_assignments (family_id, child_id) values (${fam.familyId}, ${fam.children[0]!.id})`;
    await db.sql`insert into public.child_slot_assignments (family_id, child_id) values (${fam.familyId}, ${fam.children[1]!.id})`;
    await expect(
      db.sql`insert into public.child_slot_assignments (family_id, child_id) values (${fam.familyId}, ${fam.children[2]!.id})`,
    ).rejects.toThrow(/paid capacity 2 exhausted/);
  });

  it('a family without verified capacity cannot assign any slot (no local boolean grants)', async () => {
    const f = await seedFamily(db);
    await expect(
      db.sql`insert into public.child_slot_assignments (family_id, child_id) values (${f.familyId}, ${f.children[0]!.id})`,
    ).rejects.toThrow(/paid capacity 0 exhausted/);
  });

  it('concurrent assignments from two guardians cannot exceed capacity', async () => {
    const f = await seedFamily(db, { childCount: 2 });
    await setCapacity(f.familyId, 1);
    const results = await Promise.allSettled(
      f.children.map(
        (c) =>
          db.sql`insert into public.child_slot_assignments (family_id, child_id) values (${f.familyId}, ${c.id})`,
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('a child holds at most one open slot', async () => {
    const f = await seedFamily(db);
    await setCapacity(f.familyId, 4);
    await db.sql`insert into public.child_slot_assignments (family_id, child_id) values (${f.familyId}, ${f.children[0]!.id})`;
    await expect(
      db.sql`insert into public.child_slot_assignments (family_id, child_id) values (${f.familyId}, ${f.children[0]!.id})`,
    ).rejects.toThrow(/child_slot_assignments_one_open/);
  });

  it('cannot assign another family child to a slot', async () => {
    await setCapacity(fam.familyId, 4);
    await expect(
      db.sql`insert into public.child_slot_assignments (family_id, child_id) values (${fam.familyId}, ${other.children[0]!.id})`,
    ).rejects.toThrow(/foreign key/);
  });
});

describe('entitlement ledger access (AC_BILLING_05, AC_CONN_06)', () => {
  it('parents can read but never write their entitlements or capacity', async () => {
    await db.sql`
      insert into public.family_entitlements (family_id, channel, provider_subscription_id, product_id, paid_slots,
        status, environment, period_start, period_end, provider_updated_at, fetched_at)
      values (${fam.familyId}, 'app_store', 'orig_tx_1', 'pl_family_2', 2, 'active', 'sandbox',
        now(), now() + interval '1 month', now(), now())
    `;
    const rows = await db.asParent(
      fam.ownerId,
      (tx) => tx`select status from public.family_entitlements`,
    );
    expect(rows).toEqual([{ status: 'active' }]);
    await expect(
      db.asParent(fam.ownerId, (tx) => tx`update public.family_entitlements set paid_slots = 4`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asParent(fam.ownerId, (tx) => tx`update public.family_capacity set paid_slots = 4`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asParent(
        fam.ownerId,
        (tx) =>
          tx`insert into public.child_slot_assignments (family_id, child_id) values (${fam.familyId}, ${fam.children[2]!.id})`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('another family cannot see these entitlements', async () => {
    const rows = await db.asParent(
      other.ownerId,
      (tx) => tx`select id from public.family_entitlements`,
    );
    expect(rows).toHaveLength(0);
  });

  it('children cannot read billing tables', async () => {
    for (const table of [
      'family_entitlements',
      'family_capacity',
      'billing_periods',
      'capacity_changes',
    ]) {
      await expect(
        db.asChild(childClaims(fam), (tx) => tx.unsafe(`select * from public.${table}`)),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('provider events are deduplicated by provider event id', async () => {
    const insert = () => db.sql`
      insert into public.billing_provider_events (provider, provider_event_id, event_type, payload_sha256)
      values ('revenuecat', 'evt_123', 'RENEWAL', ${'a'.repeat(64)})
    `;
    await insert();
    await expect(insert()).rejects.toThrow(
      /billing_provider_events_provider_provider_event_id_key/,
    );
  });
});

describe('usage reservations (AC_CAPTURE_06, AC_SECURITY_06)', () => {
  it('idempotency keys prevent a double charge for a duplicate finalize', async () => {
    const insert = () => db.sql`
      insert into public.usage_reservations (family_id, child_id, period_key, units, idempotency_key)
      values (${fam.familyId}, ${fam.children[0]!.id}, '2026-09', 2, 'scan-finalize-abc-123')
    `;
    await insert();
    await expect(insert()).rejects.toThrow(/idempotency_key/);
  });

  it('terminal states cannot change and facts are immutable', async () => {
    const [r] = await db.sql<{ id: string }[]>`
      insert into public.usage_reservations (family_id, child_id, period_key, units, idempotency_key)
      values (${fam.familyId}, ${fam.children[0]!.id}, '2026-09', 1, 'scan-finalize-def-456') returning id
    `;
    await db.sql`update public.usage_reservations set status = 'released', release_reason = 'unreadable' where id = ${r!.id}`;
    await expect(
      db.sql`update public.usage_reservations set status = 'committed', release_reason = null where id = ${r!.id}`,
    ).rejects.toThrow(/cannot become committed/);
    const [r2] = await db.sql<{ id: string }[]>`
      insert into public.usage_reservations (family_id, child_id, period_key, units, idempotency_key)
      values (${fam.familyId}, ${fam.children[0]!.id}, '2026-09', 1, 'scan-finalize-ghi-789') returning id
    `;
    await expect(
      db.sql`update public.usage_reservations set units = 0 where id = ${r2!.id}`,
    ).rejects.toThrow();
  });
});

describe('AI usage metering (P12, AC_FIN_05)', () => {
  it('usage events are append-only and owner-only', async () => {
    await db.sql`
      insert into public.ai_usage_events (family_id, stage, model_id, prompt_version, status, input_tokens,
        cached_input_tokens, output_tokens, latency_ms, cost_micros, rate_table_version)
      values (${fam.familyId}, 'extraction', 'gpt-5.6-terra', 'extract.v1', 'succeeded', 4000, 0, 1200, 900, 22400, '2026-09-18')
    `;
    await expect(db.sql`update public.ai_usage_events set cost_micros = 0`).rejects.toThrow(
      /append-only/,
    );
    const parentRows = await db.asParent(
      fam.ownerId,
      (tx) => tx`select id from public.ai_usage_events`,
    );
    expect(parentRows).toHaveLength(0);
    const adminRows = await db.asParent(
      adminId,
      (tx) => tx`select id from public.ai_usage_events`,
      { aal: 'aal2' },
    );
    expect(adminRows.length).toBeGreaterThan(0);
  });

  it('cached tokens cannot exceed input tokens (no double counting)', async () => {
    await expect(
      db.sql`
        insert into public.ai_usage_events (stage, model_id, prompt_version, status, input_tokens,
          cached_input_tokens, output_tokens, latency_ms, cost_micros, rate_table_version)
        values ('grading', 'gpt-5.6-terra', 'grade.v1', 'succeeded', 100, 200, 10, 10, 1, 'v')
      `,
    ).rejects.toThrow(/check constraint/);
  });

  it('a spend budget must be an explicit positive owner amount', async () => {
    await expect(
      db.sql`insert into public.spend_budgets (period_key, budget_micros, created_by) values ('2026-09', 0, ${adminId})`,
    ).rejects.toThrow(/check constraint/);
  });
});

describe('draft child without charge (AC_CAPACITY_03)', () => {
  it('a draft child exists without any slot or entitlement', async () => {
    const f = await seedFamily(db, { childCount: 0 });
    const draft = await seedChild(db, f.familyId, 'Avery', 'draft');
    const slots =
      await db.sql`select id from public.child_slot_assignments where child_id = ${draft.id}`;
    expect(slots).toHaveLength(0);
  });
});
