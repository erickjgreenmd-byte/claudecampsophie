import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { appRoutes } from '../App.tsx';
import { unconfiguredAuth } from '../lib/auth.ts';
import { SessionProvider } from '../lib/session.tsx';
import {
  CHUNK_RELOAD_MARKER,
  claimChunkReload,
  isChunkLoadError,
  pageReload,
} from './RouteError.tsx';

/**
 * WEB-R1-02: a render error or a stale lazy chunk after a deploy must not replace the whole portal
 * with React Router's unbranded "Unexpected Application Error!" page. The brand bar stays, the
 * parent gets "Reload" and "Go to the family dashboard", and a chunk-load failure reloads the page
 * once (guarded by a sessionStorage marker, never a loop).
 */

const STALE_CHUNK = new TypeError(
  'Failed to fetch dynamically imported module: /assets/HomeworkPage-old.js',
);

function Boom(): never {
  throw new Error('synthetic render failure in a page');
}

const childRoutes: RouteObject[] = [
  { path: '/app/homework', lazy: () => Promise.reject(STALE_CHUNK) },
  { path: '/app/broken', element: <Boom /> },
  { path: '/app', element: <p>Family dashboard</p> },
];

function renderAt(url: string) {
  const router = createMemoryRouter(appRoutes(childRoutes), { initialEntries: [url] });
  render(
    <SessionProvider
      value={{
        config: { apiBaseUrl: '/api', supabaseUrl: null, supabasePublishableKey: null },
        auth: unconfiguredAuth,
        api: {
          get: () => Promise.reject(new Error('unexpected GET')),
          send: () => Promise.reject(new Error('unexpected send')),
        },
      }}
    >
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return router;
}

let reload: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  window.sessionStorage.clear();
  reload = vi.fn<() => void>();
  vi.spyOn(pageReload, 'reload').mockImplementation(reload);
  // React Router and React log caught route errors; keep the test output readable.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe('WEB-R1-02 route error boundary', () => {
  it('a page that throws keeps the brand bar and offers Reload and the family dashboard', async () => {
    renderAt('/app/broken');
    const alert = await screen.findByRole('alert');
    expect(document.body.textContent).not.toMatch(/Unexpected Application Error/);
    expect(document.body.textContent).not.toMatch(/synthetic render failure/);
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'PencilLift home' })).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(
      within(alert).getByRole('link', { name: 'Go to the family dashboard' }).getAttribute('href'),
    ).toBe('/app');
    expect(reload).not.toHaveBeenCalled();
    within(alert).getByRole('button', { name: 'Reload' }).click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a stale chunk after a deploy reloads the page once', async () => {
    renderAt('/app/homework');
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_MARKER)).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/Unexpected Application Error/);
    expect(screen.getByRole('link', { name: 'PencilLift home' })).toBeTruthy();
  });

  it('a chunk that still fails after the reload shows the error page instead of looping', async () => {
    window.sessionStorage.setItem(CHUNK_RELOAD_MARKER, String(Date.now()));
    renderAt('/app/homework');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/PencilLift was updated|couldn’t be shown/);
    expect(within(alert).getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/HomeworkPage-old/);
  });
});

describe('WEB-R1-02 chunk-load detection and the reload guard', () => {
  it('recognises the browsers’ dynamic-import failures and nothing else', () => {
    expect(isChunkLoadError(STALE_CHUNK)).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('synthetic render failure'))).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });

  it('allows one reload per window and never without storage', () => {
    const now = 1_790_000_000_000;
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(claimChunkReload(storage, now)).toBe(true);
    expect(claimChunkReload(storage, now + 1_000)).toBe(false);
    expect(claimChunkReload(storage, now + 11 * 60 * 1000)).toBe(true);
    expect(claimChunkReload(null, now)).toBe(false);
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(claimChunkReload(throwing, now)).toBe(false);
  });
});
