import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftBanner, isLegalReviewed } from '../../components/DraftBanner.tsx';
import { renderPage } from '../../test/render.tsx';
import AccountDeletionPage from './AccountDeletionPage.tsx';
import ContactPage from './ContactPage.tsx';
import HowItWorksPage from './HowItWorksPage.tsx';
import LandingPage from './LandingPage.tsx';
import NotFoundPage from './NotFoundPage.tsx';
import PricingPage from './PricingPage.tsx';
import PrivacyPage from './PrivacyPage.tsx';
import SupportPage from './SupportPage.tsx';
import TermsPage from './TermsPage.tsx';

/** Pages that are drafts pending owner and legal review (spec P15 support/privacy/deletion URLs). */
const draftPages: [name: string, Page: ComponentType, path: string][] = [
  ['PrivacyPage', PrivacyPage, '/privacy'],
  ['TermsPage', TermsPage, '/terms'],
  ['SupportPage', SupportPage, '/support'],
  ['ContactPage', ContactPage, '/contact'],
  ['AccountDeletionPage', AccountDeletionPage, '/account-deletion'],
];

const nonDraftPages: [name: string, Page: ComponentType][] = [
  ['LandingPage', LandingPage],
  ['HowItWorksPage', HowItWorksPage],
  ['PricingPage', PricingPage],
  ['NotFoundPage', NotFoundPage],
];

