import { Hono } from 'hono';
import type { AppEnv } from '../middleware/context.ts';

/** Placeholder router for the parent monetization surfaces (P16), filled in by its owner. */
export function monetizationRoutes(): Hono<AppEnv> {
  return new Hono<AppEnv>();
}
