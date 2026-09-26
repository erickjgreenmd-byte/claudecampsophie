import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantAdultUnlock, seedChild, seedFamily } from '@pencillift/db/testing/fixtures';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * Round-4 hardening regressions for the family vertical (findings FL-R4-01..04).
 *
 * - FL-R4-01: a child-scope deletion request archived the child but left its paid slot assigned, so
 *   activating a sibling answered NEEDS_PAID_SLOT — the parent was told to buy capacity they already
 *   pay for — and no route could free it again (the archive route's release sat inside
 *   `if (status !== 'archived')`, which request_deletion had already made false).
 * - FL-R4-02: POST /children/:id/pairing-code took the child row first and the family row second
 *   (through the pairing-code FK), the reverse of every other family write, so it deadlocked with a
 *   concurrent PATCH/activate/archive and the victim answered 503.
 * - FL-R4-03: the two PATCH write routes reserved no per-family rate budget, unlike every sibling
 *   parent write, while each call appends an audit_events row.
 * - FL-R4-04: PATCH /v1/children/:childId answered 404 "Child not found" for a child the same API
 *   lists with deletionPending: true, telling the parent a profile they can see is gone.
 */

let api: TestApi;
const SESSION = '4a4a4a4a-4a4a-4a4a-8a4a-4a4a4a4a4a4a';

beforeAll(async () => {
  api = await createTestApi();
});

afterAll(async () => {
  await api?.close();
});

/** Riley active holding one slot, Sam a draft; `paidSlots` slots bought and consent verified. */
async function family(options: { paidSlots?: number } = {}) {
  const fam = await seedFamily(api.db, { childCount: 0 });
  await api.db.sql`
    insert into public.family_capacity (family_id, paid_slots, managing_channel)
    values (${fam.familyId}, ${options.paidSlots ?? 1}, 'app_store')`;
  await api.db.sql`
    insert into public.consent_records (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
    values (${fam.familyId}, ${fam.ownerId}, 'mock', 'mock', 'child_learning_data', 'v1', 'verified', true, now())`;
  const riley = await seedChild(api.db, fam.familyId, 'Riley', 'active');
  const sam = await seedChild(api.db, fam.familyId, 'Sam', 'draft');
  await api.db.sql`
    insert into public.child_slot_assignments (family_id, child_id) values (${fam.familyId}, ${riley.id})`;
  await grantAdultUnlock(api.db, fam.ownerId, SESSION, 3600);
  const token = await parentToken(fam.ownerId, { sessionId: SESSION });
  return { fam, riley, sam, token };
}

async function openSlots(familyId: string): Promise<number> {
  const [row] = await api.db.sql<{ n: number }[]>`
    select count(*)::int as n from public.child_slot_assignments
     where family_id = ${familyId} and released_at is null`;
  return row!.n;
}

// -----------------------------------------------------------------------------------------------
// FL-R4-01: a child deletion frees the child's paid slot
// -----------------------------------------------------------------------------------------------

describe('FL-R4-01 a child-scope deletion releases that child’s paid slot', () => {
  it('frees the slot in the same transaction, so a sibling activates without buying capacity', async () => {
    const { fam, riley, sam, token } = await family({ paidSlots: 1 });
    const requested = await api.request('/v1/deletion', {
      method: 'POST',
      token,
      body: { scope: 'child', childId: riley.id },
    });
    expect(requested.status).toBe(202);

    const [slot] = await api.db.sql<{ released_at: Date | null; release_reason: string | null }[]>`
      select released_at, release_reason from public.child_slot_assignments
       where family_id = ${fam.familyId} and child_id = ${riley.id}`;
    expect(slot!.released_at).not.toBeNull();
    expect(slot!.release_reason).toBe('archived');
    expect(await openSlots(fam.familyId)).toBe(0);

    // The one paid slot the family already pays for is now free for the sibling.
    const activated = await api.request(`/v1/children/${sam.id}/activate`, {
      method: 'POST',
      token,
    });
    expect(activated.status).toBe(200);
    expect(await json(activated)).toMatchObject({
      childId: sam.id,
      status: 'active',
      paidSlots: 1,
      assignedSlots: 1,
    });
  });

  it('lets the archive route reconcile an already-archived child that still holds a slot', async () => {
    // The parent-visible remedy if a slot is ever stranded (a purge that dead-letters, a crash
    // between the archive statements): the release must not sit behind `status !== 'archived'`.
    const { fam, token } = await family({ paidSlots: 2 });
    const stuck = await seedChild(api.db, fam.familyId, 'Avery', 'archived');
    await api.db.sql`
      insert into public.child_slot_assignments (family_id, child_id) values (${fam.familyId}, ${stuck.id})`;
    expect(await openSlots(fam.familyId)).toBe(2);

    const res = await api.request(`/v1/children/${stuck.id}/archive`, { method: 'POST', token });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ status: 'archived', assignedSlots: 1 });
    expect(await openSlots(fam.familyId)).toBe(1);
  });
});

