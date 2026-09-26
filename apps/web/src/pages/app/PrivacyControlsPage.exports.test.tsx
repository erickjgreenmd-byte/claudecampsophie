import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { ApiClient } from '@pencillift/contracts/client';
import type { AuthAdapter } from '../../lib/auth.ts';
import { SessionProvider } from '../../lib/session.tsx';
import PrivacyControlsPage from './PrivacyControlsPage.tsx';

/**
 * WEB-R2-07: an export download link is signed for 60 s (api/src/routes/export-download.ts:8), but
 * the page replaced "Get download link" with the link for good. A parent who clicked a minute later
 * — after reading the notice, or after switching tabs — got the storage service's error document,
 * and the page still showed the dead link with no way to ask for a fresh one.
 *
 * Pinned clock (L-027): every instant below is derived from NOW, and the test advances that same
 * clock. Synthetic family, child and storage host only.
 */

const NOW = new Date('2026-09-25T15:00:00.000Z');
const LINK_SECONDS = 60;

const FAMILY_ID = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const EXPORT_ID = 'ad5a6b7c-8d9e-4f0a-9b2c-3d4e5f6a7b8c';

const FAMILY = { id: FAMILY_ID, children: [{ id: RILEY, nickname: 'Riley', status: 'active' }] };
const READY_EXPORT = {
  id: EXPORT_ID,
  kind: 'progress_csv',
  childId: null,
  status: 'ready',
  createdAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
  expiresAt: new Date(NOW.getTime() + 7 * 86_400_000).toISOString(),
};

const auth: AuthAdapter = {
  configured: true,
  currentSession: () =>
    Promise.resolve({ accessToken: 'synthetic-token', email: 'pat.parent@example.test' }),
  signOut: () => Promise.resolve(),
};

function renderExports() {
  const downloads: string[] = [];
  const api: ApiClient = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      if (path === '/v1/family') return Promise.resolve(schema.parse(FAMILY));
      if (path === '/v1/exports') return Promise.resolve(schema.parse({ exports: [READY_EXPORT] }));
      if (path === '/v1/deletion') return Promise.resolve(schema.parse({ requests: [] }));
      if (path === '/v1/safety-reports') return Promise.resolve(schema.parse({ reports: [] }));
      if (path === `/v1/exports/${EXPORT_ID}/download`) {
        downloads.push(path);
        // Every signed link is stamped from the pinned clock the test advances.
        return Promise.resolve(
          schema.parse({
            url: `https://storage.example.test/signed/progress-${downloads.length}.csv`,
            expiresAt: new Date(Date.now() + LINK_SECONDS * 1000).toISOString(),
          }),
        );
      }
      return Promise.reject(new Error(`unexpected GET ${path}`));
    },
    send: () => Promise.reject(new Error('unexpected send')),
  };
  const router = createMemoryRouter([{ path: '/app/privacy', element: <PrivacyControlsPage /> }], {
    initialEntries: ['/app/privacy'],
  });
  render(
    <SessionProvider
      value={{
        config: { apiBaseUrl: '/api', supabaseUrl: null, supabasePublishableKey: null },
        auth,
        api,
      }}
    >
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return { downloads };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('WEB-R2-07 an export download link that has expired', () => {
  it('stops offering the dead link and always keeps a way to ask for a fresh one', async () => {
    const { downloads } = renderExports();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const region = await screen.findByRole('region', { name: /export your data/i });
    await user.click(within(region).getByRole('button', { name: /get download link/i }));
    const link = await within(region).findByRole('link', { name: /download file/i });
    expect(link.getAttribute('href')).toBe('https://storage.example.test/signed/progress-1.csv');
    // A fresh link is available even before this one dies: one click, no page reload.
    expect(within(region).getByRole('button', { name: /new link/i })).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LINK_SECONDS * 1000 + 1_000);
    });
    expect(within(region).queryByRole('link', { name: /download file/i })).toBeNull();
    expect(region.textContent).toMatch(/expired/i);

    await user.click(within(region).getByRole('button', { name: /new link/i }));
    const fresh = await within(region).findByRole('link', { name: /download file/i });
    expect(fresh.getAttribute('href')).toBe('https://storage.example.test/signed/progress-2.csv');
    expect(downloads).toHaveLength(2);
  });
});
