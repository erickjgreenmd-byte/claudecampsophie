// Contracts for the adult identity check that gates every child code (spec P3 verifiable parental
// consent, AC_ACCESS_01/02). Owned by the identity vertical.
//
// TWO STANDARDS, and this file words both. The STRONGER one (migration 0980, `identity_verifications`,
// basis 'verified') reads a government photo ID and compares a selfie with the photo on it. The one
// that SHIPS (migration 0990, `identity_declarations`, basis 'declared') reads the same document and
// takes the holder's legal declaration in place of that comparison, because the comparison is
// biometric identification and no provider PencilLift can reach will perform it — see
// `IDENTITY_ATTESTATION_STATEMENT` below for the owner decision and what it does and does not close.
//
// Either way: the server reads the document, checks its date of birth against the one the adult
// typed, THE IMAGES ARE DISCARDED, and only then can the adult add children (each with its own
// parent/guardian attestation, see family.ts), pay, and receive one pairing code per child.
//
// This is why nothing here may word an outcome as "verified" unless the BASIS says so — a screen that
// calls a declaration a check is the one lie this file exists to make impossible
// (`IDENTITY_BASIS_COPY`, `identityOutcome`).
//
// Requests are strict, so no client can smuggle in the outcome it wants: `confirmed`, the basis, the
// provider name and the instant are all the server's (routes/identity.ts,
// app.record_identity_verification, app.record_identity_declaration).
import { z } from 'zod';
import { BIRTH_YEAR_MIN, birthDateSchema, isoDateTimeSchema, uuidSchema } from './common.ts';

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
  // `birthDateSchema`, NOT `calendarDateSchema`: the latter's floor is the year 2000, which
  // refused every parent born before it — most of them. See that schema's docstring.
  statedDateOfBirth: birthDateSchema,
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
 * `PROVIDER_ERROR`, `PROVIDER_UNAVAILABLE` and `FACE_CHECK_UNAVAILABLE` are OURS, not the parent's
 * fault, and their copy says so — the project has filed blame-the-parent copy three times (HUNT7-I-3
 * and its predecessors).
 */
export const IDENTITY_FAILURE_CODES = [
  'NOT_A_GOVERNMENT_ID',
  'DOCUMENT_UNREADABLE',
  'DOCUMENT_EXPIRED',
  'NOT_AN_ADULT',
  'DOB_MISMATCH',
  'FACE_NOT_CONFIRMED',
  // Reachable only where the stronger biometric standard is configured (owner action #47). Kept
  // rather than removed: `identity_verifications` still exists and can still refuse this way.
  'FACE_CHECK_UNAVAILABLE',
  // The adult did not affirm the declaration. Since 0990 this is the refusal that matters most,
  // because the declaration is the gate.
  'ATTESTATION_REQUIRED',
  // No identity provider is configured at all, so the DOCUMENT could not be read. Distinct from
  // FACE_CHECK_UNAVAILABLE, which names the comparison: they are different missing pieces and a
  // parent reading the wrong one is told to wait for something that was never the problem.
  'PROVIDER_UNAVAILABLE',
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
  ATTESTATION_REQUIRED:
    'Please confirm the statement that you are the person on the ID and this child’s parent or legal guardian. We can’t set the account up without it.',
  PROVIDER_UNAVAILABLE:
    'We can’t check IDs on your account yet, so we can’t finish setting it up. This is on us, not you — nothing was saved, and support can complete the check for you.',
  /**
   * OURS and retryable, which is why it names both actions. It said only "Please try again",
   * and once `identityRetryWorthwhile` gave it back the retry control (BUG-418) that left a
   * parent whose provider keeps failing pressing the same button with nowhere to go. Same
   * shape as `IDENTITY_IMAGE_REJECTION_COPY.unsendable`, for the same reason.
   */
  PROVIDER_ERROR:
    'Something went wrong on our side while checking your ID. Nothing was saved. Please try again, and contact support if it keeps happening.',
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
  // ATTESTATION_REQUIRED is deliberately NOT here: it is the one refusal the parent can always fix,
  // by reading the statement and confirming it. Calling it ours would hide the only action there is.
  return (
    code === 'FACE_CHECK_UNAVAILABLE' ||
    code === 'PROVIDER_UNAVAILABLE' ||
    code === 'PROVIDER_ERROR' ||
    code === null ||
    code === undefined ||
    !IDENTITY_FAILURE_CODES.includes(code as IdentityFailureCode)
  );
}

