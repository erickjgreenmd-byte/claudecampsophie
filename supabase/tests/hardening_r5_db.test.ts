import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

// ---------------------------------------------------------------------------------------------
// HUNT6-B-2: request_deletion withdraws the family's finished exports itself
// ---------------------------------------------------------------------------------------------

/**
 * Migration 0920 (hardening round 6, finding HUNT6-B-2).
 *
 * 0890's L-037 sweep moved ONE handler-only effect into the function and left the other. The export
 * withdrawal (apps/api/src/routes/privacy.ts withdrawExports) still ran only in the Hono handler, so
 * a child-scope request_deletion filed through the Data API — which leaves the family live and the
 * caller's membership active — left every finished export that holds that child's homework,
 * transcriptions, results and safety-notice rows at status 'ready' with its storage_path. The
 * download route refuses only a non-ready row (apps/api/src/routes/export-download.ts), so
 * GET /v1/exports/:id/download kept minting signed URLs for it until the deletion_purge job ran, and
 * for ever if that job dead-lettered — while privacy.ts stated the withdrawal with no qualifier.
 * The status half lives in the function now; removing the files stays the handler's and the purge's.
 * Synthetic data only.
 */
describe('[HUNT6-B-2] public.request_deletion withdraws the deleted child’s finished exports', () => {
  /** A finished export file in private storage, as the export_build job leaves one. */
  async function readyExport(
    familyId: string,
    ownerId: string,
    childId: string | null,
    kind = 'family_data',
  ): Promise<string> {
    const [row] = await db.sql<{ id: string }[]>`
      insert into public.data_exports (family_id, requested_by, kind, child_id, status,
                                       storage_path, expires_at)
      values (${familyId}, ${ownerId}, ${kind}, ${childId}, 'ready',
              ${'exports/synthetic-' + kind + '-' + (childId ?? 'family') + '.json'},
              now() + interval '7 days')
      returning id`;
    return row!.id;
  }

  async function exportRow(id: string) {
    const [row] = await db.sql<
      { status: string; storage_path: string | null; lapsed: boolean | null }[]
    >`
      select status, storage_path, expires_at <= now() as lapsed
        from public.data_exports where id = ${id}`;
    return row!;
  }

  it('expires the child’s and the family-wide exports for a client-role call', async () => {
    const { fam, childId } = await familyWithOneFilledSlot();
    const sibling = await seedChild(db, fam.familyId, 'Sam', 'active');
    const childExport = await readyExport(fam.familyId, fam.ownerId, childId);
    // A family-wide export lists every child, so it holds the deleted child's rows too.
    const familyWide = await readyExport(fam.familyId, fam.ownerId, null);
    const siblingExport = await readyExport(fam.familyId, fam.ownerId, sibling.id, 'progress_pdf');
    // A FAMILY-WIDE export that is still building when a CHILD's deletion lands (HUNT7-D-1). This
    // function leaves it alone, and the reason is not 0920/0930's — theirs was "the builder already
    // leaves out every child with an open deletion request", which is false of a file the builder had
    // already composed. The reason is a division of labour: whether this row is safe depends on what
    // its bytes contain, which this function cannot see and the builder can. The builder's settle
    // compares the requests open at publish time against the snapshot the bytes were composed from,
    // so it publishes a file that already leaves the child out and refuses one that does not
    // (apps/api/tests/privacy-r2.review.test.ts). Failing the row here instead would destroy every
    // family export a parent had in flight, which spec P4 says must stay deliverable minus the
    // deleted child (apps/api/tests/export-build.test.ts).
    const [queued] = await db.sql<{ id: string }[]>`
      insert into public.data_exports (family_id, requested_by, kind, child_id, status)
      values (${fam.familyId}, ${fam.ownerId}, 'family_data', null, 'queued')
      returning id`;
    // And the sibling's own queued export, which this child's deletion must NOT settle: it carries
    // no row of the deleted child (progressRows excludes them and its child_id is the sibling's).
    const [siblingQueued] = await db.sql<{ id: string }[]>`
      insert into public.data_exports (family_id, requested_by, kind, child_id, status)
      values (${fam.familyId}, ${fam.ownerId}, 'progress_pdf', ${sibling.id}, 'queued')
      returning id`;
    // And the DELETED child's own queued export, which needs no file inspection to judge: the export is
    // about the child whose data is going, so this function settles it here.
    const [childQueued] = await db.sql<{ id: string }[]>`
      insert into public.data_exports (family_id, requested_by, kind, child_id, status)
      values (${fam.familyId}, ${fam.ownerId}, 'progress_csv', ${childId}, 'queued')
      returning id`;

    // The Data API's own call: `authenticated`, the parent's claims, no API handler in the path.
    await db.asParent(
      fam.ownerId,
      (tx) => tx`select id from public.request_deletion(${fam.familyId}::uuid, ${childId}::uuid)`,
    );

    // Before 0920 both of these were still ('ready', <path>) and export-download.ts minted a signed
    // URL for either one.
    expect(await exportRow(childExport)).toMatchObject({ status: 'expired', lapsed: true });
    expect(await exportRow(familyWide)).toMatchObject({ status: 'expired', lapsed: true });
    // The storage object is still named: removing the file is the handler's half (withdrawExports)
    // and the purge job's, and the row stays refusable meanwhile.
    expect((await exportRow(childExport)).storage_path).not.toBeNull();
    // Scoped: the sibling's export is not this child's deletion to withdraw.
    expect(await exportRow(siblingExport)).toMatchObject({ status: 'ready' });
    expect(await exportRow(siblingQueued!.id)).toMatchObject({ status: 'queued' });

    // The family-wide queued row is LEFT for the builder, which is the only party that can judge it.
    expect(await exportRow(queued!.id)).toMatchObject({ status: 'queued', storage_path: null });

    // HUNT7-D-1: the DELETED CHILD's OWN queued export is settled here, in the same transaction as the
    // request, because no file's contents are needed to judge it — the export is about that child. So
    // the builder's own compare-and-set can never publish it. The statement below IS the builder's
    // settle (apps/api/src/jobs/export-build.ts, `where id = .. and status = 'queued'`), run here
    // exactly as the job would run it a moment after the deletion committed — the window 0960 exists to
    // close. Before 0960 it returned the row, and export-download.ts then served a signed URL for a
    // file holding the deleted child's homework for seven days.
    const settled = await db.sql<{ id: string }[]>`
      update public.data_exports
         set status = 'ready', storage_path = 'exports/synthetic-late.json',
             expires_at = now() + interval '7 days'
       where id = ${childQueued!.id} and family_id = ${fam.familyId} and status = 'queued'
      returning id`;
    expect(settled).toEqual([]);
    expect(await exportRow(childQueued!.id)).toMatchObject({
      status: 'failed',
      storage_path: null,
    });
  });

  it('expires every finished export of a whole-family deletion and leaves an expired one untouched', async () => {
    const { fam, childId } = await familyWithOneFilledSlot();
    const ready = await readyExport(fam.familyId, fam.ownerId, childId);
    // A row whose link already lapsed but whose FILE is still in storage. The earlier version of
    // this case said the function must "keep withdrawing" it "so the handler and the purge still
    // have a path to remove", and the predicate carried an arm for it. That is not something this
    // statement can do: it has no `returning`, it feeds nothing, and the row is already refused by
    // its status — so on such a row the arm only locked it and wrote back a row version identical to
    // the one it read. The arm that earns its place is the HANDLER's copy of this statement
    // (withdrawExports), whose `returning id, storage_path` is what removes the object. Here the row
    // must be left alone, which `xmin` is the observable for.
    const [stale] = await db.sql<{ id: string }[]>`
      insert into public.data_exports (family_id, requested_by, kind, child_id, status,
                                       storage_path, expires_at)
      values (${fam.familyId}, ${fam.ownerId}, 'progress_csv', ${childId}, 'expired',
              'exports/synthetic-stale.csv', now() - interval '1 day')
      returning id`;
    const [before] = await db.sql<{ expires_at: Date; xmin: string }[]>`
      select expires_at, xmin::text as xmin from public.data_exports where id = ${stale!.id}`;

    await db.asParent(
      fam.ownerId,
      (tx) => tx`select id from public.request_deletion(${fam.familyId}::uuid, null::uuid)`,
    );

    expect(await exportRow(ready)).toMatchObject({ status: 'expired', lapsed: true });
    const after = await exportRow(stale!.id);
    // Still refused for download, and its file is still named for the handler and the purge.
    expect(after).toMatchObject({ status: 'expired', lapsed: true });
    expect(after.storage_path).toBe('exports/synthetic-stale.csv');
    const [now] = await db.sql<{ expires_at: Date; xmin: string }[]>`
      select expires_at, xmin::text as xmin from public.data_exports where id = ${stale!.id}`;
    // An expiry already in the past is not pushed forward ...
    expect(now!.expires_at.getTime()).toBe(before!.expires_at.getTime());
    // ... and the row is not rewritten at all: no new row version, so no row lock was taken on it
    // inside the deletion transaction either.
    expect(now!.xmin).toBe(before!.xmin);
  });
});

