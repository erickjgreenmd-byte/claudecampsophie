import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb, type Tx } from './harness.ts';
import { grantAdultUnlock, seedFamily, type SeededFamily } from './fixtures.ts';

/**
 * Migration 0860 (hardening round 2, database findings DB-R2-01..05, 07, 08 and API-AUTH-R2-01/02)
 * against real Postgres:
 *   * the hot per-family / per-child / per-attempt predicates the jobs and the parent routes run
 *     have an index path, checked with bulk rows belonging to OTHER families (as in production);
 *   * no client role keeps TRUNCATE, TRIGGER or REFERENCES on a public table, so a statement that
 *     runs as `authenticated` cannot empty an append-only ledger behind RLS and the guards;
 *   * the Supabase Data API (PostgREST as `authenticated`) is held to the same rules the Hono routes
 *     enforce: no direct child-profile or safety-report writes at all, and no learning, reward or
 *     support write for an archived child, for a child whose deletion is under way, carrying
 *     control characters, or beyond the per-family hourly bound;
 *   * a child profile cannot go back to 'active' while a deletion request covers it;
 *   * pairing codes and expired spend holds are pruned.
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

async function pgMessage(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

/** A user id usable as `overridden_by` / `requested_by` in bulk fixtures. */
async function someUser(): Promise<string> {
  return db.createUser();
}

// ---------------------------------------------------------------------------------------------
// DB-R2-01: attempt_overrides by attempt
// ---------------------------------------------------------------------------------------------

describe('[DB-R2-01] the evidence load probes attempt_overrides by attempt_id', () => {
  it('attempt_overrides_attempt serves the loadEvidence lateral (learning-jobs.ts)', async () => {
    expect(await indexDefinition('public', 'attempt_overrides', 'attempt_overrides_attempt')).toBe(
      'CREATE INDEX attempt_overrides_attempt ON public.attempt_overrides USING btree (attempt_id, created_at DESC)',
    );

    // The overrides table holds every family's parent corrections; the child under test has a few.
    const fam = await seedFamily(db, { childCount: 1 });
    const noisy = await seedFamily(db, { childCount: 1 });
    const overrider = await someUser();
    for (const f of [noisy, fam]) {
      const rows = f === noisy ? 4000 : 50;
      await db.sql`
        insert into public.attempts (family_id, child_id, question_instance_id, source, subject_key,
                                     skill, attempt_number, correctness, grader_version,
                                     idempotency_key, occurred_at)
        select ${f.familyId}::uuid, ${f.children[0]!.id}::uuid, gen_random_uuid(), 'daily', 'math',
               'math.add_within_20', 1, 'correct', 'g1', 'r2-01:' || ${f.familyId}::text || ':' || g,
               now() - make_interval(hours => (g % 480))
          from generate_series(1, ${rows}) g`;
    }
    await db.sql`
      insert into public.attempt_overrides (attempt_id, family_id, correctness, reason, overridden_by)
      select a.id, a.family_id, 'incorrect', 'synthetic review', ${overrider}::uuid
        from public.attempts a where a.family_id = ${noisy.familyId}`;
    await db.sql`analyze public.attempts`;
    await db.sql`analyze public.attempt_overrides`;

    const evidence = await plan(
      `select recent.* from (
         select a.id, a.correctness, a.occurred_at, o.correctness as override_correctness
           from public.attempts a
           left join lateral (
             select correctness, created_at from public.attempt_overrides
              where attempt_id = a.id order by created_at desc limit 1
           ) o on true
          where a.child_id = '${fam.children[0]!.id}' and a.family_id = '${fam.familyId}'
            and a.occurred_at >= now() - interval '21 days'
          order by a.occurred_at desc, a.id desc
          limit 5000
       ) recent order by recent.occurred_at, recent.id`,
    );
    expect(evidence).toContain('attempt_overrides_attempt');
    expect(evidence).not.toContain('Seq Scan on attempt_overrides');
  });
});

// ---------------------------------------------------------------------------------------------
// DB-R2-02: the inactivity sweep's lastActive subqueries
// ---------------------------------------------------------------------------------------------

