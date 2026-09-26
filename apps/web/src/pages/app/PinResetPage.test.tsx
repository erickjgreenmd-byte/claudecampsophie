import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { ApiClient } from '@pencillift/contracts/client';
import type { AccountAuth, AuthAdapter, AuthOutcome, ParentSession } from '../../lib/auth.ts';
import { SessionProvider } from '../../lib/session.tsx';
import PinResetPage from './PinResetPage.tsx';

/**
 * WEB-R2-08: "Confirm it's you" re-proves the account password with a password grant, which creates
 * a new Supabase session at aal1 and replaces the stored one. For an owner-admin that silently threw
 * away the aal2 session obtained on /admin/mfa, and every /admin page then refused with "Owner
 * administration requires an MFA session" with nothing on this page saying so.
 *
 * The API's PIN reset reads the re-authentication from the request token's `amr`
 * (apps/api/src/routes/adult.ts:83), so the fresh proof has to be on the portal's own session: the
 * new session stays, and the two-step factor is re-verified in the same flow to restore aal2 before
 * the new PIN is accepted. Synthetic emails, PINs and codes only; no network.
 */

afterEach(cleanup);

const SESSION: ParentSession = { accessToken: 'synthetic-token', email: 'pat.parent@example.test' };

/**
 * Labeled fake account, with the two spies the assertions need returned beside it (never read off
 * the object, which would bind `this` unintentionally).
 */
function fakeAccount(
  options: { level?: 'aal1' | 'aal2'; factorId?: string; codeAccepted?: boolean } = {},
): { account: AccountAuth; verifyTotp: ReturnType<typeof vi.fn> } {
  const verifyTotp = vi.fn(() =>
    Promise.resolve<AuthOutcome>(
      options.codeAccepted === false
        ? { ok: false, message: 'That code did not work.' }
        : { ok: true, next: 'done' },
    ),
  );
  const account: AccountAuth = {
    signInWithPassword: () => Promise.resolve<AuthOutcome>({ ok: true, next: 'signed_in' }),
    signUp: () => Promise.resolve({ ok: true, next: 'check_email' }),
    sendMagicLink: () => Promise.resolve({ ok: true, next: 'check_email' }),
    sendPasswordReset: () => Promise.resolve({ ok: true, next: 'check_email' }),
    updatePassword: () => Promise.resolve({ ok: true, next: 'done' }),
    assuranceLevel: () => Promise.resolve(options.level ?? 'aal1'),
    enrollTotp: () => Promise.resolve({ error: 'not used here' }),
    verifyTotp,
    verifiedTotpFactorId: () => Promise.resolve(options.factorId ?? null),
  };
  return { account, verifyTotp };
}

function renderPage(account: AccountAuth, send: ApiClient['send']) {
  const auth: AuthAdapter = {
    configured: true,
    account,
    currentSession: () => Promise.resolve(SESSION),
    signOut: () => Promise.resolve(),
  };
  const router = createMemoryRouter(
    [{ path: '/app/security/reset-pin', element: <PinResetPage /> }],
    { initialEntries: ['/app/security/reset-pin'] },
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

async function confirmPassword() {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Account password'), 'synthetic-current-pass');
  await user.click(screen.getByRole('button', { name: 'Confirm it’s you' }));
  return user;
}

describe('WEB-R2-08 PIN reset keeps an owner’s two-step (aal2) session', () => {
  it('says the two-step code will be needed again before it replaces the session', async () => {
    const { account } = fakeAccount({ level: 'aal2', factorId: 'synthetic-factor' });
    renderPage(account, (() => Promise.resolve({ ok: true })) as ApiClient['send']);
    expect(await screen.findByText(/two-step/i)).toBeTruthy();
  });

  it('re-verifies the two-step factor before the new PIN, restoring aal2 in the same flow', async () => {
    const { account, verifyTotp } = fakeAccount({
      level: 'aal2',
      factorId: 'synthetic-factor',
    });
    const send = vi.fn(() => Promise.resolve({ ok: true }));
    renderPage(account, send as unknown as ApiClient['send']);
    const user = await confirmPassword();
    // The PIN step is not reachable while the owner's session is still at aal1.
    const code = await screen.findByLabelText('Six-digit code from your authenticator app');
    expect(screen.queryByLabelText('New 6-digit PIN')).toBeNull();
    await user.type(code, '123456');
    await user.click(screen.getByRole('button', { name: 'Confirm two-step code' }));
    expect(verifyTotp).toHaveBeenCalledWith('synthetic-factor', '123456');
    await user.type(await screen.findByLabelText('New 6-digit PIN'), '284917');
    await user.type(screen.getByLabelText('Repeat the new PIN'), '284917');
    await user.click(screen.getByRole('button', { name: 'Save new PIN' }));
    expect(await screen.findByText(/Your new PIN is saved/)).toBeTruthy();
    expect(send).toHaveBeenCalledWith(
      'POST',
      '/v1/adult/pin/reset',
      { pin: '284917' },
      expect.anything(),
    );
  });

  it('keeps the two-step step in place when the code is refused', async () => {
    const { account } = fakeAccount({
      level: 'aal2',
      factorId: 'synthetic-factor',
      codeAccepted: false,
    });
    const send = vi.fn(() => Promise.resolve({ ok: true }));
    renderPage(account, send as unknown as ApiClient['send']);
    const user = await confirmPassword();
    await user.type(
      await screen.findByLabelText('Six-digit code from your authenticator app'),
      '000000',
    );
    await user.click(screen.getByRole('button', { name: 'Confirm two-step code' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByLabelText('New 6-digit PIN')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('goes straight to the new PIN for a parent without two-step verification', async () => {
    const { account, verifyTotp } = fakeAccount();
    const send = vi.fn(() => Promise.resolve({ ok: true }));
    renderPage(account, send as unknown as ApiClient['send']);
    const user = await confirmPassword();
    await user.type(await screen.findByLabelText('New 6-digit PIN'), '284917');
    await user.type(screen.getByLabelText('Repeat the new PIN'), '284917');
    await user.click(screen.getByRole('button', { name: 'Save new PIN' }));
    expect(await screen.findByText(/Your new PIN is saved/)).toBeTruthy();
    expect(verifyTotp).not.toHaveBeenCalled();
  });
});
