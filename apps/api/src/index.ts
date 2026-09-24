import type { Sql } from 'postgres';
import { createPostgresClient } from './pg-client.ts';
import { createApp } from './app.ts';
import { createParentVerifier } from './auth/parent.ts';
import { loadConfig, MOCK_ENVIRONMENTS, type ApiConfig } from './config.ts';
import { createDb } from './db.ts';
import {
  createMockModerationClient,
  createOpenAiModerationClient,
  createOpenAiResponsesClient,
  createRefusingModerationClient,
  type ModerationClient,
} from '@pencillift/ai';
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
  type ConsentProvider,
  type EmailProvider,
  type StorageProvider,
} from './providers/index.ts';
import { cryptoRandom } from '@pencillift/domain';
import {
  createRevenueCatProvider,
  createStripeClient,
  createStripeClientMock,
  createSubscriberStateMock,
  type StripeBillingClient,
  type SubscriberStateProvider,
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
  readonly sql: Sql;
  /** Provider moderation for the jobs that grade or show model output (selectModerationClient). */
  readonly moderation: ModerationClient;
}

type RuntimeFailure = { ok: false; code: 'NOT_CONFIGURED' | 'BLOCKED_EXTERNAL'; message: string };
type RuntimeResult = { ok: true; runtime: Runtime } | RuntimeFailure;

const NOT_CONFIGURED: RuntimeFailure = {
  ok: false,
  code: 'NOT_CONFIGURED',
  message: 'Service is not configured',
};
const NOT_READY: RuntimeFailure = {
  ok: false,
  code: 'BLOCKED_EXTERNAL',
  message: 'Service is not ready',
};

export type ConsentAdapterFactory = (env: WorkerEnv) => ConsentProvider;

/**
 * Real consent adapters by CONSENT_PROVIDER name (none yet: owner action #7). Every name in
 * config.ts CONSENT_ADAPTERS must be wired here; tests/runtime.test.ts keeps the lists equal.
 */
export const CONSENT_ADAPTER_FACTORIES: Readonly<Record<string, ConsentAdapterFactory>> = {};

/**
 * Staging/production without a consent adapter: nothing can be started or verified, so the
 * child-data gates stay closed. It is not a mock and never produces a consent record.
 */
function createUnavailableConsentProvider(): ConsentProvider {
  const refuse = () => Promise.reject(new Error('consent provider not configured'));
  return { name: 'not_configured', isMock: false, start: refuse, status: refuse };
}

/**
 * The consent provider the configuration selects (AC_DEPLOY_07), explicitly and failing closed:
 * the labeled development mock only in development/test, a configured adapter only when this
 * Worker implements it, and never a mock outside development/test whatever the configuration says.
 */
export function selectConsentProvider(
  config: ApiConfig,
  env: WorkerEnv,
  adapters: Readonly<Record<string, ConsentAdapterFactory>> = CONSENT_ADAPTER_FACTORIES,
): { ok: true; provider: ConsentProvider } | RuntimeFailure {
  let provider: ConsentProvider;
  switch (config.providers.consent) {
    case 'development_mock':
      provider = createDevelopmentConsentMock();
      break;
    case 'unavailable':
      provider = createUnavailableConsentProvider();
      break;
    case 'configured': {
      const name = config.providers.consentAdapter;
      const factory = name !== null && Object.hasOwn(adapters, name) ? adapters[name] : undefined;
      if (!factory) return NOT_CONFIGURED;
      provider = factory(env);
      break;
    }
    default:
      return NOT_CONFIGURED;
  }
  if (provider.isMock && !MOCK_ENVIRONMENTS.has(config.environment)) return NOT_READY;
  return { ok: true, provider };
}

/**
 * Staging/production without billing credentials: every call fails, so webhooks answer "retry
 * later", syncs report the store as unreachable and the stale-entitlement sweep skips the family.
 * Nothing is granted or revoked. Not a mock, like the unavailable consent provider.
 */
function createUnavailableSubscriberState(): SubscriberStateProvider {
  return {
    name: 'not_configured',
    isMock: false,
    fetchSubscriptions: () => Promise.reject(new Error('billing provider not configured')),
  };
}