// ---------------------------------------------------------------------------------------------
// HUNT6-B-3: request_deletion takes the slot assignment before the child profile
// ---------------------------------------------------------------------------------------------

/**
 * Migration 0930 (hardening round 6, finding HUNT6-B-3).
 *
 * BUG-106 and FL-R4-02 settled that every writer of a family's rows takes them in one order. 0890
 * added a writer that did not: its child branch updates public.child_profiles and THEN
 * public.child_slot_assignments, while every other writer of that pair goes the other way —
 * apps/api/src/routes/family.ts's archive route (the open assignment, then the profile),
 * apps/api/src/services/billing-sync.ts (applyCapacity releases the excess assignments, then
 * releaseSlotlessProfiles moves those children back to 'draft') and the purges (0620, 0710, 0820).
 *
 * The premise these cases were FIRST written on was false, and this is the correction. It said the
 * store's downgrade webhook "runs with no family `for update` at all" and holds only the KEY SHARE
 * its own inserts take, so the billing writer could interleave with the deletion and close a cycle
 * that the archive route (which does hold `for update`) cannot. Every production billing writer holds
 * it: reconcileFamilyBilling owns both applyCapacity's release and releaseSlotlessProfiles and states
 * the precondition itself ("Must run inside a transaction that already holds the family row lock"),
 * and all three of its callers meet it with `select ... from public.families ... for update` —
 * lockLiveFamily on the RevenueCat webhook (apps/api/src/routes/webhooks.ts), POST /v1/billing/sync
 * (apps/api/src/routes/billing.ts) and syncFamilyFromProvider for the billing tick.
 *
 * So the deadlock 0930 was justified by was NOT reachable by that path, and the first two cases pin
 * what is true instead: FOR UPDATE on the family row conflicts with the FOR KEY SHARE that
 * request_deletion's first statement — the insert into public.deletion_requests — needs for its
 * foreign key, so against the billing writer and against the archive route alike the deletion waits
 * before it has written ANY child row, whatever order its child statements are in.
 *
 * 0930 therefore stands as a DEFENSIVE ordering, and the third case is what it defends against: a
 * writer that reaches the family row in a mode that does not conflict with FOR KEY SHARE —
 * `for no key update`, which apps/api/src/routes/family.ts's lockFamily takes on purpose — and then
 * writes both child rows. No production writer has that shape today, so no deadlock is reachable;
 * with 0890's order one would deadlock, and that case goes red if these two statements are swapped
 * back.
 */
