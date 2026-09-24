import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { grantAdultUnlock, seedChild, seedFamily } from './fixtures.ts';

/**
 * Migration 0720 (identity/access review fixes): one active family per adult, IANA time zones on
 * every write path, one live pairing code per active child, rate-limit bucket expiry, and Supabase
 * sign-out ending API sessions. Real Postgres 16 with the labeled Supabase platform shim.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.drop();
});

/** Runs `a` and `b` in overlapping transactions: `a` holds its transaction open until `b` ran. */
async function overlapping<A, B>(
  a: (hold: Promise<void>) => Promise<A>,
  b: () => Promise<B>,
  holdMs = 800,
): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = a(hold);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = b();
  const timer = setTimeout(release, holdMs);
  const results = await Promise.allSettled([first, second]);
  clearTimeout(timer);
  return results;
}

describe('one active family per adult (RV-lead-identity-access-9)', () => {
  it('the schema refuses a second active membership, whatever the path', async () => {
    const fam = await seedFamily(db, { childCount: 0 });
    const other = await seedFamily(db, { childCount: 0 });
    await expect(
      db.sql`insert into public.family_memberships (family_id, user_id, role)
             values (${other.familyId}, ${fam.ownerId}, 'guardian')`,
    ).rejects.toMatchObject({
      code: '23505',
      constraint_name: 'family_memberships_one_active_family_per_user',
    });
    // A revoked membership does not count: the adult can join another family after leaving.
    const leaver = await db.createUser();
    await db.sql`insert into public.family_memberships (family_id, user_id, role, invited_by)
                 values (${fam.familyId}, ${leaver}, 'guardian', ${fam.ownerId})`;
    await db.sql`update public.family_memberships set status = 'revoked', revoked_at = now()
                  where user_id = ${leaver}`;
    await db.sql`insert into public.family_memberships (family_id, user_id, role, invited_by)
                 values (${other.familyId}, ${leaver}, 'guardian', ${other.ownerId})`;
  });

  it('a second create_family after the first committed gets the friendly error', async () => {
    const fam = await seedFamily(db, { childCount: 0 });
    await expect(
      db.asParent(fam.ownerId, (tx) => tx`select public.create_family('Again', 'UTC')`),
    ).rejects.toThrow(/already belongs to a family/);
  });
});

describe('families.timezone is an IANA zone on every path (review note d)', () => {
  it('create_family refuses an unknown zone', async () => {
    const adult = await db.createUser();
    await expect(
      db.asParent(adult, (tx) => tx`select public.create_family('Zones', 'Mars/Olympus_Mons')`),
    ).rejects.toMatchObject({ code: '23514', constraint_name: 'families_timezone_iana' });
    await expect(
      db.asParent(adult, (tx) => tx`select public.create_family('Zones', 'EST+5junk')`),
    ).rejects.toMatchObject({ constraint_name: 'families_timezone_iana' });
  });

  it('a direct (PostgREST) update by an unlocked member is validated too', async () => {
    const fam = await seedFamily(db, { childCount: 0 });
    const SESSION = '0720d000-0000-4000-8000-000000000001';
    await grantAdultUnlock(db, fam.ownerId, SESSION, 600);
    const update = (zone: string) =>
      db.asParent(
        fam.ownerId,
        (tx) => tx`update public.families set timezone = ${zone} where id = ${fam.familyId}`,
        { sessionId: SESSION },
      );
    await expect(update('Not/AZone')).rejects.toMatchObject({
      constraint_name: 'families_timezone_iana',
    });
    await update('Europe/Berlin');
    const [row] = await db.sql<{ timezone: string }[]>`
      select timezone from public.families where id = ${fam.familyId}`;
    expect(row!.timezone).toBe('Europe/Berlin');
  });
});

