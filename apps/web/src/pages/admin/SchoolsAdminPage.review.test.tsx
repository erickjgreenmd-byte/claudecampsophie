import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { schoolAdminSchema } from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import SchoolsAdminPage from './SchoolsAdminPage.tsx';

/**
 * Independent adversarial review of the p17-ui vertical (owner schools and payouts console).
 * Synthetic data only; responses pass through the real contract schemas.
 */

const MAPLE = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';

type School = z.infer<typeof schoolAdminSchema>;

const maple: School = {
  id: MAPLE,
  name: 'Maple Grove Elementary',
  city: 'Springfield',
  region: 'IL',
  status: 'active',
  recipientVerified: true,
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeApi(send: (call: Call) => unknown) {
  const sends: Call[] = [];
  const get = (path: string): unknown => {
    if (path === '/v1/admin/schools') return { schools: [maple] };
    if (path.startsWith(`/v1/admin/schools/${MAPLE}/report`)) {
      return {
        schoolId: MAPLE,
        month: '2026-09',
        attributedSignups: '12',
        donationEligibleFamilies: '6',
        activeFamilies: '9',
        positivePayingFamilies: '7',
        fullyDiscountedFamilies: '2',
        accruedCents: 600,
        paidCents: 0,
      };
    }
    if (path.startsWith('/v1/admin/payouts?')) return { payouts: [] };
    return new Error(`unexpected GET ${path}`);
  };
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      try {
        const value = get(path);
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
        const value = send(call);
        if (value instanceof Error) return Promise.reject(value);
        return Promise.resolve(schema.parse(value));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
  return { api, sends };
}

afterEach(() => {
  cleanup();
});

describe('[RV-p17-ui-6] a carried-forward payout result names the month that was actually prepared', () => {
  // Spec P17: payout batches must be reconcilable; the owner sees amount owed versus paid. The
  // carried-forward notice states a net balance "through <month>", so it must describe the month
  // the API evaluated, not whatever is typed in the month field afterwards.
  it('[RV-p17-ui-6] changing the month field after preparing does not relabel the carried-forward balance', async () => {
    const { api, sends } = fakeApi(() => ({ status: 'carried_forward', netCents: -100 }));
    renderPage(<SchoolsAdminPage />, { api });
    const table = await screen.findByRole('table', { name: 'Schools' });
    await userEvent.click(
      within(table).getByRole('button', { name: 'Open Maple Grove Elementary' }),
    );
    const panel = await screen.findByRole('region', {
      name: 'Maple Grove Elementary: report and payouts',
    });
    const payouts = within(panel).getByRole('region', { name: 'Payouts' });
    const month = within(payouts).getByLabelText('Pay accruals through month');
    fireEvent.change(month, { target: { value: '2026-09' } });
    await userEvent.click(within(payouts).getByRole('button', { name: 'Prepare payout' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.body).toEqual({ schoolId: MAPLE, throughMonth: '2026-09' });
    expect(await within(payouts).findByText(/through September 2026/)).toBeTruthy();

    // The owner starts typing another month but does not prepare it.
    fireEvent.change(month, { target: { value: '2026-12' } });
    expect(sends).toHaveLength(1);
    expect(within(payouts).queryByText(/through December 2026/)).toBeNull();
  });
});