describe('[HUNT6-B-3] public.request_deletion takes the slot assignment before the child profile', () => {
  /** Waits until a backend on this database is blocked on a lock, and returns its granted writes. */
  async function blockedWriter(): Promise<string> {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const [row] = await db.sql<{ writes: string | null }[]>`
        select (select string_agg(distinct c.relname, ',' order by c.relname)
                  from pg_locks l join pg_class c on c.oid = l.relation
                 where l.pid = a.pid and l.granted and l.mode = 'RowExclusiveLock'
                   and c.relkind = 'r') as writes
          from pg_stat_activity a
         where a.datname = current_database() and a.wait_event_type = 'Lock'
           and a.query like '%request_deletion%'`;
      if (row) return row.writes ?? '';
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('request_deletion never blocked: the interleaving did not happen');
  }

  it('waits on the family row before writing any child row when the store release holds it', async () => {
    const { fam, childId } = await familyWithOneFilledSlot();
    let slotReleased!: () => void;
    const released = new Promise<void>((resolve) => {
      slotReleased = resolve;
    });
    let allowProfiles!: () => void;
    const profilesAllowed = new Promise<void>((resolve) => {
      allowProfiles = resolve;
    });

    // Connection 1 replays the store-downgrade path statement for statement, in its order and with
    // its real lock: `for update` on the family row, which is reconcileFamilyBilling's stated
    // precondition and what lockLiveFamily (routes/webhooks.ts), POST /v1/billing/sync
    // (routes/billing.ts) and syncFamilyFromProvider all take before calling it. Then applyCapacity's
    // release of the excess assignment, then releaseSlotlessProfiles' write of the child profile.
    const downgrade = db.sql.begin(async (tx) => {
      await tx`select 1 from public.families where id = ${fam.familyId} for update`;
      await tx`update public.child_slot_assignments set released_at = now(), release_reason = 'downgrade'
                where family_id = ${fam.familyId} and child_id = ${childId} and released_at is null`;
      slotReleased();
      await profilesAllowed;
      await tx`update public.child_profiles set status = 'draft'
                where id = ${childId} and family_id = ${fam.familyId}`;
    });

    await released;
    // Connection 2 is the deletion, as the Data API calls it.
    const deletion = db.asParent(
      fam.ownerId,
      (tx) => tx<{ id: string }[]>`
        select id from public.request_deletion(${fam.familyId}::uuid, ${childId}::uuid)`,
    );
    // The assertion this case used to make was `not.toContain('child_profiles')` with connection 1
    // holding only `for key share`, on the premise that the downgrade webhook takes no `for update`.
    // It does. With the real lock the deletion never reaches a child row at all: it waits inside the
    // foreign-key check of its FIRST statement, so its only granted write is on deletion_requests and
    // the order of its child statements cannot matter. That is why the billing path could not have
    // deadlocked either way, and it is what the migration now says.
    let writes: string;
    try {
      writes = await blockedWriter();
    } finally {
      allowProfiles();
    }
    expect(writes).toBe('deletion_requests');

    const [, request] = await Promise.all([downgrade, deletion]);
    expect(request[0]!.id).toBeTruthy();
    expect(await openSlots(fam.familyId)).toBe(0);
  });

  it('waits on the family row before writing any child row when an archive holds it', async () => {
    // Why the finding's own interleaving — the archive route — cannot deadlock, pinned rather than
    // argued: the archive route takes the family row `for update`, and request_deletion's FIRST
    // statement needs a KEY SHARE on it for public.deletion_requests' foreign key. So the deletion
    // blocks with nothing but deletion_requests written, whatever order its child statements are in.
    const { fam, childId } = await familyWithOneFilledSlot();
    let locked!: () => void;
    const held = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let allowRest!: () => void;
    const restAllowed = new Promise<void>((resolve) => {
      allowRest = resolve;
    });
    const archive = db.sql.begin(async (tx) => {
      await tx`select 1 from public.families where id = ${fam.familyId} for update`;
      await tx`update public.child_slot_assignments set released_at = now(), release_reason = 'archived'
                where family_id = ${fam.familyId} and child_id = ${childId} and released_at is null`;
      locked();
      await restAllowed;
      await tx`update public.child_profiles set status = 'archived', archived_at = now()
                where id = ${childId} and family_id = ${fam.familyId}`;
    });
    await held;
    const deletion = db.asParent(
      fam.ownerId,
      (tx) => tx<{ id: string }[]>`
        select id from public.request_deletion(${fam.familyId}::uuid, ${childId}::uuid)`,
    );
    let writes: string;
    try {
      writes = await blockedWriter();
    } finally {
      allowRest();
    }
    expect(writes).toBe('deletion_requests');
    const [, request] = await Promise.all([archive, deletion]);
    expect(request[0]!.id).toBeTruthy();
  });

  it('keeps the canonical order against a writer that does not serialise on the family row', async () => {
    // This is what the defensive ordering is FOR, and connection 1 is a LABELLED SYNTHETIC writer:
    // no production writer of this pair has its shape, which is exactly why no deadlock is reachable
    // today. What is real is the MODE. `for no key update` does not conflict with the FOR KEY SHARE
    // that request_deletion's insert into public.deletion_requests needs, so a holder of it lets the
    // deletion straight through to the child rows — and the tree already takes that mode on this row
    // on purpose: lockFamily(.., 'no-key-update') at apps/api/src/routes/family.ts, so the child
    // pairing redeem path's own FK locks are not blocked. That route locks child_profiles and never
    // writes child_slot_assignments, so it closes no cycle; a writer of the same shape that also
    // released the slot would, against 0890's order. With 0930's order the two agree statement for
    // statement and serialise instead.
    const { fam, childId } = await familyWithOneFilledSlot();
    let slotReleased!: () => void;
    const released = new Promise<void>((resolve) => {
      slotReleased = resolve;
    });
    let allowProfiles!: () => void;
    const profilesAllowed = new Promise<void>((resolve) => {
      allowProfiles = resolve;
    });
    const writer = db.sql.begin(async (tx) => {
      await tx`select 1 from public.families where id = ${fam.familyId} for no key update`;
      await tx`update public.child_slot_assignments set released_at = now(), release_reason = 'downgrade'
                where family_id = ${fam.familyId} and child_id = ${childId} and released_at is null`;
      slotReleased();
      await profilesAllowed;
      await tx`update public.child_profiles set status = 'draft'
                where id = ${childId} and family_id = ${fam.familyId}`;
    });
    await released;
    const deletion = db.asParent(
      fam.ownerId,
      (tx) => tx<{ id: string }[]>`
        select id from public.request_deletion(${fam.familyId}::uuid, ${childId}::uuid)`,
    );
    // The deletion is inside the family row's KEY SHARE and waiting for the assignment row connection
    // 1 holds. With 0890's order it would ALREADY have written public.child_profiles by now, which is
    // the inversion: releasing connection 1 then closes the cycle and Postgres aborts one of the two
    // with 40P01 — the 503 "The service is busy. Please try again." of BUG-106 and FL-R4-02, with a
    // purge that never started leaving the request at 'requested'.
    let writes: string;
    try {
      writes = await blockedWriter();
    } finally {
      // Always release connection 1, so a red assertion reds THIS case instead of hanging afterAll.
      allowProfiles();
    }
    const [writerOutcome, deletionOutcome] = await Promise.allSettled([writer, deletion]);
    const codes = [writerOutcome, deletionOutcome].map((r) =>
      r.status === 'rejected' ? ((r.reason as { code?: string }).code ?? 'error') : 'ok',
    );
    // Swap the two statements back and this is [ 'ok', '40P01' ]: Postgres aborts one of the two.
    expect(codes).toEqual(['ok', 'ok']);
    // And the mechanism behind that outcome, not only the outcome: at the moment it was blocked the
    // deletion had not yet written public.child_profiles, so it held nothing connection 1 wanted.
    expect(writes.split(',')).not.toContain('child_profiles');
    expect(deletionOutcome.status === 'fulfilled' && deletionOutcome.value[0]!.id).toBeTruthy();
    expect(await openSlots(fam.familyId)).toBe(0);
    // And the deletion's own archive still landed, after the synthetic writer's 'draft'.
    const [child] = await db.sql<{ status: string }[]>`
      select status from public.child_profiles where id = ${childId}`;
    expect(child!.status).toBe('archived');
  });
});

