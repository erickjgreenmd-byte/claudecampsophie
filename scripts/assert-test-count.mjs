// CI gate audit (spec E5.6 / AC_ECC_15): a green run that executed zero relevant tests is a failure.
// Every workspace package with a `test` script must have written a vitest JSON report with at least
// the configured minimum number of passing tests and zero failures or skips.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const minimums = JSON.parse(readFileSync(path.join(root, 'scripts/test-minimums.json'), 'utf8'));

const packageDirs = ['apps', 'packages']
  .flatMap((dir) =>
    existsSync(path.join(root, dir))
      ? readdirSync(path.join(root, dir)).map((name) => path.join(dir, name))
      : [],
  )
  .concat(['supabase']);

let failed = false;
for (const dir of packageDirs) {
  const manifestPath = path.join(root, dir, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!manifest.scripts?.test) continue;
  const name = manifest.name;
  const reportPath = path.join(root, 'test-results', `${name.replace('@pencillift/', '')}.json`);
  if (!existsSync(reportPath)) {
    console.error(`✗ ${name}: no test report at ${path.relative(root, reportPath)}`);
    failed = true;
    continue;
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const min = minimums[name] ?? 1;
  const problems = [];
  if (report.numTotalTests < min) problems.push(`${report.numTotalTests} tests < minimum ${min}`);
  if (report.numFailedTests > 0) problems.push(`${report.numFailedTests} failed`);
  if (report.numPendingTests > 0 || report.numTodoTests > 0)
    problems.push(`${report.numPendingTests + report.numTodoTests} skipped/todo`);
  if (problems.length) {
    console.error(`✗ ${name}: ${problems.join('; ')}`);
    failed = true;
  } else {
    console.log(`✓ ${name}: ${report.numPassedTests} passed (minimum ${min})`);
  }
}
process.exit(failed ? 1 : 0);
