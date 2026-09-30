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
 * POST /v1/identity/verification. The adult's own stated date of birth is required and is CHECKED
 * AGAINST the document rather than trusted: a mismatch is a refusal (DOB_MISMATCH), which is the one
 * cheap signal that the document belongs to someone else. Neither date is stored.
 */
export const submitIdentityVerificationRequestSchema = z.strictObject({
  statedDateOfBirth: calendarDateSchema,
  document: identityImageSchema,
  selfie: identityImageSchema,
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
  /** True only when a government ID, an adult date of birth and a face match all held. */
  confirmed: z.boolean(),
  /** The most recent attempt, or null when the adult has never submitted one. */
  latest: z
    .strictObject({
      id: uuidSchema,
      checkedAt: isoDateTimeSchema,
      provider: z.string().min(1).max(120),
      documentIsGovernmentId: z.boolean(),
      documentHolderIsAdult: z.boolean(),
      faceMatch: identityFaceMatchSchema,
      /** Null on a confirmation. */
      failureCode: z.enum(IDENTITY_FAILURE_CODES).nullable(),
      /** True when a development double ran the check. Never true in production. */
      isTestProvider: z.boolean(),
    })
    .nullable(),
  /**
   * Whether the configured provider can compare faces at all. False makes the flow honest about why
   * it cannot finish, instead of letting a parent retry a photo that was never the problem.
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
 * The sentence the product uses wherever the ordering is enforced, so the portal, the app and the API
 * all say the same thing about the same rule (L-037).
 */
export const IDENTITY_REQUIRED_COPY =
  'Verify your ID first. We check a government photo ID and a selfie once, to confirm an adult is setting this up, and the photos are deleted straight after the check.';
