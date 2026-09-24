import { describe, expect, it } from 'vitest';
import type { RewardsOverview } from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import { buildParentApprovalsView, parentActionError } from './parent-view-model.ts';

const AT = '2026-09-20T15:00:00.000Z';
const base = {
  childId: '66666666-6666-4666-8666-666666666666',
  childNickname: 'Riley',
  rewardId: '11111111-1111-4111-8111-111111111111',
  rewardTitle: 'Trip to the library',
  pointCost: 10,
  requestedAt: AT,
  decidedAt: null,
  fulfilledAt: null,
  cancelledBy: null,
};

function overview(overrides: Partial<RewardsOverview> = {}): RewardsOverview {
  return {
    rewards: [],
    children: [
      { childId: base.childId, nickname: 'Riley', balance: 2 },
      { childId: '77777777-7777-4777-8777-777777777777', nickname: 'Sam', balance: 1 },
    ],
    openRequests: [
      { ...base, id: '33333333-3333-4333-8333-333333333333', state: 'pending' },
      { ...base, id: '44444444-4444-4444-8444-444444444444', state: 'approved', decidedAt: AT },
    ],
    recentRequests: [],
    ...overrides,
  };
}

describe('parent approvals view model (spec P9, P14 requests)', () => {
  it('offers approve/decline for pending and give/cancel for approved requests', () => {
    const view = buildParentApprovalsView(overview(), 'UTC');
    expect(view.pending).toHaveLength(1);
    expect(view.approved).toHaveLength(1);
    expect(view.pending[0]!.actions.map((a) => a.action)).toEqual(['approve', 'decline']);
    expect(view.approved[0]!.actions.map((a) => a.action)).toEqual(['fulfill', 'cancel']);
    expect(view.pending[0]!.heading).toBe('Riley asked for Trip to the library');
    expect(view.pending[0]!.detail).toBe('10 points · asked Sep 20');
    expect(view.pending[0]!.statusLabel).toMatch(/waiting/i);
    for (const card of [...view.pending, ...view.approved]) {
      for (const action of card.actions) {
        expect(action.a11yLabel).toContain('Riley');
        expect(action.a11yLabel).toContain('Trip to the library');
      }
    }
  });

  it('lists balances in words and has an honest empty state', () => {
    const view = buildParentApprovalsView(overview({ openRequests: [] }), 'UTC');
    expect(view.balances.map((b) => b.label)).toEqual(['Riley: 2 points', 'Sam: 1 point']);
    expect(view.emptyMessage).toMatch(/No requests waiting/);
    expect(buildParentApprovalsView(overview(), 'UTC').emptyMessage).toBeNull();
  });

  it('maps errors, flagging when a PIN step-up is needed', () => {
    expect(parentActionError(new ApiRequestError('STEP_UP_REQUIRED', 'raw', 403))).toEqual({
      needsPin: true,
      message: 'Enter your parent PIN to continue, then try again.',
    });
    expect(
      parentActionError(new ApiRequestError('BUSINESS_RULE', 'raw', 422, 'INVALID_TRANSITION'))
        .message,
    ).toMatch(/already updated/i);
    expect(parentActionError(new ApiRequestError('NETWORK', 'raw', 0)).message).toMatch(/offline/i);
    expect(parentActionError(new ApiRequestError('NOT_FOUND', 'raw', 404)).message).toMatch(
      /no longer available/i,
    );
    expect(parentActionError(new ApiRequestError('UNAUTHENTICATED', 'raw', 401)).message).toMatch(
      /sign in/i,
    );
    expect(parentActionError(new Error('x')).needsPin).toBe(false);
  });
});