describe('pairing codes (RV-lead-identity-access-7, review note e)', () => {
  const code = (familyId: string, childId: string, createdBy: string, hash: string) =>
    db.sql`insert into private.child_pairing_codes (family_id, child_id, code_hash, created_by, expires_at)
           values (${familyId}, ${childId}, decode(${hash}, 'hex'), ${createdBy}, now() + interval '10 minutes')`;

  it('two overlapping code creations for one child leave exactly one live code', async () => {
    const fam = await seedFamily(db, { childCount: 1 });
    const child = fam.children[0]!.id;
    const [a, b] = await overlapping(
      (hold) =>
        db.sql.begin(async (tx) => {
          await tx`update private.child_pairing_codes set consumed_at = now() where child_id = ${child} and consumed_at is null`;
          await tx`insert into private.child_pairing_codes (family_id, child_id, code_hash, created_by, expires_at)
                   values (${fam.familyId}, ${child}, decode('a1', 'hex'), ${fam.ownerId}, now() + interval '10 minutes')`;
          await hold;
        }),
      () =>
        db.sql.begin(async (tx) => {
          await tx`update private.child_pairing_codes set consumed_at = now() where child_id = ${child} and consumed_at is null`;
          await tx`insert into private.child_pairing_codes (family_id, child_id, code_hash, created_by, expires_at)
                   values (${fam.familyId}, ${child}, decode('b2', 'hex'), ${fam.ownerId}, now() + interval '10 minutes')`;
        }),
    );
    expect([a.status, b.status]).toEqual(['fulfilled', 'fulfilled']);
    const live = await db.sql<{ hash: string }[]>`
      select encode(code_hash, 'hex') as hash from private.child_pairing_codes
       where child_id = ${child} and consumed_at is null`;
    expect(live.map((r) => r.hash)).toEqual(['b2']); // the later code wins; the earlier one ended
  });

  it('a code cannot be issued for a draft or archived child', async () => {
    const fam = await seedFamily(db, { childCount: 0 });
    const draft = await seedChild(db, fam.familyId, 'Sam', 'draft');
    await expect(code(fam.familyId, draft.id, fam.ownerId, 'c3')).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'child_pairing_codes_child_active',
    });
  });

  it('any path that ends a child’s active status ends its unredeemed codes', async () => {
    const fam = await seedFamily(db, { childCount: 2 });
    const [riley, sam] = fam.children;
    await code(fam.familyId, riley!.id, fam.ownerId, 'd4');
    await code(fam.familyId, sam!.id, fam.ownerId, 'e5');
    await db.sql`update public.child_profiles set status = 'archived', archived_at = now() where id = ${riley!.id}`;
    await db.sql`update public.child_profiles set status = 'draft' where id = ${sam!.id}`;
    const [row] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from private.child_pairing_codes
       where family_id = ${fam.familyId} and consumed_at is null`;
    expect(row!.n).toBe(0);
    // Re-activation does not bring an old code back.
    await db.sql`update public.child_profiles set status = 'active', archived_at = null where id = ${riley!.id}`;
    const [again] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from private.child_pairing_codes
       where child_id = ${riley!.id} and consumed_at is null`;
    expect(again!.n).toBe(0);
  });
});

