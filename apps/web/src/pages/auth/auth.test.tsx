import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@pencillift/contracts/client';
import {
  safeNextPath,
  unconfiguredAuth,
  type AccountAuth,
  type AuthAdapter,
  type AuthOutcome,
} from '../../lib/auth.ts';
import { createSupabaseAuth } from '../../lib/supabase-auth.ts';
import { renderPage } from '../../test/render.tsx';
import PinResetPage from '../app/PinResetPage.tsx';
import SignInPage from './SignInPage.tsx';
import SignUpPage from './SignUpPage.tsx';

afterEach(cleanup);

const done: AuthOutcome = { ok: true, next: 'check_email' };

function fakeAccount(overrides: Partial<AccountAuth> = {}): AccountAuth {
  return {
    signInWithPassword: vi.fn(() => Promise.resolve<AuthOutcome>({ ok: true, next: 'signed_in' })),
    signUp: vi.fn(() => Promise.resolve(done)),
    sendMagicLink: vi.fn(() => Promise.resolve(done)),
    sendPasswordReset: vi.fn(() => Promise.resolve(done)),
    updatePassword: vi.fn(() => Promise.resolve<AuthOutcome>({ ok: true, next: 'done' })),
    assuranceLevel: vi.fn(() => Promise.resolve<'aal1'>('aal1')),
    enrollTotp: vi.fn(() => Promise.resolve({ error: 'unused' })),
    verifyTotp: vi.fn(() => Promise.resolve<AuthOutcome>({ ok: true, next: 'done' })),
    verifiedTotpFactorId: vi.fn(() => Promise.resolve(null)),
    ...overrides,
  };
}

function authWith(account: AccountAuth, signedIn = false): AuthAdapter {
  return {
    configured: true,
    account,
    currentSession: () =>
      Promise.resolve(
        signedIn ? { accessToken: 'test-token', email: 'riley.parent@example.test' } : null,
      ),
    signOut: () => Promise.resolve(),
  };
}

describe('safeNextPath (no open redirect after sign-in)', () => {
  it('keeps same-origin paths and rejects everything else', () => {
    expect(safeNextPath('/app/rewards?x=1')).toBe('/app/rewards?x=1');
    expect(safeNextPath('//evil.example/phish')).toBe('/app');
    expect(safeNextPath('https://evil.example')).toBe('/app');
    expect(safeNextPath('/\\evil.example')).toBe('/app');
    expect(safeNextPath(null)).toBe('/app');
  });
});

describe('sign-in and sign-up pages', () => {
  it('shows an honest not-configured state instead of a fake login', () => {
    renderPage(<SignInPage />, { auth: unconfiguredAuth, path: '/sign-in' });
    expect(screen.getByText(/sign-in isn’t available yet/i)).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('validates the email, then signs in with the trimmed address', async () => {
    const signIn = vi.fn(() => Promise.resolve<AuthOutcome>({ ok: true, next: 'signed_in' }));
    const account = fakeAccount({ signInWithPassword: signIn });
    renderPage(<SignInPage />, { auth: authWith(account), path: '/sign-in' });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/valid email/i);
    expect(signIn).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), '  riley.parent@example.test ');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(signIn).toHaveBeenCalledWith('riley.parent@example.test', 'correct horse battery'),
    );
  });

  it('a magic link answer never reveals whether the account exists', async () => {
    const account = fakeAccount();
    renderPage(<SignInPage />, { auth: authWith(account), path: '/sign-in' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /email link instead/i }));
    await user.type(screen.getByLabelText('Email'), 'someone@example.test');
    await user.click(screen.getByRole('button', { name: /sign-in link/i }));
    expect(await screen.findByText(/if that email has a pencillift account/i)).toBeTruthy();
  });

  it('sign-up enforces password length and confirmation before calling the service', async () => {
    const signUp = vi.fn(() => Promise.resolve(done));
    const account = fakeAccount({ signUp });
    renderPage(<SignUpPage />, { auth: authWith(account), path: '/sign-up' });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'sam.parent@example.test');
    await user.type(screen.getByLabelText('Password'), 'short');
    await user.type(screen.getByLabelText('Confirm password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/at least 12/i);
    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), 'a-long-enough-password');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/do not match/i);
    expect(signUp).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText('Confirm password'));
    await user.type(screen.getByLabelText('Confirm password'), 'a-long-enough-password');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText(/check your email for a verification link/i)).toBeTruthy();
  });
});

