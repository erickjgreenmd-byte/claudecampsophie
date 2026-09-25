import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { seedFamily, seedOwnerAdmin, type SeededFamily } from './fixtures.ts';

// Migration 0810: support cases, thread messages and owner-operations settings. Families act as
// `authenticated` through RLS; the owner's staff act as the service role through the API. Synthetic
// families only; no case here mentions a child.

let db: TestDb;
let famA: SeededFamily;
let famB: SeededFamily;
let adminId: string;

beforeAll(async () => {
  db = await createTestDb();
  famA = await seedFamily(db, { childCount: 1 });
  famB = await seedFamily(db, { childCount: 1 });
  adminId = await seedOwnerAdmin(db);
});

afterAll(async () => {
  await db?.drop();
});

/** A settled provider billing period for a family (service role, as billing-sync writes it). */
async function seedPeriod(fam: SeededFamily, channel: string, providerPeriodId: string) {
  const [row] = await db.sql<{ id: string }[]>`
    insert into public.billing_periods (family_id, channel, provider_period_id, kind, period_start, period_end,
      paid_slots, regular_amount_cents, charged_amount_cents, settlement, settled_at)
    values (${fam.familyId}, ${channel}, ${providerPeriodId}, 'subscription_period',
            '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', 1, 3999, 3999, 'settled', '2026-09-01T00:00:00Z')
    returning id`;
  return row!.id;
}

/** Opens a case as the family's parent (the RLS insert policy is what is under test). */
async function openCase(
  fam: SeededFamily,
  overrides: Record<string, unknown> = {},
  asUser = fam.ownerId,
): Promise<string> {
  const row = {
    family_id: fam.familyId,
    opened_by_user_id: asUser,
    opened_by_kind: 'parent',
    kind: 'complaint',
    subject: 'The app logged me out twice',
    body: 'Synthetic complaint body about the account, nothing about a child.',
    ...overrides,
  };
  return db.asParent(asUser, async (tx) => {
    const [inserted] = await tx<
      { id: string }[]
    >`insert into public.support_cases ${tx(row)} returning id`;
    return inserted!.id;
  });
}

/** A service-role insert of a case with full control over the columns (staff/API path). */
function serviceCase(fam: SeededFamily, overrides: Record<string, unknown> = {}) {
  const row = {
    family_id: fam.familyId,
    opened_by_user_id: fam.ownerId,
    opened_by_kind: 'parent',
    kind: 'complaint',
    subject: 'Service-inserted case',
    body: 'Synthetic body.',
    ...overrides,
  };
  return db.asService(async (tx) => {
    const [inserted] = await tx<
      { id: string }[]
    >`insert into public.support_cases ${tx(row)} returning id`;
    return inserted!.id;
  });
}

