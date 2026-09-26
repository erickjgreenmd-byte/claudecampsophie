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
    ).rejects.toThrow(/safety_reports_system_shape|row-level security|permission denied/);
    // API-AUTH-R2-01 (migration 0860): `authenticated` lost its insert grant on safety_reports
    // altogether, so the refusal now comes from the privilege, before the shape check. The check
    // constraint and the parent-insert policy both stay in place underneath.
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

  it('a report filed with the column default is visible to the family at once, whatever its codes (owner decision, 2026-09-25)', async () => {
    // Owner decision (2026-09-25): the parent is the only person PencilLift sends a safety message
    // to and the one who addresses the concern, so no flag is held from the family. The scan job
    // writes `family_visible = not held`, which is always true while FAMILY_HOLD_CATEGORIES is
    // empty; this test pins the column default and the RLS listing behind it: abuse, sexual and
    // secrecy reports are listed at once like a self-harm one. The tests below keep exercising the
    // 0760 hold mechanism, which stays in the schema unused by the API.
    const s = await scanned();
    const ids: string[] = [];
    for (const category of ['abuse', 'sexual', 'secrecy', 'self_harm']) {
      const target = await scanned(s.fam);
      const [report] = await systemReport(target, { screen_categories: [category] });
      ids.push(report!.id);
      const [stored] = await db.sql<{ family_visible: boolean }[]>`
        select family_visible from public.safety_reports where id = ${report!.id}`;
      expect(stored, category).toEqual({ family_visible: true });
    }
    const listed = await db.asParent(
      s.fam.ownerId,
      (tx) =>
        tx<{ id: string }[]>`select id from public.safety_reports where reporter_kind = 'system'`,
    );
    expect(listed.map((r) => r.id).sort()).toEqual([...ids].sort());
  });

  it('hold mechanism (0760, unused by the API): a system report set family_visible false by hand is hidden until released', async () => {
    // Owner decision (2026-09-25): the API files no held report (the test above pins that); the
    // 0760 hold stays in the schema, so this test sets family_visible false by hand and checks that
    // the mechanism still hides the report and releases it as designed.
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

  it('hold mechanism (0760): only system reports, and child reports about a hidden flag, can be hidden from the family', async () => {
    // Owner decision (2026-09-25): unused by the API; the constraint stays with the schema's mechanism.
    const s = await scanned();
    await expect(
      db.asService(
        (
          tx,
        ) => tx`insert into public.safety_reports (family_id, reporter_kind, category, family_visible)
                   values (${s.fam.familyId}, 'parent', 'other', false)`,
      ),
    ).rejects.toThrow(/safety_reports_hold_kind/);
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
    // The documented family columns stay readable (the reviewer's resolution note is not one).
    const cols = await db.asParent(
      s.fam.ownerId,
      (
        tx,
      ) => tx`select id, family_id, child_id, reporter_kind, category, question_id, feedback_id, note,
                        status, created_at, triaged_at, resolved_at, transcription_at, resolution
                   from public.safety_reports`,
    );
    expect(cols).toHaveLength(1);
    // Least privilege (0670) still holds: an MFA owner admin reads nothing through RLS.
    const adminId = await seedOwnerAdmin(db);
    expect(
      await db.asParent(adminId, (tx) => tx`select id from public.safety_reports`, { aal: 'aal2' }),
    ).toEqual([]);
  });

  it('families cannot read the reviewer’s resolution note (RV-child-safety-8)', async () => {
    // Runbook 5.1: the reviewer's note is internal support material (owner decision, 2026-09-25: the
    // parent addresses the concern; the reviewer clears false matches on request). A resolved report
    // still shows the family only its status.
    const s = await scanned();
    const [held] = await systemReport(s, { screen_categories: ['abuse'], family_visible: false });
    await db.asService(
      (tx) => tx`update public.safety_reports
                    set status = 'resolved', resolved_at = now(),
                        resolution_note = 'SYNTHETIC: reviewed by ids; outcome recorded',
                        family_visible = true
                  where id = ${held!.id}`,
    );
    await expect(
      db.asParent(s.fam.ownerId, (tx) => tx`select resolution_note from public.safety_reports`),
    ).rejects.toThrow(/permission denied/);
    expect(
      await db.asParent(
        s.fam.ownerId,
        (tx) =>
          tx<{ status: string }[]>`select status from public.safety_reports where id = ${held!.id}`,
      ),
    ).toEqual([{ status: 'resolved' }]);
  });

  it('hold mechanism (0760): a child’s report about a flagged question hidden by hand is hidden with it (RV-child-safety-6)', async () => {
    // Owner decision (2026-09-25): the API files no held report, so this path is unused; the schema
    // keeps it. The results screen's "Get help" button files a child report linked to the flagged
    // question and its safety row. Child reports are otherwise visible at once, which would show
    // the household a hidden question through the ordinary report list.
    const s = await scanned();
    const [held] = await systemReport(s, { screen_categories: ['abuse'], family_visible: false });
    const familyView = () =>
      db.asParent(
        s.fam.ownerId,
        (tx) => tx<{ id: string; reporter_kind: string }[]>`
          select id, reporter_kind from public.safety_reports order by created_at, id`,
      );
    const [byQuestionRow] = await db.asChild(
      childClaims(s.fam),
      (tx) =>
        tx<
          { id: string }[]
        >`select public.child_report_content('upsetting', ${s.questionId}::uuid, ${s.feedbackId}::uuid) as id`,
    );
    const byQuestion = byQuestionRow!.id;
    const [byFeedbackRow] = await db.asChild(
      childClaims(s.fam),
      (tx) =>
        tx<
          { id: string }[]
        >`select public.child_report_content('other', null, ${s.feedbackId}::uuid) as id`,
    );
    const byFeedback = byFeedbackRow!.id;
    expect(await familyView()).toEqual([]);
    const hold = await db.sql<{ id: string; family_visible: boolean }[]>`
      select id, family_visible from public.safety_reports where reporter_kind = 'child' and child_id = ${s.childId}
       order by created_at, id`;
    expect(hold.map((r) => r.family_visible)).toEqual([false, false]);
    expect(hold.map((r) => r.id).sort()).toEqual([byQuestion, byFeedback].sort());

    // A child report on another question stays visible at once.
    const other = await scanned(s.fam);
    await db.asChild(
      childClaims(s.fam),
      (tx) => tx`select public.child_report_content('upsetting', ${other.questionId}::uuid)`,
    );
    expect((await familyView()).map((r) => r.reporter_kind)).toEqual(['child']);

    // Released by the reviewer (service role, after the aal2 owner check in the API), one by one.
    await db.asService(
      (tx) =>
        tx`update public.safety_reports set family_visible = true where id in (${held!.id}, ${byQuestion})`,
    );
    expect((await familyView()).map((r) => r.id)).toEqual(
      expect.arrayContaining([held!.id, byQuestion]),
    );
    expect((await familyView()).map((r) => r.id)).not.toContain(byFeedback);
  });

  it('hold mechanism (0760): a child’s report naming a hidden flag’s feedback row is hidden, whatever question it names', async () => {
    // Owner decision (2026-09-25): unused by the API; kept with the mechanism. child_report_content
    // checks that the question and the feedback are the child's own, not that they belong together:
    // the feedback row's own question decides the hold too.
    const s = await scanned();
    await systemReport(s, { screen_categories: ['secrecy'], family_visible: false });
    const other = await scanned(s.fam);
    await db.asChild(
      childClaims(s.fam),
      (tx) =>
        tx`select public.child_report_content('other', ${other.questionId}::uuid, ${s.feedbackId}::uuid)`,
    );
    expect(
      await db.asParent(s.fam.ownerId, (tx) => tx`select id from public.safety_reports`),
    ).toEqual([]);
    // Once the flag is released, a new report about it is visible at once.
    await db.asService(
      (tx) =>
        tx`update public.safety_reports set family_visible = true
            where question_id = ${s.questionId} and reporter_kind = 'system'`,
    );
    await db.asChild(
      childClaims(s.fam),
      (tx) =>
        tx`select public.child_report_content('upsetting', ${s.questionId}::uuid, ${s.feedbackId}::uuid)`,
    );
    const seen = await db.asParent(
      s.fam.ownerId,
      (tx) =>
        tx<
          { reporter_kind: string; category: string }[]
        >`select reporter_kind, category from public.safety_reports order by reporter_kind, category`,
    );
    expect(seen).toEqual([
      { reporter_kind: 'child', category: 'upsetting' },
      { reporter_kind: 'system', category: 'severe_risk' },
    ]);
  });

  it('a child’s report about a visible flag or a released one is visible at once', async () => {
    const s = await scanned();
    await systemReport(s, { screen_categories: ['self_harm'] });
    await db.asChild(
      childClaims(s.fam),
      (tx) =>
        tx`select public.child_report_content('upsetting', ${s.questionId}::uuid, ${s.feedbackId}::uuid)`,
    );
    const seen = await db.asParent(
      s.fam.ownerId,
      (tx) =>
        tx<
          { reporter_kind: string }[]
        >`select reporter_kind from public.safety_reports order by reporter_kind`,
    );
    expect(seen.map((r) => r.reporter_kind)).toEqual(['child', 'system']);
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

describe('false-match clearance (0760, round 3: CHK2-CS-5)', () => {
  // Runbook 5.1: an owner admin resolves a system report as a false match. The clearance is the
  // report's own question and transcription (ids and a code only, never text); the scan then grades
  // that transcription normally and the child's notice is hidden.
  const clear = (id: string, set: Record<string, unknown> = {}) =>
    db.asService(
      (tx) => tx`update public.safety_reports
                    set ${tx({ status: 'resolved', resolution: 'false_match', resolution_note: 'SYNTHETIC: false match, SELF_HARM_TERM', ...set })},
                        resolved_at = now()
                  where id = ${id}`,
    );

  it('is set in the update that resolves a system report, and is final', async () => {
    const s = await scanned();
    const [report] = await systemReport(s);
    await clear(report!.id);
    const [row] = await db.sql<{ status: string; resolution: string | null }[]>`
      select status, resolution from public.safety_reports where id = ${report!.id}`;
    expect(row).toEqual({ status: 'resolved', resolution: 'false_match' });
    await expect(
      db.asService(
        (tx) => tx`update public.safety_reports set resolution = null where id = ${report!.id}`,
      ),
    ).rejects.toThrow(/resolution is final/);
  });

  it('belongs to a resolved system report only, never added after the report was resolved', async () => {
    const s = await scanned();
    const [report] = await systemReport(s);
    await expect(
      db.asService(
        (tx) =>
          tx`update public.safety_reports set resolution = 'false_match' where id = ${report!.id}`,
      ),
    ).rejects.toThrow(/safety_reports_resolution_shape/);
    await expect(
      db.asService(
        (
          tx,
        ) => tx`insert into public.safety_reports (family_id, reporter_kind, category, status, resolution)
                   values (${s.fam.familyId}, 'parent', 'other', 'resolved', 'false_match')`,
      ),
    ).rejects.toThrow(/safety_reports_resolution_shape/);
    await expect(
      db.asService(
        (tx) => tx`update public.safety_reports set resolution = 'upheld' where id = ${report!.id}`,
      ),
    ).rejects.toThrow(/safety_reports_resolution_check|violates/);
    // Resolved without a clearance first: resolved is final, so no clearance can follow.
    await db.asService(
      (tx) => tx`update public.safety_reports
                    set status = 'resolved', resolved_at = now(), resolution_note = 'SYNTHETIC: reviewed'
                  where id = ${report!.id}`,
    );
    await expect(
      db.asService(
        (tx) =>
          tx`update public.safety_reports set resolution = 'false_match' where id = ${report!.id}`,
      ),
    ).rejects.toThrow(/resolution is final/);
  });

  it('hold mechanism (0760): a report hidden by hand and cleared as a false match is never released; the family never sees it', async () => {
    // Owner decision (2026-09-25): the API files no held report; the never-released rule stays with
    // the schema's mechanism and is exercised here with family_visible set false by hand.
    const s = await scanned();
    const [held] = await systemReport(s, { screen_categories: ['abuse'], family_visible: false });
    // Clearing and releasing in one update is refused.
    await expect(clear(held!.id, { family_visible: true })).rejects.toThrow(/never released/);
    await clear(held!.id);
    await expect(
      db.asService(
        (tx) => tx`update public.safety_reports set family_visible = true where id = ${held!.id}`,
      ),
    ).rejects.toThrow(/never released/);
    expect(
      await db.asParent(
        s.fam.ownerId,
        (tx) => tx`select id, resolution from public.safety_reports`,
      ),
    ).toEqual([]);
  });

  it('families read the clearance of a visible report only, and nobody but the service role writes it', async () => {
    const s = await scanned();
    const [visible] = await systemReport(s);
    const other = await scanned(s.fam);
    const [held] = await systemReport(other, {
      screen_categories: ['secrecy'],
      family_visible: false,
    });
    await clear(visible!.id);
    await clear(held!.id);
    expect(
      await db.asParent(
        s.fam.ownerId,
        (tx) =>
          tx<
            { id: string; resolution: string | null }[]
          >`select id, resolution from public.safety_reports order by id`,
      ),
    ).toEqual([{ id: visible!.id, resolution: 'false_match' }]);
    await expect(
      db.asParent(
        s.fam.ownerId,
        (tx) => tx`update public.safety_reports set resolution = null where id = ${visible!.id}`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asChild(childClaims(s.fam), (tx) => tx`select resolution from public.safety_reports`),
    ).rejects.toThrow(/permission denied/);
    // Another family sees neither.
    const stranger = await scanned();
    expect(
      await db.asParent(
        stranger.fam.ownerId,
        (tx) => tx`select id from public.safety_reports where id in (${visible!.id}, ${held!.id})`,
      ),
    ).toEqual([]);
  });

  it('a cleared report does not block purging that child', async () => {
    const s = await scanned();
    const [report] = await systemReport(s, { screen_categories: ['abuse'], family_visible: false });
    await clear(report!.id);
    await db.sql`insert into public.deletion_requests (family_id, scope, child_id, target_child_id, requested_by)
                 values (${s.fam.familyId}, 'child', ${s.childId}, ${s.childId}, ${s.fam.ownerId})`;
    await db.asService((tx) => tx`select app.purge_family_data(${s.fam.familyId}, ${s.childId})`);
    expect(
      await db.sql`select id from public.safety_reports where child_id = ${s.childId}`,
    ).toHaveLength(0);
  });
});
