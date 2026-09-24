import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { childClaims, seedFamily, seedOwnerAdmin, type SeededFamily } from './fixtures.ts';

// Migration 0760 (spec P4; AC_SECURITY_02): the scan job's safety screen writes a 'safety' child
// feedback row and an escalated SYSTEM safety report that carries ids and codes only, never
// homework text. Synthetic families only (Riley, Sam).

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
function systemReport(s: Scanned, overrides: Record<string, unknown> = {}) {
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
  return db.asService(
    (tx) => tx<{ id: string }[]>`insert into public.safety_reports ${tx(row)} returning id`,
  );
}

describe('safety feedback kind (0760)', () => {
  it('child_feedback accepts the reviewed safety template kind and the child can read it', async () => {
    const s = await scanned();
    const rows = await db.asChild(
      childClaims(s.fam),
      (tx) =>
        tx<{ kind: string }[]>`select kind from public.child_feedback where id = ${s.feedbackId}`,
    );
    expect(rows).toEqual([{ kind: 'safety' }]);
  });

  it('still rejects unknown feedback kinds', async () => {
    const s = await scanned();
    await expect(
      db.sql`insert into public.child_feedback (question_id, family_id, child_id, kind, body, guard_version)
             values (${s.questionId}, ${s.fam.familyId}, ${s.childId}, 'free_chat', 'x', 'g')`,
    ).rejects.toThrow(/child_feedback_kind_check/);
  });
});

