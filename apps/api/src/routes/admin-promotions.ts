import { Hono } from 'hono';
import type { AppEnv } from '../middleware/context.ts';

/** Placeholder router for the admin-promotions vertical (filled in by its owner). */
export function adminPromotionsRoutes(): Hono<AppEnv> {
  return new Hono<AppEnv>();
}
