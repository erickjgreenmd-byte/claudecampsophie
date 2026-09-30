/**
 * The phone's adult ID screen, as pure logic (spec P3 verifiable parental consent, AC_ACCESS_01/02;
 * migration 0990). Validation, body-building and every sentence the screen prints are decided here;
 * `app/(parent)/identity.tsx` renders what `identityView` returns and nothing else.
 *
 * WHY THE SPLIT. `apps/mobile`'s vitest project cannot render react-native (vitest.config.ts), so a
 * rule that lives inside the screen component cannot be tested at all. That is not a theoretical
 * risk: it is why the portal's per-field edit rule was fixed three times and the phone's never once
 * while the phone silently reverted other guardians' edits (L-070, BUG-404..407).
 *
 * WHERE THE SENTENCES LIVE. Not here. Every line and every branch comes from
 * `@pencillift/contracts` (`packages/contracts/src/identity.ts`), which the portal imports too, so
 * a change to one string reaches both surfaces or neither.
 *
 * THE PORTAL'S EQUIVALENT of this module is the component `apps/web/src/pages/app/IdentityPage.tsx`
 * — the portal can render its own components under jsdom, so its logic sits in the page rather than
 * in a sibling module. The two things this file owns that the portal's page owns separately, because
 * they cannot be shared, are named beside each one below:
 *   * `identityDocumentFromAsset` here ←→ `identityDocumentFromFile` in IdentityPage.tsx
 *     (an `expo-image-picker` asset versus a browser `File`).
 *   * `identityView` here ←→ IdentityPage.tsx's own JSX
 *     (a plain view model for react-native versus the DOM).
 */
import {
  IDENTITY_ATTESTATION_STATEMENT,
  IDENTITY_SCREEN_COPY,
  identityImageRejection,
  identityFaceCheckCopy,
  identityRequestFailureCopy,
  prepareIdentitySubmission,
  type IdentityDocumentDraft,
  type IdentityOutcome,
  type IdentityProblem,
  type IdentityRequirement,
  type IdentityVerificationStatus,
  type SubmitIdentityVerificationRequest,
} from '@pencillift/contracts';
import { identityOutcome } from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';

/** The photo the parent chose. Held in memory only: it goes into the request body and nowhere else. */
export type IdentityFormDocument = IdentityDocumentDraft;

/**
 * PHONE-ONLY sentences, and deliberately NOT in `@pencillift/contracts`.
 *
 * There is no portal twin for any of them and there should not be: a browser file input renders its
 * own button and asks for no permission, so the portal has nothing to say here. A shared constant
 * with one reader is the false-sharing claim BUG-411 is about — six docblocks in this repository
 * claimed a constant was shared by surfaces that never imported it. These live where their only
 * reader does, and say so.
 */
export const IDENTITY_PHONE_COPY = {
  addFromCamera: 'Take a photo of your ID',
  addFromLibrary: 'Choose a photo of your ID',
  cameraDenied:
    'PencilLift doesn’t have permission to use this device’s camera. Allow it in Settings, or choose a photo you have already taken.',
  libraryDenied:
    'PencilLift doesn’t have permission to open this device’s photos. Allow it in Settings, or take a photo instead.',
} as const;

export interface IdentityFormState {
  /** As typed, not trimmed: the parent sees what they typed and the submit trims it. */
  readonly dateOfBirth: string;
  readonly document: IdentityFormDocument | null;
  readonly declarationAffirmed: boolean;
  /**
   * The unmet requirements from the LAST submit — all of them, never the first (L-059). Empty until
   * a submit has been attempted, so nothing is scolded before the parent has pressed anything.
   */
  readonly problems: readonly IdentityProblem[];
}

export const emptyIdentityForm: IdentityFormState = {
  dateOfBirth: '',
  document: null,
  declarationAffirmed: false,
  problems: [],
};

/**
 * One picked asset as `expo-image-picker` hands it over, narrowed to the fields this needs. The
 * portal's equivalent is `identityDocumentFromFile` in IdentityPage.tsx, which reads a `File`.
 */
export interface PickedImageAsset {
  readonly base64?: string | null | undefined;
  readonly mimeType?: string | null | undefined;
}

