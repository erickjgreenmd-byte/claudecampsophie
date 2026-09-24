import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { ApiClient } from '@pencillift/contracts/client';
import type { AuthAdapter } from '../lib/auth.ts';
import { SessionProvider } from '../lib/session.tsx';

/** Test helper: renders a page inside a memory router with a signed-in (or chosen) session and fake API. */
export function renderPage(
  element: ReactElement,
  options: { api?: Partial<ApiClient>; auth?: AuthAdapter; path?: string } = {},
) {
  const auth: AuthAdapter =
    options.auth ??
    ({
      configured: true,
      currentSession: () =>
        Promise.resolve({ accessToken: 'test-token', email: 'parent@example.test' }),
      signOut: () => Promise.resolve(),
    } satisfies AuthAdapter);
  const api: ApiClient = {
    get: () => Promise.reject(new Error('unexpected GET')),
    send: () => Promise.reject(new Error('unexpected send')),
    ...options.api,
  };
  const router = createMemoryRouter([{ path: options.path ?? '/', element }], {
    initialEntries: [options.path ?? '/'],
  });
  return render(
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
