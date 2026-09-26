import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import {
  childClaims,
  grantAdultUnlock,
  seedChild,
  seedFamily,
  seedOwnerAdmin,
  type SeededFamily,
} from './fixtures.ts';

let db: TestDb;
let familyA: SeededFamily;
let familyB: SeededFamily;

beforeAll(async () => {
  db = await createTestDb();
  familyA = await seedFamily(db, { childCount: 2 });
  familyB = await seedFamily(db, { childCount: 1 });
});

afterAll(async () => {
  await db?.drop();
});

describe('family creation (AC_ACCESS_01)', () => {
  it('creates a family and owner membership for a verified adult', async () => {
    const rows = await db.asParent(familyA.ownerId, (tx) => tx`select id from public.families`);
    expect(rows.map((r) => r.id)).toEqual([familyA.familyId]);
  });

  it('rejects an adult whose email is not verified', async () => {
    const [user] = await db.sql<{ id: string }[]>`
      insert into auth.users (email) values ('unverified@example.test') returning id
    `;
    await expect(
      db.asParent(user!.id, (tx) => tx`select public.create_family('X', 'UTC')`),
    ).rejects.toThrow(/verified email required/);
  });

  it('rejects anonymous callers', async () => {
    await expect(db.asAnon((tx) => tx`select public.create_family('X', 'UTC')`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('does not let one adult own two families', async () => {
    await expect(
      db.asParent(familyA.ownerId, (tx) => tx`select public.create_family('Second', 'UTC')`),
    ).rejects.toThrow(/already belongs to a family/);
  });
});

describe('tenant isolation for adults (AC_ACCESS_05, AC_CONN_06)', () => {
  it('a parent sees only their own family, children and sessions', async () => {
    const result = await db.asParent(familyA.ownerId, async (tx) => ({
      families: await tx`select id from public.families`,
      children: await tx`select id, family_id from public.child_profiles`,
      sessions: await tx`select family_id from public.child_sessions`,
    }));
    expect(result.families).toHaveLength(1);
    expect(result.children.every((c) => c.family_id === familyA.familyId)).toBe(true);
    expect(result.children).toHaveLength(2);
    expect(result.sessions.every((s) => s.family_id === familyA.familyId)).toBe(true);
  });

  it('a parent cannot read another family by id', async () => {
    const rows = await db.asParent(
      familyA.ownerId,
      (tx) => tx`select id from public.child_profiles where family_id = ${familyB.familyId}`,
    );
    expect(rows).toHaveLength(0);
  });

  it('anonymous callers cannot read family tables at all', async () => {
    await expect(db.asAnon((tx) => tx`select id from public.families`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.asAnon((tx) => tx`select id from public.child_profiles`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('adults cannot read the private schema', async () => {
    await expect(
      db.asParent(familyA.ownerId, (tx) => tx`select * from private.adult_unlocks`),
    ).rejects.toThrow(/permission denied/);
  });

  it('a tombstoned family becomes inaccessible to its own members', async () => {
    const doomed = await seedFamily(db);
    await db.sql`update public.families set deleted_at = now() where id = ${doomed.familyId}`;
    const rows = await db.asParent(doomed.ownerId, (tx) => tx`select id from public.families`);
    expect(rows).toHaveLength(0);
  });

  it('a revoked membership loses access immediately (AC_ACCESS_09)', async () => {
    const fam = await seedFamily(db);
    const guardian = await db.createUser();
    await db.sql`
      insert into public.family_memberships (family_id, user_id, role)
      values (${fam.familyId}, ${guardian}, 'guardian')
    `;
    const before = await db.asParent(guardian, (tx) => tx`select id from public.families`);
    expect(before).toHaveLength(1);
    await db.sql`
      update public.family_memberships set status = 'revoked', revoked_at = now()
      where family_id = ${fam.familyId} and user_id = ${guardian}
    `;
    const after = await db.asParent(guardian, (tx) => tx`select id from public.families`);
    expect(after).toHaveLength(0);
  });
});

describe('adult limit', () => {
  it('allows at most two active adults per family', async () => {
    const fam = await seedFamily(db);
    const second = await db.createUser();
    const third = await db.createUser();
    await db.sql`insert into public.family_memberships (family_id, user_id, role) values (${fam.familyId}, ${second}, 'guardian')`;
    await expect(
      db.sql`insert into public.family_memberships (family_id, user_id, role) values (${fam.familyId}, ${third}, 'guardian')`,
    ).rejects.toThrow(/maximum of 2 active adults/);
  });
});

describe('adult step-up (spec P3)', () => {
  it('child creation is no Data-API write at all, and the step-up stays session-bound', async () => {
    // API-AUTH-R2-01 (migration 0860): routes/family.ts creates a child with the service role, after
    // taking the family row lock for the CHILD_PROFILE_LIMIT cap and parsing the body with the K-8 /
    // under-13 contract, so `authenticated` holds no insert or update grant on child_profiles. The
    // write is refused whether or not the session carries a step-up — this test used to show the
    // policy refusing it, which was the weaker of the two refusals.
    const insertChild = (sessionId?: string) =>
      db.asParent(
        familyA.ownerId,
        (tx) => tx`
          insert into public.child_profiles (family_id, nickname, grade_level, age_band)
          values (${familyA.familyId}, 'Avery', 2, '5-7') returning id, status
        `,
        sessionId ? { sessionId } : {},
      );

    await expect(insertChild()).rejects.toThrow(/permission denied/);
    await grantAdultUnlock(db, familyA.ownerId, '00000000-0000-4000-8000-00000000abcd');
    await expect(insertChild()).rejects.toThrow(/permission denied/);
    await expect(insertChild('00000000-0000-4000-8000-00000000abcd')).rejects.toThrow(
      /permission denied/,
    );

    // The step-up itself is unchanged and still bound to the auth session the unlock names: an
    // unlock on another session does not transfer, which is what the (still present) insert and
    // update policies on child_profiles require.
    const unlocked = async (sessionId?: string) => {
      const rows = await db.asParent(
        familyA.ownerId,
        (tx) => tx<{ ok: boolean }[]>`select app.has_recent_adult_unlock() as ok`,
        sessionId ? { sessionId } : {},
      );
      return rows[0]!.ok;
    };
    expect(await unlocked()).toBe(false);
    expect(await unlocked('00000000-0000-4000-8000-00000000abcd')).toBe(true);
    const policies = await db.sql<{ policyname: string; with_check: string }[]>`
      select policyname, with_check from pg_policies
       where schemaname = 'public' and tablename = 'child_profiles'
         and policyname in ('child_profiles_member_insert', 'child_profiles_member_update')`;
    expect(policies).toHaveLength(2);
    for (const p of policies) expect(p.with_check ?? '').not.toBe('');

    // The API's own path (service role) still creates an uncharged draft.
    const [created] = await db.asService(
      (tx) => tx<{ status: string }[]>`
        insert into public.child_profiles (family_id, nickname, grade_level, age_band)
        values (${familyA.familyId}, 'Avery', 2, '5-7') returning status`,
    );
    expect(created!.status).toBe('draft');
  });

  it('an expired unlock is not honoured', async () => {
    const sessionId = '00000000-0000-4000-8000-00000000dead';
    await db.sql`
      insert into private.adult_unlocks (user_id, auth_session_id, method, created_at, expires_at)
      values (${familyA.ownerId}, ${sessionId}, 'pin', now() - interval '10 minutes', now() - interval '5 minutes')
    `;
    const rows = await db.asParent(
      familyA.ownerId,
      (tx) => tx`select app.has_recent_adult_unlock() as ok`,
      { sessionId },
    );
    expect(rows[0]!.ok).toBe(false);
  });

  it('a parent cannot activate a child (paid slot assignment is server-only)', async () => {
    const sessionId = '00000000-0000-4000-8000-0000000000aa';
    await grantAdultUnlock(db, familyA.ownerId, sessionId);
    await expect(
      db.asParent(
        familyA.ownerId,
        (tx) =>
          tx`update public.child_profiles set status = 'active' where family_id = ${familyA.familyId}`,
        { sessionId },
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('a parent cannot insert a child directly as active', async () => {
    const sessionId = '00000000-0000-4000-8000-0000000000bb';
    await grantAdultUnlock(db, familyA.ownerId, sessionId);
    await expect(
      db.asParent(
        familyA.ownerId,
        (tx) => tx`
          insert into public.child_profiles (family_id, nickname, grade_level, age_band, status)
          values (${familyA.familyId}, 'Sam', 2, '5-7', 'active')
        `,
        { sessionId },
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('child sessions (AC_ACCESS_04–06)', () => {
  it('a paired child sees only their own profile, not a sibling', async () => {
    const rows = await db.asChild(
      childClaims(familyA, 0),
      (tx) => tx`select id from public.child_profiles`,
    );
    expect(rows.map((r) => r.id)).toEqual([familyA.children[0]!.id]);
  });

  it('a child cannot read another family even by explicit id', async () => {
    const rows = await db.asChild(
      childClaims(familyA, 0),
      (tx) => tx`select id from public.child_profiles where family_id = ${familyB.familyId}`,
    );
    expect(rows).toHaveLength(0);
  });

  it('forged claims mixing one child with another family resolve to nothing', async () => {
    const forged = {
      childId: familyA.children[0]!.id,
      familyId: familyB.familyId,
      sessionId: familyA.children[0]!.sessionId,
    };
    const rows = await db.asChild(forged, (tx) => tx`select id from public.child_profiles`);
    expect(rows).toHaveLength(0);
  });

  it('a revoked session or device loses access (AC_ACCESS_08)', async () => {
    const fam = await seedFamily(db);
    const claims = childClaims(fam);
    expect(await db.asChild(claims, (tx) => tx`select id from public.child_profiles`)).toHaveLength(
      1,
    );
    await db.sql`update public.child_devices set revoked_at = now() where id = ${fam.children[0]!.deviceId}`;
    expect(await db.asChild(claims, (tx) => tx`select id from public.child_profiles`)).toHaveLength(
      0,
    );
  });

  it('an expired session loses access', async () => {
    const fam = await seedFamily(db);
    await db.sql`
      update public.child_sessions set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'
      where id = ${fam.children[0]!.sessionId}
    `;
    expect(
      await db.asChild(childClaims(fam), (tx) => tx`select id from public.child_profiles`),
    ).toHaveLength(0);
  });

  it('an archived child cannot use a still-open session', async () => {
    const fam = await seedFamily(db);
    await db.sql`update public.child_profiles set status = 'archived', archived_at = now() where id = ${fam.children[0]!.id}`;
    expect(
      await db.asChild(childClaims(fam), (tx) => tx`select id from public.child_profiles`),
    ).toHaveLength(0);
  });

  it('a child cannot read memberships, consent, sessions, audit or private data', async () => {
    const claims = childClaims(familyA);
    for (const table of [
      'public.family_memberships',
      'public.consent_records',
      'public.child_sessions',
      'public.audit_events',
      'private.child_pins',
    ]) {
      await expect(db.asChild(claims, (tx) => tx.unsafe(`select * from ${table}`))).rejects.toThrow(
        /permission denied/,
      );
    }
  });

  it('a child cannot write to their own profile', async () => {
    await expect(
      db.asChild(
        childClaims(familyA),
        (tx) => tx`update public.child_profiles set nickname = 'Hacker'`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('a child role cannot call the adult family RPC', async () => {
    await expect(
      db.asChild(childClaims(familyA), (tx) => tx`select public.create_family('x', 'UTC')`),
    ).rejects.toThrow(/permission denied|authentication required/);
  });

  it('a draft child cannot use a session', async () => {
    const fam = await seedFamily(db, { childCount: 0 });
    const draft = await seedChild(db, fam.familyId, 'Jordan', 'draft');
    const rows = await db.asChild(
      { childId: draft.id, familyId: fam.familyId, sessionId: draft.sessionId },
      (tx) => tx`select id from public.child_profiles`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('owner admin requires MFA', () => {
  it('admin row without aal2 is not an owner admin', async () => {
    const adminId = await seedOwnerAdmin(db);
    const aal1 = await db.asParent(adminId, (tx) => tx`select app.is_owner_admin() as ok`);
    const aal2 = await db.asParent(adminId, (tx) => tx`select app.is_owner_admin() as ok`, {
      aal: 'aal2',
    });
    expect(aal1[0]!.ok).toBe(false);
    expect(aal2[0]!.ok).toBe(true);
  });
});

describe('audit log', () => {
  it('is append-only', async () => {
    await expect(db.sql`update public.audit_events set action = 'tampered'`).rejects.toThrow(
      /append-only/,
    );
    await expect(db.sql`delete from public.audit_events`).rejects.toThrow(/append-only/);
  });
});
