import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { grantAdultUnlock, seedChild, seedFamily, type SeededFamily } from './fixtures.ts';

/**
 * Migration 0890 (hardening round 5, finding HUNT5-B-2) against real Postgres.
 *
 * FL-R4-01 freed the paid slot a deletion-pending child holds in the Hono handler
 * (apps/api/src/routes/privacy.ts releaseChildSlot), not in `public.request_deletion` itself — and
 * that function is granted to `authenticated` (migration 0840), so the Supabase Data API can reach
 * it with a parent's own access token. Its gates (app.is_family_member plus
 * app.has_recent_adult_unlock) are satisfiable outside the API, so a direct call archived the child,
 * revoked its sessions and enqueued the purge while the paid slot stayed assigned: the family kept
 * paying for a slot held by a child whose data was being erased, and activating a sibling answered
 * NEEDS_PAID_SLOT. This is the BUG-240 class — a write the Data API can reach that the database does
 * not backstop — so the release now happens inside the function, in the same transaction as the
 * archive. Synthetic data only.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.drop();
});

/** One paid slot bought, `Riley` active and holding it. */
async function familyWithOneFilledSlot(): Promise<{ fam: SeededFamily; childId: string }> {
  const fam = await seedFamily(db, { childCount: 0 });
  await db.sql`
    insert into public.family_capacity (family_id, paid_slots, managing_channel)
    values (${fam.familyId}, 1, 'app_store')`;
  const child = await seedChild(db, fam.familyId, 'Riley', 'active');
  await db.sql`
    insert into public.child_slot_assignments (family_id, child_id)
    values (${fam.familyId}, ${child.id})`;
  await grantAdultUnlock(db, fam.ownerId);
  return { fam, childId: child.id };
}

async function openSlots(familyId: string): Promise<number> {
  const [row] = await db.sql<{ n: number }[]>`
    select count(*)::int as n from public.child_slot_assignments
     where family_id = ${familyId} and released_at is null`;
  return row!.n;
}

// ---------------------------------------------------------------------------------------------
// HUNT5-B-2: request_deletion releases the child's paid slot itself
// ---------------------------------------------------------------------------------------------

describe('[HUNT5-B-2] public.request_deletion frees the deleted child’s paid slot', () => {
  it('releases the slot for a client-role call, the surface the API handler does not cover', async () => {
    const { fam, childId } = await familyWithOneFilledSlot();
    expect(await openSlots(fam.familyId)).toBe(1);

    // The Data API's own call: `authenticated`, the parent's claims, no API handler in the path.
    const request = await db.asParent(fam.ownerId, async (tx) => {
      const rows = await tx<{ id: string; scope: string; status: string }[]>`
        select id, scope, status from public.request_deletion(${fam.familyId}::uuid, ${childId}::uuid)`;
      return rows[0]!;
    });
    expect(request).toMatchObject({ scope: 'child', status: 'requested' });

    // The child is archived (0840) AND its slot is released, in that one transaction.
    const [child] = await db.sql<{ status: string }[]>`
      select status from public.child_profiles where id = ${childId}`;
    expect(child!.status).toBe('archived');
    const [slot] = await db.sql<{ released_at: Date | null; release_reason: string | null }[]>`
      select released_at, release_reason from public.child_slot_assignments
       where family_id = ${fam.familyId} and child_id = ${childId}`;
    expect(slot!.released_at).not.toBeNull();
    // The same reason the archive route and the API-side statement use; a distinct 'deletion' value
    // would need the release_reason check constraint widened (migration 0200).
    expect(slot!.release_reason).toBe('archived');
    expect(await openSlots(fam.familyId)).toBe(0);
  });

  it('leaves an already-released assignment alone, so the API-side statement stays a no-op', async () => {
    const { fam, childId } = await familyWithOneFilledSlot();
    // The slot was already freed (a downgrade), so the deletion must not rewrite its reason or its
    // instant: the release is `released_at is null` only.
    await db.sql`
      update public.child_slot_assignments set released_at = now() - interval '1 day',
             release_reason = 'downgrade'
       where family_id = ${fam.familyId} and child_id = ${childId}`;
    const [before] = await db.sql<{ released_at: Date }[]>`
      select released_at from public.child_slot_assignments
       where family_id = ${fam.familyId} and child_id = ${childId}`;

    await db.asParent(
      fam.ownerId,
      (tx) => tx`select id from public.request_deletion(${fam.familyId}::uuid, ${childId}::uuid)`,
    );

    const [after] = await db.sql<{ released_at: Date; release_reason: string }[]>`
      select released_at, release_reason from public.child_slot_assignments
       where family_id = ${fam.familyId} and child_id = ${childId}`;
    expect(after!.release_reason).toBe('downgrade');
    expect(after!.released_at.getTime()).toBe(before!.released_at.getTime());
  });

  it('frees the slot for a sibling: the capacity trigger accepts the next assignment at once', async () => {
    const { fam, childId } = await familyWithOneFilledSlot();
    const sibling = await seedChild(db, fam.familyId, 'Sam', 'draft');

    await db.asParent(
      fam.ownerId,
      (tx) => tx`select id from public.request_deletion(${fam.familyId}::uuid, ${childId}::uuid)`,
    );

    // app.enforce_slot_capacity would raise P0001 ("paid capacity 1 exhausted") while the deleted
    // child still held the only slot — the NEEDS_PAID_SLOT the parent was told to buy their way out
    // of.
    await db.sql`
      insert into public.child_slot_assignments (family_id, child_id)
      values (${fam.familyId}, ${sibling.id})`;
    expect(await openSlots(fam.familyId)).toBe(1);
  });

  it('does not touch the slots of a whole-family deletion, which the purge clears', async () => {
    const { fam, childId } = await familyWithOneFilledSlot();

    await db.asParent(
      fam.ownerId,
      (tx) => tx`select id from public.request_deletion(${fam.familyId}::uuid, null::uuid)`,
    );

    // A family-scope request tombstones the family and revokes every membership in the same
    // transaction, so no route reads that family's capacity again and no sibling can be blocked;
    // the purge deletes the assignment rows with the rest (0620).
    const [fam_row] = await db.sql<{ deleted_at: Date | null }[]>`
      select deleted_at from public.families where id = ${fam.familyId}`;
    expect(fam_row!.deleted_at).not.toBeNull();
    const [slot] = await db.sql<{ released_at: Date | null }[]>`
      select released_at from public.child_slot_assignments
       where family_id = ${fam.familyId} and child_id = ${childId}`;
    expect(slot!.released_at).toBeNull();
  });
});
