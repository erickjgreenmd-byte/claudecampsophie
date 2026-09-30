import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storeSubscriptionNotice } from '@pencillift/contracts';
import { renderPage } from '../../test/render.tsx';
import AccountDeletionPage from './AccountDeletionPage.tsx';
import PrivacyPage from './PrivacyPage.tsx';

/**
 * Independent review of the public-site vertical (REVIEW-PUBLIC-SITE). The public deletion page is
 * the store-listed deletion URL (spec P15, AC_DEPLOY_04); it must describe the implemented flow
 * exactly, including its limits, and must not promise more than the product does (AC_UX_02).
 */

async function renderPublic(Page: ComponentType, path: string) {
  const view = renderPage(<Page />, { path });
  await screen.findByRole('heading', { level: 1 });
  return view;
}

beforeEach(() => {
  vi.stubEnv('VITE_LEGAL_REVIEWED', 'false');
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('AccountDeletionPage review', () => {
  it('[RV-public-site-2, resolved] tells parents to export before deleting now that the export job builds files', async () => {
    // Implemented design: `export_build` is registered in DEFAULT_HANDLERS (apps/api/src/jobs/
    // dispatcher.ts) and GET /v1/exports/:id/download signs the file, so the page may (and must)
    // point at exports as the way to keep a copy, and may no longer call them unavailable.
    const { container } = await renderPublic(AccountDeletionPage, '/account-deletion');
    const text = container.textContent;
    expect(text).toMatch(/request an export .* before you delete/i);
    expect(text).not.toMatch(/nothing to download|switched on|export files aren.t available/i);
  });

  it('[APL-07 / PLAY-10] describes in-app deletion of the sign-in itself, in both apps and the portal, with email as the fallback', async () => {
    // Apple 5.1.1(v) and Google Play require an in-app path that deletes the account, not only
    // the family's data, and the store-listed page must describe it; email stays for people who
    // can no longer sign in.
    const { container } = await renderPublic(AccountDeletionPage, '/account-deletion');
    const inApp = screen.getByRole('region', { name: /in the app or the parent portal/i });
    expect(inApp.textContent).toMatch(/iPhone, iPad, Android/i);
    expect(inApp.textContent).toMatch(/Fire tablet/i);
    expect(inApp.textContent).toMatch(/Delete my account/);
    expect(inApp.textContent).toMatch(/closes your email and password sign-in/i);
    expect(inApp.textContent).toMatch(/family owner deletes the family account first/i);
    expect(inApp.textContent).toMatch(/guardian is removed from the family and closed at once/i);
    const email = screen.getByRole('region', { name: /email us/i });
    expect(email.textContent).toMatch(/if you can.t sign in/i);
    expect(email.textContent).toMatch(/your own sign-in/i);
    // The old wording that sent every sign-in closure to support is gone.
    expect(container.textContent).not.toMatch(/to have the sign-in closed as well, email us/i);
    const keep = screen.getByRole('region', { name: /what happens after you ask/i });
    expect(keep.textContent).toMatch(/pseudonymous account id/i);
    expect(keep.textContent).toMatch(/email address, phone number and password are removed/i);
  });

  it('shows what happened after an in-app closure (router state only, never a URL parameter)', async () => {
    const renderWithState = (state: unknown) => {
      const router = createMemoryRouter(
        [{ path: '/account-deletion', element: <AccountDeletionPage /> }],
        { initialEntries: [{ pathname: '/account-deletion', state }] },
      );
      return render(<RouterProvider router={router} />);
    };
    renderWithState({ accountClosed: 'pending' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByRole('status').textContent).toMatch(
      /closes automatically once your family account/i,
    );
    cleanup();
    renderWithState({ accountClosed: 'closed' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByRole('status').textContent).toMatch(
      /account is closed and this device is signed out/i,
    );
    cleanup();
    renderWithState({ accountClosed: 'anything-else' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('status')).toBeNull();
  });

  /**
   * Re-aimed for BUG-411. This asserted this page's OWN wording of the store notice, which is how a
   * fourth wording of it survived beside the shared one. The requirement it carries — Fire tablets
   * buy through the Amazon Appstore, deleting cancels nothing there either, and the page must say
   * where to cancel without claiming which store the reader uses — is now asserted against the
   * contracts' sentence, and the page is asserted to print exactly that sentence.
   */
  it('names the Amazon Appstore subscription on Fire tablets next to the App Store and Google Play', async () => {
    await renderPublic(AccountDeletionPage, '/account-deletion');
    const store = screen.getByRole('region', { name: /subscription/i });
    // The page covers all three deletions, so it is the `any` sentence, printed whole.
    expect(store.textContent).toContain(storeSubscriptionNotice('any', null));
    expect(store.textContent).toMatch(
      /does not cancel an App Store, Google Play or Amazon Appstore subscription/i,
    );
    expect(store.textContent).toMatch(/Amazon Appstore/);
    // A public page knows no store, so it may not name one as the reader's.
    expect(store.textContent).not.toMatch(
      /your (App Store|Google Play|Amazon Appstore) subscription/,
    );
  });

  it('[RV-public-site-3] says that only the family owner can delete the whole family account', async () => {
    // Implemented design: POST /v1/deletion with scope "family" returns FORBIDDEN
    // (ownerOnlyFamilyDeletion) for an invited guardian (apps/api/src/routes/privacy.ts). The
    // public steps tell any signed-in parent they can choose the whole family account.
    const { container } = await renderPublic(AccountDeletionPage, '/account-deletion');
    expect(container.textContent).toMatch(/only the (family|account) owner/i);
  });
});

describe.each([
  ['AccountDeletionPage', AccountDeletionPage, '/account-deletion'],
  ['PrivacyPage', PrivacyPage, '/privacy'],
] as const)('%s retention disclosure review', (_name, Page, path) => {
  it('[RV-public-site-4] discloses that consent records and the security log are kept after deletion', async () => {
    // Implemented design (supabase/migrations/0620_deletion_purge.sql header): consent records and
    // audit events are retained after a purge, and the in-app privacy controls say so ("consent
    // records and a security log that uses pseudonymous ids only"). The public pages list only
    // "limited billing records" as the exception.
    await renderPublic(Page, path);
    const section = screen.getByRole('region', {
      name: /deleting information|what happens after you ask/i,
    });
    const text = section.textContent;
    expect(text).toMatch(/limited billing records/i); // sanity: this is the retention list
    expect(text).toMatch(/consent records/i);
    expect(text).toMatch(/(security|audit) log/i);
  });
});
