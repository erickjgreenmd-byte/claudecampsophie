import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The portal's hosting configuration (`apps/web/wrangler.toml`), asserted rather than trusted.
 *
 * Every value below has a failure mode a parent meets and a test suite does not: a wrong
 * `not_found_handling` turns every emailed link into a 404 at the edge, a shared Worker name
 * overwrites one environment with another, and a `main` entry would put code of ours in front of a
 * session that needs none. None of that shows up in a unit test of a React component, which is why
 * it is checked here (the same reason `apps/api/tests/runtime.test.ts` exists for the API).
 */
const TOML = readFileSync(join(import.meta.dirname, '..', 'wrangler.toml'), 'utf8');

/** Section bodies keyed by header, e.g. `env.testbed.assets` -> the lines under it. */
function sections(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let current = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header?.[1]) {
      current = header[1];
      out[current] ??= '';
      continue;
    }
    if (line) out[current] = `${out[current] ?? ''}${line}\n`;
  }
  return out;
}

const TABLES = sections(TOML);
/** Every table that configures assets: the top level and one per environment. */
const ASSET_TABLES = Object.keys(TABLES).filter((name) => name.endsWith('assets'));

describe('the portal is served as a single-page application, everywhere', () => {
  it('declares an assets table for the top level and for every environment', () => {
    // A guard over an empty set passes (L-054): without this the loop below proves nothing.
    expect(ASSET_TABLES.sort()).toEqual([
      'assets',
      'env.production.assets',
      'env.staging.assets',
      'env.testbed.assets',
    ]);
  });

  it('every assets table serves ./dist with the SPA fallback', () => {
    for (const name of ASSET_TABLES) {
      const body = TABLES[name] ?? '';
      expect(body, name).toContain('directory = "./dist"');
      // The DEFAULT is `none`, which 404s every client-side route at the edge. Asserted as the
      // literal value rather than "not none", because a third value would be wrong too.
      expect(body, name).toContain('not_found_handling = "single-page-application"');
    }
  });
});

describe('the environments cannot overwrite each other', () => {
  it('each environment deploys a differently named Worker', () => {
    const names = [...TOML.matchAll(/^name = "([^"]+)"$/gm)].map((m) => m[1]);
    expect(names).toEqual([
      'pencillift-web',
      'pencillift-web-testbed',
      'pencillift-web-staging',
      'pencillift-web-production',
    ]);
    expect(new Set(names).size, 'a repeated name silently replaces another environment').toBe(
      names.length,
    );
  });

  it('production is not published on a workers.dev subdomain', () => {
    // Inherited from the top-level `workers_dev = false`; testbed and staging opt in explicitly.
    expect(TABLES['env.production'] ?? '').not.toContain('workers_dev = true');
    expect(TABLES['env.testbed'] ?? '').toContain('workers_dev = true');
    expect(TABLES['env.staging'] ?? '').toContain('workers_dev = true');
  });
});

describe('nothing of ours runs in front of a parent’s session', () => {
  it('has no Worker entry point', () => {
    // `main = ...` would make this a code Worker rather than a static host. Asserted as SYNTAX, not
    // as the word: a comment mentioning `main` must not satisfy it (L-077).
    expect(TOML).not.toMatch(/^\s*main\s*=/m);
  });

  it('carries no secret, key or token of any kind', () => {
    // The three public build variables are compiled into the bundle by the deploy workflow, never
    // written here. This file is committed, so anything that looks like a credential is a leak.
    expect(TOML).not.toMatch(/(?:secret|token|password|api[_-]?key)\s*=/i);
  });
});
