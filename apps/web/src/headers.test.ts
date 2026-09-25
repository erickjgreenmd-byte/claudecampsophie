// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Security headers for the static parent portal (WEB-02). `public/_headers` is the Cloudflare
 * Pages headers file; Vite copies `public/` into `dist/` unchanged, so the same file ships with the
 * build (docs/Deployment_Runbook.md §3.5). The CSP forbids inline scripts, so the page itself must
 * carry none: `index.html` is checked here, and the built `dist/index.html` when a build exists.
 */

const headersPath = fileURLToPath(new URL('../public/_headers', import.meta.url));
const indexPath = fileURLToPath(new URL('../index.html', import.meta.url));
const distIndexPath = fileURLToPath(new URL('../dist/index.html', import.meta.url));
const distHeadersPath = fileURLToPath(new URL('../dist/_headers', import.meta.url));

type Rules = Map<string, Map<string, string>>;

/** Parses the Cloudflare Pages `_headers` format: an unindented path, then indented `Name: value` lines. */
function parseHeadersFile(text: string): Rules {
  const rules: Rules = new Map();
  let current: Map<string, string> | null = null;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      current = new Map();
      rules.set(raw.trim(), current);
      continue;
    }
    if (!current) throw new Error(`header line before any path: ${raw}`);
    const colon = raw.indexOf(':');
    if (colon < 0) throw new Error(`malformed header line: ${raw}`);
    current.set(raw.slice(0, colon).trim(), raw.slice(colon + 1).trim());
  }
  return rules;
}

function parseCsp(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) directives.set(name, values);
  }
  return directives;
}

const rules = parseHeadersFile(readFileSync(headersPath, 'utf8'));
const site = rules.get('/*');

describe('apps/web/public/_headers (Cloudflare Pages)', () => {
  it('applies one rule set to every path', () => {
    expect(site).toBeDefined();
  });

  it.each([
    ['X-Content-Type-Options', 'nosniff'],
    ['X-Frame-Options', 'DENY'],
    ['Referrer-Policy', 'no-referrer'],
    ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
  ])('sets %s to %s', (name, value) => {
    expect(site?.get(name)).toBe(value);
  });

  it('denies camera, microphone and geolocation to the page and every frame', () => {
    const policy = site?.get('Permissions-Policy') ?? '';
    const parts = policy.split(',').map((p) => p.trim());
    for (const feature of ['camera', 'microphone', 'geolocation']) {
      expect(parts, `${feature} missing from ${policy}`).toContain(`${feature}=()`);
    }
  });

  it('sets a conservative Content-Security-Policy with no inline or remote scripts', () => {
    const csp = parseCsp(site?.get('Content-Security-Policy') ?? '');
    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('script-src')).toEqual(["'self'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'self'"]);
    expect(csp.get('form-action')).toEqual(["'self'"]);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('img-src')).toEqual(["'self'", 'data:', 'blob:']);
    // The API and Supabase origins are build variables, so a static file can only allow https:.
    expect(csp.get('connect-src')).toEqual(["'self'", 'https:']);
    // React sets `style` attributes, which need 'unsafe-inline' for styles only, never for scripts.
    expect(csp.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(csp.has('upgrade-insecure-requests')).toBe(true);
    for (const [name, values] of csp) {
      if (name === 'style-src') continue;
      expect(values, name).not.toContain("'unsafe-inline'");
      expect(values, name).not.toContain("'unsafe-eval'");
      expect(values, name).not.toContain('*');
    }
  });

  it('lets only the fingerprinted bundles cache for a year', () => {
    expect(rules.get('/assets/*')?.get('Cache-Control')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(site?.has('Cache-Control')).toBe(false);
  });

  it('has no path rule that would loosen the site-wide policy', () => {
    for (const [path, headers] of rules) {
      if (path === '/*') continue;
      for (const name of headers.keys()) {
        expect(site?.has(name), `${path} overrides ${name}`).toBe(false);
      }
    }
  });
});

/** Inline `<script>` (no src), inline event handlers and javascript: URLs are what the CSP blocks. */
function assertNoInlineScript(html: string, label: string) {
  const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
  for (const tag of scripts) {
    expect(tag, `${label}: inline script`).toMatch(/\ssrc=/);
  }
  expect(html, `${label}: inline event handler`).not.toMatch(/\son[a-z]+\s*=/i);
  expect(html, `${label}: javascript: URL`).not.toMatch(/javascript:/i);
}

describe('index.html under the CSP', () => {
  it('source index.html has no inline script and keeps the no-referrer meta in step with the header', () => {
    const html = readFileSync(indexPath, 'utf8');
    assertNoInlineScript(html, 'index.html');
    expect(html).toMatch(/<meta name="referrer" content="no-referrer" \/>/);
  });

  it('built dist/index.html (when a build exists) has no inline script and ships _headers beside it', () => {
    if (!existsSync(distIndexPath)) return;
    assertNoInlineScript(readFileSync(distIndexPath, 'utf8'), 'dist/index.html');
    expect(existsSync(distHeadersPath), 'dist/_headers missing: Vite must copy public/').toBe(true);
    expect(readFileSync(distHeadersPath, 'utf8')).toBe(readFileSync(headersPath, 'utf8'));
  });
});
