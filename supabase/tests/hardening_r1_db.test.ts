import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { grantAdultUnlock, seedFamily, type SeededFamily } from './fixtures.ts';

/**
 * Migration 0840 (hardening round 1, database findings DB-R1-01..04) against real Postgres:
 * the job ledger and safety reports are indexed for the per-family queries the API runs on
 * every screen load, terminal jobs can be pruned, a family-data deletion releases the adults'
 * memberships at request time (not only when the purge runs), and the IANA guard on
 * families.timezone refuses the pseudo-zones Postgres lists but Intl rejects. Synthetic data.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.drop();
});

async function indexDefinition(table: string, name: string): Promise<string | undefined> {
  const [row] = await db.sql<{ indexdef: string }[]>`
    select indexdef from pg_indexes where schemaname = 'public' and tablename = ${table} and indexname = ${name}`;
  return row?.indexdef;
}

async function plan(query: string): Promise<string> {
  const rows = await db.sql.unsafe<{ 'QUERY PLAN': string }[]>(`explain (format text) ${query}`);
  return rows.map((r) => r['QUERY PLAN']).join('\n');
}

async function membershipStates(
  familyId: string,
): Promise<{ user_id: string; status: string; revoked_at: Date | null }[]> {
  return db.sql<{ user_id: string; status: string; revoked_at: Date | null }[]>`
    select user_id, status, revoked_at from public.family_memberships
     where family_id = ${familyId} order by accepted_at, id`;
}

/** Adds a second active adult (invited guardian) to the family. */
async function addGuardian(fam: SeededFamily): Promise<string> {
  const guardianId = await db.createUser();
  await db.sql`
    insert into public.family_memberships (family_id, user_id, role, invited_by)
    values (${fam.familyId}, ${guardianId}, 'guardian', ${fam.ownerId})`;
  return guardianId;
}

// ---------------------------------------------------------------------------------------------
// DB-R1-01: public.jobs indexes and retention
// ---------------------------------------------------------------------------------------------

