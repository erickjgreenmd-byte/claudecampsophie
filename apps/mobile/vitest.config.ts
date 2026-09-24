import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    reporters: ['default', ['json', { outputFile: '../../test-results/mobile.json' }]],
    // Pure logic only: modules under test must not import react-native (native behaviour needs a device).
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