/** The decoded size of standard base64, without decoding it. */
function decodedByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/**
 * The picked photo as a sendable document, or why it is not one.
 *
 * The size is computed from the BASE64 rather than read from the picker's `fileSize`, because the
 * base64 is what travels: a picker that re-encodes on the way out reports the size of the file it
 * started from, and `IDENTITY_IMAGE_MAX_BYTES` caps what the request carries.
 *
 * IT ASKS `identityImageRejection` — the same shared question the portal's `identityDocumentFromFile`
 * asks — and it did not until this was read back. It hand-rolled two of the three checks: a missing
 * mime type was refused but a PRESENT wrong one (a HEIC, a PDF) was accepted, and the size cap was
 * not consulted at all. Neither could actually be sent, because `prepareIdentitySubmission` asks the
 * same question again with the bytes in hand — so the defect was not a hole but a worse screen: the
 * phone took the photo, called it chosen, let the parent type their date of birth and read the
 * declaration, and only then said "we can read JPEG and PNG", while the portal says it the instant
 * the file is picked. The two also disagreed on WHICH sentence an empty HEIC got, because this
 * checked empty first and the shared gate checks the type first (a HEIC of any size is the wrong
 * thing to shrink). One call settles all three.
 *
 * The docblock on the portal's side claimed this function "asks the same shared question" while it
 * did not, which is the false-sharing shape BUG-411 is about, written inside the fix for it.
 */
export function identityDocumentFromAsset(
  asset: PickedImageAsset,
): { readonly document: IdentityFormDocument } | { readonly rejection: string } {
  const base64 = asset.base64 ?? '';
  const document: IdentityFormDocument = {
    mimeType: asset.mimeType ?? '',
    base64,
    byteLength: decodedByteLength(base64),
  };
  const rejection = identityImageRejection(document);
  return rejection === null ? { document } : { rejection };
}

/** What a submit did. `answered` carries the server's own status, refusal or confirmation alike. */
export type IdentitySubmitResult =
  | { readonly kind: 'unmet'; readonly problems: readonly IdentityProblem[] }
  | { readonly kind: 'answered'; readonly status: IdentityVerificationStatus }
  /** The request could not be made, or was refused before the check ran. Always retryable. */
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Sends the check. `send` is the one thing this module cannot own — it needs the screen's API client
 * — and it is a parameter so this file stays testable without a device or a network.
 *
 * Enforcement happens HERE, on submit, and reports every unmet requirement at once. The screen's
 * button is never disabled to express a requirement: a disabled control is not a rule, it is the
 * absence of a way to break one, and it hides the reason (L-059, BUG-347).
 */
export async function submitIdentityForm(
  form: IdentityFormState,
  send: (body: SubmitIdentityVerificationRequest) => Promise<IdentityVerificationStatus>,
): Promise<IdentitySubmitResult> {
  const prepared = prepareIdentitySubmission({
    statedDateOfBirth: form.dateOfBirth,
    document: form.document,
    declarationAffirmed: form.declarationAffirmed,
  });
  if (!prepared.ok) return { kind: 'unmet', problems: prepared.problems };
  try {
    return { kind: 'answered', status: await send(prepared.body) };
  } catch (error) {
    return { kind: 'failed', message: identityRequestProblem(error) };
  }
}

/**
 * The sentence for a request that could not be made — a failed LOAD (`GET`) or a failed submit
 * alike, so the screen cannot word the same failure two ways. It reads nothing but the error's code
 * and rule, and the words themselves come from the contract, which is where the portal reads them.
 *
 * An error that is not an `ApiRequestError` gets the contract's fall-through rather than its
 * `message`: a thrown value of unknown provenance is not copy, and printing one is how a stack
 * trace ends up on a parent's screen (L-057 — land the unknown case on the honest branch).
 */
export function identityRequestProblem(error: unknown): string {
  return identityRequestFailureCopy(
    error instanceof ApiRequestError ? { code: error.code, rule: error.rule } : { code: 'UNKNOWN' },
  );
}

/** The sentence for one field's unmet requirement, or null. */
function problemFor(
  problems: readonly IdentityProblem[],
  field: IdentityRequirement,
): string | null {
  return problems.find((problem) => problem.field === field)?.message ?? null;
}

export interface IdentityFieldsView {
  readonly documentLabel: string;
  readonly documentHint: string;
  /** "No photo added yet." / "Photo added…" — never the file's name. */
  readonly documentStatus: string;
  /** Phone-only, from `IDENTITY_PHONE_COPY`: the portal's file input labels its own control. */
  readonly addFromCameraLabel: string;
  readonly addFromLibraryLabel: string;
  /**
   * Whatever stopped a photo being added: an unmet requirement, a photo the check cannot read, or a
   * permission this device has not granted. One slot, because they all belong beside the same
   * control and a parent reading two of them at once learns nothing from the second.
   */
  readonly documentProblem: string | null;
  readonly dateOfBirthLabel: string;
  readonly dateOfBirthHint: string;
  readonly dateOfBirthProblem: string | null;
  readonly declarationLabel: string;
  /** `IDENTITY_ATTESTATION_STATEMENT` in full, beside the control that affirms it. */
  readonly declarationStatement: string;
  readonly declarationProblem: string | null;
}

