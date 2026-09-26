import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb, type Tx } from './harness.ts';
import { childClaims, seedFamily, type SeededFamily } from './fixtures.ts';

// Migration 0790 (owner decision, 2026-09-25: the parent is the only safety recipient and
// addresses the concern). The schema records the parent's action on a flag ('addressed' joins
// 'false_match'), the guardian email the scan job's flag sends, and the job kind that sends it.
// Every write is the API's as the service role; a guardian cannot make any of them through the
// Data API. Synthetic families only (Riley, Sam).

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.drop();
});

interface Scanned {
  fam: SeededFamily;
  childId: string;
  questionId: string;
  feedbackId: string;
  transcriptionAt: Date;
}

/** A family with one scanned question and a safety feedback row (as the scan job writes them). */
async function scanned(fam?: SeededFamily): Promise<Scanned> {
  const family = fam ?? (await seedFamily(db, { childCount: 2 }));
  const childId = family.children[0]!.id;
  const [a] = await db.sql<{ id: string }[]>`
    insert into public.assignments (family_id, child_id, idempotency_key, created_by_kind)
    values (${family.familyId}, ${childId}, ${'k-' + randomUUID()}, 'child') returning id`;
  const pageId = randomUUID();
  await db.sql`
    insert into public.source_pages (id, assignment_id, family_id, child_id, page_number, storage_path, mime_type, byte_size, sha256)
    values (${pageId}, ${a!.id}, ${family.familyId}, ${childId}, 1,
            ${`${family.familyId}/${childId}/${a!.id}/${pageId}.jpg`}, 'image/jpeg', 10, ${'c'.repeat(64)})`;
  const [q] = await db.sql<{ id: string; created_at: Date }[]>`
    insert into public.extracted_questions (assignment_id, family_id, child_id, page_id, question_number, prompt_text,
                                            student_answer_text, answer_kind, subject_key, skill)
    values (${a!.id}, ${family.familyId}, ${childId}, ${pageId}, '1', 'Why do plants need sunlight?',
            'synthetic severe answer', 'open_response', 'science', 'plants')
    returning id, created_at`;
  const [f] = await db.sql<{ id: string }[]>`
    insert into public.child_feedback (question_id, family_id, child_id, kind, body, guard_version)
    values (${q!.id}, ${family.familyId}, ${childId}, 'safety', 'Please talk to a grown-up you trust today.', 'safety-templates.v1')
    returning id`;
  return {
    fam: family,
    childId,
    questionId: q!.id,
    feedbackId: f!.id,
    transcriptionAt: q!.created_at,
  };
}

/** Inserts a system report exactly as the scan job does (service role). */
async function systemReport(s: Scanned, overrides: Record<string, unknown> = {}): Promise<string> {
  const row = {
    family_id: s.fam.familyId,
    child_id: s.childId,
    reporter_kind: 'system',
    category: 'severe_risk',
    question_id: s.questionId,
    feedback_id: s.feedbackId,
    status: 'escalated',
    transcription_at: s.transcriptionAt,
    screen_categories: ['self_harm'],
    screen_version: 'safety-screen.v1',
    ...overrides,
  };
  const [created] = await db.asService(
    (tx) => tx<{ id: string }[]>`insert into public.safety_reports ${tx(row)} returning id`,
  );
  return created!.id;
}

/** A child's "Get help" report about the flagged question (through the child RPC). */
async function childReport(s: Scanned): Promise<string> {
  const [row] = await db.asChild(
    childClaims(s.fam),
    (tx) =>
      tx<
        { id: string }[]
      >`select public.child_report_content('upsetting', ${s.questionId}::uuid, ${s.feedbackId}::uuid) as id`,
  );
  return row!.id;
}

/** The API's parent action, as the service role after its own checks. */
function parentAction(id: string, outcome: 'addressed' | 'false_match', by: string) {
  return db.asService(
    (tx) => tx`
      update public.safety_reports
         set status = 'resolved', resolved_at = now(), resolution = ${outcome},
             parent_action_at = now(), parent_action_by = ${by}
       where id = ${id}`,
  );
}

