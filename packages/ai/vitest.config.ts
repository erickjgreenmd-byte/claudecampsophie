import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    reporters: ['default', ['json', { outputFile: '../../test-results/ai.json' }]],
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
