import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { grantAdultUnlock, seedFamily } from './fixtures.ts';

/**
 * Account closure (migration 0830; Apple 5.1.1(v), Google Play account deletion). Supabase Auth
 * closes a sign-in with a SOFT delete because auth.users is referenced without ON DELETE actions
 * all over the schema; this file proves the hard delete is refused, that the local double's soft
 * path works and ends sessions like a sign-out, and that a closed user is refused by the session
 * check the API relies on. Synthetic adults only.
 */

let db: TestDb;

const S1 = '0830a000-0000-4000-8000-000000000001';
const S2 = '0830a000-0000-4000-8000-000000000002';
const S3 = '0830a000-0000-4000-8000-000000000003';
const S4 = '0830a000-0000-4000-8000-000000000004'; // never ended: only deleted_at can refuse it
const S5 = '0830a000-0000-4000-8000-000000000005';

const signIn = (user: string, session: string) =>
  db.sql`insert into auth.sessions (id, user_id, created_at, updated_at, aal, not_after)
         values (${session}, ${user}, now(), now(), 'aal1', null)`;

const active = (user: string, session: string) =>
  db.asService(async (tx) => {
    const [row] = await tx<{ ok: boolean }[]>`
      select app.auth_session_active(${user}::uuid, ${session}) as ok`;
    return row!.ok;
  });

const closed = (user: string) =>
  db.asService(async (tx) => {
    const [row] = await tx<
      { closed: boolean }[]
    >`select app.auth_user_closed(${user}::uuid) as closed`;
    return row!.closed;
  });

const closeLocally = (user: string) =>
  db.asService(async (tx) => {
    const [row] = await tx<{ done: boolean }[]>`
      select app.close_auth_user_locally(${user}::uuid) as done`;
    return row!.done;
  });

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.drop();
});

