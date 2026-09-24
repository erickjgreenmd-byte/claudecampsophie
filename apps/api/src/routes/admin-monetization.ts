import { Hono } from 'hono';
import type { AppEnv } from '../middleware/context.ts';

/** Placeholder router for owner monetization administration (P16.5), filled in by its owner. */
export function adminMonetizationRoutes(): Hono<AppEnv> {
  return new Hono<AppEnv>();
}