describe('[DB-R2-02] the inactivity sweep reaches each family activity source by index', () => {
  it('assignments, attempts and memberships are indexed by family for lastActive (dispatcher.ts)', async () => {
    expect(await indexDefinition('public', 'assignments', 'assignments_family_created')).toBe(
      'CREATE INDEX assignments_family_created ON public.assignments USING btree (family_id, created_at DESC)',
    );
    expect(await indexDefinition('public', 'attempts', 'attempts_family_created')).toBe(
      'CREATE INDEX attempts_family_created ON public.attempts USING btree (family_id, created_at DESC)',
    );
    expect(await indexDefinition('public', 'family_memberships', 'family_memberships_family')).toBe(
      'CREATE INDEX family_memberships_family ON public.family_memberships USING btree (family_id)',
    );

    // Many families (the sweep walks all of them) and a bulk of assignments/attempts.
    const owner = await someUser();
    await db.sql`
      insert into public.families (display_name, timezone, created_by)
      select 'Sweep family ' || g, 'America/Chicago', ${owner}::uuid from generate_series(1, 400) g`;
    // Guardian history: a revoked membership stays on the row, so the table grows past the family
    // count and a per-family MAX(last_seen_at) is no longer answerable by reading it whole.
    await db.sql`
      insert into public.family_memberships (family_id, user_id, role, status, revoked_at, last_seen_at)
      select f.id, ${owner}::uuid, 'guardian', 'revoked', now(), now() - interval '2 years'
        from public.families f, generate_series(1, 10)
       where f.display_name like 'Sweep family %'`;
    const fam = await seedFamily(db, { childCount: 1 });
    await db.sql`
      insert into public.assignments (family_id, child_id, status, idempotency_key, created_by_kind)
      select ${fam.familyId}::uuid, ${fam.children[0]!.id}::uuid, 'draft', 'r2-02-assignment:' || g, 'parent'
        from generate_series(1, 4000) g`;
    await db.sql`
      insert into public.attempts (family_id, child_id, question_instance_id, source, subject_key,
                                   skill, attempt_number, correctness, grader_version,
                                   idempotency_key, occurred_at)
      select ${fam.familyId}::uuid, ${fam.children[0]!.id}::uuid, gen_random_uuid(), 'daily', 'math',
             'math.add_within_20', 1, 'correct', 'g1', 'r2-02-att:' || g, now()
        from generate_series(1, 4000) g`;
    await db.sql`analyze public.families`;
    await db.sql`analyze public.assignments`;
    await db.sql`analyze public.attempts`;
    await db.sql`analyze public.family_memberships`;

    // dispatcher.ts inactivitySweep candidate query, with lastActive inlined.
    const candidates = await plan(
      `select f.id, f.created_by, f.inactivity_notified_at
         from public.families f
        where f.deleted_at is null
          and greatest(
                f.created_at,
                coalesce((select max(m.last_seen_at) from public.family_memberships m where m.family_id = f.id), f.created_at),
                coalesce((select max(a.created_at) from public.assignments a where a.family_id = f.id), f.created_at),
                coalesce((select max(t.created_at) from public.attempts t where t.family_id = f.id), f.created_at))
              < now() - interval '18 months'
        order by f.inactivity_notified_at nulls first, f.id
        limit 50`,
    );
    expect(candidates).toContain('assignments_family_created');
    expect(candidates).toContain('attempts_family_created');
    expect(candidates).toContain('family_memberships_family');
    expect(candidates).not.toContain('Seq Scan on assignments');
    expect(candidates).not.toContain('Seq Scan on attempts');
    expect(candidates).not.toContain('Seq Scan on family_memberships');
  });
});

// ---------------------------------------------------------------------------------------------
// DB-R2-03: the AI spend admission sum
// ---------------------------------------------------------------------------------------------

describe('[DB-R2-03] the spend admission sums the month by index, not by scanning history', () => {
  it('ai_usage_events_created serves the month sum (spend-ceiling.ts, dispatcher.ts, ops-metrics.ts)', async () => {
    expect(await indexDefinition('public', 'ai_usage_events', 'ai_usage_events_created')).toBe(
      'CREATE INDEX ai_usage_events_created ON public.ai_usage_events USING btree (created_at) INCLUDE (cost_micros)',
    );
    const fam = await seedFamily(db, { childCount: 1 });
    // Twelve months of history; the admission only ever sums the current month.
    await db.sql`
      insert into public.ai_usage_events (family_id, child_id, stage, model_id, prompt_version,
                                          status, input_tokens, output_tokens, latency_ms,
                                          cost_micros, rate_table_version, created_at)
      select ${fam.familyId}::uuid, ${fam.children[0]!.id}::uuid, 'grading', 'm', 'p1', 'succeeded',
             10, 10, 5, 100, 'v1', now() - make_interval(days => (g % 360))
        from generate_series(1, 24000) g`;
    await db.sql`analyze public.ai_usage_events`;
    const admission = await plan(
      `select coalesce((select sum(cost_micros) from public.ai_usage_events
                         where created_at >= date_trunc('month', now())), 0)`,
    );
    expect(admission).toContain('ai_usage_events_created');
    expect(admission).not.toContain('Seq Scan on ai_usage_events');
  });
});

// ---------------------------------------------------------------------------------------------
// DB-R2-07: per-request parent and child reads
// ---------------------------------------------------------------------------------------------