describe('[DB-R1-01] the job ledger is indexed for the per-family queries and can be pruned', () => {
  it('jobs_family_child serves the child practice/review status and scan-version lookups', async () => {
    expect(await indexDefinition('jobs', 'jobs_family_child')).toBe(
      'CREATE INDEX jobs_family_child ON public.jobs USING btree (family_id, child_id, kind, created_at DESC)',
    );
    // The ledger holds every family's jobs; the bulk belongs to other families (as in production),
    // the family under test has a handful.
    const fam = await seedFamily(db, { childCount: 1 });
    const child = fam.children[0]!;
    const noisy = await seedFamily(db, { childCount: 1 });
    await db.sql`
      insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, status)
      select 'daily_set_generate', 'r1-01:' || g, ${noisy.familyId}::uuid, ${noisy.children[0]!.id}::uuid,
             jsonb_build_object('localDate', '2026-01-01'), 'succeeded'
        from generate_series(1, 5000) g`;
    await db.sql`
      insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, status)
      select 'daily_set_generate', 'r1-01-own:' || g, ${fam.familyId}::uuid, ${child.id}::uuid,
             jsonb_build_object('localDate', '2026-01-01'), 'succeeded'
        from generate_series(1, 20) g`;
    await db.sql`analyze public.jobs`;
    // apps/api/src/routes/learning.ts GET /child/practice/today
    const daily = await plan(
      `select status from public.jobs where kind = 'daily_set_generate' and child_id = '${child.id}'
        and family_id = '${fam.familyId}' and payload->>'localDate' = '2026-09-25'
        order by created_at desc limit 1`,
    );
    expect(daily).toContain('jobs_family_child');
    expect(daily).not.toContain('Seq Scan');
    // apps/api/src/routes/homework.ts scan version count (no child in the predicate)
    const versions = await plan(
      `select count(*) from public.jobs where family_id = '${fam.familyId}' and idempotency_key like 'scan:${randomUUID()}:v%'`,
    );
    expect(versions).toContain('jobs_family_child');
    expect(versions).not.toContain('Seq Scan');
  });

  it('jobs_running serves the dispatcher lease recovery', async () => {
    expect(await indexDefinition('jobs', 'jobs_running')).toBe(
      "CREATE INDEX jobs_running ON public.jobs USING btree (locked_until) WHERE (status = 'running'::text)",
    );
    const recovery = await plan(
      `select id from public.jobs where status = 'running' and locked_until < now()`,
    );
    expect(recovery).toContain('jobs_running');
    expect(recovery).not.toContain('Seq Scan');
  });

  it('prune_terminal_jobs deletes only old succeeded/cancelled/dead-letter rows and never the deletion or account-close audit trail', async () => {
    const fam = await seedFamily(db, { childCount: 1 });
    const child = fam.children[0]!;
    const key = (label: string) => `r1-01-prune:${label}:${randomUUID()}`;
    const rows: {
      label: string;
      kind: string;
      status: string;
      ageDays: number;
      familyId: string | null;
    }[] = [
      {
        label: 'old-succeeded',
        kind: 'daily_set_generate',
        status: 'succeeded',
        ageDays: 120,
        familyId: fam.familyId,
      },
      {
        label: 'old-cancelled',
        kind: 'scan_process',
        status: 'cancelled',
        ageDays: 120,
        familyId: fam.familyId,
      },
      {
        label: 'old-dead',
        kind: 'export_build',
        status: 'dead_letter',
        ageDays: 120,
        familyId: fam.familyId,
      },
      {
        label: 'old-failed-final',
        kind: 'scan_process',
        status: 'failed_final',
        ageDays: 120,
        familyId: fam.familyId,
      },
      {
        label: 'old-queued',
        kind: 'notification_send',
        status: 'queued',
        ageDays: 120,
        familyId: fam.familyId,
      },
      {
        label: 'old-retryable',
        kind: 'notification_send',
        status: 'failed_retryable',
        ageDays: 120,
        familyId: fam.familyId,
      },
      {
        label: 'old-running',
        kind: 'scan_process',
        status: 'running',
        ageDays: 120,
        familyId: fam.familyId,
      },
      {
        label: 'old-purge',
        kind: 'deletion_purge',
        status: 'succeeded',
        ageDays: 400,
        familyId: fam.familyId,
      },
      {
        label: 'old-close',
        kind: 'account_close',
        status: 'succeeded',
        ageDays: 400,
        familyId: null,
      },
      {
        label: 'old-global',
        kind: 'promo_month_generate',
        status: 'succeeded',
        ageDays: 120,
        familyId: null,
      },
      {
        label: 'recent-succeeded',
        kind: 'daily_set_generate',
        status: 'succeeded',
        ageDays: 10,
        familyId: fam.familyId,
      },
      {
        label: 'edge-succeeded',
        kind: 'daily_set_generate',
        status: 'succeeded',
        ageDays: 89,
        familyId: fam.familyId,
      },
    ];
    const keys = new Map<string, string>();
    for (const row of rows) {
      const k = key(row.label);
      keys.set(row.label, k);
      const childId = row.familyId ? child.id : null;
      await db.sql`
        insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, status)
        values (${row.kind}, ${k}, ${row.familyId}, ${childId}, '{}'::jsonb, ${row.status})`;
      // app.guard_job stamps updated_at = now() on every write, so a row's age (the instant it
      // ended) is backdated as a superuser fixture with the ledger triggers off.
      await db.sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`
          update public.jobs
             set created_at = now() - make_interval(days => ${row.ageDays}),
                 updated_at = now() - make_interval(days => ${row.ageDays})
           where idempotency_key = ${k}`;
      });
    }
    const [result] = await db.asService(
      (tx) => tx<{ n: number }[]>`select app.prune_terminal_jobs(interval '90 days') as n`,
    );
    expect(result!.n).toBe(4); // old-succeeded, old-cancelled, old-dead, old-global
    const remaining = await db.sql<{ idempotency_key: string }[]>`
      select idempotency_key from public.jobs where idempotency_key like 'r1-01-prune:%'`;
    const left = new Set(remaining.map((r) => r.idempotency_key));
    const expectKept = [
      'old-failed-final',
      'old-queued',
      'old-retryable',
      'old-running',
      'old-purge',
      'old-close',
      'recent-succeeded',
      'edge-succeeded',
    ];
    for (const label of expectKept) expect(left.has(keys.get(label)!), label).toBe(true);
    for (const label of ['old-succeeded', 'old-cancelled', 'old-dead', 'old-global']) {
      expect(left.has(keys.get(label)!), label).toBe(false);
    }
    // Idempotent: a second sweep with the same horizon finds nothing.
    const [again] = await db.asService(
      (tx) => tx<{ n: number }[]>`select app.prune_terminal_jobs(interval '90 days') as n`,
    );
    expect(again!.n).toBe(0);
  });

  it('prune_terminal_jobs is service-only (L-002)', async () => {
    const fam = await seedFamily(db, { childCount: 0 });
    await expect(
      db.asParent(fam.ownerId, (tx) => tx`select app.prune_terminal_jobs(interval '1 day')`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asAnon((tx) => tx`select app.prune_terminal_jobs(interval '1 day')`),
    ).rejects.toThrow(/permission denied/);
  });
});

// ---------------------------------------------------------------------------------------------
// DB-R1-02: a family-data deletion releases the adults at request time
// ---------------------------------------------------------------------------------------------

