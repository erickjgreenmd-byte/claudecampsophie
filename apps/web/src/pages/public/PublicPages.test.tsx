import { cleanup, screen, waitFor } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** Every public screen required by spec P14, with its registered path and expected tab title. */
const pages: [name: string, Page: ComponentType, path: string, title: RegExp][] = [
  ['LandingPage', LandingPage, '/', /PencilLift/],
  ['HowItWorksPage', HowItWorksPage, '/how-it-works', /How PencilLift works/],
  ['PricingPage', PricingPage, '/pricing', /Pricing/],
  ['SupportPage', SupportPage, '/support', /Support/],
  ['PrivacyPage', PrivacyPage, '/privacy', /Privacy/],
  ['TermsPage', TermsPage, '/terms', /Terms/],
  ['AccountDeletionPage', AccountDeletionPage, '/account-deletion', /Delete/],
  ['ContactPage', ContactPage, '/contact', /Contact/],
  ['NotFoundPage', NotFoundPage, '/no-such-page', /not found/i],
];

/**
 * Claims the public site must never make (spec P11, P15, P16.1, owner rules): no guaranteed
 * grades, no "unlimited AI", no unapproved free trial, no "Kids" badge or store-approval claims,
 * no ad-free marketing while commercial recommendations exist, and never "$9.99 for the first child".
 */
const forbiddenClaims: RegExp[] = [
  /unlimited/i,
  /guarantee/i,
  /free trial/i,
  /ad[\s-]?free/i,
  /kids\s+(category|badge)/i,
  /made for kids/i,
  /approved by (apple|google|the app store)/i,
  /(available|download it) (now )?on the app store/i,
  /get it on google play/i,
  /\$9\.99 for the first child/i,
  /first child[^.]{0,20}\$9\.99/i,
];

/** Link text that does not describe its destination (WCAG 2.4.4). */
const vagueLinkText = /^(here|click here|read more|learn more|more|link|this page)$/i;

async function renderPublic(Page: ComponentType, path: string) {
  const view = renderPage(<Page />, { path });
  await screen.findByRole('heading', { level: 1 });
  return view;
}

beforeEach(() => {
  // Render the draft state explicitly so a local .env cannot change what these tests see.
  vi.stubEnv('VITE_LEGAL_REVIEWED', 'false');
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe.each(pages)('%s (spec P14 public screen, AC_UX_01)', (_name, Page, path, title) => {
  it('has exactly one h1, and headings never skip a level', async () => {
    const { container } = await renderPublic(Page, path);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    const levels = [...container.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) =>
      Number(h.tagName.slice(1)),
    );
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i]!).toBeLessThanOrEqual(levels[i - 1]! + 1);
    }
  });

  it('makes none of the forbidden marketing claims', async () => {
    const { container } = await renderPublic(Page, path);
    // innerHTML also covers attribute text such as aria-label and title.
    const html = container.innerHTML;
    const text = container.textContent;
    for (const claim of forbiddenClaims) {
      expect(text, `text matched ${String(claim)}`).not.toMatch(claim);
      expect(html, `markup matched ${String(claim)}`).not.toMatch(claim);
    }
  });

  it('uses descriptive text for every link', async () => {
    const { container } = await renderPublic(Page, path);
    const links = [...container.querySelectorAll('a')];
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const name = (link.getAttribute('aria-label') ?? link.textContent).trim();
      expect(name.length).toBeGreaterThan(3);
      expect(name).not.toMatch(vagueLinkText);
      expect(link.getAttribute('href')).toMatch(/^\//);
    }
  });

  it('has no buttons that do nothing (AC_UX_02)', async () => {
    await renderPublic(Page, path);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('sets a descriptive document title', async () => {
    await renderPublic(Page, path);
    await waitFor(() => expect(document.title).toMatch(title));
    expect(document.title).toMatch(/PencilLift/);
  });
});

