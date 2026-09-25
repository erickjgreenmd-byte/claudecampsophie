import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { assertWebEnv } from './src/lib/config.ts';

export default defineConfig(({ command, mode }) => {
  // A release build fails here, in CI, rather than on the portal's first load: the same gates the
  // bundle runs at startup (src/lib/config.ts) see this build's VITE_* variables. Development and
  // test modes are exempt; the runtime gate still checks every PROD bundle.
  if (command === 'build' && mode === 'production') {
    assertWebEnv({ ...loadEnv(mode, process.cwd(), 'VITE_'), PROD: true, MODE: mode });
  }
  return {
    plugins: [react()],
    test: {
      reporters: ['default', ['json', { outputFile: '../../test-results/web.json' }]],
      include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
      environment: 'jsdom',
    },
  };
});
