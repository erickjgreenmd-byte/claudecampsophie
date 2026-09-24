import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * L-007 / BUG-012: rotating refresh tokens tolerate exactly one refresher per device. A second,
 * independent refresher replays a rotated token and the server revokes the child's session (see
 * the reproduction in family/child-session.test.ts). These source checks keep it to one.
 */
const APP_ROOT = join(import.meta.dirname, '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const files = [...sources(join(APP_ROOT, 'src')), ...sources(join(APP_ROOT, 'app'))].map(
  (path) => ({ path: relative(APP_ROOT, path), source: readFileSync(path, 'utf8') }),
);

describe('the app has exactly one child token refresher (L-007)', () => {
  it('only the family child session calls the refresh endpoint', () => {
    expect(files.filter((f) => f.source.includes('/v1/child/refresh')).map((f) => f.path)).toEqual([
      'src/family/child-session.ts',
    ]);
  });

  it('the child session is constructed once, in the app runtime', () => {
    expect(files.filter((f) => /createChildSession\(\{/.test(f.source)).map((f) => f.path)).toEqual(
      ['src/family/runtime.ts'],
    );
  });
});
