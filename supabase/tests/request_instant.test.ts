import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { grantAdultUnlock, seedFamily } from './fixtures.ts';

/**
 * Migration 0780 (BUG-090): jobs enqueued inside the database are due at the request instant the
 * application states for the transaction, else at the database clock. Clients cannot state one.
 */
let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.drop();
});

describe('jobs.run_after follows the stated request instant', () => {
  it('a purge job enqueued by request_deletion is due at the stated instant', async () => {
    const fam = await seedFamily(db, { childCount: 1 });
    const stated = new Date('2031-01-15T08:30:00Z');
    await grantAdultUnlock(db, fam.ownerId);
    await db.asParent(fam.ownerId, async (tx) => {
      await tx`select set_config('pencillift.request_now', ${stated.toISOString()}, true)`;
      await tx`select public.request_deletion(${fam.familyId}, null)`;
    });
    const [job] = await db.sql<{ run_after: Date }[]>`
      select run_after from public.jobs where family_id = ${fam.familyId} and kind = 'deletion_purge'`;
    expect(job!.run_after.toISOString()).toBe(stated.toISOString());
  });

  it('without a stated instant the database clock is used', async () => {
    const [row] = await db.asService(
      (tx) => tx<{ same: boolean }[]>`select app.request_instant() = now() as same`,
    );
    expect(row!.same).toBe(true);
  });

  it('anonymous callers cannot execute the helper', async () => {
    await expect(db.asAnon((tx) => tx`select app.request_instant()`)).rejects.toThrow(
      /permission denied/,
    );
  });
});