describe('[DB-R2-07] the remaining per-request family and child reads have an index path', () => {
  it('rewards requests, test dates, study material, devices and exports are indexed', async () => {
    const definitions: [string, string, string][] = [
      [
        'reward_redemptions',
        'reward_redemptions_family_state',
        'CREATE INDEX reward_redemptions_family_state ON public.reward_redemptions USING btree (family_id, state, requested_at)',
      ],
      [
        'test_dates',
        'test_dates_child',
        'CREATE INDEX test_dates_child ON public.test_dates USING btree (child_id, test_date)',
      ],
      [
        'study_materials',
        'study_materials_child_created',
        'CREATE INDEX study_materials_child_created ON public.study_materials USING btree (child_id, created_at DESC)',
      ],
      [
        'child_devices',
        'child_devices_family',
        'CREATE INDEX child_devices_family ON public.child_devices USING btree (family_id, paired_at DESC)',
      ],
      [
        'data_exports',
        'data_exports_family',
        'CREATE INDEX data_exports_family ON public.data_exports USING btree (family_id, created_at DESC)',
      ],
    ];
    for (const [table, name, def] of definitions) {
      expect(await indexDefinition('public', table, name), `${table}.${name}`).toBe(def);
    }

    const fam = await seedFamily(db, { childCount: 1 });
    const noisy = await seedFamily(db, { childCount: 1 });
    const requester = await someUser();
    for (const f of [noisy, fam]) {
      const n = f === noisy ? 3000 : 5;
      const child = f.children[0]!.id;
      const [subject] = await db.sql<{ id: string }[]>`
        insert into public.child_subjects (family_id, child_id, subject_key, display_name)
        values (${f.familyId}, ${child}, 'math', 'Math') returning id`;
      const [reward] = await db.sql<{ id: string }[]>`
        insert into public.rewards (family_id, child_id, title, point_cost, created_by)
        values (${f.familyId}, ${child}, 'Extra reading time', 10, ${requester}) returning id`;
      await db.sql`
        insert into public.reward_redemptions (family_id, child_id, reward_id, point_cost, state)
        select ${f.familyId}::uuid, ${child}::uuid, ${reward!.id}::uuid, 10, 'pending'
          from generate_series(1, ${n})`;
      await db.sql`
        insert into public.test_dates (family_id, child_id, subject_id, test_date)
        select ${f.familyId}::uuid, ${child}::uuid, ${subject!.id}::uuid, '2030-01-01'::date + g
          from generate_series(1, ${n}) g`;
      await db.sql`
        insert into public.study_materials (family_id, child_id, subject_id, kind, content_text)
        select ${f.familyId}::uuid, ${child}::uuid, ${subject!.id}::uuid, 'taught_notes', 'synthetic notes'
          from generate_series(1, ${n})`;
      await db.sql`
        insert into public.child_devices (family_id, child_id, label, platform)
        select ${f.familyId}::uuid, ${child}::uuid, 'Tablet', 'ios' from generate_series(1, ${n})`;
      await db.sql`
        insert into public.data_exports (family_id, requested_by, kind, child_id)
        select ${f.familyId}::uuid, ${requester}::uuid, 'progress_pdf', ${child}::uuid
          from generate_series(1, ${n})`;
    }
    for (const table of [
      'public.reward_redemptions',
      'public.test_dates',
      'public.study_materials',
      'public.child_devices',
      'public.data_exports',
    ]) {
      await db.sql.unsafe(`analyze ${table}`);
    }

    const child = fam.children[0]!.id;
    // rewards.ts parent overview: open requests of the family
    const requests = await plan(
      `select r.id from public.reward_redemptions r
        where r.family_id = '${fam.familyId}' and r.state in ('pending', 'approved')
        order by r.requested_at, r.id`,
    );
    expect(requests).toContain('reward_redemptions_family_state');
    expect(requests).not.toContain('Seq Scan on reward_redemptions');

    // learning.ts test-date list / learning-jobs.ts loadTestDates
    const testDates = await plan(
      `select t.id from public.test_dates t
        where t.child_id = '${child}' and t.family_id = '${fam.familyId}' order by t.test_date, t.id`,
    );
    expect(testDates).toContain('test_dates_child');
    expect(testDates).not.toContain('Seq Scan on test_dates');

    // learning-jobs.ts material selection for every practice job
    const materials = await plan(
      `select m.id from public.study_materials m
        where m.child_id = '${child}' and m.family_id = '${fam.familyId}'
          and m.content_text is not null and m.created_at >= now() - interval '21 days'
        order by m.created_at desc, m.id limit 20`,
    );
    // Either new index answers it without a scan; the planner picks by selectivity.
    expect(materials).toMatch(/study_materials_(child|family)_created/);
    expect(materials).not.toContain('Seq Scan on study_materials');

    // family.ts device list
    const devices = await plan(
      `select id from public.child_devices where family_id = '${fam.familyId}' order by paired_at desc`,
    );
    expect(devices).toContain('child_devices_family');
    expect(devices).not.toContain('Seq Scan on child_devices');

    // privacy.ts export list
    const exports = await plan(
      `select id from public.data_exports where family_id = '${fam.familyId}'
        order by created_at desc limit 100`,
    );
    expect(exports).toContain('data_exports_family');
    expect(exports).not.toContain('Seq Scan on data_exports');
  });
});

// ---------------------------------------------------------------------------------------------
// DB-R2-04: TRUNCATE, TRIGGER and REFERENCES are not client privileges
// ---------------------------------------------------------------------------------------------

