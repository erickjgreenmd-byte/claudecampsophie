import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import type { ApiClient } from '@pencillift/contracts/client';
import { appRoutes, PORTAL_PAGE_TITLES } from './App.tsx';
import { routes } from './routes.tsx';
import type { AuthAdapter } from './lib/auth.ts';
import { RequireParent, SessionProvider } from './lib/session.tsx';

/**
 * WEB-R2-06 (WCAG 2.4.2 Page Titled, 2.4.3 Focus Order): only public pages set a document title, so
 * every /app, /admin and auth page kept index.html's "PencilLift — Turn homework into progress." and
 * a screen-reader user could not tell Homework from Privacy. The router shell had no focus
 * management and no scroll restoration, so a nav click from the bottom of a long page left the next
 * page scrolled down and announced nothing. Signed out, the portal pages had no h1 at all.
 *
 * WEB-R2-09: the root route had no HydrateFallback, so the first load rendered nothing (no brand bar,
 * no skip link) until the page chunk arrived, and React Router warned about it.
 *
 * Synthetic emails only; no network.
 */

const STATIC_TITLE = 'PencilLift — Turn homework into progress.';

const config = { apiBaseUrl: '/api', supabaseUrl: null, supabasePublishableKey: null };

const api: ApiClient = {
  get: () => Promise.reject(new Error('unexpected GET')),
  send: () => Promise.reject(new Error('unexpected send')),
};

function auth(signedIn: boolean): AuthAdapter {
  return {
    configured: true,
    currentSession: () =>
      Promise.resolve(
        signedIn ? { accessToken: 'synthetic-token', email: 'pat.parent@example.test' } : null,
      ),
    signOut: () => Promise.resolve(),
  };
}

const TITLED_PATHS: readonly string[] = PORTAL_PAGE_TITLES.map(([path]) => path);

function renderShell(path: string, options: { signedIn?: boolean; children?: RouteObject[] } = {}) {
  const children: RouteObject[] =
    options.children ??
    TITLED_PATHS.map((stub) => ({ path: stub, element: <h1>{`Page ${stub}`}</h1> }));
  const router = createMemoryRouter(appRoutes(children), { initialEntries: [path] });
  render(
    <SessionProvider value={{ config, auth: auth(options.signedIn ?? true), api }}>
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return router;
}

/** jsdom has no layout, so scroll restoration's scrollTo is a labeled stub here. */
let scrollTo = vi.fn();

beforeEach(() => {
  document.title = STATIC_TITLE;
  scrollTo = vi.fn();
  vi.stubGlobal('scrollTo', scrollTo);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('WEB-R2-06 page titles for the portal, admin and auth pages', () => {
  it('names every registered /app, /admin and auth route', () => {
    const registered = routes
      .map((route) => route.path)
      .filter(
        (path): path is string =>
          typeof path === 'string' &&
          (path.startsWith('/app') ||
            path.startsWith('/admin') ||
            ['/sign-in', '/sign-up', '/reset-password', '/update-password'].includes(path)),
      );
    expect([...TITLED_PATHS].sort()).toEqual([...registered].sort());
  });

  it.each(PORTAL_PAGE_TITLES)('sets the tab title on %s', async (path, title) => {
    renderShell(path);
    await waitFor(() => expect(document.title).toBe(`${title} · PencilLift`));
  });

  it('leaves a public page to set its own title', async () => {
    renderShell('/', { children: [{ path: '/', element: <h1>Home</h1> }] });
    expect(await screen.findByText('Home')).toBeTruthy();
    expect(document.title).toBe(STATIC_TITLE);
  });
});

describe('WEB-R2-06 focus and scroll on client-side navigation', () => {
  it('moves focus to the new page’s heading, and not on the first load', async () => {
    renderShell('/app/homework');
    const first = await screen.findByRole('heading', { level: 1 });
    // The first load must not steal focus from the top of the document.
    expect(document.activeElement).not.toBe(first);
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: 'Privacy & data' }));
    const heading = await screen.findByRole('heading', { level: 1, name: 'Page /app/privacy' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });

  it('restores the scroll position on navigation instead of keeping the old offset', async () => {
    renderShell('/app/homework');
    await screen.findByRole('heading', { level: 1 });
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: 'Privacy & data' }));
    await screen.findByRole('heading', { level: 1, name: 'Page /app/privacy' });
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
  });
});

describe('WEB-R2-06 the signed-out portal prompt', () => {
  it('has a heading of its own, so the page is not headless', async () => {
    renderShell('/app', {
      signedIn: false,
      children: [
        {
          path: '/app',
          element: (
            <RequireParent>
              <h1>Family</h1>
            </RequireParent>
          ),
        },
      ],
    });
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).toMatch(/sign in/i);
    expect(screen.getByRole('link', { name: 'sign in' })).toBeTruthy();
  });
});

describe('WEB-R2-09 first load before the page chunk arrives', () => {
  it('renders the brand shell as the hydrate fallback and warns about none', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const root = appRoutes([{ path: '/', element: <h1>Home</h1> }])[0];
    expect(root?.hydrateFallbackElement).toBeTruthy();
    const router = createMemoryRouter(
      appRoutes([
        {
          path: '/',
          lazy: () => Promise.resolve({ Component: () => <h1>Home</h1> }),
        },
      ]),
      { initialEntries: ['/'] },
    );
    render(
      <SessionProvider value={{ config, auth: auth(false), api }}>
        <RouterProvider router={router} />
      </SessionProvider>,
    );
    // While the page chunk loads, the parent still sees the brand bar and the skip link.
    expect(screen.getByRole('link', { name: 'PencilLift home' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Skip to content' })).toBeTruthy();
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
    expect(
      warn.mock.calls.filter((call) => String(call[0]).includes('HydrateFallback')),
    ).toHaveLength(0);
    warn.mockRestore();
  });
});
