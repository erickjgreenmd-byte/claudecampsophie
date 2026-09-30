import { Hono } from 'hono';
import {
  CONSENT_POLICY_VERSION,
  IDENTITY_ATTESTATION_VERSION,
  submitIdentityVerificationRequestSchema,
  type IdentityVerificationStatus,
} from '@pencillift/contracts';
import { readJson } from '../app.ts';
import { ApiError } from '../errors.ts';
import { currentFamilyId, requireParent } from '../middleware/auth.ts';
import type { AppEnv } from '../middleware/context.ts';
import { enforceRateLimit, RATE_RULES } from '../middleware/rate-limit.ts';

/**
 * The adult identity check (spec P3, COPPA 16 CFR 312.5).
 *
 * THE OWNER'S STANDARD, and it is the weaker of the two the database knows about. Migration 0990's
 * header is the full reasoning; in short: the adult photographs a government photo ID, the model
 * answers only "is this a government ID" and "does its date of birth make an adult", and the adult
 * makes a legal DECLARATION that they are the person shown on it and the child's parent or guardian.
 * The declaration is what binds the document to the person. The stronger standard — the same document
 * checks plus a face comparison — lives in `identity_verifications` and is unreachable until a vendor
 * is contracted (owner action #47), so this route does not attempt it and does not pretend to.
 *
 * WHAT THIS ROUTE MUST NEVER DO, each for a reason this project has already paid for:
 *   * store an image, or anything read off the document. The images live in this request body and in
 *     the provider call, and nothing else. `app.record_identity_declaration` has no column for one
 *     and its NOT NULL `images_discarded_at` asserts they are gone.
 *   * decide the outcome itself. `adult_declared` is a GENERATED column: this route reports the
 *     provider's two answers and whether the declaration was made, and the database composes them.
 *   * take the declaration's VERSION from the client. The client affirms; the server stamps
 *     `IDENTITY_ATTESTATION_VERSION`, so a row always records the wording the adult actually saw
 *     (L-060: the compliance fact belongs in the database, and the version with it).
 *   * re-run a check for an adult who has already met either standard. That would bill a provider
 *     call for nothing and, worse, invite a second answer that disagrees with the first.
 */
export function identityRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireParent);

  /** The adult's own state: whether they may proceed, and on what evidence. */
  r.get('/verification', async (c) => {
    const { deps, parent } = c.var;
    return c.json(await statusFor(c, deps, parent.userId));
  });

  r.post('/verification', async (c) => {
    const { deps, parent } = c.var;
    const familyId = await currentFamilyId(c);
    const body = await readJson(c, submitIdentityVerificationRequestSchema);
    const now = deps.clock();

    // Already established, by EITHER standard: refuse rather than re-run. `adult_identity_basis`
    // is the single reader of both tables, so this cannot drift from what the gates elsewhere ask.
    const basisRows = await deps.db.asService(
      (tx) => tx<{ basis: string | null }[]>`
        select public.adult_identity_basis(${parent.userId}) as basis`,
    );
    // A one-row function result, but read defensively rather than destructured: the function is
    // `security definer` and a revoked grant would return no rows, and "no rows" must not read as
    // "already established" (it is the opposite).
    if ((basisRows[0]?.basis ?? null) !== null) {
      throw new ApiError('BUSINESS_RULE', 'Your ID is already verified.', {
        rule: 'IDENTITY_ALREADY_CONFIRMED',
      });
    }

    // Per ADULT, not per family: the cost of this is a provider call, and an adult who is invited to
    // a second family must not get a second budget of attempts.
    await enforceRateLimit(
      deps.rateLimiter,
      `identity-check:${parent.userId}`,
      RATE_RULES.identityCheckPerUser,
      now,
    );

    const provider = deps.providers.identity;
    if (provider === undefined) {
      // A missing provider is a BLOCKER, never a pass (CLAUDE.md). It is also not the parent's
      // fault, so it is recorded as a refusal with a code whose copy says so, rather than thrown:
      // the adult's screen then reads the same way as any other refusal and support can see it.
      return c.json(
        await recordAndRead(c, familyId, parent.userId, {
          provider: 'unconfigured',
          providerReference: null,
          documentIsGovernmentId: false,
          documentHolderIsAdult: false,
          attested: false,
          failureCode: 'PROVIDER_UNAVAILABLE',
          isTestProvider: false,
          now,
        }),
        200,
      );
    }

    // NO SELFIE is sent, because nothing compares it: collecting a face photo for no purpose would
    // carry the biometric exposure without the verification. The provider therefore answers
    // 'not_attempted' for the comparison and makes one round trip instead of two.
    const result = await provider.check({
      document: body.document,
      statedDateOfBirth: body.statedDateOfBirth,
      now,
    });

    // The declaration is a separate input from the document checks, and the DATABASE composes them.
    // `holderAttestation` is a `z.literal(true)`, so reaching here means it was affirmed — but the
    // recorded outcome still depends on the document, which is why this is not an early return.
    const attested = body.holderAttestation;
    return c.json(
      await recordAndRead(c, familyId, parent.userId, {
        provider: provider.name,
        providerReference: result.providerReference,
        documentIsGovernmentId: result.documentIsGovernmentId,
        documentHolderIsAdult: result.documentHolderIsAdult,
        attested,
        // The provider's own refusal wins when it has one; otherwise a document that passed both
        // checks with no declaration is refused for the declaration. A row must say why (0990's
        // `identity_declarations_unestablished_says_why`), and only one code fits in the column.
        failureCode:
          result.failureCode ??
          (result.documentIsGovernmentId && result.documentHolderIsAdult && !attested
            ? 'ATTESTATION_REQUIRED'
            : null),
        isTestProvider: provider.isMock,
        now,
      }),
      200,
    );
  });

  return r;
}

