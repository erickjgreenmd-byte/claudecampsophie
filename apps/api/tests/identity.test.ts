import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import {
  IDENTITY_ATTESTATION_STATEMENT,
  type IdentityVerificationStatus,
  IDENTITY_ATTESTATION_VERSION,
  identityFailureCopy,
  identityFailureIsOurs,
} from '@pencillift/contracts';
import { createTestApi, parentToken, type TestApi } from './helpers.ts';

/**
 * POST and GET /v1/identity/verification — the adult check the owner specified: a government photo
 * ID whose own date of birth makes an adult, PLUS the holder's legal declaration that they are the
 * person on it and the child's parent or guardian. Real Postgres; synthetic adults only.
 *
 * The route is the part that did not exist. Migration 0980 built the biometric standard, a contract
 * and a provider port, and nothing ever called any of it: `grep` for the contract's importers found
 * only the contract itself. So this file also stands as the connection test — a capability built and
 * never wired is the failure L-052 names, and it had been sitting in this project for a round.
 */
/**
 * The error envelope's inner object. Defined locally because `errorOf` is not exported from
 * helpers.ts and is instead hand-rolled in at least four test files — the same one-definition smell
 * L-070 is about, in the test harness rather than in the product. Not fixed here: moving it is a
 * shared-harness change and this file is not the place to make it. Noted so it is not rediscovered.
 */
/**
 * The status response, typed. `json(res)` answers `unknown`, and vitest transpiles without
 * typechecking — so reading `body.latest.failureCode` off it passes the suite and fails `tsc` in the
 * gate. That exact trap cost this session a red gate once already.
 */
async function statusOf(res: Response): Promise<IdentityVerificationStatus> {
  return (await res.json()) as IdentityVerificationStatus;
}

async function errorOf(res: Response): Promise<Record<string, unknown>> {
  const body = (await res.json()) as { error: Record<string, unknown> };
  return body.error;
}

let api: TestApi;
let fam: SeededFamily;

const SESSION = '41111111-1111-4111-8111-111111111111';
const OTHER_SESSION = '42222222-2222-4222-8222-222222222222';

/** A 1x1 PNG. The bytes are irrelevant to the mock; what matters is that they are never stored. */
const IMAGE = {
  mimeType: 'image/png' as const,
  base64:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AL+7AAAAABJRU5ErkJggg==',
};

const ADULT_DOB = '1990-04-12';
const CHILD_DOB = '2015-04-12';

function submit(over: Record<string, unknown> = {}) {
  return {
    statedDateOfBirth: ADULT_DOB,
    document: IMAGE,
    holderAttestation: true,
    ...over,
  };
}

beforeAll(async () => {
  api = await createTestApi();
  fam = await seedFamily(api.db, { childCount: 1 });
});
afterAll(async () => {
  await api?.db.drop();
});

describe('the adult identity check is reachable at all (the route that did not exist)', () => {
  it('reports an adult who has submitted nothing as not confirmed, with no basis', async () => {
    const solo = await seedFamily(api.db, { childCount: 1 });
    const res = await api.request('/v1/identity/verification', {
      token: await parentToken(solo.ownerId, { sessionId: OTHER_SESSION }),
    });
    expect(res.status).toBe(200);
    const body = await statusOf(res);
    expect(body.confirmed).toBe(false);
    expect(body.basis).toBeNull();
    expect(body.latest).toBeNull();
    // Said rather than hidden: the stronger standard is unreachable here, which is what makes a
    // 'declared' basis an honest answer instead of a silent downgrade.
    expect(body.attestationVersionRequired).toBe(IDENTITY_ATTESTATION_VERSION);
    expect(typeof body.faceCheckAvailable).toBe('boolean');
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await api.request('/v1/identity/verification');
    expect(res.status).toBe(401);
  });
});

