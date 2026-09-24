import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { seedFamily, seedOwnerAdmin } from './fixtures.ts';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.drop();
});

describe('safety report least privilege (migration 0670)', () => {
  it('an MFA owner admin cannot read family reports or notes through RLS', async () => {
    const fam = await seedFamily(db);
    await db.sql`
      insert into public.safety_reports (family_id, reporter_kind, category, note)
      values (${fam.familyId}, 'parent', 'other', 'synthetic note about a worksheet')`;
    const adminId = await seedOwnerAdmin(db);
    const rows = await db.asParent(
      adminId,
      (tx) => tx`select id, note from public.safety_reports`,
      {
        aal: 'aal2',
      },
    );
    expect(rows).toEqual([]);
    const own = await db.asParent(fam.ownerId, (tx) => tx`select note from public.safety_reports`);
    expect(own).toHaveLength(1);
  });

  it('a report linked to a question must name its child', async () => {
    const fam = await seedFamily(db);
    await expect(
      db.sql`
        insert into public.safety_reports (family_id, reporter_kind, category, question_id)
        values (${fam.familyId}, 'parent', 'wrong_or_confusing', gen_random_uuid())`,
    ).rejects.toThrow(/safety_reports_linked_item_has_child|violates/);
  });
});
