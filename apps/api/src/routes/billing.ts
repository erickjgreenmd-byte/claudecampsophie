import { Hono } from 'hono';
import type { AppEnv } from '../middleware/context.ts';

/** Placeholder router for parent billing status/sync (P11), filled in by its owner. */
export function billingRoutes(): Hono<AppEnv> {
  return new Hono<AppEnv>();
}
