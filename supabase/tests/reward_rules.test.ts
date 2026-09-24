import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { childClaims, grantAdultUnlock, seedFamily, type SeededFamily } from './fixtures.ts';

/**
 * Family earning rules (spec P9 "configurable earning rules"; AC_REWARDS_01), migration 0750.
 * Parents change the rules only through public.parent_set_reward_rules (membership + recent
 * step-up re-checked in the database, audited in the same transaction); a paired child reads the
 * published point values of its own family and never the anti-farming threshold.
 */

let db: TestDb;
let fam: SeededFamily;
let other: SeededFamily;
let guardianId: string;
const UNLOCKED = '00000000-0000-4000-8000-00000000a750';
const LOCKED = '00000000-0000-4000-8000-00000000b750';
const GUARDIAN_SESSION = '00000000-0000-4000-8000-00000000c750';

type Rules = [number, number, number, number];

const setRules = (userId: string, family: string, rules: Rules, sessionId = UNLOCKED) =>
  db.asParent(
    userId,
    async (tx) => {
      const [row] = await tx<{ changed: boolean }[]>`
        select public.parent_set_reward_rules(${family}, ${rules[0]}, ${rules[1]}, ${rules[2]}, ${rules[3]}) as changed`;
      return row!.changed;
    },
    { sessionId },
  );

async function storedRules(family: string): Promise<Rules | null> {
  const [row] = await db.sql<
    {
      attempt_points: number;
      independent_correct_bonus: number;
      set_completion_points: number;
      min_meaningful_response_ms: number;
    }[]
  >`
    select attempt_points, independent_correct_bonus, set_completion_points, min_meaningful_response_ms
      from public.reward_rules where family_id = ${family}`;
  return row
    ? [
        row.attempt_points,
        row.independent_correct_bonus,
        row.set_completion_points,
        row.min_meaningful_response_ms,
      ]
    : null;
}

async function ruleAudits(family: string) {
  return db.sql<{ actor_user_id: string; metadata: Record<string, unknown> }[]>`
    select actor_user_id, metadata from public.audit_events
     where family_id = ${family} and action = 'reward_rules.updated' order by id`;
}

beforeAll(async () => {
  db = await createTestDb();
  fam = await seedFamily(db, { childCount: 2 });
  other = await seedFamily(db, { childCount: 1 });
  guardianId = await db.createUser();
  await db.sql`
    insert into public.family_memberships (family_id, user_id, role, status, invited_by)
    values (${fam.familyId}, ${guardianId}, 'guardian', 'active', ${fam.ownerId})`;
  await grantAdultUnlock(db, fam.ownerId, UNLOCKED, 3600);
  await grantAdultUnlock(db, other.ownerId, UNLOCKED, 3600);
  await grantAdultUnlock(db, guardianId, GUARDIAN_SESSION, 3600);
});

afterAll(async () => {
  await db?.drop();
});

