// Shared primitives are exported flat; business modules are imported by subpath
// (e.g. `@pencillift/domain/promotions`) to keep each module's vocabulary unambiguous.
export * from './shared/result.ts';
export * from './shared/random.ts';
export * from './shared/money.ts';
export * from './shared/time.ts';
export * from './shared/billing.ts';
export * from './pricing/index.ts';