/** The failure-code type the status contract carries, named so the cast above stays readable. */
type LatestFailureCode = NonNullable<IdentityVerificationStatus['latest']>['failureCode'];

interface Recorded {
  readonly provider: string;
  readonly providerReference: string | null;
  readonly documentIsGovernmentId: boolean;
  readonly documentHolderIsAdult: boolean;
  readonly attested: boolean;
  readonly failureCode: string | null;
  readonly isTestProvider: boolean;
  readonly now: Date;
}

/**
 * Records the submission and reads the adult's state back, so the response is what the DATABASE
 * decided rather than what this route expected. The two could differ — the generated column is the
 * authority — and a response built from the route's own expectation would hide that.
 */
async function recordAndRead(
  c: Parameters<typeof currentFamilyId>[0],
  familyId: string,
  adultUserId: string,
  r: Recorded,
): Promise<IdentityVerificationStatus> {
  const { deps } = c.var;
  await deps.db.asService(
    (tx) => tx`
      select app.record_identity_declaration(
        ${familyId}, ${adultUserId}, ${r.provider}, ${r.providerReference},
        ${r.documentIsGovernmentId}, ${r.documentHolderIsAdult},
        ${r.attested ? IDENTITY_ATTESTATION_VERSION : null},
        ${r.failureCode}, ${r.isTestProvider}, ${CONSENT_POLICY_VERSION}, ${r.now})`,
  );
  deps.log({
    level: r.failureCode === null ? 'info' : 'warn',
    event: 'identity_declaration',
    code: r.failureCode ?? 'ESTABLISHED',
  });
  return statusFor(c, deps, adultUserId);
}

/** The adult's state: may they proceed, on what evidence, and what the last submission answered. */
async function statusFor(
  c: Parameters<typeof currentFamilyId>[0],
  deps: (typeof c.var)['deps'],
  adultUserId: string,
): Promise<IdentityVerificationStatus> {
  const basisRows = await deps.db.asService(
    (tx) => tx<{ basis: string | null }[]>`
      select public.adult_identity_basis(${adultUserId}) as basis`,
  );
  const basis = basisRows[0]?.basis ?? null;
  const latest = await deps.db.asService(
    (tx) => tx<
      {
        id: string;
        checked_at: Date;
        provider: string;
        document_is_government_id: boolean;
        document_holder_is_adult: boolean;
        holder_attestation_version: string | null;
        failure_code: string | null;
        is_test_provider: boolean;
      }[]
    >`
      select id, checked_at, provider, document_is_government_id, document_holder_is_adult,
             holder_attestation_version, failure_code, is_test_provider
        from public.identity_declarations
       where adult_user_id = ${adultUserId}
       order by checked_at desc limit 1`,
  );
  const row = latest[0];
  return {
    confirmed: basis !== null,
    basis: basis === 'verified' || basis === 'declared' ? basis : null,
    latest:
      row === undefined
        ? null
        : {
            id: row.id,
            checkedAt: row.checked_at.toISOString(),
            provider: row.provider,
            documentIsGovernmentId: row.document_is_government_id,
            documentHolderIsAdult: row.document_holder_is_adult,
            // Always 'not_attempted' for this standard. Reported rather than omitted so a reader of
            // the response can see that no comparison was made, instead of having to infer it.
            faceMatch: 'not_attempted',
            holderAttestationVersion: row.holder_attestation_version,
            failureCode: row.failure_code as LatestFailureCode,
            isTestProvider: row.is_test_provider,
          },
    attestationVersionRequired: IDENTITY_ATTESTATION_VERSION,
    // Whether the STRONGER standard could be met here. False today, and said rather than hidden:
    // it is what makes `basis: 'declared'` an honest answer instead of a silent downgrade.
    faceCheckAvailable: deps.providers.identity?.canCompareFaces ?? false,
  };
}
