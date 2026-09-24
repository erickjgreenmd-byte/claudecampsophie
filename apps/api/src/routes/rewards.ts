import { Hono } from 'hono';
import type { AppEnv } from '../middleware/context.ts';

/** Placeholder router for the rewards vertical (filled in by its owner). */
export function rewardsRoutes(): Hono<AppEnv> {
  return new Hono<AppEnv>();
}
