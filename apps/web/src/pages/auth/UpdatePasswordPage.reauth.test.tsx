import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { ApiClient } from '@pencillift/contracts/client';
import type { AccountAuth, AuthAdapter, AuthOutcome, ParentSession } from '../../lib/auth.ts';
import { SessionProvider } from '../../lib/session.tsx';
import {
  createSupabaseAuth,
  type PasswordProofAuth,
  type RecoveryLinkOutcome,
  type RecoveryLinkTokens,
} from '../../lib/supabase-auth.ts';
import UpdatePasswordPage from './UpdatePasswordPage.tsx';

/**
 * WEB-R2-04: /update-password changed the account password from any signed-in session with no
 * current password and no re-authentication, so an unattended signed-in browser was enough to take
 * over a parent account (and, after a PIN reset, to request exports and deletions). The weaker
 * secret was better protected: the 6-digit PIN needs the account password re-proved.
 *
 * The direct form is now only for a recovery session (the emailed link). Any other signed-in adult
 * must prove the current password first, and that proof must not replace this browser's session —
 * replacing it would drop an owner's MFA (aal2) session (WEB-R2-08).
 *
 * Synthetic emails, passwords and tokens only; every auth client here is a labeled fake (no network).
 */

afterEach(cleanup);

const SESSION: ParentSession = { accessToken: 'synthetic-token', email: 'pat.parent@example.test' };

const api: ApiClient = {
  get: () => Promise.reject(new Error('unexpected GET')),
  send: () => Promise.reject(new Error('unexpected send')),
};

/**
 * Labeled fake account. The spies are returned beside it so assertions never read a method off the
 * object (which would bind `this` unintentionally).
 */
function fakeAccount(options: { proof?: AuthOutcome; recoveryActive?: boolean } = {}): {
  account: AccountAuth & PasswordProofAuth;
  updatePassword: ReturnType<typeof vi.fn>;
  verifyPassword: ReturnType<typeof vi.fn>;
  signInWithPassword: ReturnType<typeof vi.fn>;
} {
  const updatePassword = vi.fn(() => Promise.resolve<AuthOutcome>({ ok: true, next: 'done' }));
  const verifyPassword = vi.fn(() =>
    Promise.resolve<AuthOutcome>(options.proof ?? { ok: true, next: 'signed_in' }),
  );
  const signInWithPassword = vi.fn(() =>
    Promise.resolve<AuthOutcome>({ ok: true, next: 'signed_in' }),
  );
  const account: AccountAuth & PasswordProofAuth & { recoveryActive?: () => boolean } = {
    signInWithPassword,
    signUp: () => Promise.resolve({ ok: true, next: 'check_email' }),
    sendMagicLink: () => Promise.resolve({ ok: true, next: 'check_email' }),
    sendPasswordReset: () => Promise.resolve({ ok: true, next: 'check_email' }),
    updatePassword,
    assuranceLevel: () => Promise.resolve('aal1'),
    enrollTotp: () => Promise.resolve({ error: 'not used here' }),
    verifyTotp: () => Promise.resolve({ ok: true, next: 'done' }),
    verifiedTotpFactorId: () => Promise.resolve(null),
    verifyPassword,
    ...(options.recoveryActive ? { recoveryActive: () => true } : {}),
  };
  return { account, updatePassword, verifyPassword, signInWithPassword };
}

function renderPage(account: AccountAuth, session: ParentSession | null = SESSION) {
  const auth: AuthAdapter = {
    configured: true,
    account,
    currentSession: () => Promise.resolve(session),
    signOut: () => Promise.resolve(),
  };
  const router = createMemoryRouter(
    [{ path: '/update-password', element: <UpdatePasswordPage /> }],
    {
      initialEntries: ['/update-password'],
    },
  );
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
  return router;
}

