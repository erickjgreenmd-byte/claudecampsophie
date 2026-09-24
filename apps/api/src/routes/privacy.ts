import { Hono } from 'hono';
import type { AppEnv } from '../middleware/context.ts';

/** Placeholder router for the privacy vertical (filled in by its owner). */
export function privacyRoutes(): Hono<AppEnv> {
  return new Hono<AppEnv>();
}