describe('parent_set_reward_rules (spec P9, AC_REWARDS_01)', () => {
  it('an unlocked family adult publishes rules; a repeat is a no-op and only changes are audited', async () => {
    const f = await seedFamily(db);
    await grantAdultUnlock(db, f.ownerId, UNLOCKED, 3600);
    expect(await storedRules(f.familyId)).toBeNull(); // suggested defaults apply until changed
    expect(await setRules(f.ownerId, f.familyId, [4, 6, 10, 2000])).toBe(true);
    expect(await storedRules(f.familyId)).toEqual([4, 6, 10, 2000]);
    expect(await setRules(f.ownerId, f.familyId, [4, 6, 10, 2000])).toBe(false);
    expect(await setRules(f.ownerId, f.familyId, [4, 6, 12, 2000])).toBe(true);
    const audits = await ruleAudits(f.familyId);
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.actor_user_id === f.ownerId)).toBe(true);
    expect(audits[1]!.metadata).toEqual({
      before: {
        attemptPoints: 4,
        independentCorrectBonus: 6,
        setCompletionPoints: 10,
        minMeaningfulResponseMs: 2000,
      },
      after: {
        attemptPoints: 4,
        independentCorrectBonus: 6,
        setCompletionPoints: 12,
        minMeaningfulResponseMs: 2000,
      },
    });
  });

  it('requires a recent adult unlock (step-up) inside the database', async () => {
    const before = await storedRules(fam.familyId);
    await expect(setRules(fam.ownerId, fam.familyId, [9, 9, 9, 1500], LOCKED)).rejects.toThrow(
      /recent adult unlock required/,
    );
    expect(await storedRules(fam.familyId)).toEqual(before);
  });

  it('a guardian may change the rules, like every other parent reward action', async () => {
    expect(await setRules(guardianId, fam.familyId, [3, 4, 6, 1500], GUARDIAN_SESSION)).toBe(true);
    expect(await storedRules(fam.familyId)).toEqual([3, 4, 6, 1500]);
    const [audit] = (await ruleAudits(fam.familyId)).slice(-1);
    expect(audit!.actor_user_id).toBe(guardianId);
  });

  it('a revoked guardian and another family’s adult cannot change or read the rules', async () => {
    const f = await seedFamily(db);
    const revoked = await db.createUser();
    await db.sql`
      insert into public.family_memberships (family_id, user_id, role, status, invited_by, revoked_at, revoked_by)
      values (${f.familyId}, ${revoked}, 'guardian', 'revoked', ${f.ownerId}, now(), ${f.ownerId})`;
    await grantAdultUnlock(db, revoked, UNLOCKED, 3600);
    await grantAdultUnlock(db, f.ownerId, UNLOCKED, 3600);
    await setRules(f.ownerId, f.familyId, [5, 5, 5, 1500]);
    await expect(setRules(revoked, f.familyId, [0, 0, 0, 60000])).rejects.toThrow(
      /family not found/,
    );
    await expect(setRules(other.ownerId, f.familyId, [0, 0, 0, 60000])).rejects.toThrow(
      /family not found/,
    );
    expect(await storedRules(f.familyId)).toEqual([5, 5, 5, 1500]);
    const visible = await db.asParent(
      other.ownerId,
      (tx) => tx`select family_id from public.reward_rules where family_id = ${f.familyId}`,
      { sessionId: UNLOCKED },
    );
    expect(visible).toEqual([]);
  });

  it('refuses values outside the published limits, including a threshold under 500 ms', async () => {
    const f = await seedFamily(db);
    await grantAdultUnlock(db, f.ownerId, UNLOCKED, 3600);
    const invalid: Rules[] = [
      [101, 3, 5, 1500],
      [-1, 3, 5, 1500],
      [2, 101, 5, 1500],
      [2, 3, -1, 1500],
      [2, 3, 5, 499],
      [2, 3, 5, 0],
      [2, 3, 5, 60001],
    ];
    for (const rules of invalid) {
      await expect(setRules(f.ownerId, f.familyId, rules)).rejects.toMatchObject({
        code: '22023',
      });
    }
    await expect(
      db.asParent(
        f.ownerId,
        (tx) =>
          tx`select public.parent_set_reward_rules(${f.familyId}, null, 3, 5, 1500) as changed`,
        { sessionId: UNLOCKED },
      ),
    ).rejects.toMatchObject({ code: '22023' });
    expect(await storedRules(f.familyId)).toBeNull();
    // The lowest and highest published values are accepted.
    expect(await setRules(f.ownerId, f.familyId, [0, 0, 0, 500])).toBe(true);
    expect(await setRules(f.ownerId, f.familyId, [100, 100, 100, 60000])).toBe(true);
  });

  it('the table itself refuses a threshold under the 500 ms anti-farming floor', async () => {
    const f = await seedFamily(db);
    await expect(
      db.sql`insert into public.reward_rules (family_id, min_meaningful_response_ms) values (${f.familyId}, 0)`,
    ).rejects.toThrow(/reward_rules_min_meaningful_floor/);
    await db.sql`insert into public.reward_rules (family_id) values (${f.familyId})`;
    await expect(
      db.sql`update public.reward_rules set min_meaningful_response_ms = 499 where family_id = ${f.familyId}`,
    ).rejects.toThrow(/reward_rules_min_meaningful_floor/);
    expect(await storedRules(f.familyId)).toEqual([2, 3, 5, 1500]);
  });
});

describe('reward_rules grants', () => {
  it('parents cannot write the table directly; children and anon cannot call the RPC', async () => {
    await expect(
      db.asParent(
        fam.ownerId,
        (tx) =>
          tx`update public.reward_rules set attempt_points = 100 where family_id = ${fam.familyId}`,
        { sessionId: UNLOCKED },
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asParent(
        other.ownerId,
        (tx) => tx`insert into public.reward_rules (family_id) values (${other.familyId})`,
        { sessionId: UNLOCKED },
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asChild(
        childClaims(fam),
        (tx) =>
          tx`select public.parent_set_reward_rules(${fam.familyId}, 100, 100, 100, 500) as changed`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asAnon(
        (tx) =>
          tx`select public.parent_set_reward_rules(${fam.familyId}, 100, 100, 100, 500) as changed`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asChild(
        childClaims(fam),
        (tx) =>
          tx`update public.reward_rules set attempt_points = 100 where family_id = ${fam.familyId}`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('a paired child reads its own family’s point values only, never the threshold', async () => {
    await setRules(fam.ownerId, fam.familyId, [3, 4, 6, 1500]);
    await setRules(other.ownerId, other.familyId, [9, 9, 9, 1500]);
    const rows = await db.asChild(
      childClaims(fam, 1),
      (tx) => tx<
        {
          family_id: string;
          attempt_points: number;
          independent_correct_bonus: number;
          set_completion_points: number;
        }[]
      >`
        select family_id, attempt_points, independent_correct_bonus, set_completion_points
          from public.reward_rules`,
    );
    expect(rows).toEqual([
      {
        family_id: fam.familyId,
        attempt_points: 3,
        independent_correct_bonus: 4,
        set_completion_points: 6,
      },
    ]);
    await expect(
      db.asChild(
        childClaims(fam),
        (tx) => tx`select min_meaningful_response_ms from public.reward_rules`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asChild(childClaims(fam), (tx) => tx`select updated_at from public.reward_rules`),
    ).rejects.toThrow(/permission denied/);
  });
});
