import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, screen } from '@testing-library/react';
import { contrastRatio } from '@pencillift/ui-tokens';
import { afterEach, describe, expect, it } from 'vitest';
import { renderPage } from '../../test/render.tsx';
import LandingPage from './LandingPage.tsx';

/**
 * Independent review of the public-site vertical (REVIEW-PUBLIC-SITE), AC_UX_01 (focus and
 * contrast). Public CTA links and text links carry no focus style of their own (inline styles
 * cannot), so keyboard users see only the global `:focus-visible` ring from styles.css.
 */

// Read from disk: vitest does not process CSS imports, so `?raw` would yield an empty string.
const css = readFileSync(resolve(import.meta.dirname, '../../styles.css'), 'utf8');

function cssVariable(name: string): string {
  const match = new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!match?.[1]) throw new Error(`missing ${name} in styles.css`);
  return match[1];
}

/** Resolves the colour of the global :focus-visible outline (a literal or a var()). */
function focusRingColour(): string {
  const rule = /:focus-visible\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  const outline = /outline\s*:\s*([^;]+);/.exec(rule)?.[1] ?? '';
  const variable = /var\((--[\w-]+)\)/.exec(outline)?.[1];
  if (variable) return cssVariable(variable);
  const literal = /#[0-9a-fA-F]{6}/.exec(outline)?.[0];
  if (!literal) throw new Error(`cannot resolve focus outline colour from "${outline}"`);
  return literal;
}

afterEach(cleanup);

describe('LandingPage keyboard focus review', () => {
  it('[RV-public-site-5] the focus ring around public links and CTAs has at least 3:1 contrast with the page (WCAG 1.4.11)', async () => {
    renderPage(<LandingPage />, { path: '/' });
    await screen.findByRole('heading', { level: 1 });
    // The page's primary CTA relies on the global focus ring.
    const cta = screen.getByRole('link', { name: /see how PencilLift works/i });
    expect(cta.getAttribute('style') ?? '').not.toMatch(/outline/);

    const ring = focusRingColour();
    // outline-offset: 2px means the ring sits on the page background (off-white body, white
    // cards/secondary CTAs, the .notice panel), not on the button fill.
    const backgrounds = {
      'page (--off-white)': cssVariable('--off-white'),
      'card / secondary CTA (--white)': cssVariable('--white'),
      '.notice panel': '#fff8eb',
    };
    for (const [where, background] of Object.entries(backgrounds)) {
      const ratio = contrastRatio(ring, background);
      expect(
        ratio,
        `focus ring ${ring} on ${where} ${background} = ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(3);
    }
  });
});
