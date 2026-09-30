// Contracts for the adult identity check that gates every child code (migration 0980; spec P3
// verifiable parental consent, AC_ACCESS_01/02). Owned by the identity vertical.
//
// The owner's flow: the adult photographs a government photo ID and takes a selfie, the server checks
// the document is genuine and reads its date of birth, a face comparison checks the selfie is the same
// person, THE IMAGES ARE DISCARDED, and only then can the adult add children (each with its own
// parent/guardian attestation, see family.ts), pay, and receive one pairing code per child.
//
// Requests are strict, so no client can smuggle in the outcome it wants: `confirmed`, the provider
// name and the instant are all the server's (routes/identity.ts, app.record_identity_verification).
import { z } from 'zod';
import { calendarDateSchema, isoDateTimeSchema, uuidSchema } from './common.ts';

/**
 * The largest image the check accepts, per image, DECODED. A phone photo of a licence is well under
 * this; the cap exists because these bytes travel in the request body rather than to storage — which
 * is the whole point, since an object in storage is an object that can be forgotten there.
 */
export const IDENTITY_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The image types the check accepts: the same two `imagePart` in @pencillift/ai accepts, so there is one
 * answer in the product to "which image types do we send the model" rather than two that can drift.
 * HEIC is excluded because the model cannot read it and no server-side transcode step exists, so
 * accepting it would fail in a way the parent cannot act on — iOS hands a JPEG to a file input anyway.
 */
export const IDENTITY_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png'] as const;
export type IdentityImageMimeType = (typeof IDENTITY_IMAGE_MIME_TYPES)[number];

/** The minimum age the document's own date of birth has to establish. */
export const ADULT_MIN_AGE_YEARS = 18;

/**
 * One captured image, as a base64 data URL — the same shape the homework scan path already hands the
 * vision model, so there is one image encoding in the product rather than two.
 */
export const identityImageSchema = z.strictObject({
  mimeType: z.enum(IDENTITY_IMAGE_MIME_TYPES),
  /**
   * Base64 WITHOUT a `data:` prefix. The server builds the data URL, so a client cannot declare one
   * mime type in `mimeType` and a different one inside the URL.
   */
  base64: z
    .string()
    .min(1)
    .max(Math.ceil((IDENTITY_IMAGE_MAX_BYTES * 4) / 3) + 4)
    .regex(
      /^[A-Za-z0-9+/]+={0,2}$/,
      'Send standard base64 with no data URL prefix and no newlines',
    ),
});
export type IdentityImage = z.infer<typeof identityImageSchema>;

/**
 * The declaration the adult makes, which is what binds the document to the person holding the phone.
 *
 * OWNER DECISION (2026-09-30): the licence establishes that an ADULT exists and consents; this
 * statement binds that adult to the act. The face comparison used to do the binding and cannot: it is
 * biometric identification, which no provider PencilLift can reach will perform, so `adult_confirmed`
 * was unsatisfiable and every adult failed closed (migration 0990's header has the full reasoning).
 *
 * WHAT THIS IS NOT. It is not the FTC-approved ID method. 16 CFR 312.5(b)(2)(v) approves checking a
 * government ID against DATABASES of such information; a vision model reading a licence checks it
 * against nothing and cannot tell whose hand is holding the phone. Two things narrow that gap and
 * neither closes it: `statedDateOfBirth` is checked against the document (DOB_MISMATCH), so the
 * submitter has to know the document holder's birth date; and this declaration carries the legal
 * consequence of a false statement. docs/Threat_Model.md T41 states the residual, and owner action
 * #48 carries the one question counsel must answer for the method to be sufficient.
 *
 * The version is stamped SERVER-side, never taken from the client, and travels onto the consent row —
 * so a later wording is a new version and existing rows keep the words their adult actually agreed
 * to. The client asserts the declaration; it does not get to choose which declaration it made (L-060).
 */
export const IDENTITY_ATTESTATION_VERSION = '2026-09-v1';

/**
 * Counsel approves this wording under owner action #48; until they do it is the draft the product
 * ships behind the same legal-review gate as the public pages. It says three things on purpose: who
 * the adult is relative to the document, who they are relative to the child, and that this is a legal
 * declaration — the third is what gives the first two consequence.
 */
export const IDENTITY_ATTESTATION_STATEMENT =
  'I am the person shown on this document, I am at least 18 years old, and I am this child’s ' +
  'parent or legal guardian. I understand this is a legal declaration.';

/** What a surface says when the declaration is not made. One wording for the portal and the app. */
export const IDENTITY_ATTESTATION_REQUIRED_COPY =
  'Please confirm the statement above before submitting your ID.';

