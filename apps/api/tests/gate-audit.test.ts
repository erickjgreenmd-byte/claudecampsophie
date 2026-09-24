import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Self-test of the CI gate audit (spec E5.6, AC_ECC_07/15): a run with too few tests, a failed or
 * skipped test, or a missing report must fail the gate. The audit reads synthetic reports from a
 * temporary directory (PL_TEST_RESULTS_DIR); the repository's own reports are never touched.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const minimums = JSON.parse(
  readFileSync(path.join(ROOT, 'scripts/test-minimums.json'), 'utf8'),
) as Record<string, number>;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function report(passed: number, extra: { failed?: number; pending?: number } = {}) {
  const failed = extra.failed ?? 0;
  const pending = extra.pending ?? 0;
  return {
    numTotalTests: passed + failed + pending,
    numPassedTests: passed,
    numFailedTests: failed,
    numPendingTests: pending,
    numTodoTests: 0,
  };
}

function audit(reports: Record<string, object | undefined>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gate-audit-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(reports)) {
    if (body)
      writeFileSync(
        path.join(dir, `${name.replace('@pencillift/', '')}.json`),
        JSON.stringify(body),
      );
  }
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts/assert-test-count.mjs')], {
    env: { ...process.env, PL_TEST_RESULTS_DIR: dir },
    encoding: 'utf8',
  });
}

const atFloor = () =>
  Object.fromEntries(Object.entries(minimums).map(([name, min]) => [name, report(min)]));

describe('CI gate audit', () => {
  it('passes when every package ran at least its floor with nothing failed or skipped', () => {
    const run = audit(atFloor());
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('fails when a package ran fewer tests than its floor (mass deletion or a partial run)', () => {
    const run = audit({
      ...atFloor(),
      '@pencillift/api': report(minimums['@pencillift/api']! - 1),
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/@pencillift\/api: .* < minimum/);
  });

  it('fails on a failed or skipped test, and on a missing report', () => {
    expect(audit({ ...atFloor(), '@pencillift/web': report(1000, { failed: 1 }) }).status).toBe(1);
    expect(audit({ ...atFloor(), '@pencillift/web': report(1000, { pending: 1 }) }).status).toBe(1);
    const missing = audit({ ...atFloor(), '@pencillift/db': undefined });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/@pencillift\/db: no test report/);
  });
});