describe('why the auth user is soft-deleted (APL-07 / PLAY-10)', () => {
  it('about forty columns reference auth.users with no ON DELETE action, so a hard delete is refused', async () => {
    const [refs] = await db.sql<{ no_action: number; total: number }[]>`
      select count(*) filter (where confdeltype = 'a')::int as no_action, count(*)::int as total
        from pg_constraint
       where contype = 'f' and confrelid = 'auth.users'::regclass`;
    expect(refs!.no_action).toBeGreaterThanOrEqual(40);
    expect(refs!.total).toBeGreaterThanOrEqual(refs!.no_action);

    const fam = await seedFamily(db);
    await expect(db.sql`delete from auth.users where id = ${fam.ownerId}`).rejects.toMatchObject({
      code: '23503',
    });
    const [still] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from public.family_memberships where user_id = ${fam.ownerId}`;
    expect(still!.n).toBe(1);
  });
});

describe('the local double emulates the soft delete (development and test only)', () => {
  it('marks the user closed, scrubs identifiers, ends every session and revokes step-ups', async () => {
    const fam = await seedFamily(db);
    const owner = fam.ownerId;
    await signIn(owner, S1);
    await signIn(owner, S2);
    await grantAdultUnlock(db, owner, S1);
    await grantAdultUnlock(db, owner, '0830a000-0000-4000-8000-0000000000aa'); // not a live session
    const [before] = await db.sql<
      { email: string }[]
    >`select email from auth.users where id = ${owner}`;
    expect(await active(owner, S1)).toBe(true);
    expect(await closed(owner)).toBe(false);

    expect(await closeLocally(owner)).toBe(true);

    const [user] = await db.sql<
      { email: string; phone: string | null; deleted_at: Date | null; meta: unknown }[]
    >`select email, phone, deleted_at, raw_user_meta_data as meta from auth.users where id = ${owner}`;
    expect(user!.deleted_at).not.toBeNull();
    expect(user!.email).not.toBe(before!.email);
    expect(user!.email).not.toContain('@');
    expect(user!.phone).toBeNull();
    expect(user!.meta).toEqual({});
    // Sessions are gone the way a Supabase sign-out removes them, and recorded as ended (0720).
    const [sessions] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from auth.sessions where user_id = ${owner}`;
    expect(sessions!.n).toBe(0);
    const ended = await db.sql<{ session_id: string }[]>`
      select session_id::text as session_id from private.ended_auth_sessions
       where user_id = ${owner} order by session_id`;
    expect(ended.map((e) => e.session_id)).toEqual([S1, S2]);
    const unlocks = await db.sql<{ revoked: boolean }[]>`
      select revoked_at is not null as revoked from private.adult_unlocks where user_id = ${owner}`;
    expect(unlocks).toHaveLength(2);
    expect(unlocks.every((u) => u.revoked)).toBe(true);
    // The pseudonymous id is still referable: nothing that pointed at the adult was removed.
    const [memberships] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from public.family_memberships where user_id = ${owner}`;
    expect(memberships!.n).toBe(1);

    // Idempotent: closing again changes nothing and says so.
    expect(await closeLocally(owner)).toBe(false);
    // Unknown users are "already closed" (nothing to close, and never a valid sign-in).
    expect(await closeLocally('0830a000-0000-4000-8000-0000000000ee')).toBe(false);
  });

  it('a closed user is refused by the session check and has no email address any more', async () => {
    // S4 is a fresh session id that no earlier test ended: it is NOT in private.ended_auth_sessions,
    // its auth.sessions row stays in place, and its not_after is null. Only deleted_at can refuse it.
    const fam = await seedFamily(db);
    const adult = fam.ownerId;
    await signIn(adult, S4);
    expect(await active(adult, S4)).toBe(true);
    await db.sql`update auth.users set deleted_at = now() where id = ${adult}`; // as GoTrue does
    expect(await closed(adult)).toBe(true);
    const [ended] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from private.ended_auth_sessions where user_id = ${adult}`;
    expect(ended!.n).toBe(0);
    const [live] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from auth.sessions where id = ${S4} and user_id = ${adult}`;
    expect(live!.n).toBe(1);
    expect(await active(adult, S4)).toBe(false);
    expect(await active(adult, '0830a000-0000-4000-8000-0000000000ff')).toBe(false);
    const contact = await db.asService(
      (tx) => tx<{ email: string | null }[]>`select email from app.adult_auth_email(${adult})`,
    );
    expect(contact).toHaveLength(0);

    // The "no sessions recorded" fallback (0720 answers true for a user with no auth.sessions rows
    // at all) is closed too: a token minted for a closed user with no session table entry is refused.
    const lone = await seedFamily(db);
    expect(await active(lone.ownerId, S5)).toBe(true);
    await db.sql`update auth.users set deleted_at = now() where id = ${lone.ownerId}`;
    expect(await active(lone.ownerId, S5)).toBe(false);

    // Other adults are untouched.
    const other = await seedFamily(db);
    await signIn(other.ownerId, S3);
    expect(await closed(other.ownerId)).toBe(false);
    expect(await active(other.ownerId, S3)).toBe(true);
    const [row] = await db.asService(
      (tx) => tx<{ email: string | null; email_verified: boolean }[]>`
        select email, email_verified from app.adult_auth_email(${other.ownerId})`,
    );
    expect(row!.email_verified).toBe(true);
  });

  it('only the service role may close a user or ask whether one is closed', async () => {
    const fam = await seedFamily(db);
    await expect(
      db.asParent(
        fam.ownerId,
        (tx) => tx`select app.close_auth_user_locally(${fam.ownerId}::uuid)`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      db.asAnon((tx) => tx`select app.close_auth_user_locally(${fam.ownerId}::uuid)`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      db.asParent(fam.ownerId, (tx) => tx`select app.auth_user_closed(${fam.ownerId}::uuid)`),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await closed(fam.ownerId)).toBe(false);
  });

  it('account_close is a job kind with no family; unknown kinds are still refused', async () => {
    const fam = await seedFamily(db);
    const rows = await db.sql<{ id: string }[]>`
      insert into public.jobs (kind, idempotency_key, payload)
      values ('account_close', ${'account_close:' + fam.ownerId}, ${JSON.stringify({ userId: fam.ownerId })}::text::jsonb)
      returning id`;
    expect(rows).toHaveLength(1);
    await expect(
      db.sql`insert into public.jobs (kind, idempotency_key) values ('account_hard_delete', 'x:1')`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('the local double refuses on a database marked staging or production', async () => {
    // Last in this file: the mark is written by the migration role and the API cannot undo it.
    const fam = await seedFamily(db);
    await db.sql`insert into private.deployment (environment) values ('staging')`;
    await expect(closeLocally(fam.ownerId)).rejects.toThrow(/refused outside development and test/);
    expect(await closed(fam.ownerId)).toBe(false);
  });
});
