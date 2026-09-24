import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The answer guard reads arithmetic expressions as their value ("6 × 7" discloses 42) unless a
 * caller passes `evaluateExpressions: false`. Only a check of a problem statement may do that (the
 * bank's prompt self-check), because a problem necessarily contains an expression equal to its own
 * key. Every child-facing hint, intro or example must keep it on, so this test fails if a new call
 * site opts out, or if an API call site stops stating the option explicitly (spec P6, L-012).
 */

const ROOT = resolve(__dirname, '../../..');
const SCANNED = ['apps/api/src', 'packages/domain/src'];
const OPT_OUT_ALLOWED = new Set(['packages/domain/src/bank/validate.ts']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** The argument text of every `name(` call in `source`, parentheses balanced. */
function callArguments(source: string, name: string): string[] {
  const calls: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(`${name}(`, from);
    if (at === -1) return calls;
    let depth = 0;
    let end = at + name.length;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    calls.push(source.slice(at + name.length + 1, end));
    from = end;
  }
}

const files = SCANNED.flatMap((dir) => sourceFiles(join(ROOT, dir))).map((path) => ({
  path: relative(ROOT, path),
  source: readFileSync(path, 'utf8'),
}));

describe('answer-guard call sites keep expression reading on', () => {
  it('only the bank prompt self-check opts out', () => {
    const optOuts = files
      .filter((f) => !f.path.startsWith('packages/domain/src/answer-guard/'))
      .filter((f) => /evaluateExpressions\s*:\s*false/.test(f.source))
      .map((f) => f.path);
    expect(optOuts.filter((path) => !OPT_OUT_ALLOWED.has(path))).toEqual([]);
    expect(optOuts).toEqual([...OPT_OUT_ALLOWED]);
  });

  it('every API call to guardChildContent states evaluateExpressions: true', () => {
    const calls = files
      .filter((f) => f.path.startsWith('apps/api/src/'))
      .flatMap((f) =>
        callArguments(f.source, 'guardChildContent').map((args) => ({ path: f.path, args })),
      );
    expect(calls.length).toBeGreaterThanOrEqual(2); // scan coaching and the practice intro
    for (const call of calls) {
      expect(call.args, call.path).toMatch(/evaluateExpressions\s*:\s*true/);
    }
  });

  it('the default in the guard itself is on', () => {
    const scan = files.find((f) => f.path === 'packages/domain/src/answer-guard/scan.ts')!;
    expect(scan.source).toMatch(/evaluateExpressions !== false \? createExpressionCache\(\)/);
  });
});
