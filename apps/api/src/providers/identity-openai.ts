import {
  PROMPTS,
  dataEnvelope,
  imagePart,
  PROPOSED_STAGE_LIMITS,
  runStage,
  type InputPart,
  type ResponsesClient,
} from '@pencillift/ai';
import { validateZdrEvidence, type ZdrEvidence } from '@pencillift/ai';
import { DEFAULT_RATE_TABLE_2026_09_18, type ModelRateTable } from '@pencillift/domain/quotas';
import type { IdentityFailureCode } from '@pencillift/contracts';
import { inputTokenUpperBound } from '../jobs/spend-ceiling.ts';
import {
  isAdultOn,
  type IdentityCheckInput,
  type IdentityCheckResult,
  type IdentityProvider,
} from './identity.ts';

/**
 * The adult ID check against OpenAI's vision model (migration 0980).
 *
 * WHAT THIS ADAPTER CAN AND CANNOT DO, stated here because the difference decides whether a family can
 * finish signing up:
 *
 *   * IT CAN establish ADULTHOOD. It sends the document image and asks whether it is a genuine
 *     government photo ID, whether it is readable, and what its printed date of birth and expiry are.
 *     That is document transcription, which is what this model is for and what the homework path
 *     already uses it for. The server does the arithmetic on both dates against its own clock, so no
 *     model does date maths and neither date is kept.
 *
 *   * IT CANNOT establish SAME PERSON. Comparing a selfie to the portrait on an ID is biometric
 *     identification. OpenAI's usage policies prohibit it and the vision models decline the question.
 *     This adapter ASKS ANYWAY — once, through `PROMPTS.identity_face_compare` — and records whatever
 *     comes back, so the refusal appears in this deployment's own audit trail rather than resting on
 *     this comment. A declined or unparseable comparison is recorded as `refused`, and because
 *     `adult_confirmed` is GENERATED in migration 0980 and requires `matched`, no configuration and no
 *     later code change can read that as a pass.
 *
 * So `canCompareFaces` is FALSE here, and a deployment with only this adapter cannot confirm an adult.
 * That is the honest state of affairs, not a bug: the flow tells the parent the check cannot be
 * completed on our side (FACE_CHECK_UNAVAILABLE) rather than blaming their photograph. To confirm
 * adults, configure an identity vendor — the FTC approved face-match-to-photo-ID as a COPPA method in
 * 2023, and vendors implement it with liveness detection and human review, which is also what carries
 * the biometric-law exposure that doing it here would put on PencilLift.
 *
 * ZERO RETENTION IS A PRECONDITION, not a preference. A government photo ID sent to a provider that
 * retains inputs is an adult's identity document sitting in someone else's logs for their retention
 * window. The child-data gate does not cover this — an adult's licence is not child personal data — so
 * this adapter applies the same ZDR evidence check on its own account and refuses to send anything
 * without it. `PROVIDER_ERROR` is what the parent sees; the log says which.
 *
 * NOTHING IS STORED OR LOGGED. The images live in the argument, go into the request, and are gone when
 * this function returns. No branch writes them, logs them, or returns them, and nothing off the
 * document — name, number, either date — leaves this function: the result is three booleans, an enum
 * and a reference string built from the document KIND alone.
 */
