import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { childClaims, seedFamily, type SeededFamily } from './fixtures.ts';

/**
 * Adversarial review regression for migration 0650 (learning runtime; AC_LEARNING_08, spec P8
 * "make the reviews ready in time" + RLS as the second layer, docs/Architecture.md). Synthetic
 * family: Riley (child 0).
 */

let db: TestDb;
let fam: SeededFamily;

beforeAll(async () => {
  db = await createTestDb();
  fam = await seedFamily(db, { childCount: 1 });
});

afterAll(async () => {
  await db?.drop();
});

describe('RV-learning-db-1: a review generated ahead of its release is not readable by the child before release_at', () => {
  it('pl_child cannot select an unreleased set or its questions', async () => {
    const riley = fam.children[0]!.id;
    // Jobs save reviews hours before the release instant (status 'ready', release_at in the future).
    const [set] = await db.sql<{ id: string }[]>`
      insert into public.practice_sets (family_id, child_id, kind, set_key, subject_key, review_week, status,
                                        ready_at, release_at)
      values (${fam.familyId}, ${riley}, 'thursday_review', ${'review:rv-db-1:' + riley}, 'math', '2026-W39',
              'ready', now(), now() + interval '2 hours')
      returning id`;
    await db.sql`
      insert into public.practice_items (set_id, family_id, child_id, position, subject_key, skill, category, prompt)
      values (${set!.id}, ${fam.familyId}, ${riley}, 1, 'math', 'math.multiplication_facts', 'weak',
              ${JSON.stringify({ text: 'What is 6 × 7?', choices: null, passage: null, responseFormat: 'number', unitHint: null })}::text::jsonb)`;
    const sets = await db.asChild(
      childClaims(fam, 0),
      (tx) => tx`select id from public.practice_sets where id = ${set!.id}`,
    );
    const items = await db.asChild(
      childClaims(fam, 0),
      (tx) => tx`select id, prompt from public.practice_items where set_id = ${set!.id}`,
    );
    // Actual: practice_sets_child_read / practice_items_child_read only check status, so the
    // second layer releases the whole review (questions) as soon as it is generated; only the API
    // route's own release_at filter hides it.
    expect(sets).toEqual([]);
    expect(items).toEqual([]);
  });
});
