import {
  ADULT_MIN_AGE_YEARS,
  type IdentityFaceMatch,
  type IdentityFailureCode,
  type IdentityImage,
} from '@pencillift/contracts';

/**
 * The adult identity check behind migration 0980 and POST /v1/identity/verification.
 *
 * TWO INDEPENDENT CLAIMS, deliberately separate on this interface, because they are established by
 * different means and one of them is much harder to get:
 *
 *   * ADULTHOOD — read off a government photo ID. A vision model does this well: is this a genuine
 *     government document, what is its date of birth, has it expired. This is document reading.
 *   * SAME PERSON — a comparison between the portrait on that document and a live selfie. This is
 *     BIOMETRIC IDENTIFICATION. OpenAI's usage policies prohibit it and their vision models refuse the
 *     question, so the OpenAI adapter answers `refused` and cannot ever produce a confirmed adult.
 *     A dedicated identity vendor (the FTC approved face-match-to-photo-ID as a COPPA method in 2023,
 *     and vendors implement it with liveness detection and human review) answers `matched`.
 *
 * Nothing here decides whether the adult is confirmed. `adult_confirmed` is a GENERATED column in
 * migration 0980 — `document_is_government_id and document_holder_is_adult and face_match = 'matched'`
 * — so a provider that returns a partial result cannot be read as a pass by any caller, present or
 * future, and there is no configuration that changes that.
 *
 * THE IMAGES DO NOT PERSIST. They arrive in the request body, are handed to this provider, and are
 * released when the call returns. No adapter may write them to storage, to the database, or to a log,
 * and none may return them. `apps/api/tests/identity.test.ts` proves the route touches no storage and
 * that no row holds any image bytes.
 */
export interface IdentityProvider {
  readonly name: string;
  readonly isMock: boolean;
  /**
   * Whether this provider can compare a face to a document portrait at all. False is not a failure —
   * it is the honest state of a deployment with no biometric vendor configured, and it lets the
   * product tell the parent the check cannot finish rather than blaming their selfie.
   */
  readonly canCompareFaces: boolean;
  check(input: IdentityCheckInput): Promise<IdentityCheckResult>;
}

export interface IdentityCheckInput {
  /** A government photo ID, as captured. Released when the call returns. */
  readonly document: IdentityImage;
  /** A selfie, as captured. Released when the call returns. */
  readonly selfie: IdentityImage;
  /** The date the adult typed, `YYYY-MM-DD`, for cross-checking against the document. */
  readonly statedDateOfBirth: string;
  /** The application's clock. Expiry and age are judged against this, never against a wall clock. */
  readonly now: Date;
}

/**
 * What a provider answers. Note what is ABSENT: no date of birth, no name, no document number, no
 * face template, no image. The result carries the two booleans and the comparison outcome, which is
 * all migration 0980 stores.
 */
export interface IdentityCheckResult {
  readonly documentIsGovernmentId: boolean;
  readonly documentHolderIsAdult: boolean;
  readonly faceMatch: IdentityFaceMatch;
  /** Null only when all three checks passed. */
  readonly failureCode: IdentityFailureCode | null;
  /** The provider's own reference for this attempt, for an audit. Never a value read off the document. */
  readonly providerReference: string | null;
}

/**
 * Whether a date of birth makes an adult at `now`, in whole years, with no time zone subtlety: the
 * document carries a calendar date and the answer must not flip with the server's zone.
 */
export function isAdultOn(dateOfBirth: string, now: Date): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (!m) return false;
  const [, y, mo, d] = m;
  const born = { y: Number(y), m: Number(mo), d: Number(d) };
  const today = {
    y: now.getUTCFullYear(),
    m: now.getUTCMonth() + 1,
    d: now.getUTCDate(),
  };
  let age = today.y - born.y;
  if (today.m < born.m || (today.m === born.m && today.d < born.d)) age -= 1;
  return age >= ADULT_MIN_AGE_YEARS;
}

/**
 * The development double. It is a LABELED MOCK: every row it produces carries
 * `is_test_provider = true`, and `productionReadiness` blocks while it is the configured provider, so
 * it can never stand in for a real check in front of a real family (CLAUDE.md: mocks are labeled
 * mocks; a missing credential is a blocker, never a passing test).
 *
 * It confirms, so the whole flow — verify, add children with their attestations, pay, issue codes —
 * is exercisable end to end in development and in tests without sending anyone's licence anywhere.
 * The one thing it will not do is confirm an under-age stated date of birth, because a mock that
 * ignores its input teaches the tests nothing.
 */
export function createDevelopmentIdentityMock(): IdentityProvider {
  return {
    name: 'development_mock',
    isMock: true,
    canCompareFaces: true,
    check: (input) =>
      Promise.resolve(
        isAdultOn(input.statedDateOfBirth, input.now)
          ? {
              documentIsGovernmentId: true,
              documentHolderIsAdult: true,
              faceMatch: 'matched' as const,
              failureCode: null,
              providerReference: 'mock-identity',
            }
          : {
              documentIsGovernmentId: true,
              documentHolderIsAdult: false,
              faceMatch: 'matched' as const,
              failureCode: 'NOT_AN_ADULT' as const,
              providerReference: 'mock-identity',
            },
      ),
  };
}

/**
 * The provider used when nothing is configured. It is NOT a mock and it does not pretend: it refuses
 * every check with `FACE_CHECK_UNAVAILABLE`, so a deployment that forgot to configure a provider fails
 * closed and says which side the problem is on. A missing credential is a blocker, never a pass.
 */
export function createUnconfiguredIdentityProvider(): IdentityProvider {
  return {
    name: 'unconfigured',
    isMock: false,
    canCompareFaces: false,
    check: () =>
      Promise.resolve({
        documentIsGovernmentId: false,
        documentHolderIsAdult: false,
        faceMatch: 'not_attempted' as const,
        failureCode: 'FACE_CHECK_UNAVAILABLE' as const,
        providerReference: null,
      }),
  };
}
