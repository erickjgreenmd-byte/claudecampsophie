import {
  billingStatusResponseSchema,
  capacityChangeResponseSchema,
  familyOverviewResponseSchema,
  type BillingStatus,
  type CapacityChangeRequest,
  type CapacityChangeResponse,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';

/**
 * API calls for the parent plan screen (spec P11). Pure: no react-native imports. Failures become
 * calm, specific parent messages keyed on stable codes, never on raw server text for unknown errors.
 */

export interface BillingProblem {
  readonly message: string;
  /** The server wants a fresh parent PIN step-up (STEP_UP_REQUIRED). */
  readonly needsPin: boolean;
  /** The caller has no family yet. */
  readonly noFamily: boolean;
}

const RULE_MESSAGES: Readonly<Record<string, string>> = {
  NOT_AN_UPGRADE: 'Your plan already covers that many children. Choose a larger plan.',
  NOT_A_DOWNGRADE: 'Choose a plan with fewer children than your current plan.',
  KEEP_SELECTION_REQUIRED: 'Choose which children stay active on the smaller plan.',
  KEEP_NOT_ACTIVE: 'Only children who are active now can stay active on the smaller plan.',
  TOO_MANY_KEPT: 'The smaller plan can’t keep that many children active.',
  SUBSCRIPTION_BOUND_ELSEWHERE:
    'This store subscription is linked to a different PencilLift family. Contact support to move it.',
};

/** Codes whose server message is written for an adult and safe to show as-is. */
const SERVER_WORDED = new Set([
  'RATE_LIMITED',
  'NETWORK',
  'UNAUTHENTICATED',
  'PROVIDER_UNAVAILABLE',
  'NOT_CONFIGURED',
]);

export function billingProblem(error: unknown): BillingProblem {
  const problem = (message: string, extra: Partial<BillingProblem> = {}): BillingProblem => ({
    message,
    needsPin: false,
    noFamily: false,
    ...extra,
  });
  if (!(error instanceof ApiRequestError)) {
    return problem('Something went wrong. Please try again.');
  }
  if (error.code === 'STEP_UP_REQUIRED') {
    return problem('Unlock with your parent PIN to change your plan, then try again.', {
      needsPin: true,
    });
  }
  if (error.code === 'CHILD_MODE_FORBIDDEN') {
    return problem('Plans can only be changed by a grown-up.');
  }
  if (error.code === 'NOT_FOUND') {
    return problem('Create your family first, then come back to choose a plan.', {
      noFamily: true,
    });
  }
  if (error.code === 'BUSINESS_RULE') {
    return problem((error.rule ? RULE_MESSAGES[error.rule] : undefined) ?? error.message);
  }
  return problem(
    SERVER_WORDED.has(error.code) ? error.message : 'Something went wrong. Please try again.',
  );
}

export function loadBillingStatus(api: ApiClient): Promise<BillingStatus> {
  return api.get('/v1/billing/status', billingStatusResponseSchema);
}

/** Asks the server to fetch the provider's current state. The server ignores any client claim. */
export function syncBilling(api: ApiClient): Promise<BillingStatus> {
  return api.send('POST', '/v1/billing/sync', undefined, billingStatusResponseSchema);
}

/** Records the parent's intent (server step-up). It never changes paid capacity by itself. */
export function requestCapacityChange(
  api: ApiClient,
  body: CapacityChangeRequest,
): Promise<CapacityChangeResponse> {
  return api.send('POST', '/v1/billing/capacity-changes', body, capacityChangeResponseSchema);
}

export interface ActiveChild {
  readonly id: string;
  readonly nickname: string;
}

/** Children holding a paid slot today (candidates to keep on a smaller plan). */
export async function loadActiveChildren(api: ApiClient): Promise<ActiveChild[]> {
  const family = await api.get('/v1/family', familyOverviewResponseSchema);
  return family.children
    .filter((child) => child.status === 'active')
    .map((child) => ({ id: child.id, nickname: child.nickname }));
}
