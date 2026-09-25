import { cleanup, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from '../../test/render.tsx';
import AccountDeletionPage from './AccountDeletionPage.tsx';
import ContactPage from './ContactPage.tsx';
import PrivacyPage from './PrivacyPage.tsx';
import SupportPage from './SupportPage.tsx';
import TermsPage from './TermsPage.tsx';

/**
 * Store-review hardening of the public legal pages (WEB-06 / APL-20, AMZ-17, APL-28 / PLAY-25).
 *
 * In a reviewed build (`VITE_LEGAL_REVIEWED=true` with `VITE_LEGAL_EFFECTIVE_DATE` and
 * `VITE_SUPPORT_EMAIL`) no draft wording, placeholder mailbox or missing effective date may remain
 * on any public legal page. In a draft build every legal page carries the DraftBanner.
 */

/** Every public legal page: fully asserted in reviewed mode. */
const reviewedPages: [name: string, Page: ComponentType, path: string][] = [
  ['PrivacyPage', PrivacyPage, '/privacy'],
  ['TermsPage', TermsPage, '/terms'],
  ['SupportPage', SupportPage, '/support'],
  ['ContactPage', ContactPage, '/contact'],
  ['AccountDeletionPage', AccountDeletionPage, '/account-deletion'],
];

const allLegalPages = reviewedPages;

/** Pages that name a payment channel (AMZ-17); ContactPage names none. */
const paymentPages: [name: string, Page: ComponentType, path: string][] = [
  ['PrivacyPage', PrivacyPage, '/privacy'],
  ['TermsPage', TermsPage, '/terms'],
  ['SupportPage', SupportPage, '/support'],
  ['AccountDeletionPage', AccountDeletionPage, '/account-deletion'],
];

const REVIEWED_MAILBOX = 'support@example.test';
const REVIEWED_DATE = '2026-10-01';
/** The placeholder shown while the owner has not confirmed a mailbox (common.tsx). */
const PLACEHOLDER_MAILBOX = 'support@pencillift.com';

/** Wording that marks a page as unfinished; none of it may survive legal review. */
const draftWording: RegExp[] = [
  /\bdrafts?\b/i,
  /to be confirmed/i,
  /will be confirmed/i,
  /not yet in effect/i,
  /pending (owner|legal|review)/i,
  /placeholder/i,
  /\bTBD\b/,
  /still being written/i,
  /after legal review/i,
  /lorem ipsum/i,
  /\[[^\]]*(insert|name|date|address)[^\]]*\]/i,
];

function stubReviewed() {
  vi.stubEnv('VITE_LEGAL_REVIEWED', 'true');
  vi.stubEnv('VITE_LEGAL_EFFECTIVE_DATE', REVIEWED_DATE);
  vi.stubEnv('VITE_SUPPORT_EMAIL', REVIEWED_MAILBOX);
}

function stubDraft() {
  vi.stubEnv('VITE_LEGAL_REVIEWED', 'false');
  vi.stubEnv('VITE_LEGAL_EFFECTIVE_DATE', '');
  vi.stubEnv('VITE_SUPPORT_EMAIL', '');
}

async function renderPublic(Page: ComponentType, path: string) {
  const view = renderPage(<Page />, { path });
  await screen.findByRole('heading', { level: 1 });
  return view;
}

/** Reviewed mode: no draft wording, no placeholder mailbox, no DraftBanner anywhere on the page. */
async function expectNoDraftWording(Page: ComponentType, path: string) {
  const { container } = await renderPublic(Page, path);
  const text = container.textContent;
  for (const pattern of draftWording) {
    expect(text, `matched ${String(pattern)}`).not.toMatch(pattern);
  }
  expect(text).not.toContain(PLACEHOLDER_MAILBOX);
  expect(screen.queryByRole('note', { name: /draft/i })).toBeNull();
}

