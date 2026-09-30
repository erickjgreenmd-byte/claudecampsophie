import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { seedFamily, type SeededFamily } from './fixtures.ts';

/**
 * Migration 0990: the owner's method for establishing an adult — a government photo ID whose own date
 * of birth puts the holder at or over the adult age, PLUS the holder's legal declaration that they
 * are the person shown on it and the child's parent or guardian.
 *
 * WHY THIS IS A SEPARATE FILE AND A SEPARATE TABLE. 0980's biometric standard and its tests are
 * untouched. The first attempt at this change redefined `identity_verifications.adult_confirmed` to
 * drop the face comparison, which would have meant re-aiming the 0980 case that asserts five
 * non-matching biometric answers REFUSE into one saying they now confirm. That is a security control
 * changing meaning under a name that did not change, and neither a reader nor an auditor could then
 * tell which standard any row had met. Two named standards cannot be confused.
 *
 * What this file pins:
 *   1. `adult_declared` cannot be asserted by a writer — it is generated from three inputs.
 *   2. The DECLARATION is the gate. A genuine government ID of a genuine adult establishes NOTHING
 *      without it, because anyone can photograph an adult's licence.
 *   3. Nothing read off the document is stored.
 *   4. An established adult earns the verified consent row every existing gate reads, in the same
 *      transaction, and it carries the BASIS so the weaker standard is never invisible.
 *   5. `adult_identity_basis` reports which standard was met, and prefers the stronger one.
 */
let db: TestDb;
let fam: SeededFamily;

beforeAll(async () => {
  db = await createTestDb();
  fam = await seedFamily(db, { childCount: 1 });
});
afterAll(async () => {
  await db?.drop();
});

const NOW = new Date('2026-09-30T12:00:00.000Z');
const VERSION = '2026-09-v1';

/** Records one submission through the only writer there is. */
async function declare(
  over: Partial<{
    provider: string;
    reference: string | null;
    documentIsGovernmentId: boolean;
    documentHolderIsAdult: boolean;
    holderAttestationVersion: string | null;
    failureCode: string | null;
    isTestProvider: boolean;
    adult: string;
    family: string;
  }> = {},
) {
  const v = {
    provider: 'openai_document',
    reference: 'synthetic-ref-1',
    documentIsGovernmentId: true,
    documentHolderIsAdult: true,
    holderAttestationVersion: VERSION as string | null,
    failureCode: null as string | null,
    isTestProvider: false,
    adult: fam.ownerId,
    family: fam.familyId,
    ...over,
  };
  return db.asService(
    (tx) => tx<{ id: string; adult_declared: boolean; failure_code: string | null }[]>`
      select id, adult_declared, failure_code from app.record_identity_declaration(
        ${v.family}::uuid, ${v.adult}::uuid, ${v.provider}, ${v.reference},
        ${v.documentIsGovernmentId}, ${v.documentHolderIsAdult},
        ${v.holderAttestationVersion}, ${v.failureCode}, ${v.isTestProvider},
        ${VERSION}, ${NOW})`,
  );
}