function createUnavailableStripeClient(): StripeBillingClient {
  const refuse = () => Promise.reject(new Error('web billing provider not configured'));
  return {
    name: 'not_configured',
    isMock: false,
    addDiscountToDraftInvoice: refuse,
    invoiceForCharge: refuse,
  };
}

/**
 * The billing clients the configuration selects (AC_DEPLOY_07), explicitly and failing closed like
 * consent: the labeled mocks only in development/test, the real clients only with their server
 * keys, and never a mock outside development/test whatever the configuration says.
 */
export function selectBillingProviders(
  config: ApiConfig,
  env: WorkerEnv,
):
  | { ok: true; subscriptions: SubscriberStateProvider; stripe: StripeBillingClient }
  | RuntimeFailure {
  let subscriptions: SubscriberStateProvider;
  switch (config.providers.billing) {
    case 'development_mock':
      subscriptions = createSubscriberStateMock();
      break;
    case 'unavailable':
      subscriptions = createUnavailableSubscriberState();
      break;
    case 'revenuecat':
      if (typeof env.REVENUECAT_SECRET_API_KEY !== 'string' || !env.REVENUECAT_SECRET_API_KEY) {
        return NOT_CONFIGURED;
      }
      subscriptions = createRevenueCatProvider(env.REVENUECAT_SECRET_API_KEY);
      break;
    default:
      return NOT_CONFIGURED;
  }
  let stripe: StripeBillingClient;
  switch (config.providers.webBilling) {
    case 'development_mock':
      stripe = createStripeClientMock();
      break;
    case 'unavailable':
      stripe = createUnavailableStripeClient();
      break;
    case 'stripe':
      if (typeof env.STRIPE_SECRET_KEY !== 'string' || !env.STRIPE_SECRET_KEY) {
        return NOT_CONFIGURED;
      }
      stripe = createStripeClient(env.STRIPE_SECRET_KEY);
      break;
    default:
      return NOT_CONFIGURED;
  }
  if ((subscriptions.isMock || stripe.isMock) && !MOCK_ENVIRONMENTS.has(config.environment)) {
    return NOT_READY;
  }
  return { ok: true, subscriptions, stripe };
}

/**
 * The moderation client the configuration selects (spec P4; AC_SECURITY_02), explicitly and failing
 * closed like billing: the labeled mock only in development/test, the OpenAI client only with
 * OPENAI_API_KEY, the refusing client in staging/production without it (a scan then stops instead
 * of grading unmoderated text), and never a mock outside development/test.
 */
export function selectModerationClient(
  config: ApiConfig,
  env: WorkerEnv,
): { ok: true; client: ModerationClient } | RuntimeFailure {
  let client: ModerationClient;
  switch (config.providers.moderation) {
    case 'development_mock':
      client = createMockModerationClient();
      break;
    case 'unavailable':
      client = createRefusingModerationClient();
      break;
    case 'openai':
      if (typeof env.OPENAI_API_KEY !== 'string' || !env.OPENAI_API_KEY) return NOT_CONFIGURED;
      client = createOpenAiModerationClient({
        apiKey: env.OPENAI_API_KEY,
        ...(typeof env.OPENAI_PROJECT === 'string' ? { project: env.OPENAI_PROJECT } : {}),
      });
      break;
    default:
      return NOT_CONFIGURED;
  }
  if (client.isMock && !MOCK_ENVIRONMENTS.has(config.environment)) return NOT_READY;
  return { ok: true, client };
}

/**
 * Storage and email outside development/test without their credentials: a provider that refuses
 * every call, never a labeled mock (L-016). An in-memory store loses homework photos and an outbox
 * delivers nothing, yet both answer as if they worked.
 */
function createUnavailableStorage(): StorageProvider {
  const refuse = () => Promise.reject(new Error('storage provider not configured'));
  return {
    name: 'not_configured',
    isMock: false,
    createSignedUploadUrl: refuse,
    createSignedReadUrl: refuse,
    exists: refuse,
    stat: refuse,
    remove: refuse,
  };
}

function createUnavailableEmail(): EmailProvider {
  return {
    name: 'not_configured',
    isMock: false,
    send: () => Promise.reject(new Error('email provider not configured')),
  };
}

/**
 * Explicit storage and email selection: labeled mocks only in development and test. A value the
 * adapter refuses is NOT_CONFIGURED, never an exception out of buildRuntime (LRD-4); loadConfig
 * reports the same values first.
 */
