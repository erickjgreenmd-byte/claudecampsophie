import { Hono } from 'hono';
import type { AppEnv } from '../middleware/context.ts';

/** Placeholder router for the learning vertical (filled in by its owner). */
export function learningRoutes(): Hono<AppEnv> {
  return new Hono<AppEnv>();
}
