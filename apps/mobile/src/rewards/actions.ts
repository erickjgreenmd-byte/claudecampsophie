import {
  childRewardRequestResponseSchema,
  childRewardsResponseSchema,
  rewardDecisionResponseSchema,
  rewardsOverviewResponseSchema,
  type ChildRewards,
  type ParentRewardRequest,
  type RewardDecisionAction,
  type RewardsOverview,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { childRewardsErrorMessage } from './child-view-model.ts';
import { DECISION_DONE, parentActionError } from './parent-view-model.ts';

/**
 * API calls and action outcomes for the rewards screens. Pure (no react-native), so the screens
 * stay thin and this behaviour is unit-tested. There is intentionally no call that earns points.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };
export type ParentActionResult = { ok: boolean; needsPin: boolean; message: string };

/**
 * Client-generated request ids per reward. A retry after a lost response reuses the id, so the
 * server's idempotent `child_request_reward` never reserves points twice for one tap.
 */
export interface RequestIds {
  idFor(rewardId: string): string;
  settle(rewardId: string): void;
}

export function createRequestIds(generate: () => string): RequestIds {
  const inFlight = new Map<string, string>();
  return {
    idFor(rewardId) {
      let id = inFlight.get(rewardId);
      if (id === undefined) {
        id = generate();
        inFlight.set(rewardId, id);
      }
      return id;
    },
    settle(rewardId) {
      inFlight.delete(rewardId);
    },
  };
}

/**
 * Decision: keep the id when the outcome is unknown (offline, or a 5xx that may have committed) so a
 * retry is idempotent; settle it once the server gave a definite answer (success or a 4xx).
 */
function outcomeIsDefinite(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status >= 400 && error.status < 500;
}

export function loadChildRewards(api: ApiClient): Promise<ChildRewards> {
  return api.get('/v1/child/rewards', childRewardsResponseSchema);
}

export async function askForRewardAction(
  api: ApiClient,
  ids: RequestIds,
  reward: { id: string; title: string },
): Promise<ActionResult> {
  const requestId = ids.idFor(reward.id);
  try {
    await api.send(
      'POST',
      `/v1/child/rewards/${encodeURIComponent(reward.id)}/request`,
      { requestId },
      childRewardRequestResponseSchema,
    );
    ids.settle(reward.id);
    return { ok: true, message: `You asked for ${reward.title}! A grown-up will take a look.` };
  } catch (error) {
    if (outcomeIsDefinite(error)) ids.settle(reward.id);
    return { ok: false, message: childRewardsErrorMessage(error) };
  }
}

export async function cancelRequestAction(
  api: ApiClient,
  request: { id: string; title: string },
): Promise<ActionResult> {
  try {
    await api.send(
      'POST',
      `/v1/child/reward-requests/${encodeURIComponent(request.id)}/cancel`,
      undefined,
      childRewardRequestResponseSchema,
    );
    return { ok: true, message: `Cancelled. Your points are back.` };
  } catch (error) {
    return { ok: false, message: childRewardsErrorMessage(error) };
  }
}

export function loadRewardsOverview(api: ApiClient): Promise<RewardsOverview> {
  return api.get('/v1/rewards', rewardsOverviewResponseSchema);
}

export async function decideRequestAction(
  api: ApiClient,
  request: ParentRewardRequest,
  action: RewardDecisionAction,
): Promise<ParentActionResult> {
  try {
    await api.send(
      'POST',
      `/v1/reward-requests/${encodeURIComponent(request.id)}/decision`,
      { action },
      rewardDecisionResponseSchema,
    );
    return {
      ok: true,
      needsPin: false,
      message: `${DECISION_DONE[action]} ${request.childNickname}’s request for ${request.rewardTitle}.`,
    };
  } catch (error) {
    return { ok: false, ...parentActionError(error) };
  }
}