describe('system safety reports (0760)', () => {
  it('the service role files an escalated system report with ids and codes only', async () => {
    const s = await scanned();
    const [row] = await systemReport(s);
    const [stored] = await db.sql<
      {
        reporter_kind: string;
        category: string;
        status: string;
        note: string | null;
        screen_categories: string[];
      }[]
    >`select reporter_kind, category, status, note, screen_categories from public.safety_reports where id = ${row!.id}`;
    expect(stored).toEqual({
      reporter_kind: 'system',
      category: 'severe_risk',
      status: 'escalated',
      note: null,
      screen_categories: ['self_harm'],
    });
  });

  it('one system report per question and transcription', async () => {
    const s = await scanned();
    await systemReport(s);
    await expect(systemReport(s)).rejects.toThrow(/safety_reports_system_once/);
    // A corrected transcription is a new screening, so it may carry its own report.
    await systemReport(s, { transcription_at: new Date(s.transcriptionAt.getTime() + 60_000) });
  });

  it('a system report never carries text and always names its child and question', async () => {
    const s = await scanned();
    for (const bad of [
      { note: 'synthetic homework text' },
      { question_id: null, feedback_id: null },
      { child_id: null, question_id: null, feedback_id: null },
      { status: 'open' },
      { status: 'triaged' },
      { category: 'upsetting' },
      { screen_categories: [] },
      { screen_categories: ['not_a_category'] },
      { screen_categories: null },
      { screen_version: null },
      { transcription_at: null },
    ]) {
      await expect(systemReport(s, bad), JSON.stringify(bad)).rejects.toThrow(
        /safety_reports_system_shape|safety_reports_linked_item_has_child|violates/,
      );
    }
  });

  it('severe_risk and the screen columns belong to system reports only', async () => {
    const s = await scanned();
    await expect(
      db.asService(
        (tx) => tx`insert into public.safety_reports (family_id, reporter_kind, category)
                   values (${s.fam.familyId}, 'parent', 'severe_risk')`,
      ),
    ).rejects.toThrow(/safety_reports_system_shape/);
    await expect(
      db.asService(
        (
          tx,
        ) => tx`insert into public.safety_reports (family_id, reporter_kind, category, screen_categories)
                   values (${s.fam.familyId}, 'parent', 'other', ${['self_harm']})`,
      ),
    ).rejects.toThrow(/safety_reports_system_shape/);
  });

  it('parents and children cannot create a system report', async () => {
    const s = await scanned();
    await expect(
      db.asParent(
        s.fam.ownerId,
        (tx) => tx`insert into public.safety_reports (family_id, reporter_kind, category)
                   values (${s.fam.familyId}, 'system', 'severe_risk')`,
      ),
    ).rejects.toThrow(/row-level security|permission denied/);
    await expect(
      db.asParent(
        s.fam.ownerId,
        (tx) => tx`insert into public.safety_reports (family_id, reporter_kind, category)
                   values (${s.fam.familyId}, 'parent', 'severe_risk')`,
      ),
    ).rejects.toThrow(/safety_reports_system_shape|row-level security/);
    await expect(
      db.asChild(
        childClaims(s.fam),
        (tx) => tx`insert into public.safety_reports (family_id, reporter_kind, category)
                   values (${s.fam.familyId}, 'system', 'severe_risk')`,
      ),
    ).rejects.toThrow(/permission denied/);
    // The child's report RPC cannot be used to file a system category either.
    await expect(
      db.asChild(childClaims(s.fam), (tx) => tx`select public.child_report_content('severe_risk')`),
    ).rejects.toThrow(/safety_reports_system_shape|violates/);
  });

  it('a family sees its own system reports; another family and children see none', async () => {
    const s = await scanned();
    const other = await scanned();
    const [mine] = await systemReport(s);
    await systemReport(other);
    const own = await db.asParent(
      s.fam.ownerId,
      (tx) => tx<{ id: string; reporter_kind: string; category: string; status: string }[]>`
        select id, reporter_kind, category, status from public.safety_reports where reporter_kind = 'system'`,
    );
    expect(own).toEqual([
      { id: mine!.id, reporter_kind: 'system', category: 'severe_risk', status: 'escalated' },
    ]);
    await expect(
      db.asChild(childClaims(s.fam), (tx) => tx`select id from public.safety_reports`),
    ).rejects.toThrow(/permission denied/);
  });

  it('a held system report is hidden from the family until a reviewer releases it', async () => {
    // Runbook 5.1: abuse-type reports (abuse, sexual, secrecy) may involve someone in the household,
    // so the family list does not show them until the owner decides.
    const s = await scanned();
    const [held] = await systemReport(s, { screen_categories: ['abuse'], family_visible: false });
    const familyView = () =>
      db.asParent(
        s.fam.ownerId,
        (tx) =>
          tx<{ id: string }[]>`select id from public.safety_reports where reporter_kind = 'system'`,
      );
    expect(await familyView()).toEqual([]);
    // The reviewer releases it (service role, after the aal2 owner check in the API).
    await db.asService(
      (tx) => tx`update public.safety_reports set family_visible = true where id = ${held!.id}`,
    );
    expect(await familyView()).toEqual([{ id: held!.id }]);
  });

  it('only system reports can be held from the family', async () => {
    const s = await scanned();
    await expect(
      db.asService(
        (
          tx,
        ) => tx`insert into public.safety_reports (family_id, reporter_kind, category, family_visible)
                   values (${s.fam.familyId}, 'parent', 'other', false)`,
      ),
    ).rejects.toThrow(/safety_reports_hold_system_only/);
    // A parent cannot hide its own report or read the hold flag.
    await expect(
      db.asParent(
        s.fam.ownerId,
        (
          tx,
        ) => tx`insert into public.safety_reports (family_id, reporter_kind, category, family_visible)
                   values (${s.fam.familyId}, 'parent', 'other', false)`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asParent(s.fam.ownerId, (tx) => tx`select family_visible from public.safety_reports`),
    ).rejects.toThrow(/permission denied/);
  });

  it('families cannot read the screen codes (the admin queue reads them with the service role)', async () => {
    const s = await scanned();
    await systemReport(s);
    await expect(
      db.asParent(s.fam.ownerId, (tx) => tx`select screen_categories from public.safety_reports`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asParent(s.fam.ownerId, (tx) => tx`select screen_version from public.safety_reports`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asParent(s.fam.ownerId, (tx) => tx`select * from public.safety_reports`),
    ).rejects.toThrow(/permission denied/);
    // The documented family columns stay readable.
    const cols = await db.asParent(
      s.fam.ownerId,
      (
        tx,
      ) => tx`select id, family_id, child_id, reporter_kind, category, question_id, feedback_id, note,
                        status, created_at, triaged_at, resolved_at, resolution_note, transcription_at
                   from public.safety_reports`,
    );
    expect(cols).toHaveLength(1);
    // Least privilege (0670) still holds: an MFA owner admin reads nothing through RLS.
    const adminId = await seedOwnerAdmin(db);
    expect(
      await db.asParent(adminId, (tx) => tx`select id from public.safety_reports`, { aal: 'aal2' }),
    ).toEqual([]);
  });

  it('[BUG] a report linked to a feedback row does not block purging that child', async () => {
    // Before 0760 the purge deleted child_feedback first and the report's feedback_id foreign key
    // refused it, so any child report on a hint (and every system report) blocked a deletion.
    const s = await scanned();
    await systemReport(s);
    await db.asChild(
      childClaims(s.fam),
      (tx) =>
        tx`select public.child_report_content('upsetting', ${s.questionId}::uuid, ${s.feedbackId}::uuid)`,
    );
    await db.sql`insert into public.deletion_requests (family_id, scope, child_id, target_child_id, requested_by)
                 values (${s.fam.familyId}, 'child', ${s.childId}, ${s.childId}, ${s.fam.ownerId})`;
    await db.asService((tx) => tx`select app.purge_family_data(${s.fam.familyId}, ${s.childId})`);
    const left = await db.sql`select id from public.safety_reports where child_id = ${s.childId}`;
    expect(left).toHaveLength(0);
  });
});
