import type { TestDb } from './harness.ts';

/** Synthetic fixtures only (spec P3: never real children's details). */
export const SYNTHETIC_CHILD_NAMES = ['Riley', 'Sam', 'Jordan', 'Avery'] as const;

export const DEFAULT_SESSION_ID = '00000000-0000-4000-8000-000000000001';

export interface SeededChild {
  id: string;
  deviceId: string;
  sessionId: string;
}

export interface SeededFamily {
  familyId: string;
  ownerId: string;
  children: SeededChild[];
}

/**
 * Creates a verified adult, a family through the real `create_family` RPC (as that adult), and
 * `childCount` active children each with a paired device and a live session.
 */
export async function seedFamily(
  db: TestDb,
  options: { childCount?: number; timezone?: string; displayName?: string } = {},
): Promise<SeededFamily> {
  const ownerId = await db.createUser();
  const familyId = await db.asParent(ownerId, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      select public.create_family(${options.displayName ?? 'Test Family'}, ${options.timezone ?? 'America/Chicago'}) as id
    `;
    return rows[0]!.id;
  });

  const children: SeededChild[] = [];
  for (let i = 0; i < (options.childCount ?? 1); i += 1) {
    children.push(await seedChild(db, familyId, SYNTHETIC_CHILD_NAMES[i % 4]));
  }
  return { familyId, ownerId, children };
}

export async function seedChild(
  db: TestDb,
  familyId: string,
  nickname = 'Riley',
  status: 'draft' | 'active' | 'archived' = 'active',
): Promise<SeededChild> {
  const [child] = await db.sql<{ id: string }[]>`
    insert into public.child_profiles (family_id, nickname, grade_level, age_band, status)
    values (${familyId}, ${nickname}, 3, '8-10', ${status})
    returning id
  `;
  const [device] = await db.sql<{ id: string }[]>`
    insert into public.child_devices (family_id, child_id, label, platform)
    values (${familyId}, ${child!.id}, 'Test tablet', 'ios')
    returning id
  `;
  const [session] = await db.sql<{ id: string }[]>`
    insert into public.child_sessions (family_id, child_id, device_id, expires_at)
    values (${familyId}, ${child!.id}, ${device!.id}, now() + interval '1 hour')
    returning id
  `;
  return { id: child!.id, deviceId: device!.id, sessionId: session!.id };
}

/** Records a server-verified adult step-up for the given Supabase auth session. */
export async function grantAdultUnlock(
  db: TestDb,
  userId: string,
  sessionId = DEFAULT_SESSION_ID,
  ttlSeconds = 300,
): Promise<void> {
  await db.sql`
    insert into private.adult_unlocks (user_id, auth_session_id, method, expires_at)
    values (${userId}, ${sessionId}, 'pin', now() + make_interval(secs => ${ttlSeconds}))
  `;
}

export function childClaims(family: SeededFamily, index = 0) {
  const child = family.children[index]!;
  return { childId: child.id, familyId: family.familyId, sessionId: child.sessionId };
}

/** Adds an owner-admin user (MFA must still be present on the session claims). */
export async function seedOwnerAdmin(db: TestDb): Promise<string> {
  const id = await db.createUser();
  await db.sql`insert into public.admin_users (user_id, role) values (${id}, 'owner_admin')`;
  return id;
}
