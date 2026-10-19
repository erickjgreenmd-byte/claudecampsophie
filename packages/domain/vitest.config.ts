import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    reporters: ['default', ['json', { outputFile: '../../test-results/domain.json' }]],
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // This package is where the property tests live: they generate every bank item for every skill
    // at every grade, scan each one for leaks, and screen a synthetic corpus. Five of them measured
    // between 2.5 s and 4.5 s against vitest's 5,000 ms default — one at 4,512 ms, a 1.11x margin —
    // and the run starts one worker process per test file, 96 of them, on however many cores the
    // machine has. They are deterministic failures on a slower machine, not flakes (BUG-442).
    // `apps/api` and `supabase` already carry this same budget. It bounds the harness and nothing
    // below it: `scripts/check-test-timeout-margin.mjs` fails the gate if any test creeps up on it
    // again, and `bank.test.ts` keeps its own 120 s because 30 s is genuinely not enough for it.
    testTimeout: 30_000,
  },
});
