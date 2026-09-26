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
    const allowlisted = new Set<string>([]);
    const rows = await db.sql<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type
        from information_schema.role_table_grants
       where table_schema = 'public' and grantee = 'pl_child'
         and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    `;
    expect(rows.filter((r) => !allowlisted.has(r.table_name))).toEqual([]);
  });

  it('[DB-R2-04] no client role holds TRUNCATE, TRIGGER or REFERENCES on a public table', async () => {
    // TRUNCATE ignores RLS and fires no row trigger, so it is the one write app.prevent_mutation()
    // on the append-only ledgers cannot see; TRIGGER and REFERENCES let a client attach its own
    // code to, or key its own table against, a family table. None of the three is a client
    // privilege, and the Supabase default privileges hand out ALL, so a new table needs no
    // migration line to be exposed again — this invariant is the guard (migration 0860).
    const rows = await db.sql<{ grantee: string; table_name: string; privilege_type: string }[]>`
      select grantee, table_name, privilege_type
        from information_schema.role_table_grants
       where table_schema = 'public'
         and grantee in ('anon', 'authenticated', 'pl_child', 'PUBLIC')
         and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES')
       order by table_name, grantee, privilege_type`;
    expect(rows).toEqual([]);
  });

  it('[DB-R2-04] the default privileges for new public tables grant no client role those three', async () => {
    // ACL letters: D = TRUNCATE, x = REFERENCES, t = TRIGGER.
    const rows = await db.sql<{ acl: string }[]>`
      select unnest(d.defaclacl)::text as acl
        from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
       where n.nspname = 'public' and d.defaclobjtype = 'r'`;
    const offenders = rows
      .map((r) => r.acl)
      .filter((acl) => /^(anon|authenticated|pl_child)=/.test(acl))
      .filter((acl) => /[tDx]/.test(acl.split('=')[1]!.split('/')[0]!));
    expect(offenders).toEqual([]);
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
