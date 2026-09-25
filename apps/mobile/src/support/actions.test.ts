import { describe, expect, it } from 'vitest';
import { SUPPORT_RULES, type SupportCaseDetail } from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import {
  loadBillingPeriods,
  loadSupportCase,
  loadSupportCases,
  openSupportCase,
  replyToCase,
} from './actions.ts';
import { EMPTY_DRAFT, NO_PERIOD_VALUE } from './view-model.ts';

// Synthetic data only: no child names, no homework text.
const CASE_ID = '11111111-1111-4111-8111-111111111111';
const PERIOD_ID = '22222222-2222-4222-8222-222222222222';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Labeled test double: responses pass through the real contract schemas, like the real client. */
function fakeApi(handler: (call: Call) => unknown): { api: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const respond = (call: Call, schema: { parse: (v: unknown) => unknown }): Promise<never> => {
    calls.push(call);
    const value = handler(call);
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(schema.parse(value) as never);
  };
  return {
    calls,
    api: {
      get: (path, schema) => respond({ method: 'GET', path, body: undefined }, schema),
      send: (method, path, body, schema) => respond({ method, path, body }, schema),
    },
  };
}

function detail(overrides: Partial<SupportCaseDetail> = {}): SupportCaseDetail {
  return {
    id: CASE_ID,
    kind: 'refund_request',
    status: 'open',
    subject: 'Refund for September',
    body: 'We cancelled before the renewal but were still charged.',
    billingPeriod: {
      id: PERIOD_ID,
      channel: 'play_store',
      providerPeriodId: 'GPA.synthetic-001',
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-10-01T00:00:00.000Z',
      paidSlots: 1,
      chargedCents: 3999,
      refundedCents: 0,
      settlement: 'settled',
    },
    resolution: null,
    createdAt: '2026-09-23T12:00:00.000Z',
    updatedAt: '2026-09-23T12:00:00.000Z',
    resolvedAt: null,
    canReply: true,
    messages: [],
    messageCount: 0,
    ...overrides,
  };
}

describe('loads', () => {
  it('reads the family’s cases, billing periods and one case by id', async () => {
    const { messages: _m, ...summary } = detail();
    const { api, calls } = fakeApi((call) => {
      if (call.path === '/v1/support/cases') return { cases: [summary] };
      if (call.path === '/v1/support/billing-periods') return { periods: [summary.billingPeriod] };
      return { case: detail() };
    });
    expect(await loadSupportCases(api)).toEqual([summary]);
    expect(await loadBillingPeriods(api)).toEqual([summary.billingPeriod]);
    expect(await loadSupportCase(api, CASE_ID)).toEqual(detail());
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/support/cases',
      'GET /v1/support/billing-periods',
      `GET /v1/support/cases/${CASE_ID}`,
    ]);
  });
});

describe('openSupportCase', () => {
  it('refuses an empty draft locally without calling the server', async () => {
    const { api, calls } = fakeApi(() => new Error('should not be called'));
    const result = await openSupportCase(api, EMPTY_DRAFT);
    expect(result).toEqual({
      ok: false,
      reason: 'fields',
      problems: { subject: 'Add a short subject.', message: 'Tell us what happened.' },
    });
    expect(calls).toHaveLength(0);
  });

  it('posts the trimmed body with the period of a refund request and confirms in calm copy', async () => {
    const { api, calls } = fakeApi(() => ({ case: detail() }));
    const result = await openSupportCase(api, {
      kind: 'refund_request',
      subject: ' Refund for September ',
      message: ' We cancelled before the renewal but were still charged. ',
      billingPeriodId: PERIOD_ID,
    });
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/v1/support/cases',
      body: {
        kind: 'refund_request',
        subject: 'Refund for September',
        message: 'We cancelled before the renewal but were still charged.',
        billingPeriodId: PERIOD_ID,
      },
    });
    expect(result.ok && result.detail.id).toBe(CASE_ID);
    expect(result.ok && result.message).toMatch(/Your case is open/);
  });

  it('never sends a period with another kind', async () => {
    const { api, calls } = fakeApi(() => ({ case: detail({ kind: 'bug', billingPeriod: null }) }));
    await openSupportCase(api, {
      kind: 'bug',
      subject: 'Practice page will not open',
      message: 'Tapping Start practice shows a blank screen.',
      billingPeriodId: PERIOD_ID,
    });
    expect(calls[0]!.body).toEqual({
      kind: 'bug',
      subject: 'Practice page will not open',
      message: 'Tapping Start practice shows a blank screen.',
    });
    const { api: api2, calls: calls2 } = fakeApi(() => ({ case: detail({ billingPeriod: null }) }));
    await openSupportCase(api2, {
      kind: 'refund_request',
      subject: 'Refund for September',
      message: 'Charged after cancelling.',
      billingPeriodId: NO_PERIOD_VALUE,
    });
    expect(calls2[0]!.body).not.toHaveProperty('billingPeriodId');
  });

  it('maps a server refusal to parent copy keyed on the code', async () => {
    const { api } = fakeApi(() => new ApiRequestError('RATE_LIMITED', 'Too many', 429));
    const result = await openSupportCase(api, {
      ...EMPTY_DRAFT,
      subject: 'Refund for September',
      message: 'Charged after cancelling.',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'request',
      problem: {
        message:
          'You’ve opened several cases in the last hour. Please wait a little before opening another; your existing cases are still with the team.',
        needsPin: false,
        noFamily: false,
      },
    });
  });
});

describe('replyToCase', () => {
  it('refuses an empty reply locally', async () => {
    const { api, calls } = fakeApi(() => new Error('should not be called'));
    const result = await replyToCase(api, CASE_ID, '  ', 'open');
    expect(result).toEqual({
      ok: false,
      problem: { message: 'Write your reply first.', needsPin: false, noFamily: false },
    });
    expect(calls).toHaveLength(0);
  });

  it('posts the trimmed reply and says when it reopened the case', async () => {
    const reopened = detail({
      status: 'open',
      messages: [
        {
          id: '77777777-7777-4777-8777-777777777777',
          authorKind: 'parent',
          body: 'The store still shows the charge.',
          createdAt: '2026-09-25T10:00:00.000Z',
        },
      ],
      messageCount: 1,
    });
    const { api, calls } = fakeApi(() => ({ case: reopened }));
    const result = await replyToCase(
      api,
      CASE_ID,
      ' The store still shows the charge. ',
      'resolved',
    );
    expect(calls[0]).toEqual({
      method: 'POST',
      path: `/v1/support/cases/${CASE_ID}/messages`,
      body: { message: 'The store still shows the charge.' },
    });
    expect(result.ok && result.message).toMatch(/open again and back with the PencilLift team/);
    expect(result.ok && result.detail.messageCount).toBe(1);

    const same = await replyToCase(api, CASE_ID, 'One more detail.', 'open');
    expect(same.ok && same.message).toBe('Reply sent. We’ll answer here.');
  });

  it('explains a closed case instead of showing server text', async () => {
    const { api } = fakeApi(
      () => new ApiRequestError('BUSINESS_RULE', 'raw', 422, SUPPORT_RULES.caseClosed),
    );
    const result = await replyToCase(api, CASE_ID, 'Hello again', 'closed');
    expect(!result.ok && result.problem.message).toMatch(/closed, so it takes no more replies/);
  });
});