// ---------------------------------------------------------------------------------------------
// HUNT7-D-2: what the writers of these rows agree on, and what they do not
// ---------------------------------------------------------------------------------------------

/**
 * HUNT7-D-2. Migration 0930 defines "the canonical order" for this codebase, and it used to tell its
 * reader that the archive route, the billing writers and the purges "now agree with this function
 * statement for statement". They do not, outside the pair {child_slot_assignments, child_profiles}:
 * `public.request_deletion` revokes sessions and devices BEFORE that pair and the archive route writes
 * them AFTER it. Nothing is reachable as a deadlock, because every one of these writers serialises on
 * the family row first — which the interleaving case above proves for the one that is hardest to
 * believe — but a reader who took the statement-for-statement claim at face value would conclude that
 * copying this function's sequence is what keeps a new writer safe. It is not; taking the family row
 * first is.
 *
 * 0930's comment now says exactly that, including WHICH writers differ and where. A comment asserting a
 * disagreement can rot in the other direction — someone makes them agree and the comment becomes false
 * again — so the disagreement is pinned here, along with the agreement that is claimed. If a later
 * change reorders either writer, one of these goes red and 0930's comment gets rewritten with it.
 */
describe('[HUNT7-D-2] 0930’s claim about the other writers is pinned in both directions', () => {
  /** The order the tables of interest are first written in, read from the live function body. */
  function order(body: string, tables: readonly string[]): string[] {
    return tables
      .map((t) => ({ t, at: body.indexOf(`public.${t}`) }))
      .filter((e) => e.at >= 0)
      .sort((a, b) => a.at - b.at)
      .map((e) => e.t);
  }

  it('request_deletion revokes sessions and devices BEFORE the pair, and the pair in order', async () => {
    const [fn] = await db.sql<{ def: string }[]>`
      select pg_get_functiondef('public.request_deletion(uuid, uuid)'::regprocedure) as def`;
    // Everything after the declarations: the `insert into public.deletion_requests` is the first
    // statement and takes the family row's KEY SHARE through its foreign key.
    const body = fn!.def.slice(fn!.def.indexOf('insert into public.deletion_requests'));
    expect(
      order(body, ['child_sessions', 'child_devices', 'child_slot_assignments', 'child_profiles']),
    ).toEqual(['child_sessions', 'child_devices', 'child_slot_assignments', 'child_profiles']);
  });

  it('the archive route writes the pair FIRST and the session rows after — the inversion 0930 names', () => {
    const route = readFileSync(
      join(import.meta.dirname, '..', '..', 'apps', 'api', 'src', 'routes', 'family.ts'),
      'utf8',
    );
    const archive = route.slice(route.indexOf("'/children/:childId/archive'"));
    const upTo = archive.slice(0, archive.indexOf('audit_events'));
    expect(
      order(upTo, ['child_slot_assignments', 'child_profiles', 'child_sessions', 'child_devices']),
    ).toEqual(['child_slot_assignments', 'child_profiles', 'child_sessions', 'child_devices']);
  });

  it('0930 no longer claims the writers agree statement for statement', () => {
    const m = readFileSync(
      join(import.meta.dirname, '..', 'migrations', '0930_deletion_lock_order.sql'),
      'utf8',
    );
    // The corrected text says which writers differ and that the family row is what rules out a cycle.
    expect(m).toMatch(/Every writer of this pair takes the FAMILY ROW first/);
    expect(m).toMatch(/HUNT7-D-2 corrects this comment/);
    // And it does not re-assert the claim, in the one phrasing that was false. The negative is bounded
    // to the sentence, not the file, because the correction itself quotes the old wording (L-054).
    expect(m).not.toMatch(/now agree with this function statement for statement/);
  });
});