describe('parent outcomes (0790)', () => {
  it("'addressed' resolves a system report or a child's report; a false match stays system-only", async () => {
    const s = await scanned();
    const flag = await systemReport(s);
    await parentAction(flag, 'addressed', s.fam.ownerId);
    const other = await scanned(s.fam);
    const fromChild = await childReport(other);
    await parentAction(fromChild, 'addressed', s.fam.ownerId);
    const rows = await db.sql<{ id: string; resolution: string; status: string }[]>`
      select id, resolution, status from public.safety_reports where id in (${flag}, ${fromChild}) order by created_at`;
    expect(rows).toEqual([
      { id: flag, resolution: 'addressed', status: 'resolved' },
      { id: fromChild, resolution: 'addressed', status: 'resolved' },
    ]);
    // A child's report cannot be cleared as a false match (nothing to recheck).
    const third = await scanned(s.fam);
    const another = await childReport(third);
    await expect(parentAction(another, 'false_match', s.fam.ownerId)).rejects.toThrow(
      /safety_reports_resolution_shape/,
    );
  });

  it("a parent's own report is closed by the reviewer, never marked addressed", async () => {
    const s = await scanned();
    // Fixture written as the API writes it: routes/privacy.ts inserts a parent report with the
    // service role, and since migration 0860 (API-AUTH-R2-01) `authenticated` holds no insert grant
    // on safety_reports at all, so a Data-API insert is not the path any more.
    const [own] = await db.asService(
      (tx) => tx<{ id: string }[]>`
        insert into public.safety_reports (family_id, reporter_kind, category, note)
        values (${s.fam.familyId}, 'parent', 'other', 'SYNTHETIC parent note') returning id`,
    );
    await expect(parentAction(own!.id, 'addressed', s.fam.ownerId)).rejects.toThrow(
      /safety_reports_resolution_shape/,
    );
  });

  it('an outcome belongs to a resolved report, and stays final', async () => {
    const s = await scanned();
    const flag = await systemReport(s);
    await expect(
      db.asService(
        (tx) => tx`update public.safety_reports set resolution = 'addressed' where id = ${flag}`,
      ),
    ).rejects.toThrow(/safety_reports_resolution_shape/);
    await expect(
      db.asService(
        (tx) =>
          tx`update public.safety_reports set status = 'resolved', resolved_at = now(), resolution = 'looked' where id = ${flag}`,
      ),
    ).rejects.toThrow(/safety_reports_resolution_check|violates/);
    await parentAction(flag, 'addressed', s.fam.ownerId);
    // The 0760 guard: a resolution never changes afterwards (a false match cannot follow).
    await expect(
      db.asService(
        (tx) => tx`update public.safety_reports set resolution = 'false_match' where id = ${flag}`,
      ),
    ).rejects.toThrow(/resolution is final/);
  });

  it('the action stamp is a resolution with an actor, never a bare stamp', async () => {
    const s = await scanned();
    const flag = await systemReport(s);
    await expect(
      db.asService(
        (tx) => tx`update public.safety_reports set parent_action_at = now() where id = ${flag}`,
      ),
    ).rejects.toThrow(/safety_reports_parent_action_shape/);
    await expect(
      db.asService(
        (tx) =>
          tx`update public.safety_reports set parent_action_by = ${s.fam.ownerId} where id = ${flag}`,
      ),
    ).rejects.toThrow(/safety_reports_parent_action_shape/);
    // The reviewer's clearing carries no parent stamp (still valid: the stamp is optional).
    await db.asService(
      (tx) => tx`
        update public.safety_reports
           set status = 'resolved', resolved_at = now(), resolution = 'false_match',
               resolution_note = 'SYNTHETIC: reviewed by ids'
         where id = ${flag}`,
    );
    const [row] = await db.sql<
      { parent_action_at: Date | null; parent_action_by: string | null }[]
    >`
      select parent_action_at, parent_action_by from public.safety_reports where id = ${flag}`;
    expect(row).toEqual({ parent_action_at: null, parent_action_by: null });
  });
});

