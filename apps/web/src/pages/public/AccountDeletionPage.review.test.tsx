import { cleanup, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  it('[RV-public-site-2] does not advise requesting an export before deleting while export files are never produced', async () => {
    // Implemented design: POST /v1/exports only queues an `export_build` job; no handler for that
    // job kind exists (apps/api/src/jobs/dispatcher.ts DEFAULT_HANDLERS has only deletion_purge),
    // the in-app page says "there is nothing to download until the export service is switched
    // on", and app.purge_family_data deletes public.data_exports. A parent who follows the
    // public advice gets no copy and then loses the data.
    const { container } = await renderPublic(AccountDeletionPage, '/account-deletion');
    const text = container.textContent;
    if (/export/i.test(text)) {
      expect(text).toMatch(
        /export (files )?(are|is)n.t (available|ready|prepared)|export(s)? (are|is) not (yet )?available|nothing to download/i,
      );
    }
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
