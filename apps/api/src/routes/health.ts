import { Hono } from 'hono';
import { productionReadiness } from '../config.ts';
import { assertOwnerAdmin, requireParent } from '../middleware/auth.ts';
import type { AppEnv } from '../middleware/context.ts';

export function healthRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get('/health', (c) => c.json({ ok: true }));
  // Readiness reveals which integrations are blocked; owner admin only.
  r.get('/v1/admin/readiness', requireParent, async (c) => {
    await assertOwnerAdmin(c);
    const { config } = c.var.deps;
    return c.json({ environment: config.environment, checks: productionReadiness(config) });
  });
  return r;
}
