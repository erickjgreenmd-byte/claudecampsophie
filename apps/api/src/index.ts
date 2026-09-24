import postgres from 'postgres';
import { createApp } from './app.ts';
import { createParentVerifier } from './auth/parent.ts';
import { loadConfig } from './config.ts';
import { createDb } from './db.ts';
import { runScheduledTick } from './jobs/dispatcher.ts';
import type { AppDeps } from './middleware/context.ts';
import { createDbRateLimiter } from './middleware/rate-limit.ts';
import {
  createDevelopmentConsentMock,
  createMemoryStorageMock,
  createOutboxEmailMock,
} from './providers/index.ts';
import { cryptoRandom } from '@pencillift/domain';
import {
  createRevenueCatProvider,
  createStripeClient,
  createStripeClientMock,
  createSubscriberStateMock,
} from './providers/billing.ts';

/**
 * Cloudflare Worker entry. Secrets/vars arrive in `env`; the database connection comes from the
 * Hyperdrive binding. Nothing here runs at import time, so tests use createApp() directly.
 */
export interface WorkerEnv {
  readonly HYPERDRIVE: { readonly connectionString: string };
  readonly [key: string]: unknown;
}

function stringEnv(env: WorkerEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') out[key] = value;
  return out;
}

interface Runtime {
  readonly deps: AppDeps;
  readonly sql: postgres.Sql;
}

type RuntimeResult = { ok: true; runtime: Runtime } | { ok: false; code: string; message: string };

/** Builds the per-invocation dependencies shared by HTTP requests and Cron Triggers. */
function buildRuntime(env: WorkerEnv): RuntimeResult {
  const loaded = loadConfig(stringEnv(env));
  if (!loaded.ok)
    return { ok: false, code: 'NOT_CONFIGURED', message: 'Service is not configured' };
  const config = loaded.config;
  if (config.environment === 'production' && config.providers.consent !== 'configured') {
    // AC_DEPLOY_07: production never serves with the development consent mock.
    return { ok: false, code: 'BLOCKED_EXTERNAL', message: 'Service is not ready' };
  }
  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    fetch_types: false,
    prepare: false,
  });
  const db = createDb(sql);
  const deps: AppDeps = {
    config,
    db,
    clock: () => new Date(),
    random: cryptoRandom,
    verifyParentToken: createParentVerifier(config),
    rateLimiter: createDbRateLimiter(db),
    // Real Supabase Storage / email adapters replace these once credentials exist (docs/Connections.md).
    providers: {
      consent: createDevelopmentConsentMock(),
      storage: createMemoryStorageMock(),
      email: createOutboxEmailMock(),
      subscriptions:
        typeof env.REVENUECAT_SECRET_API_KEY === 'string'
          ? createRevenueCatProvider(env.REVENUECAT_SECRET_API_KEY)
          : createSubscriberStateMock(),
      stripe:
        typeof env.STRIPE_SECRET_KEY === 'string'
          ? createStripeClient(env.STRIPE_SECRET_KEY)
          : createStripeClientMock(),
    },
    log: (event) => console.log(JSON.stringify(event)),
  };
  return { ok: true, runtime: { deps, sql } };
}

interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const built = buildRuntime(env);
    if (!built.ok) {
      return Response.json(
        { error: { code: built.code, message: built.message, requestId: 'config' } },
        { status: 503 },
      );
    }
    const { deps, sql } = built.runtime;
    const response = await createApp(deps).fetch(request, env);
    ctx.waitUntil(sql.end({ timeout: 5 }));
    return response;
  },

  /** Cron Trigger (wrangler.toml): one idempotent tick of durable scheduled work. */
  async scheduled(_controller: unknown, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const built = buildRuntime(env);
    if (!built.ok) {
      console.log(
        JSON.stringify({ level: 'error', event: 'scheduled_not_configured', code: built.code }),
      );
      return;
    }
    const { deps, sql } = built.runtime;
    try {
      await runScheduledTick(deps);
    } finally {
      ctx.waitUntil(sql.end({ timeout: 5 }));
    }
  },
};
