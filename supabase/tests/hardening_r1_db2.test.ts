import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { seedFamily, type SeededFamily } from './fixtures.ts';

/**
 * Migration 0850 (hardening round 1, database findings DB-R1-05..07) against real Postgres:
 * a subject link on a test date, study material or scan names a subject of that same child (not
 * only of the same family); the support-case author links carry no ON DELETE action that their own
 * checks would always refuse; the child session tables are indexed for the per-session and
 * per-family predicates the API and the deletion paths run, and ended session rows can be pruned.
 * Synthetic data only.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.drop();
});

async function indexDefinition(
  schema: string,
  table: string,
  name: string,
): Promise<string | undefined> {
  const [row] = await db.sql<{ indexdef: string }[]>`
    select indexdef from pg_indexes
     where schemaname = ${schema} and tablename = ${table} and indexname = ${name}`;
  return row?.indexdef;
}

async function plan(query: string): Promise<string> {
  const rows = await db.sql.unsafe<{ 'QUERY PLAN': string }[]>(`explain (format text) ${query}`);
  return rows.map((r) => r['QUERY PLAN']).join('\n');
}

async function constraintDefinitions(table: string): Promise<string[]> {
  const rows = await db.sql<{ def: string }[]>`
    select pg_get_constraintdef(oid) as def from pg_constraint
     where conrelid = ${table}::regclass order by conname`;
  return rows.map((r) => r.def);
}

async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

async function addSubject(fam: SeededFamily, childIndex: number, name: string): Promise<string> {
  const [row] = await db.sql<{ id: string }[]>`
    insert into public.child_subjects (family_id, child_id, subject_key, display_name)
    values (${fam.familyId}, ${fam.children[childIndex]!.id}, 'math', ${name})
    returning id`;
  return row!.id;
}

// ---------------------------------------------------------------------------------------------
// DB-R1-05: subject links are bound to the child, not only the family
// ---------------------------------------------------------------------------------------------

describe('[DB-R1-05] a subject link names a subject of the same child', () => {
  it('child_subjects is keyed by (id, child_id) and the three subject links reference it', async () => {
    expect(await constraintDefinitions('public.child_subjects')).toContain('UNIQUE (id, child_id)');
    for (const table of ['public.test_dates', 'public.study_materials', 'public.assignments']) {
      const defs = await constraintDefinitions(table);
      expect(defs, table).toContain(
        'FOREIGN KEY (subject_id, child_id) REFERENCES child_subjects(id, child_id)',
      );
      // The family-bound keys stay as they were.
      expect(defs, table).toContain(
        'FOREIGN KEY (subject_id, family_id) REFERENCES child_subjects(id, family_id)',
      );
      expect(defs, table).toContain(
        'FOREIGN KEY (child_id, family_id) REFERENCES child_profiles(id, family_id)',
      );
    }
  });

  it('a parent Data-API insert naming child A with child B subject is refused; same-child succeeds', async () => {
    const fam = await seedFamily(db, { childCount: 2 });
    const [childA, childB] = fam.children;
    const subjectA = await addSubject(fam, 0, 'Math A');
    const subjectB = await addSubject(fam, 1, 'Math B');

    // test_dates (parents hold a direct insert grant: the PostgREST path)
    expect(
      await pgCode(
        db.asParent(
          fam.ownerId,
          (tx) => tx`
            insert into public.test_dates (family_id, child_id, subject_id, test_date)
            values (${fam.familyId}, ${childA!.id}, ${subjectB}, '2026-10-10')`,
        ),
      ),
    ).toBe('23503');
    expect(
      await pgCode(
        db.asParent(
          fam.ownerId,
          (tx) => tx`
            insert into public.test_dates (family_id, child_id, subject_id, test_date)
            values (${fam.familyId}, ${childA!.id}, ${subjectA}, '2026-10-10')`,
        ),
      ),
    ).toBeUndefined();

    // study_materials (same direct grant)
    expect(
      await pgCode(
        db.asParent(
          fam.ownerId,
          (tx) => tx`
            insert into public.study_materials (family_id, child_id, subject_id, kind, content_text)
            values (${fam.familyId}, ${childA!.id}, ${subjectB}, 'taught_notes', 'Synthetic notes')`,
        ),
      ),
    ).toBe('23503');
    expect(
      await pgCode(
        db.asParent(
          fam.ownerId,
          (tx) => tx`
            insert into public.study_materials (family_id, child_id, subject_id, kind, content_text)
            values (${fam.familyId}, ${childB!.id}, ${subjectB}, 'taught_notes', 'Synthetic notes')`,
        ),
      ),
    ).toBeUndefined();
    // A study material without a subject is still allowed.
    expect(
      await pgCode(
        db.asParent(
          fam.ownerId,
          (tx) => tx`
            insert into public.study_materials (family_id, child_id, subject_id, kind, content_text)
            values (${fam.familyId}, ${childA!.id}, null, 'taught_notes', 'Synthetic notes')`,
        ),
      ),
    ).toBeUndefined();

    // assignments are written by the API as the service role; the database refuses the mismatch too.
    expect(
      await pgCode(
        db.asService(
          (tx) => tx`
            insert into public.assignments (family_id, child_id, subject_id, idempotency_key, created_by_kind)
            values (${fam.familyId}, ${childA!.id}, ${subjectB}, ${'r1-05:' + randomUUID()}, 'parent')`,
        ),
      ),
    ).toBe('23503');
    expect(
      await pgCode(
        db.asService(
          (tx) => tx`
            insert into public.assignments (family_id, child_id, subject_id, idempotency_key, created_by_kind)
            values (${fam.familyId}, ${childA!.id}, ${subjectA}, ${'r1-05:' + randomUUID()}, 'parent')`,
        ),
      ),
    ).toBeUndefined();

    // The rows that exist are the same-child ones only.
    const [counts] = await db.sql<{ td: number; sm: number; asg: number }[]>`
      select (select count(*)::int from public.test_dates where family_id = ${fam.familyId}) as td,
             (select count(*)::int from public.study_materials where family_id = ${fam.familyId}) as sm,
             (select count(*)::int from public.assignments where family_id = ${fam.familyId}) as asg`;
    expect(counts).toEqual({ td: 1, sm: 2, asg: 1 });
  });

  it('the migration stops, rather than rewriting family data, when a cross-child link already exists', async () => {
    const fam = await seedFamily(db, { childCount: 2 });
    const subjectB = await addSubject(fam, 1, 'Math B pre');
    const text = await readFile(
      fileURLToPath(new URL('../migrations/0850_hardening_r1_db2.sql', import.meta.url)),
      'utf8',
    );
    let caught: { code?: string; message?: string } | undefined;
    const rollback = new Error('rollback');
    try {
      await db.sql.begin(async (tx) => {
        // Recreate the pre-0850 state inside this transaction only.
        await tx`alter table public.test_dates drop constraint test_dates_subject_child_fkey`;
        await tx`alter table public.study_materials drop constraint study_materials_subject_child_fkey`;
        await tx`alter table public.assignments drop constraint assignments_subject_child_fkey`;
        await tx`alter table public.child_subjects drop constraint child_subjects_id_child_key`;
        await tx`
          insert into public.test_dates (family_id, child_id, subject_id, test_date)
          values (${fam.familyId}, ${fam.children[0]!.id}, ${subjectB}, '2026-10-12')`;
        try {
          await tx.unsafe(text);
        } catch (error) {
          caught = error as { code?: string; message?: string };
        }
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    expect(caught?.code).toBe('23503');
    expect(caught?.message).toBe(
      'rows link a subject of another child: test_dates 1, study_materials 0, assignments 0',
    );
    // Rolled back: the constraints are in place and the row never landed.
    expect(await constraintDefinitions('public.child_subjects')).toContain('UNIQUE (id, child_id)');
    const [n] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from public.test_dates where family_id = ${fam.familyId}`;
    expect(n!.n).toBe(0);
  });

  it('a subject of another family is still refused (the family-bound key is unchanged)', async () => {
    const famA = await seedFamily(db, { childCount: 1 });
    const famB = await seedFamily(db, { childCount: 1 });
    const foreignSubject = await addSubject(famB, 0, 'Math other');
    expect(
      await pgCode(
        db.asParent(
          famA.ownerId,
          (tx) => tx`
            insert into public.test_dates (family_id, child_id, subject_id, test_date)
            values (${famA.familyId}, ${famA.children[0]!.id}, ${foreignSubject}, '2026-10-11')`,
        ),
      ),
    ).toBe('23503');
  });
});

// ---------------------------------------------------------------------------------------------
// DB-R1-06: support-case author links carry no ON DELETE action
// ---------------------------------------------------------------------------------------------

describe('[DB-R1-06] support-case author links have no ON DELETE SET NULL their checks would refuse', () => {
  it('the author foreign keys are plain references (NO ACTION), the assignee keeps SET NULL', async () => {
    const rows = await db.sql<{ conname: string; confdeltype: string; def: string }[]>`
      select conname, confdeltype, pg_get_constraintdef(oid) as def from pg_constraint
       where conname in ('support_cases_opened_by_user_id_fkey',
                         'support_case_messages_author_user_id_fkey',
                         'support_cases_assignee_user_id_fkey')
       order by conname`;
    const byName = new Map(rows.map((r) => [r.conname, r]));
    const opened = byName.get('support_cases_opened_by_user_id_fkey');
    const author = byName.get('support_case_messages_author_user_id_fkey');
    expect(opened?.def).toBe('FOREIGN KEY (opened_by_user_id) REFERENCES auth.users(id)');
    expect(opened?.confdeltype).toBe('a');
    expect(author?.def).toBe('FOREIGN KEY (author_user_id) REFERENCES auth.users(id)');
    expect(author?.confdeltype).toBe('a');
    // Unchanged: the assignee column is nullable with no check, so SET NULL can succeed there.
    expect(byName.get('support_cases_assignee_user_id_fkey')?.confdeltype).toBe('n');
    // The parent-author checks stay.
    expect(await constraintDefinitions('public.support_cases')).toContain(
      "CHECK (((opened_by_kind <> 'parent'::text) OR (opened_by_user_id IS NOT NULL)))",
    );
    expect(await constraintDefinitions('public.support_case_messages')).toContain(
      "CHECK (((author_kind <> 'parent'::text) OR (author_user_id IS NOT NULL)))",
    );
  });

  it('a hard delete of a case author is refused by the reference (not by a check) and the case keeps its author id', async () => {
    const fam = await seedFamily(db, { childCount: 0 });
    const author = await db.createUser();
    const [kase] = await db.sql<{ id: string }[]>`
      insert into public.support_cases (family_id, opened_by_user_id, opened_by_kind, kind, subject, body)
      values (${fam.familyId}, ${author}, 'parent', 'bug', 'Synthetic subject', 'Synthetic body')
      returning id`;
    await db.sql`
      insert into public.support_case_messages (case_id, author_kind, author_user_id, body)
      values (${kase!.id}, 'parent', ${author}, 'Synthetic reply')`;
    const code = await pgCode(db.sql`delete from auth.users where id = ${author}`);
    // Before 0850 this was 23514 (support_cases_parent_author): the SET NULL action could never
    // complete for a parent-opened case. Now it is the same foreign-key refusal as the ~40 other
    // references to auth.users (0830: soft delete is the documented path).
    expect(code).toBe('23503');
    const [still] = await db.sql<{ opened_by_user_id: string }[]>`
      select opened_by_user_id from public.support_cases where id = ${kase!.id}`;
    expect(still!.opened_by_user_id).toBe(author);
  });
});

// ---------------------------------------------------------------------------------------------
// DB-R1-07: session-table indexes and pruning
// ---------------------------------------------------------------------------------------------

async function insertSession(
  fam: SeededFamily,
  opts: { createdAgoDays: number; expiresInDays: number; revokedAgoDays: number | null },
): Promise<string> {
  const child = fam.children[0]!;
  const [row] = await db.sql<{ id: string }[]>`
    insert into public.child_sessions (family_id, child_id, device_id, created_at, expires_at, revoked_at, revoke_reason)
    values (${fam.familyId}, ${child.id}, ${child.deviceId},
            now() - make_interval(days => ${opts.createdAgoDays}),
            now() + make_interval(days => ${opts.expiresInDays}),
            case when ${opts.revokedAgoDays}::int is null then null
                 else now() - make_interval(days => ${opts.revokedAgoDays}::int) end,
            case when ${opts.revokedAgoDays}::int is null then null else 'logout' end)
    returning id`;
  return row!.id;
}

/** A rotated pair of refresh tokens (old used, replaced by the new one) for the session. */
async function insertTokens(sessionId: string, issuedAgoDays: number): Promise<string[]> {
  const [next] = await db.sql<{ id: string }[]>`
    insert into private.child_refresh_tokens (session_id, token_hash, issued_at, expires_at)
    values (${sessionId}, ${randomBytes(32)}, now() - make_interval(days => ${issuedAgoDays}),
            now() - make_interval(days => ${issuedAgoDays}) + interval '30 days')
    returning id`;
  const [prev] = await db.sql<{ id: string }[]>`
    insert into private.child_refresh_tokens (session_id, token_hash, issued_at, expires_at, used_at, replaced_by)
    values (${sessionId}, ${randomBytes(32)}, now() - make_interval(days => ${issuedAgoDays + 1}),
            now() - make_interval(days => ${issuedAgoDays + 1}) + interval '30 days',
            now() - make_interval(days => ${issuedAgoDays}), ${next!.id})
    returning id`;
  return [next!.id, prev!.id];
}

