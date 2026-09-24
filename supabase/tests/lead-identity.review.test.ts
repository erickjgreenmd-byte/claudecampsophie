import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';

/**
 * Lead adversarial review, identity/access slice (spec P1/P3, migration 0001).
 * RV-lead-identity-access-9: public.create_family refuses an adult who "already belongs to a family"
 * with a plain, unlocked EXISTS check, and nothing in the schema makes an adult's active membership
 * unique (family_memberships_one_active_per_user_family is per (family, user)). Two overlapping
 * calls by the same adult — a double-submitted "Create family", a retry after a timeout, or a direct
 * PostgREST rpc — both pass the check and commit two families with the adult as owner of each.
 * The API then resolves the adult's family with `rows[0]` of an unordered query (currentFamilyId),
 * so which family, children, capacity and billing identity they see is arbitrary.
 * This is the create_family sibling of RV-family-2 (invitation acceptance); fixing only the
 * invitation path leaves this one open.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.drop();
});

describe('RV-lead-identity-access-9: one adult, one family, even under concurrent create_family', () => {
  it('two overlapping create_family calls by one adult leave exactly one active membership', async () => {
    const adult = await db.createUser('rv9.parent@example.test');
    let called = 0;
    let release!: () => void;
    const bothCalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    // If a fixed implementation makes the second call wait for the first, do not deadlock the test.
    const timeout = setTimeout(() => release(), 1500);

    const attempt = (name: string) =>
      db.asParent(adult, async (tx) => {
        const [row] = await tx<
          { id: string }[]
        >`select public.create_family(${name}, 'America/Chicago') as id`;
        called += 1;
        if (called === 2) release();
        await bothCalled; // hold the transaction open until the other call has run too
        return row!.id;
      });

    const results = await Promise.allSettled([
      attempt('Riley family'),
      attempt('Riley family (again)'),
    ]);
    clearTimeout(timeout);

    const [memberships] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from public.family_memberships where user_id = ${adult} and status = 'active'`;
    expect({
      activeMemberships: memberships!.n,
      created: results.filter((r) => r.status === 'fulfilled').length,
    }).toEqual({ activeMemberships: 1, created: 1 });
  });
});
