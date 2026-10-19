#!/usr/bin/env node
/**
 * No test may run close to its own timeout.
 *
 *   node scripts/check-test-timeout-margin.mjs [--margin 2.5]
 *
 * WHY. `packages/domain/src/bank/grade-isolation.test.ts` measured 2,892 ms for its heaviest case
 * against vitest's 5,000 ms default — a 1.7x margin alone, and none at all under the full `domain`
 * run, which starts one worker per test file (96 of them) on however many cores the machine has. It
 * failed twice that way, and because `pnpm -r run test` stops at the first failing package, the
 * other six packages never reported (BUG-442). A contractor's first `pnpm check` would have gone
 * red on a machine, not on the code.
 *
 * That is not a flake to re-run: a test whose duration sits inside a small multiple of its deadline
 * WILL fail on a slower or busier machine, and the time to find out is now. This reads the durations
 * the reporters already wrote and fails when any test is closer to its deadline than the margin.
 * Raising a budget is the fix; the assertions are untouched by it.
 *
 * Needs `test-results/*.json`, which `pnpm test` writes. Skips silently when they are absent so a
 * static-only gate (`scripts/verify.sh --no-tests`) does not fail on a missing input.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = join(repo, 'test-results');
const argMargin = process.argv.indexOf('--margin');
const MARGIN = argMargin === -1 ? 2.5 : Number(process.argv[argMargin + 1]);

if (!existsSync(reportsDir)) {
  console.log('check-test-timeout-margin: no test-results/ — run pnpm test first; skipping');
  process.exit(0);
}

const VITEST_DEFAULT_MS = 5_000;

/** Report basename to the workspace directory whose config governs it. */
const PACKAGE_DIR = {
  api: 'apps/api',
  web: 'apps/web',
  mobile: 'apps/mobile',
  domain: 'packages/domain',
  ai: 'packages/ai',
  contracts: 'packages/contracts',
  'ui-tokens': 'packages/ui-tokens',
  db: 'supabase',
};

/**
 * The repo-relative path of a test file. A reporter records an ABSOLUTE path, and the run may have
 * happened in a git worktree somewhere else entirely, so `relative(repo, name)` produces
 * `../../../tmp/claude-0/gate4-.../apps/api/tests/x.ts`. That path resolves to nothing here, the
 * per-file and per-package lookups both miss, and every test falls back to the 5,000 ms default —
 * which reported nine `apps/api` tests as over their limit when that package runs at 30,000 ms.
 * Cutting at the known package directory makes the answer the same wherever the run happened.
 */
function repoRelative(name, pkgDir) {
  const unix = name.replace(/\\/g, '/');
  const at = unix.lastIndexOf(`/${pkgDir}/`);
  if (at !== -1) return unix.slice(at + 1);
  const rel = relative(repo, unix);
  return rel.startsWith('..') ? unix : rel;
}

/** The timeout a file actually runs under: its own setConfig, else its package's config, else 5 s. */
const configCache = new Map();
function packageTimeout(file) {
  const m = /^(apps\/[a-z]+|packages\/[a-z-]+|supabase)\//.exec(file);
  const pkgDir = m === null ? null : m[1];
  if (pkgDir === null) throw new Error(`cannot tell which package governs ${file}`);
  if (!configCache.has(pkgDir)) {
    let value = VITEST_DEFAULT_MS;
    for (const name of ['vitest.config.ts', 'vitest.config.mts', 'vite.config.ts']) {
      const p = join(repo, pkgDir, name);
      if (!existsSync(p)) continue;
      const hit = /testTimeout:\s*([\d_]+)/.exec(readFileSync(p, 'utf8'));
      if (hit !== null) value = Number(hit[1].replace(/_/g, ''));
      break;
    }
    configCache.set(pkgDir, value);
  }
  return configCache.get(pkgDir);
}

function fileTimeout(file) {
  const p = join(repo, file);
  if (existsSync(p)) {
    const hit = /vi\.setConfig\(\{[^}]*testTimeout:\s*([\d_]+)/.exec(readFileSync(p, 'utf8'));
    if (hit !== null) return Number(hit[1].replace(/_/g, ''));
  }
  return packageTimeout(file);
}

const tight = [];
let examined = 0;

/**
 * A partial set of reports would pass this check while saying nothing — the same vacuity
 * `assert-test-count.mjs` exists to prevent. A single-file run overwrites its package's report, so
 * the totals are compared against the floors and a short report is a failure, not a pass.
 */
const floors = JSON.parse(readFileSync(join(repo, 'scripts/test-minimums.json'), 'utf8'));
const perPackage = new Map();

for (const report of readdirSync(reportsDir).filter((f) => f.endsWith('.json'))) {
  const data = JSON.parse(readFileSync(join(reportsDir, report), 'utf8'));
  const reportName = report.replace(/\.json$/, '');
  const pkgDir = PACKAGE_DIR[reportName];
  if (pkgDir === undefined) throw new Error(`unknown report ${report}; add it to PACKAGE_DIR`);
  perPackage.set(`@pencillift/${reportName}`, data.numTotalTests ?? 0);
  for (const suiteFile of data.testResults ?? []) {
    const file = repoRelative(suiteFile.name, pkgDir);
    const limit = fileTimeout(file);
    for (const a of suiteFile.assertionResults ?? []) {
      const ms = a.duration ?? 0;
      examined += 1;
      if (ms * MARGIN > limit) {
        tight.push({
          file,
          name: [...(a.ancestorTitles ?? []), a.title].join(' > '),
          ms: Math.round(ms),
          limit,
          ratio: (limit / ms).toFixed(2),
        });
      }
    }
  }
}

const short = Object.entries(floors).filter(([name, floor]) => (perPackage.get(name) ?? 0) < floor);
if (short.length > 0) {
  console.error(
    '✗ test timeout margins: the reports in test-results/ are not a whole run, so this check would ' +
      'pass without examining anything. Run `pnpm test` (not a single file) and try again.',
  );
  for (const [name, floor] of short) {
    console.error(`  - ${name}: report holds ${perPackage.get(name) ?? 0}, floor is ${floor}`);
  }
  process.exit(1);
}

if (tight.length > 0) {
  tight.sort((a, b) => Number(a.ratio) - Number(b.ratio));
  console.error(
    `✗ ${tight.length} test(s) run closer than ${MARGIN}x to their timeout. On a slower or busier ` +
      'machine they fail, and the failure says nothing about the code. Give the file an explicit ' +
      'budget (`vi.setConfig({ testTimeout: N })`, as packages/domain/src/bank/bank.test.ts does) ' +
      'or make the test cheaper. Do NOT weaken what it asserts.',
  );
  for (const t of tight) {
    console.error(
      `  - ${t.file}\n      ${t.name}\n      ${t.ms} ms against a ${t.limit} ms timeout (${t.ratio}x)`,
    );
  }
  process.exit(1);
}
console.log(
  `✓ test timeout margins: ${examined} tests, none closer than ${MARGIN}x to its deadline`,
);
