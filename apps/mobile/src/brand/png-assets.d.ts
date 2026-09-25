/**
 * Metro bundles `import mark from './x.png'` as an asset id (`ImageRequireSource`, a number). This
 * SDK's `expo/types` declares no image modules, so the brand module declares the shape it relies
 * on. Vite (the unit-test runner) serves the same import as a URL string; the tests accept both.
 */
declare module '*.png' {
  const source: number;
  export default source;
}