describe('LandingPage truthful product copy (spec P1)', () => {
  it('describes guidance without the answer key, parent solutions behind a PIN, and the core features', async () => {
    const { container } = await renderPublic(LandingPage, '/');
    const text = container.textContent;
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Turn homework into progress.',
    );
    expect(text).toMatch(/understand their own homework/i);
    expect(text).toMatch(/answer key/i);
    expect(text).toMatch(/complete (answers|solutions)/i);
    expect(text).toMatch(/PIN/);
    expect(text).toMatch(/daily extra-credit practice/i);
    expect(text).toMatch(/Thursday/);
    expect(text).toMatch(/Friday tests/i);
    expect(text).toMatch(/rewards you (define|choose)/i);
    expect(text).toMatch(/learning resources/i);
    expect(text).toMatch(/not yet available/i);
  });

  it('shows the traced lockup with the tagline as the hero visual and keeps the h1 as text', async () => {
    const { container } = await renderPublic(LandingPage, '/');
    const hero = screen.getByRole('img', { name: 'PencilLift' });
    expect(hero.getAttribute('src')).toBe('/brand/lockup.svg');
    expect(hero.getAttribute('width')).toMatch(/^\d+$/);
    expect(hero.getAttribute('height')).toMatch(/^\d+$/);
    // The h1 keeps the tagline as real text (visually hidden) and comes right after the lockup.
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.className).toContain('sr-only');
    expect(hero.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The old text lockup ("Pencil" + "Lift" spans) is gone from the page markup.
    expect(container.querySelectorAll('span[aria-label="PencilLift"]')).toHaveLength(0);
  });

  it.each([LandingPage, HowItWorksPage])('lists all six supported subjects', async (Page) => {
    await renderPublic(Page, '/');
    const subjects = screen.getByRole('list', { name: /subjects/i });
    const items = [...subjects.querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toEqual([
      'Math',
      'Reading comprehension',
      'Spelling and vocabulary',
      'Grammar and writing',
      'Science',
      'Social studies',
    ]);
  });
});

describe('HowItWorksPage (spec P1, P6–P10)', () => {
  it('explains the parent PIN area, Thursday reviews and parent-only commercial content honestly', async () => {
    const { container } = await renderPublic(HowItWorksPage, '/how-it-works');
    const text = container.textContent;
    expect(text).toMatch(/verifiable parental consent/i);
    expect(text).toMatch(/pairing code/i);
    expect(text).toMatch(/six-digit PIN/i);
    expect(text).toMatch(/Thursday at 4 p\.m\./);
    expect(text).toMatch(/can.t predict/i);
    expect(text).toMatch(/only in the parent area/i);
    expect(text).toMatch(/not money/i);
  });
});

describe('NotFoundPage', () => {
  it('offers real ways back instead of a dead end', async () => {
    await renderPublic(NotFoundPage, '/no-such-page');
    expect(screen.getByRole('link', { name: /home page/i }).getAttribute('href')).toBe('/');
    expect(screen.getByRole('link', { name: /support/i }).getAttribute('href')).toBe('/support');
  });
});

describe('PageTitle', () => {
  it('restores the site-wide static title when a public page unmounts', async () => {
    document.title = 'PencilLift — Turn homework into progress.';
    const view = await renderPublic(PricingPage, '/pricing');
    await waitFor(() => expect(document.title).toBe('Pricing · PencilLift'));
    view.unmount();
    expect(document.title).toBe('PencilLift — Turn homework into progress.');
  });
});

describe('public page sources (spec P11: prices come from @pencillift/domain)', () => {
  it('contain no hardcoded price literals', () => {
    const sources = import.meta.glob<string>(['./*.tsx', '!./*.test.tsx'], {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(9);
    for (const [file, source] of Object.entries(sources)) {
      expect(source, file).not.toMatch(/\$\d+\.\d\d/);
      expect(source, file).not.toMatch(/\b(3999|4998|5997|6996|999)\b/);
    }
  });
});
