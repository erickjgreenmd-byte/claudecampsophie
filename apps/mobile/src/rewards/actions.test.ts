import { describe, expect, it } from 'vitest';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import {
  askForRewardAction,
  cancelRequestAction,
  createRequestIds,
  decideRequestAction,
  loadChildRewards,
  loadRewardsOverview,
} from './actions.ts';

const REWARD = '11111111-1111-4111-8111-111111111111';
const REQUEST = '33333333-3333-4333-8333-333333333333';
const AT = '2026-09-20T15:00:00.000Z';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeApi(respond: (call: Call) => unknown): ApiClient & { calls: Call[] } {
  const calls: Call[] = [];
  // Responses pass through the real contract schema, exactly as the production client does.
  const handle = (call: Call, schema: { parse: (v: unknown) => unknown }): Promise<never> => {
    calls.push(call);
    const value = respond(call);
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(schema.parse(value) as never);
  };
  return {
    calls,
    get: (path, schema) => handle({ method: 'GET', path, body: undefined }, schema),
    send: (method, path, body, schema) => handle({ method, path, body }, schema),
  };
}

const childRequest = {
  id: REQUEST,
  rewardId: REWARD,
  rewardTitle: 'Trip to the library',
  pointCost: 10,
  state: 'pending' as const,
  requestedAt: AT,
  decidedAt: null,
  fulfilledAt: null,
};

function sequentialIds() {
  let n = 0;
  return () => {
    n += 1;
    return `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
  };
}

describe('request ids (idempotent retries, AC_REWARDS_02)', () => {
  it('reuses the id for a reward until the request is settled', () => {
    const ids = createRequestIds(sequentialIds());
    const first = ids.idFor(REWARD);
    expect(ids.idFor(REWARD)).toBe(first);
    ids.settle(REWARD);
    expect(ids.idFor(REWARD)).not.toBe(first);
  });
});

describe('child actions', () => {
  it('loads from the child endpoint only', async () => {
    const api = fakeApi(() => ({ balance: 0, rewards: [], requests: [] }));
    await loadChildRewards(api);
    expect(api.calls).toEqual([{ method: 'GET', path: '/v1/child/rewards', body: undefined }]);
  });

  it('a retry after going offline reuses the same request id; success starts fresh', async () => {
    let attempt = 0;
    const api = fakeApi(() => {
      attempt += 1;
      return attempt === 1
        ? new ApiRequestError('NETWORK', 'offline', 0)
        : { request: childRequest, balance: 2 };
    });
    const ids = createRequestIds(sequentialIds());
    const reward = { id: REWARD, title: 'Trip to the library' };
    const failed = await askForRewardAction(api, ids, reward);
    expect(failed.ok).toBe(false);
    expect(failed.message).toMatch(/offline/i);
    const ok = await askForRewardAction(api, ids, reward);
    expect(ok).toEqual({
      ok: true,
      message: 'You asked for Trip to the library! A grown-up will take a look.',
    });
    expect(api.calls.map((c) => c.path)).toEqual([
      `/v1/child/rewards/${REWARD}/request`,
      `/v1/child/rewards/${REWARD}/request`,
    ]);
    expect(api.calls[0]!.body).toEqual(api.calls[1]!.body);
    expect(ids.idFor(REWARD)).not.toBe((api.calls[1]!.body as { requestId: string }).requestId);
  });

  it('a definite answer from the server settles the id', async () => {
    const api = fakeApi(
      () => new ApiRequestError('BUSINESS_RULE', 'raw', 422, 'INSUFFICIENT_POINTS'),
    );
    const ids = createRequestIds(sequentialIds());
    const result = await askForRewardAction(api, ids, { id: REWARD, title: 'Park' });
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toMatch(/few more points/i);
    expect(ids.idFor(REWARD)).not.toBe((api.calls[0]!.body as { requestId: string }).requestId);
  });

  it('cancels through the child cancel endpoint', async () => {
    const api = fakeApi(() => ({ request: { ...childRequest, state: 'cancelled' }, balance: 12 }));
    const result = await cancelRequestAction(api, { id: REQUEST, title: 'Trip to the library' });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/points are back/i);
    expect(api.calls[0]).toMatchObject({
      method: 'POST',
      path: `/v1/child/reward-requests/${REQUEST}/cancel`,
    });
  });
});

describe('parent actions', () => {
  const parentRequest = {
    ...childRequest,
    childId: '66666666-6666-4666-8666-666666666666',
    childNickname: 'Riley',
    cancelledBy: null,
  };

  it('loads the overview and posts decisions', async () => {
    const api = fakeApi((call) =>
      call.method === 'GET'
        ? { rewards: [], children: [], openRequests: [], recentRequests: [] }
        : { request: { ...parentRequest, state: 'approved', decidedAt: AT }, balance: 2 },
    );
    await loadRewardsOverview(api);
    const result = await decideRequestAction(api, parentRequest, 'approve');
    expect(result).toEqual({
      ok: true,
      needsPin: false,
      message: 'Approved Riley’s request for Trip to the library.',
    });
    expect(api.calls[1]).toEqual({
      method: 'POST',
      path: `/v1/reward-requests/${REQUEST}/decision`,
      body: { action: 'approve' },
    });
  });

  it('asks for the parent PIN when a step-up is required', async () => {
    const api = fakeApi(() => new ApiRequestError('STEP_UP_REQUIRED', 'raw', 403));
    const result = await decideRequestAction(api, parentRequest, 'decline');
    expect(result).toMatchObject({ ok: false, needsPin: true });
    expect(result.message).toMatch(/Enter your parent PIN/);
  });
});