export type IdentityViewBody =
  | {
      readonly kind: 'form';
      readonly fields: IdentityFieldsView;
      readonly submitLabel: string;
      /**
       * True ONLY while a request is in flight, so one tap cannot become two checks. It is never how
       * a requirement is expressed — see `submitIdentityForm` (L-059).
       */
      readonly submitDisabled: boolean;
      /** The last refusal, when it is the parent's to act on, above the form they will fix. */
      readonly refusal: string | null;
      /** A request that could not be made. Distinct from a refusal by the check itself. */
      readonly transportProblem: string | null;
    }
  | { readonly kind: 'established'; readonly headline: string; readonly detail: string }
  /**
   * A refusal the parent cannot act on: the form is gone, because a control that will fail the same
   * way is worse than none, and support is the only action there is.
   */
  | { readonly kind: 'blocked'; readonly message: string; readonly supportLabel: string };

export interface IdentityView {
  readonly title: string;
  readonly method: string;
  readonly notStored: string;
  /**
   * Whether the stronger standard can be met here, in one sentence, printed on EVERY state of this
   * screen. One call, so the form and the success state cannot disagree about the same fact about
   * the same account — the failure L-068 names (four rounds of self-contradicting screens).
   */
  readonly faceCheckNote: string;
  readonly body: IdentityViewBody;
}

/**
 * Everything the screen shows, decided from the adult's status and the form in hand.
 *
 * The state is `identityOutcome(status)` — the ONE shared predicate — and this function only dresses
 * it. It does not ask "is this refused" a second way, and neither does the portal.
 */
export function identityView(args: {
  readonly form: IdentityFormState;
  readonly status: IdentityVerificationStatus;
  readonly busy: boolean;
  /** The message from a submit whose request could not be made, if the last one could not. */
  readonly transportProblem?: string | null | undefined;
}): IdentityView {
  const outcome: IdentityOutcome = identityOutcome(args.status);
  const shell = {
    title: IDENTITY_SCREEN_COPY.title,
    method: IDENTITY_SCREEN_COPY.method,
    notStored: IDENTITY_SCREEN_COPY.notStored,
    faceCheckNote: identityFaceCheckCopy(args.status.faceCheckAvailable),
  };
  if (outcome.state === 'established') {
    return {
      ...shell,
      body: { kind: 'established', headline: outcome.headline, detail: outcome.detail },
    };
  }
  if (outcome.state === 'refused' && !outcome.retryOffered) {
    return {
      ...shell,
      body: {
        kind: 'blocked',
        message: outcome.message,
        supportLabel: IDENTITY_SCREEN_COPY.supportLabel,
      },
    };
  }
  const { form } = args;
  return {
    ...shell,
    body: {
      kind: 'form',
      fields: {
        documentLabel: IDENTITY_SCREEN_COPY.documentLabel,
        documentHint: IDENTITY_SCREEN_COPY.documentHint,
        documentStatus:
          form.document === null
            ? IDENTITY_SCREEN_COPY.documentNone
            : IDENTITY_SCREEN_COPY.documentChosen,
        addFromCameraLabel: IDENTITY_PHONE_COPY.addFromCamera,
        addFromLibraryLabel: IDENTITY_PHONE_COPY.addFromLibrary,
        documentProblem: problemFor(form.problems, 'document'),
        dateOfBirthLabel: IDENTITY_SCREEN_COPY.dateOfBirthLabel,
        dateOfBirthHint: IDENTITY_SCREEN_COPY.dateOfBirthHint,
        dateOfBirthProblem: problemFor(form.problems, 'dateOfBirth'),
        declarationLabel: IDENTITY_SCREEN_COPY.declarationLabel,
        declarationStatement: IDENTITY_ATTESTATION_STATEMENT,
        declarationProblem: problemFor(form.problems, 'declaration'),
      },
      submitLabel: args.busy ? IDENTITY_SCREEN_COPY.busyLabel : IDENTITY_SCREEN_COPY.submitLabel,
      submitDisabled: args.busy,
      refusal: outcome.state === 'refused' ? outcome.message : null,
      transportProblem: args.transportProblem ?? null,
    },
  };
}