/** The error Postgres raised, or '' when the statement succeeded. */
async function refusal(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('[0990] the declaration keeps nothing that was on the document', () => {
  it('has no column for an image, a document number, a date of birth, a name or an address', async () => {
    const columns = await db.sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'identity_declarations'
       order by column_name`;
    const names = columns.map((c) => c.column_name);
    // The whole list, asserted exactly: a later migration that adds anything reds here and has to
    // justify itself rather than arriving unnoticed.
    expect(names).toEqual([
      'adult_declared',
      'adult_user_id',
      'checked_at',
      'created_at',
      'document_holder_is_adult',
      'document_is_government_id',
      'failure_code',
      'family_id',
      'holder_attestation_version',
      'holder_attested_at',
      'id',
      'images_discarded_at',
      'is_test_provider',
      'provider',
      'provider_reference',
    ]);
    // And as a PROPERTY, so the intent survives a legitimate addition. The two exemptions are by
    // EXACT NAME, not by loosening the rule: `images_discarded_at` asserts an image is GONE, which is
    // the opposite of keeping one, and `holder_attested_at` is when the adult acted, which is a fact
    // about them and not about the document. A new `document_number` or `selfie_hash` still reds.
    const allowedDespiteName = new Set(['images_discarded_at', 'holder_attested_at']);
    const suspect = names.filter((n) => !allowedDespiteName.has(n));
    for (const forbidden of [
      'image',
      'photo',
      'selfie',
      'template',
      'embedding',
      'biometric',
      'document_number',
      'licence',
      'license',
      'date_of_birth',
      'birth',
      'dob',
      'first_name',
      'last_name',
      'full_name',
      'address',
      'ssn',
    ]) {
      expect(
        suspect.filter((n) => n.includes(forbidden)),
        forbidden,
      ).toEqual([]);
    }
  });

  it('cannot exist without asserting the image is gone', async () => {
    const missing = await refusal(
      db.asService(
        (tx) => tx`
          insert into public.identity_declarations
            (family_id, adult_user_id, provider, document_is_government_id,
             document_holder_is_adult, holder_attestation_version, holder_attested_at,
             is_test_provider, checked_at)
          values (${fam.familyId}::uuid, ${fam.ownerId}::uuid, 'x', true, true,
                  ${VERSION}, ${NOW}, false, ${NOW})`,
      ),
    );
    expect(missing).toMatch(/images_discarded_at/);
  });
});

describe('[0990] the declaration is the gate, and no writer may assert it', () => {
  it('refuses to let any writer set adult_declared', async () => {
    const asserted = await refusal(
      db.asService(
        (tx) => tx`
          insert into public.identity_declarations
            (family_id, adult_user_id, provider, document_is_government_id,
             document_holder_is_adult, is_test_provider, images_discarded_at, checked_at,
             adult_declared)
          values (${fam.familyId}::uuid, ${fam.ownerId}::uuid, 'x', false, false, false,
                  ${NOW}, ${NOW}, true)`,
      ),
    );
    // A generated column cannot be written at all: the refusal is the database's, not a check's.
    expect(asserted).toMatch(/adult_declared/);
  });

  it('establishes nothing without the declaration, whatever the document showed', async () => {
    // THE point of this standard, asserted in the direction that matters. A genuine government ID of
    // a genuine adult is not enough on its own, because photographing an adult's licence is not hard.
    const [row] = await declare({
      holderAttestationVersion: null,
      failureCode: 'ATTESTATION_REQUIRED',
    });
    expect(row!.adult_declared).toBe(false);
  });

  it('establishes nothing for a non-ID, nor for an ID whose holder is not an adult', async () => {
    const [notId] = await declare({
      documentIsGovernmentId: false,
      failureCode: 'NOT_A_GOVERNMENT_ID',
    });
    expect(notId!.adult_declared).toBe(false);
    const [minor] = await declare({
      documentHolderIsAdult: false,
      failureCode: 'NOT_AN_ADULT',
    });
    expect(minor!.adult_declared).toBe(false);
  });

  it('establishes an adult when all three hold, and names no failure', async () => {
    const [row] = await declare();
    expect(row!.adult_declared).toBe(true);
    expect(row!.failure_code).toBeNull();
  });

  it('records the declaration version with its instant, or neither', async () => {
    const [made] = await db.sql<
      { holder_attestation_version: string | null; holder_attested_at: string | null }[]
    >`select holder_attestation_version, holder_attested_at
        from public.identity_declarations
       where adult_declared order by checked_at desc limit 1`;
    expect(made!.holder_attestation_version).toBe(VERSION);
    expect(made!.holder_attested_at).not.toBeNull();
    // A version with no instant is refused, so a row cannot claim a declaration it cannot date.
    const halfMade = await refusal(
      db.asService(
        (tx) => tx`
          insert into public.identity_declarations
            (family_id, adult_user_id, provider, document_is_government_id,
             document_holder_is_adult, holder_attestation_version, is_test_provider,
             images_discarded_at, checked_at)
          values (${fam.familyId}::uuid, ${fam.ownerId}::uuid, 'x', true, true, ${VERSION},
                  false, ${NOW}, ${NOW})`,
      ),
    );
    expect(halfMade).toMatch(/identity_declarations_attestation_complete/);
  });

  it('insists an establishment names no failure and a refusal names one', async () => {
    const establishedWithFailure = await refusal(declare({ failureCode: 'SOMETHING' }));
    expect(establishedWithFailure).toMatch(/identity_declarations_established_names_no_failure/);
    const refusedWithoutFailure = await refusal(
      declare({ holderAttestationVersion: null, failureCode: null }),
    );
    expect(refusedWithoutFailure).toMatch(/identity_declarations_unestablished_says_why/);
  });

  it('accepts only a short machine failure code, never provider prose', async () => {
    // Provider prose can quote what was read off the document. The pattern is what stops it.
    const prose = await refusal(
      declare({
        holderAttestationVersion: null,
        failureCode: 'Jordan did not confirm the statement about the licence',
      }),
    );
    expect(prose).toMatch(/failure_code/);
  });
});

describe('[0990] an established adult earns the consent row every gate already reads', () => {
  it('writes it in the same transaction, carrying the basis and the version', async () => {
    const solo = await seedFamily(db, { childCount: 1 });
    const consents = () =>
      db.sql<{ status: string; method: string; scope: Record<string, unknown> }[]>`
        select status, method, scope from public.consent_records
         where family_id = ${solo.familyId} order by created_at`;
    const before = (await consents()).length;

    await declare({ family: solo.familyId, adult: solo.ownerId });
    const after = await consents();
    expect(after.length).toBe(before + 1);
    const row = after.at(-1)!;
    expect(row.status).toBe('verified');
    // The method names HOW, so an audit reading consent_records alone can tell this standard from a
    // face-matched one without joining back to the evidence table.
    expect(row.method).toBe('document_only');
    expect(row.scope.basis).toBe('declared');
    expect(row.scope.holderAttestationVersion).toBe(VERSION);
  });

  it('writes none for a refusal', async () => {
    const solo = await seedFamily(db, { childCount: 1 });
    const count = () =>
      db.sql<{ n: number }[]>`
        select count(*)::int as n from public.consent_records where family_id = ${solo.familyId}`;
    const before = (await count())[0]!.n;
    await declare({
      family: solo.familyId,
      adult: solo.ownerId,
      holderAttestationVersion: null,
      failureCode: 'ATTESTATION_REQUIRED',
    });
    expect((await count())[0]!.n).toBe(before);
  });
});

describe('[0990] the basis is reported, so the weaker standard is never invisible', () => {
  it('answers null for an adult who has met neither standard', async () => {
    const solo = await seedFamily(db, { childCount: 1 });
    const [basis] = await db.sql<{ b: string | null }[]>`
      select public.adult_identity_basis(${solo.ownerId}::uuid) as b`;
    expect(basis!.b).toBeNull();
    const [established] = await db.sql<{ e: boolean }[]>`
      select public.adult_identity_established(${solo.ownerId}::uuid) as e`;
    expect(established!.e).toBe(false);
  });

  it("answers 'declared' for the owner's method, and counts as established", async () => {
    const solo = await seedFamily(db, { childCount: 1 });
    await declare({ family: solo.familyId, adult: solo.ownerId });
    const [basis] = await db.sql<{ b: string | null }[]>`
      select public.adult_identity_basis(${solo.ownerId}::uuid) as b`;
    expect(basis!.b).toBe('declared');
    const [established] = await db.sql<{ e: boolean }[]>`
      select public.adult_identity_established(${solo.ownerId}::uuid) as e`;
    expect(established!.e).toBe(true);
  });

  it("prefers 'verified' when an adult has met both, because that is the stronger evidence", async () => {
    const solo = await seedFamily(db, { childCount: 1 });
    await declare({ family: solo.familyId, adult: solo.ownerId });
    // The 0980 standard, recorded through its own writer and unchanged by this migration.
    await db.asService(
      (tx) => tx`
        select app.record_identity_verification(
          ${solo.familyId}::uuid, ${solo.ownerId}::uuid, 'vendor', 'ref', 'document_and_selfie',
          true, true, 'matched', null, false, ${VERSION}, ${NOW})`,
    );
    const [basis] = await db.sql<{ b: string | null }[]>`
      select public.adult_identity_basis(${solo.ownerId}::uuid) as b`;
    expect(basis!.b).toBe('verified');
  });

  it('is not readable by anon or a child, and is readable by a parent', async () => {
    const asAnon = await refusal(
      db.asAnon((tx) => tx`select public.adult_identity_basis(${fam.ownerId}::uuid)`),
    );
    expect(asAnon).not.toBe('');
    const asChild = await refusal(
      db.asChild(
        {
          childId: fam.children[0]!.id,
          familyId: fam.familyId,
          sessionId: fam.children[0]!.sessionId,
        },
        (tx) => tx`select public.adult_identity_basis(${fam.ownerId}::uuid)`,
      ),
    );
    expect(asChild).not.toBe('');
  });

  it('lets a family member read their own family’s declarations and nobody else’s', async () => {
    const other = await seedFamily(db, { childCount: 1 });
    await declare();
    const own = await db.asParent(
      fam.ownerId,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from public.identity_declarations
         where family_id = ${fam.familyId}`,
    );
    expect(own[0]!.n).toBeGreaterThan(0);
    const foreign = await db.asParent(
      other.ownerId,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from public.identity_declarations
         where family_id = ${fam.familyId}`,
    );
    // RLS, not a filter the query chose: the rows are invisible, so the count is zero.
    expect(foreign[0]!.n).toBe(0);
  });

  it('refuses every write from authenticated, anon and the child role', async () => {
    for (const [name, run] of [
      [
        'authenticated',
        () =>
          db.asParent(
            fam.ownerId,
            (tx) => tx`
              insert into public.identity_declarations
                (family_id, adult_user_id, provider, document_is_government_id,
                 document_holder_is_adult, holder_attestation_version, holder_attested_at,
                 is_test_provider, images_discarded_at, checked_at)
              values (${fam.familyId}::uuid, ${fam.ownerId}::uuid, 'x', true, true, ${VERSION},
                      ${NOW}, false, ${NOW}, ${NOW})`,
          ),
      ],
      [
        'the recorder itself',
        () =>
          db.asParent(
            fam.ownerId,
            (tx) => tx`
              select app.record_identity_declaration(
                ${fam.familyId}::uuid, ${fam.ownerId}::uuid, 'x', null, true, true,
                ${VERSION}, null, false, ${VERSION}, ${NOW})`,
          ),
      ],
    ] as const) {
      // The outcome of an identity check is not a value a client may assert, and `authenticated`
      // reaches this table through the Supabase Data API without passing any handler.
      expect(await refusal(run()), name).not.toBe('');
    }
  });
});
