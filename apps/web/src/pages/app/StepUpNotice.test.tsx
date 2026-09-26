import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import type { AuthAdapter } from '../../lib/auth.ts';
import { SessionProvider } from '../../lib/session.tsx';
import SecurityPage, { ActionFeedback, StepUpNotice } from './SecurityPage.tsx';

/**
 * WEB-R2-05: every step-up refusal outside the privacy page sent the parent to /app/security, which
 * unmounted the page and lost the typed child nickname, guardian email or support message, and the
 * Security page had no way back. The inline PIN prompt the privacy page already had is now the
 * shared one, so the PIN is entered in place; the fallback link keeps the return path.
 *
 * Pinned clock (L-027): every timestamp in this file comes from NOW. Synthetic PINs only.
 */

afterEach(cleanup);

const NOW = new Date('2026-09-25T18:00:00.000Z');
const UNLOCKED_UNTIL = new Date(NOW.getTime() + 5 * 60_000).toISOString();

const stepUp = new ApiRequestError('STEP_UP_REQUIRED', 'This action needs a recent unlock', 403);

function renderFeedback(send: ApiClient['send'], path = '/app/children') {
  const auth: AuthAdapter = {
    configured: true,
    currentSession: () =>
      Promise.resolve({ accessToken: 'synthetic-token', email: 'pat.parent@example.test' }),
    signOut: () => Promise.resolve(),
  };
  const router = createMemoryRouter(
    [
      {
        path,
        element: (
          <ActionFeedback
            feedback={{ kind: 'error', error: stepUp }}
            stepUpAction="Adding a child"
          />
        ),
      },
      { path: '/app/security', element: <h1>Security</h1> },
    ],
    { initialEntries: [path] },
  );
  render(
    <SessionProvider
      value={{
        config: { apiBaseUrl: '/api', supabaseUrl: null, supabasePublishableKey: null },
        auth,
        api: { get: () => Promise.reject(new Error('unexpected GET')), send },
      }}
    >
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return router;
}

describe('WEB-R2-05 step-up refusal is answered in place', () => {
  it('asks for the PIN on the page the parent was already on', async () => {
    const send = vi.fn(() => Promise.resolve({ unlockedUntil: UNLOCKED_UNTIL }));
    const router = renderFeedback(send as unknown as ApiClient['send']);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Parent PIN'), '284917');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(send).toHaveBeenCalledWith(
      'POST',
      '/v1/adult/unlock',
      { method: 'pin', pin: '284917' },
      expect.anything(),
    );
    expect(await screen.findByRole('status')).toBeTruthy();
    // The parent never left the page they were filling in.
    expect(router.state.location.pathname).toBe('/app/children');
  });

  it('keeps a Security-page link that carries the way back to where the parent was', async () => {
    const router = renderFeedback(() => Promise.reject(new Error('not used')));
    const user = userEvent.setup();
    const link = await screen.findByRole('link', { name: 'Unlock on the Security page' });
    // The address stays exactly /app/security: the learning-planner and rewards screens (other
    // areas' files) pin that href. The return path travels as router state instead, and the Security
    // page reads it with safeNextPath.
    expect(link.getAttribute('href')).toBe('/app/security');
    await user.click(link);
    expect(router.state.location.pathname).toBe('/app/security');
    expect(router.state.location.state).toEqual({ stepUpNext: '/app/children' });
  });

  it('names the action and reports a wrong PIN without leaving the page', async () => {
    const send = vi.fn(() =>
      Promise.reject(new ApiRequestError('FORBIDDEN', 'PIN not accepted', 403)),
    );
    const router = renderFeedback(send);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Parent PIN'), '111111');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('That PIN is not correct.')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/app/children');
  });

  it('StepUpNotice itself offers the inline prompt, so every page that renders it gets one', async () => {
    const auth: AuthAdapter = {
      configured: true,
      currentSession: () =>
        Promise.resolve({ accessToken: 'synthetic-token', email: 'pat.parent@example.test' }),
      signOut: () => Promise.resolve(),
    };
    const router = createMemoryRouter(
      [{ path: '/app/guardians', element: <StepUpNotice action="Inviting a guardian" /> }],
      { initialEntries: ['/app/guardians'] },
    );
    render(
      <SessionProvider
        value={{
          config: { apiBaseUrl: '/api', supabaseUrl: null, supabasePublishableKey: null },
          auth,
          api: {
            get: () => Promise.reject(new Error('unexpected GET')),
            send: (_method, _path, _body, schema) =>
              Promise.resolve(schema.parse({ unlockedUntil: UNLOCKED_UNTIL })),
          },
        }}
      >
        <RouterProvider router={router} />
      </SessionProvider>,
    );
    expect(await screen.findByLabelText('Parent PIN')).toBeTruthy();
    expect(screen.getByText(/Inviting a guardian/)).toBeTruthy();
    expect(router.state.location.pathname).toBe('/app/guardians');
  });
});

describe('WEB-R2-05 the Security page offers the way back', () => {
  const auth: AuthAdapter = {
    configured: true,
    currentSession: () =>
      Promise.resolve({ accessToken: 'synthetic-token', email: 'pat.parent@example.test' }),
    signOut: () => Promise.resolve(),
  };

  function renderSecurity(entry: string) {
    const router = createMemoryRouter(
      [
        { path: '/app/security', element: <SecurityPage /> },
        { path: '/app/guardians', element: <h1>Guardians</h1> },
      ],
      { initialEntries: [entry] },
    );
    render(
      <SessionProvider
        value={{
          config: { apiBaseUrl: '/api', supabaseUrl: null, supabasePublishableKey: null },
          auth,
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

  const backLink = async () =>
    (await screen.findByRole('link', { name: 'go back to what you were doing' })).getAttribute(
      'href',
    );

  it('follows the router state the inline prompt link carries', async () => {
    const router = renderSecurity('/app/guardians');
    await screen.findByRole('heading', { level: 1, name: 'Guardians' });
    await act(async () => {
      await router.navigate('/app/security', { state: { stepUpNext: '/app/guardians' } });
    });
    expect(await backLink()).toBe('/app/guardians');
  });

  it('accepts ?next= as well, and refuses an off-origin return path', async () => {
    renderSecurity('/app/security?next=%2Fapp%2Fguardians');
    expect(await backLink()).toBe('/app/guardians');
    cleanup();
    renderSecurity('/app/security?next=%2F%2Fevil.example');
    expect(await backLink()).toBe('/app');
  });
});
