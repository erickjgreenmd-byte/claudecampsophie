import { SignJWT } from 'jose';
import { createTestDb, type TestDb } from '@pencillift/db/testing';
import { cryptoRandom } from '@pencillift/domain';
import { createPostgresClient } from '../src/pg-client.ts';
import { createApp } from '../src/app.ts';
import { createParentVerifier } from '../src/auth/parent.ts';
import { createStripeClientMock, createSubscriberStateMock } from '../src/providers/billing.ts';
import { loadConfig, type ApiConfig } from '../src/config.ts';
import { createDb, type Db } from '../src/db.ts';
import type { LogEvent } from '../src/middleware/context.ts';
import { createDbRateLimiter } from '../src/middleware/rate-limit.ts';
import {
  createDevelopmentConsentMock,
  createMemoryStorageMock,
  createOutboxEmailMock,
} from '../src/providers/index.ts';

export const TEST_JWT_SECRET = 'test-supabase-jwt-secret-with-at-least-32-chars!!';
export const TEST_ISSUER = 'https://test-project.supabase.co/auth/v1';

export const TEST_ENV: Record<string, string> = {
  APP_ENV: 'test',
  SUPABASE_JWT_SECRET: TEST_JWT_SECRET,
  SUPABASE_JWT_ISSUER: TEST_ISSUER,
  CHILD_TOKEN_SECRET: 'test-child-token-secret-with-at-least-32-chars!!',
  HASH_PEPPER: 'test-hash-pepper-with-at-least-32-characters!!!!',
  CORS_ORIGINS: 'https://app.pencillift.test',
};

export interface TestApi {
  db: TestDb;
  apiDb: Db;
  config: ApiConfig;
  app: ReturnType<typeof createApp>;
  logs: LogEvent[];
  now: { value: Date };
  providers: {
    consent: ReturnType<typeof createDevelopmentConsentMock>;
    storage: ReturnType<typeof createMemoryStorageMock>;
    email: ReturnType<typeof createOutboxEmailMock>;
    subscriptions: ReturnType<typeof createSubscriberStateMock>;
    stripe: ReturnType<typeof createStripeClientMock>;
  };
  request(
    path: string,
    init?: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<Response>;
  close(): Promise<void>;
}

export async function createTestApi(overrides: Record<string, string> = {}): Promise<TestApi> {
  const now = { value: new Date('2026-09-24T15:00:00Z') };
  // Direct SQL in tests states the pinned clock, as the API does (migration 0780, BUG-090).
  const db = await createTestDb({ requestNow: () => now.value });
  const loaded = loadConfig({ ...TEST_ENV, ...overrides });
  if (!loaded.ok) throw new Error(`bad test config: ${JSON.stringify(loaded.errors)}`);
  const config = loaded.config;
  // The API under test uses the production client options (BUG-063): same factory as the Worker.
  const apiSql = createPostgresClient(db.url, { max: 4, onnotice: () => undefined });
  const apiDb = createDb(apiSql);
  const logs: LogEvent[] = [];
  const providers = {
    consent: createDevelopmentConsentMock(),
    storage: createMemoryStorageMock(),
    email: createOutboxEmailMock(),
    subscriptions: createSubscriberStateMock(),
    stripe: createStripeClientMock(),
  };
  const app = createApp({
    config,
    db: apiDb,
    clock: () => now.value,
    random: cryptoRandom,
    verifyParentToken: createParentVerifier(config),
    rateLimiter: createDbRateLimiter(apiDb),
    providers,
    log: (e) => logs.push(e),
  });
  return {
    db,
    apiDb,
    config,
    app,
    logs,
    now,
    providers,
    request(path, init = {}) {
      const headers: Record<string, string> = { ...init.headers };
      if (init.token) headers.authorization = `Bearer ${init.token}`;
      let body: string | undefined;
      if (init.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(init.body);
      }
      return Promise.resolve(
        app.request(path, {
          method: init.method ?? 'GET',
          headers,
          ...(body === undefined ? {} : { body }),
        }),
      );
    },
    close: async () => {
      await apiSql.end({ timeout: 5 });
      await db.drop();
    },
  };
}

/** Mints a Supabase-shaped access token signed with the local test secret. */
export async function parentToken(
  userId: string,
  options: {
    sessionId?: string;
    aal?: 'aal1' | 'aal2';
    expiresInSeconds?: number;
    secret?: string;
    role?: string;
    /** Supabase authentication method references, e.g. [{ method: 'password', timestamp }]. */
    amr?: { method: string; timestamp: number }[];
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    role: options.role ?? 'authenticated',
    session_id: options.sessionId ?? '11111111-1111-4111-8111-111111111111',
    aal: options.aal ?? 'aal1',
    ...(options.amr ? { amr: options.amr } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(TEST_ISSUER)
    .setAudience('authenticated')
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + (options.expiresInSeconds ?? 3600))
    .sign(new TextEncoder().encode(options.secret ?? TEST_JWT_SECRET));
}

export async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
