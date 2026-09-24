import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '@pencillift/contracts/client';
import {
  billingProblem,
  loadActiveChildren,
  loadBillingStatus,
  requestCapacityChange,
  syncBilling,
} from './actions.ts';
import { billingStatus, fakeApi, RILEY, SAM } from './testing.ts';

describe('billingProblem maps stable codes to parent messages', () => {
  it('asks for the PIN on STEP_UP_REQUIRED', () => {
    const p = billingProblem(new ApiRequestError('STEP_UP_REQUIRED', 'x', 403));
    expect(p).toMatchObject({ needsPin: true, noFamily: false });
    expect(p.message).toMatch(/parent PIN/);
  });

  it.each([
    ['NOT_AN_UPGRADE', /already covers/],
    ['KEEP_SELECTION_REQUIRED', /Choose which children stay active/],
    ['TOO_MANY_KEPT', /can’t keep that many/],
    ['SUBSCRIPTION_BOUND_ELSEWHERE', /different PencilLift family/],
  ])('%s', (rule, message) => {
    expect(
      billingProblem(new ApiRequestError('BUSINESS_RULE', 'server text', 422, rule)).message,
    ).toMatch(message);
  });

  it('shows the server’s concrete report for a price or keep-selection refusal', () => {
    const price =
      'The App Store charges $49.99 per month for 2 children, which isn’t PencilLift’s approved price of $49.98. This plan can’t be bought there until the store price matches.';
    expect(
      billingProblem(new ApiRequestError('BUSINESS_RULE', price, 422, 'STORE_PRICE_NOT_APPROVED'))
        .message,
    ).toBe(price);
    const keep = 'Choose 2 children to keep active on the smaller plan.';
    expect(
      billingProblem(new ApiRequestError('BUSINESS_RULE', keep, 422, 'KEEP_SELECTION_INCOMPLETE'))
        .message,
    ).toBe(keep);
  });

  it('shows adult-worded server text only for known codes', () => {
    expect(
      billingProblem(
        new ApiRequestError('PROVIDER_UNAVAILABLE', 'We couldn’t reach the store', 503),
      ).message,
    ).toBe('We couldn’t reach the store');
    expect(billingProblem(new ApiRequestError('INTERNAL', 'SQL leaked', 500)).message).toBe(
      'Something went wrong. Please try again.',
    );
    expect(billingProblem(new ApiRequestError('NOT_FOUND', 'x', 404)).noFamily).toBe(true);
    expect(billingProblem(new Error('x')).message).toBe('Something went wrong. Please try again.');
    expect(billingProblem(new ApiRequestError('CHILD_MODE_FORBIDDEN', 'x', 403)).message).toMatch(
      /grown-up/,
    );
  });
});

describe('billing API calls', () => {
  it('status and sync use the contract; sync sends no client claim', async () => {
    const { api, calls } = fakeApi(() => billingStatus({ paidSlots: 1 }));
    expect((await loadBillingStatus(api)).paidSlots).toBe(1);
    expect((await syncBilling(api)).paidSlots).toBe(1);
    expect(calls).toEqual([
      { method: 'GET', path: '/v1/billing/status', body: undefined },
      { method: 'POST', path: '/v1/billing/sync', body: undefined },
    ]);
  });

  it('a response with an extra private field is rejected by the strict contract', async () => {
    const { api } = fakeApi(() => ({ ...billingStatus(), familyId: RILEY }));
    await expect(loadBillingStatus(api)).rejects.toThrow();
  });

  it('capacity changes post the parent’s choice', async () => {
    const { api, calls } = fakeApi(() => ({
      id: '9c4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b',
      kind: 'downgrade',
      fromSlots: 2,
      toSlots: 1,
      keepChildIds: [RILEY],
      status: 'scheduled',
      currentRecurringCents: 4998,
      newRecurringCents: 3999,
      nextStep: 'change_in_store',
      createdAt: '2026-09-24T15:00:00.000Z',
    }));
    const res = await requestCapacityChange(api, {
      kind: 'downgrade',
      toSlots: 1,
      keepChildIds: [RILEY],
    });
    expect(res.status).toBe('scheduled');
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/v1/billing/capacity-changes',
      body: { kind: 'downgrade', toSlots: 1, keepChildIds: [RILEY] },
    });
  });

  it('keep candidates are the children active today', async () => {
    const { api } = fakeApi(() => ({
      id: '0d1e2f3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a',
      displayName: 'Test Family',
      timezone: 'America/Chicago',
      paidSlots: 2,
      billingConflict: null,
      managingChannel: 'app_store',
      children: [
        { id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' },
        { id: SAM, nickname: 'Sam', gradeLevel: 1, ageBand: '5-7', status: 'draft' },
      ],
    }));
    expect(await loadActiveChildren(api)).toEqual([{ id: RILEY, nickname: 'Riley' }]);
  });
});
