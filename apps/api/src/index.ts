import postgres from 'postgres';
import { createApp } from './app.ts';
import { createParentVerifier } from './auth/parent.ts';
import { loadConfig } from './config.ts';
import { createDb } from './db.ts';
import { createOpenAiResponsesClient } from '@pencillift/ai';
import { DEFAULT_HANDLERS, runScheduledTick, type JobHandler } from './jobs/dispatcher.ts';
import { createExportBuildHandler } from './jobs/export-build.ts';
import { createLearningHandlers } from './jobs/learning-jobs.ts';
import { createScanProcessHandler, storageReader } from './jobs/scan-process.ts';
import type { AppDeps } from './middleware/context.ts';
import { createDbRateLimiter } from './middleware/rate-limit.ts';
import { createSupabaseStorage } from './providers/supabase-storage.ts';
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
  if (
    config.environment === 'production' &&
    (config.providers.consent !== 'configured' || config.providers.storage !== 'supabase')
  ) {
    // AC_DEPLOY_07: production never serves with the development consent or storage mocks.
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
    // Consent and email adapters do not exist yet (docs/Connections.md); storage uses Supabase when set.
    providers: {
      consent: createDevelopmentConsentMock(),
      storage:
        config.providers.storage === 'supabase' &&
        typeof env.SUPABASE_URL === 'string' &&
        typeof env.SUPABASE_SERVICE_ROLE_KEY === 'string'
          ? createSupabaseStorage({
              supabaseUrl: env.SUPABASE_URL,
              serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
            })
          : createMemoryStorageMock(),
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
    const ai =
      typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.length > 0
        ? createOpenAiResponsesClient({
            apiKey: env.OPENAI_API_KEY,
            ...(typeof env.OPENAI_PROJECT === 'string' ? { project: env.OPENAI_PROJECT } : {}),
          })
        : null;
    const handlers: Record<string, JobHandler> = {
      ...DEFAULT_HANDLERS,
      // Practice sets are built from the original bank; the AI only re-themes them when a key,
      // consent and the child-data gate allow it, so these run with or without a key.
      ...createLearningHandlers(ai ? { ai } : {}),
      export_build: createExportBuildHandler(),
    };
    if (ai) {
      // Without a real key scans stay queued and readiness reports AI as blocked; they are never
      // processed by a mock in a deployed environment.
      handlers.scan_process = createScanProcessHandler({
        ai,
        readObject: storageReader(deps.providers.storage),
      });
    }
    try {
      await runScheduledTick(deps, handlers);
    } finally {
      ctx.waitUntil(sql.end({ timeout: 5 }));
    }
  },
};