describe('a document plus the declaration establishes the adult', () => {
  it('confirms, reports the basis as declared, and stamps the version server-side', async () => {
    const res = await api.request('/v1/identity/verification', {
      method: 'POST',
      token: await parentToken(fam.ownerId, { sessionId: SESSION }),
      body: submit(),
    });
    expect(res.status).toBe(200);
    const body = await statusOf(res);
    expect(body.confirmed).toBe(true);
    // The basis is the point: an audit can tell this from a face-matched verification.
    expect(body.basis).toBe('declared');
    expect(body.latest!.failureCode).toBeNull();
    expect(body.latest!.holderAttestationVersion).toBe(IDENTITY_ATTESTATION_VERSION);
    // No comparison was made, and the response says so rather than leaving it to be inferred.
    expect(body.latest!.faceMatch).toBe('not_attempted');
    // The mock is labeled as one, all the way out to the response.
    expect(body.latest!.isTestProvider).toBe(true);
  });

  it('writes the verified consent row every other gate reads, carrying the basis', async () => {
    const rows = await api.db.sql<
      { status: string; method: string; scope: Record<string, unknown> }[]
    >`
      select status, method, scope from public.consent_records
       where family_id = ${fam.familyId} and adult_user_id = ${fam.ownerId}
       order by created_at desc limit 1`;
    const row = rows[0]!;
    expect(row.status).toBe('verified');
    expect(row.method).toBe('document_only');
    expect(row.scope.basis).toBe('declared');
    expect(row.scope.holderAttestationVersion).toBe(IDENTITY_ATTESTATION_VERSION);
  });

  it('stores no image and nothing read off the document', async () => {
    // The property, not a column list: the columns are pinned in the DB suite. What is checked here
    // is that the ROUTE did not find somewhere else to put the bytes.
    const rows = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
       where table_schema in ('public', 'private')
         and (column_name like '%image%' or column_name like '%selfie%'
              or column_name like '%document_number%' or column_name like '%date_of_birth%')
         -- images_discarded_at legitimately contains the word image: it asserts the images are
         -- GONE, the opposite of storing one. Exempt by EXACT NAME rather than by loosening the
         -- pattern. (No backticks in here: this is inside a tagged template, and the first draft
         -- used them and terminated the literal.)
         and column_name <> 'images_discarded_at'
         and table_name like 'identity%'`;
    expect(rows[0]!.n).toBe(0);
    // And the declaration row asserts the images are gone, which is NOT NULL in the schema.
    const discarded = await api.db.sql<{ images_discarded_at: Date | null }[]>`
      select images_discarded_at from public.identity_declarations
       where adult_user_id = ${fam.ownerId} order by checked_at desc limit 1`;
    expect(discarded[0]!.images_discarded_at).not.toBeNull();
  });

  it('refuses a second check for an adult already established, rather than billing another', async () => {
    const res = await api.request('/v1/identity/verification', {
      method: 'POST',
      token: await parentToken(fam.ownerId, { sessionId: SESSION }),
      body: submit(),
    });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).rule).toBe('IDENTITY_ALREADY_CONFIRMED');
  });
});

describe('what it refuses, and whose fault each refusal says it is', () => {
  it('establishes nothing when the document holder is not an adult', async () => {
    const solo = await seedFamily(api.db, { childCount: 1 });
    const session = '43333333-3333-4333-8333-333333333333';
    const res = await api.request('/v1/identity/verification', {
      method: 'POST',
      token: await parentToken(solo.ownerId, { sessionId: session }),
      body: submit({ statedDateOfBirth: CHILD_DOB }),
    });
    expect(res.status).toBe(200);
    const body = await statusOf(res);
    expect(body.confirmed).toBe(false);
    expect(body.basis).toBeNull();
    expect(body.latest!.failureCode).toBe('NOT_AN_ADULT');
    // The parent's to act on — and the copy names the action rather than blaming their photo.
    expect(identityFailureIsOurs('NOT_AN_ADULT')).toBe(false);
    expect(identityFailureCopy('NOT_AN_ADULT')).toMatch(/parent or legal guardian/i);
  });

  it('rejects a submission that does not affirm the declaration, before any provider call', async () => {
    const solo = await seedFamily(api.db, { childCount: 1 });
    const session = '44444444-4444-4444-8444-444444444444';
    const res = await api.request('/v1/identity/verification', {
      method: 'POST',
      token: await parentToken(solo.ownerId, { sessionId: session }),
      body: submit({ holderAttestation: false }),
    });
    // `z.literal(true)` in the contract: `false` and the field's absence are the same refusal, and
    // neither can be mistaken for consent. Rejected at the schema, so no licence is ever sent.
    expect(res.status).toBe(400);
    const established = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from public.identity_declarations
       where adult_user_id = ${solo.ownerId}`;
    expect(established[0]!.n).toBe(0);
  });

  it('rejects a submission carrying a selfie, because nothing compares one', async () => {
    const solo = await seedFamily(api.db, { childCount: 1 });
    const session = '45555555-5555-4555-8555-555555555555';
    const res = await api.request('/v1/identity/verification', {
      method: 'POST',
      token: await parentToken(solo.ownerId, { sessionId: session }),
      body: { ...submit(), selfie: IMAGE },
    });
    // The request schema is strict. Collecting a face photo nothing uses would carry the biometric
    // exposure without the verification, so the shape refuses it rather than silently ignoring it.
    expect(res.status).toBe(400);
  });

  it('names OUR side, not the parent, when no provider is configured at all', async () => {
    const bare = await createTestApi();
    try {
      // The deployment forgot to configure a provider. A missing credential is a blocker, never a
      // pass: the check refuses, and the refusal says whose problem it is.
      (bare.providers as { identity?: unknown }).identity = undefined;
      const solo = await seedFamily(bare.db, { childCount: 1 });
      const res = await bare.request('/v1/identity/verification', {
        method: 'POST',
        token: await parentToken(solo.ownerId, {
          sessionId: '46666666-6666-4666-8666-666666666666',
        }),
        body: submit(),
      });
      expect(res.status).toBe(200);
      const body = await statusOf(res);
      expect(body.confirmed).toBe(false);
      expect(body.latest!.failureCode).toBe('PROVIDER_UNAVAILABLE');
      expect(identityFailureIsOurs('PROVIDER_UNAVAILABLE')).toBe(true);
      expect(identityFailureCopy('PROVIDER_UNAVAILABLE')).toMatch(/on us, not you/i);
      // And it names the DOCUMENT read as the missing piece, not the face check — different missing
      // pieces, and a parent told the wrong one waits for something that was never the problem.
      expect(identityFailureCopy('PROVIDER_UNAVAILABLE')).not.toMatch(/face/i);
    } finally {
      await bare.db.drop();
    }
  });
});

