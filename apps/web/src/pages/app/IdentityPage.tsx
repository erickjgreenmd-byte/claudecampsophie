import { useId, useState, type FormEvent } from 'react';
import {
  IDENTITY_ATTESTATION_STATEMENT,
  IDENTITY_IMAGE_MIME_TYPES,
  IDENTITY_IMAGE_REJECTION_COPY,
  IDENTITY_SCREEN_COPY,
  clearIdentityProblem,
  identityFaceCheckCopy,
  identityImageRejection,
  identityOutcome,
  identityRequestFailureCopy,
  identityVerificationStatusSchema,
  prepareIdentitySubmission,
  type IdentityDocumentDraft,
  type IdentityProblem,
  type IdentityRequirement,
  type IdentityVerificationStatus,
} from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import { RequireParent, useApiQuery, useSession } from '../../lib/session.tsx';
import { ErrorState, Loading, Notice } from '../../components/states.tsx';

/**
 * The adult ID check (spec P3 verifiable parental consent, AC_ACCESS_01/02; migration 0990). Until
 * this screen existed no parent could finish setting up an account: the route, the contract and the
 * provider port were all built and nothing called any of them.
 *
 * THE METHOD, so the copy is true. The parent photographs ONE government photo ID. There is NO
 * SELFIE and this screen must never grow one — nothing compares it (0990), so collecting a face
 * photo would carry the biometric exposure without the verification. The parent also types their own
 * date of birth, which is checked AGAINST the document (a mismatch is DOB_MISMATCH), and affirms
 * `IDENTITY_ATTESTATION_STATEMENT`, the legal declaration that BINDS the document to the person —
 * which is why the sentence is shown in full as the label of the box that affirms it, rather than
 * summarised beside a link.
 *
 * NOT ONE SENTENCE OR DECISION IS DEFINED HERE. They all come from `@pencillift/contracts`
 * (`packages/contracts/src/identity.ts`), which `apps/mobile/src/identity/identity-form.ts` imports
 * too — so a change reaches the portal and the phone or neither. Seven of round 7's sixty findings
 * were the opposite arrangement (L-070): a helper inside `apps/web` claiming to decide "for every
 * surface" while the phone printed the old sentence.
 *
 * THE PHONE'S EQUIVALENTS, named so a later change can find both halves:
 *   * this component's logic  ←→ `identityView` / `submitIdentityForm` in identity-form.ts
 *     (the phone's screen cannot be rendered by any test, so its logic lives in a pure module;
 *      the portal renders under jsdom, so its logic lives here and IdentityPage.test.tsx drives it).
 *   * `identityDocumentFromFile` below ←→ `identityDocumentFromAsset` in identity-form.ts.
 *     Both ask `identityImageRejection` in packages/contracts/src/identity.ts, so the type, the
 *     size cap and the empty case are one answer and are refused at PICK time on both surfaces.
 *     That was written here before it was true: the phone's half hand-rolled two checks, let a
 *     HEIC through to the submit, and never consulted the size cap. Naming the helper and its
 *     file is what makes the claim checkable in one grep — the vagueness is what let it stand.
 */

/** Base64 of `bytes`, in chunks so a multi-megabyte photo cannot overflow the argument list. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 8192) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  }
  return btoa(binary);
}

/**
 * The chosen file as a sendable document, or why it is not one.
 *
 * The type and the size are asked FIRST, from the file input's own metadata, so an oversized photo
 * is refused without being read into the tab — the bytes travel in the request body, and reading 6 MB
 * to then refuse it is work the parent waits for twice. The phone's equivalent is
 * `identityDocumentFromAsset`, which asks the same shared question of an image-picker asset.
 *
 * The photo NEVER reaches storage, a form POST or a URL: it exists as this value until the request
 * body is built, which is the whole reason `IDENTITY_IMAGE_MAX_BYTES` is small.
 */
async function identityDocumentFromFile(
  file: File,
): Promise<{ readonly document: IdentityDocumentDraft } | { readonly rejection: string }> {
  const early = identityImageRejection({ mimeType: file.type, byteLength: file.size });
  if (early !== null) return { rejection: early };
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return {
      document: { mimeType: file.type, base64: toBase64(bytes), byteLength: bytes.byteLength },
    };
  } catch {
    // The browser could not hand over the bytes. That is ours, and the copy says so rather than
    // sending the parent back to their camera for a fault their photo does not have.
    return { rejection: IDENTITY_IMAGE_REJECTION_COPY.unsendable };
  }
}

