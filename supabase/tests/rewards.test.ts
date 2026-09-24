import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { childClaims, grantAdultUnlock, seedFamily, type SeededFamily } from './fixtures.ts';

let db: TestDb;
let fam: SeededFamily;
let other: SeededFamily;
const UNLOCKED_SESSION = '00000000-0000-4000-8000-00000000f00d';

async function award(
  family: SeededFamily,
  childIndex: number,
  points: number,
  key: string = randomUUID(),
) {
  await db.sql`
    insert into public.points_ledger (family_id, child_id, kind, points, idempotency_key, actor_kind)
    values (${family.familyId}, ${family.children[childIndex]!.id}, 'award', ${points}, ${'attempt:' + key}, 'system')
  `;
}

async function balance(family: SeededFamily, childIndex = 0): Promise<number> {
  const rows = await db.sql<{ balance: number }[]>`
    select balance from public.point_balances where child_id = ${family.children[childIndex]!.id}
  `;
  return rows[0]?.balance ?? 0;
}

async function createReward(
  family: SeededFamily,
  cost: number,
  childIndex?: number,
): Promise<string> {
  const [row] = await db.sql<{ id: string }[]>`
    insert into public.rewards (family_id, child_id, title, point_cost, created_by)
    values (${family.familyId}, ${childIndex === undefined ? null : family.children[childIndex]!.id},
            'Trip to the library', ${cost}, ${family.ownerId})
    returning id
  `;
  return row!.id;
}

const childRequest = (
  family: SeededFamily,
  reward: string,
  request = randomUUID(),
  childIndex = 0,
) =>
  db.asChild(
    childClaims(family, childIndex),
    (tx) => tx`select * from public.child_request_reward(${reward}, ${request})`,
  );

const parentDecide = (
  family: SeededFamily,
  request: string,
  action: string,
  sessionId = UNLOCKED_SESSION,
) =>
  db.asParent(
    family.ownerId,
    (tx) => tx`select * from public.parent_decide_reward(${request}, ${action})`,
    { sessionId },
  );

beforeAll(async () => {
  db = await createTestDb();
  fam = await seedFamily(db, { childCount: 2 });
  other = await seedFamily(db, { childCount: 1 });
  await grantAdultUnlock(db, fam.ownerId, UNLOCKED_SESSION, 3600);
});

afterAll(async () => {
  await db?.drop();
});

describe('ledger and balance (AC_REWARDS_01, AC_REWARDS_05)', () => {
  it('awards update the balance and duplicate award keys are rejected', async () => {
    const f = await seedFamily(db);
    await award(f, 0, 5, 'q-1');
    await expect(award(f, 0, 5, 'q-1')).rejects.toThrow(
      /points_ledger_child_id_idempotency_key_key/,
    );
    expect(await balance(f)).toBe(5);
  });

  it('the ledger is append-only', async () => {
    await award(fam, 0, 1);
    await expect(db.sql`update public.points_ledger set points = 999`).rejects.toThrow(
      /append-only/,
    );
    await expect(db.sql`delete from public.points_ledger`).rejects.toThrow(/append-only/);
  });

  it('no entry can drive a balance negative', async () => {
    const f = await seedFamily(db);
    await award(f, 0, 3);
    await expect(
      db.sql`
        insert into public.points_ledger (family_id, child_id, kind, points, idempotency_key, reason, actor_kind)
        values (${f.familyId}, ${f.children[0]!.id}, 'adjustment', -4, 'adjust:x', 'correction', 'parent')
      `,
    ).rejects.toThrow(/insufficient points/);
    expect(await balance(f)).toBe(3);
  });
});