/**
 * POST /v1/identity/verification. The adult's own stated date of birth is required and is CHECKED
 * AGAINST the document rather than trusted: a mismatch is a refusal (DOB_MISMATCH), which is the one
 * cheap signal that the document belongs to someone else. Neither date is stored.
 *
 * No selfie, since 0990: nothing compares it to anything, and an image PencilLift cannot use is an
 * image it should not ask a parent to send — collecting a face photo for no purpose is the worst of
 * both worlds, carrying the biometric exposure without the verification.
 */
export const submitIdentityVerificationRequestSchema = z.strictObject({
  statedDateOfBirth: calendarDateSchema,
  document: identityImageSchema,
  /**
   * The adult affirms `IDENTITY_ATTESTATION_STATEMENT`. A literal `true` rather than a boolean: the
   * absence of the field and a `false` are the same refusal, and neither can be mistaken for consent.
   * The DATABASE is what actually enforces it — `adult_confirmed` is generated and requires the
   * stamped version — because `authenticated` reaches these tables through the Data API and would
   * otherwise find the requirement optional (L-060).
   */
  holderAttestation: z.literal(true),
});
export type SubmitIdentityVerificationRequest = z.infer<
  typeof submitIdentityVerificationRequestSchema
>;

/**
 * Why a check did not confirm. These are the codes the SERVER may return; the copy for each is below.
 * `PROVIDER_ERROR` and `FACE_CHECK_UNAVAILABLE` are ours, not the parent's fault, and their copy says
 * so — the project has filed blame-the-parent copy three times (HUNT7-I-3 and its predecessors).
 */
export const IDENTITY_FAILURE_CODES = [
  'NOT_A_GOVERNMENT_ID',
  'DOCUMENT_UNREADABLE',
  'DOCUMENT_EXPIRED',
  'NOT_AN_ADULT',
  'DOB_MISMATCH',
  'FACE_NOT_CONFIRMED',
  'FACE_CHECK_UNAVAILABLE',
  'PROVIDER_ERROR',
] as const;
export type IdentityFailureCode = (typeof IDENTITY_FAILURE_CODES)[number];

/**
 * What the parent is told, and what they can do about it. Two properties this map must keep:
 *   1. every line names an ACTION, or says plainly that the action is ours;
 *   2. an unknown code — one a provider adds, or a future method introduces — falls through to a line
 *      that is honest rather than to the nearest enumerated guess. `identityFailureCopy` below is the
 *      only reader, and it handles the fall-through (L-057: fix the fall-through, not the cases).
 */
const IDENTITY_FAILURE_COPY: Readonly<Record<IdentityFailureCode, string>> = {
  NOT_A_GOVERNMENT_ID:
    'That photo didn’t read as a government photo ID. Use a driver’s licence, state ID card or passport, and photograph the side with your photo and date of birth.',
  DOCUMENT_UNREADABLE:
    'We couldn’t read the ID clearly. Lay it flat, fill the frame, and avoid glare and shadows.',
  DOCUMENT_EXPIRED: 'That ID has expired. Use one that is still in date.',
  NOT_AN_ADULT: `The date of birth on that ID is under ${ADULT_MIN_AGE_YEARS}. A parent or legal guardian aged ${ADULT_MIN_AGE_YEARS} or over has to set up the account.`,
  DOB_MISMATCH:
    'The date of birth on the ID doesn’t match the one you entered. Check what you typed, or use the ID that belongs to you.',
  FACE_NOT_CONFIRMED:
    'We couldn’t confirm the selfie shows the person on the ID. Take the selfie in good light, facing the camera, with nothing covering your face.',
  FACE_CHECK_UNAVAILABLE:
    'We can’t run the face check on your account yet, so we can’t finish setting it up. This is on us, not you — support can complete the check for you.',
  PROVIDER_ERROR:
    'Something went wrong on our side while checking your ID. Nothing was saved. Please try again.',
};

/** The line for an unknown or absent code: honest, and never blaming the parent's photos. */
export const IDENTITY_FAILURE_FALLBACK =
  'We couldn’t complete the ID check, and we can’t tell you why from here. Nothing was saved. Support can finish the check for you.';

/**
 * The parent-facing line for a refusal. A code this build does not know about gets
 * `IDENTITY_FAILURE_FALLBACK` rather than the nearest guess, because a wrong remedy costs the parent a
 * retry that cannot succeed.
 */
export function identityFailureCopy(code: string | null | undefined): string {
  if (code === null || code === undefined) return IDENTITY_FAILURE_FALLBACK;
  return IDENTITY_FAILURE_COPY[code as IdentityFailureCode] ?? IDENTITY_FAILURE_FALLBACK;
}

/** Whether a refusal is the parent's to act on, or ours. Drives whether a retry is offered at all. */
export function identityFailureIsOurs(code: string | null | undefined): boolean {
  return (
    code === 'FACE_CHECK_UNAVAILABLE' ||
    code === 'PROVIDER_ERROR' ||
    code === null ||
    code === undefined ||
    !IDENTITY_FAILURE_CODES.includes(code as IdentityFailureCode)
  );
}

