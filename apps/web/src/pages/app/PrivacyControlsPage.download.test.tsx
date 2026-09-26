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
 * Round-4 hardening of the WEB-R2-07 export download link. Synthetic family and storage host only;
 * pinned clock (L-027), and every instant below is derived from NOW.
 *
 *  - WEBR4-08 the expiry timer dropped `link` but left the stale "Your download link is ready."
 *    outcome, and the render order then showed it again beside "That download link expired": two
 *    contradicting role="status" lines, both read out.
 *  - WEBR4-09 the window was `expiresAt - Date.now()`, the signer's clock minus the device's. A
 *    device five minutes behind kept the dead link on screen and clickable for five minutes.
 */

const NOW = new Date('2026-09-25T15:00:00.000Z');
const LINK_SECONDS = 60;
/** The skew this test simulates: the device's clock runs five minutes behind the signer's. */
const SKEW_SECONDS = 300;

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

/** `skewSeconds` is added to the signed link's `expiresAt`, as a slow device clock would see it. */
function renderExports(skewSeconds = 0) {
  const api: ApiClient = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      if (path === '/v1/family') return Promise.resolve(schema.parse(FAMILY));
      if (path === '/v1/exports') return Promise.resolve(schema.parse({ exports: [READY_EXPORT] }));
      if (path === '/v1/deletion') return Promise.resolve(schema.parse({ requests: [] }));
      if (path === '/v1/safety-reports') return Promise.resolve(schema.parse({ reports: [] }));
      if (path === `/v1/exports/${EXPORT_ID}/download`) {
        return Promise.resolve(
          schema.parse({
            url: 'https://storage.example.test/signed/progress.csv',
            expiresAt: new Date(Date.now() + (LINK_SECONDS + skewSeconds) * 1000).toISOString(),
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
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

async function getLink(skewSeconds = 0) {
  renderExports(skewSeconds);
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const region = await screen.findByRole('region', { name: /export your data/i });
  await user.click(within(region).getByRole('button', { name: /get download link/i }));
  await within(region).findByRole('link', { name: /download file/i });
  return region;
}

describe('[WEBR4-08] an expired download link speaks with one voice', () => {
  it('drops the stale "ready" message so only the expiry line remains', async () => {
    const region = await getLink();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LINK_SECONDS * 1000 + 1_000);
    });
    const statuses = within(region)
      .getAllByRole('status')
      .map((n) => n.textContent ?? '');
    expect(statuses.some((s) => /expired/i.test(s))).toBe(true);
    expect(statuses.some((s) => /link is ready/i.test(s))).toBe(false);
  });
});

describe('[WEBR4-09] the link window is measured on one clock', () => {
  it('drops the link after its own lifetime even when the device clock is behind', async () => {
    const region = await getLink(SKEW_SECONDS);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LINK_SECONDS * 1000 + 1_000);
    });
    expect(within(region).queryByRole('link', { name: /download file/i })).toBeNull();
    expect(region.textContent).toMatch(/expired/i);
  });
});
