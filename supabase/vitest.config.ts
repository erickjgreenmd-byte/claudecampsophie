import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    reporters: ['default', ['json', { outputFile: '../test-results/db.json' }]],
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Each test file provisions its own database; keep file-level parallelism modest.
    maxWorkers: 2,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
