import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { childClaims, grantAdultUnlock, seedFamily, type SeededFamily } from './fixtures.ts';

let db: TestDb;
let fam: SeededFamily;
let other: SeededFamily;
const UNLOCKED = '00000000-0000-4000-8000-0000000c0ffe';
const SECRET_ANSWER = '3/4';
const SECRET_SOLUTION = 'Divide both by the common factor to get three fourths.';

interface SeededAssignment {
  assignmentId: string;
  questionId: string;
  pageId: string;
  storagePath: string;
}

async function seedAssignment(family: SeededFamily, childIndex = 0): Promise<SeededAssignment> {
  const childId = family.children[childIndex]!.id;
  const [a] = await db.sql<{ id: string }[]>`
    insert into public.assignments (family_id, child_id, status, idempotency_key, created_by_kind, page_count)
    values (${family.familyId}, ${childId}, 'draft', ${'create-' + randomUUID()}, 'child', 1) returning id
  `;
  const pageId = randomUUID();
  const storagePath = `${family.familyId}/${childId}/${a!.id}/${pageId}.jpg`;
  await db.sql`
    insert into public.source_pages (id, assignment_id, family_id, child_id, page_number, storage_path, mime_type, byte_size, sha256)
    values (${pageId}, ${a!.id}, ${family.familyId}, ${childId}, 1, ${storagePath}, 'image/jpeg', 1000, ${'b'.repeat(64)})
  `;
  const [q] = await db.sql<{ id: string }[]>`
    insert into public.extracted_questions (assignment_id, family_id, child_id, page_id, question_number,
      prompt_text, student_answer_text, answer_kind, subject_key, skill)
    values (${a!.id}, ${family.familyId}, ${childId}, ${pageId}, '1', 'Simplify 6/8', '6/8', 'numeric', 'math', 'fractions.simplify')
    returning id
  `;
  await db.sql`
    insert into private.question_solutions (question_id, family_id, correct_answer, worked_solution, grader_version)
    values (${q!.id}, ${family.familyId}, ${SECRET_ANSWER}, ${SECRET_SOLUTION}, 'deterministic.v1')
  `;
  await db.sql`
    insert into public.question_results (question_id, family_id, child_id, verdict, route, grader_version)
    values (${q!.id}, ${family.familyId}, ${childId}, 'incorrect', 'deterministic', 'deterministic.v1')
  `;
  await db.sql`insert into storage.objects (bucket_id, name) values ('homework', ${storagePath})`;
  return { assignmentId: a!.id, questionId: q!.id, pageId, storagePath };
}

let mine: SeededAssignment;
let sibling: SeededAssignment;
let foreign: SeededAssignment;

beforeAll(async () => {
  db = await createTestDb();
  fam = await seedFamily(db, { childCount: 2 });
  other = await seedFamily(db, { childCount: 1 });
  mine = await seedAssignment(fam, 0);
  sibling = await seedAssignment(fam, 1);
  foreign = await seedAssignment(other, 0);
  await grantAdultUnlock(db, fam.ownerId, UNLOCKED, 3600);
});

afterAll(async () => {
  await db?.drop();
});

