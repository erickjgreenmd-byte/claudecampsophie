import { Hono } from 'hono';
import type { AppEnv } from '../middleware/context.ts';

/** Placeholder router for the homework vertical (filled in by its owner). */
export function homeworkRoutes(): Hono<AppEnv> {
  return new Hono<AppEnv>();
}
