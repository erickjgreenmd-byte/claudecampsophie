import { Hono } from 'hono';
import type { AppEnv } from '../middleware/context.ts';

/** Placeholder router for the promotions vertical (filled in by its owner). */
export function promotionsRoutes(): Hono<AppEnv> {
  return new Hono<AppEnv>();
}