export function createOpenAiIdentityProvider(options: {
  readonly ai: ResponsesClient;
  readonly zdrEvidence: ZdrEvidence | null;
  readonly environment: 'development' | 'test' | 'staging' | 'production';
  readonly rates?: ModelRateTable;
  readonly log?: (entry: { level: 'info' | 'warn'; event: string; code?: string }) => void;
}): IdentityProvider {
  const rates = options.rates ?? DEFAULT_RATE_TABLE_2026_09_18;
  const log = options.log ?? (() => undefined);
  return {
    name: 'openai_document',
    isMock: options.ai.isMock,
    // The one claim this adapter cannot make. See the block above.
    canCompareFaces: false,
    async check(input: IdentityCheckInput): Promise<IdentityCheckResult> {
      const zdr = validateZdrEvidence(options.zdrEvidence, input.now);
      if (!zdr.ok) {
        log({ level: 'warn', event: 'identity_zdr_missing', code: zdr.error.code });
        return refused('PROVIDER_ERROR', 'not_attempted', null);
      }

      // ---- 1. the document ----
      const docInput: InputPart[] = [
        dataEnvelope({ purpose: 'adult_age_check' }),
        imagePart(input.document.mimeType, input.document.base64, 'high'),
      ];
      const read = await runStage({
        prompt: PROMPTS.identity_document,
        input: docInput,
        client: options.ai,
        limits: PROPOSED_STAGE_LIMITS.identity_document,
        rates,
        gate: {
          // An adult's own government photo ID is not CHILD personal data, so the child-data gate does
          // not apply to it and saying otherwise would make that gate mean two things. The ZDR
          // requirement still does apply, for a different and equally strong reason — an identity
          // document in a provider's retention window is an identity document in someone else's logs —
          // so it is enforced ABOVE, on this adapter's own account, before any image is sent. That check
          // is the one that must never be removed here; this `false` is not a licence to skip it.
          containsChildPersonalData: false,
          ageBand: null,
          zdrEvidence: options.zdrEvidence,
          environment: options.environment,
          now: input.now,
        },
        metadata: { stage: 'identity_document' },
        estimatedInputTokens: inputTokenUpperBound(PROMPTS.identity_document, docInput),
      });
      if (!read.result.ok) {
        log({ level: 'warn', event: 'identity_document_failed', code: read.result.error.code });
        return refused('PROVIDER_ERROR', 'not_attempted', null);
      }
      const doc = read.result.value;
      const reference = `openai:${doc.documentKind}`;
      if (!doc.readable) return refused('DOCUMENT_UNREADABLE', 'not_attempted', reference);
      if (!doc.isGovernmentPhotoId) {
        return refused('NOT_A_GOVERNMENT_ID', 'not_attempted', reference);
      }
      // An expired document proves nothing about who is holding it today.
      if (doc.expiryDate !== null && doc.expiryDate < isoDay(input.now)) {
        return {
          documentIsGovernmentId: true,
          documentHolderIsAdult: false,
          faceMatch: 'not_attempted',
          failureCode: 'DOCUMENT_EXPIRED',
          providerReference: reference,
        };
      }
      if (doc.dateOfBirth === null) {
        return refused('DOCUMENT_UNREADABLE', 'not_attempted', reference);
      }
      // The stated date is CHECKED, not trusted: a mismatch is the cheapest signal that the document
      // belongs to someone else. Compared as strings because both are calendar dates in one format.
      if (doc.dateOfBirth !== input.statedDateOfBirth) {
        return {
          documentIsGovernmentId: true,
          documentHolderIsAdult: isAdultOn(doc.dateOfBirth, input.now),
          faceMatch: 'not_attempted',
          failureCode: 'DOB_MISMATCH',
          providerReference: reference,
        };
      }
      const holderIsAdult = isAdultOn(doc.dateOfBirth, input.now);
      if (!holderIsAdult) {
        return {
          documentIsGovernmentId: true,
          documentHolderIsAdult: false,
          faceMatch: 'not_attempted',
          failureCode: 'NOT_AN_ADULT',
          providerReference: reference,
        };
      }

      // ---- 2. the face comparison, asked and recorded ONLY when a selfie was sent ----
      // Since migration 0990 the product's standard is the document plus the holder's legal
      // declaration, so no selfie is collected and this second call does not happen: one provider
      // round trip per verification instead of two, and the measured `identity_face_compare` stage
      // (15,000 micro-USD of budget) is never spent. 'not_attempted' is the honest answer to a
      // question nobody asked — distinct from 'refused', which is what this adapter answers when the
      // comparison IS requested and the provider's policy declines it.
      const faceMatch =
        input.selfie === undefined ? ('not_attempted' as const) : await compareFaces(input);
      return {
        documentIsGovernmentId: true,
        documentHolderIsAdult: true,
        faceMatch,
        // 'matched' is unreachable through this adapter; the branch exists so that the day a provider
        // here CAN answer it, the result is already correct rather than needing a second edit.
        failureCode: faceMatch === 'matched' ? null : faceCode(faceMatch),
        providerReference: reference,
      };

      async function compareFaces(
        args: IdentityCheckInput,
      ): Promise<IdentityCheckResult['faceMatch']> {
        const faceInput: InputPart[] = [
          dataEnvelope({ purpose: 'adult_age_check_with_consent' }),
          imagePart(args.document.mimeType, args.document.base64, 'high'),
          // Only reached with a selfie present: the caller above checks, and this narrows it for the
          // compiler rather than asserting with `!` — an assertion would still compile the day someone
          // calls this directly.
          ...(args.selfie === undefined
            ? []
            : [imagePart(args.selfie.mimeType, args.selfie.base64, 'high')]),
        ];
        const out = await runStage({
          prompt: PROMPTS.identity_face_compare,
          input: faceInput,
          client: options.ai,
          limits: PROPOSED_STAGE_LIMITS.identity_face_compare,
          rates,
          gate: {
            // As above: an adult's ID is not child data, and the ZDR precondition is enforced by this
            // adapter before either call.
            containsChildPersonalData: false,
            ageBand: null,
            zdrEvidence: options.zdrEvidence,
            environment: options.environment,
            now: args.now,
          },
          metadata: { stage: 'identity_face_compare' },
          estimatedInputTokens: inputTokenUpperBound(PROMPTS.identity_face_compare, faceInput),
        });
        if (!out.result.ok) {
          // A policy refusal arrives in one of two shapes, and neither is an outage: the provider
          // REJECTS the request outright (`PROVIDER_REJECTED`, its 400/415/422 path), or it answers with
          // prose instead of the schema (`OUTPUT_INVALID`). Both are recorded as `refused`, because
          // `error` would suggest a retry is worth something and it is not — the same request will be
          // refused again. A transport failure or a truncated answer stays `error`.
          const code = out.result.error.code;
          log({ level: 'info', event: 'identity_face_compare_unavailable', code });
          return code === 'PROVIDER_REJECTED' || code === 'OUTPUT_INVALID' ? 'refused' : 'error';
        }
        switch (out.result.value.verdict) {
          case 'same_person':
            return 'matched';
          case 'different_person':
            return 'not_matched';
          case 'cannot_tell':
            // The provider compared them and could not decide. Recorded as itself rather than folded
            // into 'not_matched' (which would assert a finding it did not make) or 'refused' (which
            // would assert a decline it did not make). It is the one non-pass a better selfie may fix.
            return 'inconclusive';
          case 'declined':
            return 'refused';
        }
      }
    },
  };
}

