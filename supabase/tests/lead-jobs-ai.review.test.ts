import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { seedFamily } from './fixtures.ts';

/**
 * Adversarial review of app.purge_family_data (migration 0620) against spec P4: "Purge active
 * uploads, derivatives, provider objects if any, queue payloads and caches on deletion" and E4
 * "Keep only explicitly justified billing/legal records". Expected to FAIL against the code under
 * review (RV-lead-jobs-ai-18). Synthetic data only.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.drop();
});

describe('child purge leaves the queue and usage rows keyed to the deleted child', () => {
  it('RV-lead-jobs-ai-18: no job payload or usage event still points at a purged child', async () => {
    const fam = await seedFamily(db, { childCount: 2 });
    const doomed = fam.children[0]!.id;
    const [a] = await db.sql<{ id: string }[]>`
      insert into public.assignments (family_id, child_id, idempotency_key, created_by_kind)
      values (${fam.familyId}, ${doomed}, ${'k-' + randomUUID()}, 'child') returning id`;
    // Finished queue work for the child (what the scan/learning/export jobs leave behind).
    await db.sql`
      insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, status)
      values ('scan_process', ${`scan:${a!.id}:v1`}, ${fam.familyId}, ${doomed},
              ${JSON.stringify({ assignmentId: a!.id, mode: 'initial' })}::text::jsonb, 'succeeded'),
             ('daily_set_generate', ${'daily:' + randomUUID()}, ${fam.familyId}, ${doomed},
              ${JSON.stringify({ childId: doomed, localDate: '2026-09-24' })}::text::jsonb, 'succeeded')`;
    // Per-operation AI metering for the child's scan.
    await db.sql`
      insert into public.ai_usage_events (family_id, child_id, stage, model_id, prompt_version, status, input_tokens, output_tokens, latency_ms, cost_micros, rate_table_version)
      values (${fam.familyId}, ${doomed}, 'extraction', 'gpt-5.6-terra', 'extraction.v1', 'succeeded', 1200, 300, 25, 900, 'test')`;
    await db.sql`
      insert into public.deletion_requests (family_id, scope, child_id, target_child_id, requested_by)
      values (${fam.familyId}, 'child', ${doomed}, ${doomed}, ${fam.ownerId})`;

    await db.asService((tx) => tx`select app.purge_family_data(${fam.familyId}, ${doomed})`);

    const [left] = await db.sql<{ child: number; jobs: number; usage: number }[]>`
      select (select count(*)::int from public.child_profiles where id = ${doomed}) as child,
             (select count(*)::int from public.jobs
               where kind <> 'deletion_purge'
                 and (child_id = ${doomed} or payload::text like ${'%' + doomed + '%'}
                      or payload::text like ${'%' + a!.id + '%'})) as jobs,
             (select count(*)::int from public.ai_usage_events where child_id = ${doomed}) as usage`;
    expect(left!.child).toBe(0); // the child is gone ...
    // ... so nothing in the queue or the metering tables may still identify it (0620's retained
    // list justifies billing, consent and audit rows only).
    expect.soft(left!.jobs).toBe(0);
    expect.soft(left!.usage).toBe(0);
  });
});
