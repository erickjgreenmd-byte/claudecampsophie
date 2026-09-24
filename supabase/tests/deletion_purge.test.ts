import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { childClaims, seedFamily, type SeededFamily } from './fixtures.ts';

let db: TestDb;

async function populate(fam: SeededFamily, childIndex = 0) {
  const childId = fam.children[childIndex]!.id;
  const [a] = await db.sql<{ id: string }[]>`
    insert into public.assignments (family_id, child_id, idempotency_key, created_by_kind) values (${fam.familyId}, ${childId}, ${'k-' + randomUUID()}, 'child') returning id`;
  const pageId = randomUUID();
  await db.sql`
    insert into public.source_pages (id, assignment_id, family_id, child_id, page_number, storage_path, mime_type, byte_size, sha256)
    values (${pageId}, ${a!.id}, ${fam.familyId}, ${childId}, 1, ${`${fam.familyId}/${childId}/${a!.id}/${pageId}.jpg`}, 'image/jpeg', 10, ${'c'.repeat(64)})`;
  const [q] = await db.sql<{ id: string }[]>`
    insert into public.extracted_questions (assignment_id, family_id, child_id, page_id, question_number, prompt_text, answer_kind, subject_key, skill)
    values (${a!.id}, ${fam.familyId}, ${childId}, ${pageId}, '1', 'Add 2+2', 'numeric', 'math', 'addition') returning id`;
  await db.sql`insert into private.question_solutions (question_id, family_id, correct_answer, worked_solution, grader_version) values (${q!.id}, ${fam.familyId}, '4', 'two plus two', 'v1')`;
  await db.sql`insert into public.child_feedback (question_id, family_id, child_id, kind, body, guard_version) values (${q!.id}, ${fam.familyId}, ${childId}, 'hint', 'Count on your fingers.', 'g1')`;
  await db.sql`
    insert into public.attempts (family_id, child_id, question_instance_id, source, subject_key, skill, attempt_number, correctness, grader_version, idempotency_key, occurred_at)
    values (${fam.familyId}, ${childId}, ${q!.id}, 'homework', 'math', 'addition', 1, 'correct', 'v1', ${'att-' + randomUUID()}, now())`;
  await db.sql`insert into public.points_ledger (family_id, child_id, kind, points, idempotency_key, actor_kind) values (${fam.familyId}, ${childId}, 'award', 5, ${'attempt:' + randomUUID()}, 'system')`;
  await db.sql`
    insert into public.billing_periods (family_id, channel, provider_period_id, kind, period_start, period_end, paid_slots, regular_amount_cents, charged_amount_cents, settlement, settled_at)
    values (${fam.familyId}, 'app_store', ${'tx-' + randomUUID()}, 'subscription_period', now(), now() + interval '1 month', 1, 3999, 3999, 'settled', now())`;
  await db.sql`
    insert into public.consent_records (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
    values (${fam.familyId}, ${fam.ownerId}, 'mock', 'mock', 'child_learning_data', 'v1', 'verified', true, now())`;
}

async function count(table: string, familyId: string): Promise<number> {
  const [row] = await db.sql.unsafe<{ n: number }[]>(
    `select count(*)::int as n from ${table} where family_id = $1`,
    [familyId],
  );
  return row!.n;
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.drop();
});

describe('family purge (AC_ACCESS_10, AC_SECURITY_05)', () => {
  it('refuses to purge a family that is not tombstoned', async () => {
    const fam = await seedFamily(db);
    await expect(
      db.asService((tx) => tx`select app.purge_family_data(${fam.familyId})`),
    ).rejects.toThrow(/must be tombstoned/);
  });

  it('removes child data, keeps financial/consent records and reports storage objects to delete', async () => {
    const fam = await seedFamily(db, { childCount: 2 });
    await populate(fam, 0);
    await populate(fam, 1);
    await db.sql`update public.families set deleted_at = now() where id = ${fam.familyId}`;
    await db.sql`insert into public.deletion_requests (family_id, scope, requested_by) values (${fam.familyId}, 'family', ${fam.ownerId})`;
    const [row] = await db.asService(
      (tx) =>
        tx<
          { r: { counts: Record<string, number>; storagePaths: string[] } }[]
        >`select app.purge_family_data(${fam.familyId}) as r`,
    );
    expect(row!.r.storagePaths).toHaveLength(2);
    for (const table of [
      'public.child_profiles',
      'public.assignments',
      'public.extracted_questions',
      'public.child_feedback',
      'public.attempts',
      'public.points_ledger',
      'public.source_pages',
      'private.question_solutions',
    ]) {
      expect(await count(table, fam.familyId)).toBe(0);
    }
    expect(await count('public.billing_periods', fam.familyId)).toBe(1 * 2);
    expect(await count('public.consent_records', fam.familyId)).toBe(2);
    const [req] = await db.sql<
      { status: string }[]
    >`select status from public.deletion_requests where family_id = ${fam.familyId}`;
    expect(req!.status).toBe('completed');
    const [family] = await db.sql<
      { display_name: string; deleted_at: Date | null }[]
    >`select display_name, deleted_at from public.families where id = ${fam.familyId}`;
    expect(family).toMatchObject({ display_name: 'Deleted family' });
    expect(family!.deleted_at).not.toBeNull();
  });

  it('a child-scoped purge removes only that child and needs an open request', async () => {
    const fam = await seedFamily(db, { childCount: 2 });
    await populate(fam, 0);
    await populate(fam, 1);
    const target = fam.children[0]!.id;
    await expect(
      db.asService((tx) => tx`select app.purge_family_data(${fam.familyId}, ${target})`),
    ).rejects.toThrow(/no open deletion request/);
    await db.sql`insert into public.deletion_requests (family_id, scope, child_id, target_child_id, requested_by) values (${fam.familyId}, 'child', ${target}, ${target}, ${fam.ownerId})`;
    await db.asService((tx) => tx`select app.purge_family_data(${fam.familyId}, ${target})`);
    const remaining = await db.sql<
      { id: string }[]
    >`select id from public.child_profiles where family_id = ${fam.familyId}`;
    expect(remaining.map((r) => r.id)).toEqual([fam.children[1]!.id]);
    expect(
      await db.asChild(childClaims(fam, 1), (tx) => tx`select id from public.child_profiles`),
    ).toHaveLength(1);
    const siblingAttempts =
      await db.sql`select id from public.attempts where child_id = ${fam.children[1]!.id}`;
    expect(siblingAttempts).toHaveLength(1);
  });

  it('append-only ledgers stay append-only outside the purge, even if a client sets the purge flag', async () => {
    const fam = await seedFamily(db);
    await populate(fam, 0);
    await expect(
      db.sql`delete from public.attempts where family_id = ${fam.familyId}`,
    ).rejects.toThrow(/append-only/);
    await expect(
      db.asService(async (tx) => {
        await tx`select set_config('pencillift.purging', 'on', true)`;
        return tx`delete from public.points_ledger where family_id = ${fam.familyId}`;
      }),
    ).rejects.toThrow(/append-only/);
  });

  it('clients cannot call the purge function', async () => {
    const fam = await seedFamily(db);
    await expect(
      db.asParent(fam.ownerId, (tx) => tx`select app.purge_family_data(${fam.familyId})`),
    ).rejects.toThrow(/permission denied/);
  });
});