describe('WEB-R2-04 /update-password outside a recovery link', () => {
  it('asks for the current password and does not change anything without it', async () => {
    const { account, updatePassword } = fakeAccount();
    renderPage(account);
    expect(await screen.findByLabelText('Current password')).toBeTruthy();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('New password'), 'a-long-synthetic-pass');
    await user.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(updatePassword).not.toHaveBeenCalled();
  });

  it('proves the current password without replacing this browser’s session, then changes it', async () => {
    const { account, updatePassword, verifyPassword, signInWithPassword } = fakeAccount();
    renderPage(account);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Current password'), 'synthetic-current-pass');
    await user.type(screen.getByLabelText('New password'), 'a-long-synthetic-pass');
    await user.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await screen.findByText(/Your password is changed/)).toBeTruthy();
    expect(verifyPassword).toHaveBeenCalledWith(
      'pat.parent@example.test',
      'synthetic-current-pass',
    );
    // The session-replacing password grant is never used here: it would drop an owner's aal2.
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(updatePassword).toHaveBeenCalledWith('a-long-synthetic-pass');
  });

  it('keeps the password unchanged when the current password is wrong', async () => {
    const { account, updatePassword } = fakeAccount({
      proof: { ok: false, message: 'That password did not match.' },
    });
    renderPage(account);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Current password'), 'wrong-synthetic-pass');
    await user.type(screen.getByLabelText('New password'), 'a-long-synthetic-pass');
    await user.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(updatePassword).not.toHaveBeenCalled();
  });

  it('asks only for the new password in a recovery session from the emailed link', async () => {
    const { account, updatePassword } = fakeAccount({ recoveryActive: true });
    renderPage(account);
    expect(await screen.findByLabelText('New password')).toBeTruthy();
    expect(screen.queryByLabelText('Current password')).toBeNull();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('New password'), 'a-long-synthetic-pass');
    await user.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await screen.findByText(/Your password is changed/)).toBeTruthy();
    expect(updatePassword).toHaveBeenCalledWith('a-long-synthetic-pass');
  });
});

describe('WEB-R2-04 Supabase adapter verifyPassword (labeled fake client, no network)', () => {
  const config = {
    apiBaseUrl: '/api',
    supabaseUrl: 'https://example.supabase.co',
    supabasePublishableKey: 'sb_publishable_test',
  };

  it('proves the password on a second, non-persisting client and signs that one out', async () => {
    const created: { persistSession: unknown; storageKey?: unknown }[] = [];
    const proofSignOut = vi.fn(() => Promise.resolve({ error: null }));
    const proofSignIn = vi.fn(() => Promise.resolve({ error: null }));
    const mainSignIn = vi.fn(() => Promise.resolve({ error: null }));
    let call = 0;
    const factory = (_url: string, _key: string, options?: { auth?: Record<string, unknown> }) => {
      created.push((options?.auth ?? {}) as { persistSession: unknown });
      call += 1;
      return (
        call === 1
          ? {
              auth: {
                signInWithPassword: mainSignIn,
                onAuthStateChange: () => ({
                  data: { subscription: { unsubscribe: () => undefined } },
                }),
              },
            }
          : { auth: { signInWithPassword: proofSignIn, signOut: proofSignOut } }
      ) as never;
    };
    const adapter = createSupabaseAuth(config, factory);
    const account = adapter.account as AccountAuth & PasswordProofAuth;
    expect(
      await account.verifyPassword('pat.parent@example.test', 'synthetic-current-pass'),
    ).toEqual({ ok: true, next: 'signed_in' });
    expect(proofSignIn).toHaveBeenCalledWith({
      email: 'pat.parent@example.test',
      password: 'synthetic-current-pass',
    });
    // The portal's own client never re-signs in, so its session (and an owner's aal2) survives.
    expect(mainSignIn).not.toHaveBeenCalled();
    expect(created[1]?.persistSession).toBe(false);
    expect(proofSignOut).toHaveBeenCalledWith({ scope: 'local' });
  });
});

/**
 * WEB-R2-04, second round: the acceptance checker found the grant was opened once and never closed.
 * The adapter is created at module scope, so a parent who legitimately followed one emailed link
 * kept a session that could set a new password with nothing else for as long as that page stayed
 * open — including after the change had been made, and after they signed out in another tab.
 * The grant is now single-use and time-bounded, and a sign-out ends it.
 */