describe('[DB-R2-04] no client role holds TRUNCATE, TRIGGER or REFERENCES in public', () => {
  it('the three privileges are revoked from anon, authenticated and pl_child on every table', async () => {
    const rows = await db.sql<{ grantee: string; table_name: string; privilege_type: string }[]>`
      select grantee, table_name, privilege_type
        from information_schema.role_table_grants
       where table_schema = 'public'
         and grantee in ('anon', 'authenticated', 'pl_child', 'PUBLIC')
         and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES')
       order by table_name, grantee, privilege_type`;
    expect(rows).toEqual([]);
  });

  it('the default privileges for new public tables no longer carry them', async () => {
    const rows = await db.sql<{ acl: string }[]>`
      select unnest(d.defaclacl)::text as acl
        from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
       where n.nspname = 'public' and d.defaclobjtype = 'r'`;
    const client = rows.map((r) => r.acl).filter((a) => /^(anon|authenticated|pl_child)=/.test(a));
    expect(client.filter((a) => /[tDx]/.test(a.split('=')[1]!.split('/')[0]!))).toEqual([]);
  });

  it('a statement running as authenticated can no longer TRUNCATE an append-only ledger', async () => {
    const fam = await seedFamily(db, { childCount: 1 });
    await db.sql`
      insert into public.ai_usage_events (family_id, child_id, stage, model_id, prompt_version,
                                          status, input_tokens, output_tokens, latency_ms,
                                          cost_micros, rate_table_version)
      values (${fam.familyId}, ${fam.children[0]!.id}, 'grading', 'm', 'p1', 'succeeded',
              10, 10, 5, 100, 'v1')`;
    // The append-only trigger already refuses a DELETE; TRUNCATE fires no row trigger and ignores
    // RLS, so only the missing privilege stops it.
    for (const table of [
      'public.ai_usage_events',
      'public.audit_events',
      'public.consent_records',
      'public.points_ledger',
    ]) {
      const message = await pgMessage(
        db.asParent(fam.ownerId, (tx) => tx.unsafe(`truncate ${table}`)),
      );
      expect(message, table).toMatch(/permission denied/);
    }
    const [left] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from public.ai_usage_events where family_id = ${fam.familyId}`;
    expect(left!.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// DB-R2-05 / API-AUTH-R2-01: the Data API is held to the API's rules
// ---------------------------------------------------------------------------------------------

/** Seeds a family whose child is archived, plus an active child, and an unlocked adult session. */
async function familyWithArchivedChild(): Promise<{
  fam: SeededFamily;
  activeChild: string;
  archivedChild: string;
  subjectOfActive: string;
  subjectOfArchived: string;
}> {
  const fam = await seedFamily(db, { childCount: 2 });
  const activeChild = fam.children[0]!.id;
  const archivedChild = fam.children[1]!.id;
  await db.sql`update public.child_profiles set status = 'archived', archived_at = now()
                where id = ${archivedChild}`;
  const subject = async (child: string, name: string) => {
    const [row] = await db.sql<{ id: string }[]>`
      insert into public.child_subjects (family_id, child_id, subject_key, display_name)
      values (${fam.familyId}, ${child}, 'math', ${name}) returning id`;
    return row!.id;
  };
  await grantAdultUnlock(db, fam.ownerId, undefined, 3600);
  return {
    fam,
    activeChild,
    archivedChild,
    subjectOfActive: await subject(activeChild, 'Math A'),
    subjectOfArchived: await subject(archivedChild, 'Math B'),
  };
}

describe('[API-AUTH-R2-01] child profiles and safety reports are not writable through the Data API', () => {
  it('authenticated holds no insert or update privilege on child_profiles or safety_reports', async () => {
    const rows = await db.sql<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and grantee = 'authenticated'
         and table_name in ('child_profiles', 'safety_reports')
         and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
       order by table_name, privilege_type`;
    expect(rows).toEqual([]);
    const columns = await db.sql<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.column_privileges
       where table_schema = 'public' and grantee = 'authenticated'
         and table_name in ('child_profiles', 'safety_reports')
         and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
       order by table_name, privilege_type`;
    expect(columns).toEqual([]);
  });

  it('a parent cannot create draft profiles past the API cap, nor a grade 9-12 / 14-18 profile', async () => {
    const fam = await seedFamily(db, { childCount: 1 });
    await grantAdultUnlock(db, fam.ownerId, undefined, 3600);
    expect(
      await pgMessage(
        db.asParent(
          fam.ownerId,
          (tx) => tx`
            insert into public.child_profiles (family_id, nickname, grade_level, age_band)
            select ${fam.familyId}::uuid, 'Bulk ' || g, 4, '8-10' from generate_series(1, 40) g`,
        ),
      ),
    ).toMatch(/permission denied/);
    expect(
      await pgMessage(
        db.asParent(
          fam.ownerId,
          (tx) => tx`
            insert into public.child_profiles (family_id, nickname, grade_level, age_band)
            values (${fam.familyId}, 'Teen', 12, '14-18')`,
        ),
      ),
    ).toMatch(/permission denied/);
    expect(
      await pgMessage(
        db.asParent(
          fam.ownerId,
          (tx) => tx`
            update public.child_profiles set grade_level = 12, age_band = '14-18'
             where id = ${fam.children[0]!.id}`,
        ),
      ),
    ).toMatch(/permission denied/);
    const [count] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from public.child_profiles where family_id = ${fam.familyId}`;
    expect(count!.n).toBe(1);
  });

  it('a parent cannot bulk-file safety reports through the Data API', async () => {
    const fam = await seedFamily(db, { childCount: 1 });
    expect(
      await pgMessage(
        db.asParent(
          fam.ownerId,
          (tx) => tx`
            insert into public.safety_reports (family_id, reporter_kind, category)
            select ${fam.familyId}::uuid, 'parent', 'other' from generate_series(1, 500)`,
        ),
      ),
    ).toMatch(/permission denied/);
    const [count] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from public.safety_reports where family_id = ${fam.familyId}`;
    expect(count!.n).toBe(0);
  });
});

describe('[DB-R2-05] the Data API refuses learning, reward and support writes the API refuses', () => {
  it('an archived child takes no new subject, test date, study material, schedule or reward', async () => {
    const s = await familyWithArchivedChild();
    const statements: [string, (tx: Tx) => Promise<unknown>][] = [
      [
        'child_subjects',
        (
          tx,
        ) => tx`insert into public.child_subjects (family_id, child_id, subject_key, display_name)
                   values (${s.fam.familyId}, ${s.archivedChild}, 'custom', 'Chess club')`,
      ],
      [
        'test_dates',
        (tx) => tx`insert into public.test_dates (family_id, child_id, subject_id, test_date)
                   values (${s.fam.familyId}, ${s.archivedChild}, ${s.subjectOfArchived}, '2030-05-05')`,
      ],
      [
        'study_materials',
        (
          tx,
        ) => tx`insert into public.study_materials (family_id, child_id, subject_id, kind, content_text)
                   values (${s.fam.familyId}, ${s.archivedChild}, ${s.subjectOfArchived}, 'taught_notes', 'notes')`,
      ],
      [
        'learning_schedules',
        (tx) => tx`insert into public.learning_schedules (child_id, family_id)
                   values (${s.archivedChild}, ${s.fam.familyId})`,
      ],
      [
        'rewards',
        (tx) => tx`insert into public.rewards (family_id, child_id, title, point_cost, created_by)
                   values (${s.fam.familyId}, ${s.archivedChild}, 'Ice cream', 5, ${s.fam.ownerId})`,
      ],
    ];
    for (const [label, statement] of statements) {
      expect(await pgMessage(db.asParent(s.fam.ownerId, statement)), label).toMatch(/archived/i);
    }
    // The same writes for the ACTIVE child still work through the same grants (the API path).
    expect(
      await pgMessage(
        db.asParent(
          s.fam.ownerId,
          (tx) => tx`
            insert into public.test_dates (family_id, child_id, subject_id, test_date)
            values (${s.fam.familyId}, ${s.activeChild}, ${s.subjectOfActive}, '2030-05-05')`,
        ),
      ),
    ).toBeUndefined();
  });

  it('an existing reward of an archived child can still be renamed and switched off', async () => {
    // routes/rewards.ts PATCH /rewards/:id has no archived check (only POST does), so the guard must
    // not invent one: a parent who archived a child still needs to deactivate that child's rewards.
    const s = await familyWithArchivedChild();
    const [reward] = await db.sql<{ id: string }[]>`
      insert into public.rewards (family_id, child_id, title, point_cost, created_by)
      values (${s.fam.familyId}, ${s.archivedChild}, 'Ice cream', 5, ${s.fam.ownerId}) returning id`;
    expect(
      await pgMessage(
        db.asParent(
          s.fam.ownerId,
          (tx) => tx`update public.rewards set active = false, title = 'Ice cream (retired)'
                      where id = ${reward!.id} and family_id = ${s.fam.familyId}`,
        ),
      ),
    ).toBeUndefined();
    // Control characters are still refused on that same update.
    expect(
      await pgMessage(
        db.asParent(
          s.fam.ownerId,
          (tx) => tx`update public.rewards set title = ${'Ice' + String.fromCodePoint(7) + 'cream'}
                      where id = ${reward!.id} and family_id = ${s.fam.familyId}`,
        ),
      ),
    ).toMatch(/control character/i);
  });

  it('a child whose deletion is under way takes no learning or reward write', async () => {
    const s = await familyWithArchivedChild();
    await db.sql`
      insert into public.deletion_requests (family_id, scope, child_id, target_child_id, requested_by)
      values (${s.fam.familyId}, 'child', ${s.activeChild}, ${s.activeChild}, ${s.fam.ownerId})`;
    expect(
      await pgMessage(
        db.asParent(
          s.fam.ownerId,
          (tx) => tx`
            insert into public.study_materials (family_id, child_id, subject_id, kind, content_text)
            values (${s.fam.familyId}, ${s.activeChild}, ${s.subjectOfActive}, 'taught_notes', 'notes')`,
        ),
      ),
    ).toMatch(/deletion/i);
  });

  it('control characters are refused in the free text the Data API can write (L-028 in the database)', async () => {
    const s = await familyWithArchivedChild();
    expect(
      await pgMessage(
        db.asParent(
          s.fam.ownerId,
          (tx) => tx`
            insert into public.test_dates (family_id, child_id, subject_id, test_date, scope_notes)
            values (${s.fam.familyId}, ${s.activeChild}, ${s.subjectOfActive}, '2030-06-06',
                    ${'chapters 1-3' + String.fromCodePoint(7)})`,
        ),
      ),
    ).toMatch(/control character/i);
    expect(
      await pgMessage(
        db.asParent(
          s.fam.ownerId,
          (tx) => tx`
            insert into public.child_subjects (family_id, child_id, subject_key, display_name)
            values (${s.fam.familyId}, ${s.activeChild}, 'custom', ${'Chess' + String.fromCodePoint(1)})`,
        ),
      ),
    ).toMatch(/control character/i);
    // Tabs and newlines are ordinary text and stay allowed.
    expect(
      await pgMessage(
        db.asParent(
          s.fam.ownerId,
          (tx) => tx`
            insert into public.study_materials (family_id, child_id, kind, content_text)
            values (${s.fam.familyId}, ${s.activeChild}, 'taught_notes', ${'line one\nline two\tend'})`,
        ),
      ),
    ).toBeUndefined();
  });

  it('a bulk Data-API insert is stopped by the per-family hourly bound on each table', async () => {
    const s = await familyWithArchivedChild();
    const child = s.activeChild;
    // study_materials: the API bound is 30/hour per family; 200 rows of 20 000 characters was the
    // reported flood.
    expect(
      await pgMessage(
        db.asParent(
          s.fam.ownerId,
          (tx) => tx`
            insert into public.study_materials (family_id, child_id, kind, content_text)
            select ${s.fam.familyId}::uuid, ${child}::uuid, 'taught_notes', repeat('a', 20000)
              from generate_series(1, 200)`,
        ),
      ),
    ).toMatch(/too many/i);
    // child_subjects: the six defaults per child are free, custom subjects are bounded.
    expect(
      await pgMessage(
        db.asParent(
          s.fam.ownerId,
          (tx) => tx`
            insert into public.child_subjects (family_id, child_id, subject_key, display_name)
            select ${s.fam.familyId}::uuid, ${child}::uuid, 'custom', 'Club ' || g
              from generate_series(1, 200) g`,
        ),
      ),
    ).toMatch(/too many/i);
    // support_cases and support_case_messages: the owner's queues cannot be flooded.
    expect(
      await pgMessage(
        db.asParent(
          s.fam.ownerId,
          (tx) => tx`
            insert into public.support_cases (family_id, opened_by_user_id, opened_by_kind, kind, subject, body)
            select ${s.fam.familyId}::uuid, ${s.fam.ownerId}::uuid, 'parent', 'other',
                   'Subject ' || g, 'Synthetic body' from generate_series(1, 500) g`,
        ),
      ),
    ).toMatch(/too many/i);
    const [cases] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from public.support_cases where family_id = ${s.fam.familyId}`;
    expect(cases!.n).toBe(0);
  });

  it('a single write of each kind still succeeds, so the API routes keep working', async () => {
    const s = await familyWithArchivedChild();
    await db.asParent(s.fam.ownerId, async (tx) => {
      await tx`insert into public.child_subjects (family_id, child_id, subject_key, display_name)
               values (${s.fam.familyId}, ${s.activeChild}, 'custom', 'Chess club')`;
      await tx`insert into public.learning_schedules (child_id, family_id)
               values (${s.activeChild}, ${s.fam.familyId})`;
      await tx`update public.learning_schedules set daily_question_count = 7
                where child_id = ${s.activeChild}`;
      await tx`insert into public.rewards (family_id, child_id, title, point_cost, created_by)
               values (${s.fam.familyId}, ${s.activeChild}, 'Ice cream', 5, ${s.fam.ownerId})`;
      await tx`insert into public.support_cases (family_id, opened_by_user_id, opened_by_kind, kind, subject, body)
               values (${s.fam.familyId}, ${s.fam.ownerId}, 'parent', 'other', 'Hello', 'Synthetic body')`;
    });
    const [n] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from public.support_cases where family_id = ${s.fam.familyId}`;
    expect(n!.n).toBe(1);
  });

  it('the service role is not held to the Data-API bounds (jobs and API service writes)', async () => {
    const s = await familyWithArchivedChild();
    // A job writes for an archived child's history and in bulk; only the parent role is bounded.
    await db.asService(
      (tx) => tx`
        insert into public.study_materials (family_id, child_id, kind, content_text)
        select ${s.fam.familyId}::uuid, ${s.archivedChild}::uuid, 'taught_notes', 'job notes'
          from generate_series(1, 100)`,
    );
    const [n] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from public.study_materials where child_id = ${s.archivedChild}`;
    expect(n!.n).toBe(100);
  });

  it('the lazily created default subjects of a large family never bound a real parent action', async () => {
    // Regression for the first attempt's DB-R2-05 guard, which counted every child_subjects row of
    // the family in the sliding hour. A parent with 7 children (CHILD_PROFILE_LIMIT is 12) who opens
    // each child's subject list once has 7 x 6 = 42 rows created by ensureLearningDefaults
    // (apps/api/src/jobs/learning-jobs.ts:186-194), a read path the API's own limiter never counts
    // (RATE_RULES.subjectCreatePerFamily = 20 counts POST /children/:childId/subjects requests
    // only). The bound must therefore ignore those rows, and must not apply to an UPDATE at all:
    // PATCH /children/:childId/subjects has no limiter and adds no row.
    const fam = await seedFamily(db, { childCount: 7 });
    const defaults: [string, string][] = [
      ['math', 'Math'],
      ['reading', 'Reading'],
      ['spelling_vocabulary', 'Spelling & Vocabulary'],
      ['grammar_writing', 'Grammar & Writing'],
      ['science', 'Science'],
      ['social_studies', 'Social Studies'],
    ];
    await db.asParent(fam.ownerId, async (tx) => {
      for (const child of fam.children)
        for (const [key, name] of defaults)
          await tx`insert into public.child_subjects (family_id, child_id, subject_key, display_name)
                   values (${fam.familyId}, ${child.id}, ${key}, ${name})`;
    });
    const [seeded] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from public.child_subjects where family_id = ${fam.familyId}`;
    expect(seeded!.n).toBe(42);

    const first = fam.children[0]!.id;
    const [toggled] = await db.sql<{ id: string }[]>`
      select id from public.child_subjects where child_id = ${first} and subject_key = 'science'`;
    // PATCH /children/:childId/subjects (toggle a subject off, then rename it).
    expect(
      await pgMessage(
        db.asParent(
          fam.ownerId,
          (tx) => tx`update public.child_subjects set enabled = false
                      where id = ${toggled!.id} and child_id = ${first} and family_id = ${fam.familyId}`,
        ),
      ),
    ).toBeUndefined();
    // POST /children/:childId/subjects with one custom subject, well inside the API's 20/hour.
    expect(
      await pgMessage(
        db.asParent(
          fam.ownerId,
          (
            tx,
          ) => tx`insert into public.child_subjects (family_id, child_id, subject_key, display_name)
                      values (${fam.familyId}, ${first}, 'custom', 'Chess club')`,
        ),
      ),
    ).toBeUndefined();
    // The flood bound still holds for rows the API's limiter does count, whatever subject_key they
    // carry (child_subjects_unique_name is per child and lower(display_name), so a non-custom key
    // with fresh names is a flood vector too).
    expect(
      await pgMessage(
        db.asParent(
          fam.ownerId,
          (
            tx,
          ) => tx`insert into public.child_subjects (family_id, child_id, subject_key, display_name)
                      select ${fam.familyId}::uuid, ${first}::uuid, 'math', 'Extra math ' || g
                        from generate_series(1, 200) g`,
        ),
      ),
    ).toMatch(/too many/i);
  });
});

// ---------------------------------------------------------------------------------------------
// API-AUTH-R2-02: no activation while a deletion request covers the child
// ---------------------------------------------------------------------------------------------

describe('[API-AUTH-R2-02] a child under deletion cannot be activated again', () => {
  it('a child-scope request blocks its own child; a family-scope request blocks every child', async () => {
    const fam = await seedFamily(db, { childCount: 2 });
    const [a, b] = fam.children;
    await db.sql`update public.child_profiles set status = 'draft' where family_id = ${fam.familyId}`;
    await db.sql`
      insert into public.deletion_requests (family_id, scope, child_id, target_child_id, requested_by)
      values (${fam.familyId}, 'child', ${a!.id}, ${a!.id}, ${fam.ownerId})`;
    expect(
      await pgMessage(
        db.asService(
          (tx) => tx`update public.child_profiles set status = 'active' where id = ${a!.id}`,
        ),
      ),
    ).toMatch(/deletion/i);
    // The other child of the same family is untouched by a child-scope request.
    expect(
      await pgMessage(
        db.asService(
          (tx) => tx`update public.child_profiles set status = 'active' where id = ${b!.id}`,
        ),
      ),
    ).toBeUndefined();

    const other = await seedFamily(db, { childCount: 1 });
    await db.sql`update public.child_profiles set status = 'draft' where family_id = ${other.familyId}`;
    await db.sql`
      insert into public.deletion_requests (family_id, scope, requested_by)
      values (${other.familyId}, 'family', ${other.ownerId})`;
    expect(
      await pgMessage(
        db.asService(
          (tx) =>
            tx`update public.child_profiles set status = 'active' where id = ${other.children[0]!.id}`,
        ),
      ),
    ).toMatch(/deletion/i);
  });

  it('a fixture that must simulate the blocked state turns triggers off, as ledger fixtures do', async () => {
    // The backstop makes "active while a deletion is open" unreachable through any writer, so a test
    // that has to stage that state (apps/api/tests/family-profile.review.test.ts proves the
    // pairing-code route has its own check and does not rely on the status) states it as a superuser
    // fixture with session_replication_role = replica, the same way hardening_r1_db.test.ts backdates
    // the append-only job ledger. Recorded here so the escape hatch is a documented one.
    const fam = await seedFamily(db, { childCount: 1 });
    const child = fam.children[0]!.id;
    await db.sql`update public.child_profiles set status = 'archived', archived_at = now() where id = ${child}`;
    await db.sql`
      insert into public.deletion_requests (family_id, scope, child_id, target_child_id, requested_by)
      values (${fam.familyId}, 'child', ${child}, ${child}, ${fam.ownerId})`;
    await db.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update public.child_profiles set status = 'active' where id = ${child}`;
    });
    const [row] = await db.sql<{ status: string }[]>`
      select status from public.child_profiles where id = ${child}`;
    expect(row!.status).toBe('active');
  });

  it('a completed or cancelled request does not block activation', async () => {
    const fam = await seedFamily(db, { childCount: 1 });
    const child = fam.children[0]!.id;
    await db.sql`update public.child_profiles set status = 'draft' where id = ${child}`;
    await db.sql`
      insert into public.deletion_requests (family_id, scope, child_id, target_child_id, requested_by,
                                            status, completed_at)
      values (${fam.familyId}, 'child', ${child}, ${child}, ${fam.ownerId}, 'completed', now())`;
    expect(
      await pgMessage(
        db.asService(
          (tx) => tx`update public.child_profiles set status = 'active' where id = ${child}`,
        ),
      ),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// DB-R2-08: pairing codes and expired spend holds are pruned
// ---------------------------------------------------------------------------------------------

describe('[DB-R2-08] pairing codes and expired spend holds are pruned', () => {
  it('child_pairing_codes_family_child serves the purge delete', async () => {
    expect(
      await indexDefinition('private', 'child_pairing_codes', 'child_pairing_codes_family_child'),
    ).toBe(
      'CREATE INDEX child_pairing_codes_family_child ON private.child_pairing_codes USING btree (family_id, child_id)',
    );
  });

  it('prune_credential_rows deletes consumed and expired codes past the horizon and keeps live ones', async () => {
    const fam = await seedFamily(db, { childCount: 1 });
    const child = fam.children[0]!.id;
    // Each insert consumes the child's previous live code (migration 0720), so the intended
    // timestamps are stamped afterwards: this fixture states exactly one state per row.
    const code = async (
      label: string,
      values: { createdDaysAgo: number; expiresDaysAgo: number; consumedDaysAgo?: number },
    ) => {
      const hash = Buffer.from(label.padEnd(32, '.'));
      await db.sql`
        insert into private.child_pairing_codes (family_id, child_id, code_hash, created_by, expires_at)
        values (${fam.familyId}, ${child}, ${hash}, ${fam.ownerId}, now() + interval '10 minutes')`;
      await db.sql`
        update private.child_pairing_codes
           set created_at = now() - make_interval(days => ${values.createdDaysAgo}),
               expires_at = now() - make_interval(days => ${values.expiresDaysAgo}),
               consumed_at = ${values.consumedDaysAgo === undefined ? null : db.sql`now() - make_interval(days => ${values.consumedDaysAgo})`}
         where code_hash = ${hash}`;
    };
    // Live code (expires in the future): kept whatever its age.
    await code('live', { createdDaysAgo: 0, expiresDaysAgo: -1 });
    await code('expired-old', { createdDaysAgo: 80, expiresDaysAgo: 79 });
    await code('expired-recent', { createdDaysAgo: 2, expiresDaysAgo: 1 });
    await code('consumed-old', { createdDaysAgo: 80, expiresDaysAgo: -1, consumedDaysAgo: 79 });
    const [pruned] = await db.asService(
      (tx) => tx<{ n: number }[]>`select app.prune_credential_rows(interval '30 days') as n`,
    );
    expect(pruned!.n).toBe(2);
    const left = await db.sql<{ code_hash: Buffer }[]>`
      select code_hash from private.child_pairing_codes where family_id = ${fam.familyId}`;
    expect(left.map((r) => r.code_hash.toString().replace(/\.+$/, '')).sort()).toEqual([
      'expired-recent',
      'live',
    ]);
  });

  it('prune_credential_rows deletes spend holds that expired over a day ago and keeps the rest', async () => {
    await db.sql`
      insert into private.ai_spend_holds (period_key, micros, expires_at, created_at)
      values ('2026-09', 100, now() + interval '5 minutes', now()),
             ('2026-09', 100, now() - interval '2 hours', now() - interval '3 hours'),
             ('2026-08', 100, now() - interval '3 days', now() - interval '4 days'),
             ('2026-07', 100, now() - interval '40 days', now() - interval '41 days')`;
    const [pruned] = await db.asService(
      (tx) => tx<{ n: number }[]>`select app.prune_credential_rows(interval '30 days') as n`,
    );
    expect(pruned!.n).toBe(2);
    const left = await db.sql<
      { n: number }[]
    >`select count(*)::int as n from private.ai_spend_holds`;
    expect(left[0]!.n).toBe(2);
  });

  it('prune_credential_rows is service-only and refuses a horizon under a day', async () => {
    const fam = await seedFamily(db, { childCount: 0 });
    for (const run of [
      db.asParent(fam.ownerId, (tx) => tx`select app.prune_credential_rows(interval '30 days')`),
      db.asAnon((tx) => tx`select app.prune_credential_rows(interval '30 days')`),
    ]) {
      expect(await pgMessage(run)).toMatch(/permission denied|does not exist/);
    }
    expect(
      await pgMessage(
        db.asService((tx) => tx`select app.prune_credential_rows(interval '1 hour')`),
      ),
    ).toMatch(/at least one day/);
  });
});

// A stable id so a failure message names the finding, not a random uuid.
export const HARDENING_R2_DB_MARKER = `hardening-r2-db:${randomUUID().slice(0, 8)}`;
