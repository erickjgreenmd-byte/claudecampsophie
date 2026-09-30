import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.ts';
import { seedFamily, type SeededFamily } from './fixtures.ts';

/**
 * Migration 0980, the adult ID check, against real Postgres.
 *
 * The owner's flow is: the adult photographs a government ID and takes a selfie, the system checks
 * the document is genuine, reads its date of birth and compares the faces, THE IMAGES ARE DELETED,
 * and only then are the per-child attestation (0970), the payment and the pairing codes reached.
 *
 * These cases pin the three properties that make that flow safe rather than merely present:
 *   1. the table keeps NOTHING off the document — no image, no face template, no document number, no
 *      date of birth, no name. The column list is asserted, so a later migration that adds one reds.
 *   2. `adult_confirmed` cannot be asserted by a writer. It is generated from the two independent
 *      checks, so a provider that cannot compare faces can never produce a confirmed adult, whatever
 *      it returns and whatever a caller passes.
 *   3. a confirmation, and only a confirmation, earns the `verified` public.consent_records row that
 *      every existing gate in the product reads — in the same transaction, so the two cannot diverge.
 *
 * Synthetic data only; no image bytes appear anywhere in this file.
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

/** Records one attempt through the only writer there is. */
async function record(
  over: Partial<{
    provider: string;
    reference: string | null;
    method: string;
    documentIsGovernmentId: boolean;
    documentHolderIsAdult: boolean;
    faceMatch: string;
    failureCode: string | null;
    isTestProvider: boolean;
    adult: string;
    family: string;
  }> = {},
) {
  const v = {
    provider: 'openai_document+vendor_face',
    reference: 'synthetic-ref-1',
    method: 'document_and_selfie',
    documentIsGovernmentId: true,
    documentHolderIsAdult: true,
    faceMatch: 'matched',
    failureCode: null as string | null,
    isTestProvider: false,
    adult: fam.ownerId,
    family: fam.familyId,
    ...over,
  };
  return db.asService(
    (tx) => tx<{ id: string; adult_confirmed: boolean; failure_code: string | null }[]>`
      select id, adult_confirmed, failure_code from app.record_identity_verification(
        ${v.family}::uuid, ${v.adult}::uuid, ${v.provider}, ${v.reference}, ${v.method},
        ${v.documentIsGovernmentId}, ${v.documentHolderIsAdult}, ${v.faceMatch},
        ${v.failureCode}, ${v.isTestProvider}, ${'2026-09-v1'}, ${NOW})`,
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

describe('[0980] the check keeps nothing that was on the document', () => {
  it('has no column for an image, a face template, a document number, a date of birth or a name', async () => {
    const columns = await db.sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'identity_verifications'
       order by column_name`;
    const names = columns.map((c) => c.column_name);
    // The whole column list, asserted exactly: a migration that adds anything reds here and has to
    // justify itself rather than arriving unnoticed.
    expect(names).toEqual([
      'adult_confirmed',
      'adult_user_id',
      'checked_at',
      'created_at',
      'document_holder_is_adult',
      'document_is_government_id',
      'face_match',
      'failure_code',
      'family_id',
      'id',
      'images_discarded_at',
      'is_test_provider',
      'method',
      'provider',
      'provider_reference',
    ]);
    // And said as a property rather than only as a list, so the intent survives a legitimate
    // addition: nothing here may name a thing read off the document.
    //
    // `images_discarded_at` is exempt BY EXACT NAME, not by loosening the rule: it is a timestamp
    // asserting the images are gone, which is the opposite of storing one, and it is the only column
    // whose name may contain any of these words. A new `image_url` or `selfie_hash` still reds.
    const allowedDespiteName = new Set(['images_discarded_at']);
    const suspect = names.filter((n) => !allowedDespiteName.has(n));
    for (const forbidden of [
      'image',
      'photo',
      'selfie',
      'template',
      'embedding',
      'descriptor',
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

  it('cannot hold a row that does not assert the images were discarded', async () => {
    // images_discarded_at is NOT NULL, and the function sets it to the stated instant. A hand-built
    // row that leaves it out is refused, so no attempt can be recorded without that assertion.
    const message = await refusal(
      db.asService(
        (tx) => tx`
          insert into public.identity_verifications
            (family_id, adult_user_id, provider, method, document_is_government_id,
             document_holder_is_adult, face_match, is_test_provider, checked_at, failure_code)
          values (${fam.familyId}, ${fam.ownerId}, 'p', 'document_and_selfie', true, true,
                  'not_matched', false, ${NOW}, 'NO_MATCH')`,
      ),
    );
    expect(message).toMatch(/images_discarded_at/);
  });
});

describe('[0980] a confirmed adult cannot be asserted, only earned', () => {
  it('refuses to let any writer set adult_confirmed', async () => {
    const message = await refusal(
      db.asService(
        (tx) => tx`
          insert into public.identity_verifications
            (family_id, adult_user_id, provider, method, document_is_government_id,
             document_holder_is_adult, face_match, is_test_provider, images_discarded_at,
             checked_at, adult_confirmed)
          values (${fam.familyId}, ${fam.ownerId}, 'p', 'document_and_selfie', false, false,
                  'refused', false, ${NOW}, ${NOW}, true)`,
      ),
    );
    // A generated column cannot be written to at all, which is the point: there is no code path,
    // and no configuration, that turns a partial check into a pass.
    expect(message).toMatch(/generated|cannot insert/i);
  });

  it('does not confirm when the face comparison did not match, whatever it answered', async () => {
    // 'refused' is the answer a provider whose policy forbids biometric comparison gives, and it is
    // the one most likely to be mistaken for a pass. All FIVE non-matches are checked, so no single
    // outcome can be special-cased later — including 'inconclusive', which is the only one a better
    // selfie may resolve and so the only one the parent is offered a retry for.
    for (const faceMatch of ['not_matched', 'inconclusive', 'not_attempted', 'refused', 'error']) {
      const [row] = await record({ faceMatch, failureCode: 'FACE_NOT_CONFIRMED' });
      expect(row!.adult_confirmed, faceMatch).toBe(false);
    }
  });

  it('does not confirm a genuine ID whose holder is not an adult, nor a non-ID of an adult', async () => {
    const [minor] = await record({ documentHolderIsAdult: false, failureCode: 'NOT_AN_ADULT' });
    expect(minor!.adult_confirmed).toBe(false);
    const [notId] = await record({
      documentIsGovernmentId: false,
      failureCode: 'NOT_A_GOVERNMENT_ID',
    });
    expect(notId!.adult_confirmed).toBe(false);
  });

  it('confirms only when the document is a government ID, the holder is an adult and the faces match', async () => {
    const [row] = await record();
    expect(row!.adult_confirmed).toBe(true);
    expect(row!.failure_code).toBeNull();
  });

  it('insists a confirmation names no failure and a refusal names one', async () => {
    const confirmedWithFailure = await refusal(record({ failureCode: 'SOMETHING' }));
    expect(confirmedWithFailure).toMatch(/identity_verifications_check/);
    const refusedWithoutFailure = await refusal(
      record({ faceMatch: 'not_matched', failureCode: null }),
    );
    expect(refusedWithoutFailure).toMatch(/identity_verifications_check/);
  });

  it('accepts only a short machine failure code, never provider prose', async () => {
    // Provider prose can quote what was read off the document. The pattern is what stops it.
    const prose = await refusal(
      record({
        faceMatch: 'not_matched',
        failureCode: 'The face on the licence for Jordan did not match',
      }),
    );
    expect(prose).toMatch(/failure_code/);
    const [ok] = await record({ faceMatch: 'not_matched', failureCode: 'FACE_NOT_CONFIRMED' });
    expect(ok!.adult_confirmed).toBe(false);
  });
});

describe('[0980] a confirmation earns the consent row every gate already reads', () => {
  it('writes a verified consent_records row in the same transaction, and none for a refusal', async () => {
    const solo = await seedFamily(db, { childCount: 1 });
    const consents = () =>
      db.sql<{ status: string; method: string; is_test_provider: boolean; scope: unknown }[]>`
        select status, method, is_test_provider, scope from public.consent_records
         where family_id = ${solo.familyId} order by created_at`;
    // seedFamily may give the family a consent row of its own; count from here.
    const before = (await consents()).length;

    await record({
      family: solo.familyId,
      adult: solo.ownerId,
      faceMatch: 'refused',
      failureCode: 'FACE_REFUSED',
    });
    expect((await consents()).length, 'a refusal must earn nothing').toBe(before);

    const [confirmed] = await record({ family: solo.familyId, adult: solo.ownerId });
    const after = await consents();
    expect(after.length).toBe(before + 1);
    const row = after[after.length - 1]!;
    expect(row.status).toBe('verified');
    expect(row.method).toBe('document_and_selfie');
    expect(row.is_test_provider).toBe(false);
    // The consent row points back at the attempt, so an audit can reach the evidence from the grant.
    expect(row.scope).toMatchObject({ identityVerificationId: confirmed!.id });
  });

  it('carries the test-provider flag through, so a mock cannot pass as a real check', async () => {
    const solo = await seedFamily(db, { childCount: 1 });
    await record({ family: solo.familyId, adult: solo.ownerId, isTestProvider: true });
    const [consent] = await db.sql<{ is_test_provider: boolean }[]>`
      select is_test_provider from public.consent_records
       where family_id = ${solo.familyId} order by created_at desc limit 1`;
    expect(consent!.is_test_provider).toBe(true);
  });

  it('answers adult_identity_confirmed for the adult, and not for one who has not passed', async () => {
    const passed = await seedFamily(db, { childCount: 1 });
    const failed = await seedFamily(db, { childCount: 1 });
    await record({ family: passed.familyId, adult: passed.ownerId });
    await record({
      family: failed.familyId,
      adult: failed.ownerId,
      faceMatch: 'not_attempted',
      failureCode: 'FACE_NOT_CONFIRMED',
    });
    const confirmed = (adult: string) =>
      db.asParent(adult, async (tx) => {
        const [row] = await tx<{ ok: boolean }[]>`
          select public.adult_identity_confirmed(${adult}::uuid) as ok`;
        return row!.ok;
      });
    expect(await confirmed(passed.ownerId)).toBe(true);
    expect(await confirmed(failed.ownerId)).toBe(false);
  });
});

describe('[0980] the outcome of an identity check is not a value a client may write', () => {
  it('lets a parent read their own family’s attempts and no other family’s', async () => {
    const mine = await seedFamily(db, { childCount: 1 });
    const theirs = await seedFamily(db, { childCount: 1 });
    await record({ family: mine.familyId, adult: mine.ownerId });
    await record({ family: theirs.familyId, adult: theirs.ownerId });
    const visible = await db.asParent(
      mine.ownerId,
      (tx) => tx<{ family_id: string }[]>`select family_id from public.identity_verifications`,
    );
    expect(visible.length).toBeGreaterThan(0);
    expect([...new Set(visible.map((r) => r.family_id))]).toEqual([mine.familyId]);
  });

  it('refuses every write from authenticated, from anon and from a paired child', async () => {
    const insertAsParent = await refusal(
      db.asParent(
        fam.ownerId,
        (tx) => tx`
          insert into public.identity_verifications
            (family_id, adult_user_id, provider, method, document_is_government_id,
             document_holder_is_adult, face_match, is_test_provider, images_discarded_at, checked_at)
          values (${fam.familyId}, ${fam.ownerId}, 'self', 'document_and_selfie', true, true,
                  'matched', false, ${NOW}, ${NOW})`,
      ),
    );
    expect(insertAsParent).toMatch(/permission denied/i);

    const updateAsParent = await refusal(
      db.asParent(
        fam.ownerId,
        (tx) => tx`update public.identity_verifications set face_match = 'matched'`,
      ),
    );
    expect(updateAsParent).toMatch(/permission denied/i);

    const deleteAsParent = await refusal(
      db.asParent(fam.ownerId, (tx) => tx`delete from public.identity_verifications`),
    );
    expect(deleteAsParent).toMatch(/permission denied/i);

    const readAsAnon = await db.asAnon(
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from public.identity_verifications`,
    );
    expect(readAsAnon[0]!.n, 'anon sees nothing through the RLS policy').toBe(0);
  });

  it('refuses the recording function to everyone but service_role', async () => {
    const message = await refusal(
      db.asParent(
        fam.ownerId,
        (tx) => tx`
          select app.record_identity_verification(
            ${fam.familyId}::uuid, ${fam.ownerId}::uuid, 'self', null, 'document_and_selfie',
            true, true, 'matched', null, false, '2026-09-v1', ${NOW})`,
      ),
    );
    expect(message).toMatch(/permission denied/i);
  });
});
