import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Brand wiring in the web shell: every icon index.html references is a real file under
 * apps/web/public, the manifest carries the brand colours, and the small marks are the symbol
 * without the tagline (brand/BRAND_GUIDE.md, brand/ASSETS.md).
 */

const webRoot = resolve(import.meta.dirname, '..');
const publicDir = resolve(webRoot, 'public');
const html = readFileSync(resolve(webRoot, 'index.html'), 'utf8');

const TEAL = '#008D87';
const OFF_WHITE = '#F7F9FB';
/** Public origin (docs/Deployment_Runbook.md, step 8): Open Graph needs absolute image URLs. */
const PUBLIC_ORIGIN = 'https://pencillift.com';

/** All `<link>` / `<meta>` tags in the head as attribute maps. */
function headTags(name: 'link' | 'meta'): Record<string, string>[] {
  return [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'g'))].map((tag) =>
    Object.fromEntries(
      [...tag[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [key!, value!]),
    ),
  );
}

function meta(selector: 'name' | 'property', value: string): string | undefined {
  return headTags('meta').find((tag) => tag[selector] === value)?.content;
}

/** Path under apps/web/public for a site-absolute href, or an absolute URL on the public origin. */
function publicFile(href: string): string {
  const path = href.startsWith(PUBLIC_ORIGIN) ? href.slice(PUBLIC_ORIGIN.length) : href;
  expect(path, href).toMatch(/^\/[\w./-]+$/);
  return resolve(publicDir, `.${path}`);
}

/** Width and height from a PNG's IHDR chunk (bytes 16–23), after the 8-byte signature. */
function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function readManifest(): {
  name: string;
  short_name: string;
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
} {
  return JSON.parse(readFileSync(resolve(publicDir, 'manifest.webmanifest'), 'utf8'));
}

describe('index.html brand head', () => {
  it('links the SVG favicon, PNG fallbacks, the apple touch icon and the manifest', () => {
    const links = headTags('link');
    const icons = links.filter((tag) => tag.rel === 'icon');
    expect(icons.some((tag) => tag.href === '/favicon.svg' && tag.type === 'image/svg+xml')).toBe(
      true,
    );
    for (const size of ['32x32', '16x16']) {
      const png = icons.find((tag) => tag.sizes === size);
      expect(png?.type, size).toBe('image/png');
      const actual = pngSize(publicFile(png!.href!));
      expect(`${actual.width}x${actual.height}`).toBe(size);
    }
    const touch = links.find((tag) => tag.rel === 'apple-touch-icon');
    expect(touch?.href).toBe('/apple-touch-icon-180.png');
    expect(pngSize(publicFile(touch!.href!))).toEqual({ width: 180, height: 180 });
    expect(links.find((tag) => tag.rel === 'manifest')?.href).toBe('/manifest.webmanifest');
  });

  it('every referenced icon, manifest and Open Graph image exists under apps/web/public', () => {
    const hrefs = [
      ...headTags('link')
        .filter((tag) => /^(icon|apple-touch-icon|manifest)$/.test(tag.rel ?? ''))
        .map((tag) => tag.href!),
      meta('property', 'og:image')!,
    ];
    expect(hrefs.length).toBeGreaterThanOrEqual(6);
    for (const href of hrefs) {
      expect(existsSync(publicFile(href)), `${href} is missing under apps/web/public`).toBe(true);
    }
  });

  it('sets the teal theme colour, matching the manifest', () => {
    expect(meta('name', 'theme-color')?.toUpperCase()).toBe(TEAL);
    expect(readManifest().theme_color.toUpperCase()).toBe(
      meta('name', 'theme-color')!.toUpperCase(),
    );
  });

  it('points Open Graph at the 512px PNG tile on the public origin (never an SVG)', () => {
    const image = meta('property', 'og:image');
    expect(image).toBe(`${PUBLIC_ORIGIN}/icon-512.png`);
    expect(meta('property', 'og:image:type')).toBe('image/png');
    expect(pngSize(publicFile(image!))).toEqual({
      width: Number(meta('property', 'og:image:width')),
      height: Number(meta('property', 'og:image:height')),
    });
    expect(meta('property', 'og:title')).toMatch(/^PencilLift/);
    expect(meta('property', 'og:image:alt')).toBeTruthy();
  });
});

describe('manifest.webmanifest', () => {
  it('parses with the brand name, colours and real 192/512 icons for any and maskable', () => {
    const manifest = readManifest();
    expect(manifest.name).toBe('PencilLift');
    expect(manifest.short_name).toBe('PencilLift');
    expect(manifest.theme_color.toUpperCase()).toBe(TEAL);
    expect(manifest.background_color.toUpperCase()).toBe(OFF_WHITE);
    const seen = new Set<string>();
    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      const actual = pngSize(publicFile(icon.src));
      expect(`${actual.width}x${actual.height}`, icon.src).toBe(icon.sizes);
      seen.add(`${icon.sizes}:${icon.purpose ?? 'any'}`);
    }
    expect([...seen].sort()).toEqual(
      ['192x192:any', '192x192:maskable', '512x512:any', '512x512:maskable'].sort(),
    );
  });
});

describe('small marks', () => {
  it('the favicon is the symbol alone: no tagline, no wordmark, no presentation board', () => {
    const favicon = readFileSync(resolve(publicDir, 'favicon.svg'), 'utf8');
    expect(favicon).toBe(readFileSync(resolve(publicDir, 'brand/symbol.svg'), 'utf8'));
    expect(favicon).toContain('viewBox="0 0 540 430"');
    expect(favicon).not.toMatch(/<text|homework|progress/i);
    expect(favicon).toMatch(/Traced from brand\/approved_logo_reference\.png/);
  });

  it('the lockup used as the hero is the only shell asset that carries the tagline', () => {
    const lockup = readFileSync(resolve(publicDir, 'brand/lockup.svg'), 'utf8');
    expect(lockup).toContain('Turn homework into progress.');
    for (const file of ['brand/lockup-no-tagline.svg', 'brand/symbol.svg', 'brand/wordmark.svg']) {
      expect(readFileSync(resolve(publicDir, file), 'utf8'), file).not.toMatch(/homework/i);
    }
  });
});
