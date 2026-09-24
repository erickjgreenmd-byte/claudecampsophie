import type { RouteObject } from 'react-router';

/** Route table; page modules are added by feature (public, parent portal, owner admin). */
export const routes: RouteObject[] = [
  {
    path: '/',
    lazy: async () => ({ Component: (await import('./pages/public/Landing.tsx')).Landing }),
  },
];
