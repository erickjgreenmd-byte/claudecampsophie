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
    build: {
      rollupOptions: {
        output: {
          /**
           * WEB-R2-09: the single entry chunk was 643 kB (gzip 187 kB), over Vite's 500 kB warning,
           * because the auth SDK and the schema library sat in it. Splitting them keeps the entry
           * small and lets the browser cache them across deploys of the app code.
           */
          manualChunks: (id: string): string | undefined => {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('@supabase')) return 'supabase-auth';
            if (id.includes('/zod/')) return 'schema';
            if (/\/(react|react-dom|react-router|scheduler)\//.test(id)) return 'react';
            return undefined;
          },
        },
      },
    },
    test: {
      reporters: ['default', ['json', { outputFile: '../../test-results/web.json' }]],
      include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
      environment: 'jsdom',
    },
  };
});
