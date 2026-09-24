import type {
  ParentRewardRequest,
  RewardDecisionAction,
  RewardRequestState,
  RewardsOverview,
} from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';

/**
 * Parent approvals screen logic (spec P9, P14 "requests"). Pure: no react-native imports.
 * Decisions need a recent parent-PIN step-up; the API enforces it and this module turns the
 * STEP_UP_REQUIRED answer into a clear prompt instead of a silent failure.
 */

export interface DecisionButton {
  readonly action: RewardDecisionAction;
  readonly label: string;
  readonly a11yLabel: string;
  readonly primary: boolean;
}

export interface ParentRequestCard {
  readonly id: string;
  readonly request: ParentRewardRequest;
  readonly heading: string;
  readonly detail: string;
  readonly statusLabel: string;
  readonly actions: readonly DecisionButton[];
}

export interface ParentApprovalsView {
  readonly pending: readonly ParentRequestCard[];
  readonly approved: readonly ParentRequestCard[];
  readonly balances: readonly { childId: string; label: string }[];
  readonly emptyMessage: string | null;
}

const STATUS_LABEL: Record<RewardRequestState, string> = {
  pending: 'Waiting for your decision',
  approved: 'Approved – give it when you can',
  fulfilled: 'Given',
  declined: 'Declined – points returned',
  cancelled: 'Cancelled – points returned',
};

export const DECISION_DONE: Record<RewardDecisionAction, string> = {
  approve: 'Approved',
  decline: 'Declined',
  fulfill: 'Marked as given:',
  cancel: 'Cancelled',
};

function points(n: number): string {
  return `${n} ${n === 1 ? 'point' : 'points'}`;
}

function shortDate(iso: string, timeZone: string | undefined): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(timeZone === undefined ? {} : { timeZone }),
  });
}

function card(request: ParentRewardRequest, timeZone: string | undefined): ParentRequestCard {
  const about = `${request.childNickname}’s request for ${request.rewardTitle}`;
  const actions: DecisionButton[] =
    request.state === 'pending'
      ? [
          { action: 'approve', label: 'Approve', a11yLabel: `Approve ${about}`, primary: true },
          {
            action: 'decline',
            label: 'Decline',
            a11yLabel: `Decline ${about} and return the points`,
            primary: false,
          },
        ]
      : [
          {
            action: 'fulfill',
            label: 'Mark as given',
            a11yLabel: `Mark ${about} as given`,
            primary: true,
          },
          {
            action: 'cancel',
            label: 'Cancel and return points',
            a11yLabel: `Cancel ${about} and return the points`,
            primary: false,
          },
        ];
  return {
    id: request.id,
    request,
    heading: `${request.childNickname} asked for ${request.rewardTitle}`,
    detail: `${points(request.pointCost)} · asked ${shortDate(request.requestedAt, timeZone)}`,
    statusLabel: STATUS_LABEL[request.state],
    actions,
  };
}

/** `timeZone` defaults to the device zone; tests pass 'UTC' for stable dates. */
export function buildParentApprovalsView(
  overview: RewardsOverview,
  timeZone?: string,
): ParentApprovalsView {
  const pending = overview.openRequests.filter((r) => r.state === 'pending');
  const approved = overview.openRequests.filter((r) => r.state === 'approved');
  return {
    pending: pending.map((r) => card(r, timeZone)),
    approved: approved.map((r) => card(r, timeZone)),
    balances: overview.children.map((c) => ({
      childId: c.childId,
      label: `${c.nickname}: ${points(c.balance)}`,
    })),
    emptyMessage:
      overview.openRequests.length === 0
        ? 'No requests waiting. When a child asks for a reward, it appears here.'
        : null,
  };
}

export function parentActionError(error: unknown): { needsPin: boolean; message: string } {
  if (!(error instanceof ApiRequestError))
    return { needsPin: false, message: 'Something went wrong. Please try again.' };
  const { code } = error;
  if (code === 'STEP_UP_REQUIRED')
    return { needsPin: true, message: 'Enter your parent PIN to continue, then try again.' };
  if (code === 'BUSINESS_RULE' && error.rule === 'INVALID_TRANSITION')
    return {
      needsPin: false,
      message: 'This request was already updated. Refresh to see its current status.',
    };
  if (code === 'BUSINESS_RULE') return { needsPin: false, message: error.message };
  if (code === 'NOT_FOUND')
    return { needsPin: false, message: 'This request is no longer available.' };
  if (code === 'NETWORK')
    return {
      needsPin: false,
      message: 'You appear to be offline. Try again when you’re connected.',
    };
  if (code === 'UNAUTHENTICATED')
    return { needsPin: false, message: 'Please sign in again to manage rewards.' };
  return { needsPin: false, message: 'Something went wrong. Please try again.' };
}