describe('PIN reset requires re-entering the account password (spec P3)', () => {
  it('re-authenticates with the session email, then saves the PIN through the API', async () => {
    const signIn = vi.fn(() => Promise.resolve<AuthOutcome>({ ok: true, next: 'signed_in' }));
    const account = fakeAccount({ signInWithPassword: signIn });
    const send = vi.fn(() => Promise.resolve({ ok: true }));
    renderPage(<PinResetPage />, {
      auth: authWith(account, true),
      api: { send: send as never },
      path: '/app/security/reset-pin',
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Account password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: /confirm it’s you/i }));
    expect(signIn).toHaveBeenCalledWith('riley.parent@example.test', 'correct horse battery');
    await user.type(await screen.findByLabelText('New 6-digit PIN'), '731846');
    await user.type(screen.getByLabelText('Repeat the new PIN'), '731840');
    await user.click(screen.getByRole('button', { name: 'Save new PIN' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/do not match/i);
    expect(send).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText('Repeat the new PIN'));
    await user.type(screen.getByLabelText('Repeat the new PIN'), '731846');
    await user.click(screen.getByRole('button', { name: 'Save new PIN' }));
    expect(await screen.findByText(/new pin is saved/i)).toBeTruthy();
    expect(send).toHaveBeenCalledWith(
      'POST',
      '/v1/adult/pin/reset',
      { pin: '731846' },
      expect.anything(),
    );
  });

  it('an expired re-authentication sends the parent back to the password step', async () => {
    const account = fakeAccount();
    const send = vi.fn(() =>
      Promise.reject(new ApiRequestError('BUSINESS_RULE', 'Sign in again', 422)),
    );
    renderPage(<PinResetPage />, {
      auth: authWith(account, true),
      api: { send },
      path: '/app/security/reset-pin',
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Account password'), 'pw');
    await user.click(screen.getByRole('button', { name: /confirm it’s you/i }));
    await user.type(await screen.findByLabelText('New 6-digit PIN'), '731846');
    await user.type(screen.getByLabelText('Repeat the new PIN'), '731846');
    await user.click(screen.getByRole('button', { name: 'Save new PIN' }));
    expect(await screen.findByLabelText('Account password')).toBeTruthy();
  });
});

describe('Supabase adapter (stubbed client, no network)', () => {
  function stubClient(auth: Record<string, unknown>) {
    return () => ({ auth }) as never;
  }
  const config = {
    apiBaseUrl: '/api',
    supabaseUrl: 'https://example.supabase.co',
    supabasePublishableKey: 'sb_publishable_test',
  };

  it('sign-up answers the same whether or not the email is already registered', async () => {
    const adapter = createSupabaseAuth(
      config,
      stubClient({
        signUp: () => Promise.resolve({ data: {}, error: { message: 'User already registered' } }),
      }),
    );
    expect(await adapter.account!.signUp('a@example.test', 'x'.repeat(12), '/app')).toEqual({
      ok: true,
      next: 'check_email',
    });
  });

  it('a failed password sign-in gives one generic message', async () => {
    const adapter = createSupabaseAuth(
      config,
      stubClient({
        signInWithPassword: () =>
          Promise.resolve({ data: {}, error: { message: 'Invalid login credentials' } }),
      }),
    );
    const outcome = await adapter.account!.signInWithPassword('a@example.test', 'nope');
    expect(outcome).toEqual({ ok: false, message: expect.stringMatching(/did not match/) });
  });

  it('exposes only the access token and email of the current session', async () => {
    const adapter = createSupabaseAuth(
      config,
      stubClient({
        getSession: () =>
          Promise.resolve({
            data: {
              session: {
                access_token: 'jwt',
                refresh_token: 'secret-refresh',
                user: { email: 'riley.parent@example.test' },
              },
            },
          }),
      }),
    );
    expect(await adapter.currentSession()).toEqual({
      accessToken: 'jwt',
      email: 'riley.parent@example.test',
    });
  });
});
