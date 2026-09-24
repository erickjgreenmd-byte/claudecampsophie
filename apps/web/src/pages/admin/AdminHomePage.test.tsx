import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import AdminHomePage from './AdminHomePage.tsx';

afterEach(() => {
  cleanup();
});

function apiWith(get: (path: string) => unknown): Partial<ApiClient> {
  return {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      const value = get(path);
      if (value instanceof Error) return Promise.reject(value);
      try {
        return Promise.resolve(schema.parse(value));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

const readiness = {
  environment: 'development',
  checks: [
    {
      check: 'consent_provider',
      status: 'blocked',
      detail: 'Verifiable parental consent provider',
    },
    { check: 'billing_provider', status: 'blocked', detail: 'RevenueCat server credentials' },
    { check: 'cors', status: 'ready', detail: 'Explicit CORS origins' },
  ],
};

describe('AdminHomePage (spec P14 owner admin; AC_UX_02)', () => {
  it('shows the MFA requirement instead of any admin data when the API refuses', async () => {
    const api = apiWith(
      () => new ApiRequestError('FORBIDDEN', 'Owner administration requires an MFA session', 403),
    );
    renderPage(<AdminHomePage />, { api });
    expect(await screen.findByText(/Owner administration requires an MFA session/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('lists every readiness check with blocked items visible in text, not hidden', async () => {
    const api = apiWith((path) => (path === '/v1/admin/readiness' ? readiness : new Error(path)));
    renderPage(<AdminHomePage />, { api });
    const table = await screen.findByRole('table', { name: /Production readiness/ });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4); // header + 3 checks
    expect(within(rows[1]!).getByText('Parental consent provider')).toBeTruthy();
    expect(within(rows[1]!).getByText(/Blocked/)).toBeTruthy();
    expect(within(rows[3]!).getByText(/Ready/)).toBeTruthy();
    expect(screen.getByText(/2 of 3 checks are blocked/)).toBeTruthy();
    expect(screen.getByText('development')).toBeTruthy();
    // Navigation to the other owner consoles.
    expect(screen.getAllByRole('link', { name: 'Promotions' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Schools and payouts' }).length).toBeGreaterThan(0);
  });

  it('offers a retry for a non-permission failure', async () => {
    const api = apiWith(() => new ApiRequestError('NETWORK', 'You appear to be offline.', 0));
    renderPage(<AdminHomePage />, { api });
    expect(await screen.findByText(/You appear to be offline/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
