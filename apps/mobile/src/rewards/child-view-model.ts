import type { ChildRewards, RewardRequestState } from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';

/**
 * Child rewards screen logic (spec P9, P14 "progress/rewards"). Pure: no react-native imports.
 *
 * Copy rules for child-facing text: calm and encouraging, points are never described as money,
 * and nothing here mentions cash, wallets, buying or shopping. Reward titles and instructions are
 * written by the child's parent and are shown as-is.
 */

/** Words that must never appear in copy this module generates for a child. */
export const CHILD_COPY_FORBIDDEN =
  /\$|\b(cash|money|wallet|dollars?|buy|bought|purchase|pay|paid|spend|price|shop|store|sale|coins?)\b/i;

export interface ChildRewardCard {
  readonly id: string;
  readonly title: string;
  readonly instructions: string | null;
  readonly costLabel: string;
  /** 0..1 share of the cost the child already has (shown as a bar plus text, never colour alone). */
  readonly progress: number;
  readonly progressLabel: string;
  readonly canAsk: boolean;
  readonly askLabel: string;
  readonly askA11yLabel: string;
}

export interface ChildRequestRow {
  readonly id: string;
  readonly title: string;
  readonly statusLabel: string;
  readonly canCancel: boolean;
  readonly cancelLabel: string;
  readonly cancelA11yLabel: string;
}

export interface ChildRewardsView {
  readonly balanceLabel: string;
  readonly encouragement: string;
  readonly rewards: readonly ChildRewardCard[];
  readonly requests: readonly ChildRequestRow[];
  readonly emptyRewardsMessage: string | null;
  readonly emptyRequestsMessage: string | null;
}

export function pointsText(points: number): string {
  return `${points} ${points === 1 ? 'point' : 'points'}`;
}

const STATUS_LABEL: Record<RewardRequestState, string> = {
  pending: 'Asked – waiting for a grown-up',
  approved: 'A grown-up said yes! It’s coming soon',
  fulfilled: 'You got this reward. Enjoy!',
  declined: 'Not this time – your points are back',
  cancelled: 'Cancelled – your points are back',
};

export function buildChildRewardsView(data: ChildRewards): ChildRewardsView {
  const { balance } = data;
  const rewards = data.rewards.map((reward): ChildRewardCard => {
    const canAsk = balance >= reward.pointCost;
    const missing = reward.pointCost - balance;
    return {
      id: reward.id,
      title: reward.title,
      instructions: reward.instructions,
      costLabel: pointsText(reward.pointCost),
      progress: canAsk ? 1 : Math.max(0, Math.min(1, balance / reward.pointCost)),
      progressLabel: canAsk
        ? 'You have enough points to ask!'
        : `${missing} more ${missing === 1 ? 'point' : 'points'} to go`,
      canAsk,
      askLabel: 'Ask for this',
      askA11yLabel: `Ask a grown-up for ${reward.title}. It needs ${pointsText(reward.pointCost)}.`,
    };
  });
  const requests = data.requests.map((request): ChildRequestRow => {
    const title = request.rewardTitle ?? 'A reward';
    return {
      id: request.id,
      title,
      statusLabel: STATUS_LABEL[request.state],
      canCancel: request.state === 'pending',
      cancelLabel: 'Cancel request',
      cancelA11yLabel: `Cancel your request for ${title}. Your points come back.`,
    };
  });
  return {
    balanceLabel: `You have ${pointsText(balance)}`,
    // Decision (RV-rewards-5): awards are capped per question and per set (spec P9), so the copy
    // says finished practice *can* earn points and never promises points for every attempt.
    encouragement:
      balance === 0
        ? 'Finishing your practice can earn points. You’ve got this!'
        : 'Great work! Keep practicing to reach your next reward.',
    rewards,
    requests,
    emptyRewardsMessage:
      rewards.length === 0 ? 'No rewards yet. Ask a grown-up to add one for you!' : null,
    emptyRequestsMessage:
      requests.length === 0 ? 'When you ask for a reward, you’ll see it here.' : null,
  };
}

/** Calm, generic child copy for API failures (never shows raw server text). */
export function childRewardsErrorMessage(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return 'Something went wrong. Please try again.';
  const { code, rule } = error;
  if (code === 'UNAUTHENTICATED')
    return 'This device needs to be connected again. Ask a grown-up to help.';
  if (code === 'NETWORK') return 'Looks like we’re offline. Your points are safe – try again soon.';
  if (code === 'BUSINESS_RULE' && rule === 'INSUFFICIENT_POINTS')
    return 'You need a few more points for this one. Keep practicing!';
  if (code === 'BUSINESS_RULE' && rule === 'INVALID_TRANSITION')
    return 'A grown-up is already looking at this request.';
  if (code === 'NOT_FOUND') return 'That reward isn’t available right now.';
  if (code === 'RATE_LIMITED') return 'Let’s take a little break and try again soon.';
  return 'Something went wrong. Please try again.';
}