describe('support_cases row policies (0810)', () => {
  it('a parent opens a case for their family and reads it back; another family sees nothing', async () => {
    const id = await openCase(famA);
    const mine = await db.asParent(
      famA.ownerId,
      (tx) =>
        tx<
          { id: string; status: string; priority: string; opened_by_kind: string }[]
        >`select id, status, priority, opened_by_kind from public.support_cases where id = ${id}`,
    );
    expect(mine).toEqual([{ id, status: 'open', priority: 'normal', opened_by_kind: 'parent' }]);
    const theirs = await db.asParent(
      famB.ownerId,
      (tx) => tx<{ id: string }[]>`select id from public.support_cases where id = ${id}`,
    );
    expect(theirs).toEqual([]);
    const all = await db.asParent(
      famB.ownerId,
      (tx) => tx<{ id: string }[]>`select id from public.support_cases`,
    );
    expect(all.map((r) => r.id)).not.toContain(id);
  });

  it('a parent cannot open a case for another family, as staff, as someone else, or not open', async () => {
    const rls = /row-level security|permission denied/;
    await expect(openCase(famA, { family_id: famB.familyId })).rejects.toThrow(rls);
    await expect(openCase(famA, { opened_by_kind: 'admin' })).rejects.toThrow(rls);
    await expect(openCase(famA, { opened_by_user_id: famB.ownerId })).rejects.toThrow(rls);
    // status, priority, assignee and resolution are not in the parent's insert grant.
    await expect(openCase(famA, { status: 'in_progress' })).rejects.toThrow(/permission denied/);
    await expect(openCase(famA, { priority: 'high' })).rejects.toThrow(/permission denied/);
    await expect(openCase(famA, { assignee_user_id: adminId })).rejects.toThrow(
      /permission denied/,
    );
  });

  it('a refund request names only one of the family’s own billing periods', async () => {
    await seedPeriod(famA, 'app_store', 'rls-period-a');
    await seedPeriod(famB, 'play_store', 'rls-period-b');
    const own = await openCase(famA, {
      kind: 'refund_request',
      channel: 'app_store',
      provider_period_id: 'rls-period-a',
    });
    expect(own).toBeTruthy();
    await expect(
      openCase(famA, {
        kind: 'refund_request',
        channel: 'play_store',
        provider_period_id: 'rls-period-b',
      }),
    ).rejects.toThrow(/row-level security/);
    await expect(
      openCase(famA, {
        kind: 'refund_request',
        channel: 'app_store',
        provider_period_id: 'never-charged',
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('a parent cannot change status, resolution or assignee, and cannot delete a case', async () => {
    const id = await openCase(famA);
    await expect(
      db.asParent(
        famA.ownerId,
        (tx) => tx`update public.support_cases set status = 'resolved' where id = ${id}`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asParent(
        famA.ownerId,
        (tx) => tx`update public.support_cases set subject = 'edited' where id = ${id}`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asParent(famA.ownerId, (tx) => tx`delete from public.support_cases where id = ${id}`),
    ).rejects.toThrow(/permission denied/);
    const [row] = await db.sql<
      { status: string }[]
    >`select status from public.support_cases where id = ${id}`;
    expect(row!.status).toBe('open');
  });

  it('children and anonymous callers have no access', async () => {
    const id = await openCase(famA);
    const child = famA.children[0]!;
    await expect(
      db.asChild(
        { childId: child.id, familyId: famA.familyId, sessionId: child.sessionId },
        (tx) => tx`select id from public.support_cases where id = ${id}`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asAnon((tx) => tx`select id from public.support_cases where id = ${id}`),
    ).rejects.toThrow(/permission denied/);
    await expect(db.asAnon((tx) => tx`select key from public.ops_settings`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('updated_at is touched on update (service role)', async () => {
    const id = await openCase(famA);
    const [before] = await db.sql<
      { updated_at: Date }[]
    >`select updated_at from public.support_cases where id = ${id}`;
    await db.sql`select pg_sleep(0.01)`;
    await db.asService(
      (tx) => tx`update public.support_cases set priority = 'high' where id = ${id}`,
    );
    const [after] = await db.sql<
      { updated_at: Date; priority: string }[]
    >`select updated_at, priority from public.support_cases where id = ${id}`;
    expect(after!.priority).toBe('high');
    expect(after!.updated_at.getTime()).toBeGreaterThan(before!.updated_at.getTime());
  });
});

describe('support_case_messages row policies (0810)', () => {
  it('internal staff notes are invisible to the family; public replies and own replies are visible', async () => {
    const id = await openCase(famA);
    await db.asService(
      (tx) => tx`
        insert into public.support_case_messages (case_id, author_kind, author_user_id, body, internal) values
          (${id}, 'admin', ${adminId}, 'INTERNAL: check the store receipt first', true),
          (${id}, 'admin', ${adminId}, 'Thanks, we are looking into it.', false)`,
    );
    await db.asParent(
      famA.ownerId,
      (
        tx,
      ) => tx`insert into public.support_case_messages (case_id, author_kind, author_user_id, body)
                 values (${id}, 'parent', ${famA.ownerId}, 'Thank you.')`,
    );
    const seen = await db.asParent(
      famA.ownerId,
      (tx) =>
        tx<
          { author_kind: string; body: string }[]
        >`select author_kind, body from public.support_case_messages where case_id = ${id} order by created_at`,
    );
    expect(seen).toEqual([
      { author_kind: 'admin', body: 'Thanks, we are looking into it.' },
      { author_kind: 'parent', body: 'Thank you.' },
    ]);
    expect(JSON.stringify(seen)).not.toContain('INTERNAL');
    const others = await db.asParent(
      famB.ownerId,
      (tx) =>
        tx<{ id: string }[]>`select id from public.support_case_messages where case_id = ${id}`,
    );
    expect(others).toEqual([]);
    const [total] = await db.sql<
      { n: number }[]
    >`select count(*)::int as n from public.support_case_messages where case_id = ${id}`;
    expect(total!.n).toBe(3);
  });

  it('a parent cannot write an internal note, post as staff, post as someone else, or reply on a closed case', async () => {
    const id = await openCase(famA);
    const reply = (row: Record<string, unknown>, asUser = famA.ownerId) =>
      db.asParent(
        asUser,
        (tx) =>
          tx`insert into public.support_case_messages ${tx({
            case_id: id,
            author_kind: 'parent',
            author_user_id: asUser,
            body: 'reply',
            ...row,
          })}`,
      );
    await expect(reply({ internal: true })).rejects.toThrow(/permission denied/);
    await expect(reply({ author_kind: 'admin' })).rejects.toThrow(/row-level security/);
    await expect(reply({ author_user_id: famB.ownerId })).rejects.toThrow(/row-level security/);
    await expect(reply({}, famB.ownerId)).rejects.toThrow(/row-level security/);
    await db.asService(
      (tx) =>
        tx`update public.support_cases set status = 'closed', resolved_at = now() where id = ${id}`,
    );
    await expect(reply({})).rejects.toThrow(/row-level security/);
    await db.asService(
      (tx) =>
        tx`update public.support_cases set status = 'resolved', resolution = 'answered' where id = ${id}`,
    );
    // Not closed (resolved): a reply is allowed so the family can come back on it.
    await reply({});
  });

  it('messages go with their case (cascade) and a parent cannot edit or delete them', async () => {
    const id = await openCase(famA);
    await db.asParent(
      famA.ownerId,
      (
        tx,
      ) => tx`insert into public.support_case_messages (case_id, author_kind, author_user_id, body)
                 values (${id}, 'parent', ${famA.ownerId}, 'first')`,
    );
    await expect(
      db.asParent(
        famA.ownerId,
        (tx) => tx`update public.support_case_messages set body = 'edited' where case_id = ${id}`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asParent(
        famA.ownerId,
        (tx) => tx`delete from public.support_case_messages where case_id = ${id}`,
      ),
    ).rejects.toThrow(/permission denied/);
    await db.asService((tx) => tx`delete from public.support_cases where id = ${id}`);
    const [left] = await db.sql<
      { n: number }[]
    >`select count(*)::int as n from public.support_case_messages where case_id = ${id}`;
    expect(left!.n).toBe(0);
  });
});

describe('support case shapes (0810)', () => {
  it('kinds, statuses, priorities and resolutions are closed enums', async () => {
    await expect(serviceCase(famA, { kind: 'chat' })).rejects.toThrow(/support_cases_kind_check/);
    await expect(serviceCase(famA, { status: 'pending' })).rejects.toThrow(
      /support_cases_status_check/,
    );
    await expect(serviceCase(famA, { priority: 'urgent' })).rejects.toThrow(
      /support_cases_priority_check/,
    );
    await expect(
      serviceCase(famA, {
        status: 'resolved',
        resolved_at: new Date(),
        resolution: 'refunded_by_pencillift',
      }),
    ).rejects.toThrow(/support_cases_resolution_check/);
    await expect(serviceCase(famA, { opened_by_kind: 'child' })).rejects.toThrow(
      /support_cases_opened_by_kind_check/,
    );
    for (const kind of [
      'complaint',
      'refund_request',
      'billing_issue',
      'bug',
      'safety_question',
      'other',
    ]) {
      expect(await serviceCase(famA, { kind })).toBeTruthy();
    }
  });

  it('caps the subject at 120 and the body at 2000 characters and refuses blanks', async () => {
    await expect(serviceCase(famA, { subject: 'x'.repeat(121) })).rejects.toThrow(
      /support_cases_subject_check/,
    );
    await expect(serviceCase(famA, { subject: '   ' })).rejects.toThrow(
      /support_cases_subject_check/,
    );
    await expect(serviceCase(famA, { body: 'y'.repeat(2001) })).rejects.toThrow(
      /support_cases_body_check/,
    );
    expect(
      await serviceCase(famA, { subject: 'x'.repeat(120), body: 'y'.repeat(2000) }),
    ).toBeTruthy();
    await expect(
      db.asService(
        (
          tx,
        ) => tx`insert into public.support_case_messages (case_id, author_kind, author_user_id, body)
                   values ((select id from public.support_cases limit 1), 'admin', ${adminId}, ${'z'.repeat(2001)})`,
      ),
    ).rejects.toThrow(/support_case_messages_body_check/);
  });

  it('a billing period belongs to a refund request, comes as channel plus id, and must exist', async () => {
    await expect(
      serviceCase(famA, { kind: 'complaint', channel: 'app_store', provider_period_id: 'p1' }),
    ).rejects.toThrow(/support_cases_period_kind/);
    await expect(
      serviceCase(famA, { kind: 'refund_request', channel: 'app_store' }),
    ).rejects.toThrow(/support_cases_period_shape/);
    // The link is billing_periods' own key: an unknown channel or period id is refused by the
    // foreign key, so the channel vocabulary (migration 0800) is never repeated here.
    await expect(
      serviceCase(famA, { kind: 'refund_request', channel: 'amazon', provider_period_id: 'p1' }),
    ).rejects.toThrow(/support_cases_period_fkey/);
    await expect(
      serviceCase(famA, {
        kind: 'refund_request',
        channel: 'app_store',
        provider_period_id: 'never-reported',
      }),
    ).rejects.toThrow(/support_cases_period_fkey/);
    await seedPeriod(famA, 'amazon_appstore', 'amz-1');
    const id = await serviceCase(famA, {
      kind: 'refund_request',
      channel: 'amazon_appstore',
      provider_period_id: 'amz-1',
    });
    expect(id).toBeTruthy();
    // Removing the period row clears the link and keeps the case.
    await db.sql`delete from public.billing_periods where channel = 'amazon_appstore' and provider_period_id = 'amz-1'`;
    const [row] = await db.sql<
      { channel: string | null; provider_period_id: string | null }[]
    >`select channel, provider_period_id from public.support_cases where id = ${id}`;
    expect(row).toEqual({ channel: null, provider_period_id: null });
  });

  it('resolved needs a resolution and a stamp; a Stripe refund needs its reference', async () => {
    await expect(
      serviceCase(famA, { status: 'resolved', resolved_at: new Date() }),
    ).rejects.toThrow(/support_cases_resolved_needs_resolution/);
    await expect(serviceCase(famA, { status: 'resolved', resolution: 'answered' })).rejects.toThrow(
      /support_cases_resolved_stamp/,
    );
    await expect(serviceCase(famA, { status: 'open', resolution: 'answered' })).rejects.toThrow(
      /support_cases_resolution_status/,
    );
    await expect(
      serviceCase(famA, {
        status: 'resolved',
        resolved_at: new Date(),
        resolution: 'stripe_refund_issued',
      }),
    ).rejects.toThrow(/support_cases_stripe_reference/);
    expect(
      await serviceCase(famA, {
        status: 'resolved',
        resolved_at: new Date(),
        resolution: 'stripe_refund_issued',
        resolution_reference: 're_synthetic_0001',
      }),
    ).toBeTruthy();
    expect(await serviceCase(famA, { status: 'closed', resolved_at: new Date() })).toBeTruthy();
  });

  it('a message is internal only when written by staff, and a parent message names its author', async () => {
    const id = await serviceCase(famA);
    await expect(
      db.asService(
        (
          tx,
        ) => tx`insert into public.support_case_messages (case_id, author_kind, author_user_id, body, internal)
                   values (${id}, 'parent', ${famA.ownerId}, 'x', true)`,
      ),
    ).rejects.toThrow(/support_case_messages_internal_admin/);
    await expect(
      db.asService(
        (tx) => tx`insert into public.support_case_messages (case_id, author_kind, body)
                   values (${id}, 'parent', 'x')`,
      ),
    ).rejects.toThrow(/support_case_messages_parent_author/);
    await expect(
      db.asService(
        (tx) => tx`insert into public.support_case_messages (case_id, author_kind, body)
                   values (${id}, 'system', 'x')`,
      ),
    ).rejects.toThrow(/support_case_messages_author_kind_check/);
  });
});

describe('ops_settings (0810)', () => {
  it('seeds the store fee rates: 30% for the three app stores, 0 for Stripe', async () => {
    const rows = await db.asService(
      (tx) =>
        tx<
          { key: string; value: Record<string, number> }[]
        >`select key, value from public.ops_settings`,
    );
    expect(rows).toEqual([
      {
        key: 'store_fee_rates',
        value: { app_store: 0.3, play_store: 0.3, amazon_appstore: 0.3, stripe: 0 },
      },
    ]);
  });

  it('is service-role only, and only holds JSON objects', async () => {
    await expect(
      db.asParent(famA.ownerId, (tx) => tx`select key from public.ops_settings`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asParent(adminId, (tx) => tx`select key from public.ops_settings`, { aal: 'aal2' }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asService(
        (tx) =>
          tx`insert into public.ops_settings (key, value) values ('scalar_test', '"0.3"'::text::jsonb)`,
      ),
    ).rejects.toThrow(/ops_settings_value_check/);
    await expect(
      db.asService(
        (tx) =>
          tx`insert into public.ops_settings (key, value) values ('Bad Key', '{}'::text::jsonb)`,
      ),
    ).rejects.toThrow(/ops_settings_key_check/);
    await db.asService(
      (
        tx,
      ) => tx`update public.ops_settings set value = '{"app_store": 0.15, "play_store": 0.3, "amazon_appstore": 0.3, "stripe": 0}'::text::jsonb,
                        updated_by = ${adminId} where key = 'store_fee_rates'`,
    );
    const [row] = await db.sql<
      { value: Record<string, number>; updated_by: string }[]
    >`select value, updated_by from public.ops_settings where key = 'store_fee_rates'`;
    expect(row!.value.app_store).toBe(0.15);
    expect(row!.updated_by).toBe(adminId);
  });
});
