import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  AdminSupportCase,
  AdminSupportCaseDetailResponse,
  AdminSupportCaseMessage,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import SupportAdminPage from './SupportAdminPage.tsx';

// Synthetic data only: invented family label, ids and case text about a plan, never a child.
const CASE_A = '1a2b3c4d-1111-4aaa-8bbb-000000000001';
const CASE_B = '1a2b3c4d-2222-4aaa-8bbb-000000000002';
const FAMILY = '2b3c4d5e-3333-4aaa-8bbb-000000000003';
const STAFF = '3c4d5e6f-4444-4aaa-8bbb-000000000004';
const PERIOD = '4d5e6f70-5555-4aaa-8bbb-000000000005';
const PERIOD_OLD = '4d5e6f70-6666-4aaa-8bbb-000000000006';
const MSG_1 = '5e6f7081-7777-4aaa-8bbb-000000000007';
const MSG_2 = '5e6f7081-8888-4aaa-8bbb-000000000008';
const NOW = '2026-09-25T12:00:00.000Z';
const CURSOR = `1758715200000000_${CASE_B}`;

function adminCase(overrides: Partial<AdminSupportCase> = {}): AdminSupportCase {
  return {
    id: CASE_A,
    familyId: FAMILY,
    openedByKind: 'parent',
    openedByUserId: '6f708192-9999-4aaa-8bbb-000000000009',
    kind: 'refund_request',
    status: 'open',
    priority: 'normal',
    subject: 'Charged twice for the family plan',
    body: 'We were charged twice in September for the same plan. Please refund one charge.',
    billingPeriod: { channel: 'app_store', providerPeriodId: 'txn_synthetic_001' },
    assigneeUserId: null,
    resolution: null,
    resolutionReference: null,
    createdAt: '2026-09-22T12:00:00.000Z',
    updatedAt: '2026-09-22T12:00:00.000Z',
    resolvedAt: null,
    ageHours: 72,
    ageBucket: '3_to_7_days',
    messageCount: 2,
    lastMessageAt: '2026-09-23T09:00:00.000Z',
    ...overrides,
  };
}

const secondCase = adminCase({
  id: CASE_B,
  kind: 'bug',
  subject: 'Camera button does nothing on the tablet',
  body: 'The scan button does not open the camera on our tablet since the last update.',
  billingPeriod: null,
  status: 'in_progress',
  priority: 'high',
  assigneeUserId: STAFF,
  createdAt: '2026-09-24T12:00:00.000Z',
  updatedAt: '2026-09-24T12:00:00.000Z',
  ageHours: 24,
  ageBucket: '1_to_3_days',
  messageCount: 0,
  lastMessageAt: null,
});

const messages: AdminSupportCaseMessage[] = [
  {
    id: MSG_1,
    authorKind: 'admin',
    authorUserId: STAFF,
    body: 'Checked RevenueCat: two App Store transactions on the same day.',
    internal: true,
    createdAt: '2026-09-23T08:00:00.000Z',
  },
  {
    id: MSG_2,
    authorKind: 'admin',
    authorUserId: STAFF,
    body: 'Thanks for reporting this. Apple issues App Store refunds; here is how to request one.',
    internal: false,
    createdAt: '2026-09-23T09:00:00.000Z',
  },
];

