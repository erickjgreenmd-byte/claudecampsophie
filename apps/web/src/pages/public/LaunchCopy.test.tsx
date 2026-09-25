import { cleanup, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from '../../test/render.tsx';
import LandingPage from './LandingPage.tsx';
import PricingPage from './PricingPage.tsx';
import SupportPage from './SupportPage.tsx';
import TermsPage from './TermsPage.tsx';

/**
 * WEB-R1-11: the pre-launch statements ("still being built", "not yet available to download",
 * "not yet available for purchase") are gated by the build flag VITE_STORE_LIVE. Off (the default)
 * they show; `VITE_STORE_LIVE=true` (the store review build, docs/Release_Readiness.md) hides them.
 *
 * WEB-R1-08: the public Support FAQ points a parent who forgot the PIN to the self-serve verified
 * reset in the portal, and to support only when they cannot sign in.
 */

const PRE_LAUNCH = /still being built|not yet available/i;

async function renderPublic(Page: ComponentType, path: string) {
  const view = renderPage(<Page />, { path });
  await screen.findByRole('heading', { level: 1 });
  return view;
}

beforeEach(() => {
  // Draft legal state throughout so only the store flag changes between cases.
  vi.stubEnv('VITE_LEGAL_REVIEWED', 'false');
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const launchPages: [name: string, Page: ComponentType, path: string][] = [
  ['LandingPage', LandingPage, '/'],
  ['PricingPage', PricingPage, '/pricing'],
  ['TermsPage', TermsPage, '/terms'],
];

describe.each(launchPages)('WEB-R1-11 %s pre-launch notice', (_name, Page, path) => {
  it('shows the pre-launch notice while VITE_STORE_LIVE is unset', async () => {
    vi.stubEnv('VITE_STORE_LIVE', '');
    const { container } = await renderPublic(Page, path);
    expect(container.textContent).toMatch(PRE_LAUNCH);
  });

  it('keeps the notice for anything but the exact string "true"', async () => {
    vi.stubEnv('VITE_STORE_LIVE', '1');
    const { container } = await renderPublic(Page, path);
    expect(container.textContent).toMatch(PRE_LAUNCH);
  });

  it('hides the pre-launch notice when VITE_STORE_LIVE=true', async () => {
    vi.stubEnv('VITE_STORE_LIVE', 'true');
    const { container } = await renderPublic(Page, path);
    expect(container.textContent).not.toMatch(PRE_LAUNCH);
    expect(container.textContent).not.toMatch(/once store setup is complete/i);
  });
});

describe('WEB-R1-11 live pricing still names every store and makes no store-approval claim', () => {
  it('names the App Store, Google Play and the Amazon Appstore as where plans are bought', async () => {
    vi.stubEnv('VITE_STORE_LIVE', 'true');
    const { container } = await renderPublic(PricingPage, '/pricing');
    const text = container.textContent;
    expect(text).toMatch(/App Store/);
    expect(text).toMatch(/Google Play/);
    expect(text).toMatch(/Amazon Appstore/);
    expect(text).not.toMatch(/approved by (apple|google|amazon)/i);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('WEB-R1-08 public Support FAQ: forgotten parent PIN', () => {
  it('points to the verified self-serve reset in the portal, support only if sign-in fails', async () => {
    const { container } = await renderPublic(SupportPage, '/support');
    const question = screen.getByText('I forgot my parent PIN.');
    const answer = question.closest('div, li, details, section')!.textContent ?? '';
    expect(answer).toMatch(/Sign in to the parent portal/i);
    expect(answer).toMatch(/Security/);
    expect(answer).toMatch(/Reset your parent PIN/);
    expect(answer).toMatch(/account password/i);
    expect(answer).toMatch(/contact support only if you can.t sign in/i);
    expect(container.textContent).not.toMatch(/PIN is reset only after we verify you/i);
  });
});