async function insertUnlock(
  userId: string,
  opts: { createdAgoDays: number; expiresAgoDays: number; revokedAgoDays: number | null },
): Promise<string> {
  const [row] = await db.sql<{ id: string }[]>`
    insert into private.adult_unlocks (user_id, auth_session_id, method, created_at, expires_at, revoked_at)
    values (${userId}, ${randomUUID()}, 'pin',
            now() - make_interval(days => ${opts.createdAgoDays}),
            now() - make_interval(days => ${opts.expiresAgoDays}),
            case when ${opts.revokedAgoDays}::int is null then null
                 else now() - make_interval(days => ${opts.revokedAgoDays}::int) end)
    returning id`;
  return row!.id;
}

describe('[DB-R1-07] child session tables are indexed and ended rows can be pruned', () => {
  it('child_refresh_tokens_session serves the per-session token update and the purge join', async () => {
    expect(
      await indexDefinition('private', 'child_refresh_tokens', 'child_refresh_tokens_session'),
    ).toBe(
      'CREATE INDEX child_refresh_tokens_session ON private.child_refresh_tokens USING btree (session_id)',
    );
    const fam = await seedFamily(db, { childCount: 1 });
    const busy = fam.children[0]!.sessionId;
    // One long-lived session with many rotations (every refresh adds a row), all live.
    await db.sql`
      insert into private.child_refresh_tokens (session_id, token_hash, issued_at, expires_at, used_at)
      select ${busy}::uuid, sha256(convert_to('r1-07:' || g || ':' || ${randomUUID()}, 'UTF8')),
             now(), now() + interval '30 days', now()
        from generate_series(1, 20000) g`;
    const other = await seedFamily(db, { childCount: 1 });
    await db.sql`analyze private.child_refresh_tokens`;
    const revoke = await plan(
      `update private.child_refresh_tokens set used_at = now()
        where session_id = '${other.children[0]!.sessionId}' and used_at is null`,
    );
    expect(revoke).toContain('child_refresh_tokens_session');
    expect(revoke).not.toContain('Seq Scan on child_refresh_tokens');
  });

  it('child_sessions_family serves the deletion paths session revoke by family', async () => {
    expect(await indexDefinition('public', 'child_sessions', 'child_sessions_family')).toBe(
      'CREATE INDEX child_sessions_family ON public.child_sessions USING btree (family_id) WHERE (revoked_at IS NULL)',
    );
    const noisy = await seedFamily(db, { childCount: 1 });
    const child = noisy.children[0]!;
    // Many families' sessions: recently revoked history plus live ones (kept by the pruning test).
    await db.sql`
      insert into public.child_sessions (family_id, child_id, device_id, expires_at, revoked_at, revoke_reason)
      select ${noisy.familyId}::uuid, ${child.id}::uuid, ${child.deviceId}::uuid,
             now() + interval '1 hour', case when g % 3 = 0 then null else now() end,
             case when g % 3 = 0 then null else 'logout' end
        from generate_series(1, 15000) g`;
    const fam = await seedFamily(db, { childCount: 1 });
    await db.sql`analyze public.child_sessions`;
    // public.request_deletion / app.inactivity_delete_family (0840) session revoke
    const revoke = await plan(
      `update public.child_sessions set revoked_at = now(), revoke_reason = 'deletion'
        where family_id = '${fam.familyId}' and revoked_at is null`,
    );
    expect(revoke).toContain('child_sessions_family');
    expect(revoke).not.toContain('Seq Scan on child_sessions');
  });

  it('prune_session_rows deletes exactly the rows ended longer ago than the horizon', async () => {
    const fam = await seedFamily(db, { childCount: 1 });
    const live = fam.children[0]!.sessionId;
    // A live session keeps every token, however old (rotation-reuse detection needs them).
    const liveTokens = await insertTokens(live, 100);

    const revokedOld = await insertSession(fam, {
      createdAgoDays: 60,
      expiresInDays: 300,
      revokedAgoDays: 40,
    });
    const revokedOldTokens = await insertTokens(revokedOld, 45);
    const revokedRecent = await insertSession(fam, {
      createdAgoDays: 60,
      expiresInDays: 300,
      revokedAgoDays: 5,
    });
    const revokedRecentTokens = await insertTokens(revokedRecent, 45);
    const expiredOld = await insertSession(fam, {
      createdAgoDays: 100,
      expiresInDays: -40,
      revokedAgoDays: null,
    });
    const expiredOldTokens = await insertTokens(expiredOld, 70);
    const expiredRecent = await insertSession(fam, {
      createdAgoDays: 100,
      expiresInDays: -5,
      revokedAgoDays: null,
    });
    const expiredRecentTokens = await insertTokens(expiredRecent, 70);
    // Expired long ago, revoked only yesterday (a family deletion revokes every unrevoked session,
    // expired or not): it ended when it expired.
    const expiredThenRevoked = await insertSession(fam, {
      createdAgoDays: 100,
      expiresInDays: -40,
      revokedAgoDays: 1,
    });

    const adult = fam.ownerId;
    const unlockLive = await insertUnlock(adult, {
      createdAgoDays: 0,
      expiresAgoDays: -1,
      revokedAgoDays: null,
    });
    const unlockExpiredOld = await insertUnlock(adult, {
      createdAgoDays: 41,
      expiresAgoDays: 40,
      revokedAgoDays: null,
    });
    const unlockRevokedOld = await insertUnlock(adult, {
      createdAgoDays: 41,
      expiresAgoDays: 39,
      revokedAgoDays: 40,
    });
    const unlockExpiredRecent = await insertUnlock(adult, {
      createdAgoDays: 6,
      expiresAgoDays: 5,
      revokedAgoDays: null,
    });
    const unlockRevokedRecentOnly = await insertUnlock(adult, {
      createdAgoDays: 6,
      expiresAgoDays: -1,
      revokedAgoDays: 5,
    });

    const [result] = await db.asService(
      (tx) => tx<{ n: number }[]>`select app.prune_session_rows(interval '30 days') as n`,
    );
    // 4 tokens + 3 sessions (revokedOld, expiredOld, expiredThenRevoked) + 2 unlocks
    expect(result!.n).toBe(9);

    const sessions = new Set(
      (await db.sql<{ id: string }[]>`select id from public.child_sessions`).map((r) => r.id),
    );
    for (const id of [live, revokedRecent, expiredRecent]) expect(sessions.has(id)).toBe(true);
    for (const id of [revokedOld, expiredOld, expiredThenRevoked])
      expect(sessions.has(id)).toBe(false);

    const tokens = new Set(
      (await db.sql<{ id: string }[]>`select id from private.child_refresh_tokens`).map(
        (r) => r.id,
      ),
    );
    for (const id of [...liveTokens, ...revokedRecentTokens, ...expiredRecentTokens]) {
      expect(tokens.has(id)).toBe(true);
    }
    for (const id of [...revokedOldTokens, ...expiredOldTokens]) expect(tokens.has(id)).toBe(false);

    const unlocks = new Set(
      (await db.sql<{ id: string }[]>`select id from private.adult_unlocks`).map((r) => r.id),
    );
    for (const id of [unlockLive, unlockExpiredRecent, unlockRevokedRecentOnly]) {
      expect(unlocks.has(id)).toBe(true);
    }
    for (const id of [unlockExpiredOld, unlockRevokedOld]) expect(unlocks.has(id)).toBe(false);

    // Idempotent: a second sweep with the same horizon finds nothing.
    const [again] = await db.asService(
      (tx) => tx<{ n: number }[]>`select app.prune_session_rows(interval '30 days') as n`,
    );
    expect(again!.n).toBe(0);
  });

  it('prune_session_rows refuses a horizon shorter than one day', async () => {
    expect(
      await pgCode(db.asService((tx) => tx`select app.prune_session_rows(interval '23 hours')`)),
    ).toBe('22023');
    expect(await pgCode(db.asService((tx) => tx`select app.prune_session_rows(null)`))).toBe(
      '22023',
    );
  });

  it('prune_session_rows is a service-only SECURITY DEFINER with an empty search_path (L-002)', async () => {
    const [fn] = await db.sql<{ prosecdef: boolean; proconfig: string[] | null }[]>`
      select prosecdef, proconfig from pg_proc where oid = 'app.prune_session_rows(interval)'::regprocedure`;
    expect(fn!.prosecdef).toBe(true);
    expect(fn!.proconfig).toContain('search_path=""');
    const [grants] = await db.sql<Record<string, boolean>[]>`
      select has_function_privilege('anon', 'app.prune_session_rows(interval)', 'execute') as anon,
             has_function_privilege('authenticated', 'app.prune_session_rows(interval)', 'execute') as authenticated,
             has_function_privilege('pl_child', 'app.prune_session_rows(interval)', 'execute') as pl_child,
             has_function_privilege('service_role', 'app.prune_session_rows(interval)', 'execute') as service_role`;
    expect(grants).toEqual({
      anon: false,
      authenticated: false,
      pl_child: false,
      service_role: true,
    });
    const fam = await seedFamily(db, { childCount: 0 });
    await expect(
      db.asParent(fam.ownerId, (tx) => tx`select app.prune_session_rows(interval '30 days')`),
    ).rejects.toThrow(/permission denied/);
  });
});