/**
 * The comparison's outcome. Five of the six are not a pass and each says a different thing; only
 * 'inconclusive' and 'not_matched' are the parent's to act on (see `identityFailureIsOurs`). Migration
 * 0980's check constraint carries the same six with the reason for each.
 */
export const identityFaceMatchSchema = z.enum([
  'matched',
  'not_matched',
  'inconclusive',
  'not_attempted',
  'refused',
  'error',
]);
export type IdentityFaceMatch = z.infer<typeof identityFaceMatchSchema>;

/** GET /v1/identity/verification, and the POST's own answer. */
export const identityVerificationStatusSchema = z.strictObject({
  /**
   * True only when the document was a government photo ID, its own date of birth put the holder at or
   * over `ADULT_MIN_AGE_YEARS`, AND the holder made the declaration. Generated in the database, so no
   * writer can assert it (migration 0990).
   */
  confirmed: z.boolean(),
  /**
   * WHICH standard this adult met, so the weaker basis is never invisible: 'verified' is the
   * biometric standard (`identity_verifications.adult_confirmed`), 'declared' is the document plus
   * the holder's legal declaration (`identity_declarations.adult_declared`, migration 0990, the
   * owner's method), and null is neither. `confirmed` above is true for both — it answers "may this
   * adult proceed"; this answers "on what evidence", which is the question an audit asks and the one
   * that says whose adults would need re-verifying if counsel requires the stronger standard.
   */
  basis: z.enum(['verified', 'declared']).nullable(),
  /** The most recent attempt, or null when the adult has never submitted one. */
  latest: z
    .strictObject({
      id: uuidSchema,
      checkedAt: isoDateTimeSchema,
      provider: z.string().min(1).max(120),
      documentIsGovernmentId: z.boolean(),
      documentHolderIsAdult: z.boolean(),
      /**
       * Recorded, never gating, since 0990: 'not_attempted' is the ordinary value because PencilLift
       * stopped asking. Kept because it is the evidence that the question WAS asked and refused,
       * which is the record justifying the owner's method.
       */
      faceMatch: identityFaceMatchSchema,
      /** The declaration's version, or null when none was made — which cannot confirm. */
      holderAttestationVersion: z.string().min(1).max(40).nullable(),
      /** Null on a confirmation. */
      failureCode: z.enum(IDENTITY_FAILURE_CODES).nullable(),
      /** True when a development double ran the check. Never true in production. */
      isTestProvider: z.boolean(),
    })
    .nullable(),
  /**
   * The declaration version a client must show and affirm. A literal, so a client cannot submit an
   * affirmation of some other wording: the version it agreed to is the version the server stamps.
   *
   * (An earlier draft of this docblock said `faceCheckAvailable` had been REMOVED here. It had not —
   * I restored it two edits later, and left the claim standing. Recorded rather than quietly
   * deleted, because a comment asserting something about code that is not true is the exact defect
   * class this round spent four stages hunting, and I wrote one inside the fix for it.)
   */
  attestationVersionRequired: z.literal(IDENTITY_ATTESTATION_VERSION),
  /**
   * Whether the stronger biometric standard can be met at all in this deployment. False today, and
   * stated rather than hidden: it is what makes `basis: 'declared'` an honest answer instead of a
   * silent downgrade. When a vendor is contracted (owner action #47) this turns true and new adults
   * meet the stronger standard without any client change.
   */
  faceCheckAvailable: z.boolean(),
});
export type IdentityVerificationStatus = z.infer<typeof identityVerificationStatusSchema>;

/** Stable `rule` codes the identity route returns with 422. */
export const IDENTITY_RULES = {
  /** A confirmed adult already exists; re-checking is refused rather than run and billed again. */
  alreadyConfirmed: 'IDENTITY_ALREADY_CONFIRMED',
  /** The adult must be verified before children, payment or codes (the owner's ordering). */
  identityRequired: 'IDENTITY_REQUIRED',
} as const;

/**
 * The sentence for the ordering rule.
 *
 * ITS DOCBLOCK USED TO CLAIM “the portal, the app and the API all say the same thing about the same
 * rule (L-037)”. That was FALSE and it was mine: nothing imported this constant — not the portal, not
 * the app, not the API. The round-7 parity audit found it among six such claims, and it is exactly the
 * species of claim that produced the round's largest finding, written by the person who had just spent
 * a stage hunting it. What is true is stated instead: this is the ONE definition, and it is shared the
 * moment a surface imports it. A test that asserts an importer set is the only thing that could make
 * the stronger claim, and there is not one.
 */
export const IDENTITY_REQUIRED_COPY =
  'Verify your ID first. We check a government photo ID once, to confirm an adult is setting this up, and the photo is deleted straight after the check.';