/** A refusal with no adult established. */
function refused(
  failureCode: IdentityFailureCode,
  faceMatch: IdentityCheckResult['faceMatch'],
  providerReference: string | null,
): IdentityCheckResult {
  return {
    documentIsGovernmentId: false,
    documentHolderIsAdult: false,
    faceMatch,
    failureCode,
    providerReference,
  };
}

/** The parent-facing code for a face comparison that did not match. */
function faceCode(faceMatch: IdentityCheckResult['faceMatch']): IdentityFailureCode {
  // The split is by WHOSE problem it is, which decides whether the parent is offered a retry at all.
  // A judgement about the photographs — they are different people, or the comparison could not decide —
  // is the parent's to act on with a better selfie. Everything else (declined, not attempted, failed)
  // is ours, and saying otherwise would send them to retake a photo that was never the problem.
  return faceMatch === 'not_matched' || faceMatch === 'inconclusive'
    ? 'FACE_NOT_CONFIRMED'
    : 'FACE_CHECK_UNAVAILABLE';
}

/** `YYYY-MM-DD` for the application's clock, in UTC, to compare against a printed calendar date. */
function isoDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// The data URL is built inside `imagePart` from the DECLARED mime type and the base64, so a client
// cannot declare one type in `mimeType` and embed another inside a URL it supplied itself.
