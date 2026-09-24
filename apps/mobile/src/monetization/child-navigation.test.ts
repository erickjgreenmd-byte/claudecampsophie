import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * AC_MON_02 / spec P16.1: nothing commercial is ever rendered in child mode, login or pairing.
 * Expo Router's navigation config is the file tree under app/, so this test reads the real
 * routes: no child route may be a commercial screen, and no child, login or pairing route may
 * reach the monetization module or a commercial endpoint through any chain of local imports.
 */

const MOBILE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const APP_DIR = join(MOBILE_ROOT, 'app');
const CHILD_DIR = join(APP_DIR, '(child)');
const MONETIZATION_DIR = join(MOBILE_ROOT, 'src', 'monetization');

const COMMERCIAL_ROUTE_NAME = /resource|sponsor|monetiz|placement|affiliate|amazon|advert|shop/i;
const COMMERCIAL_REFERENCE =
  /\/v1\/placements|\/v1\/resources|\/v1\/monetization|SponsorCard|sponsorCard|monetization\//;

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

const IMPORT_PATTERN =
  /(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|import\s+['"](\.[^'"]+)['"]/g;

function resolveImport(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

/** Every local module reachable from `entry` through relative imports (entry included). */
function localImportClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) continue;
      const target = resolveImport(file, specifier);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

function commercialReach(entry: string): string[] {
  return [...localImportClosure(entry)]
    .filter(
      (file) =>
        file.startsWith(MONETIZATION_DIR) || COMMERCIAL_REFERENCE.test(readFileSync(file, 'utf8')),
    )
    .map((file) => relative(MOBILE_ROOT, file));
}

const childRoutes = listFiles(CHILD_DIR).filter((f) => /\.(ts|tsx)$/.test(f));

describe('child navigation contains no monetization screen (AC_MON_02)', () => {
  it('finds the child routes it is guarding', () => {
    const names = childRoutes.map((f) => relative(CHILD_DIR, f));
    expect(names).toContain('_layout.tsx');
    expect(names).toContain('home.tsx');
  });

  it('has no commercial route in the child group', () => {
    const commercial = childRoutes
      .map((f) => relative(CHILD_DIR, f))
      .filter((name) => COMMERCIAL_ROUTE_NAME.test(name));
    expect(commercial).toEqual([]);
  });

  it.each(childRoutes.map((f) => [relative(APP_DIR, f), f]))(
    '%s cannot reach the monetization module or a commercial endpoint',
    (_name, file) => {
      expect(commercialReach(file)).toEqual([]);
    },
  );

  it.each(['index.tsx', 'pair.tsx', '_layout.tsx', '(parent)/sign-in.tsx', '(parent)/unlock.tsx'])(
    'login, pairing and unlock route %s carries nothing commercial',
    (name) => {
      const file = join(APP_DIR, name);
      expect(existsSync(file)).toBe(true);
      expect(commercialReach(file)).toEqual([]);
    },
  );

  it('keeps the resources screen in the parent group only', () => {
    expect(existsSync(join(APP_DIR, '(parent)', 'resources.tsx'))).toBe(true);
    const outsideParent = listFiles(APP_DIR)
      .filter((f) => !f.startsWith(join(APP_DIR, '(parent)')))
      .filter((f) => COMMERCIAL_ROUTE_NAME.test(relative(APP_DIR, f)));
    expect(outsideParent).toEqual([]);
  });

  it('would notice a child route that imported the monetization module (self-check)', () => {
    // The parent resources screen does import it, so the same walk must report it there.
    const reach = commercialReach(join(APP_DIR, '(parent)', 'resources.tsx'));
    expect(reach.some((f) => f.startsWith(join('src', 'monetization')))).toBe(true);
  });
});
