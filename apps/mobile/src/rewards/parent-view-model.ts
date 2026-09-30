import {
  rewardBalanceStatusNote,
  type ParentRewardRequest,
  type RewardChildBalance,
  type RewardDecisionAction,
  type RewardRequestState,
  type RewardsOverview,
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

/**
 * One line of the Balances list: the nickname, the points, and — unless the profile is active — the
 * note that says the number is a closed total.
 *
 * GET /v1/rewards returns every profile's balance, archived and draft included (spec P11), and this
 * list printed all of them as a bare "Jordan: 30 points" while the portal printed a status beside
 * the same number. The note is `rewardBalanceStatusNote` in packages/contracts/src/family.ts, which
 * the portal's `BalancesSection` (apps/web/src/pages/app/RewardsPage.tsx) calls too and neither
 * surface shadows; its docblock holds the evidence that nothing can be added to a non-active
 * profile's total from the child's side.
 *
 * The note goes INSIDE `label` rather than into a field of its own because the screen prints one
 * `Text` per balance (`{b.label}`, app/(parent)/rewards.tsx): a second field is a field the screen
 * can silently not render, and not rendering it is the defect this closes.
 */
function balanceLine(child: RewardChildBalance): { childId: string; label: string } {
  const note = rewardBalanceStatusNote(child);
  const line = `${child.nickname}: ${points(child.balance)}`;
  return { childId: child.childId, label: note === null ? line : `${line} ${note}` };
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
    balances: overview.children.map((c) => balanceLine(c)),
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
      message: 'This request was already updated. The list now shows where it is.',
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
