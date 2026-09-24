import { Hono } from 'hono';
import type { AppEnv } from '../middleware/context.ts';

/** Placeholder router for the webhooks vertical (filled in by its owner). */
export function webhooksRoutes(): Hono<AppEnv> {
  return new Hono<AppEnv>();
}