describe('protected parent solutions (AC_GRADING_05, AC_GRADING_06)', () => {
  it('a child cannot read solutions directly or through the parent function', async () => {
    await expect(
      db.asChild(childClaims(fam), (tx) => tx`select * from private.question_solutions`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asChild(
        childClaims(fam),
        (tx) => tx`select * from public.parent_assignment_solutions(${mine.assignmentId})`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('no child-readable row or column contains the withheld answer or solution', async () => {
    const claims = childClaims(fam);
    const dump = await db.asChild(claims, async (tx) => ({
      // Column grants make `select *` fail closed for children; the API selects the allowlist.
      questions:
        await tx`select id, assignment_id, child_id, question_number, prompt_text, student_answer_text, answer_kind, subject_key from public.extracted_questions`,
      results:
        await tx`select question_id, child_id, verdict, graded_at from public.question_results`,
      feedback:
        await tx`select id, question_id, child_id, kind, body, created_at from public.child_feedback`,
      assignments:
        await tx`select id, child_id, subject_id, status, page_count, created_at, updated_at from public.assignments`,
    }));
    const text = JSON.stringify(dump);
    expect(text).not.toContain(SECRET_SOLUTION);
    expect(text).not.toContain('correct_answer');
    expect(text).not.toContain('worked_solution');
    expect(Object.keys(dump.results[0]!)).toEqual([
      'question_id',
      'child_id',
      'verdict',
      'graded_at',
    ]);
  });

  it('a child selecting a forbidden column (or *) is denied, not silently empty', async () => {
    await expect(
      db.asChild(
        childClaims(fam),
        (tx) => tx`select disagreement, route from public.question_results`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asChild(childClaims(fam), (tx) => tx`select * from public.question_results`),
    ).rejects.toThrow(/permission denied/);
  });

  it('a parent without a recent unlock cannot read solutions', async () => {
    await expect(
      db.asParent(
        fam.ownerId,
        (tx) => tx`select * from public.parent_assignment_solutions(${mine.assignmentId})`,
      ),
    ).rejects.toThrow(/recent adult unlock required/);
  });

  it('a recently unlocked parent reads solutions for their own family only', async () => {
    const rows = await db.asParent(
      fam.ownerId,
      (tx) =>
        tx`select correct_answer from public.parent_assignment_solutions(${mine.assignmentId})`,
      { sessionId: UNLOCKED },
    );
    expect(rows).toEqual([{ correct_answer: SECRET_ANSWER }]);
    await expect(
      db.asParent(
        fam.ownerId,
        (tx) => tx`select * from public.parent_assignment_solutions(${foreign.assignmentId})`,
        { sessionId: UNLOCKED },
      ),
    ).rejects.toThrow(/assignment not found/);
  });

  it('anonymous callers cannot call the solution function', async () => {
    await expect(
      db.asAnon((tx) => tx`select * from public.parent_assignment_solutions(${mine.assignmentId})`),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('sibling and family isolation (AC_ACCESS_05, AC_CAPACITY_07)', () => {
  it('a child sees only their own assignments, questions and results', async () => {
    const claims = childClaims(fam, 0);
    const result = await db.asChild(claims, async (tx) => ({
      assignments: await tx`select id from public.assignments`,
      questions: await tx`select id from public.extracted_questions`,
      results: await tx`select question_id from public.question_results`,
    }));
    expect(result.assignments.map((r) => r.id)).toEqual([mine.assignmentId]);
    expect(result.questions.map((r) => r.id)).toEqual([mine.questionId]);
    expect(result.results.map((r) => r.question_id)).toEqual([mine.questionId]);
    expect(JSON.stringify(result)).not.toContain(sibling.assignmentId);
  });

  it('a parent sees both children but not another family', async () => {
    const rows = await db.asParent(fam.ownerId, (tx) => tx`select id from public.assignments`);
    expect(rows.map((r) => r.id).sort()).toEqual([mine.assignmentId, sibling.assignmentId].sort());
  });

  it('children cannot read attempts, overrides, templates or source pages', async () => {
    for (const table of [
      'attempts',
      'attempt_overrides',
      'question_templates',
      'source_pages',
      'study_materials',
    ]) {
      await expect(
        db.asChild(childClaims(fam), (tx) => tx.unsafe(`select * from public.${table}`)),
      ).rejects.toThrow(/permission denied/);
    }
  });
});

describe('private homework storage (AC_SECURITY_04)', () => {
  it('parents read only their family objects; anon and children read none', async () => {
    const parentRows = await db.asParent(
      fam.ownerId,
      (tx) => tx`select name from storage.objects where bucket_id = 'homework'`,
    );
    expect(parentRows.map((r) => r.name).sort()).toEqual(
      [mine.storagePath, sibling.storagePath].sort(),
    );
    const anonRows = await db.asAnon((tx) => tx`select name from storage.objects`);
    expect(anonRows).toHaveLength(0);
    await expect(
      db.asChild(childClaims(fam), (tx) => tx`select name from storage.objects`),
    ).rejects.toThrow(/permission denied/);
  });

  it('a malformed object path does not break policy evaluation for everyone', async () => {
    await db.sql`insert into storage.objects (bucket_id, name) values ('homework', 'not-a-uuid/whatever.jpg')`;
    const rows = await db.asParent(
      fam.ownerId,
      (tx) => tx`select name from storage.objects where bucket_id = 'homework'`,
    );
    expect(rows).toHaveLength(2);
  });

  it('the homework bucket is private', async () => {
    const [bucket] = await db.sql<
      { public: boolean }[]
    >`select public from storage.buckets where id = 'homework'`;
    expect(bucket!.public).toBe(false);
  });
});

describe('processing state machine (spec P5, AC_CAPTURE_06/07)', () => {
  it('follows allowed transitions and rejects skipping verification', async () => {
    const a = await seedAssignment(fam);
    for (const status of ['uploading', 'queued', 'extracting', 'checking']) {
      await db.sql`update public.assignments set status = ${status} where id = ${a.assignmentId}`;
    }
    await expect(
      db.sql`update public.assignments set status = 'ready' where id = ${a.assignmentId}`,
    ).rejects.toThrow(/invalid assignment transition checking -> ready/);
  });

  it('a failed_final job cannot be shown as ready', async () => {
    const a = await seedAssignment(fam);
    for (const status of ['uploading', 'queued', 'extracting', 'failed_final']) {
      await db.sql`update public.assignments set status = ${status} where id = ${a.assignmentId}`;
    }
    await expect(
      db.sql`update public.assignments set status = 'ready' where id = ${a.assignmentId}`,
    ).rejects.toThrow(/invalid assignment transition/);
  });

  it('duplicate create/finalize with the same idempotency key creates one assignment', async () => {
    const key = 'create-dup-' + randomUUID();
    const insert = () => db.sql`
      insert into public.assignments (family_id, child_id, idempotency_key, created_by_kind)
      values (${fam.familyId}, ${fam.children[0]!.id}, ${key}, 'parent')
    `;
    await insert();
    await expect(insert()).rejects.toThrow(/assignments_idempotency_key_key/);
  });

  it('deleted assignments disappear from the child view', async () => {
    const a = await seedAssignment(fam);
    await db.sql`update public.assignments set status = 'deleted' where id = ${a.assignmentId}`;
    const rows = await db.asChild(
      childClaims(fam),
      (tx) => tx`select id from public.assignments where id = ${a.assignmentId}`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('learning evidence (AC_LEARNING_01, AC_GRADING_10)', () => {
  it('attempts are immutable and one row per (instance, attempt number)', async () => {
    const instance = randomUUID();
    const insert = (n: number, key: string) => db.sql`
      insert into public.attempts (family_id, child_id, question_instance_id, source, subject_key, skill,
        attempt_number, hints_used, correctness, grader_version, idempotency_key, occurred_at)
      values (${fam.familyId}, ${fam.children[0]!.id}, ${instance}, 'daily', 'math', 'fractions', ${n}, 0,
        'incorrect', 'v1', ${key}, now())
    `;
    await insert(1, 'attempt-key-0001');
    await expect(insert(1, 'attempt-key-0002')).rejects.toThrow(
      /question_instance_id_attempt_number/,
    );
    await expect(db.sql`update public.attempts set correctness = 'correct'`).rejects.toThrow(
      /append-only/,
    );
    const [row] = await db.sql<
      { independent: boolean }[]
    >`select independent from public.attempts where question_instance_id = ${instance}`;
    expect(row!.independent).toBe(true);
  });

  it('parent overrides require unlock + reason and are audited', async () => {
    await expect(
      db.asParent(
        fam.ownerId,
        (tx) =>
          tx`select * from public.parent_override_result(${mine.questionId}, 'correct', 'Teacher accepted it')`,
      ),
    ).rejects.toThrow(/recent adult unlock required/);
    await expect(
      db.asParent(
        fam.ownerId,
        (tx) => tx`select * from public.parent_override_result(${mine.questionId}, 'correct', ' ')`,
        {
          sessionId: UNLOCKED,
        },
      ),
    ).rejects.toThrow(/reason is required/);
    const [res] = await db.asParent(
      fam.ownerId,
      (tx) =>
        tx`select * from public.parent_override_result(${mine.questionId}, 'correct', 'Teacher accepted it')`,
      { sessionId: UNLOCKED },
    );
    expect(res!.parent_override_verdict).toBe('correct');
    const audit =
      await db.sql`select action from public.audit_events where target_id = ${mine.questionId}`;
    expect(audit.map((a) => a.action)).toContain('grading.override');
  });
});

describe('practice sets (AC_LEARNING_06)', () => {
  it('children see ready sets and items but never the item keys', async () => {
    const [set] = await db.sql<{ id: string }[]>`
      insert into public.practice_sets (family_id, child_id, kind, set_key, local_date, status, ready_at)
      values (${fam.familyId}, ${fam.children[0]!.id}, 'daily', ${'daily:' + randomUUID()}, '2026-09-24', 'ready', now())
      returning id
    `;
    const [item] = await db.sql<{ id: string }[]>`
      insert into public.practice_items (set_id, family_id, child_id, position, subject_key, skill, category, prompt)
      values (${set!.id}, ${fam.familyId}, ${fam.children[0]!.id}, 1, 'math', 'fractions', 'weak', '{"text":"Simplify 4/6"}')
      returning id
    `;
    await db.sql`insert into private.practice_item_keys (item_id, family_id, answer_spec) values (${item!.id}, ${fam.familyId}, '{"value":"2/3"}')`;
    const items = await db.asChild(
      childClaims(fam),
      (tx) =>
        tx`select id, set_id, child_id, position, subject_key, skill, category, prompt from public.practice_items`,
    );
    await expect(
      db.asChild(childClaims(fam), (tx) => tx`select template_id from public.practice_items`),
    ).rejects.toThrow(/permission denied/);
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items)).not.toContain('2/3');
    await expect(
      db.asChild(childClaims(fam), (tx) => tx`select * from private.practice_item_keys`),
    ).rejects.toThrow(/permission denied/);
  });

  it('a generating set is invisible to the child', async () => {
    await db.sql`
      insert into public.practice_sets (family_id, child_id, kind, set_key, local_date, status)
      values (${fam.familyId}, ${fam.children[0]!.id}, 'daily', ${'daily:gen-' + randomUUID()}, '2026-09-25', 'generating')
    `;
    const rows = await db.asChild(
      childClaims(fam),
      (tx) => tx`select status from public.practice_sets where status = 'generating'`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('parent-managed settings', () => {
  it('a parent can add a subject and test date for their child but not for another family', async () => {
    const [subject] = await db.asParent(
      fam.ownerId,
      (tx) => tx`insert into public.child_subjects (family_id, child_id, subject_key, display_name)
                 values (${fam.familyId}, ${fam.children[0]!.id}, 'math', 'Math') returning id`,
    );
    await db.asParent(
      fam.ownerId,
      (tx) => tx`insert into public.test_dates (family_id, child_id, subject_id, test_date)
                 values (${fam.familyId}, ${fam.children[0]!.id}, ${subject!.id}, '2026-10-02')`,
    );
    await expect(
      db.asParent(
        fam.ownerId,
        (
          tx,
        ) => tx`insert into public.child_subjects (family_id, child_id, subject_key, display_name)
                   values (${fam.familyId}, ${other.children[0]!.id}, 'math', 'Math')`,
      ),
    ).rejects.toThrow(/foreign key|row-level security/);
    await expect(
      db.asParent(
        fam.ownerId,
        (
          tx,
        ) => tx`insert into public.child_subjects (family_id, child_id, subject_key, display_name)
                   values (${other.familyId}, ${other.children[0]!.id}, 'math', 'Math')`,
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