describe('rate-limit buckets (RV-lead-identity-access-6)', () => {
  const T0 = new Date('2026-09-24T15:00:00Z');
  const hit = (key: string, now: Date) =>
    db.asService(
      (tx) => tx<{ allowed: boolean; hits: number }[]>`
        select allowed, hits from app.rate_limit_hit(${key}, 2, 900, ${now})`,
    );
  const reserve = (shared: string, client: string, limit: number, now = T0) =>
    db.asService(async (tx) => {
      const [row] = await tx<
        { allowed: boolean; exhausted: boolean; retry_after_seconds: number }[]
      >`
        select allowed, exhausted, retry_after_seconds
          from app.rate_limit_reserve_shared(${shared}, ${client}, ${limit}, 900, ${now})`;
      return row!;
    });
  const release = (key: string, now = T0) =>
    db.asService((tx) => tx`select app.rate_limit_release(${key}, 900, ${now})`);
  const hitsOf = async (key: string) => {
    const [row] = await db.sql<{ hits: number }[]>`
      select hits from private.rate_limit_buckets where bucket_key = ${key}`;
    return row?.hits ?? 0;
  };

  it('hits record when their window ends', async () => {
    await hit('expiry-test', T0);
    const [row] = await db.sql<{ expires_at: Date }[]>`
      select expires_at from private.rate_limit_buckets where bucket_key = 'expiry-test'`;
    expect(row!.expires_at.toISOString()).toBe('2026-09-24T15:15:00.000Z');
  });

  it('a shared budget is reserved before the attempt; once used up only a client with nothing in the window may try', async () => {
    expect(await reserve('rs:shared', 'rs:a', 2)).toMatchObject({
      allowed: true,
      exhausted: false,
    });
    expect(await reserve('rs:shared', 'rs:a', 2)).toMatchObject({
      allowed: true,
      exhausted: false,
    });
    expect(await hitsOf('rs:shared')).toBe(2);
    // Used up: client a already has attempts in the window and is refused; nothing is kept for it.
    const refused = await reserve('rs:shared', 'rs:a', 2);
    expect(refused).toMatchObject({ allowed: false, exhausted: true });
    expect(refused.retry_after_seconds).toBe(900);
    expect(await hitsOf('rs:shared')).toBe(2);
    expect(await hitsOf('rs:a')).toBe(2);
    // Client b has nothing in the window: one attempt, then refused while that one is held.
    expect(await reserve('rs:shared', 'rs:b', 2)).toMatchObject({ allowed: true, exhausted: true });
    expect(await reserve('rs:shared', 'rs:b', 2)).toMatchObject({
      allowed: false,
      exhausted: true,
    });
    // Its attempt succeeded: both units come back, so b may try again.
    await release('rs:shared');
    await release('rs:b');
    expect(await hitsOf('rs:b')).toBe(0);
    expect(await reserve('rs:shared', 'rs:b', 2)).toMatchObject({ allowed: true, exhausted: true });
    // The next window starts empty.
    expect(await reserve('rs:shared', 'rs:a', 2, new Date(T0.getTime() + 900_000))).toMatchObject({
      allowed: true,
      exhausted: false,
    });
  });

  it('simultaneous reservations are serialized: with one unit left exactly one of many proceeds', async () => {
    await reserve('rs2:shared', 'rs2:seed', 30); // spends 1
    for (let i = 0; i < 28; i += 1) await hit('rs2:shared', T0); // 29 of 30 spent
    const results = await Promise.all(
      Array.from({ length: 12 }, () => reserve('rs2:shared', 'rs2:site', 30)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(1);
    expect(await hitsOf('rs2:shared')).toBe(30);
    expect(await hitsOf('rs2:site')).toBe(1);
  });

  it('a release never goes below zero and never touches a later window', async () => {
    await hit('rel-test', T0);
    await release('rel-test');
    await release('rel-test');
    expect(await hitsOf('rel-test')).toBe(0);
    await hit('rel-test', new Date(T0.getTime() + 900_000));
    await release('rel-test', T0); // a release for the earlier window
    expect(await hitsOf('rel-test')).toBe(1);
  });

  it('the purge removes only buckets whose window has ended', async () => {
    await hit('purge-old', new Date(T0.getTime() - 3600_000));
    await hit('purge-live', T0);
    const [purged] = await db.asService(
      (tx) => tx<{ n: number }[]>`select app.purge_expired_rate_limit_buckets(${T0}) as n`,
    );
    expect(purged!.n).toBeGreaterThanOrEqual(1);
    const keys = await db.sql<{ bucket_key: string }[]>`
      select bucket_key from private.rate_limit_buckets where bucket_key like 'purge-%'`;
    expect(keys.map((k) => k.bucket_key)).toEqual(['purge-live']);
  });

  it('every hit also clears a few buckets that ended over a day ago, so the table cannot grow without a scheduler', async () => {
    const stale = new Date(T0.getTime() - 3 * 86_400_000);
    await db.sql`
      insert into private.rate_limit_buckets (bucket_key, window_start, hits, updated_at, expires_at)
      select 'stale-' || g, ${stale}, 1, ${stale}, ${stale} from generate_series(1, 20) g`;
    await db.sql`
      insert into private.rate_limit_buckets (bucket_key, window_start, hits, updated_at, expires_at)
      values ('recent-ended', ${T0}, 1, ${T0}, ${new Date(T0.getTime() - 3600_000)})`;
    const staleLeft = async () => {
      const [row] = await db.sql<{ n: number }[]>`
        select count(*)::int as n from private.rate_limit_buckets where bucket_key like 'stale-%'`;
      return row!.n;
    };
    await hit('sweeper', T0);
    const afterOne = await staleLeft();
    expect(afterOne).toBeLessThan(20);
    for (let i = 0; i < 5 && (await staleLeft()) > 0; i += 1) await hit('sweeper', T0);
    expect(await staleLeft()).toBe(0);
    // Within a day of its end a bucket is left alone (a lagging clock may still be counting in it).
    expect(await hitsOf('recent-ended')).toBe(1);
    expect(await hitsOf('sweeper')).toBeGreaterThan(0);
  });
});

describe('Supabase sign-out ends the session for the API (review note a)', () => {
  const active = (user: string, session: string) =>
    db.asService(async (tx) => {
      const [row] = await tx<{ ok: boolean }[]>`
        select app.auth_session_active(${user}::uuid, ${session}) as ok`;
      return row!.ok;
    });
  const signIn = (user: string, session: string, notAfter: Date | null = null) =>
    db.sql`insert into auth.sessions (id, user_id, created_at, updated_at, aal, not_after)
           values (${session}, ${user}, now(), now(), 'aal1', ${notAfter})`;

  it('live, signed-out, time-boxed, borrowed and malformed sessions', async () => {
    const adult = await db.createUser();
    const stranger = await db.createUser();
    const S1 = '0720a000-0000-4000-8000-000000000001';
    const S2 = '0720a000-0000-4000-8000-000000000002';
    const S3 = '0720a000-0000-4000-8000-000000000003';
    const UNKNOWN = '0720a000-0000-4000-8000-0000000000ff';
    // No sessions recorded for this adult at all (e.g. rows removed before 0720): not refused.
    expect(await active(adult, UNKNOWN)).toBe(true);
    await signIn(adult, S1);
    await signIn(adult, S2);
    await signIn(adult, S3, new Date(Date.now() - 1000));
    expect(await active(adult, S1)).toBe(true);
    expect(await active(adult, S3)).toBe(false); // past not_after
    expect(await active(stranger, S1)).toBe(false); // someone else's session
    expect(await active(adult, UNKNOWN)).toBe(false); // gone while the adult has others
    expect(await active(adult, 'not-a-uuid')).toBe(false);

    await grantAdultUnlock(db, adult, S2, 600);
    await db.sql`delete from auth.sessions where id = ${S2}`; // Supabase sign-out
    expect(await active(adult, S2)).toBe(false);
    const [unlock] = await db.sql<{ revoked: boolean }[]>`
      select revoked_at is not null as revoked from private.adult_unlocks where auth_session_id = ${S2}`;
    expect(unlock!.revoked).toBe(true);

    // Global sign-out: every row goes, every session stays ended.
    await db.sql`delete from auth.sessions where user_id = ${adult}`;
    expect(await active(adult, S1)).toBe(false);
    expect(await active(adult, S2)).toBe(false);
  });

  it('sign-out records are kept a week and a day by the database clock, then purged', async () => {
    const adult = await db.createUser();
    const S = '0720b000-0000-4000-8000-000000000001';
    const OLD = '0720b000-0000-4000-8000-000000000002';
    await signIn(adult, S);
    await db.sql`delete from auth.sessions where id = ${S}`;
    await db.sql`
      insert into private.ended_auth_sessions (session_id, user_id, ended_at)
      values (${OLD}, ${adult}, now() - interval '9 days')`;
    const [row] = await db.asService(
      (tx) => tx<{ n: number }[]>`select app.purge_ended_auth_sessions() as n`,
    );
    expect(row!.n).toBeGreaterThanOrEqual(1);
    expect(await active(adult, S)).toBe(false);
    const left = await db.sql<{ session_id: string }[]>`
      select session_id::text from private.ended_auth_sessions where session_id in (${S}, ${OLD})`;
    expect(left.map((r) => r.session_id)).toEqual([S]);
  });

  it('each sign-out also clears a few records older than a week and a day', async () => {
    const adult = await db.createUser();
    await db.sql`
      insert into private.ended_auth_sessions (session_id, user_id, ended_at)
      select gen_random_uuid(), ${adult}, now() - interval '10 days' from generate_series(1, 5)`;
    await db.sql`
      insert into private.ended_auth_sessions (session_id, user_id, ended_at)
      values ('0720c000-0000-4000-8000-000000000009', ${adult}, now() - interval '7 days')`;
    const S = '0720c000-0000-4000-8000-000000000001';
    await signIn(adult, S);
    await db.sql`delete from auth.sessions where id = ${S}`;
    const [row] = await db.sql<{ old: number; kept: number; fresh: number }[]>`
      select count(*) filter (where ended_at < now() - interval '8 days')::int as old,
             count(*) filter (where session_id = '0720c000-0000-4000-8000-000000000009')::int as kept,
             count(*) filter (where session_id = ${S})::int as fresh
        from private.ended_auth_sessions where user_id = ${adult}`;
    expect(row).toEqual({ old: 0, kept: 1, fresh: 1 });
  });

  it('client roles cannot call the session, limiter or purge functions', async () => {
    for (const role of ['anon', 'authenticated', 'pl_child']) {
      for (const fn of [
        'app.auth_session_active(uuid, text)',
        'app.rate_limit_hit(text, integer, integer, timestamptz)',
        'app.rate_limit_reserve_shared(text, text, integer, integer, timestamptz)',
        'app.rate_limit_release(text, integer, timestamptz)',
        'app.purge_expired_rate_limit_buckets(timestamptz, integer)',
        'app.purge_ended_auth_sessions(integer)',
      ]) {
        const [row] = await db.sql<{ ok: boolean }[]>`
          select has_function_privilege(${role}, ${fn}, 'EXECUTE') as ok`;
        expect({ role, fn, ok: row!.ok }).toEqual({ role, fn, ok: false });
      }
    }
  });
});