describe('the cost claim in docs/Cost_Analysis.md is true of this route', () => {
  // Not `async`: this case reads the source synchronously and awaits nothing, which
  // `@typescript-eslint/require-await` refuses. It shipped as `async` in e5c74d2 because I ran vitest
  // and prettier over that edit and NOT eslint, then read the wrapper's exit code instead of the
  // gate's own GATE_EXIT line and pushed a commit the gate had rejected.
  it('sends no selfie, so the identity_face_compare stage is never entered', () => {
    // docs/Cost_Analysis.md states that one provider call happens per verification and that the
    // 15,000-micro `identity_face_compare` stage is never spent — a 43% reduction in the worst case
    // of establishing an adult. That is a claim about THIS route, so it is asserted here rather than
    // left as prose in a document (the round-7 cost-doc work found the document understating the
    // largest hold by 93% precisely because nothing related the two).
    //
    // Two independent facts establish it, and both are checked: the request schema has no `selfie`
    // (a strict object, so sending one is a 400 — asserted above), and the route's own source passes
    // no selfie to the provider. The ADAPTER's behaviour with an absent selfie is
    // `identity-openai.ts`'s to test; what is this file's business is that the route never supplies
    // one.
    const source = readFileSync(
      join(import.meta.dirname, '..', 'src', 'routes', 'identity.ts'),
      'utf8',
    );
    const call = /provider\.check\(\{([\s\S]*?)\}\)/.exec(source);
    expect(
      call,
      'the route no longer calls provider.check the way this test expects',
    ).not.toBeNull();
    expect(call![1]).toMatch(/document:/);
    expect(call![1]).toMatch(/statedDateOfBirth:/);
    expect(call![1]).not.toMatch(/selfie/);
  });
});

describe('the declaration wording is one definition, shared', () => {
  it('is a statement about the document, the child AND its own legal weight', () => {
    // All three, because the third is what gives the first two consequence. This is the only thing
    // standing between "an adult exists" and "this adult is the one submitting".
    expect(IDENTITY_ATTESTATION_STATEMENT).toMatch(/person shown on this document/i);
    expect(IDENTITY_ATTESTATION_STATEMENT).toMatch(/parent or legal guardian/i);
    expect(IDENTITY_ATTESTATION_STATEMENT).toMatch(/legal declaration/i);
    expect(IDENTITY_ATTESTATION_STATEMENT).toMatch(/18 years old/);
  });

  it('carries a version, so a later wording does not re-characterise what an adult agreed to', () => {
    expect(IDENTITY_ATTESTATION_VERSION).toMatch(/^\d{4}-\d{2}-v\d+$/);
  });
});
