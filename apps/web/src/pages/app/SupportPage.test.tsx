import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { SupportBillingPeriod, SupportCase, SupportCaseDetail } from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { unconfiguredAuth } from '../../lib/auth.ts';
import { renderPage } from '../../test/render.tsx';
import SupportPage from './SupportPage.tsx';

// Synthetic data only: a case about a plan and a charge, never about a child.
const CASE_A = '1a2b3c4d-1111-4aaa-8bbb-000000000001';
const CASE_B = '1a2b3c4d-2222-4aaa-8bbb-000000000002';
const PERIOD = '4d5e6f70-5555-4aaa-8bbb-000000000005';
const MSG = '5e6f7081-7777-4aaa-8bbb-000000000007';
const AT = '2026-09-22T12:00:00.000Z';

const period: SupportBillingPeriod = {
  id: PERIOD,
  channel: 'app_store',
  providerPeriodId: 'txn_synthetic_001',
  periodStart: '2026-09-01T00:00:00.000Z',
  periodEnd: '2026-10-01T00:00:00.000Z',
  paidSlots: 2,
  chargedCents: 4998,
  refundedCents: 0,
  settlement: 'settled',
};

function supportCase(overrides: Partial<SupportCase> = {}): SupportCase {
  return {
    id: CASE_A,
    kind: 'refund_request',
    status: 'open',
    subject: 'Charged twice for the family plan',
    body: 'We were charged twice in September for the same plan.',
    billingPeriod: period,
    resolution: null,
    createdAt: AT,
    updatedAt: AT,
    resolvedAt: null,
    canReply: true,
    messageCount: 1,
    ...overrides,
  };
}

