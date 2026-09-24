import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { GuardiansOverview } from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { SessionProvider } from '../../lib/session.tsx';
import { renderPage } from '../../test/render.tsx';
import GuardiansPage from './GuardiansPage.tsx';

// Synthetic adults only.
const OWNER = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const GUARDIAN = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const INVITE = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const FAMILY = '9c4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b';
const TOKEN = 'k3Jx9QpL2mN8vB4cR7tY1wZ5aS6dF0gH-_eU3iO9pQ';
const AT = '2026-09-24T15:00:00.000Z';
const LATER = '2026-10-01T15:00:00.000Z';

function ownerView(overrides: Partial<GuardiansOverview> = {}): GuardiansOverview {
  return {
    callerRole: 'owner',
    maxAdults: 2,
    members: [
      {
        userId: OWNER,
        role: 'owner',
        email: 'riley.parent@example.test',
        isYou: true,
        acceptedAt: AT,
      },
    ],
    pendingInvitations: [
      { id: INVITE, email: 'sam.guardian@example.test', expiresAt: LATER, createdAt: AT },
    ],
    ...overrides,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeApi(options: { get?: () => unknown; send?: (call: Call) => unknown } = {}) {
  const gets: string[] = [];
  const sends: Call[] = [];
  const settle = <S extends z.ZodType>(value: unknown, schema: S) => {
    try {
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(schema.parse(value));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      gets.push(path);
      return settle(options.get ? options.get() : ownerView(), schema);
    },
    send: <S extends z.ZodType>(
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      body: unknown,
      schema: S,
    ) => {
      const call = { method, path, body };
      sends.push(call);
      return settle(options.send?.(call), schema);
    },
  };
  return { api, gets, sends };
}

afterEach(cleanup);

/**
 * Like renderPage, but the route pattern and the opened URL differ: the emailed link opens
 * `/app/guardians#accept=<token>` (renderPage uses one string for both).
 */
function renderAcceptLink(api: Partial<ApiClient>) {
  const router = createMemoryRouter([{ path: '/app/guardians', element: <GuardiansPage /> }], {
    initialEntries: [`/app/guardians#accept=${TOKEN}`],
  });
  const client: ApiClient = {
    get: () => Promise.reject(new Error('unexpected GET')),
    send: () => Promise.reject(new Error('unexpected send')),
    ...api,
  };
  const view = render(
    <SessionProvider
      value={{
        config: { apiBaseUrl: '/api', supabaseUrl: null, supabasePublishableKey: null },
        auth: {
          configured: true,
          currentSession: () =>
            Promise.resolve({ accessToken: 'test-token', email: 'sam.guardian@example.test' }),
          signOut: () => Promise.resolve(),
        },
        api: client,
      }}
    >
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return { ...view, router };
}

describe('GuardiansPage', () => {
  it('shows members, pending invitations and sends an invitation', async () => {
    const user = userEvent.setup();
    const { api, sends, gets } = fakeApi({
      send: () => ({
        invitationId: INVITE,
        email: 'jordan.adult@example.test',
        status: 'pending',
        expiresAt: LATER,
      }),
    });
    renderPage(<GuardiansPage />, { api });
    expect(await screen.findByText('Owner (you): riley.parent@example.test')).toBeTruthy();
    expect(screen.getByText('sam.guardian@example.test')).toBeTruthy();
    await user.type(
      screen.getByLabelText('Guardian’s email address'),
      ' jordan.adult@example.test ',
    );
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText(/Invitation sent to jordan\.adult@example\.test/)).toBeTruthy();
    expect(sends).toEqual([
      {
        method: 'POST',
        path: '/v1/guardians/invitations',
        body: { email: 'jordan.adult@example.test' },
      },
    ]);
    await waitFor(() => expect(gets.length).toBe(2));
  });

  it('validates the email and explains step-up for invitations', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi({
      send: () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403),
    });
    renderPage(<GuardiansPage />, { api });
    await user.type(await screen.findByLabelText('Guardian’s email address'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(screen.getByText('Enter a valid email address.')).toBeTruthy();
    expect(sends).toHaveLength(0);
    await user.clear(screen.getByLabelText('Guardian’s email address'));
    await user.type(screen.getByLabelText('Guardian’s email address'), 'sam@example.test');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText(/Inviting a guardian needs a recent PIN unlock/)).toBeTruthy();
  });

  it('cancels a pending invitation', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi({ send: () => ({ ok: true }) });
    renderPage(<GuardiansPage />, { api });
    await user.click(
      await screen.findByRole('button', {
        name: 'Cancel invitation to sam.guardian@example.test',
      }),
    );
    await waitFor(() =>
      expect(sends).toEqual([
        { method: 'POST', path: `/v1/guardians/invitations/${INVITE}/revoke`, body: undefined },
      ]),
    );
  });

  it('removes the guardian after confirmation and hides the invite form when full', async () => {
    const user = userEvent.setup();
    const full = ownerView({
      members: [
        {
          userId: OWNER,
          role: 'owner',
          email: 'riley.parent@example.test',
          isYou: true,
          acceptedAt: AT,
        },
        {
          userId: GUARDIAN,
          role: 'guardian',
          email: 's***n@example.test',
          isYou: false,
          acceptedAt: AT,
        },
      ],
      pendingInvitations: [],
    });
    const { api, sends } = fakeApi({ get: () => full, send: () => ({ ok: true }) });
    renderPage(<GuardiansPage />, { api });
    expect(await screen.findByText('Guardian: s***n@example.test')).toBeTruthy();
    expect(screen.queryByLabelText('Guardian’s email address')).toBeNull();
    expect(screen.getByText(/already has the maximum of 2 adults/)).toBeTruthy();
    expect(screen.getByText('No invitations are waiting.')).toBeTruthy();

    const row = screen.getByText('Guardian: s***n@example.test').closest('li')!;
    await user.click(within(row).getByRole('button', { name: 'Remove guardian' }));
    expect(
      within(row).getByText(/lose access to your family and children immediately/),
    ).toBeTruthy();
    await user.click(within(row).getByRole('button', { name: 'Yes, remove' }));
    await waitFor(() =>
      expect(sends).toEqual([
        { method: 'DELETE', path: `/v1/guardians/${GUARDIAN}`, body: undefined },
      ]),
    );
  });

  it('a guardian sees the family but no owner-only controls', async () => {
    const guardianView: GuardiansOverview = {
      callerRole: 'guardian',
      maxAdults: 2,
      members: [
        { userId: OWNER, role: 'owner', email: 'r***t@example.test', isYou: false, acceptedAt: AT },
        {
          userId: GUARDIAN,
          role: 'guardian',
          email: 'sam.guardian@example.test',
          isYou: true,
          acceptedAt: AT,
        },
      ],
      pendingInvitations: [],
    };
    renderPage(<GuardiansPage />, { api: fakeApi({ get: () => guardianView }).api });
    expect(await screen.findByText('Owner: r***t@example.test')).toBeTruthy();
    expect(screen.getByText('Only the family owner can invite or remove guardians.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove guardian' })).toBeNull();
    expect(screen.queryByLabelText('Guardian’s email address')).toBeNull();
  });

  it('accepts an invitation from the emailed link without showing the token', async () => {
    const user = userEvent.setup();
    let joined = false;
    const { api, sends } = fakeApi({
      get: () =>
        joined
          ? ownerView({ callerRole: 'guardian', pendingInvitations: [] })
          : new ApiRequestError('NOT_FOUND', 'Create your family first', 404),
      send: () => {
        joined = true;
        return { familyId: FAMILY, role: 'guardian' };
      },
    });
    const { container, router } = renderAcceptLink(api);
    await user.click(await screen.findByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByText('You joined the family as a guardian.')).toBeTruthy();
    expect(sends).toEqual([
      { method: 'POST', path: '/v1/invitations/accept', body: { token: TOKEN } },
    ]);
    expect(container.innerHTML).not.toContain(TOKEN);
    // The token was removed from the address (and history entry) as soon as it was captured.
    expect(router.state.location.hash).toBe('');
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).toBeNull();
    expect(await screen.findByText(/Only the family owner can invite/)).toBeTruthy();
  });

  it('explains a mismatched or expired invitation', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi({
      get: () => new ApiRequestError('NOT_FOUND', 'Create your family first', 404),
      send: () =>
        new ApiRequestError(
          'FORBIDDEN',
          'This invitation was sent to a different email address',
          403,
          'INVITATION_EMAIL_MISMATCH',
        ),
    });
    renderAcceptLink(api);
    await user.click(await screen.findByRole('button', { name: 'Accept invitation' }));
    expect(
      await screen.findByText('This invitation was sent to a different email address'),
    ).toBeTruthy();
  });

  it('shows a not-in-family state without an invitation link', async () => {
    renderPage(<GuardiansPage />, {
      api: fakeApi({ get: () => new ApiRequestError('NOT_FOUND', 'Create your family first', 404) })
        .api,
    });
    expect(await screen.findByText('You’re not part of a family yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).toBeNull();
  });
});
