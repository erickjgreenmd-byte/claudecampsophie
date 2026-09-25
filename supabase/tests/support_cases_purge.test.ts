import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { seedFamily } from './fixtures.ts';

/**
 * Migration 0820: the family purge removes the family's support cases and their messages (0810);
 * a child-scoped purge keeps them, because a case is the parent's own account text and holds no
 * child data (the intake copy forbids child names and homework).
 */
describe('support cases and the deletion purge (0820)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });

  async function openCase(familyId: string, ownerId: string): Promise<string> {
    return db.asService(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into public.support_cases (family_id, opened_by_user_id, opened_by_kind, kind, subject, body)
        values (${familyId}, ${ownerId}, 'parent', 'complaint', 'Billing question', 'The charge looks wrong.')
        returning id`;
      await tx`
        insert into public.support_case_messages (case_id, author_kind, body, internal)
        values (${row!.id}, 'admin', 'Looking into it.', true)`;
      return row!.id;
    });
  }

  async function counts(familyId: string): Promise<{ cases: number; messages: number }> {
    return db.asService(async (tx) => {
      const [row] = await tx<{ cases: number; messages: number }[]>`
        select (select count(*) from public.support_cases where family_id = ${familyId})::int as cases,
               (select count(*) from public.support_case_messages m
                  join public.support_cases c on c.id = m.case_id
                 where c.family_id = ${familyId})::int as messages`;
      return row!;
    });
  }

  it('a family purge removes the family’s support cases and messages and reports the count', async () => {
    const fam = await seedFamily(db, { childCount: 1 });
    await openCase(fam.familyId, fam.ownerId);
    await openCase(fam.familyId, fam.ownerId);
    const other = await seedFamily(db, { childCount: 1 });
    await openCase(other.familyId, other.ownerId);
    expect(await counts(fam.familyId)).toEqual({ cases: 2, messages: 2 });

    await db.sql`update public.families set deleted_at = now() where id = ${fam.familyId}`;
    await db.sql`insert into public.deletion_requests (family_id, scope, requested_by) values (${fam.familyId}, 'family', ${fam.ownerId})`;
    const [purged] = await db.asService(
      (tx) =>
        tx<
          { r: { counts: Record<string, number> } }[]
        >`select app.purge_family_data(${fam.familyId}) as r`,
    );
    expect(purged!.r.counts['support_cases']).toBe(2);
    expect(await counts(fam.familyId)).toEqual({ cases: 0, messages: 0 });
    // Another family's cases are untouched.
    expect(await counts(other.familyId)).toEqual({ cases: 1, messages: 1 });
  });

  it('a child-scoped purge keeps the family’s support cases (parent account text, no child data)', async () => {
    const fam = await seedFamily(db, { childCount: 2 });
    await openCase(fam.familyId, fam.ownerId);
    const target = fam.children[0]!.id;
    await db.sql`insert into public.deletion_requests (family_id, scope, child_id, target_child_id, requested_by) values (${fam.familyId}, 'child', ${target}, ${target}, ${fam.ownerId})`;
    const [purged] = await db.asService(
      (tx) =>
        tx<
          { r: { counts: Record<string, number> } }[]
        >`select app.purge_family_data(${fam.familyId}, ${target}) as r`,
    );
    expect(purged!.r.counts['child_profiles']).toBe(1);
    expect(purged!.r.counts['support_cases']).toBeUndefined();
    expect(await counts(fam.familyId)).toEqual({ cases: 1, messages: 1 });
  });
});