function detail(overrides: Partial<SupportCaseDetail> = {}): SupportCaseDetail {
  return {
    ...supportCase(),
    messages: [
      {
        id: MSG,
        authorKind: 'admin',
        body: 'Thanks for reporting this. Apple issues App Store refunds; here is how to request one.',
        createdAt: '2026-09-23T09:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}
type Responder = (call: Call) => unknown;

function fakeApi(routes: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const defaults: Record<string, unknown> = {
    'GET /v1/support/cases': { cases: [supportCase()] },
    'GET /v1/support/billing-periods': { periods: [period] },
    'GET /v1/support/policy': {
      refundWindowDays: 14,
      responseTargetHours: {
        refund_request: 48,
        complaint: 48,
        billing_issue: 48,
        bug: 72,
        safety_question: 24,
        other: 72,
      },
      refundWindowSentence:
        'Refund requests are reviewed for charges from the last 14 days; the store or Stripe issues any refund, and PencilLift records the outcome on your case.',
    },
    [`GET /v1/support/cases/${CASE_A}`]: { case: detail() },
  };
  const table = { ...defaults, ...routes };
  const respond = (call: Call): unknown => {
    const key = `${call.method} ${call.path.split('?')[0]}`;
    if (!(key in table)) return new Error(`unexpected ${key}`);
    const value = table[key];
    return typeof value === 'function' ? (value as Responder)(call) : value;
  };
  const settle = <S extends z.ZodType>(call: Call, schema: S) => {
    calls.push(call);
    try {
      const value = respond(call);
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(schema.parse(value));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const api: Partial<ApiClient> = {
    get: (path, schema) => settle({ method: 'GET', path, body: undefined }, schema),
    send: (method, path, body, schema) => settle({ method, path, body }, schema),
  };
  const sent = () => calls.filter((c) => c.method !== 'GET');
  const listCalls = () => calls.filter((c) => c.path === '/v1/support/cases' && c.method === 'GET');
  return { api, calls, sent, listCalls };
}

afterEach(() => {
  cleanup();
});

function render(api: Partial<ApiClient>) {
  return renderPage(<SupportPage />, { api, path: '/app/support' });
}

describe('SupportPage access and empty state', () => {
  it('never shows support data without a configured parent sign-in', async () => {
    renderPage(<SupportPage />, { auth: unconfiguredAuth });
    expect(await screen.findByText(/Parent sign-in isn’t available yet/)).toBeTruthy();
  });

  it('tells a family with no cases so, and shows the intake notice about children', async () => {
    const { api } = fakeApi({
      'GET /v1/support/cases': { cases: [] },
      'GET /v1/support/billing-periods': { periods: [] },
    });
    render(api);
    expect(await screen.findByText(/You haven’t opened a case yet/)).toBeTruthy();
    expect(
      screen.getByText(/Please don’t include your child’s name, homework text or answers/),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'help page' }).getAttribute('href')).toBe('/support');
  });
});

describe('Opening a case', () => {
  it('validates, shows the refund notice and billing periods for a refund request, and posts the case', async () => {
    const { api, sent, listCalls } = fakeApi({
      'POST /v1/support/cases': (call: Call) => {
        const body = call.body as { kind: SupportCase['kind']; subject: string; message: string };
        return {
          case: detail({
            id: CASE_B,
            kind: body.kind,
            subject: body.subject,
            body: body.message,
            messages: [],
            messageCount: 0,
          }),
        };
      },
    });
    render(api);
    const form = await screen.findByRole('form', { name: 'Open a case' });
    expect(screen.queryByText(/refunds are issued by the store/)).toBeNull();
    await userEvent.click(within(form).getByRole('button', { name: 'Send to support' }));
    expect(await within(form).findByText('Give the case a short subject.')).toBeTruthy();
    expect(within(form).getByText('Tell us what happened.')).toBeTruthy();
    expect(sent()).toHaveLength(0);
    await userEvent.selectOptions(
      within(form).getByLabelText('What is it about?'),
      'refund_request',
    );
    expect(
      within(form).getByText(/refunds are issued by the store, not by PencilLift/),
    ).toBeTruthy();
    const periods = within(form).getByLabelText('Which charge? (optional)');
    const option = within(periods).getByRole('option', { name: /App Store .* \$49\.98/ });
    await userEvent.selectOptions(periods, option);
    await userEvent.type(within(form).getByLabelText('Subject'), '  Double charge in September ');
    await userEvent.type(
      within(form).getByLabelText('Message'),
      'Two charges on the same day for one plan.',
    );
    expect(within(form).getByText(/41\/2000/)).toBeTruthy();
    await userEvent.click(within(form).getByRole('button', { name: 'Send to support' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({
      method: 'POST',
      path: '/v1/support/cases',
      body: {
        kind: 'refund_request',
        subject: 'Double charge in September',
        message: 'Two charges on the same day for one plan.',
        billingPeriodId: PERIOD,
      },
    });
    expect(await screen.findByText(/Your case is open/)).toBeTruthy();
    await waitFor(() => expect(listCalls().length).toBeGreaterThanOrEqual(2));
    expect(within(form).getByLabelText('Subject').getAttribute('value')).toBe('');
  });

  it('never sends a billing period for a non-refund case and explains a refused period', async () => {
    const { api, sent } = fakeApi({
      'POST /v1/support/cases': new ApiRequestError(
        'BUSINESS_RULE',
        'Billing period not found',
        422,
        'BILLING_PERIOD_NOT_FOUND',
      ),
    });
    render(api);
    const form = await screen.findByRole('form', { name: 'Open a case' });
    await userEvent.selectOptions(
      within(form).getByLabelText('What is it about?'),
      'refund_request',
    );
    await userEvent.selectOptions(within(form).getByLabelText('Which charge? (optional)'), PERIOD);
    await userEvent.selectOptions(within(form).getByLabelText('What is it about?'), 'bug');
    expect(within(form).queryByLabelText('Which charge? (optional)')).toBeNull();
    await userEvent.type(within(form).getByLabelText('Subject'), 'Camera button');
    await userEvent.type(within(form).getByLabelText('Message'), 'The scan button does nothing.');
    await userEvent.click(within(form).getByRole('button', { name: 'Send to support' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]!.body).toEqual({
      kind: 'bug',
      subject: 'Camera button',
      message: 'The scan button does nothing.',
    });
    expect(await screen.findByText(/That billing period isn’t one of your family’s/)).toBeTruthy();
  });

  it('shows the rate limit refusal from the server', async () => {
    const { api } = fakeApi({
      'POST /v1/support/cases': new ApiRequestError(
        'RATE_LIMITED',
        'Too many cases opened this hour. Please try again later.',
        429,
      ),
      'GET /v1/support/billing-periods': { periods: [] },
    });
    render(api);
    const form = await screen.findByRole('form', { name: 'Open a case' });
    await userEvent.type(within(form).getByLabelText('Subject'), 'Plan question');
    await userEvent.type(within(form).getByLabelText('Message'), 'How do I add a slot?');
    await userEvent.click(within(form).getByRole('button', { name: 'Send to support' }));
    expect(await screen.findByText(/Too many cases opened this hour/)).toBeTruthy();
  });
});

describe('Reading and replying', () => {
  it('lists the family’s cases and opens one with its replies, the charge and a reply box', async () => {
    let current = detail();
    const { api, sent } = fakeApi({
      [`GET /v1/support/cases/${CASE_A}`]: () => ({ case: current }),
      [`POST /v1/support/cases/${CASE_A}/messages`]: (call: Call) => {
        current = detail({
          messages: [
            ...detail().messages,
            {
              id: '5e6f7081-8888-4aaa-8bbb-000000000008',
              authorKind: 'parent',
              body: (call.body as { message: string }).message,
              createdAt: '2026-09-24T09:00:00.000Z',
            },
          ],
          messageCount: 2,
        });
        return { case: current };
      },
    });
    render(api);
    const list = await screen.findByRole('region', { name: 'Your cases' });
    const link = within(list).getByRole('link', { name: 'Charged twice for the family plan' });
    expect(within(list).getByText('Open')).toBeTruthy();
    expect(within(list).getByText(/Refund request · opened .* · 1 reply/)).toBeTruthy();
    await userEvent.click(link);
    const region = await screen.findByRole('region', { name: 'Charged twice for the family plan' });
    expect(within(region).getByText(/We were charged twice in September/)).toBeTruthy();
    expect(within(region).getByText(/Charge in question:/)).toBeTruthy();
    expect(within(region).getByText(/App Store .* \$49\.98 · paid/)).toBeTruthy();
    expect(
      within(region).getByText('The store has not reported a refund on this charge yet.'),
    ).toBeTruthy();
    expect(
      within(region).getByText(/refunds are issued by the store, not by PencilLift/),
    ).toBeTruthy();
    expect(within(region).getByText('PencilLift support')).toBeTruthy();
    expect(within(region).getByText(/Apple issues App Store refunds/)).toBeTruthy();
    const reply = within(region).getByRole('form', { name: 'Reply' });
    await userEvent.click(within(reply).getByRole('button', { name: 'Send reply' }));
    expect(await within(reply).findByText('Write a reply first.')).toBeTruthy();
    await userEvent.type(within(reply).getByLabelText('Reply'), 'Done, Apple has the request.');
    await userEvent.click(within(reply).getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({
      method: 'POST',
      path: `/v1/support/cases/${CASE_A}/messages`,
      body: { message: 'Done, Apple has the request.' },
    });
    expect(await screen.findByText('Your reply was added to the case.')).toBeTruthy();
    expect(await within(region).findByText('Done, Apple has the request.')).toBeTruthy();
  });

  it('shows the store-reported refund and the outcome, and no reply box once closed', async () => {
    const closed = detail({
      status: 'closed',
      canReply: false,
      resolution: 'refunded_by_store',
      resolvedAt: '2026-09-24T12:00:00.000Z',
      billingPeriod: { ...period, settlement: 'refunded', refundedCents: 4998 },
    });
    const { api } = fakeApi({
      'GET /v1/support/cases': { cases: [{ ...supportCase(), status: 'closed', canReply: false }] },
      [`GET /v1/support/cases/${CASE_A}`]: { case: closed },
    });
    render(api);
    await userEvent.click(
      await screen.findByRole('link', { name: 'Charged twice for the family plan' }),
    );
    const region = await screen.findByRole('region', { name: 'Charged twice for the family plan' });
    expect(
      within(region).getByText(/The store reports \$49\.98 refunded on this charge/),
    ).toBeTruthy();
    expect(within(region).getByText(/Refunded by the store/)).toBeTruthy();
    expect(within(region).queryByRole('form', { name: 'Reply' })).toBeNull();
    expect(
      within(region).getByText(/This case is closed, so it no longer takes replies/),
    ).toBeTruthy();
  });
});