function detail(
  overrides: Partial<AdminSupportCaseDetailResponse> = {},
): AdminSupportCaseDetailResponse {
  return {
    case: adminCase(),
    messages,
    family: {
      id: FAMILY,
      displayName: 'The Test Family',
      timezone: 'America/Chicago',
      createdAt: '2026-03-01T00:00:00.000Z',
      deletedAt: null,
    },
    billingPeriods: [
      {
        id: PERIOD,
        channel: 'app_store',
        providerPeriodId: 'txn_synthetic_001',
        kind: 'subscription_period',
        periodStart: '2026-09-01T00:00:00.000Z',
        periodEnd: '2026-10-01T00:00:00.000Z',
        paidSlots: 2,
        regularAmountCents: 4998,
        chargedAmountCents: 4998,
        discountCents: 0,
        settlement: 'settled',
        settledAt: '2026-09-01T00:05:00.000Z',
        refundedCents: 0,
        currency: 'USD',
        linkedToCase: true,
      },
      {
        id: PERIOD_OLD,
        channel: 'app_store',
        providerPeriodId: 'txn_synthetic_000',
        kind: 'subscription_period',
        periodStart: '2026-08-01T00:00:00.000Z',
        periodEnd: '2026-09-01T00:00:00.000Z',
        paidSlots: 2,
        regularAmountCents: 4998,
        chargedAmountCents: 3998,
        discountCents: 1000,
        settlement: 'settled',
        settledAt: '2026-08-01T00:05:00.000Z',
        refundedCents: 0,
        currency: 'USD',
        linkedToCase: false,
      },
    ],
    pendingRefunds: [],
    refundPath:
      'Apple issues App Store refunds. The family requests one at reportaproblem.apple.com.',
    stripeRefundFromCase: false,
    ...overrides,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}
type Responder = (call: Call) => unknown;

const BASE = '/v1/admin/support/cases';

/** Fake API routed by "METHOD path" (query string stripped); every value passes the contract schema. */
function fakeApi(routes: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const defaults: Record<string, unknown> = {
    [`GET ${BASE}`]: { cases: [adminCase(), secondCase], nextCursor: null },
    [`GET ${BASE}/${CASE_A}`]: detail(),
    [`GET ${BASE}/${CASE_B}`]: detail({ case: secondCase, messages: [], refundPath: null }),
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
  const queueQueries = () =>
    calls
      .filter((c) => c.method === 'GET' && c.path.split('?')[0] === BASE)
      .map((c) => new URLSearchParams(c.path.split('?')[1] ?? ''));
  return { api, calls, sent, queueQueries };
}

afterEach(() => {
  cleanup();
});

function render(api: Partial<ApiClient>) {
  return renderPage(<SupportAdminPage />, { api, path: '/admin/support' });
}

async function openCase(subject: string) {
  await userEvent.click(await screen.findByRole('link', { name: subject }));
  return screen.findByRole('region', { name: 'Case' });
}

describe('SupportAdminPage access', () => {
  it('shows only the MFA-required state when the owner session is refused', async () => {
    const { api } = fakeApi({
      [`GET ${BASE}`]: new ApiRequestError(
        'FORBIDDEN',
        'Owner administration requires an MFA session',
        403,
      ),
    });
    render(api);
    expect(await screen.findByText(/Owner administration requires an MFA session/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('Charged twice for the family plan')).toBeNull();
  });
});

describe('Support queue', () => {
  it('lists the open queue oldest first with status, priority, assignee and message counts', async () => {
    const { api, queueQueries } = fakeApi();
    render(api);
    const table = await screen.findByRole('table', { name: 'Cases' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(
      within(rows[0]!).getByRole('link', { name: 'Charged twice for the family plan' }),
    ).toBeTruthy();
    expect(within(rows[0]!).getByText('Refund request')).toBeTruthy();
    expect(within(rows[0]!).getByText('Open')).toBeTruthy();
    expect(within(rows[0]!).getByText('3d ago')).toBeTruthy();
    expect(within(rows[0]!).getByText('Unassigned')).toBeTruthy();
    expect(within(rows[1]!).getByText('High')).toBeTruthy();
    expect(within(rows[1]!).getByText('In progress')).toBeTruthy();
    expect(within(rows[1]!).getByText(STAFF.slice(0, 8))).toBeTruthy();
    expect(screen.getByText(/2 cases shown for the open queue, oldest first\./)).toBeTruthy();
    expect(screen.getByText('End of the list.')).toBeTruthy();
    expect(queueQueries()[0]!.get('scope')).toBe('open');
    expect(queueQueries()[0]!.has('kind')).toBe(false);
  });

  it('shows an honest empty state', async () => {
    const { api } = fakeApi({ [`GET ${BASE}`]: { cases: [], nextCursor: null } });
    render(api);
    expect(await screen.findByText('No cases match the open queue.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('End of the list.')).toBeNull();
  });

  it('applies filters through the query string and asks the API again', async () => {
    const { api, queueQueries } = fakeApi();
    render(api);
    const filters = await screen.findByRole('form', { name: 'Queue filters' });
    await userEvent.selectOptions(within(filters).getByLabelText('Kind'), 'refund_request');
    await waitFor(() => expect(queueQueries()).toHaveLength(2));
    expect(queueQueries()[1]!.get('kind')).toBe('refund_request');
    await userEvent.selectOptions(within(filters).getByLabelText('Show'), 'all');
    await userEvent.selectOptions(within(filters).getByLabelText('Status'), 'closed');
    await userEvent.selectOptions(within(filters).getByLabelText('Age'), 'over_7d');
    await waitFor(() => expect(queueQueries().length).toBeGreaterThanOrEqual(5));
    const last = queueQueries().at(-1)!;
    expect(last.get('scope')).toBe('all');
    expect(last.get('kind')).toBe('refund_request');
    expect(last.get('status')).toBe('closed');
    expect(last.get('age')).toBe('over_7d');
    expect(
      await screen.findByText(
        /shown for all cases, status closed, kind refund request, older than 7 days/,
      ),
    ).toBeTruthy();
  });

  it('pages with the keyset cursor and appends the next page', async () => {
    const { api, queueQueries } = fakeApi({
      [`GET ${BASE}`]: (call: Call) => {
        const after = new URLSearchParams(call.path.split('?')[1] ?? '').get('after');
        return after === null
          ? { cases: [adminCase()], nextCursor: CURSOR }
          : { cases: [secondCase], nextCursor: null };
      },
    });
    render(api);
    expect(await screen.findByText(/1 case shown .* \(more available\)/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Load the next 50' }));
    expect(
      await screen.findByRole('link', { name: 'Camera button does nothing on the tablet' }),
    ).toBeTruthy();
    expect(queueQueries()[1]!.get('after')).toBe(CURSOR);
    expect(screen.getByText(/2 cases shown/)).toBeTruthy();
    expect(screen.getByText('End of the list.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Load the next/ })).toBeNull();
  });
});

describe('Case detail', () => {
  it('shows the family, the thread with internal notes marked, the refund path and the periods', async () => {
    const { api } = fakeApi();
    render(api);
    const region = await openCase('Charged twice for the family plan');
    expect(within(region).getByText(/The Test Family · time zone America\/Chicago/)).toBeTruthy();
    expect(within(region).getByText(/We were charged twice in September/)).toBeTruthy();
    const thread = screen.getByRole('region', { name: 'Thread' });
    const notes = within(thread).getAllByRole('listitem');
    expect(notes).toHaveLength(2);
    expect(within(notes[0]!).getByText('Internal note — not shown to the family')).toBeTruthy();
    expect(within(notes[0]!).getByText(/Checked RevenueCat/)).toBeTruthy();
    expect(within(notes[1]!).queryByText(/Internal note/)).toBeNull();
    const billing = screen.getByRole('region', { name: 'Billing periods and refunds' });
    expect(within(billing).getByText(/Refund request for the App Store period/)).toBeTruthy();
    expect(
      within(billing).getByText(/The provider has not reported a refund on this period yet/),
    ).toBeTruthy();
    expect(within(billing).getByText(/Apple issues App Store refunds/)).toBeTruthy();
    expect(within(billing).getByText(/issued by the store, never by PencilLift/)).toBeTruthy();
    const table = within(billing).getByRole('table', { name: 'Billing periods' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Named')).toBeTruthy();
    expect(within(rows[0]!).getByText('$49.98')).toBeTruthy();
    expect(within(rows[1]!).getByText(/after \$10\.00 discount/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '← Back to the queue' })).toBeTruthy();
  });

  it('shows the provider-reported refund once the store reports it', async () => {
    const base = detail();
    const refunded = detail({
      case: adminCase({ status: 'resolved', resolution: 'refunded_by_store', resolvedAt: NOW }),
      billingPeriods: [
        { ...base.billingPeriods[0]!, settlement: 'refunded', refundedCents: 4998 },
        base.billingPeriods[1]!,
      ],
      pendingRefunds: [
        {
          channel: 'app_store',
          providerPeriodId: 'txn_synthetic_002',
          kind: 'refund',
          refundedCents: null,
          createdAt: NOW,
        },
      ],
    });
    const { api } = fakeApi({ [`GET ${BASE}/${CASE_A}`]: refunded });
    render(api);
    await openCase('Charged twice for the family plan');
    expect(
      await screen.findByText(/The provider reports \$49\.98 refunded \(refunded\)/),
    ).toBeTruthy();
    expect(screen.getByText('Refunds reported before their charge')).toBeTruthy();
    expect(screen.getByText('not stated')).toBeTruthy();
    expect(screen.getAllByText('Refunded by the store').length).toBeGreaterThan(0);
  });

  it('sends a reply to the family, or saves an internal note, and confirms in the page', async () => {
    const { api, sent } = fakeApi({
      [`POST ${BASE}/${CASE_A}/messages`]: (call: Call) => {
        const body = call.body as { message: string; internal: boolean };
        return {
          message: { ...messages[1]!, body: body.message, internal: body.internal },
          case: adminCase({ messageCount: 3 }),
        };
      },
    });
    render(api);
    await openCase('Charged twice for the family plan');
    const form = screen.getByRole('form', { name: 'Reply or add a note' });
    await userEvent.click(within(form).getByRole('button', { name: 'Send reply to the family' }));
    expect(await within(form).findByText('Write a message first.')).toBeTruthy();
    expect(sent()).toHaveLength(0);
    await userEvent.type(within(form).getByLabelText('Message'), 'Apple has your request.');
    await userEvent.click(within(form).getByRole('button', { name: 'Send reply to the family' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({
      method: 'POST',
      path: `${BASE}/${CASE_A}/messages`,
      body: { message: 'Apple has your request.', internal: false },
    });
    expect(await screen.findByText('Reply sent to the family.')).toBeTruthy();
    await userEvent.type(within(form).getByLabelText('Message'), 'Owner: waiting on Apple.');
    await userEvent.click(within(form).getByLabelText(/Internal note \(staff only/));
    await userEvent.click(within(form).getByRole('button', { name: 'Save internal note' }));
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]!.body).toEqual({ message: 'Owner: waiting on Apple.', internal: true });
    expect(
      await screen.findByText(/Internal note saved\. The family never sees it\./),
    ).toBeTruthy();
  });

  it('refuses an inconsistent update before sending and sends only the changed fields', async () => {
    const { api, sent } = fakeApi({
      [`PATCH ${BASE}/${CASE_A}`]: (call: Call) => ({
        case: adminCase({
          ...(call.body as Partial<AdminSupportCase>),
          resolvedAt: NOW,
          updatedAt: NOW,
        }),
      }),
    });
    render(api);
    await openCase('Charged twice for the family plan');
    const form = screen.getByRole('form', { name: 'Assign, status and resolution' });
    await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await within(form).findByText('Nothing to change.')).toBeTruthy();
    await userEvent.selectOptions(within(form).getByLabelText('Status'), 'resolved');
    await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(
      await within(form).findByText('Choose a resolution before resolving the case.'),
    ).toBeTruthy();
    expect(sent()).toHaveLength(0);
    await userEvent.selectOptions(within(form).getByLabelText('Resolution'), 'refunded_by_store');
    await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({
      method: 'PATCH',
      path: `${BASE}/${CASE_A}`,
      body: { status: 'resolved', resolution: 'refunded_by_store' },
    });
    expect(
      await screen.findByText('Case updated: Resolved, Refunded by the store, unassigned.'),
    ).toBeTruthy();
  });

  it('needs a Stripe reference for a web-billing refund and a UUID for an assignee', async () => {
    const { api, sent } = fakeApi({
      [`PATCH ${BASE}/${CASE_A}`]: (call: Call) => ({
        case: adminCase({ ...(call.body as Partial<AdminSupportCase>), updatedAt: NOW }),
      }),
    });
    render(api);
    await openCase('Charged twice for the family plan');
    const form = screen.getByRole('form', { name: 'Assign, status and resolution' });
    await userEvent.type(within(form).getByLabelText(/Assignee/), 'not-a-uuid');
    await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await within(form).findByText(/user id \(a UUID\)/)).toBeTruthy();
    expect(sent()).toHaveLength(0);
    await userEvent.clear(within(form).getByLabelText(/Assignee/));
    await userEvent.type(within(form).getByLabelText(/Assignee/), STAFF);
    await userEvent.selectOptions(within(form).getByLabelText('Status'), 'closed');
    await userEvent.selectOptions(
      within(form).getByLabelText('Resolution'),
      'stripe_refund_issued',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await within(form).findByText(/Record the Stripe refund reference/)).toBeTruthy();
    expect(sent()).toHaveLength(0);
    await userEvent.type(within(form).getByLabelText(/Stripe refund reference/), 're_synthetic_1');
    await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]!.body).toEqual({
      status: 'closed',
      resolution: 'stripe_refund_issued',
      resolutionReference: 're_synthetic_1',
      assigneeUserId: STAFF,
    });
    expect(await screen.findByText(/assigned to 3c4d5e6f/)).toBeTruthy();
  });

  it('explains a server rule refusal instead of showing a raw error', async () => {
    const { api } = fakeApi({
      [`PATCH ${BASE}/${CASE_A}`]: new ApiRequestError(
        'BUSINESS_RULE',
        'Assign a case to a staff member',
        422,
        'ASSIGNEE_NOT_STAFF',
      ),
    });
    render(api);
    await openCase('Charged twice for the family plan');
    const form = screen.getByRole('form', { name: 'Assign, status and resolution' });
    await userEvent.type(within(form).getByLabelText(/Assignee/), STAFF);
    await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText(
        /not an active staff member \(admin_users\), so the case was not assigned/,
      ),
    ).toBeTruthy();
  });

  it('says so when a Stripe period is involved and nothing here can refund it', async () => {
    const base = detail();
    const stripe = detail({
      case: adminCase({ billingPeriod: { channel: 'stripe', providerPeriodId: 'in_synthetic_9' } }),
      billingPeriods: [
        {
          ...base.billingPeriods[0]!,
          channel: 'stripe',
          providerPeriodId: 'in_synthetic_9',
          linkedToCase: true,
        },
      ],
      refundPath: 'Web billing: the owner refunds the charge in the Stripe dashboard.',
    });
    const { api } = fakeApi({ [`GET ${BASE}/${CASE_A}`]: stripe });
    render(api);
    await openCase('Charged twice for the family plan');
    expect(
      await screen.findByText(/this build’s Stripe client exposes no refund call/),
    ).toBeTruthy();
    expect(screen.getByText(/refunds the charge in the Stripe dashboard/)).toBeTruthy();
  });
});
