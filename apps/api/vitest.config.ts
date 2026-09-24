import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    reporters: ['default', ['json', { outputFile: '../../test-results/api.json' }]],
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    maxWorkers: 2,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
