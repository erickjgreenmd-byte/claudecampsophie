import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { contrastRatio } from '@pencillift/ui-tokens';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../App.tsx';
import { BRAND_ASSETS, HEADER_LOGO_HEIGHT, Logo, SYMBOL_ONLY_MAX_WIDTH } from './Logo.tsx';

const publicDir = resolve(import.meta.dirname, '../../public');
// Read from disk: vitest does not process CSS imports.
const css = readFileSync(resolve(import.meta.dirname, '../styles.css'), 'utf8');

function cssVariable(name: string): string {
  const match = new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!match?.[1]) throw new Error(`missing ${name} in styles.css`);
  return match[1];
}

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match?.[1]) throw new Error(`missing rule ${selector} in styles.css`);
  return match[1];
}

function aspect(width: string | null, height: string | null): number {
  expect(width).toMatch(/^\d+$/);
  expect(height).toMatch(/^\d+$/);
  return Number(width) / Number(height);
}

afterEach(cleanup);

describe('Logo (traced brand lockup from apps/web/public/brand)', () => {
  it('renders the lockup without the tagline as an accessible image with an explicit intrinsic size', () => {
    render(<Logo />);
    const img = screen.getByRole('img', { name: 'PencilLift' });
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toBe('/brand/lockup-no-tagline.svg');
    expect(img.getAttribute('alt')).toBe('PencilLift');
    expect(img.getAttribute('height')).toBe(String(HEADER_LOGO_HEIGHT));
    const ratio = aspect(img.getAttribute('width'), img.getAttribute('height'));
    const { lockupNoTagline } = BRAND_ASSETS;
    expect(Math.abs(ratio - lockupNoTagline.width / lockupNoTagline.height)).toBeLessThan(0.02);
  });

  it('swaps to the symbol-only mark below 420px through a media query, at the same height', () => {
    const { container } = render(<Logo />);
    const picture = container.querySelector('picture.logo');
    expect(picture).not.toBeNull();
    const source = picture!.querySelector('source');
    expect(source).not.toBeNull();
    expect(source!.getAttribute('media')).toBe(SYMBOL_ONLY_MAX_WIDTH);
    expect(SYMBOL_ONLY_MAX_WIDTH).toBe('(max-width: 419.98px)');
    expect(source!.getAttribute('srcset')).toBe('/brand/symbol.svg');
    expect(source!.getAttribute('height')).toBe(String(HEADER_LOGO_HEIGHT));
    const ratio = aspect(source!.getAttribute('width'), source!.getAttribute('height'));
    expect(Math.abs(ratio - BRAND_ASSETS.symbol.width / BRAND_ASSETS.symbol.height)).toBeLessThan(
      0.02,
    );
    // Only one image is exposed to assistive technology.
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });

  it('hero variant shows the full lockup with the tagline, fluid, named after the brand only', () => {
    render(<Logo variant="hero" />);
    const img = screen.getByRole('img', { name: 'PencilLift' });
    expect(img.getAttribute('src')).toBe('/brand/lockup.svg');
    expect(img.getAttribute('width')).toBe(String(BRAND_ASSETS.lockup.width));
    expect(img.getAttribute('height')).toBe(String(BRAND_ASSETS.lockup.height));
    expect(img.className).toContain('logo-hero');
    expect(ruleBody('.logo-hero')).toMatch(/height:\s*auto/);
  });

  it('every asset it references is served from apps/web/public and matches its viewBox', () => {
    for (const asset of Object.values(BRAND_ASSETS)) {
      const file = resolve(publicDir, `.${asset.src}`);
      expect(existsSync(file), `${asset.src} missing under apps/web/public`).toBe(true);
      const svg = readFileSync(file, 'utf8');
      expect(svg).toContain(`viewBox="0 0 ${asset.width} ${asset.height}"`);
      // Derived artwork is labelled as a trace of the approved reference, never as exact.
      expect(svg).toMatch(/Traced from brand\/approved_logo_reference\.png/);
      expect(svg).toMatch(/not an exact copy/);
    }
  });

  it('styles.css sizes the header logo at the same height and keeps the tagline out of it', () => {
    expect(ruleBody('.logo img')).toMatch(new RegExp(`height:\\s*${HEADER_LOGO_HEIGHT}px`));
    expect(BRAND_ASSETS.lockupNoTagline.src).toBe('/brand/lockup-no-tagline.svg');
    expect(readFileSync(resolve(publicDir, 'brand/lockup-no-tagline.svg'), 'utf8')).not.toMatch(
      /homework|progress/i,
    );
  });
});

describe('brand bar (App shell)', () => {
  it('uses a teal focus ring with at least 3:1 contrast on the off-white bar and white cards (WCAG 1.4.11)', () => {
    const rule = ruleBody('.brand-bar a:focus-visible');
    const outline = /outline\s*:\s*([^;]+);/.exec(rule)?.[1] ?? '';
    const variable = /var\((--[\w-]+)\)/.exec(outline)?.[1];
    expect(variable).toBe('--teal');
    const ring = cssVariable(variable!);
    expect(ring.toUpperCase()).toBe('#008D87');
    for (const background of [cssVariable('--off-white'), cssVariable('--white')]) {
      expect(contrastRatio(ring, background)).toBeGreaterThanOrEqual(3);
    }
    expect(ruleBody('.brand-bar')).toMatch(/background:\s*var\(--off-white\)/);
    expect(ruleBody('.brand-bar a')).toMatch(/color:\s*var\(--navy\)/);
  });

  it.each(['/', '/how-it-works', '/pricing'])(
    'shows the logo as the home link and the main navigation on %s',
    async (path) => {
      window.history.pushState({}, '', path);
      render(<App />);
      await screen.findByRole('heading', { level: 1 });
      const home = screen.getByRole('link', { name: 'PencilLift home' });
      expect(home.getAttribute('href')).toBe('/');
      const logo = home.querySelector('img');
      expect(logo?.getAttribute('src')).toBe('/brand/lockup-no-tagline.svg');
      expect(logo?.getAttribute('alt')).toBe('PencilLift');
      const nav = screen.getByRole('navigation', { name: 'Main' });
      expect([...nav.querySelectorAll('a')].map((a) => a.textContent)).toEqual([
        'How it works',
        'Pricing',
        'Support',
        'Parent portal',
      ]);
    },
  );
});