describe('[DB-R1-02] a family deletion request releases the memberships in the same transaction', () => {
  it('the owner can create a new family right after requesting deletion, before the purge runs', async () => {
    const fam = await seedFamily(db, { childCount: 1 });
    await grantAdultUnlock(db, fam.ownerId);
    const [req] = await db.asParent(
      fam.ownerId,
      (tx) =>
        tx<{ status: string }[]>`select status from public.request_deletion(${fam.familyId}, null)`,
    );
    expect(req!.status).toBe('requested');
    const states = await membershipStates(fam.familyId);
    expect(states.map((m) => m.status)).toEqual(['revoked']);
    expect(states[0]!.revoked_at).not.toBeNull();
    const [tomb] = await db.sql<{ deletion_requested_at: Date; revoked_at: Date }[]>`
      select f.deletion_requested_at, m.revoked_at from public.families f
        join public.family_memberships m on m.family_id = f.id where f.id = ${fam.familyId}`;
    // Released by the deletion itself: the same instant as the tombstone.
    expect(tomb!.revoked_at.getTime()).toBe(tomb!.deletion_requested_at.getTime());

    // The purge job is still queued: nothing has run yet.
    const [job] = await db.sql<{ status: string }[]>`
      select status from public.jobs where family_id = ${fam.familyId} and kind = 'deletion_purge'`;
    expect(job!.status).toBe('queued');

    const [fresh] = await db.asParent(
      fam.ownerId,
      (tx) =>
        tx<{ id: string }[]>`select public.create_family('Fresh start', 'America/Chicago') as id`,
    );
    expect(fresh!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(fresh!.id).not.toBe(fam.familyId);

    // The later purge still completes and leaves the release instant untouched (its own revoke is a no-op).
    await db.asService((tx) => tx`select app.purge_family_data(${fam.familyId}, null)`);
    const after = await membershipStates(fam.familyId);
    expect(after[0]!.revoked_at?.getTime()).toBe(tomb!.revoked_at.getTime());
    const [done] = await db.sql<{ status: string }[]>`
      select status from public.deletion_requests where family_id = ${fam.familyId}`;
    expect(done!.status).toBe('completed');
    // The new family is untouched by the old family's purge.
    const [kept] = await db.sql<{ status: string }[]>`
      select status from public.family_memberships where family_id = ${fresh!.id} and user_id = ${fam.ownerId}`;
    expect(kept!.status).toBe('active');
  });

  it('the family’s other guardian is released too', async () => {
    const fam = await seedFamily(db, { childCount: 1 });
    const guardianId = await addGuardian(fam);
    await grantAdultUnlock(db, fam.ownerId);
    await db.asParent(
      fam.ownerId,
      (tx) => tx`select public.request_deletion(${fam.familyId}, null)`,
    );
    const states = await membershipStates(fam.familyId);
    expect(states.map((m) => [m.user_id, m.status])).toEqual([
      [fam.ownerId, 'revoked'],
      [guardianId, 'revoked'],
    ]);
    const [fresh] = await db.asParent(
      guardianId,
      (tx) =>
        tx<{ id: string }[]>`select public.create_family('Guardian starts over', 'UTC') as id`,
    );
    expect(fresh!.id).not.toBe(fam.familyId);
  });

  it('a child-scoped deletion request does not release anyone', async () => {
    const fam = await seedFamily(db, { childCount: 2 });
    const guardianId = await addGuardian(fam);
    await grantAdultUnlock(db, fam.ownerId);
    await db.asParent(
      fam.ownerId,
      (tx) => tx`select public.request_deletion(${fam.familyId}, ${fam.children[0]!.id})`,
    );
    const states = await membershipStates(fam.familyId);
    expect(states.map((m) => [m.user_id, m.status])).toEqual([
      [fam.ownerId, 'active'],
      [guardianId, 'active'],
    ]);
    await expect(
      db.asParent(fam.ownerId, (tx) => tx`select public.create_family('Again', 'UTC')`),
    ).rejects.toThrow(/already belongs to a family/);
  });

  it('a guardian removed before the deletion keeps their earlier revocation record', async () => {
    const fam = await seedFamily(db, { childCount: 1 });
    const removedId = await addGuardian(fam);
    const earlier = new Date('2026-01-01T00:00:00Z');
    await db.sql`
      update public.family_memberships set status = 'revoked', revoked_at = ${earlier}, revoked_by = ${fam.ownerId}
       where family_id = ${fam.familyId} and user_id = ${removedId}`;
    await grantAdultUnlock(db, fam.ownerId);
    await db.asParent(
      fam.ownerId,
      (tx) => tx`select public.request_deletion(${fam.familyId}, null)`,
    );
    const [removed] = await db.sql<{ revoked_at: Date }[]>`
      select revoked_at from public.family_memberships where family_id = ${fam.familyId} and user_id = ${removedId}`;
    expect(removed!.revoked_at.getTime()).toBe(earlier.getTime());
  });

  it('inactivity deletion releases the memberships with the tombstone', async () => {
    const NOW = new Date('2026-09-24T03:00:00Z');
    const IDLE_BEFORE = new Date('2025-09-24T03:00:00Z');
    const NOTICE_BEFORE = new Date('2026-08-25T03:00:00Z');
    const fam = await seedFamily(db, { childCount: 1 });
    const guardianId = await addGuardian(fam);
    await db.sql`
      update public.families set created_at = '2025-06-01T00:00:00Z', inactivity_notified_at = '2026-08-01T00:00:00Z'
       where id = ${fam.familyId}`;
    const [row] = await db.asService(
      (tx) => tx<{ id: string | null }[]>`
        select app.inactivity_delete_family(${fam.familyId}, ${NOW}, ${IDLE_BEFORE}, ${NOTICE_BEFORE}) as id`,
    );
    expect(row!.id).not.toBeNull();
    const states = await membershipStates(fam.familyId);
    expect(states.map((m) => [m.user_id, m.status])).toEqual([
      [fam.ownerId, 'revoked'],
      [guardianId, 'revoked'],
    ]);
    const [fresh] = await db.asParent(
      fam.ownerId,
      (tx) => tx<{ id: string }[]>`select public.create_family('Back again', 'UTC') as id`,
    );
    expect(fresh!.id).not.toBe(fam.familyId);
  });
});

// ---------------------------------------------------------------------------------------------
// DB-R1-03: pseudo-zones are not IANA zones
// ---------------------------------------------------------------------------------------------

describe('[DB-R1-03] families.timezone refuses the pseudo-zones Postgres lists but Intl rejects', () => {
  const PSEUDO = ['localtime', 'Factory', 'posixrules'];

  it('the zone cache carries no pseudo-zone', async () => {
    const rows = await db.sql<{ name: string }[]>`
      select name from private.known_time_zones
       where name in ('localtime', 'Factory', 'posixrules')
          or name like 'posix/%' or name like 'right/%'`;
    expect(rows).toEqual([]);
    // And still knows the real zones.
    const [real] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from private.known_time_zones where name in ('America/Chicago', 'Europe/Berlin', 'UTC')`;
    expect(real!.n).toBe(3);
  });

  it('a direct (PostgREST) update by an unlocked member cannot set one, a real zone still works', async () => {
    const fam = await seedFamily(db, { childCount: 0 });
    const SESSION = '0840d000-0000-4000-8000-000000000001';
    await grantAdultUnlock(db, fam.ownerId, SESSION, 600);
    const update = (zone: string) =>
      db.asParent(
        fam.ownerId,
        (tx) => tx`update public.families set timezone = ${zone} where id = ${fam.familyId}`,
        { sessionId: SESSION },
      );
    for (const zone of [...PSEUDO, 'posix/America/New_York', 'right/UTC']) {
      await expect(update(zone), zone).rejects.toMatchObject({
        code: '23514',
        constraint_name: 'families_timezone_iana',
      });
    }
    await update('America/Chicago');
    const [row] = await db.sql<{ timezone: string }[]>`
      select timezone from public.families where id = ${fam.familyId}`;
    expect(row!.timezone).toBe('America/Chicago');
  });

  it('create_family refuses a pseudo-zone', async () => {
    const adult = await db.createUser();
    await expect(
      db.asParent(adult, (tx) => tx`select public.create_family('Zones', 'localtime')`),
    ).rejects.toMatchObject({ code: '23514', constraint_name: 'families_timezone_iana' });
  });
});

// ---------------------------------------------------------------------------------------------
// DB-R1-04: safety_reports by family
// ---------------------------------------------------------------------------------------------

describe('[DB-R1-04] the parent safety-report list is served by a family index', () => {
  it('safety_reports_family serves GET /safety-reports (privacy.ts)', async () => {
    expect(await indexDefinition('safety_reports', 'safety_reports_family')).toBe(
      'CREATE INDEX safety_reports_family ON public.safety_reports USING btree (family_id, created_at DESC)',
    );
    const fams = [await seedFamily(db), await seedFamily(db)];
    for (const f of fams) {
      await db.sql`
        insert into public.safety_reports (family_id, child_id, reporter_kind, category, note)
        select ${f.familyId}::uuid, ${f.children[0]!.id}::uuid, 'parent', 'other', 'synthetic'
          from generate_series(1, 3000)`;
    }
    await db.sql`analyze public.safety_reports`;
    const list = await plan(
      `select id from public.safety_reports where family_id = '${fams[0]!.familyId}' order by created_at desc limit 100`,
    );
    expect(list).toContain('safety_reports_family');
    expect(list).not.toContain('Seq Scan');
  });
});
