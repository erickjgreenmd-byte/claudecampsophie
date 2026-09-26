import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { childClaims, grantAdultUnlock, seedFamily, type SeededFamily } from './fixtures.ts';

let db: TestDb;
let fam: SeededFamily;
const UNLOCKED = '00000000-0000-4000-8000-0000000d0e1e';

async function queueJob(family: SeededFamily, kind = 'scan_process', key = randomUUID()) {
  return db.sql<{ id: string }[]>`
    insert into public.jobs (kind, idempotency_key, family_id, child_id)
    values (${kind}, ${kind + ':' + key}, ${family.familyId}, ${family.children[0]?.id ?? null})
    returning id
  `;
}

beforeAll(async () => {
  db = await createTestDb();
  fam = await seedFamily(db, { childCount: 2 });
  await grantAdultUnlock(db, fam.ownerId, UNLOCKED, 3600);
});

afterAll(async () => {
  await db?.drop();
});

describe('family deletion (AC_ACCESS_10, AC_SECURITY_05)', () => {
  it('requires a recent unlock', async () => {
    const f = await seedFamily(db);
    await expect(
      db.asParent(f.ownerId, (tx) => tx`select * from public.request_deletion(${f.familyId})`),
    ).rejects.toThrow(/recent adult unlock required/);
  });

  it('tombstones first, revokes child access, cancels queued jobs and refuses new ones', async () => {
    const f = await seedFamily(db, { childCount: 1 });
    await grantAdultUnlock(db, f.ownerId, UNLOCKED, 3600);
    const [job] = await queueJob(f);
    expect(
      await db.asChild(childClaims(f), (tx) => tx`select id from public.child_profiles`),
    ).toHaveLength(1);

    const [req] = await db.asParent(
      f.ownerId,
      (tx) => tx`select * from public.request_deletion(${f.familyId})`,
      {
        sessionId: UNLOCKED,
      },
    );
    expect(req!.status).toBe('requested');

    const [family] = await db.sql<
      { deleted_at: Date | null }[]
    >`select deleted_at from public.families where id = ${f.familyId}`;
    expect(family!.deleted_at).not.toBeNull();
    expect(
      await db.asChild(childClaims(f), (tx) => tx`select id from public.child_profiles`),
    ).toHaveLength(0);
    expect(await db.asParent(f.ownerId, (tx) => tx`select id from public.families`)).toHaveLength(
      0,
    );
    const [cancelled] = await db.sql<
      { status: string }[]
    >`select status from public.jobs where id = ${job!.id}`;
    expect(cancelled!.status).toBe('cancelled');

    // A late webhook/job retry cannot resurrect processing for the deleted family.
    await expect(queueJob(f, 'daily_set_generate')).rejects.toThrow(
      /is deleted; job daily_set_generate refused/,
    );
    // The purge job itself is allowed.
    await queueJob(f, 'deletion_purge');
  });

  it('child-scoped deletion archives only that child and revokes only their sessions', async () => {
    const f = await seedFamily(db, { childCount: 2 });
    await grantAdultUnlock(db, f.ownerId, UNLOCKED, 3600);
    await db.asParent(
      f.ownerId,
      (tx) => tx`select * from public.request_deletion(${f.familyId}, ${f.children[0]!.id})`,
      {
        sessionId: UNLOCKED,
      },
    );
    expect(
      await db.asChild(childClaims(f, 0), (tx) => tx`select id from public.child_profiles`),
    ).toHaveLength(0);
    expect(
      await db.asChild(childClaims(f, 1), (tx) => tx`select id from public.child_profiles`),
    ).toHaveLength(1);
  });

  it('only one open deletion request per scope', async () => {
    const f = await seedFamily(db, { childCount: 2 });
    await grantAdultUnlock(db, f.ownerId, UNLOCKED, 3600);
    const del = () =>
      db.asParent(
        f.ownerId,
        (tx) => tx`select * from public.request_deletion(${f.familyId}, ${f.children[1]!.id})`,
        {
          sessionId: UNLOCKED,
        },
      );
    await del();
    await expect(del()).rejects.toThrow(/deletion_requests_one_open/);
  });

  it('another family cannot request deletion of this family', async () => {
    const attacker = await seedFamily(db);
    await grantAdultUnlock(db, attacker.ownerId, UNLOCKED, 3600);
    await expect(
      db.asParent(
        attacker.ownerId,
        (tx) => tx`select * from public.request_deletion(${fam.familyId})`,
        {
          sessionId: UNLOCKED,
        },
      ),
    ).rejects.toThrow(/family not found/);
  });
});

