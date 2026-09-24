import { Hono } from 'hono';
import type { AppEnv } from '../middleware/context.ts';

/** Placeholder router for the guardians vertical (filled in by its owner). */
export function guardiansRoutes(): Hono<AppEnv> {
  return new Hono<AppEnv>();
}
