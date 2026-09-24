import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import type { Sql, TransactionSql } from 'postgres';
import { applyMigrations, listMigrations, MIGRATIONS_DIR } from '../scripts/migrate.ts';

/**
 * Real-Postgres authorization test harness.
 *
 * Every test file gets its own freshly created database with the Supabase platform shim and the
 * project migrations applied. Queries run inside a transaction after `SET LOCAL ROLE` and with
 * `request.jwt.claims` populated exactly as PostgREST / the PencilLift API does, so RLS, grants and
 * SECURITY DEFINER functions are exercised for real. Nothing here mocks the database.
 */

const SHIM_PATH = fileURLToPath(new URL('./shim/supabase_platform_shim.sql', import.meta.url));

export const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

export type Tx = TransactionSql;

export interface ParentClaims {
  /** Supabase auth session id (the `session_id` JWT claim). */
  sessionId?: string;
  /** Authenticator assurance level; `aal2` means MFA was completed. */
  aal?: 'aal1' | 'aal2';
  extra?: Record<string, unknown>;
}

export interface ChildClaims {
  childId: string;
  familyId: string;
  sessionId: string;
}

export interface TestDb {
  /** Superuser connection to the isolated database (bypasses RLS; use only for fixtures). */
  readonly sql: Sql;
  readonly name: string;
  /** Connection URL of the isolated database, for clients built with production options. */
  readonly url: string;
  asParent<T>(userId: string, fn: (tx: Tx) => Promise<T>, claims?: ParentClaims): Promise<T>;
  asChild<T>(claims: ChildClaims, fn: (tx: Tx) => Promise<T>): Promise<T>;
  asAnon<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  asService<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Creates an email-verified auth.users row and returns its id. */
  createUser(email?: string): Promise<string>;
  drop(): Promise<void>;
}

/**
 * Optional comma-separated migration filename prefixes (e.g. "0001,0300") so an author can test one
 * area migration against the core without depending on unrelated in-progress files. The integrated
 * suite (CI) never sets this and applies every migration.
 */
function migrationFilter(): ((name: string) => boolean) | undefined {
  const raw = process.env.PL_MIGRATIONS_ONLY;
  if (!raw) return undefined;
  const prefixes = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return (name) => prefixes.some((p) => name.startsWith(p));
}

async function applySelectedMigrations(sql: Sql): Promise<void> {
  const filter = migrationFilter();
  if (!filter) {
    await applyMigrations(sql);
    return;
  }
  const { readFile: read } = await import('node:fs/promises');
  const path = await import('node:path');
  for (const name of (await listMigrations()).filter(filter)) {
    const text = await read(path.join(MIGRATIONS_DIR, name), 'utf8');
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(text);
      });
    } catch (error) {
      throw new Error(`Migration ${name} failed: ${(error as Error).message}`, { cause: error });
    }
  }
}

export interface TestDbOptions {
  /**
   * The application clock to state in every transaction (pencillift.request_now), as the API
   * does: jobs the database enqueues are then due at this clock (migration 0780). API tests pin
   * their clock; without this, work enqueued inside the database would follow the real clock.
   */
  readonly requestNow?: () => Date;
}

export async function createTestDb(options: TestDbOptions = {}): Promise<TestDb> {
  const baseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const admin = postgres(baseUrl, { max: 1, onnotice: () => undefined });
  const name = `pl_test_${randomBytes(6).toString('hex')}`;
  try {
    await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.end();
  }

  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 4, onnotice: () => undefined });

  await sql.unsafe(await readFile(SHIM_PATH, 'utf8'));
  await applySelectedMigrations(sql);

  async function run<T>(
    role: string,
    claims: Record<string, unknown>,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return (await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
      if (options.requestNow) {
        await tx`select set_config('pencillift.request_now', ${options.requestNow().toISOString()}, true)`;
      }
      await tx.unsafe(`set local role ${role}`);
      return fn(tx);
    })) as T;
  }

  return {
    sql,
    name,
    url: url.toString(),
    asParent(userId, fn, claims = {}) {
      return run(
        'authenticated',
        {
          sub: userId,
          role: 'authenticated',
          aal: claims.aal ?? 'aal1',
          session_id: claims.sessionId ?? '00000000-0000-4000-8000-000000000001',
          ...claims.extra,
        },
        fn,
      );
    },
    asChild(claims, fn) {
      return run(
        'pl_child',
        {
          role: 'pl_child',
          child_id: claims.childId,
          family_id: claims.familyId,
          child_session_id: claims.sessionId,
        },
        fn,
      );
    },
    asAnon(fn) {
      return run('anon', { role: 'anon' }, fn);
    },
    asService(fn) {
      return run('service_role', { role: 'service_role' }, fn);
    },
    async createUser(email) {
      const address = email ?? `user_${randomBytes(4).toString('hex')}@example.test`;
      const rows = await sql<{ id: string }[]>`
        insert into auth.users (email, email_confirmed_at) values (${address}, now()) returning id
      `;
      return rows[0]!.id;
    },
    async drop() {
      await sql.end();
      const cleanup = postgres(baseUrl, { max: 1, onnotice: () => undefined });
      try {
        await cleanup.unsafe(`drop database if exists ${name} with (force)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