describe('durable jobs (AC_LEARNING_08, AC_CAPTURE_07)', () => {
  it('an idempotency key yields exactly one job across retries', async () => {
    const key = `thursday:${fam.children[0]!.id}:math:2026-W39:1`;
    const insert = () => db.sql`
      insert into public.jobs (kind, idempotency_key, family_id) values ('thursday_review_generate', ${key}, ${fam.familyId})
    `;
    await insert();
    await expect(insert()).rejects.toThrow(/jobs_idempotency_key_key/);
  });

  it('terminal jobs cannot be restarted', async () => {
    const [job] = await queueJob(fam);
    await db.sql`update public.jobs set status = 'succeeded' where id = ${job!.id}`;
    await expect(
      db.sql`update public.jobs set status = 'queued' where id = ${job!.id}`,
    ).rejects.toThrow(/is terminal/);
  });

  it('families and children cannot read the job ledger', async () => {
    expect(await db.asParent(fam.ownerId, (tx) => tx`select id from public.jobs`)).toHaveLength(0);
    await expect(
      db.asChild(childClaims(fam), (tx) => tx`select id from public.jobs`),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('safety reports (AC_SECURITY_01)', () => {
  it('a child can report content from their own session only', async () => {
    const [row] = await db.asChild(
      childClaims(fam),
      (tx) => tx`select public.child_report_content('upsetting') as id`,
    );
    const [report] = await db.sql<{ child_id: string; reporter_kind: string }[]>`
      select child_id, reporter_kind from public.safety_reports where id = ${row!.id}
    `;
    expect(report).toEqual({ child_id: fam.children[0]!.id, reporter_kind: 'child' });
  });

  it('a child cannot attach another child question to a report', async () => {
    await expect(
      db.asChild(
        childClaims(fam),
        (tx) => tx`select public.child_report_content('other', ${randomUUID()})`,
      ),
    ).rejects.toThrow(/question not found/);
  });

  it('a parent files a report through the API, never through the Data API (API-AUTH-R2-01)', async () => {
    // Migration 0860 revoked `authenticated`'s insert grant: routes/privacy.ts inserts with the
    // service role after checking the family, the question and the child (it has to set child_id,
    // which the grant never covered), so the per-user limit and the child link cannot be skipped and
    // one statement can no longer write hundreds of rows into the owner's safety queue. Both parent
    // and child reporter kinds are refused before RLS is even consulted.
    for (const kind of ['parent', 'child']) {
      await expect(
        db.asParent(
          fam.ownerId,
          (tx) =>
            tx`insert into public.safety_reports (family_id, reporter_kind, category) values (${fam.familyId}, ${kind}, 'other')`,
        ),
      ).rejects.toThrow(/permission denied/);
    }
    // The parent-insert policy stays as the second layer, and still admits only a parent report.
    const [policy] = await db.sql<{ qual: string }[]>`
      select with_check as qual from pg_policies
       where schemaname = 'public' and tablename = 'safety_reports'
         and policyname = 'safety_reports_parent_insert'`;
    expect(policy!.qual).toMatch(/reporter_kind = 'parent'/);
    // The API's own path still works and is visible to the family.
    await db.asService(
      (tx) =>
        tx`insert into public.safety_reports (family_id, reporter_kind, category) values (${fam.familyId}, 'parent', 'wrong_or_confusing')`,
    );
    const mine = await db.asParent(
      fam.ownerId,
      (tx) => tx`select id from public.safety_reports where family_id = ${fam.familyId}`,
    );
    expect(mine.length).toBeGreaterThanOrEqual(1);
  });
});

describe('exports (AC_LEARNING_10)', () => {
  it('an answer-key export requires a recent unlock and is audited', async () => {
    await expect(
      db.asParent(
        fam.ownerId,
        (tx) => tx`select public.request_export(${fam.familyId}, 'review_answer_key_pdf')`,
      ),
    ).rejects.toThrow(/recent adult unlock required/);
    const [row] = await db.asParent(
      fam.ownerId,
      (tx) => tx`select public.request_export(${fam.familyId}, 'review_answer_key_pdf') as id`,
      { sessionId: UNLOCKED },
    );
    const audit = await db.sql`select action from public.audit_events where target_id = ${row!.id}`;
    expect(audit).toEqual([{ action: 'export.requested' }]);
  });

  it('children cannot request exports', async () => {
    await expect(
      db.asChild(
        childClaims(fam),
        (tx) => tx`select public.request_export(${fam.familyId}, 'review_questions_pdf')`,
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('notifications (spec P14)', () => {
  it('only generic message keys can be stored and push tokens are private', async () => {
    const [device] = await db.sql<{ id: string }[]>`
      insert into public.notification_devices (family_id, owner_kind, user_id, platform)
      values (${fam.familyId}, 'parent', ${fam.ownerId}, 'ios') returning id
    `;
    await expect(
      db.sql`
        insert into public.notification_deliveries (family_id, device_id, message_key, dedupe_key, scheduled_for)
        values (${fam.familyId}, ${device!.id}, 'the answer is 3/4', 'd-1', now())
      `,
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.asParent(fam.ownerId, (tx) => tx`select * from private.push_tokens`),
    ).rejects.toThrow(/permission denied/);
  });
});