/** Reviewed mode: every mention of the mailbox is a mailto link to the configured address. */
async function expectMailtoSupportLink(Page: ComponentType, path: string) {
  await renderPublic(Page, path);
  const links = screen.getAllByRole('link', { name: REVIEWED_MAILBOX });
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    expect(link.getAttribute('href')).toBe(`mailto:${REVIEWED_MAILBOX}`);
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('reviewed build (VITE_LEGAL_REVIEWED=true)', () => {
  beforeEach(stubReviewed);

  describe.each(reviewedPages)('%s', (_name, Page, path) => {
    it('contains no draft wording, no placeholder mailbox and no draft banner', async () => {
      await expectNoDraftWording(Page, path);
    });

    it('shows the configured support mailbox as a mailto link', async () => {
      await expectMailtoSupportLink(Page, path);
    });
  });

  it.each([
    ['PrivacyPage', PrivacyPage, '/privacy'],
    ['TermsPage', TermsPage, '/terms'],
  ] as const)('%s states the effective date from the build', async (_name, Page, path) => {
    const { container } = await renderPublic(Page, path);
    expect(container.textContent).toMatch(/Effective date: October 1, 2026/);
    const time = container.querySelector('time');
    expect(time?.getAttribute('dateTime')).toBe(REVIEWED_DATE);
  });

  it('TermsPage no longer promises clauses that were never written', async () => {
    const { container } = await renderPublic(TermsPage, '/terms');
    expect(container.textContent).not.toMatch(/will be added/i);
  });
});

describe('draft build (VITE_LEGAL_REVIEWED unset or not "true")', () => {
  beforeEach(stubDraft);

  describe.each(allLegalPages)('%s', (_name, Page, path) => {
    it('shows the DraftBanner before the h1 and marks the mailbox and date as unconfirmed', async () => {
      const { container } = await renderPublic(Page, path);
      const note = screen.getByRole('note', { name: /draft/i });
      const h1 = screen.getByRole('heading', { level: 1 });
      expect(note.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(container.textContent).toMatch(/support@pencillift\.com \(to be confirmed\)/);
      // Never a mailto link to an unconfirmed inbox.
      expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
    });
  });

  it.each([
    ['PrivacyPage', PrivacyPage, '/privacy'],
    ['TermsPage', TermsPage, '/terms'],
  ] as const)('%s says the effective date is to be confirmed', async (_name, Page, path) => {
    const { container } = await renderPublic(Page, path);
    expect(container.textContent).toMatch(/Effective date to be confirmed/);
  });
});

describe.each([
  ['reviewed', stubReviewed],
  ['draft', stubDraft],
] as const)('payment channels and notices (%s build)', (_mode, stub) => {
  beforeEach(stub);

  it.each(paymentPages)(
    '%s names the Amazon Appstore wherever it names Google Play (AMZ-17)',
    async (_name, Page, path) => {
      const { container } = await renderPublic(Page, path);
      const blocks = [...container.querySelectorAll('p, li')].filter((el) =>
        el.textContent.includes('Google Play'),
      );
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block.textContent).toContain('Amazon Appstore');
      }
    },
  );

  it('PrivacyPage promises email notices, not push notifications (APL-28 / PLAY-25)', async () => {
    const { container } = await renderPublic(PrivacyPage, '/privacy');
    const text = container.textContent;
    expect(text).not.toMatch(/notifications go to parents. devices/i);
    expect(text).not.toMatch(/by push notification/i);
    expect(text).toMatch(/we contact parents by email/i);
    expect(text).toMatch(/does not send push notifications/i);
  });

  it('PrivacyPage states plainly how IP addresses are handled (APL-28 / PLAY-25)', async () => {
    const { container } = await renderPublic(PrivacyPage, '/privacy');
    const text = container.textContent;
    // What the API does: only the pairing-code endpoint reads the client address, and only as a
    // short-lived abuse counter (apps/api/src/routes/child-auth.ts, private.rate_limit_buckets).
    expect(text).toMatch(
      /do not store IP addresses with your account or your child.s information/i,
    );
    expect(text).toMatch(/never written to our own logs/i);
    expect(text).toMatch(/pairing code/i);
    expect(text).toMatch(/deleted within about a day/i);
    expect(text).toMatch(/never linked to a family or a child/i);
  });
});
