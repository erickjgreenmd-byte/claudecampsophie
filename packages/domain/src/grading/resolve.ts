/**
 * Final grading decision from deterministic evidence plus model judgments (spec P5: "Model
 * confidence is advisory ... Independent verification and deterministic checks decide acceptance;
 * disagreements go to a stronger model or parent review. Escalation limits cannot silently convert
 * uncertainty into 'wrong'." AC_GRADING_04).
 *
 * Rules, in order:
 * 1. A decisive deterministic result (correct/incorrect) is final. Any model voting the other way
 *    is flagged as a disagreement but cannot override it, whatever its confidence.
 * 2. Otherwise acceptance needs two independent agreeing judgments: primary + verifier agreeing
 *    with confidence >= threshold (and no escalation contradicting them), or an escalation verdict
 *    that corroborates the primary or the verifier.
 * 3. An unsettled item (disagreement, abstention, low confidence) with no escalation result is
 *    sent to escalation while budget remains, else to parent review.
 * 4. If every judge abstains there is nothing to corroborate: the item stays `unresolved` and goes
 *    to a grown-up, without spending escalation budget.
 * Confidence is only ever used to be MORE cautious; it never picks a side.
 */

export type ModelVerdict = 'correct' | 'incorrect' | 'unresolved';
export type DeterministicVerdict = 'correct' | 'incorrect' | 'unresolved';

export interface ModelJudgment {
  readonly verdict: ModelVerdict;
  /** Model-reported confidence in [0, 1]; advisory only. */
  readonly confidence: number;
}

export interface ResolveGradingInput {
  readonly deterministic?: DeterministicVerdict;
  readonly primary: ModelJudgment;
  readonly verifier?: ModelJudgment;
  readonly escalation?: { readonly verdict: ModelVerdict };
  readonly escalationBudgetRemaining: number;
  /** Default DEFAULT_LOW_CONFIDENCE_THRESHOLD. */
  readonly lowConfidenceThreshold?: number;
}

export type FinalVerdict = 'correct' | 'incorrect' | 'unresolved' | 'needs_parent_review';
export type ResolutionRoute = 'deterministic' | 'agreement' | 'escalated' | 'parent_review';

export interface GradingResolution {
  readonly final: FinalVerdict;
  readonly route: ResolutionRoute;
  /** Decisive evidence exists on both sides (deterministic or model). */
  readonly disagreement: boolean;
  /** route 'escalated' with final 'unresolved': run the stronger model, then resolve again. */
  readonly awaitingEscalation: boolean;
}

/**
 * Decision: primary/verifier agreement below 0.5 reported confidence is not accepted on its own
 * (escalate or parent review). Callers may raise the threshold; lowering it cannot make a single
 * judgment decisive.
 */
export const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.5;

type Decisive = 'correct' | 'incorrect';

function isDecisive(verdict: string | undefined): verdict is Decisive {
  return verdict === 'correct' || verdict === 'incorrect';
}

/** Model output is untrusted: NaN, infinities and out-of-range values count as no confidence. */
function confident(judgment: ModelJudgment, threshold: number): boolean {
  const c = judgment.confidence;
  return Number.isFinite(c) && c >= 0 && c <= 1 && c >= threshold;
}

function resolution(
  final: FinalVerdict,
  route: ResolutionRoute,
  disagreement: boolean,
  awaitingEscalation = false,
): GradingResolution {
  return { final, route, disagreement, awaitingEscalation };
}

export function resolveGrading(input: ResolveGradingInput): GradingResolution {
  const threshold = input.lowConfidenceThreshold ?? DEFAULT_LOW_CONFIDENCE_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError('lowConfidenceThreshold must be within [0, 1]');
  }
  const { deterministic, primary, verifier, escalation } = input;
  const votes = [deterministic, primary.verdict, verifier?.verdict, escalation?.verdict].filter(
    isDecisive,
  );
  const disagreement = votes.includes('correct') && votes.includes('incorrect');

  if (isDecisive(deterministic)) return resolution(deterministic, 'deterministic', disagreement);

  if (
    verifier !== undefined &&
    isDecisive(primary.verdict) &&
    primary.verdict === verifier.verdict &&
    confident(primary, threshold) &&
    confident(verifier, threshold)
  ) {
    if (isDecisive(escalation?.verdict) && escalation.verdict !== primary.verdict) {
      return resolution('needs_parent_review', 'parent_review', disagreement);
    }
    return resolution(primary.verdict, 'agreement', disagreement);
  }

  if (escalation !== undefined) {
    const corroborated =
      isDecisive(escalation.verdict) &&
      (primary.verdict === escalation.verdict || verifier?.verdict === escalation.verdict);
    return corroborated
      ? resolution(escalation.verdict, 'escalated', disagreement)
      : resolution('needs_parent_review', 'parent_review', disagreement);
  }

  if (!isDecisive(primary.verdict) && !isDecisive(verifier?.verdict)) {
    return resolution('unresolved', 'parent_review', disagreement);
  }
  // Decision: a missing verifier is not a disagreement; the primary alone is never accepted and
  // paid escalation is not used as a substitute for verification.
  if (verifier === undefined)
    return resolution('needs_parent_review', 'parent_review', disagreement);
  if (input.escalationBudgetRemaining > 0) {
    return resolution('unresolved', 'escalated', disagreement, true);
  }
  return resolution('needs_parent_review', 'parent_review', disagreement);
}
