import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { seedFamily, type SeededFamily } from './fixtures.ts';

/**
 * Parental/guardian attestation, per child (migration 0970, spec P3, AC_ACCESS_01/02) against real
 * Postgres.
 *
 * Verifiable parental consent is two claims and the schema carried only one. The consent provider
 * establishes that the consenting person is an ADULT and `public.consent_records` records it. That this
 * adult is THIS CHILD'S parent or legal guardian is established by nothing an identity check can
 * produce — no COPPA-enumerated method verifies a family relationship — so it rests on the adult's own
 * assertion, and that assertion now has a field.
 *
 * The constraint is in the DATABASE and not only in the handler because `authenticated` reaches
 * `public.child_profiles` through the Data API: a child may not be `active` without an attestation, so
 * the status that grants a paid slot and lets a device pair cannot be reached without one. This file
 * exercises it as the service role, which bypasses RLS — if the constraint holds for the role that
 * bypasses everything, no client can get past it either.
 *
 * Synthetic names only.
 */

let db: TestDb;
let fam: SeededFamily;

beforeAll(async () => {
  db = await createTestDb();
  fam = await seedFamily(db, { childCount: 0 });
});

afterAll(async () => {
  await db?.drop();
});

const VERSION = '2026-09-v1';

describe('a child may not be active without a parental attestation', () => {
  it('refuses an active child with no attestation at all', async () => {
    await expect(
      db.sql`
        insert into public.child_profiles (family_id, nickname, grade_level, age_band, status)
        values (${fam.familyId}, 'Riley', 3, '8-10', 'active')`,
    ).rejects.toThrow(/child_profiles_active_requires_attestation/);
  });

  it('refuses ACTIVATING a child that was created without one', async () => {
    const [child] = await db.sql<{ id: string }[]>`
      insert into public.child_profiles (family_id, nickname, grade_level, age_band, status)
      values (${fam.familyId}, 'Sam', 3, '8-10', 'draft') returning id`;
    // This is the path that matters: a draft is lawful, and the UPDATE to 'active' is what the API
    // does and what the Data API could attempt.
    await expect(
      db.sql`update public.child_profiles set status = 'active' where id = ${child!.id}`,
    ).rejects.toThrow(/child_profiles_active_requires_attestation/);
  });

  it('allows an active child that carries one', async () => {
    const [child] = await db.sql<{ id: string; status: string }[]>`
      insert into public.child_profiles
        (family_id, nickname, grade_level, age_band, status,
         attestation_version, attested_at, attested_by)
      values (${fam.familyId}, 'Jordan', 3, '8-10', 'active',
              ${VERSION}, now(), ${fam.ownerId}) returning id, status`;
    expect(child!.status).toBe('active');
  });

  it('leaves a draft and an archived profile free to sit unattested', async () => {
    // A draft holds no paid slot and cannot pair; an archived profile is history only. Neither opens
    // the product to a child, so neither needs the claim — and requiring it would block the archive
    // path for profiles that predate this column.
    for (const status of ['draft', 'archived'] as const) {
      const [row] = await db.sql<{ status: string }[]>`
        insert into public.child_profiles (family_id, nickname, grade_level, age_band, status)
        values (${fam.familyId}, 'Avery', 3, '8-10', ${status}) returning status`;
      expect(row!.status).toBe(status);
    }
  });
});

describe('an attestation is all three fields or none', () => {
  it('refuses a version with no instant', async () => {
    await expect(
      db.sql`
        insert into public.child_profiles
          (family_id, nickname, grade_level, age_band, attestation_version)
        values (${fam.familyId}, 'Riley', 3, '8-10', ${VERSION})`,
    ).rejects.toThrow(/child_profiles_attestation_complete/);
  });

  it('refuses an instant with no adult behind it', async () => {
    await expect(
      db.sql`
        insert into public.child_profiles
          (family_id, nickname, grade_level, age_band, attestation_version, attested_at)
        values (${fam.familyId}, 'Riley', 3, '8-10', ${VERSION}, now())`,
    ).rejects.toThrow(/child_profiles_attestation_complete/);
  });

  it('refuses an adult with no statement version, which is an attestation to nothing', async () => {
    await expect(
      db.sql`
        insert into public.child_profiles
          (family_id, nickname, grade_level, age_band, attested_at, attested_by)
        values (${fam.familyId}, 'Riley', 3, '8-10', now(), ${fam.ownerId})`,
    ).rejects.toThrow(/child_profiles_attestation_complete/);
  });
});

describe('the record answers what an audit would ask', () => {
  it('names which adult attested, against which statement version, and when', async () => {
    const before = new Date();
    const [child] = await db.sql<{ id: string }[]>`
      insert into public.child_profiles
        (family_id, nickname, grade_level, age_band, status,
         attestation_version, attested_at, attested_by)
      values (${fam.familyId}, 'Sam', 4, '8-10', 'active', ${VERSION}, now(), ${fam.ownerId})
      returning id`;
    const [row] = await db.sql<
      { attestation_version: string; attested_at: Date; attested_by: string }[]
    >`
      select attestation_version, attested_at, attested_by
        from public.child_profiles where id = ${child!.id}`;
    expect(row!.attestation_version).toBe(VERSION);
    expect(row!.attested_by).toBe(fam.ownerId);
    // A real instant, not a placeholder: an audit years later has to be able to date the claim.
    expect(row!.attested_at.getTime()).toBeGreaterThanOrEqual(before.getTime() - 60_000);
  });

  it('keeps the attestation when the child is archived, so history stays auditable', async () => {
    const [child] = await db.sql<{ id: string }[]>`
      insert into public.child_profiles
        (family_id, nickname, grade_level, age_band, status,
         attestation_version, attested_at, attested_by)
      values (${fam.familyId}, 'Avery', 4, '8-10', 'active', ${VERSION}, now(), ${fam.ownerId})
      returning id`;
    await db.sql`
      update public.child_profiles set status = 'archived', archived_at = now()
       where id = ${child!.id}`;
    const [row] = await db.sql<{ attestation_version: string | null }[]>`
      select attestation_version from public.child_profiles where id = ${child!.id}`;
    expect(row!.attestation_version).toBe(VERSION);
  });
});