/** The sentence for one field's unmet requirement, or null. Mirrors identity-form.ts's `problemFor`. */
function problemFor(
  problems: readonly IdentityProblem[],
  field: IdentityRequirement,
): string | null {
  return problems.find((problem) => problem.field === field)?.message ?? null;
}

const problemStyle = { color: 'var(--danger)', margin: '4px 0 0' } as const;

/** The id of the paragraph holding one field's reason. Also what its control points at. */
function problemId(fieldId: string): string {
  return `${fieldId}-problem`;
}

/**
 * The id a control announces, or undefined when it has nothing to announce.
 *
 * A reason on screen that the control does not point at is a reason a screen-reader user never
 * reaches — the L-059 defect in its assistive-technology form, and the page's first draft had it:
 * the photo input named its OWN id and the other two controls named nothing.
 */
function describedBy(fieldId: string, message: string | null): string | undefined {
  return message === null ? undefined : problemId(fieldId);
}

function FieldProblem({ id, message }: { id: string; message: string | null }) {
  if (message === null) return null;
  return (
    <p id={problemId(id)} role="alert" style={problemStyle}>
      {message}
    </p>
  );
}

function IdentityCheck() {
  const { api } = useSession();
  const query = useApiQuery(
    (client) => client.get('/v1/identity/verification', identityVerificationStatusSchema),
    [],
  );
  /** The answer the SERVER last gave: the GET's, or the POST's, which supersedes it. */
  const [submitted, setSubmitted] = useState<IdentityVerificationStatus | null>(null);
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [document, setDocument] = useState<IdentityDocumentDraft | null>(null);
  const [declarationAffirmed, setDeclarationAffirmed] = useState(false);
  /** Every unmet requirement from the last submit, never just the first (L-059). */
  const [problems, setProblems] = useState<readonly IdentityProblem[]>([]);
  /** A request that could not be made. Distinct from a refusal the check itself returned. */
  const [transportProblem, setTransportProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const documentId = useId();
  const dobId = useId();
  const declarationId = useId();
  const documentProblem = problemFor(problems, 'document');
  const dobProblem = problemFor(problems, 'dateOfBirth');
  const declarationProblem = problemFor(problems, 'declaration');

  if (query.status === 'loading') return <Loading label={IDENTITY_SCREEN_COPY.loadingLabel} />;
  if (query.status === 'error') {
    return <ErrorState message={identityRequestFailureCopy(query.error)} onRetry={query.reload} />;
  }

  const status = submitted ?? query.data;
  const outcome = identityOutcome(status);
  // ONE call, printed on every state of this screen: the form and the success state cannot disagree
  // about the same fact about the same account (L-068 — four rounds of self-contradicting screens).
  const faceCheckNote = identityFaceCheckCopy(status.faceCheckAvailable);

  const chooseFile = async (file: File | undefined) => {
    setTransportProblem(null);
    if (file === undefined) return;
    const read = await identityDocumentFromFile(file);
    if ('rejection' in read) {
      // Nothing is kept: a photo that cannot be sent must not sit in the form looking accepted.
      setDocument(null);
      setProblems([{ field: 'document', message: read.rejection }]);
      return;
    }
    setDocument(read.document);
    setProblems((current) => clearIdentityProblem(current, 'document'));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setTransportProblem(null);
    const prepared = prepareIdentitySubmission({
      statedDateOfBirth: dateOfBirth,
      document,
      declarationAffirmed,
    });
    // Enforced HERE, where the reason can be given, and all of it at once. The submit button is
    // never disabled to express a requirement: that hides the reason (L-059, BUG-347).
    if (!prepared.ok) {
      setProblems(prepared.problems);
      return;
    }
    setProblems([]);
    setBusy(true);
    try {
      const answer = await api.send(
        'POST',
        '/v1/identity/verification',
        prepared.body,
        identityVerificationStatusSchema,
      );
      // What the DATABASE decided, not what this page hoped for: `adult_declared` is a generated
      // column and the response is read back from it.
      setSubmitted(answer);
      setDocument(null);
      setDeclarationAffirmed(false);
    } catch (error) {
      setTransportProblem(
        identityRequestFailureCopy(
          error instanceof ApiRequestError
            ? { code: error.code, rule: error.rule }
            : { code: 'UNKNOWN' },
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  if (outcome.state === 'established') {
    return (
      <section className="card" aria-labelledby="identity-title">
        <h1 id="identity-title">{outcome.headline}</h1>
        <p>{outcome.detail}</p>
        <p>{faceCheckNote}</p>
      </section>
    );
  }

  if (outcome.state === 'refused' && !outcome.retryOffered) {
    // A refusal the parent cannot act on: no form, because a control that will fail the same way is
    // worse than none, and support is the only action there is.
    return (
      <section className="card" aria-labelledby="identity-title">
        <h1 id="identity-title">{IDENTITY_SCREEN_COPY.title}</h1>
        <div className="error" role="alert">
          <p>{outcome.message}</p>
          <p>
            <a href="/app/support">{IDENTITY_SCREEN_COPY.supportLabel}</a>
          </p>
        </div>
        <p>{faceCheckNote}</p>
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby="identity-title">
      <h1 id="identity-title">{IDENTITY_SCREEN_COPY.title}</h1>
      <p>{IDENTITY_SCREEN_COPY.method}</p>
      <p>{IDENTITY_SCREEN_COPY.notStored}</p>
      <p>{faceCheckNote}</p>
      {outcome.state === 'refused' ? (
        <div className="error" role="alert">
          <p>{outcome.message}</p>
        </div>
      ) : null}
      {transportProblem !== null ? <Notice>{transportProblem}</Notice> : null}
      <form onSubmit={(e) => void submit(e)} noValidate>
        <label htmlFor={documentId}>{IDENTITY_SCREEN_COPY.documentLabel}</label>
        <p>{IDENTITY_SCREEN_COPY.documentHint}</p>
        <input
          id={documentId}
          type="file"
          accept={IDENTITY_IMAGE_MIME_TYPES.join(',')}
          capture="environment"
          aria-describedby={describedBy(documentId, documentProblem)}
          onChange={(e) => void chooseFile(e.target.files?.[0])}
        />
        <p>
          {document === null
            ? IDENTITY_SCREEN_COPY.documentNone
            : IDENTITY_SCREEN_COPY.documentChosen}
        </p>
        <FieldProblem id={documentId} message={documentProblem} />

        <label htmlFor={dobId}>{IDENTITY_SCREEN_COPY.dateOfBirthLabel}</label>
        <p>{IDENTITY_SCREEN_COPY.dateOfBirthHint}</p>
        <input
          id={dobId}
          type="date"
          value={dateOfBirth}
          autoComplete="bday"
          aria-describedby={describedBy(dobId, dobProblem)}
          onChange={(e) => {
            setDateOfBirth(e.target.value);
            setProblems((current) => clearIdentityProblem(current, 'dateOfBirth'));
          }}
        />
        <FieldProblem id={dobId} message={dobProblem} />

        <h2>{IDENTITY_SCREEN_COPY.declarationLabel}</h2>
        <label
          htmlFor={declarationId}
          style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontWeight: 400 }}
        >
          <input
            id={declarationId}
            type="checkbox"
            checked={declarationAffirmed}
            aria-describedby={describedBy(declarationId, declarationProblem)}
            onChange={(e) => {
              setDeclarationAffirmed(e.target.checked);
              setProblems((current) => clearIdentityProblem(current, 'declaration'));
            }}
            style={{ marginTop: 4, width: 20, height: 20 }}
          />
          {/* The declaration in full, beside the control that affirms it: it is a statement being
              made, not a tick box, and a summary is not the thing the server stamps a version of. */}
          <span>{IDENTITY_ATTESTATION_STATEMENT}</span>
        </label>
        <FieldProblem id={declarationId} message={declarationProblem} />

        <div style={{ margin: '16px 0 0' }}>
          {/* `disabled` only while a request is in flight, so one click cannot become two provider
              calls. Never to express a requirement — see `submit` above. */}
          <button type="submit" className="btn" disabled={busy} aria-busy={busy}>
            {busy ? IDENTITY_SCREEN_COPY.busyLabel : IDENTITY_SCREEN_COPY.submitLabel}
          </button>
        </div>
      </form>
    </section>
  );
}

export default function IdentityPage() {
  return (
    <RequireParent>
      <IdentityCheck />
    </RequireParent>
  );
}