// -----------------------------------------------------------------------------------------------
// FL-R4-02: one lock order for the family and child rows
// -----------------------------------------------------------------------------------------------

describe('FL-R4-02 the pairing-code route takes the family row before the child row', () => {
  it('does not deadlock with a concurrent family-then-child write', async () => {
    const { fam, riley, token } = await family({ paidSlots: 1 });
    // Session A replays PATCH /v1/children/:childId exactly: families FOR UPDATE, then the child
    // row. Session B is the real pairing-code route. Before the fix B held the child row and waited
    // for the family row (the pairing-code FK takes FOR KEY SHARE on families), so the pair was an
    // ABBA cycle and Postgres killed one side with 40P01 — mapped to 503 by app.ts.
    let pairing: Promise<Response> | undefined;
    let sideAError: string | undefined;
    const sideA = api.db.sql
      .begin(async (tx) => {
        await tx`select 1 from public.families where id = ${fam.familyId} for update`;
        pairing = api.request(`/v1/children/${riley.id}/pairing-code`, { method: 'POST', token });
        // Wait until the route's transaction is blocked on a lock before taking the child row, which
        // is what makes the old inversion deadlock rather than merely queue.
        for (let i = 0; i < 200; i += 1) {
          const [waiting] = await api.db.sql<{ n: number }[]>`
            select count(*)::int as n from pg_stat_activity
             where datname = ${api.db.name} and wait_event_type = 'Lock' and pid <> pg_backend_pid()`;
          if ((waiting?.n ?? 0) > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await tx`update public.child_profiles set nickname = 'Riley R.' where id = ${riley.id}`;
        return 'committed';
      })
      .catch((error: unknown) => {
        sideAError = error instanceof Error ? error.message : String(error);
        return 'failed';
      });
    const outcome = await sideA;
    const res = await pairing!;
    // Both sides must finish: a deadlock shows up either as 40P01 on side A or as the 503 app.ts
    // maps 40P01 to on the route.
    expect({ outcome, sideAError, status: res.status }).toEqual({
      outcome: 'committed',
      sideAError: undefined,
      status: 201,
    });
  });

  it('does not deadlock with the redeem path, which reaches families through its FK locks', async () => {
    // The family lock's STRENGTH matters as much as its position. POST /v1/child/pair claims the code
    // row first and touches `families` only through the FKs of the device and session it inserts
    // (FOR KEY SHARE). A FOR UPDATE here would block that and trade the FL-R4-02 cycle for a new one
    // with the redeem path, so this route takes FOR NO KEY UPDATE: it still conflicts with the other
    // family writes' FOR UPDATE, but not with an FK's FOR KEY SHARE.
    const { fam, riley, token } = await family({ paidSlots: 1 });
    const first = await api.request(`/v1/children/${riley.id}/pairing-code`, {
      method: 'POST',
      token,
    });
    expect(first.status).toBe(201);

    let reissue: Promise<Response> | undefined;
    let redeemError: string | undefined;
    const redeem = api.db.sql
      .begin(async (tx) => {
        // The atomic claim POST /v1/child/pair makes, on the live code row.
        const claimed = await tx<{ id: string }[]>`
          update private.child_pairing_codes set consumed_at = now()
           where child_id = ${riley.id} and consumed_at is null returning id`;
        expect(claimed.length).toBe(1);
        // A reissue now blocks on that code row, holding the family and child locks.
        reissue = api.request(`/v1/children/${riley.id}/pairing-code`, { method: 'POST', token });
        for (let i = 0; i < 200; i += 1) {
          const [waiting] = await api.db.sql<{ n: number }[]>`
            select count(*)::int as n from pg_stat_activity
             where datname = ${api.db.name} and wait_event_type = 'Lock' and pid <> pg_backend_pid()`;
          if ((waiting?.n ?? 0) > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        // The rest of the redeem: this insert's FKs take FOR KEY SHARE on families and child_profiles.
        await tx`
          insert into public.child_devices (family_id, child_id, label, platform)
          values (${fam.familyId}, ${riley.id}, 'Redeemed tablet', 'ios')`;
        return 'committed';
      })
      .catch((error: unknown) => {
        redeemError = error instanceof Error ? error.message : String(error);
        return 'failed';
      });
    const outcome = await redeem;
    const res = await reissue!;
    expect({ outcome, redeemError, status: res.status }).toEqual({
      outcome: 'committed',
      redeemError: undefined,
      status: 201,
    });
  });
});

// -----------------------------------------------------------------------------------------------
// FL-R4-03: the profile edits are rate limited like every other parent write
// -----------------------------------------------------------------------------------------------

describe('FL-R4-03 profile edits reserve a per-family budget', () => {
  it('refuses the calls past the hourly bound and writes no further audit row', async () => {
    const { fam, riley, token } = await family({ paidSlots: 1 });
    let allowed = 0;
    for (let i = 0; i < 30; i += 1) {
      const res = await api.request('/v1/family', {
        method: 'PATCH',
        token,
        body: { displayName: `Family ${i}` },
      });
      if (res.status === 200) allowed += 1;
    }
    expect(allowed).toBe(30);
    // The same per-family budget covers both profile edits, so the child edit is refused too.
    const over = await api.request(`/v1/children/${riley.id}`, {
      method: 'PATCH',
      token,
      body: { gradeLevel: 5 },
    });
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).not.toBeNull();
    const [audits] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where family_id = ${fam.familyId} and action = 'child.profile_updated'`;
    expect(audits!.n).toBe(0);
  });
});

// -----------------------------------------------------------------------------------------------
// FL-R4-04: a deletion-pending child the caller can see is named, not denied
// -----------------------------------------------------------------------------------------------

describe('FL-R4-04 a profile edit under an open deletion says why', () => {
  it('answers BUSINESS_RULE CHILD_DELETION_PENDING for the caller’s own listed child', async () => {
    const { fam, riley, token } = await family({ paidSlots: 1 });
    expect(
      (
        await api.request('/v1/deletion', {
          method: 'POST',
          token,
          body: { scope: 'child', childId: riley.id },
        })
      ).status,
    ).toBe(202);
    // GET /v1/family has already named this child to this caller (deletionPending: true), so a
    // "Child not found" on the edit protects nothing and only misleads.
    const overview = await api.request('/v1/family', { token });
    const body = await json<{ children: { id: string; deletionPending?: boolean }[] }>(overview);
    expect(body.children.find((ch) => ch.id === riley.id)).toMatchObject({
      deletionPending: true,
    });

    const res = await api.request(`/v1/children/${riley.id}`, {
      method: 'PATCH',
      token,
      body: { gradeLevel: 7 },
    });
    expect(res.status).toBe(422);
    const error = await json<{ error: { code: string; rule: string; message: string } }>(res);
    expect(error.error).toMatchObject({ code: 'BUSINESS_RULE', rule: 'CHILD_DELETION_PENDING' });
    expect(error.error.message).toMatch(/being deleted/i);
    expect(await openSlots(fam.familyId)).toBe(0);
  });

  it('still answers NOT_FOUND for an unknown id and another family’s child', async () => {
    const mine = await family({ paidSlots: 1 });
    const theirs = await family({ paidSlots: 1 });
    expect(
      (
        await api.request(`/v1/children/${theirs.riley.id}`, {
          method: 'PATCH',
          token: mine.token,
          body: { gradeLevel: 6 },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api.request('/v1/children/11111111-1111-4111-8111-111111111111', {
          method: 'PATCH',
          token: mine.token,
          body: { gradeLevel: 6 },
        })
      ).status,
    ).toBe(404);
  });
});