export function selectStorageAndEmail(
  config: ApiConfig,
  env: WorkerEnv,
): { ok: true; storage: StorageProvider; email: EmailProvider } | RuntimeFailure {
  const mocksAllowed = MOCK_ENVIRONMENTS.has(config.environment);
  let storage: StorageProvider;
  if (
    config.providers.storage === 'supabase' &&
    typeof env.SUPABASE_URL === 'string' &&
    typeof env.SUPABASE_SERVICE_ROLE_KEY === 'string'
  ) {
    try {
      storage = createSupabaseStorage({
        supabaseUrl: env.SUPABASE_URL,
        serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
      });
    } catch {
      return NOT_CONFIGURED;
    }
  } else {
    storage = mocksAllowed ? createMemoryStorageMock() : createUnavailableStorage();
  }
  // No transactional email adapter exists yet (docs/Connections.md, Owner action #14).
  const email = mocksAllowed ? createOutboxEmailMock() : createUnavailableEmail();
  return { ok: true, storage, email };
}

/**
 * Builds the per-invocation dependencies shared by HTTP requests and Cron Triggers. A provider
 * constructor that refuses a configured value answers NOT_CONFIGURED like any other configuration
 * error (LRD-4): fetch() then serves the structured 503 and scheduled() logs
 * scheduled_not_configured, instead of an unstructured platform error.
 */
export function buildRuntime(env: WorkerEnv): RuntimeResult {
  try {
    return buildRuntimeOrThrow(env);
  } catch (error) {
    // The error class only: a message can quote the configured value.
    console.log(
      JSON.stringify({
        level: 'error',
        event: 'runtime_not_configured',
        error: error instanceof Error ? error.name : typeof error,
      }),
    );
    return NOT_CONFIGURED;
  }
}

function buildRuntimeOrThrow(env: WorkerEnv): RuntimeResult {
  // APP_ENV is never defaulted (LRD-5): without it loadConfig fails and nothing is served.
  const loaded = loadConfig(stringEnv(env));
  if (!loaded.ok) return NOT_CONFIGURED;
  const config = loaded.config;
  if (
    config.environment === 'production' &&
    (config.providers.consent !== 'configured' || config.providers.storage !== 'supabase')
  ) {
    // AC_DEPLOY_07: production never serves with the development consent or storage mocks.
    return NOT_READY;
  }
  const consent = selectConsentProvider(config, env);
  if (!consent.ok) return consent;
  const billing = selectBillingProviders(config, env);
  if (!billing.ok) return billing;
  const storageAndEmail = selectStorageAndEmail(config, env);
  if (!storageAndEmail.ok) return storageAndEmail;
  const moderation = selectModerationClient(config, env);
  if (!moderation.ok) return moderation;
  // Last, so a refused configuration never opens a client. One client configuration for the
  // Worker and the tests (BUG-063: array parameters need types).
  const sql = createPostgresClient(env.HYPERDRIVE.connectionString);
  const db = createDb(sql);
  const deps: AppDeps = {
    config,
    db,
    clock: () => new Date(),
    random: cryptoRandom,
    verifyParentToken: createParentVerifier(config),
    rateLimiter: createDbRateLimiter(db),
    providers: {
      consent: consent.provider,
      storage: storageAndEmail.storage,
      email: storageAndEmail.email,
      subscriptions: billing.subscriptions,
      stripe: billing.stripe,
    },
    log: (event) => console.log(JSON.stringify(event)),
  };
  return { ok: true, runtime: { deps, sql, moderation: moderation.client } };
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
    const { deps, sql, moderation } = built.runtime;
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
      // consent and the child-data gate allow it, so these run with or without a key. Every
      // re-themed story and intro passes provider moderation before a child sees it.
      ...createLearningHandlers(ai ? { ai, moderation } : {}),
      export_build: createExportBuildHandler(),
    };
    if (ai) {
      // Without a real key scans stay queued and readiness reports AI as blocked; they are never
      // processed by a mock in a deployed environment. The child's answers are moderated before
      // grading and every child-facing output after it (fail closed on a moderation error).
      handlers.scan_process = createScanProcessHandler({
        ai,
        moderation,
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