async function renderPublic(Page: ComponentType, path = '/') {
  const view = renderPage(<Page />, { path });
  await screen.findByRole('heading', { level: 1 });
  return view;
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('isLegalReviewed', () => {
  it('is true only for the exact string "true"', () => {
    expect(isLegalReviewed({ VITE_LEGAL_REVIEWED: 'true' })).toBe(true);
    expect(isLegalReviewed({ VITE_LEGAL_REVIEWED: 'TRUE' })).toBe(false);
    expect(isLegalReviewed({ VITE_LEGAL_REVIEWED: '1' })).toBe(false);
    expect(isLegalReviewed({ VITE_LEGAL_REVIEWED: 'false' })).toBe(false);
    expect(isLegalReviewed({})).toBe(false);
  });
});

describe('DraftBanner', () => {
  it('announces the draft status as a labelled note', () => {
    vi.stubEnv('VITE_LEGAL_REVIEWED', 'false');
    render(<DraftBanner />);
    const note = screen.getByRole('note', { name: /draft/i });
    expect(note.textContent).toMatch(/owner and legal review/i);
  });

  it('renders nothing once legal review is recorded', () => {
    vi.stubEnv('VITE_LEGAL_REVIEWED', 'true');
    const { container } = render(<DraftBanner />);
    expect(container.innerHTML).toBe('');
  });
});

describe.each(draftPages)('%s draft status', (_name, Page, path) => {
  it('shows the DraftBanner at the top, before the h1, while legal review is pending', async () => {
    vi.stubEnv('VITE_LEGAL_REVIEWED', 'false');
    await renderPublic(Page, path);
    const note = screen.getByRole('note', { name: /draft/i });
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(note.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('hides the DraftBanner when VITE_LEGAL_REVIEWED is "true"', async () => {
    vi.stubEnv('VITE_LEGAL_REVIEWED', 'true');
    await renderPublic(Page, path);
    expect(screen.queryByRole('note', { name: /draft/i })).toBeNull();
  });
});

describe.each(nonDraftPages)('%s', (_name, Page) => {
  it('is not marked as a legal draft', async () => {
    vi.stubEnv('VITE_LEGAL_REVIEWED', 'false');
    await renderPublic(Page);
    expect(screen.queryByRole('note', { name: /draft/i })).toBeNull();
  });
});

describe('PrivacyPage draft content (spec P3, P4, P16.1)', () => {
  it('accurately describes the implemented privacy design', async () => {
    vi.stubEnv('VITE_LEGAL_REVIEWED', 'false');
    const { container } = await renderPublic(PrivacyPage, '/privacy');
    const text = container.textContent;
    expect(text).toMatch(/verifiable parental consent before/i);
    expect(text).toMatch(/children don.t need an email address/i);
    expect(text).toMatch(/private storage/i);
    expect(text).toMatch(/raw homework photos are deleted after 30 days by default/i);
    expect(text).toMatch(/processing stops immediately/i);
    expect(text).toMatch(/within 30 days/i);
    expect(text).toMatch(/backups expire on a documented schedule/i);
    expect(text).toMatch(/zero data retention/i);
    expect(text).toMatch(/no behavioral advertising/i);
    expect(text).toMatch(/do not sell/i);
    expect(text).toMatch(/no ads or affiliate links in children.s areas/i);
    expect(text).toMatch(/sponsor cards/i);
    expect(text).toMatch(/only (to|for) parents/i);
    expect(text).toMatch(/Amazon links only where (PencilLift is )?eligible/i);
    expect(text).toMatch(/support@pencillift\.com \(to be confirmed\)/);
    expect(
      screen.getByRole('link', { name: /how to delete your account/i }).getAttribute('href'),
    ).toBe('/account-deletion');
  });
});

describe('PrivacyPage states the limits of the implemented design (RV-public-site-1, -2, -3)', () => {
  it('describes photo metadata removal as implemented, exports as unavailable, and owner-only family deletion', async () => {
    vi.stubEnv('VITE_LEGAL_REVIEWED', 'false');
    const { container } = await renderPublic(PrivacyPage, '/privacy');
    const text = container.textContent;
    // The device re-encode can fail and upload the original (apps/mobile scan.tsx); only the
    // server scan job's stripImageMetadata is guaranteed, so the copy names both steps.
    expect(text).toMatch(
      /our servers remove those details before the photo is processed or sent to AI/i,
    );
    expect(text).not.toMatch(/does not collect precise location/i);
    // No deployed job builds export files yet (dispatcher DEFAULT_HANDLERS).
    expect(text).toMatch(/export files aren.t available yet/i);
    // POST /v1/deletion scope "family" is owner-only (privacy.ts ownerOnlyFamilyDeletion).
    expect(text).toMatch(/only the family owner can delete the whole family account/i);
  });
});

describe('TermsPage deletion rights match the API', () => {
  it('says the family owner deletes the family account and any guardian can delete a child’s data', async () => {
    vi.stubEnv('VITE_LEGAL_REVIEWED', 'false');
    const { container } = await renderPublic(TermsPage, '/terms');
    expect(container.textContent).toMatch(/family owner can delete the family account/i);
    expect(container.textContent).toMatch(
      /any parent or guardian in the family can delete a child.s data/i,
    );
  });
});

describe('AccountDeletionPage (spec P4, P11, P15)', () => {
  it('explains both ways to delete, what happens, and that store subscriptions must be cancelled in the store', async () => {
    vi.stubEnv('VITE_LEGAL_REVIEWED', 'false');
    const { container } = await renderPublic(AccountDeletionPage, '/account-deletion');
    const text = container.textContent;
    expect(
      screen
        .getByRole('link', { name: /privacy controls in the parent area/i })
        .getAttribute('href'),
    ).toBe('/app/privacy');
    expect(text).toMatch(/PIN/);
    expect(text).toMatch(/support@pencillift\.com \(to be confirmed\)/);
    expect(text).toMatch(/stops immediately/i);
    expect(text).toMatch(/within 30 days/i);
    expect(text).toMatch(/backups expire on a documented schedule/i);

    const store = screen.getByRole('region', { name: /subscription/i });
    expect(store.textContent).toMatch(
      /deleting your PencilLift account does not cancel an App Store or Google Play subscription/i,
    );
    expect(store.textContent).toMatch(/cancel it in the App Store or Google Play/i);
  });
});

describe.each([
  ['SupportPage', SupportPage, '/support'],
  ['ContactPage', ContactPage, '/contact'],
] as const)('%s contact details', (_name, Page, path) => {
  it('shows the placeholder support address marked "to be confirmed" and asks for no child details', async () => {
    vi.stubEnv('VITE_LEGAL_REVIEWED', 'false');
    const { container } = await renderPublic(Page, path);
    const text = container.textContent;
    expect(text).toMatch(/support@pencillift\.com \(to be confirmed\)/);
    expect(text).toMatch(/don.t include homework photos/i);
  });
});

describe('TermsPage (spec P9, P11)', () => {
  it('states store billing, store cancellation and that points are not money', async () => {
    vi.stubEnv('VITE_LEGAL_REVIEWED', 'false');
    const { container } = await renderPublic(TermsPage, '/terms');
    const text = container.textContent;
    expect(text).toMatch(/App Store or Google Play/);
    expect(text).toMatch(/does not cancel/i);
    expect(text).toMatch(/points (are not|aren.t) money/i);
    expect(text).toMatch(/can.t promise particular grades/i);
  });
});
