import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Expo Router navigation integrity. The route types that `typedRoutes` generates are not part of
 * `tsc` here (expo-env.d.ts is generated and ignored), so a link to a missing screen, or a screen
 * nothing links to, would pass typecheck (RV-rewards-6: the approvals screen was unreachable).
 */
const appDir = join(import.meta.dirname, '..', 'app');
const srcDir = import.meta.dirname;
const GROUPS = ['(parent)', '(child)'] as const;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Screen route of a file under app/, e.g. app/(parent)/plan.tsx -> '/(parent)/plan'. */
function screenRoute(file: string): string | null {
  const rel = relative(appDir, file).replace(/\.tsx$/, '');
  if (rel.endsWith('_layout')) return null;
  return rel === 'index' ? '/' : `/${rel}`;
}

const screens = files(appDir)
  .map(screenRoute)
  .filter((r): r is string => r !== null);

/** String literals shaped like a route: '/', '/pair', '/(parent)/plan'. */
const ROUTE_LITERAL = /['"`](\/(?:\((?:parent|child)\)\/)?(?:[a-z][a-z-]*)?)['"`]/g;

function routeLiterals(): { route: string; file: string }[] {
  return [...files(appDir), ...files(srcDir)].flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(ROUTE_LITERAL)].map((m) => ({
      route: m[1]!,
      file: relative(join(appDir, '..'), file),
    })),
  );
}

/** Screens a route can open: an exact match, or a group-less path matching a grouped screen. */
function resolve(route: string): string[] {
  if (screens.includes(route)) return [route];
  return GROUPS.map((g) => `/${g}${route}`).filter((r) => screens.includes(r));
}

describe('mobile navigation integrity', () => {
  it('every route literal opens exactly one screen', () => {
    const broken = routeLiterals()
      .filter(({ route }) => resolve(route).length !== 1)
      .map(({ route, file }) => `${route} in ${file}`);
    expect(broken).toEqual([]);
  });

  it('every screen is reachable from some route literal', () => {
    const linked = new Set(routeLiterals().flatMap(({ route }) => resolve(route)));
    const orphans = screens.filter((s) => s !== '/' && !linked.has(s));
    expect(orphans).toEqual([]);
  });

  it('the parent home links to every parent tool screen', () => {
    const home = readFileSync(join(appDir, '(parent)', 'home.tsx'), 'utf8');
    for (const screen of ['rewards', 'planner', 'plan', 'school', 'resources', 'privacy']) {
      expect(home, screen).toContain(`'/(parent)/${screen}'`);
    }
  });
});
