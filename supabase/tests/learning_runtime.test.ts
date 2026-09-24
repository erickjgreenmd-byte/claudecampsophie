import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { childClaims, seedFamily, type SeededFamily } from './fixtures.ts';

/**
 * Migration 0650 (learning runtime): database-maintained schedule versions (review job keys,
 * spec P8), child column grants for the release instant and intro only, and purge compatibility.
 * Synthetic family: Riley (child 0) and Sam (child 1).
 */

let db: TestDb;
let fam: SeededFamily;

async function version(childId: string): Promise<number> {
  const [row] = await db.sql<{ schedule_version: number }[]>`
    select schedule_version from public.learning_schedules where child_id = ${childId}`;
  return row!.schedule_version;
}

async function subject(childId: string, familyId: string, key = 'math'): Promise<string> {
  const [row] = await db.sql<{ id: string }[]>`
    insert into public.child_subjects (family_id, child_id, subject_key, display_name)
    values (${familyId}, ${childId}, ${key}, ${key + '-' + childId.slice(0, 4)}) returning id`;
  return row!.id;
}

beforeAll(async () => {
  db = await createTestDb();
  fam = await seedFamily(db, { childCount: 2 });
  for (const child of fam.children) {
    await db.sql`insert into public.learning_schedules (child_id, family_id) values (${child.id}, ${fam.familyId})`;
  }
});

afterAll(async () => {
  await db?.drop();
});