describe('redemption workflow (AC_REWARDS_02, AC_REWARDS_03)', () => {
  it('a child request reserves points; decline releases exactly once', async () => {
    const f = await seedFamily(db);
    await grantAdultUnlock(db, f.ownerId, UNLOCKED_SESSION, 3600);
    await award(f, 0, 20);
    const reward = await createReward(f, 15);
    const request = randomUUID();
    const [req] = await childRequest(f, reward, request);
    expect(req!.state).toBe('pending');
    expect(await balance(f)).toBe(5);
    await parentDecide(f, request, 'decline');
    await parentDecide(f, request, 'decline');
    expect(await balance(f)).toBe(20);
  });

  it('retrying the same request id does not reserve twice', async () => {
    const f = await seedFamily(db);
    await award(f, 0, 30);
    const reward = await createReward(f, 10);
    const request = randomUUID();
    await childRequest(f, reward, request);
    await childRequest(f, reward, request);
    expect(await balance(f)).toBe(20);
  });

  it('insufficient points leaves no request and no ledger entry', async () => {
    const f = await seedFamily(db);
    await award(f, 0, 4);
    const reward = await createReward(f, 5);
    const request = randomUUID();
    await expect(childRequest(f, reward, request)).rejects.toThrow(/insufficient points/);
    const rows = await db.sql`select id from public.reward_redemptions where id = ${request}`;
    expect(rows).toHaveLength(0);
    expect(await balance(f)).toBe(4);
  });

  it('two devices redeeming concurrently cannot spend the same points', async () => {
    const f = await seedFamily(db);
    await award(f, 0, 10);
    const reward = await createReward(f, 10);
    const results = await Promise.allSettled([
      childRequest(f, reward),
      childRequest(f, reward),
      childRequest(f, reward),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await balance(f)).toBe(0);
  });

  it('approve then fulfill keeps points spent; fulfilled cannot be cancelled', async () => {
    const f = await seedFamily(db);
    await grantAdultUnlock(db, f.ownerId, UNLOCKED_SESSION, 3600);
    await award(f, 0, 10);
    const reward = await createReward(f, 10);
    const request = randomUUID();
    await childRequest(f, reward, request);
    await parentDecide(f, request, 'approve');
    await parentDecide(f, request, 'fulfill');
    expect(await balance(f)).toBe(0);
    await expect(parentDecide(f, request, 'cancel')).rejects.toThrow(
      /invalid reward redemption transition fulfilled -> cancelled/,
    );
  });

  it('a parent can cancel an approved request and the points return once', async () => {
    const f = await seedFamily(db);
    await grantAdultUnlock(db, f.ownerId, UNLOCKED_SESSION, 3600);
    await award(f, 0, 12);
    const reward = await createReward(f, 12);
    const request = randomUUID();
    await childRequest(f, reward, request);
    await parentDecide(f, request, 'approve');
    await parentDecide(f, request, 'cancel');
    expect(await balance(f)).toBe(12);
  });

  it('a child can cancel only a pending request', async () => {
    const f = await seedFamily(db);
    await grantAdultUnlock(db, f.ownerId, UNLOCKED_SESSION, 3600);
    await award(f, 0, 20);
    const reward = await createReward(f, 5);
    const pending = randomUUID();
    await childRequest(f, reward, pending);
    await db.asChild(
      childClaims(f),
      (tx) => tx`select * from public.child_cancel_reward_request(${pending})`,
    );
    expect(await balance(f)).toBe(20);
    const approved = randomUUID();
    await childRequest(f, reward, approved);
    await parentDecide(f, approved, 'approve');
    await expect(
      db.asChild(
        childClaims(f),
        (tx) => tx`select * from public.child_cancel_reward_request(${approved})`,
      ),
    ).rejects.toThrow(/only pending requests/);
  });

  it('parent decisions require a recent unlock and the right family', async () => {
    await award(fam, 0, 10);
    const reward = await createReward(fam, 3);
    const request = randomUUID();
    await childRequest(fam, reward, request);
    await expect(
      parentDecide(fam, request, 'approve', '00000000-0000-4000-8000-00000000beef'),
    ).rejects.toThrow(/recent adult unlock required/);
    await expect(
      db.asParent(
        other.ownerId,
        (tx) => tx`select * from public.parent_decide_reward(${request}, 'approve')`,
      ),
    ).rejects.toThrow(/request not found/);
  });

  it('a child cannot request a reward reserved for a sibling', async () => {
    await award(fam, 0, 50);
    const siblingOnly = await createReward(fam, 1, 1);
    await expect(childRequest(fam, siblingOnly)).rejects.toThrow(/reward not available/);
  });
});

describe('parent adjustments (AC_REWARDS_05)', () => {
  it('require a reason and a recent unlock and are idempotent', async () => {
    const child = fam.children[1]!.id;
    await expect(
      db.asParent(
        fam.ownerId,
        (tx) => tx`select public.parent_adjust_points(${child}, 5, '  ', ${randomUUID()})`,
        { sessionId: UNLOCKED_SESSION },
      ),
    ).rejects.toThrow(/reason is required/);
    const adjustment = randomUUID();
    for (let i = 0; i < 2; i += 1) {
      await db.asParent(
        fam.ownerId,
        (tx) => tx`select public.parent_adjust_points(${child}, 5, 'Extra reading', ${adjustment})`,
        { sessionId: UNLOCKED_SESSION },
      );
    }
    expect(await balance(fam, 1)).toBe(5);
    await expect(
      db.asParent(
        fam.ownerId,
        (tx) => tx`select public.parent_adjust_points(${child}, 5, 'x', ${randomUUID()})`,
      ),
    ).rejects.toThrow(/recent adult unlock required/);
  });
});

describe('isolation', () => {
  it('a child sees only their own balance, ledger and requests', async () => {
    await award(fam, 1, 7);
    const claims = childClaims(fam, 0);
    const balances = await db.asChild(
      claims,
      (tx) => tx`select child_id from public.point_balances`,
    );
    expect(balances.every((b) => b.child_id === fam.children[0]!.id)).toBe(true);
    const ledger = await db.asChild(claims, (tx) => tx`select child_id from public.points_ledger`);
    expect(ledger.every((l) => l.child_id === fam.children[0]!.id)).toBe(true);
  });

  it('a child cannot write to the ledger or balances directly', async () => {
    await expect(
      db.asChild(childClaims(fam), (tx) => tx`update public.point_balances set balance = 9999`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.asChild(
        childClaims(fam),
        (
          tx,
        ) => tx`insert into public.points_ledger (family_id, child_id, kind, points, idempotency_key, actor_kind)
                   values (${fam.familyId}, ${fam.children[0]!.id}, 'award', 100, 'forged', 'child')`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('parents cannot read another family ledger', async () => {
    const rows = await db.asParent(other.ownerId, (tx) => tx`select id from public.points_ledger`);
    expect(rows).toHaveLength(0);
  });
});