/**
 * Whether trying again could plausibly get a different answer. NOT the same question as
 * `identityFailureIsOurs`, which asks whose fault the refusal is — and conflating the two is how a
 * parent came to read "Please try again" on a screen that offered no way to.
 *
 * `PROVIDER_ERROR` is ours AND retryable: something transient broke mid-check, and the next attempt
 * may well succeed. `PROVIDER_UNAVAILABLE` and `FACE_CHECK_UNAVAILABLE` are ours and NOT retryable:
 * they say a provider is not configured, so the next attempt fails identically and a retry control
 * only costs the parent the wait. An unknown code is not retryable because we cannot claim it is; it
 * gets `IDENTITY_FAILURE_FALLBACK`, which offers support instead (L-057).
 *
 * Everything the parent can act on is retryable by definition — including `NOT_AN_ADULT`, where the
 * action is the right adult's ID rather than the same one again, and `ATTESTATION_REQUIRED`, where it
 * is reading the statement. Both keep the form for exactly that reason.
 */
export function identityRetryWorthwhile(code: string | null | undefined): boolean {
  if (code === 'PROVIDER_ERROR') return true;
  return !identityFailureIsOurs(code);
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE PARENT-FACING ID SCREEN: its sentences and its decisions, defined ONCE.
//
// WHY THEY ARE HERE AND NOT ON A SURFACE. Seven of round 7's sixty findings were one shape — a fix
// that reached the portal and not the phone, each claiming "one helper decides the sentence for
// every surface" while the helper sat inside `apps/web` (L-070). The portal's per-field edit rule
// was fixed three times and the phone's never once, because the phone's rule lived in a component
// `apps/mobile`'s suite cannot render.
//
// So: `apps/web/src/pages/app/IdentityPage.tsx` and `apps/mobile/src/identity/identity-form.ts`
// (which `apps/mobile/app/(parent)/identity.tsx` renders) print NO sentence of their own and decide
// nothing of their own. Every line and every branch below is imported by both. That is why a
// mutation of one string here reddens the web suite and the mobile suite together — which is the
// evidence L-070 asks for, and which a test reading the other surface's SOURCE cannot give: a source
// pin guards the words and not the meaning (it catches a reword, never a widened predicate).
//
// What is NOT shared, and cannot be: choosing the photo (a file input versus an image picker) and
// the rendering itself. Each surface's own helper names the other's equivalent beside it.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** `IDENTITY_IMAGE_MAX_BYTES` as a whole number of MB, for the sentence a parent reads. */
export const IDENTITY_IMAGE_MAX_MB = IDENTITY_IMAGE_MAX_BYTES / (1024 * 1024);

/** `IDENTITY_IMAGE_MIME_TYPES` as the parent reads it, so the list and the sentence cannot drift. */
export const IDENTITY_IMAGE_TYPES_LABEL = IDENTITY_IMAGE_MIME_TYPES.map((type) =>
  type.replace('image/', '').toUpperCase(),
).join(' or ');

/**
 * The screen's fixed sentences. `method` is `IDENTITY_REQUIRED_COPY`, the sentence that already
 * existed for this rule and that nothing imported — the gap L-070's docblock records. Importing it
 * here is what makes the portal, the app and the gates elsewhere say one thing about one rule.
 *
 * There is no line about a selfie, and there must not be: nothing compares one (migration 0990), so
 * asking for a face photo would carry the biometric exposure without the verification. A sentence
 * that merely MENTIONS one teaches a parent to expect a step that does not exist.
 */
export const IDENTITY_SCREEN_COPY = {
  title: 'Verify your ID',
  method: IDENTITY_REQUIRED_COPY,
  /**
   * The honest version of "we don't store it". It does NOT claim anything about the parent's own
   * device: a camera roll keeps the photo they took, and a phone's image picker writes a copy into
   * the app's cache to hand it over. What this promises is what the product controls.
   */
  notStored:
    'Your photo travels inside this one request, is read for the check, and is deleted straight after. We never store it, and nothing is read off it but “is this a government ID” and the date of birth on it.',
  documentLabel: 'Photo of your government photo ID',
  documentHint: `A driver’s licence, state ID card or passport. Photograph the side with your photo and date of birth, as ${IDENTITY_IMAGE_TYPES_LABEL}, under ${IDENTITY_IMAGE_MAX_MB} MB.`,
  /**
   * Whether a photo has been chosen. Neither surface prints the FILE NAME: on a shared screen it is
   * one more thing about the adult on display, it buys the parent nothing they cannot see from the
   * picker, and a name is the kind of detail one surface shows and the other forgets.
   */
  documentNone: 'No photo added yet.',
  documentChosen: 'Photo added. Choose another to replace it.',
  dateOfBirthLabel: 'Your date of birth',
  dateOfBirthHint:
    'We check this against the date printed on the ID. Neither date is stored, and a mismatch stops the check.',
  declarationLabel: 'Your declaration',
  /**
   * Shown while the adult's own state is being read. Here rather than on each surface because the
   * two had already diverged — 'Checking what’s on record…' on the portal, the same line without
   * the ellipsis on the phone — inside one change by one owner. Nobody writes the second sentence
   * on purpose; the only defence is that there is one place to write it.
   */
  loadingLabel: 'Checking what’s on record…',
  submitLabel: 'Submit ID check',
  busyLabel: 'Checking your ID…',
  /**
   * Offered where the refusal is OURS — `identityFailureIsOurs(code)` true — because that is where
   * the parent has nothing to fix and support is the only action there is.
   *
   * (This docblock said the exact opposite until it was read back: "offered only where a refusal is
   * the parent's to act on". The code was right and the sentence about it was wrong, which is the
   * defect class round 7 spent four stages hunting, so it is corrected in place and recorded rather
   * than quietly swapped.)
   */
  supportLabel: 'Contact support',
} as const;

/**
 * The three things a submission needs. Field names, not error names: the screen puts each unmet
 * requirement's sentence beside the control it is about, and a parent missing two of them must see
 * both (L-059 — a disabled submit button is not a rule, it is the absence of a way to break one,
 * and it hides the reason).
 */
export const IDENTITY_REQUIREMENTS = ['document', 'dateOfBirth', 'declaration'] as const;
export type IdentityRequirement = (typeof IDENTITY_REQUIREMENTS)[number];

/**
 * What a parent is told when a requirement is unmet. Each names the ACTION. `declaration` reuses
 * `IDENTITY_ATTESTATION_REQUIRED_COPY` rather than restating it, because that sentence already
 * exists for this exact refusal and two copies of one sentence is how they diverge.
 */
export const IDENTITY_REQUIREMENT_COPY: Readonly<Record<IdentityRequirement, string>> = {
  document: 'Add a photo of your government photo ID.',
  dateOfBirth: `Enter your date of birth as year-month-day, from ${BIRTH_YEAR_MIN} onwards — for example 1990-04-12.`,
  declaration: IDENTITY_ATTESTATION_REQUIRED_COPY,
};

/**
 * A photo this build cannot send, worded so the parent knows what to do. Client-side because the
 * bytes travel in the request body: a 6 MB photo is a refused request and a wasted upload, and the
 * server's own limits are the backstop rather than the first thing the parent meets.
 *
 * None of these blames the parent for something of ours, and the size line says WHY the cap exists
 * — an unexplained limit reads as an accusation.
 */
export const IDENTITY_IMAGE_REJECTION_COPY = {
  mimeType: `We can read ${IDENTITY_IMAGE_TYPES_LABEL}. Take the photo again with your camera app, or choose a ${IDENTITY_IMAGE_TYPES_LABEL} photo.`,
  tooLarge: `That photo is over ${IDENTITY_IMAGE_MAX_MB} MB. Your ID is sent in one request instead of being stored anywhere, so take the photo again at a lower resolution and choose it.`,
  empty: 'That photo came through empty. Take the photo again and choose it.',
  /**
   * The encoder produced something the contract will not accept — a data URL prefix, a line break,
   * an empty string. That is OURS, and the copy says so rather than sending the parent back to
   * their camera for a fault their photo does not have.
   */
  unsendable:
    'We couldn’t prepare that photo to send. This is on us, not your photo — try choosing it again, and contact support if it keeps happening.',
} as const;

/** One picked photo as a surface hands it over, before it is known to be sendable. */
export interface IdentityDocumentDraft {
  readonly mimeType: string;
  /** Base64 with no `data:` prefix — see `identityImageSchema`. */
  readonly base64: string;
  /** DECODED size, which is what `IDENTITY_IMAGE_MAX_BYTES` caps. */
  readonly byteLength: number;
}

/**
 * Why this photo cannot be sent, or null when it can. The type check comes before the size check on
 * purpose: a HEIC of any size is the wrong thing to shrink.
 *
 * `base64` is optional so a surface can ask this BEFORE it reads the bytes — the portal knows a
 * browser `File`'s type and size from the file input and refuses a 6 MB photo without loading it
 * into the tab. What it may not do is skip the question: `prepareIdentitySubmission` asks again with
 * the bytes in hand, so a surface that forgets the early check still cannot send an oversized photo.
 */
export function identityImageRejection(image: {
  readonly mimeType: string;
  readonly byteLength: number;
  readonly base64?: string | undefined;
}): string | null {
  if (!IDENTITY_IMAGE_MIME_TYPES.includes(image.mimeType as IdentityImageMimeType)) {
    return IDENTITY_IMAGE_REJECTION_COPY.mimeType;
  }
  if (!Number.isFinite(image.byteLength) || image.byteLength <= 0 || image.base64?.length === 0) {
    return IDENTITY_IMAGE_REJECTION_COPY.empty;
  }
  if (image.byteLength > IDENTITY_IMAGE_MAX_BYTES) return IDENTITY_IMAGE_REJECTION_COPY.tooLarge;
  return null;
}

/** One unmet requirement, with the control it belongs beside. */
export interface IdentityProblem {
  readonly field: IdentityRequirement;
  readonly message: string;
}

/**
 * The reasons left standing once the parent has changed ONE field. Shared because both surfaces had
 * hand-rolled it and had already diverged: the phone cleared the declaration's reason when the box
 * was ticked, the portal did not, and NEITHER cleared the date of birth's when it was retyped.
 *
 * So a parent on the portal ticked the box and went on reading "Please confirm the statement that
 * you are the person on the ID" in red beside a ticked box — a screen contradicting its own control,
 * which is L-068's failure with the two regions one keystroke apart. A stale reason is worse than no
 * reason: it says the parent's correction did not count.
 *
 * Only the field that changed is cleared. The others are still unmet and still have to say so, or a
 * parent who fixes one of three requirements is told everything is fine and meets the same submit
 * again (L-059: every unmet requirement, every time, beside its own control).
 */
export function clearIdentityProblem(
  problems: readonly IdentityProblem[],
  field: IdentityRequirement,
): readonly IdentityProblem[] {
  return problems.filter((problem) => problem.field !== field);
}

/** What a surface has collected so far. `document` is null until a photo is chosen. */
export interface IdentityDraft {
  readonly statedDateOfBirth: string;
  readonly document: IdentityDocumentDraft | null;
  readonly declarationAffirmed: boolean;
}

export type IdentitySubmission =
  | { readonly ok: true; readonly body: SubmitIdentityVerificationRequest }
  | { readonly ok: false; readonly problems: readonly IdentityProblem[] };

/**
 * The request body, or EVERY reason there isn't one — never the first reason. A parent missing the
 * date and the declaration gets both, because fixing one and being refused for the other is the
 * defect L-059 was written for.
 *
 * The final `safeParse` is not belt-and-braces: `identityImageSchema`'s base64 pattern refuses a
 * `data:` prefix and newlines, which is a fault in the surface's encoder rather than in the photo,
 * so it lands on the copy that says so instead of throwing past the screen.
 */
export function prepareIdentitySubmission(draft: IdentityDraft): IdentitySubmission {
  const problems: IdentityProblem[] = [];
  if (draft.document === null) {
    problems.push({ field: 'document', message: IDENTITY_REQUIREMENT_COPY.document });
  } else {
    const rejection = identityImageRejection(draft.document);
    if (rejection !== null) problems.push({ field: 'document', message: rejection });
  }
  if (!birthDateSchema.safeParse(draft.statedDateOfBirth.trim()).success) {
    problems.push({ field: 'dateOfBirth', message: IDENTITY_REQUIREMENT_COPY.dateOfBirth });
  }
  if (!draft.declarationAffirmed) {
    problems.push({ field: 'declaration', message: IDENTITY_REQUIREMENT_COPY.declaration });
  }
  if (problems.length > 0) return { ok: false, problems };
  const parsed = submitIdentityVerificationRequestSchema.safeParse({
    statedDateOfBirth: draft.statedDateOfBirth.trim(),
    document: { mimeType: draft.document?.mimeType, base64: draft.document?.base64 },
    holderAttestation: true,
  });
  if (!parsed.success) {
    return {
      ok: false,
      problems: [{ field: 'document', message: IDENTITY_IMAGE_REJECTION_COPY.unsendable }],
    };
  }
  return { ok: true, body: parsed.data };
}

/**
 * WHAT WAS ESTABLISHED, said out loud. `basis` is the field an audit asks about, and a parent is
 * owed the same answer: 'declared' is the document plus their legal declaration and NOTHING
 * compared their face to it, so calling that "verified" is a false statement about their account.
 *
 * Every entry carries BOTH a headline and a detail, and no entry but `verified` may contain the word
 * — L-068's fourth occurrence was a `Record<state, copy>` in which one state printed an
 * unconditional present-tense sentence, so the property is asserted on THIS TABLE rather than on one
 * state's rendered output, and a basis added later cannot slip through.
 *
 * `unstated` is the fall-through, not a guess: `confirmed` with no basis cannot happen today
 * (`adult_identity_basis` is the single reader of both tables), and if a later build produces it the
 * parent is told plainly that we cannot name the evidence rather than told the stronger of the two
 * (L-057: fix the fall-through, not the enumerated cases).
 */
export const IDENTITY_BASIS_COPY = {
  verified: {
    headline: 'Your ID is verified.',
    detail:
      'A government photo ID was read, its date of birth put you at or over 18, and a face check confirmed it is yours. You can add your children now.',
  },
  declared: {
    headline: 'Your ID check is complete.',
    detail:
      'We read a government photo ID, its date of birth put you at or over 18, and you declared that you are the person shown on it and your child’s parent or legal guardian. That declaration is what ties the ID to you — nothing compared a photo of you with it. You can add your children now.',
  },
  unstated: {
    headline: 'Your account is set up.',
    detail:
      'You can add your children. We can’t tell you from here which check established this, so if you need that on record, support can look it up.',
  },
} as const satisfies Readonly<Record<string, { headline: string; detail: string }>>;

export type IdentityBasisKey = keyof typeof IDENTITY_BASIS_COPY;

/**
 * Whether the STRONGER standard can be met in this deployment at all, in a sentence — with BOTH
 * variants present, so no state of `faceCheckAvailable` can print an unconditional claim (L-068).
 * It is what keeps `basis: 'declared'` an honest answer instead of a silent downgrade, which is why
 * the screen prints it BEFORE a parent submits as well as after.
 */
export const IDENTITY_FACE_CHECK_COPY = {
  available:
    'This account can also run a face check, comparing a photo of you with the one on the ID.',
  unavailable:
    'We can’t compare a photo of you with the one on the ID — no service we use will do that — so your declaration is what ties the ID to you. No account here meets the stronger standard yet.',
} as const;

export function identityFaceCheckCopy(available: boolean): string {
  return available ? IDENTITY_FACE_CHECK_COPY.available : IDENTITY_FACE_CHECK_COPY.unavailable;
}

/**
 * THE ONE QUESTION THE SCREEN ASKS ABOUT THE ADULT: is this settled, is it refused, and if refused
 * is it theirs to act on. Both surfaces import this and neither re-derives any part of it — the
 * failure that L-068 names is two regions of one screen answering the same question separately and
 * agreeing only until the next state is added.
 *
 * A refusal the parent cannot fix gets support rather than a control that will fail the same way, and
 * `ATTESTATION_REQUIRED` — the one refusal they can ALWAYS fix — keeps the form. An unknown code
 * lands on support with `IDENTITY_FAILURE_FALLBACK` rather than on a guessed remedy.
 *
 * `retryOffered` is `identityRetryWorthwhile(code)`, NOT `!identityFailureIsOurs(code)`, which is
 * what it used to be. Under the old rule `PROVIDER_ERROR` — ours, but transient — got no retry
 * control while its own copy ended "Please try again", so the screen told the parent to do something
 * it had just taken away. The docblock here recorded that as a residual and excused it on the grounds
 * that "the API's tests assert that copy"; nothing asserted it (`apps/api/tests/identity.test.ts`
 * checks only that `faceCheckAvailable` is a boolean), so the excuse was false and the fix was
 * always available. Whose fault a refusal is and whether trying again can help are two questions,
 * and support is still offered by the first (`identityFailureIsOurs`) wherever it is ours.
 */
export type IdentityOutcome =
  | {
      readonly state: 'established';
      readonly basis: IdentityBasisKey;
      readonly headline: string;
      readonly detail: string;
    }
  | {
      readonly state: 'refused';
      readonly failureCode: string | null;
      readonly message: string;
      readonly retryOffered: boolean;
    }
  | { readonly state: 'not_started' };

export function identityOutcome(status: IdentityVerificationStatus): IdentityOutcome {
  if (status.confirmed || status.basis !== null) {
    // The BASIS decides the words, never `confirmed`: `confirmed` answers "may this adult proceed",
    // and answering "on what evidence" with it is exactly how a declaration gets called a check.
    const basis: IdentityBasisKey = status.basis ?? 'unstated';
    const copy = IDENTITY_BASIS_COPY[basis];
    return { state: 'established', basis, headline: copy.headline, detail: copy.detail };
  }
  if (status.latest === null) return { state: 'not_started' };
  const failureCode = status.latest.failureCode;
  return {
    state: 'refused',
    failureCode,
    message: identityFailureCopy(failureCode),
    retryOffered: identityRetryWorthwhile(failureCode),
  };
}

/**
 * The request itself did not get an answer, or got a refusal that is not an outcome of the check.
 * Shaped as plain fields rather than as `ApiRequestError` so this file does not pull the fetch
 * client into every consumer of the contracts index; each surface passes `{ code, rule }` from its
 * own caught error, and the SENTENCES stay here where both read them.
 */
export interface IdentityRequestFailure {
  readonly code: string;
  readonly rule?: string | null | undefined;
}

/**
 * What a parent reads when the submission could not be made. The default is the fall-through, and it
 * is honest rather than a guess (L-057): a code neither surface has seen must not be worded as the
 * nearest one. Nothing here blames the parent for an outcome of ours.
 */
export const IDENTITY_REQUEST_FAILURE_COPY = {
  offline:
    'Your ID check wasn’t sent — this device appears to be offline. Check your connection and submit it again.',
  rateLimited:
    'There have been too many ID checks on this account. Please wait a little, then submit it again.',
  alreadyConfirmed:
    'Your ID check is already on record, so this one wasn’t run again. Reload this screen to see what it says.',
  tooLarge: `That photo was too large to send (the limit is ${IDENTITY_IMAGE_MAX_MB} MB). Take it again at a lower resolution and choose it.`,
  rejected:
    'We couldn’t send that ID check. Check the date of birth you typed and the photo you chose, then submit it again.',
  signIn: 'Please sign in again, then submit your ID check.',
  stepUp: 'Enter your parent PIN, then submit your ID check again.',
  unknown:
    'Your ID check couldn’t be sent, and we can’t tell you why from here. Nothing was saved. Please try again, and contact support if it keeps happening.',
} as const;

export function identityRequestFailureCopy(failure: IdentityRequestFailure): string {
  if (failure.code === 'BUSINESS_RULE' && failure.rule === IDENTITY_RULES.alreadyConfirmed) {
    return IDENTITY_REQUEST_FAILURE_COPY.alreadyConfirmed;
  }
  switch (failure.code) {
    case 'NETWORK':
      return IDENTITY_REQUEST_FAILURE_COPY.offline;
    case 'RATE_LIMITED':
      return IDENTITY_REQUEST_FAILURE_COPY.rateLimited;
    case 'PAYLOAD_TOO_LARGE':
      return IDENTITY_REQUEST_FAILURE_COPY.tooLarge;
    case 'VALIDATION_FAILED':
      return IDENTITY_REQUEST_FAILURE_COPY.rejected;
    case 'UNAUTHENTICATED':
      return IDENTITY_REQUEST_FAILURE_COPY.signIn;
    case 'STEP_UP_REQUIRED':
      return IDENTITY_REQUEST_FAILURE_COPY.stepUp;
    default:
      return IDENTITY_REQUEST_FAILURE_COPY.unknown;
  }
}
