import { Hono } from 'hono';
import { loadReadinessFacts, productionReadiness } from '../config.ts';
import { assertOwnerAdmin, requireParent } from '../middleware/auth.ts';
import type { AppEnv } from '../middleware/context.ts';

export function healthRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get('/health', (c) => c.json({ ok: true }));
  // Readiness (AC_DEPLOY_07) reveals which integrations are blocked; owner admin only. Adds
  // database facts to the configuration checks (this month's AI spend cap).
  r.get('/v1/admin/readiness', requireParent, async (c) => {
    await assertOwnerAdmin(c);
    const { config, db, clock } = c.var.deps;
    const facts = await loadReadinessFacts(db, clock());
    return c.json({ environment: config.environment, checks: productionReadiness(config, facts) });
  });
  return r;
}
