import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';

/**
 * Schema-wide security invariants. These run against every migration, so a new table or function
 * added by any area is checked automatically (spec E4 tenant isolation, AC_SECURITY_04).
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.drop();
});

describe('schema invariants', () => {
  it('every table in the exposed public schema has row level security enabled', async () => {
    const rows = await db.sql<{ table_name: string }[]>`
      select c.relname as table_name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
    `;
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });

  it('no client role holds privileges in the private schema', async () => {
    const rows = await db.sql<{ grantee: string; table_name: string; privilege_type: string }[]>`
      select grantee, table_name, privilege_type
        from information_schema.role_table_grants
       where table_schema = 'private' and grantee in ('anon', 'authenticated', 'pl_child', 'PUBLIC')
    `;
    expect(rows).toEqual([]);
    const usage = await db.sql<{ role: string; has_usage: boolean }[]>`
      select r.role, has_schema_privilege(r.role, 'private', 'USAGE') as has_usage
        from (values ('anon'), ('authenticated'), ('pl_child')) as r(role)
    `;
    expect(usage.filter((u) => u.has_usage)).toEqual([]);
  });

  it('every SECURITY DEFINER function pins its search_path', async () => {
    const rows = await db.sql<{ fn: string }[]>`
      select n.nspname || '.' || p.proname as fn
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where p.prosecdef
         and n.nspname in ('public', 'app', 'private')
         and not exists (
           select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%'
         )
    `;
    expect(rows.map((r) => r.fn)).toEqual([]);
  });

  it('anon cannot execute any SECURITY DEFINER function except explicitly public ones', async () => {
    const allowedForAnon = new Set<string>([]);
    const rows = await db.sql<{ fn: string }[]>`
      select n.nspname || '.' || p.proname as fn
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where p.prosecdef
         and n.nspname in ('public', 'app', 'private')
         and has_function_privilege('anon', p.oid, 'EXECUTE')
    `;
    expect(rows.map((r) => r.fn).filter((fn) => !allowedForAnon.has(fn))).toEqual([]);
  });

  it('pl_child has no write privilege on any public table unless explicitly allowlisted', async () => {
    // Child writes go through API-owned SECURITY DEFINER functions. Add a table here only with a
    // reviewed RLS policy that scopes the write to app.current_child_id().
    //
    // PUBLIC counts as pl_child here, exactly as it does in the DB-R2-04 table case below (whose
    // grantee list names it) and in the two sequence cases: `grant insert on public.t to public` is
    // reported by information_schema with grantee 'PUBLIC', which `grantee = 'pl_child'` cannot
    // match, so the invariant would return no rows while has_table_privilege('pl_child',
    // 'public.t', 'INSERT') is true — pl_child holding exactly the write this case denies.
    //
    // A column-level grant is the second way a write hides from a grantee predicate:
    // `grant insert (id) on public.t to pl_child` is not in role_table_grants at all (that view
    // carries table-level grants only) and has_table_privilege is false for it, yet pl_child can
    // insert rows naming just the granted columns. The migrations write parent grants in exactly
    // that column-listing style, so the child-facing slip is one word away. role_column_grants
    // carries both levels for INSERT and UPDATE — the only two write privileges Postgres grants per
    // column — so DELETE and TRUNCATE stay with the table-level view above, which is complete for
    // them; `union` folds away the per-column copies of a table-level grant.
    const allowlisted = new Set<string>([]);
    const childWriteGrants = async () =>
      (
        await db.sql<{ table_name: string; grantee: string; privilege_type: string }[]>`
          select table_name, grantee, privilege_type
            from information_schema.role_table_grants
           where table_schema = 'public' and grantee in ('pl_child', 'PUBLIC')
             and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
           union
          select table_name, grantee, privilege_type
            from information_schema.role_column_grants
           where table_schema = 'public' and grantee in ('pl_child', 'PUBLIC')
             and privilege_type in ('INSERT', 'UPDATE')
           order by table_name, grantee, privilege_type`
      ).filter((r) => !allowlisted.has(r.table_name));
    expect(await childWriteGrants()).toEqual([]);

    // And the invariant can see each of those grants: planted, caught, and revoked again. The query
    // has FOUR independent lists — two grantee lists and two privilege lists — and a plant is only
    // worth having if some single word can be deleted from one of them and only that plant reds.
    //
    // Plants 1-5 pin the four grantee cells of {PUBLIC, pl_child} x {table level, column level}: each
    // table-level cell is planted with DELETE, which has no column form and so can only be reported
    // by the table-level arm, and PUBLIC x table also keeps the INSERT plant it started with
    // (role_column_grants expands a table-level INSERT to every column, so that plant alone does not
    // pin the table-level arm).
    //
    // HUNT7-D-3: pinning the grantees is not pinning the PRIVILEGE lists, and round 6's comment said
    // "no arm can be dropped" as though it were. Both column-level plants were UPDATE, so `'INSERT'`
    // could be deleted from the column arm's privilege list at :101 and all five plants stayed green —
    // plant 1 survives because the TABLE arm still names PUBLIC and INSERT. The arm that word protects
    // is the one this case's own lead example writes out in full (`grant insert (family_id, child_id)
    // on public.<family table> to pl_child`) and the one CLAUDE.md's "child writes go through
    // API-owned SECURITY DEFINER functions" rule rests on, so it is the last arm that should be
    // deletable with CI green. Plant 6 below is that column-level INSERT. It is the same defect as
    // HUNT6-E-4 with one word moved: there the deletable word was a grantee, here it is a privilege.
    //
    // Which privilege words are load-bearing, so the next reader who mutates them knows what a green
    // run means. 'INSERT' and 'UPDATE' in the TABLE arm at :96 CAN be deleted with every plant still
    // green, and that is redundancy rather than a hole: role_column_grants expands a table-level
    // INSERT or UPDATE to every column, so the column arm reports those grants too. Plant 1 is the
    // demonstration — it is a TABLE-level insert and it survives deleting 'INSERT' from the table arm.
    // The words only the table arm can report are 'DELETE' and 'TRUNCATE', because neither has a
    // column form: DELETE is planted here twice (plants 2 and 5, one per grantee) and TRUNCATE is
    // planted in the '[DB-R2-04]' case for both grantees. So every word in this query is either
    // pinned by a plant or provably redundant, and nothing is merely unexamined.
    //
    // 1. The grant to PUBLIC that `grantee = 'pl_child'` could not see, table level.
    await db.sql`grant insert on public.audit_events to public`;
    try {
      expect(await childWriteGrants()).toEqual([
        { table_name: 'audit_events', grantee: 'PUBLIC', privilege_type: 'INSERT' },
      ]);
    } finally {
      await db.sql`revoke insert on public.audit_events from public`;
    }
    expect(await childWriteGrants()).toEqual([]);

    // 2. DELETE to PUBLIC: no column form exists, so only the table-level arm can catch it — this
    // is what pins 'PUBLIC' into that arm's grantee list rather than only into the column arm's.
    await db.sql`grant delete on public.audit_events to public`;
    try {
      expect(await childWriteGrants()).toEqual([
        { table_name: 'audit_events', grantee: 'PUBLIC', privilege_type: 'DELETE' },
      ]);
    } finally {
      await db.sql`revoke delete on public.audit_events from public`;
    }
    expect(await childWriteGrants()).toEqual([]);

    // 3. A column-level UPDATE, which no table-level view reports and has_table_privilege denies,
    // yet it lets the child update that column on every row the RLS policies expose.
    await db.sql`grant update (metadata) on public.audit_events to pl_child`;
    try {
      expect(await childWriteGrants()).toEqual([
        { table_name: 'audit_events', grantee: 'pl_child', privilege_type: 'UPDATE' },
      ]);
    } finally {
      await db.sql`revoke update (metadata) on public.audit_events from pl_child`;
    }
    expect(await childWriteGrants()).toEqual([]);

    // 4. PUBLIC at column level: the cell plants 1-3 left unpinned. Plants 1 and 2 pin 'PUBLIC' into
    // the table arm and plant 3 pins the column arm's 'pl_child', so dropping 'PUBLIC' from the
    // COLUMN arm alone kept this case green while the comment above claimed no arm could be
    // dropped. It is the likeliest of the four to arrive by accident, since the migrations write
    // grants column by column.
    await db.sql`grant update (metadata) on public.audit_events to public`;
    try {
      expect(await childWriteGrants()).toEqual([
        { table_name: 'audit_events', grantee: 'PUBLIC', privilege_type: 'UPDATE' },
      ]);
    } finally {
      await db.sql`revoke update (metadata) on public.audit_events from public`;
    }
    expect(await childWriteGrants()).toEqual([]);

    // 5. pl_child at TABLE level — the cell the four plants above still left unpinned, and the cell
    // this invariant's original `grantee = 'pl_child'` form existed for. role_column_grants expands
    // a table-level INSERT or UPDATE to every column, so plant 3 is caught by the column arm alone
    // and nothing forced 'pl_child' to stay in the table-level arm's grantee list: dropping it kept
    // all four plants green while `grant delete on public.audit_events to pl_child` — a privilege
    // with no column form, so invisible to the column arm — went unseen (HUNT6-E-4). DELETE is
    // therefore the privilege to plant here; it reaches this arm and no other.
    await db.sql`grant delete on public.audit_events to pl_child`;
    try {
      expect(await childWriteGrants()).toEqual([
        { table_name: 'audit_events', grantee: 'pl_child', privilege_type: 'DELETE' },
      ]);
    } finally {
      await db.sql`revoke delete on public.audit_events from pl_child`;
    }
    expect(await childWriteGrants()).toEqual([]);

    // 6. A column-level INSERT to pl_child — the grant this case's lead example names, and the one
    // privilege word no other plant reaches (HUNT7-D-3). The table-level view does not report a
    // column-level grant at all, so only the column arm's `'INSERT'` can see it: delete that word and
    // this plant reds while every other plant stays green, which is what makes the word undeletable.
    // It is the shape a real slip would take, because the migrations write grants column by column.
    await db.sql`grant insert (metadata) on public.audit_events to pl_child`;
    try {
      expect(await childWriteGrants()).toEqual([
        { table_name: 'audit_events', grantee: 'pl_child', privilege_type: 'INSERT' },
      ]);
    } finally {
      await db.sql`revoke insert (metadata) on public.audit_events from pl_child`;
    }
    expect(await childWriteGrants()).toEqual([]);
  });

  it('[DB-R2-04] no client role holds TRUNCATE, TRIGGER or REFERENCES on a public table', async () => {
    // TRUNCATE ignores RLS and fires no row trigger, so it is the one write app.prevent_mutation()
    // on the append-only ledgers cannot see; TRIGGER and REFERENCES let a client attach its own
    // code to, or key its own table against, a family table. None of the three is a client
    // privilege, and the Supabase default privileges hand out ALL, so a new table needs no
    // migration line to be exposed again — this invariant is the guard (migration 0860).
    //
    // REFERENCES is the one of the three Postgres also grants PER COLUMN, so role_table_grants alone
    // cannot fail on `grant references (metadata) on public.audit_events to authenticated`:
    // has_column_privilege is then true while the table-level view reports nothing. TRUNCATE and
    // TRIGGER have no column form, so the table-level view stays complete for them and the column arm
    // is restricted to REFERENCES; `union` folds away the per-column copies of a table-level grant.
    const clientWideGrants = async () =>
      await db.sql<{ grantee: string; table_name: string; privilege_type: string }[]>`
        select grantee, table_name, privilege_type
          from information_schema.role_table_grants
         where table_schema = 'public'
           and grantee in ('anon', 'authenticated', 'pl_child', 'PUBLIC')
           and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES')
         union
        select grantee, table_name, privilege_type
          from information_schema.role_column_grants
         where table_schema = 'public'
           and grantee in ('anon', 'authenticated', 'pl_child', 'PUBLIC')
           and privilege_type = 'REFERENCES'
         order by table_name, grantee, privilege_type`;
    expect(await clientWideGrants()).toEqual([]);

    // Planted, caught, revoked: the column-level REFERENCES the table-level view cannot see. A client
    // needs CREATE on schema public to exploit it (none has it today), which is why this is a guard
    // against a future slip rather than a live hole — but a guard that cannot fail is not a guard.
    await db.sql`grant references (metadata) on public.audit_events to authenticated`;
    try {
      expect(await clientWideGrants()).toEqual([
        { table_name: 'audit_events', grantee: 'authenticated', privilege_type: 'REFERENCES' },
      ]);
    } finally {
      await db.sql`revoke references (metadata) on public.audit_events from authenticated`;
    }
    expect(await clientWideGrants()).toEqual([]);
  });

  it('[DB-R2-04] the default privileges for new public tables grant no client role those three', async () => {
    // ACL letters: D = TRUNCATE, x = REFERENCES, t = TRIGGER.
    //
    // PUBLIC counts as a client role here, exactly as it does in the table-grant case above (whose
    // grantee list names it) and in the two sequence cases below: a default privilege granted to
    // PUBLIC is rendered with an empty grantee ('=Dxt/owner'), which no pattern over role names can
    // match, and whatever PUBLIC holds anon, authenticated and pl_child hold. So the bare '=' form
    // counts too, and the privilege-letter filter below reads it unchanged.
    //
    // Both PLACES a default can live count as well: `alter default privileges in schema public` and
    // the global `alter default privileges` (no `in schema`) are separate pg_default_acl rows, and
    // the global one has defaclnamespace = 0 and so no pg_namespace row to inner-join to. Postgres
    // merges the two, so a new table in public inherits both — hence the left join and the
    // `defaclnamespace = 0` arm, each pinned by a plant below (HUNT6-E-2).
    const clientTableDefaults = async () =>
      (
        await db.sql<{ acl: string }[]>`
          select unnest(d.defaclacl)::text as acl
            from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
           where (n.nspname = 'public' or d.defaclnamespace = 0) and d.defaclobjtype = 'r'`
      )
        .map((r) => r.acl)
        .filter((acl) => /^(anon|authenticated|pl_child)=/.test(acl) || acl.startsWith('='))
        .filter((acl) => /[tDx]/.test(acl.split('=')[1]!.split('/')[0]!));
    expect(await clientTableDefaults()).toEqual([]);

    // And the invariant can see that grant: planted, caught, and revoked again. A new public table
    // inheriting TRUNCATE from the schema default is exactly what this case exists to catch —
    // TRUNCATE ignores RLS and fires no row trigger.
    await db.sql`alter default privileges in schema public
      grant truncate, trigger, references on tables to public`;
    try {
      const planted = await clientTableDefaults();
      expect(planted).toHaveLength(1);
      expect(planted[0]).toMatch(/^=Dxt\//);
    } finally {
      await db.sql`alter default privileges in schema public
        revoke truncate, trigger, references on tables from public`;
    }
    expect(await clientTableDefaults()).toEqual([]);

    // And the GLOBAL spelling of the same default: `alter default privileges` with no `in schema`
    // writes a pg_default_acl row whose defaclnamespace is 0, which an inner join on pg_namespace
    // discards. Per-schema default privileges are merged ADDITIVELY onto the global ones
    // (get_user_default_acl / aclmerge), so a table created in public inherits the global row just
    // as it inherits the per-schema one, and a per-schema REVOKE cannot subtract it — the reason
    // 0001_core_identity.sql:539 spells the function revoke globally (HUNT6-E-2).
    await db.sql`alter default privileges grant truncate, trigger, references on tables to public`;
    try {
      const planted = await clientTableDefaults();
      expect(planted).toHaveLength(1);
      expect(planted[0]).toMatch(/^=Dxt\//);
    } finally {
      await db.sql`alter default privileges revoke truncate, trigger, references on tables from public`;
    }
    expect(await clientTableDefaults()).toEqual([]);
  });

  it('[HR4-0860-01] no client role holds a privilege on a sequence in public', async () => {
    // The sibling of the two DB-R2-04 cases above, for sequences (migration 0870). A sequence is a
    // write path of its own: UPDATE on one is all setval() needs, and setval needs no privilege on
    // the owning table, so neither app.prevent_mutation() on the append-only ledgers nor the revoked
    // INSERT/UPDATE/DELETE grants can see it — resetting public.audit_events_id_seq makes every
    // later append fail on audit_events_pkey. USAGE is likewise not a client privilege: every
    // sequence in public belongs to a `generated always as identity` column, whose inserts are
    // authorized on the table. The Supabase default privileges grant ALL on sequences, so a new
    // table with an identity column needs no migration line to be exposed again.
    //
    // PUBLIC counts as a client role here, exactly as it does in the table case above: aclexplode
    // reports a grant to PUBLIC with grantee = 0, which pg_get_userbyid renders as
    // 'unknown (OID=0)' and no IN-list of role names can match, so `authenticated` would hold
    // UPDATE — all setval() needs — through a PUBLIC grant this invariant never saw. Render
    // grantee 0 as 'PUBLIC' and match it by name, as information_schema does for the table case.
    const clientSequenceGrants = () =>
      db.sql<{ sequence_name: string; grantee: string; privilege_type: string }[]>`
        select c.relname as sequence_name,
               case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
               a.privilege_type
          from pg_class c, aclexplode(c.relacl) a
         where c.relkind = 'S' and c.relnamespace = 'public'::regnamespace
           and (a.grantee = 0
                or pg_get_userbyid(a.grantee) in ('anon', 'authenticated', 'pl_child'))
         order by sequence_name, grantee, a.privilege_type`;
    expect(await clientSequenceGrants()).toEqual([]);

    // And the invariant can see that grant: planted, caught, and revoked again.
    await db.sql`grant update on sequence public.audit_events_id_seq to public`;
    try {
      expect(await clientSequenceGrants()).toEqual([
        { sequence_name: 'audit_events_id_seq', grantee: 'PUBLIC', privilege_type: 'UPDATE' },
      ]);
    } finally {
      await db.sql`revoke update on sequence public.audit_events_id_seq from public`;
    }
    expect(await clientSequenceGrants()).toEqual([]);
  });

  it('[HR4-0860-01] the default privileges for new public sequences grant no client role', async () => {
    // ACL letters for a sequence: r = SELECT, w = UPDATE, U = USAGE. A default privilege granted to
    // PUBLIC is rendered with an empty grantee ('=U/owner'), which the named-role pattern misses,
    // so the bare '=' form counts too — every client role holds what PUBLIC holds. And the global
    // row (defaclnamespace = 0) counts as much as the per-schema one, since Postgres merges them
    // onto each other: hence the left join and the `defaclnamespace = 0` arm (HUNT6-E-2).
    const clientDefaults = async () =>
      (
        await db.sql<{ acl: string }[]>`
          select unnest(d.defaclacl)::text as acl
            from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
           where (n.nspname = 'public' or d.defaclnamespace = 0) and d.defaclobjtype = 'S'`
      )
        .map((r) => r.acl)
        .filter((a) => /^(anon|authenticated|pl_child)=/.test(a) || a.startsWith('='));
    expect(await clientDefaults()).toEqual([]);

    await db.sql`alter default privileges in schema public grant usage on sequences to public`;
    try {
      const planted = await clientDefaults();
      expect(planted).toHaveLength(1);
      expect(planted[0]).toMatch(/^=U\//);
    } finally {
      await db.sql`alter default privileges in schema public revoke usage on sequences from public`;
    }
    expect(await clientDefaults()).toEqual([]);

    // The GLOBAL spelling too (defaclnamespace = 0), which an inner join on pg_namespace discards:
    // it is merged onto the per-schema defaults, so a sequence created in public inherits it, and
    // 0910's per-schema revoke cannot subtract it — migration 0940 is the global revoke that can
    // (HUNT6-E-2).
    await db.sql`alter default privileges grant usage on sequences to public`;
    try {
      const planted = await clientDefaults();
      expect(planted).toHaveLength(1);
      expect(planted[0]).toMatch(/^=U\//);
    } finally {
      await db.sql`alter default privileges revoke usage on sequences from public`;
    }
    expect(await clientDefaults()).toEqual([]);
  });

  it('[BUG-008] every jsonb column rejects scalar JSON (double-encoded strings fail loudly)', async () => {
    const unchecked = await db.sql<{ col: string }[]>`
      select c.table_schema || '.' || c.table_name || '.' || c.column_name as col
        from information_schema.columns c
        join information_schema.tables t
          on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
       where c.table_schema in ('public', 'private') and c.data_type = 'jsonb'
         and not exists (
           select 1 from pg_constraint k
            where k.contype = 'c'
              and k.conrelid = (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass
              and pg_get_constraintdef(k.oid) like '%jsonb_typeof(' || c.column_name || ')%')
    `;
    expect(unchecked).toEqual([]);
    const fam = await db.sql<{ id: string }[]>`select gen_random_uuid() as id`;
    await expect(
      db.sql`insert into public.audit_events (actor_kind, action, target_id, metadata)
             values ('system', 'test.shape', ${fam[0]!.id}, ${JSON.stringify({ a: 1 })}::jsonb)`,
    ).rejects.toThrow(/json_shape/);
    await db.sql`insert into public.audit_events (actor_kind, action, target_id, metadata)
                 values ('system', 'test.shape', ${fam[0]!.id}, ${JSON.stringify({ a: 1 })}::text::jsonb)`;
  });
});
