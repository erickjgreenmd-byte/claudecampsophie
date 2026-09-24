import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { unconfiguredAuth } from '../../lib/auth.ts';
import { renderPage } from '../../test/render.tsx';
import SecurityPage from './SecurityPage.tsx';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Fake API: responses are validated through the real contract schemas. */
function fakeApi(send: (call: Call) => unknown) {
  const sends: Call[] = [];
  const api: Partial<ApiClient> = {
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

afterEach(cleanup);

describe('SecurityPage', () => {
  it('shows an honest state when parent sign-in is not configured', async () => {
    renderPage(<SecurityPage />, { auth: unconfiguredAuth });
    expect(await screen.findByText(/Parent sign-in isn’t available yet/)).toBeTruthy();
    expect(screen.queryByLabelText('Parent PIN')).toBeNull();
  });

  it('explains step-up and that the PIN is not consent', async () => {
    renderPage(<SecurityPage />, { api: fakeApi(() => ({})).api });
    expect(await screen.findByText(/What the parent PIN protects/)).toBeTruthy();
    expect(screen.getByText(/not proof of parental consent/)).toBeTruthy();
    // A forgotten PIN has a working, verified reset path (RV-family-4), not a dead end.
    expect(screen.queryByText(/isn’t available in the portal yet/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Reset your parent PIN' }).getAttribute('href')).toBe(
      '/app/security/reset-pin',
    );
    expect(screen.getByText(/confirming it’s you with your account password/)).toBeTruthy();
  });

  it('unlocks with the PIN, shows when the unlock ends and clears the field', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi(() => ({ unlockedUntil: '2026-09-24T15:05:00.000Z' }));
    renderPage(<SecurityPage />, { api });
    const input = await screen.findByLabelText('Parent PIN');
    await user.type(input, '482913');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText(/Unlocked until/)).toBeTruthy();
    expect(sends).toEqual([
      { method: 'POST', path: '/v1/adult/unlock', body: { method: 'pin', pin: '482913' } },
    ]);
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('shows a clear message for an incorrect PIN and for a lockout', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const { api } = fakeApi(() => {
      attempt += 1;
      return attempt === 1
        ? new ApiRequestError('FORBIDDEN', 'Incorrect PIN', 403)
        : new ApiRequestError('LOCKED_OUT', 'Too many incorrect PINs. Try again later.', 423);
    });
    renderPage(<SecurityPage />, { api });
    const input = await screen.findByLabelText('Parent PIN');
    await user.type(input, '482913');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('That PIN is not correct.')).toBeTruthy();
    await user.type(input, '482914');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText(/Too many incorrect PINs/)).toBeTruthy();
    // A locked-out parent is pointed at the verified reset, as the API message suggests.
    expect(screen.getByRole('link', { name: 'Reset it' }).getAttribute('href')).toBe(
      '/app/security/reset-pin',
    );
  });

  it('does not send an incomplete PIN', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi(() => ({}));
    renderPage(<SecurityPage />, { api });
    await user.type(await screen.findByLabelText('Parent PIN'), '12');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(screen.getByText('Enter your 6-digit parent PIN.')).toBeTruthy();
    expect(sends).toHaveLength(0);
  });

  it('locks on request', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi(() => ({ ok: true }));
    renderPage(<SecurityPage />, { api });
    await user.click(await screen.findByRole('button', { name: 'Lock now' }));
    expect(
      await screen.findByText(/Locked\. Sensitive actions need your PIN again\./),
    ).toBeTruthy();
    expect(sends).toEqual([{ method: 'POST', path: '/v1/adult/lock', body: undefined }]);
  });

  it('gives weak-PIN feedback and refuses to submit a weak or mismatched PIN', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi(() => ({ ok: true }));
    renderPage(<SecurityPage />, { api });
    const pin = await screen.findByLabelText('New PIN');
    await user.type(pin, '123456');
    expect(screen.getByText('Avoid counting up or down.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save PIN' }));
    expect(sends).toHaveLength(0);

    await user.clear(pin);
    await user.type(pin, '482913');
    expect(screen.queryByText('Avoid counting up or down.')).toBeNull();
    await user.type(screen.getByLabelText('Confirm new PIN'), '482914');
    await user.click(screen.getByRole('button', { name: 'Save PIN' }));
    expect(screen.getByText('The two PINs don’t match.')).toBeTruthy();
    expect(sends).toHaveLength(0);
  });

  it('saves a new PIN', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi(() => ({ ok: true }));
    renderPage(<SecurityPage />, { api });
    await user.type(await screen.findByLabelText('New PIN'), '482913');
    await user.type(screen.getByLabelText('Confirm new PIN'), '482913');
    await user.click(screen.getByRole('button', { name: 'Save PIN' }));
    expect(await screen.findByText('Your parent PIN is saved.')).toBeTruthy();
    expect(sends).toEqual([{ method: 'PUT', path: '/v1/adult/pin', body: { pin: '482913' } }]);
  });

  it('explains that changing an existing PIN needs a step-up first', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi(
      () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN to continue', 403),
    );
    renderPage(<SecurityPage />, { api });
    await user.type(await screen.findByLabelText('New PIN'), '482913');
    await user.type(screen.getByLabelText('Confirm new PIN'), '482913');
    await user.click(screen.getByRole('button', { name: 'Save PIN' }));
    await waitFor(() =>
      expect(screen.getByText(/Changing an existing PIN needs a recent PIN unlock/)).toBeTruthy(),
    );
    expect(screen.getByRole('link', { name: 'Unlock on the Security page' })).toBeTruthy();
  });
});
