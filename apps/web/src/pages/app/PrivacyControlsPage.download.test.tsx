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

/**
 * `skewSeconds` is added to the signed link's `expiresAt`, as a slow device clock would see it.
 * `latencyMs` is how long each download response takes to come back (a number, or a function of the
 * call number), and `signedAts` records when each link was SIGNED — the API signs at the instant it
 * handles the request (createSignedReadUrl), so a slow round trip eats into the signature's life.
 */
interface ExportsOptions {
  skewSeconds?: number;
  latencyMs?: number | ((call: number) => number);
}

function renderExports(options: ExportsOptions = {}) {
  const skewSeconds = options.skewSeconds ?? 0;
  const signedAts: number[] = [];
  const api: ApiClient = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      if (path === '/v1/family') return Promise.resolve(schema.parse(FAMILY));
      if (path === '/v1/exports') return Promise.resolve(schema.parse({ exports: [READY_EXPORT] }));
      if (path === '/v1/deletion') return Promise.resolve(schema.parse({ requests: [] }));
      if (path === '/v1/safety-reports') return Promise.resolve(schema.parse({ reports: [] }));
      if (path === `/v1/exports/${EXPORT_ID}/download`) {
        const call = signedAts.push(Date.now());
        const body = {
          url: `https://storage.example.test/signed/progress-${call}.csv`,
          expiresAt: new Date(
            signedAts[call - 1]! + (LINK_SECONDS + skewSeconds) * 1000,
          ).toISOString(),
        };
        const wait =
          typeof options.latencyMs === 'function'
            ? options.latencyMs(call)
            : (options.latencyMs ?? 0);
        if (wait <= 0) return Promise.resolve(schema.parse(body));
        return new Promise<void>((resolve) => setTimeout(resolve, wait)).then(() =>
          schema.parse(body),
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
  return { signedAts };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

async function getLink(options: ExportsOptions = {}) {
  const { signedAts } = renderExports(options);
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const region = await screen.findByRole('region', { name: /export your data/i });
  await user.click(within(region).getByRole('button', { name: /get download link/i }));
  const first = typeof options.latencyMs === 'function' ? options.latencyMs(1) : options.latencyMs;
  if (first) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(first);
    });
  }
  await within(region).findByRole('link', { name: /download file/i });
  return { region, user, signedAts };
}

/** Moves the fake clock to an absolute instant and lets everything due settle. */
async function advanceTo(instant: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(Math.max(0, instant - Date.now()));
  });
}

describe('[WEBR4-08] an expired download link speaks with one voice', () => {
  it('drops the stale "ready" message so only the expiry line remains', async () => {
    const { region } = await getLink();
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
    const { region } = await getLink({ skewSeconds: SKEW_SECONDS });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LINK_SECONDS * 1000 + 1_000);
    });
    expect(within(region).queryByRole('link', { name: /download file/i })).toBeNull();
    expect(region.textContent).toMatch(/expired/i);
  });
});

/**
 * HUNT5-F-6: `expired` is cleared only at the top of fetchLink and set by the expiry timer, never
 * when a new link is stored. A parent who presses "Get a new link" shortly before the old window ends
 * has the old timer fire while the request is in flight, so the fresh, valid link renders above
 * "That download link expired for your safety. Ask for a new one" — the two-voice defect WEBR4-08 was
 * filed for, with the other half of the pair still in place.
 */
describe('[HUNT5-F-6] a fresh link is never shown beside the expiry line', () => {
  it('clears the expiry notice when the replacement link arrives', async () => {
    // The first link lands at once; the replacement takes ten seconds, as a cold Worker would.
    const { region, user, signedAts } = await getLink({
      latencyMs: (call) => (call === 1 ? 0 : 10_000),
    });
    const firstLinkAt = signedAts[0]!;
    // Five seconds before the old window ends, the parent asks for another.
    await advanceTo(firstLinkAt + 55_000);
    await user.click(within(region).getByRole('button', { name: /get a new link/i }));
    // The old timer fires while the second request is still in flight.
    await advanceTo(firstLinkAt + 61_000);
    expect(region.textContent).toMatch(/expired/i);
    // Now the replacement lands.
    await advanceTo(firstLinkAt + 66_000);
    expect(within(region).getByRole('link', { name: /download file/i })).toBeTruthy();
    expect(region.textContent).not.toMatch(/expired/i);
  });
});

/**
 * HUNT5-F-7: WEBR4-09 made the window a fixed 60s started when the response LANDS, so the whole round
 * trip is added to the signature's life — the API signs when it handles the request. The page then
 * offers the URL after the signature has died, and clicking it fetches the storage service's error
 * document. `expiresAt` is parsed and displayed, so the bound is in hand.
 */
describe('[HUNT5-F-7] the link is dropped by its signature’s own end', () => {
  it('does not stay clickable for the round trip after the signature died', async () => {
    const { region, signedAts } = await getLink({ latencyMs: 3_000 });
    // Half a second past the instant the signature was signed to expire.
    await advanceTo(signedAts[0]! + LINK_SECONDS * 1000 + 500);
    expect(within(region).queryByRole('link', { name: /download file/i })).toBeNull();
    expect(region.textContent).toMatch(/expired/i);
  });

  it('keeps a valid link for its whole minute when the device clock runs ahead', async () => {
    // The other half of WEBR4-09: a device five minutes AHEAD reads expiresAt as already past, so
    // bounding the window by `expiresAt - <this clock>` would drop a perfectly good link at once.
    const { region, signedAts } = await getLink({ skewSeconds: -SKEW_SECONDS });
    await advanceTo(signedAts[0]! + 30_000);
    expect(within(region).getByRole('link', { name: /download file/i })).toBeTruthy();
    expect(region.textContent).not.toMatch(/expired/i);
  });

  it('still keeps the device-clock ceiling when the device clock runs behind', async () => {
    // A device five minutes behind reads expiresAt as five minutes further off; the fixed window is
    // what must still bound the link (WEBR4-09), so it goes at 60s, not at 360s.
    const { region, signedAts } = await getLink({ skewSeconds: SKEW_SECONDS });
    await advanceTo(signedAts[0]! + LINK_SECONDS * 1000 + 1_000);
    expect(within(region).queryByRole('link', { name: /download file/i })).toBeNull();
    expect(region.textContent).toMatch(/expired/i);
  });
});