describe('schedule_version is maintained by the database (spec P8)', () => {
  it('changing the review day or time bumps the version; other settings do not', async () => {
    const riley = fam.children[0]!.id;
    const before = await version(riley);
    await db.asParent(
      fam.ownerId,
      (tx) => tx`
      update public.learning_schedules set daily_question_count = 7 where child_id = ${riley}`,
    );
    expect(await version(riley)).toBe(before);
    await db.asParent(
      fam.ownerId,
      (tx) => tx`
      update public.learning_schedules set review_weekday = 3 where child_id = ${riley}`,
    );
    expect(await version(riley)).toBe(before + 1);
    await db.asParent(
      fam.ownerId,
      (tx) => tx`
      update public.learning_schedules set review_local_time = '17:30' where child_id = ${riley}`,
    );
    expect(await version(riley)).toBe(before + 2);
  });

  it('a parent cannot set the version directly', async () => {
    const riley = fam.children[0]!.id;
    await expect(
      db.asParent(
        fam.ownerId,
        (tx) => tx`
        update public.learning_schedules set schedule_version = 99 where child_id = ${riley}`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('adding or removing a test date bumps only that child’s version', async () => {
    const [riley, sam] = [fam.children[0]!.id, fam.children[1]!.id];
    const math = await subject(riley, fam.familyId);
    const rileyBefore = await version(riley);
    const samBefore = await version(sam);
    const [row] = await db.asParent(
      fam.ownerId,
      (tx) => tx<{ id: string }[]>`
      insert into public.test_dates (family_id, child_id, subject_id, test_date, scope_notes)
      values (${fam.familyId}, ${riley}, ${math}, '2026-10-02', 'fractions') returning id`,
    );
    expect(await version(riley)).toBe(rileyBefore + 1);
    await db.asParent(fam.ownerId, (tx) => tx`delete from public.test_dates where id = ${row!.id}`);
    expect(await version(riley)).toBe(rileyBefore + 2);
    expect(await version(sam)).toBe(samBefore);
  });

  it('the trigger function is not callable by client roles', async () => {
    const [row] = await db.sql<{ anon: boolean; parent: boolean; child: boolean }[]>`
      select has_function_privilege('anon', 'app.bump_schedule_version_on_test_date()', 'EXECUTE') as anon,
             has_function_privilege('authenticated', 'app.bump_schedule_version_on_test_date()', 'EXECUTE') as parent,
             has_function_privilege('pl_child', 'app.bump_schedule_version_on_test_date()', 'EXECUTE') as child`;
    expect(row).toEqual({ anon: false, parent: false, child: false });
  });
});

describe('practice set columns for children (AC_GRADING_06)', () => {
  it('a child reads the release instant and intro but not the parent notes, mix or cutoff', async () => {
    const riley = fam.children[0]!.id;
    await db.sql`
      insert into public.practice_sets (family_id, child_id, kind, set_key, status, release_at, child_intro, notes)
      values (${fam.familyId}, ${riley}, 'daily', ${'daily:' + riley + ':2026-09-24'}, 'ready', now() - interval '1 hour',
              'Let us warm up!', ${JSON.stringify([{ code: 'X', message: 'parent note' }])}::text::jsonb)`;
    const rows = await db.asChild(
      childClaims(fam, 0),
      (tx) => tx<{ release_at: Date; child_intro: string }[]>`
      select release_at, child_intro from public.practice_sets where child_id = ${riley}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.child_intro).toBe('Let us warm up!');
    for (const column of ['notes', 'mix', 'evidence_cutoff_at', 'set_key']) {
      await expect(
        db.asChild(childClaims(fam, 0), (tx) =>
          tx.unsafe(`select ${column} from public.practice_sets`),
        ),
      ).rejects.toThrow(/permission denied/);
    }
    // A sibling sees nothing of Riley's sets.
    const sibling = await db.asChild(
      childClaims(fam, 1),
      (tx) => tx`
      select id from public.practice_sets where child_id = ${riley}`,
    );
    expect(sibling).toEqual([]);
  });

  it('an intro longer than 200 characters is rejected', async () => {
    const riley = fam.children[0]!.id;
    await expect(
      db.sql`insert into public.practice_sets (family_id, child_id, kind, set_key, child_intro)
             values (${fam.familyId}, ${riley}, 'daily', 'daily:long-intro', ${'x'.repeat(201)})`,
    ).rejects.toThrow(/check constraint/);
  });
});

describe('release instant as the second layer (spec P8; RV-learning-db-1)', () => {
  it('a child reads a review and its questions only from release_at on (DB clock or the API request instant)', async () => {
    const riley = fam.children[0]!.id;
    const [set] = await db.sql<{ id: string }[]>`
      insert into public.practice_sets (family_id, child_id, kind, set_key, subject_key, review_week, status,
                                        ready_at, release_at)
      values (${fam.familyId}, ${riley}, 'thursday_review', ${'review:release-layer:' + riley}, 'math', '2026-W39',
              'ready', now(), now() + interval '3 hours')
      returning id`;
    await db.sql`
      insert into public.practice_items (set_id, family_id, child_id, position, subject_key, skill, category, prompt)
      values (${set!.id}, ${fam.familyId}, ${riley}, 1, 'math', 'math.multiplication_facts', 'weak',
              ${JSON.stringify({ text: 'What is 3 × 4?' })}::text::jsonb)`;
    const read = (instant: string | null) =>
      db.asChild(childClaims(fam, 0), async (tx) => {
        if (instant !== null)
          await tx`select set_config('pencillift.request_now', ${instant}, true)`;
        const sets = await tx`select id from public.practice_sets where id = ${set!.id}`;
        const items = await tx`select id from public.practice_items where set_id = ${set!.id}`;
        return { sets: sets.length, items: items.length };
      });
    // Database clock: not released yet.
    expect(await read(null)).toEqual({ sets: 0, items: 0 });
    // The API's request instant before and after the release.
    const [times] = await db.sql<{ before: Date; after: Date }[]>`
      select now() + interval '2 hours' as before, now() + interval '4 hours' as after`;
    expect(await read(times!.before.toISOString())).toEqual({ sets: 0, items: 0 });
    expect(await read(times!.after.toISOString())).toEqual({ sets: 1, items: 1 });
    // Released or not, a sibling never sees Riley's review.
    const sibling = await db.asChild(childClaims(fam, 1), async (tx) => {
      await tx`select set_config('pencillift.request_now', ${times!.after.toISOString()}, true)`;
      return tx`select id from public.practice_sets where id = ${set!.id}`;
    });
    expect(sibling).toEqual([]);
  });
});

describe('purge compatibility (AC_ACCESS_10)', () => {
  it('a family purge removes test dates without the version trigger getting in the way', async () => {
    const other = await seedFamily(db, { childCount: 1 });
    const child = other.children[0]!.id;
    await db.sql`insert into public.learning_schedules (child_id, family_id) values (${child}, ${other.familyId})`;
    const math = await subject(child, other.familyId);
    await db.sql`insert into public.test_dates (family_id, child_id, subject_id, test_date) values (${other.familyId}, ${child}, ${math}, '2026-10-09')`;
    await db.sql`update public.families set deleted_at = now() where id = ${other.familyId}`;
    await db.sql`insert into public.deletion_requests (family_id, scope, requested_by) values (${other.familyId}, 'family', ${other.ownerId})`;
    await db.asService((tx) => tx`select app.purge_family_data(${other.familyId})`);
    const left = await db.sql`select id from public.test_dates where family_id = ${other.familyId}
                              union all select child_id from public.learning_schedules where family_id = ${other.familyId}`;
    expect(left).toEqual([]);
  });
});
