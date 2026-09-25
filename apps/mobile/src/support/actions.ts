import {
  supportBillingPeriodsResponseSchema,
  supportCaseResponseSchema,
  supportCasesResponseSchema,
  type SupportBillingPeriod,
  type SupportCase,
  type SupportCaseDetail,
  parentSupportPolicyResponseSchema,
  type ParentSupportPolicyResponse,
} from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import {
  replySentMessage,
  supportProblem,
  validateDraft,
  validateReply,
  type CaseDraft,
  type DraftProblems,
  type SupportProblem,
} from './view-model.ts';

/**
 * API calls for the parent Support screen (/v1/support/*). Pure: no react-native imports. The
 * family and the author are derived server-side from the parent's session; failures become calm
 * parent copy keyed on stable codes (view-model.ts), never on server text.
 */

export function loadSupportCases(api: ApiClient): Promise<SupportCase[]> {
  return api.get('/v1/support/cases', supportCasesResponseSchema).then((r) => r.cases);
}

export function loadBillingPeriods(api: ApiClient): Promise<SupportBillingPeriod[]> {
  return api
    .get('/v1/support/billing-periods', supportBillingPeriodsResponseSchema)
    .then((r) => r.periods);
}

/** The owner's refund window and response targets (Owner action #32); wording comes from the API. */
export function loadSupportPolicy(api: ApiClient): Promise<ParentSupportPolicyResponse> {
  return api.get('/v1/support/policy', parentSupportPolicyResponseSchema);
}

export function loadSupportCase(api: ApiClient, id: string): Promise<SupportCaseDetail> {
  return api
    .get(`/v1/support/cases/${encodeURIComponent(id)}`, supportCaseResponseSchema)
    .then((r) => r.case);
}

export type OpenCaseResult =
  | { readonly ok: true; readonly detail: SupportCaseDetail; readonly message: string }
  | { readonly ok: false; readonly reason: 'fields'; readonly problems: DraftProblems }
  | { readonly ok: false; readonly reason: 'request'; readonly problem: SupportProblem };

/** Validates locally first (the server checks again), then opens the case. */
export async function openSupportCase(api: ApiClient, draft: CaseDraft): Promise<OpenCaseResult> {
  const checked = validateDraft(draft);
  if (!checked.ok) return { ok: false, reason: 'fields', problems: checked.problems };
  try {
    const { case: detail } = await api.send(
      'POST',
      '/v1/support/cases',
      checked.body,
      supportCaseResponseSchema,
    );
    return {
      ok: true,
      detail,
      message: 'Your case is open. We’ll reply here, and you can add to it any time.',
    };
  } catch (error) {
    return { ok: false, reason: 'request', problem: supportProblem(error, 'open') };
  }
}

export type ReplyResult =
  | { readonly ok: true; readonly detail: SupportCaseDetail; readonly message: string }
  | { readonly ok: false; readonly problem: SupportProblem };

/**
 * Adds the parent's reply. `previousStatus` is the status the screen showed, so the confirmation
 * can say when the reply put a resolved or waiting case back with the team.
 */
export async function replyToCase(
  api: ApiClient,
  id: string,
  message: string,
  previousStatus: SupportCase['status'],
): Promise<ReplyResult> {
  const checked = validateReply(message);
  if (!checked.ok) {
    return { ok: false, problem: { message: checked.problem, needsPin: false, noFamily: false } };
  }
  try {
    const { case: detail } = await api.send(
      'POST',
      `/v1/support/cases/${encodeURIComponent(id)}/messages`,
      checked.body,
      supportCaseResponseSchema,
    );
    return { ok: true, detail, message: replySentMessage(previousStatus, detail.status) };
  } catch (error) {
    return { ok: false, problem: supportProblem(error, 'reply') };
  }
}
