import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { payoutBatchSchema, schoolAdminSchema } from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import SchoolsAdminPage from './SchoolsAdminPage.tsx';

// Synthetic data only. School names are invented.
const MAPLE = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const CEDAR = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const PAYOUT = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const AT = '2026-09-20T15:00:00.000Z';

type School = z.infer<typeof schoolAdminSchema>;
type Payout = z.infer<typeof payoutBatchSchema>;

const maple: School = {
  id: MAPLE,
  name: 'Maple Grove Elementary',
  city: 'Springfield',
  region: 'IL',
  status: 'active',
  recipientVerified: true,
};
const cedar: School = {
  id: CEDAR,
  name: 'Cedar Park Middle',
  city: null,
  region: null,
  status: 'pending_verification',
  recipientVerified: false,
};

function payout(overrides: Partial<Payout> = {}): Payout {
  return {
    id: PAYOUT,
    schoolId: MAPLE,
    batchKey: `payout:${MAPLE}:2026-09`,
    totalCents: 4200,
    status: 'accrued',
    externalTransferRef: null,
    createdAt: AT,
    ...overrides,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeApi(
  options: {
    payouts?: Payout[];
    get?: (path: string) => unknown;
    send?: (call: Call) => unknown;
  } = {},
) {
  const gets: string[] = [];
  const sends: Call[] = [];
  const defaultGet = (path: string): unknown => {
    if (path === '/v1/admin/schools') return { schools: [maple, cedar] };
    if (path.startsWith(`/v1/admin/schools/${MAPLE}/report`)) {
      return {
        schoolId: MAPLE,
        month: '2026-09',
        attributedSignups: '12',
        donationEligibleFamilies: '<5',
        accruedCents: 300,
        paidCents: 100,
      };
    }
    if (path.startsWith('/v1/admin/payouts?')) return { payouts: options.payouts ?? [payout()] };
    return new Error(`unexpected GET ${path}`);
  };
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      gets.push(path);
      try {
        const value = options.get?.(path) ?? defaultGet(path);
        if (value instanceof Error) return Promise.reject(value);
        return Promise.resolve(schema.parse(value));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    send: <S extends z.ZodType>(
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      body: unknown,
      schema: S,
    ) => {
      const call = { method, path, body };
      sends.push(call);
      try {
        const value = options.send?.(call);
        if (value instanceof Error) return Promise.reject(value);
        return Promise.resolve(schema.parse(value));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
  return { api, gets, sends };
}

afterEach(() => {
  cleanup();
});

async function openSchool(name = 'Maple Grove Elementary') {
  const table = await screen.findByRole('table', { name: 'Schools' });
  await userEvent.click(within(table).getByRole('button', { name: `Open ${name}` }));
  return screen.findByRole('region', { name: `${name}: report and payouts` });
}

describe('SchoolsAdminPage — access and list (spec P17, AC_PROMO_13)', () => {
  it('shows the MFA requirement and nothing else when the API refuses', async () => {
    const { api } = fakeApi({
      get: () =>
        new ApiRequestError('FORBIDDEN', 'Owner administration requires an MFA session', 403),
    });
    renderPage(<SchoolsAdminPage />, { api });
    expect(await screen.findByText(/Owner administration requires an MFA session/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('lists schools with verification in text and states that live transfers are disabled', async () => {
    const { api } = fakeApi();
    renderPage(<SchoolsAdminPage />, { api });
    const table = await screen.findByRole('table', { name: 'Schools' });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]!).getByText('Maple Grove Elementary')).toBeTruthy();
    expect(within(rows[1]!).getByText('Recipient verified')).toBeTruthy();
    expect(within(rows[2]!).getByText('Pending verification')).toBeTruthy();
    expect(within(rows[2]!).getByText('Recipient not verified')).toBeTruthy();
    expect(
      screen.getByText(/Live transfers are disabled until real recipient details exist/),
    ).toBeTruthy();
  });

  it('validates and creates a school', async () => {
    const { api, sends } = fakeApi({
      send: () => ({
        ...cedar,
        id: '9c4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b',
        name: 'Birch Hill School',
      }),
    });
    renderPage(<SchoolsAdminPage />, { api });
    const form = await screen.findByRole('form', { name: 'Add a school' });
    await userEvent.type(within(form).getByLabelText('School name'), 'B');
    await userEvent.click(within(form).getByRole('button', { name: 'Add school' }));
    expect(await within(form).findByText(/2 to 160 characters/)).toBeTruthy();
    expect(sends).toHaveLength(0);
    await userEvent.type(within(form).getByLabelText('School name'), 'irch Hill School');
    await userEvent.type(within(form).getByLabelText(/City/), 'Riverton');
    await userEvent.click(within(form).getByRole('button', { name: 'Add school' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      method: 'POST',
      path: '/v1/admin/schools',
      body: { name: 'Birch Hill School', city: 'Riverton', region: null },
    });
    expect(await screen.findByText(/Birch Hill School added/)).toBeTruthy();
  });
});

describe('SchoolsAdminPage — monthly report (AC_PROMO_10)', () => {
  it('shows distinct-family counts, explains “<5” suppression and owed versus paid', async () => {
    const { api, gets } = fakeApi();
    renderPage(<SchoolsAdminPage />, { api });
    const panel = await openSchool();
    fireEvent.change(within(panel).getByLabelText('Report month'), {
      target: { value: '2026-09' },
    });
    await waitFor(() => expect(gets).toContain(`/v1/admin/schools/${MAPLE}/report?month=2026-09`));
    const report = within(panel).getByRole('region', { name: /Monthly report/ });
    expect(await within(report).findByText('12')).toBeTruthy();
    expect(within(report).getByText('<5')).toBeTruthy();
    expect(within(report).getByText(/shown as “<5”/)).toBeTruthy();
    expect(
      within(report).getByText(/distinct families, not children, guardians or code redemptions/),
    ).toBeTruthy();
    expect(within(report).getByText('$3.00')).toBeTruthy();
    expect(within(report).getByText('$1.00')).toBeTruthy();
    expect(within(report).getByText('$2.00')).toBeTruthy(); // owed = accrued − paid
  });
});

describe('SchoolsAdminPage — payouts', () => {
  it('shows a carried-forward result when there is nothing positive to pay', async () => {
    const { api, sends } = fakeApi({
      payouts: [],
      send: () => ({ status: 'carried_forward', netCents: -100 }),
    });
    renderPage(<SchoolsAdminPage />, { api });
    const panel = await openSchool();
    const payouts = within(panel).getByRole('region', { name: 'Payouts' });
    fireEvent.change(within(payouts).getByLabelText('Pay accruals through month'), {
      target: { value: '2026-09' },
    });
    await userEvent.click(within(payouts).getByRole('button', { name: 'Prepare payout' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      method: 'POST',
      path: '/v1/admin/payouts/prepare',
      body: { schoolId: MAPLE, throughMonth: '2026-09' },
    });
    expect(await within(payouts).findByText(/Carried forward/)).toBeTruthy();
    expect(within(payouts).getByText(/net balance of -\$1\.00/)).toBeTruthy();
    expect(within(payouts).getByText(/No payout batch was created/)).toBeTruthy();
  });

  it('explains disabled transfers when preparing is blocked', async () => {
    const { api } = fakeApi({
      payouts: [],
      send: () =>
        new ApiRequestError(
          'BLOCKED_EXTERNAL',
          'School transfers are disabled until real recipient details are configured',
          503,
          'TRANSFERS_DISABLED',
        ),
    });
    renderPage(<SchoolsAdminPage />, { api });
    const panel = await openSchool();
    const payouts = within(panel).getByRole('region', { name: 'Payouts' });
    fireEvent.change(within(payouts).getByLabelText('Pay accruals through month'), {
      target: { value: '2026-09' },
    });
    await userEvent.click(within(payouts).getByRole('button', { name: 'Prepare payout' }));
    expect(
      await within(payouts).findByText(/Transfers are disabled in this environment/),
    ).toBeTruthy();
  });

  it('approves after confirmation and requires a transfer reference to mark paid', async () => {
    const { api, sends } = fakeApi({
      payouts: [payout({ status: 'approved' })],
      send: (call) =>
        call.path.endsWith('/mark-paid')
          ? payout({ status: 'paid', externalTransferRef: 'TRF-2026-0001' })
          : payout({ status: 'approved' }),
    });
    renderPage(<SchoolsAdminPage />, { api });
    const panel = await openSchool();
    const payouts = within(panel).getByRole('region', { name: 'Payouts' });
    const row = await within(payouts).findByRole('row', { name: /\$42\.00/ });
    expect(within(row).getByText(/Approved – awaiting transfer/)).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: /Mark paid/ }));
    const form = await within(payouts).findByRole('form', { name: /Record transfer/ });
    await userEvent.click(within(form).getByRole('button', { name: 'Record as paid' }));
    expect(await within(form).findByText(/Enter the transfer reference/)).toBeTruthy();
    expect(sends).toHaveLength(0);
    await userEvent.type(within(form).getByLabelText('Transfer reference'), 'TRF-2026-0001');
    await userEvent.click(within(form).getByRole('button', { name: 'Record as paid' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      method: 'POST',
      path: `/v1/admin/payouts/${PAYOUT}/mark-paid`,
      body: { externalTransferRef: 'TRF-2026-0001' },
    });
  });

  it('asks before approving an accrued batch', async () => {
    const { api, sends } = fakeApi({ send: () => payout({ status: 'approved' }) });
    renderPage(<SchoolsAdminPage />, { api });
    const panel = await openSchool();
    const payouts = within(panel).getByRole('region', { name: 'Payouts' });
    const row = await within(payouts).findByRole('row', { name: /\$42\.00/ });
    expect(within(row).getByText(/Accrued – awaiting approval/)).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: /Approve/ }));
    expect(sends).toHaveLength(0);
    await userEvent.click(within(row).getByRole('button', { name: /Yes, approve/ }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.path).toBe(`/v1/admin/payouts/${PAYOUT}/approve`);
  });
});