describe('WEB-R2-04 the recovery grant is single-use and time-bounded', () => {
  const config = {
    apiBaseUrl: '/api',
    supabaseUrl: 'https://example.supabase.co',
    supabasePublishableKey: 'sb_publishable_test',
  };

  /** A labeled fake portal client whose auth events and clock the test drives. */
  function adapterWithClock(startMs: number) {
    let nowMs = startMs;
    let emit: (event: string) => void = () => undefined;
    const updateUser = vi.fn(() => Promise.resolve({ error: null }));
    const signOut = vi.fn(() => Promise.resolve({ error: null }));
    const factory = () =>
      ({
        auth: {
          updateUser,
          signOut,
          onAuthStateChange: (handler: (event: string) => void) => {
            emit = handler;
            return { data: { subscription: { unsubscribe: () => undefined } } };
          },
        },
      }) as never;
    const adapter = createSupabaseAuth(config, factory, () => nowMs);
    const account = adapter.account as AccountAuth & { recoveryActive(): boolean };
    return {
      adapter,
      account,
      updateUser,
      signOut,
      recover: () => emit('PASSWORD_RECOVERY'),
      signedIn: () => emit('SIGNED_IN'),
      signedOutEvent: () => emit('SIGNED_OUT'),
      advance: (ms: number) => {
        nowMs += ms;
      },
    };
  }

  it('opens on the recovery event and closes as soon as the password is changed', async () => {
    const h = adapterWithClock(1_780_000_000_000);
    expect(h.account.recoveryActive()).toBe(false);
    h.recover();
    expect(h.account.recoveryActive()).toBe(true);
    expect(await h.account.updatePassword('a-long-synthetic-pass')).toEqual({
      ok: true,
      next: 'done',
    });
    // The grant was for one change. A second change on the same page proves the old password.
    expect(h.account.recoveryActive()).toBe(false);
  });

  it('lapses fifteen minutes after the link was followed', () => {
    const h = adapterWithClock(1_780_000_000_000);
    h.recover();
    h.advance(14 * 60_000);
    expect(h.account.recoveryActive()).toBe(true);
    h.advance(61_000);
    expect(h.account.recoveryActive()).toBe(false);
  });

  it('a failed password change keeps the grant open so the parent can try again', async () => {
    const h = adapterWithClock(1_780_000_000_000);
    h.recover();
    (
      h.updateUser as unknown as { mockImplementation: (f: () => unknown) => void }
    ).mockImplementation(() => Promise.resolve({ error: { message: 'network' } }));
    expect((await h.account.updatePassword('a-long-synthetic-pass')).ok).toBe(false);
    expect(h.account.recoveryActive()).toBe(true);
  });

  it('signing out ends the grant, by either the adapter or the auth server event', async () => {
    const byAdapter = adapterWithClock(1_780_000_000_000);
    byAdapter.recover();
    await byAdapter.adapter.signOut();
    expect(byAdapter.account.recoveryActive()).toBe(false);

    const byEvent = adapterWithClock(1_780_000_000_000);
    byEvent.recover();
    byEvent.signedOutEvent();
    expect(byEvent.account.recoveryActive()).toBe(false);
  });

  it('an ordinary sign-in never opens it, and never closes a live one', () => {
    const h = adapterWithClock(1_780_000_000_000);
    h.signedIn();
    expect(h.account.recoveryActive()).toBe(false);
    h.recover();
    // The SDK emits SIGNED_IN alongside a recovery link in some flows: it must not revoke the grant.
    h.signedIn();
    expect(h.account.recoveryActive()).toBe(true);
  });

  it('an accepted mobile recovery link opens the same bounded, single-use grant', async () => {
    let nowMs = 1_780_000_000_000;
    const user = { email: 'pat.parent@example.test' };
    const factory = () =>
      ({
        auth: {
          setSession: () =>
            Promise.resolve({
              data: { user, session: { access_token: 'synthetic-access', user } },
              error: null,
            }),
          updateUser: () => Promise.resolve({ error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
        },
      }) as never;
    const account = createSupabaseAuth(config, factory, () => nowMs).account as AccountAuth & {
      recoveryActive(): boolean;
      acceptRecoveryLink(t: { accessToken: string; refreshToken: string }): Promise<unknown>;
    };
    await account.acceptRecoveryLink({
      accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh',
    });
    expect(account.recoveryActive()).toBe(true);
    nowMs += 16 * 60_000;
    expect(account.recoveryActive()).toBe(false);
  });
});

/**
 * WEB-R4-AUTH-1: the bound above was only ever checked on the adapter. The page treated its own
 * `recovery` state — written once when the mobile (implicit-flow) link was adopted and never reset —
 * as a second, unbounded grant, so an /update-password tab left open on a shared family, school or
 * library computer still set a new account password with no current password hours later. The page
 * now reads the grant from the adapter alone, which is what RECOVERY_GRANT_MS, the single use and a
 * sign-out all act on.
 *
 * All emails, tokens and passwords below are synthetic; the account is a labeled fake (no network).
 */
describe('WEB-R4-AUTH-1 an abandoned mobile-link tab is not a standing grant', () => {
  const RECOVERY_HASH =
    '#access_token=synthetic-access&refresh_token=synthetic-refresh&type=recovery';

  /** Labeled fake account whose grant the test opens (via the link) and lets lapse. */
  function linkAccount() {
    let grantOpen = false;
    const base = fakeAccount();
    const account: AccountAuth &
      PasswordProofAuth & {
        recoveryActive(): boolean;
        acceptRecoveryLink(t: RecoveryLinkTokens): Promise<RecoveryLinkOutcome>;
      } = {
      ...base.account,
      recoveryActive: () => grantOpen,
      // Mirrors the adapter: accepting the link is what opens the bounded grant (supabase-auth.ts).
      acceptRecoveryLink: () => {
        grantOpen = true;
        return Promise.resolve({ ok: true, email: 'pat.parent@example.test' });
      },
    };
    return {
      account,
      updatePassword: base.updatePassword,
      verifyPassword: base.verifyPassword,
      lapse: () => {
        grantOpen = false;
      },
    };
  }

  function renderLink(account: AccountAuth) {
    const auth: AuthAdapter = {
      configured: true,
      account,
      currentSession: () => Promise.resolve(SESSION),
      signOut: () => Promise.resolve(),
    };
    const router = createMemoryRouter(
      [{ path: '/update-password', element: <UpdatePasswordPage /> }],
      { initialEntries: [`/update-password${RECOVERY_HASH}`] },
    );
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
    return router;
  }

  it('asks for the current password once the fifteen minutes have passed', async () => {
    const { account, updatePassword, verifyPassword, lapse } = linkAccount();
    renderLink(account);
    expect(await screen.findByLabelText('New password')).toBeTruthy();
    expect(screen.queryByLabelText('Current password')).toBeNull();
    // Sixteen minutes pass with the tab still open: the adapter's grant has lapsed.
    lapse();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('New password'), 'attacker-chosen-pass');
    expect(await screen.findByLabelText('Current password')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(updatePassword).not.toHaveBeenCalled();
  });

  /**
   * HUNT5-E-4: the test above only escapes the render-time capture because it types the new password
   * AFTER the grant lapses, and typing is what re-renders this page and brings the "Current password"
   * field back. Swap the two steps and the decision is the one taken at the last render, which fell
   * inside the window: `mustProve` is captured by the submit closure and AccountForm keeps its own
   * busy/error state (forms.tsx), so nothing re-renders the page between the typing and the click.
   * The deadline has to be enforced at the moment the account is changed, which is what BUG-242 and
   * L-040 are about.
   */
  it('refuses a form filled inside the grant but submitted after it lapsed', async () => {
    const { account, updatePassword, verifyPassword, lapse } = linkAccount();
    renderLink(account);
    const user = userEvent.setup();
    // Typed while the grant was open, so this page's last render fell inside the window.
    await user.type(await screen.findByLabelText('New password'), 'a-long-synthetic-pass');
    expect(screen.queryByLabelText('Current password')).toBeNull();
    // Sixteen minutes pass with the form filled in and the tab abandoned, then it is submitted.
    lapse();
    await user.click(screen.getByRole('button', { name: 'Save password' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/current password/i);
    expect(updatePassword).not.toHaveBeenCalled();
    expect(verifyPassword).not.toHaveBeenCalled();
    // And the field the parent now needs is on screen, not only demanded.
    expect(await screen.findByLabelText('Current password')).toBeTruthy();
  });

  it('still lets the parent set the password inside the grant', async () => {
    const { account, updatePassword } = linkAccount();
    renderLink(account);
    expect(await screen.findByText('Set a new password for p•••@example.test')).toBeTruthy();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('New password'), 'a-long-synthetic-pass');
    await user.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await screen.findByText(/Your password is changed/)).toBeTruthy();
    expect(updatePassword).toHaveBeenCalledWith('a-long-synthetic-pass');
  });
});