describe('the guardian email record (0790)', () => {
  it("starts 'not_sent'; 'sent' and the delivery instant are one fact; 'failed' is allowed", async () => {
    const s = await scanned();
    const flag = await systemReport(s);
    const state = async () => {
      const [row] = await db.sql<{ status: string; at: Date | null }[]>`
        select parent_email_status as status, parent_emailed_at as at from public.safety_reports where id = ${flag}`;
      return row;
    };
    expect(await state()).toEqual({ status: 'not_sent', at: null });
    await expect(
      db.asService(
        (tx) =>
          tx`update public.safety_reports set parent_email_status = 'sent' where id = ${flag}`,
      ),
    ).rejects.toThrow(/safety_reports_parent_email_shape/);
    await expect(
      db.asService(
        (tx) => tx`update public.safety_reports set parent_emailed_at = now() where id = ${flag}`,
      ),
    ).rejects.toThrow(/safety_reports_parent_email_shape/);
    await expect(
      db.asService(
        (tx) =>
          tx`update public.safety_reports set parent_email_status = 'queued' where id = ${flag}`,
      ),
    ).rejects.toThrow(/safety_reports_parent_email_status_check|violates/);
    await db.asService(
      (tx) =>
        tx`update public.safety_reports set parent_email_status = 'failed' where id = ${flag}`,
    );
    expect(await state()).toEqual({ status: 'failed', at: null });
    await db.asService(
      (tx) =>
        tx`update public.safety_reports set parent_email_status = 'sent', parent_emailed_at = now() where id = ${flag}`,
    );
    expect((await state())?.status).toBe('sent');
  });

  it("the job ledger accepts 'safety_flag_email' with the report id only", async () => {
    const s = await scanned();
    const flag = await systemReport(s);
    await db.asService(
      (tx) => tx`
        insert into public.jobs (kind, idempotency_key, family_id, child_id, payload)
        values ('safety_flag_email', ${`safety-flag-email:${flag}`}, ${s.fam.familyId}, ${s.childId},
                ${JSON.stringify({ reportId: flag })}::text::jsonb)`,
    );
    // Once per report.
    await expect(
      db.asService(
        (tx) => tx`
          insert into public.jobs (kind, idempotency_key, family_id, child_id, payload)
          values ('safety_flag_email', ${`safety-flag-email:${flag}`}, ${s.fam.familyId}, ${s.childId},
                  ${JSON.stringify({ reportId: flag })}::text::jsonb)`,
      ),
    ).rejects.toThrow(/jobs_idempotency_key_key|duplicate key/);
    await expect(
      db.asService(
        (tx) => tx`
          insert into public.jobs (kind, idempotency_key, family_id, payload)
          values ('safety_flag_sms', ${'sms:' + flag}, ${s.fam.familyId}, '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/jobs_kind_check/);
    // A child purge removes the job with the report (spec P4 "queue payloads").
    await db.sql`insert into public.deletion_requests (family_id, scope, child_id, target_child_id, requested_by)
                 values (${s.fam.familyId}, 'child', ${s.childId}, ${s.childId}, ${s.fam.ownerId})`;
    await db.asService((tx) => tx`select app.purge_family_data(${s.fam.familyId}, ${s.childId})`);
    expect(
      await db.sql`select id from public.jobs where idempotency_key = ${`safety-flag-email:${flag}`}`,
    ).toHaveLength(0);
    expect(await db.sql`select id from public.safety_reports where id = ${flag}`).toHaveLength(0);
  });
});

describe('grants (0790): the API writes, the family reads its own', () => {
  it('a guardian cannot resolve, clear, stamp or "mark emailed" a report through the Data API', async () => {
    const s = await scanned();
    const flag = await systemReport(s);
    const attempts: ((tx: Tx) => Promise<unknown>)[] = [
      (tx) =>
        tx`update public.safety_reports set status = 'resolved', resolution = 'addressed' where id = ${flag}`,
      (tx) =>
        tx`update public.safety_reports set status = 'resolved', resolution = 'false_match' where id = ${flag}`,
      (tx) =>
        tx`update public.safety_reports set parent_action_at = now(), parent_action_by = ${s.fam.ownerId} where id = ${flag}`,
      (tx) =>
        tx`update public.safety_reports set parent_email_status = 'sent', parent_emailed_at = now() where id = ${flag}`,
      (tx) =>
        tx`update public.safety_reports set parent_email_status = 'failed' where id = ${flag}`,
      (tx) => tx`delete from public.safety_reports where id = ${flag}`,
    ];
    for (const attempt of attempts) {
      await expect(db.asParent(s.fam.ownerId, attempt)).rejects.toThrow(/permission denied/);
    }
    // A guardian cannot enqueue the email job either.
    await expect(
      db.asParent(
        s.fam.ownerId,
        (tx) => tx`
          insert into public.jobs (kind, idempotency_key, family_id, payload)
          values ('safety_flag_email', ${'forged:' + flag}, ${s.fam.familyId}, '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/permission denied/);
    const [row] = await db.sql<{ status: string; email: string }[]>`
      select status, parent_email_status as email from public.safety_reports where id = ${flag}`;
    expect(row).toEqual({ status: 'escalated', email: 'not_sent' });
  });

  it('families read the action stamp and the email state of their own reports; not the actor', async () => {
    const s = await scanned();
    const flag = await systemReport(s);
    await db.asService(
      (tx) =>
        tx`update public.safety_reports set parent_email_status = 'sent', parent_emailed_at = now() where id = ${flag}`,
    );
    await parentAction(flag, 'addressed', s.fam.ownerId);
    const mine = await db.asParent(
      s.fam.ownerId,
      (tx) => tx<
        { id: string; resolution: string; email: string; emailed: boolean; acted: boolean }[]
      >`
        select id, resolution, parent_email_status as email, parent_emailed_at is not null as emailed,
               parent_action_at is not null as acted
          from public.safety_reports where id = ${flag}`,
    );
    expect(mine).toEqual([
      { id: flag, resolution: 'addressed', email: 'sent', emailed: true, acted: true },
    ]);
    await expect(
      db.asParent(
        s.fam.ownerId,
        (tx) => tx`select parent_action_by from public.safety_reports where id = ${flag}`,
      ),
    ).rejects.toThrow(/permission denied/);
    // Another family sees nothing; a child session reads no reports at all.
    const stranger = await seedFamily(db, { childCount: 1 });
    expect(
      await db.asParent(
        stranger.ownerId,
        (tx) => tx`select id, parent_email_status from public.safety_reports where id = ${flag}`,
      ),
    ).toEqual([]);
    await expect(
      db.asChild(
        childClaims(s.fam),
        (tx) => tx`select parent_email_status from public.safety_reports`,
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
